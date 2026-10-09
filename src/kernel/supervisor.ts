import { Breakers } from './breaker.js';
import { canonicalJson, hashOf } from './canonical.js';
import type { Clock } from './clock.js';
import { createHostPacer, freezePack, type EgressSets, type HostPacer } from './broker.js';
import { contractHash, contractShape, securityDiff } from './contract.js';
import { type Envelope, type GuardrailVerdict, makeEnvelopeId, openObligations, ZERO_COST } from './envelope.js';
import { InvalidTransition } from './errors.js';
import { recoverPending } from './files.js';
import { executeStep, type ExecutorDeps, type StepOutcome } from './executor.js';
import type { GuardrailRegistry } from './guardrails/index.js';
import type { Policy } from './policy.js';
import type { Providers } from './providers.js';
import type { Registry } from './registry.js';
import type { StateMachine } from './state-machine.js';
import type { EventRow, Store } from './store/store.js';
import { type CompiledPipeline, SUPERVISOR_ID, seedClass } from './wiring.js';

/** Maps envelopes and outcomes onto an entity state machine (e.g. one row per job). */
export interface Tracker {
  readonly kind: string;
  readonly machine: StateMachine;
  /**
   * The entity this envelope belongs to, or null when the tracker does not follow it. Must be a
   * pure function of the envelope. Throwing is treated as a broken output, not a broken tracker:
   * when it throws for an output of a done step, that step is quarantined with verdict G-TRACKER
   * and nothing is routed. A step executed in this run is quarantined in the store (its outputs are
   * dropped); a replayed step is quarantined for this run only, leaving stored history untouched.
   * A throw while tracking a quarantined input is only audited (`tracker_error`).
   */
  keyOf(env: Envelope): string | null;
  /** `env` is the tracked envelope: an output when the step is done, its input when it is quarantined. */
  eventFor(agentId: string, outcome: 'done' | 'quarantined', env: Envelope): string | null;
}

export interface SupervisorDeps {
  readonly store: Store;
  readonly registry: Registry;
  readonly compiled: CompiledPipeline;
  readonly guardrails: GuardrailRegistry;
  readonly policy: Policy;
  readonly policyHash: string;
  readonly providers: Providers;
  readonly clock: Clock;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Applied independently, in array order. */
  readonly trackers?: readonly Tracker[];
  readonly onInvoke?: (agentId: string, stepKey: string) => void;
  /** Test hook: runs after a step's own transaction, before routing. Throwing here simulates a crash. */
  readonly afterStep?: (count: number) => void;
  /** The user's public pack; given to contracts with `capabilities.pack: true` and to guardrails. */
  readonly pack?: unknown;
  /** Hash of `pack`, part of the step key of pack agents only. Default 'none'. */
  readonly packHash?: string;
  /** The full pack (with P1 contact details); given to contracts with `capabilities.pack: 'full'`. */
  readonly fullPack?: unknown;
  /** Hash of `fullPack`, part of the step key of 'full' pack agents only. Default 'none'. */
  readonly fullPackHash?: string;
  /** The hosts behind symbolic egress entries (`pack:careers-hosts`); the app derives them from the pack. */
  readonly egressSets?: EgressSets;
  /**
   * Fingerprint of the agents' implementation (review I4), in every step key: a code change re-runs every step once.
   * Default 'none' (kernel and demo), which leaves the keys as before.
   */
  readonly codeHash?: string;
}

export interface RunReport {
  readonly runId: string;
  readonly status: 'completed';
  readonly queue: Record<'pending' | 'done' | 'failed' | 'quarantined' | 'skipped', number>;
  readonly replayed: number;
  /** Failed steps whose item no longer exists at its source (error code `gone`); they are inside `queue.failed`. */
  readonly gone: number;
  /** Failed steps refused for their input alone (error code `input_rejected`); they are inside `queue.failed`. */
  readonly inputRejected: number;
  readonly openObligations: readonly { readonly envelopeId: string; readonly ids: readonly string[] }[];
  readonly costUsd: number;
}

/**
 * The deterministic hub. It never calls a model and never decides anything a
 * table doesn't: routes come from the compiled wiring, order from the queue's
 * total order, state from the tracker's machine.
 */
export class Supervisor {
  /**
   * Breakers are per run and in memory only: their counts restart after a
   * resume, so a resumed run re-learns failures. Everything else a report
   * needs is read back from the store.
   */
  private readonly breakersByRun = new Map<string, Breakers>();
  private readonly sleep: (ms: number) => Promise<void>;
  /** One per supervisor: every step's requests to a host share its spacing. */
  private readonly hostPacer: HostPacer;
  /** One per supervisor: browser renders of a host are also spaced by policy.minBrowserIntervalMs. */
  private readonly browserPacer: HostPacer;
  /** One frozen deep copy of each pack, made once; the caller's objects are left alone. */
  private readonly pack: unknown;
  private readonly fullPack: unknown;

