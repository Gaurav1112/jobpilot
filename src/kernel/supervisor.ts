import { Breakers } from './breaker.js';
import { canonicalJson, hashOf } from './canonical.js';
import type { Clock } from './clock.js';
import { contractHash, contractShape } from './contract.js';
import { type Envelope, makeEnvelopeId, openObligations, ZERO_COST } from './envelope.js';
import { InvalidTransition } from './errors.js';
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
  keyOf(env: Envelope): string | null;
  eventFor(agentId: string, outcome: 'done' | 'quarantined'): string | null;
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
  readonly tracker?: Tracker;
  readonly onInvoke?: (agentId: string, stepKey: string) => void;
  /** Test hook: runs after a step's own transaction, before routing. Throwing here simulates a crash. */
  readonly afterStep?: (count: number) => void;
}

export interface RunReport {
  readonly runId: string;
  readonly status: 'completed';
  readonly queue: Record<'pending' | 'done' | 'failed' | 'quarantined' | 'skipped', number>;
  readonly replayed: number;
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

  constructor(private readonly d: SupervisorDeps) {}

  private get exec(): ExecutorDeps {
    const d = this.d;
    return {
      store: d.store,
      policy: d.policy,
      policyHash: d.policyHash,
      providers: d.providers,
      clock: d.clock,
      guardrails: d.guardrails,
      sleep: d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
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
    return this.drain(runId);
  }

  /** Continues a crashed run. Finished steps replay from the store; nothing finished runs again. */
  async resume(runId: string): Promise<RunReport> {
    const run = this.d.store.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    if (run.status === 'completed') throw new Error(`run ${runId} is already completed`);
    if (run.policy_hash !== this.d.policyHash) throw new Error(`run ${runId} used a different policy; start a new run instead`);
    this.event(runId, 'run_resumed', {});
    this.rememberContracts();
    return this.drain(runId);
  }

  /** Past minor versions recorded by earlier runs stay valid producers (G-LINEAGE). */
  private rememberContracts(): void {
    for (const c of this.d.store.contracts()) this.d.registry.rememberVersion(c.agent_id, c.version, c.hash);
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
          this.event(runId, 'step_skipped', { agent: item.agent_id, reason: 'breaker_open' });
          this.reportOpen(runId, input);
        });
        continue;
      }
      const outcome: StepOutcome = await executeStep(this.exec, runId, agent, input);
      count += 1;
      this.d.afterStep?.(count);

      store.tx(() => {
        if (outcome.kind === 'done') {
          for (const out of outcome.outputs) {
            this.route(runId, out);
            this.track(runId, out, outcome.stepKey, item.agent_id, 'done');
          }
        } else if (outcome.kind === 'quarantined') {
          this.track(runId, input, outcome.stepKey, item.agent_id, 'quarantined');
        }
        // The input never got past this step, so whatever it still owes stays open.
        if (outcome.kind !== 'done') this.reportOpen(runId, input);
        store.markQueue(runId, item.agent_id, item.envelope_id, outcome.kind);
      });

      if (outcome.kind === 'failed') {
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
      replayed: events.filter((e) => e.kind === 'step_replayed').length,
      openObligations: openObligationsOf(events),
      costUsd: store.runCost(runId),
    };
    this.event(runId, 'run_finished', report);
    return report;
  }

  private track(runId: string, env: Envelope, stepKey: string, agentId: string, outcome: 'done' | 'quarantined'): void {
    const t = this.d.tracker;
    if (!t) return;
    const key = t.keyOf(env);
    const ev = t.eventFor(agentId, outcome);
    if (key === null || ev === null) return;
    const { store } = this.d;
    if (store.hasTransition(key, stepKey, ev)) return; // a replayed step never re-applies
    let to: string;
    try {
      to = t.machine.next(store.entityState(key) ?? t.machine.def.initial, ev);
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
    store.applyTransition(key, t.kind, stepKey, ev, t.machine);
  }
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
