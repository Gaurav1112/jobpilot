import { Breakers } from './breaker.js';
import { canonicalJson, hashOf } from './canonical.js';
import type { Clock } from './clock.js';
import { contractHash, contractShape } from './contract.js';
import { type Envelope, makeEnvelopeId, openObligations, ZERO_COST } from './envelope.js';
import { executeStep, type ExecutorDeps, type StepOutcome } from './executor.js';
import type { GuardrailRegistry } from './guardrails/index.js';
import type { Policy } from './policy.js';
import type { Providers } from './providers.js';
import type { Registry } from './registry.js';
import type { StateMachine } from './state-machine.js';
import type { Store } from './store/store.js';
import { type CompiledPipeline, SUPERVISOR_ID } from './wiring.js';

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
  private readonly breakers = new Breakers();
  private replayed = 0;
  private readonly leaves: { envelopeId: string; ids: string[] }[] = [];

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

  private event(runId: string, kind: string, data: unknown): void {
    this.d.store.appendEvent(runId, this.d.clock.now(), kind, data, this.d.policyHash);
  }

  /** Validates seeds, records the run and drains its queue. */
  async start(runId: string, seeds: readonly unknown[]): Promise<RunReport> {
    const { store, compiled, policyHash, clock } = this.d;
    const seedType = compiled.pipeline.seed.type;
    const envs: Envelope[] = seeds.map((payload) => {
      const r = seedType.schema.safeParse(payload);
      if (!r.success || canonicalJson(r.data) !== canonicalJson(payload)) throw new TypeError(`seed is not a valid ${seedType.id}`);
      for (const g of compiled.pipeline.seed.guarantees) if (!g.test(payload)) throw new TypeError(`seed fails ${g.id}`);
      const stepKey = hashOf({ seed: compiled.pipeline.id, version: compiled.pipeline.version, payload, policyHash });
      return {
        envelopeId: makeEnvelopeId(stepKey, 0),
        stepKey,
        index: 0,
        type: seedType.id,
        producer: { agentId: SUPERVISOR_ID, version: compiled.pipeline.version, contractHash: compiled.seedHash },
        parents: [],
        payload,
        handoff: { guarantees: compiled.pipeline.seed.guarantees.map((g) => g.id).sort(), dataClass: 'P0', obligations: [], pins: { policyHash } },
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
    });
    this.event(runId, 'run_started', { pipeline: compiled.pipeline.id, seeds: envs.length });
    return this.drain(runId);
  }

  /** Continues a crashed run. Finished steps replay from the store; nothing finished runs again. */
  async resume(runId: string): Promise<RunReport> {
    const run = this.d.store.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    if (run.policy_hash !== this.d.policyHash) throw new Error(`run ${runId} used a different policy; start a new run instead`);
    this.event(runId, 'run_resumed', {});
    return this.drain(runId);
  }

  private route(runId: string, env: Envelope): void {
    const consumers = this.d.compiled.routes.get(env.type) ?? [];
    for (const to of consumers) this.d.store.enqueue(runId, this.d.compiled.stage.get(to) ?? 0, to, env.envelopeId);
    if (consumers.length === 0) {
      const ids = openObligations(env);
      if (ids.length > 0) this.leaves.push({ envelopeId: env.envelopeId, ids });
    }
  }

  private failure(key: string, threshold: number, runId: string): void {
    if (this.breakers.failure(key, threshold)) this.event(runId, 'breaker_open', { key });
  }

  private async drain(runId: string): Promise<RunReport> {
    const { store, registry, compiled, tracker } = this.d;
    let count = 0;
    for (let item = store.nextQueued(runId); item; item = store.nextQueued(runId)) {
      const agent = registry.get(item.agent_id);
      const team = compiled.teamOf.get(item.agent_id);
      const agentKey = `agent:${item.agent_id}`;
      const teamKey = `team:${team?.id ?? '?'}`;
      if (this.breakers.isOpen(agentKey) || this.breakers.isOpen(teamKey)) {
        store.markQueue(runId, item.agent_id, item.envelope_id, 'skipped');
        this.event(runId, 'step_skipped', { agent: item.agent_id, reason: 'breaker_open' });
        continue;
      }
      const input = store.getEnvelope(item.envelope_id);
      const outcome: StepOutcome = await executeStep(this.exec, runId, agent, input);
      count += 1;
      this.d.afterStep?.(count);

      store.tx(() => {
        if (outcome.kind === 'done') {
          if (outcome.replayed) this.replayed += 1;
          for (const out of outcome.outputs) {
            this.route(runId, out);
            this.track(out, outcome.stepKey, item.agent_id, 'done');
          }
        } else if (outcome.kind === 'quarantined') {
          this.track(input, outcome.stepKey, item.agent_id, 'quarantined');
        }
        store.markQueue(runId, item.agent_id, item.envelope_id, outcome.kind);
      });

      if (outcome.kind === 'failed') {
        this.failure(agentKey, agent.contract.breaker.consecutiveFailures, runId);
        if (team) this.failure(teamKey, team.breaker.consecutiveFailures, runId);
      } else if (outcome.kind === 'done') {
        this.breakers.success(agentKey);
        this.breakers.success(teamKey);
      }
    }
    store.finishRun(runId, this.d.clock.now());
    const report: RunReport = {
      runId,
      status: 'completed',
      queue: store.queueCounts(runId),
      replayed: this.replayed,
      openObligations: [...this.leaves].sort((a, b) => (a.envelopeId < b.envelopeId ? -1 : 1)),
      costUsd: store.runCost(runId),
    };
    this.event(runId, 'run_finished', report);
    return report;
  }

  private track(env: Envelope, stepKey: string, agentId: string, outcome: 'done' | 'quarantined'): void {
    const t = this.d.tracker;
    if (!t) return;
    const key = t.keyOf(env);
    const ev = t.eventFor(agentId, outcome);
    if (key !== null && ev !== null) this.d.store.applyTransition(key, t.kind, stepKey, ev, t.machine);
  }
}