  constructor(private readonly d: SupervisorDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.hostPacer = createHostPacer(d.policy.minHostIntervalMs, d.clock, this.sleep);
    this.browserPacer = createHostPacer(d.policy.minBrowserIntervalMs, d.clock, this.sleep);
    this.pack = d.pack === undefined ? undefined : freezePack(d.pack);
    this.fullPack = d.fullPack === undefined ? undefined : freezePack(d.fullPack);
  }

  private get exec(): ExecutorDeps {
    const d = this.d;
    return {
      store: d.store,
      policy: d.policy,
      policyHash: d.policyHash,
      providers: d.providers,
      clock: d.clock,
      guardrails: d.guardrails,
      sleep: this.sleep,
      hostPacer: this.hostPacer,
      browserPacer: this.browserPacer,
      ...(this.pack !== undefined ? { pack: this.pack } : {}),
      ...(d.packHash !== undefined ? { packHash: d.packHash } : {}),
      ...(this.fullPack !== undefined ? { fullPack: this.fullPack } : {}),
      ...(d.fullPackHash !== undefined ? { fullPackHash: d.fullPackHash } : {}),
      ...(d.egressSets !== undefined ? { egressSets: d.egressSets } : {}),
      ...(d.codeHash !== undefined ? { codeHash: d.codeHash } : {}),
      contractHashOf: (id, v) => (id === SUPERVISOR_ID && v === d.compiled.pipeline.version ? d.compiled.seedHash : d.registry.contractHashOf(id, v)),
      ...(d.onInvoke ? { onInvoke: d.onInvoke } : {}),
    };
  }

  private breakers(runId: string): Breakers {
    let b = this.breakersByRun.get(runId);
    if (!b) this.breakersByRun.set(runId, (b = new Breakers()));
    return b;
  }

  private event(runId: string, kind: string, data: unknown): void {
    this.d.store.appendEvent(runId, this.d.clock.now(), kind, data, this.d.policyHash);
  }

  /** Validates seeds, records the run and drains its queue. */
  async start(runId: string, seeds: readonly unknown[]): Promise<RunReport> {
    const { store, compiled, policyHash, clock } = this.d;
    if (store.getRun(runId)) throw new Error(`run ${runId} already exists; resume it instead`);
    const seedType = compiled.pipeline.seed.type;
    const envs: Envelope[] = seeds.map((payload) => {
      const r = seedType.schema.safeParse(payload);
      if (!r.success || canonicalJson(r.data) !== canonicalJson(payload)) throw new TypeError(`seed is not a valid ${seedType.id}`);
      for (const g of compiled.pipeline.seed.guarantees) if (!g.test(payload)) throw new TypeError(`seed fails ${g.id}`);
      const dataClass = seedClass(compiled.pipeline);
      const stepKey = hashOf({ seed: compiled.pipeline.id, version: compiled.pipeline.version, payload, dataClass, policyHash });
      return {
        envelopeId: makeEnvelopeId(stepKey, 0),
        stepKey,
        index: 0,
        type: seedType.id,
        producer: { agentId: SUPERVISOR_ID, version: compiled.pipeline.version, contractHash: compiled.seedHash },
        parents: [],
        payload,
        handoff: { guarantees: compiled.pipeline.seed.guarantees.map((g) => g.id).sort(), dataClass, obligations: [], pins: { policyHash } },
        guardrails: [],
        cost: ZERO_COST,
      };
    });
    store.tx(() => {
      store.startRun(runId, `${compiled.pipeline.id}@${compiled.pipeline.version}`, policyHash, clock.now());
      for (const a of this.d.registry.list()) store.saveContract(a.contract.id, a.contract.version, contractHash(a.contract), contractShape(a.contract));
      for (const e of envs) {
        store.putSeed(e.stepKey, e, compiled.pipeline.version, compiled.seedHash);
        this.route(runId, e);
      }
      this.event(runId, 'run_started', { pipeline: compiled.pipeline.id, seeds: envs.length });
    });
    this.rememberContracts();
    await this.recoverFiles(runId);
    return this.drain(runId);
  }

  /**
   * Staged writes left by a crashed process (files.ts): a done step's stage is committed (the crash came between
   * recording the step and committing its files), every other stage is deleted. Runs before any step of this run.
   */
  private async recoverFiles(runId: string): Promise<void> {
    for (const [name, root] of Object.entries(this.d.providers.fileRoots ?? {})) {
      if (root === undefined) continue;
      const r = await recoverPending(root, (k) => this.d.store.getStep(k)?.status === 'done', this.d.policy.maxResponseBytes);
      if (r.committed.length + r.discarded.length + r.failed.length > 0) this.event(runId, 'files_recovered', { root: name, ...r });
    }
  }

  /** Continues a crashed run. Finished steps replay from the store; nothing finished runs again. */
  async resume(runId: string): Promise<RunReport> {
    const run = this.d.store.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    if (run.status === 'completed') throw new Error(`run ${runId} is already completed`);
    if (run.policy_hash !== this.d.policyHash) throw new Error(`run ${runId} used a different policy; start a new run instead`);
    this.event(runId, 'run_resumed', {});
    this.rememberContracts();
    await this.recoverFiles(runId);
    return this.drain(runId);
  }

  /**
   * Past minor versions recorded by earlier runs stay valid producers (G-LINEAGE), but only
   * when their security-relevant fields match the current contract. Otherwise their outputs
   * fail G-LINEAGE downstream: a taint or capability change must never ride on a replay.
   */
  private rememberContracts(): void {
    const { registry } = this.d;
    for (const c of this.d.store.contracts()) {
      if (!registry.has(c.agent_id)) continue;
      if (securityDiff(c.shape, contractShape(registry.get(c.agent_id).contract)).length > 0) continue;
      registry.rememberVersion(c.agent_id, c.version, c.hash);
    }
  }

  private route(runId: string, env: Envelope): void {
    const consumers = this.d.compiled.routes.get(env.type) ?? [];
    for (const to of consumers) this.d.store.enqueue(runId, this.d.compiled.stage.get(to) ?? 0, to, env.envelopeId);
    if (consumers.length === 0) this.reportOpen(runId, env);
  }

  /** An envelope that goes no further with obligations still open is reported in the run. */
  private reportOpen(runId: string, env: Envelope): void {
    const ids = openObligations(env);
    if (ids.length > 0) this.event(runId, 'obligation_open', { envelopeId: env.envelopeId, ids });
  }

  private failure(key: string, threshold: number, runId: string): void {
    if (this.breakers(runId).failure(key, threshold)) this.event(runId, 'breaker_open', { key });
  }

  private async drain(runId: string): Promise<RunReport> {
    const { store, registry, compiled } = this.d;
    const breakers = this.breakers(runId);
    let count = 0;
    for (let item = store.nextQueued(runId); item; item = store.nextQueued(runId)) {
      const agent = registry.get(item.agent_id);
      const team = compiled.teamOf.get(item.agent_id);
      const agentKey = `agent:${item.agent_id}`;
      // An agent without a team has no team breaker.
      const teamKey = team ? `team:${team.id}` : undefined;
      const input = store.getEnvelope(item.envelope_id);
      if (breakers.isOpen(agentKey) || (teamKey !== undefined && breakers.isOpen(teamKey))) {
        store.tx(() => {
          store.markQueue(runId, item.agent_id, item.envelope_id, 'skipped');
          this.event(runId, 'step_skipped', { agent: item.agent_id, envelopeId: item.envelope_id, reason: 'breaker_open' });
          this.reportOpen(runId, input);
        });
        continue;
      }
      const executed: StepOutcome = await executeStep(this.exec, runId, agent, input);
      count += 1;
      this.d.afterStep?.(count);
      const trip = executed.kind === 'done' ? this.trackerTrip(executed.outputs) : undefined;
      const outcome: StepOutcome = trip ? { kind: 'quarantined', stepKey: executed.stepKey, verdicts: [trip] } : executed;

      store.tx(() => {
        if (trip) {
          // Persist only what this execution created and nothing has consumed yet. A replayed step's
          // envelopes may belong to other runs' history, so its quarantine is for this run only: keyOf
          // is pure, so later runs re-derive it, and a fixed tracker heals the pipeline.
          const persisted = executed.kind === 'done' && !executed.replayed;
          if (persisted) store.quarantineDoneStep(outcome.stepKey, JSON.stringify([trip]));
          this.event(runId, 'step_quarantined', { agent: item.agent_id, stepKey: outcome.stepKey, envelopeId: item.envelope_id, side: 'tracker', persisted, verdict: trip });
        }
        if (outcome.kind === 'done') {
          for (const out of outcome.outputs) {
            this.route(runId, out);
            this.track(runId, out, outcome.stepKey, item.agent_id, 'done');
          }
        } else if (outcome.kind === 'quarantined') {
          this.track(runId, input, outcome.stepKey, item.agent_id, 'quarantined');
        }
        // The input never got past this step (or the step produced nothing to carry it), so whatever it still owes stays open.
        if (outcome.kind !== 'done' || outcome.outputs.length === 0) this.reportOpen(runId, input);
        store.markQueue(runId, item.agent_id, item.envelope_id, outcome.kind);
      });

      // A gone or input-rejected item is that item's failure, not the service's: it neither trips nor resets a breaker.
      if (outcome.kind === 'failed' && (outcome.error === 'gone' || outcome.error === 'input_rejected')) {
        // reported through the step_failed event and RunReport.gone / inputRejected
      } else if (outcome.kind === 'failed') {
        this.failure(agentKey, agent.contract.breaker.consecutiveFailures, runId);
        if (team && teamKey !== undefined) this.failure(teamKey, team.breaker.consecutiveFailures, runId);
      } else if (outcome.kind === 'done') {
        breakers.success(agentKey);
        if (teamKey !== undefined) breakers.success(teamKey);
      }
    }
    store.finishRun(runId, this.d.clock.now());
    const events = store.events(runId);
    const report: RunReport = {
      runId,
      status: 'completed',
      queue: store.queueCounts(runId),
      replayed: replayedOf(events),
      gone: events.filter((e) => e.kind === 'step_failed' && (JSON.parse(e.data) as { error?: unknown }).error === 'gone').length,
      inputRejected: events.filter((e) => e.kind === 'step_failed' && (JSON.parse(e.data) as { error?: unknown }).error === 'input_rejected').length,
      openObligations: openObligationsOf(events),
      costUsd: store.runCost(runId),
    };
    this.event(runId, 'run_finished', report);
    return report;
  }

  /** G-TRACKER: an output no tracker can key is not trusted. The first throw, in output then tracker order, decides. */
  private trackerTrip(outputs: readonly Envelope[]): GuardrailVerdict | undefined {
    for (const [i, out] of outputs.entries()) {
      for (const t of this.d.trackers ?? []) {
        try {
          t.keyOf(out);
        } catch (err) {
          return { id: 'G-TRACKER', verdict: 'trip', detail: `tracker ${t.kind} could not key output ${i}: ${messageOf(err)}` };
        }
      }
    }
    return undefined;
  }

  private track(runId: string, env: Envelope, stepKey: string, agentId: string, outcome: 'done' | 'quarantined'): void {
    for (const t of this.d.trackers ?? []) this.trackOne(t, runId, env, stepKey, agentId, outcome);
  }

  private trackOne(t: Tracker, runId: string, env: Envelope, stepKey: string, agentId: string, outcome: 'done' | 'quarantined'): void {
    // Tracker callbacks are pluggable code: one that throws is audited, never allowed to wedge the run.
    let key: string | null;
    let ev: string | null = null;
    try {
      key = t.keyOf(env);
      if (key !== null) ev = t.eventFor(agentId, outcome, env);
    } catch (err) {
      this.event(runId, 'tracker_error', { tracker: t.kind, agent: agentId, stepKey, message: messageOf(err) });
      return;
    }
    if (key === null || ev === null) return;
    const { store } = this.d;
    if (store.hasTransition(key, t.kind, stepKey, ev)) return; // a replayed step never re-applies
    let to: string;
    try {
      to = t.machine.next(store.entityState(key, t.kind) ?? t.machine.def.initial, ev);
    } catch (err) {
      // The same entity can legitimately arrive twice (two sources list the same job): it keeps its state and the duplicate is audited.
      if (!(err instanceof InvalidTransition)) throw err;
      this.event(runId, 'transition_rejected', { entity: key, event: ev, agent: agentId, stepKey });
      return;
    }
    const open = openObligations(env);
    if (t.machine.isSuccess(to) && open.length > 0) {
      this.event(runId, 'obligation_blocked', { entity: key, event: ev, ids: open });
      return;
    }
    store.applyTransition(key, t.kind, stepKey, ev, t.machine, outcome);
  }
}

function messageOf(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return 'unprintable error';
  }
}

/**
 * Queue items answered from the store: one per (agent, input envelope), so a step a crash interrupted after its
 * replay (before its queue row was marked) is not counted twice when the run resumes (review m1).
 */
export function replayedOf(events: readonly EventRow[]): number {
  const seen = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'step_replayed') continue;
    const d = JSON.parse(e.data) as { agent?: unknown; envelopeId?: unknown; stepKey?: unknown };
    seen.add(`${String(d.agent)}\u0000${String(d.envelopeId ?? `step:${String(d.stepKey)}:${e.seq}`)}`);
  }
  return seen.size;
}

/** The run's `obligation_open` events, one per envelope, in envelope order. */
function openObligationsOf(events: readonly EventRow[]): RunReport['openObligations'] {
  const byEnvelope = new Map<string, readonly string[]>();
  for (const e of events) {
    if (e.kind !== 'obligation_open') continue;
    const d = JSON.parse(e.data) as { envelopeId: string; ids: string[] };
    byEnvelope.set(d.envelopeId, d.ids);
  }
  return [...byEnvelope]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([envelopeId, ids]) => ({ envelopeId, ids }));
}
