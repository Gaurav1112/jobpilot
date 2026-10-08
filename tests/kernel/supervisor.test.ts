import { describe, expect, it } from 'vitest';
import { defineAgent } from '../../src/kernel/agent.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { defineContract } from '../../src/kernel/contract.js';
import { KernelError } from '../../src/kernel/errors.js';
import { fakeLlm } from '../../src/kernel/fakes.js';
import { builtinGuardrails } from '../../src/kernel/guardrails/builtin.js';
import { mergePolicy, policyHash, PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import type { LlmProvider } from '../../src/kernel/providers.js';
import { Registry } from '../../src/kernel/registry.js';
import { verifyChain } from '../../src/kernel/store/audit.js';
import { Store } from '../../src/kernel/store/store.js';
import { Supervisor, type SupervisorDeps } from '../../src/kernel/supervisor.js';
import { compileWiring, type Pipeline } from '../../src/kernel/wiring.js';
import { demoScorer, demoScorerContract, demoSource, demoSourceContract } from '../../src/demo/agents.js';
import { demoKernel } from '../../src/demo/kernel.js';
import { demoLlm, demoMachine, demoPipeline } from '../../src/demo/pipeline.js';

const seed = { count: 5, prefix: 'demo' };
const invocations = () => {
  const calls: string[] = [];
  return { calls, onInvoke: (agent: string, stepKey: string) => calls.push(`${agent}:${stepKey}`) };
};

describe('supervisor end to end', () => {
  it('runs the demo pipeline: 1 source step, 5 scorer steps, every obligation discharged', async () => {
    const k = demoKernel();
    const r = await k.supervisor.start('run-1', [seed]);
    expect(r.queue).toEqual({ pending: 0, done: 6, failed: 0, quarantined: 0, skipped: 0 });
    expect(r.openObligations).toEqual([]);
    expect(r.costUsd).toBeCloseTo(0.005);
    expect(k.store.entityState('demo-003')).toBe('SCORED');
    expect(verifyChain(k.store)).toMatchObject({ ok: true });
  });

  it('is deterministic: two fresh databases end byte-identical', async () => {
    const a = demoKernel();
    const b = demoKernel();
    await a.supervisor.start('run-a', [seed]);
    await b.supervisor.start('run-b', [seed]);
    expect(a.store.dump('envelopes', 'envelope_id')).toBe(b.store.dump('envelopes', 'envelope_id'));
    expect(a.store.dump('entities', 'entity_id')).toBe(b.store.dump('entities', 'entity_id'));
    expect(a.store.dump('steps', 'step_key')).toBe(b.store.dump('steps', 'step_key'));
  });

  it('replays: a second run on the same database invokes no agent and pays nothing', async () => {
    const store = Store.open(':memory:');
    await demoKernel({ store }).supervisor.start('run-1', [seed]);
    const before = store.dump('envelopes', 'envelope_id');
    const inv = invocations();
    const r = await demoKernel({ store, onInvoke: inv.onInvoke }).supervisor.start('run-2', [seed]);
    expect(inv.calls).toEqual([]);
    expect(r.replayed).toBe(6);
    expect(r.costUsd).toBe(0);
    expect(store.dump('envelopes', 'envelope_id')).toBe(before);
  });

  it('survives a crash between a step and its routing: resume runs no finished step twice', async () => {
    const store = Store.open(':memory:');
    const inv = invocations();
    const crashing = demoKernel({ store, onInvoke: inv.onInvoke, afterStep: (n) => { if (n === 3) throw new Error('simulated crash'); } });
    await expect(crashing.supervisor.start('run-1', [seed])).rejects.toThrow('simulated crash');
    const r = await demoKernel({ store, onInvoke: inv.onInvoke }).supervisor.resume('run-1');
    expect(r.queue.done).toBe(6);
    expect(new Set(inv.calls).size).toBe(inv.calls.length);
    const clean = demoKernel();
    await clean.supervisor.start('run-1', [seed]);
    expect(store.dump('envelopes', 'envelope_id')).toBe(clean.store.dump('envelopes', 'envelope_id'));
    expect(store.dump('entities', 'entity_id')).toBe(clean.store.dump('entities', 'entity_id'));
  });

  it('quarantines outputs that break a guarantee and moves the entity to QUARANTINED', async () => {
    const k = demoKernel({ llm: fakeLlm(() => JSON.stringify({ score: 99, reason: 'too keen' })) });
    const r = await k.supervisor.start('run-1', [seed]);
    expect(r.queue).toMatchObject({ done: 1, quarantined: 5 });
    expect(k.store.entityState('demo-001')).toBe('QUARANTINED');
    const trip = k.store.events('run-1').find((e) => e.kind === 'step_quarantined');
    expect(JSON.parse(trip!.data).verdict).toMatchObject({ id: 'G-POST', verdict: 'trip' });
  });

  it('opens the agent breaker after 3 consecutive failures and skips the rest', async () => {
    let calls = 0;
    const down = { host: 'api.anthropic.com', async complete() { calls += 1; throw new KernelError('overloaded', '529'); } };
    const k = demoKernel({ llm: down });
    const r = await k.supervisor.start('run-1', [seed]);
    expect(r.queue).toMatchObject({ done: 1, failed: 3, skipped: 2 });
    expect(calls).toBe(9);
    expect(k.store.events('run-1').some((e) => e.kind === 'breaker_open')).toBe(true);
  });

  it('reports the open obligations of an input whose step failed', async () => {
    const k = demoKernel({ llm: fakeLlm(() => 'not json') });
    const r = await k.supervisor.start('run-1', [{ count: 2, prefix: 'demo' }]);
    expect(r.queue).toMatchObject({ failed: 2 });
    expect(r.openObligations).toHaveLength(2);
    for (const o of r.openObligations) {
      expect(o.ids).toEqual(['demo.scored']);
      expect(k.store.getEnvelope(o.envelopeId).type).toBe('DemoItem@1');
    }
  });

  it('reports the open obligations of inputs skipped by an open breaker', async () => {
    const down = { host: 'api.anthropic.com', async complete() { throw new KernelError('overloaded', '529'); } };
    const r = await demoKernel({ llm: down }).supervisor.start('run-1', [seed]);
    expect(r.queue).toMatchObject({ failed: 3, skipped: 2 });
    expect(r.openObligations).toHaveLength(5);
  });

  it('gives seed envelopes the class the pipeline declares, so a P0-only source refuses a P1 seed at the door', async () => {
    const store = Store.open(':memory:');
    const inv = invocations();
    const p1: Pipeline = { ...demoPipeline, seed: { ...demoPipeline.seed, dataClass: 'P1' } };
    const r = await handBuilt({ store, pipeline: p1, scorer: demoScorer, onInvoke: inv.onInvoke }).start('run-1', [seed]);
    expect(r.queue).toMatchObject({ done: 0, quarantined: 1 });
    expect(inv.calls).toEqual([]);
    const trip = store.events('run-1').find((e) => e.kind === 'step_quarantined');
    expect(JSON.parse(trip!.data).verdict).toMatchObject({ id: 'G-DATACLASS', verdict: 'trip' });
  });

  it('does not retry invalid model output', async () => {
    const llm = fakeLlm(() => 'not json');
    const r = await demoKernel({ llm }).supervisor.start('run-1', [{ count: 2, prefix: 'demo' }]);
    expect(r.queue).toMatchObject({ failed: 2 });
    expect(llm.calls).toHaveLength(2);
  });

  it('stops paying once the run budget is spent, and lets the rest wait', async () => {
    const r = await demoKernel({ userPolicy: { maxUsdPerRun: 0.003 } }).supervisor.start('run-1', [seed]);
    expect(r.queue).toMatchObject({ done: 4, skipped: 2 });
    expect(r.costUsd).toBeCloseTo(0.003);
  });

  it('refuses an invalid seed before anything runs', async () => {
    const k = demoKernel();
    await expect(k.supervisor.start('run-1', [{ count: 0, prefix: 'demo' }])).rejects.toThrow(/not a valid DemoRequest@1/);
    await expect(k.supervisor.start('run-2', [{ count: 1, prefix: 'demo', extra: 1 }])).rejects.toThrow(/not a valid/);
  });

  it('refuses to resume a run under a different policy', async () => {
    const store = Store.open(':memory:');
    const crashing = demoKernel({ store, afterStep: (n) => { if (n === 2) throw new Error('simulated crash'); } });
    await expect(crashing.supervisor.start('run-1', [seed])).rejects.toThrow('simulated crash');
    await expect(demoKernel({ store, userPolicy: { maxUsdPerRun: 1 } }).supervisor.resume('run-1')).rejects.toThrow(/different policy/);
  });

  it('survives the same entity arriving twice: the duplicate is audited, the run completes', async () => {
    const k = demoKernel();
    const r = await k.supervisor.start('run-1', [{ count: 2, prefix: 'demo' }, { count: 3, prefix: 'demo' }]);
    expect(r.queue).toMatchObject({ pending: 0, failed: 0 });
    const rejected = k.store.events('run-1').filter((e) => e.kind === 'transition_rejected').map((e) => JSON.parse(e.data).entity as string);
    expect(rejected).toContain('demo-001');
    expect(rejected).toContain('demo-002');
    expect(k.store.entityState('demo-003')).toBe('SCORED');
  });

  it('keeps open obligations across a resume, and blocks the success state while they are open', async () => {
    const store = Store.open(':memory:');
    const crashing = handBuilt({ store, afterStep: (n) => { if (n === 3) throw new Error('simulated crash'); } });
    await expect(crashing.start('run-1', [seed])).rejects.toThrow('simulated crash');
    const r = await handBuilt({ store }).resume('run-1');
    for (const id of ['demo-001', 'demo-002', 'demo-003', 'demo-004', 'demo-005']) expect(store.entityState(id)).toBe('DISCOVERED');
    const blocked = store.events('run-1').filter((e) => e.kind === 'obligation_blocked').map((e) => JSON.parse(e.data) as { entity: string; event: string; ids: string[] });
    expect(blocked.map((b) => b.entity).sort()).toEqual(['demo-001', 'demo-002', 'demo-003', 'demo-004', 'demo-005']);
    expect(blocked.every((b) => b.event === 'scored' && b.ids.join() === 'demo.scored')).toBe(true);
    expect(r.openObligations).toHaveLength(5);
    for (const o of r.openObligations) {
      expect(o.ids).toEqual(['demo.scored']);
      expect(store.getEnvelope(o.envelopeId).type).toBe('DemoScore@1');
    }
    expect([...r.openObligations].map((o) => o.envelopeId)).toEqual([...r.openObligations].map((o) => o.envelopeId).sort());
  });

  it('does not carry one run\'s obligations or replay count into the next run on the same instance', async () => {
    const sup = handBuilt({ store: Store.open(':memory:') });
    const r1 = await sup.start('run-1', [{ count: 2, prefix: 'a' }]);
    expect(r1.openObligations).toHaveLength(2);
    expect(r1.replayed).toBe(0);
    const r2 = await sup.start('run-2', [{ count: 2, prefix: 'a' }]);
    expect(r2.replayed).toBe(3);
    expect(r2.openObligations).toEqual(r1.openObligations);
    const r3 = await sup.start('run-3', [{ count: 1, prefix: 'b' }]);
    expect(r3.replayed).toBe(0);
    expect(r3.openObligations).toHaveLength(1);
    expect(r1.openObligations.map((o) => o.envelopeId)).not.toContain(r3.openObligations[0]!.envelopeId);
  });

  it('survives a crash right after the source step, before its fan-out is routed', async () => {
    const store = Store.open(':memory:');
    const inv = invocations();
    const crashing = demoKernel({ store, onInvoke: inv.onInvoke, afterStep: (n) => { if (n === 1) throw new Error('simulated crash'); } });
    await expect(crashing.supervisor.start('run-1', [seed])).rejects.toThrow('simulated crash');
    const r = await demoKernel({ store, onInvoke: inv.onInvoke }).supervisor.resume('run-1');
    expect(r.queue.done).toBe(6);
    expect(new Set(inv.calls).size).toBe(inv.calls.length);
    expect(r.replayed).toBe(1);
  });

  it('guards the run lifecycle', async () => {
    const k = demoKernel();
    await k.supervisor.start('run-1', [seed]);
    await expect(k.supervisor.start('run-1', [seed])).rejects.toThrow(/already exists/);
    await expect(k.supervisor.resume('run-1')).rejects.toThrow(/already completed/);
    await expect(k.supervisor.start('run-x', [{ count: 0, prefix: 'demo' }])).rejects.toThrow(/not a valid/);
    expect(k.store.getRun('run-x')).toBeUndefined();
  });

  it('opens the team breaker before the agent breaker when the team is stricter', async () => {
    const down = { host: 'api.anthropic.com', async complete() { throw new KernelError('overloaded', '529'); } };
    const strict: Pipeline = { ...demoPipeline, teams: demoPipeline.teams.map((t) => (t.id === 'evaluation' ? { ...t, breaker: { consecutiveFailures: 2 } } : t)) };
    const store = Store.open(':memory:');
    const r = await handBuilt({ store, llm: down, pipeline: strict, scorer: demoScorer }).start('run-1', [seed]);
    expect(r.queue).toMatchObject({ done: 1, failed: 2, skipped: 3 });
    const opened = store.events('run-1').filter((e) => e.kind === 'breaker_open').map((e) => JSON.parse(e.data).key as string);
    expect(opened).toContain('team:evaluation');
  });

  it('replays across a minor version bump of the source (G-LINEAGE remembers past versions of the same major)', async () => {
    const store = Store.open(':memory:');
    await handBuilt({ store, scorer: demoScorer }).start('run-1', [seed]);
    const minor = defineAgent(defineContract({ ...demoSourceContract, version: '1.1.0' }), demoSource.run);
    const inv = invocations();
    const r = await handBuilt({ store, scorer: demoScorer, source: minor, onInvoke: inv.onInvoke }).start('run-2', [seed]);
    expect(r.queue).toMatchObject({ pending: 0, done: 6, quarantined: 0, failed: 0 });
    expect(inv.calls).toEqual([]);
    expect(store.events('run-2').filter((e) => e.kind === 'step_replayed')).toHaveLength(6);
    expect(store.entityState('demo-003')).toBe('SCORED');
  });

  it('re-executes the source after a major bump and still completes without quarantine', async () => {
    const store = Store.open(':memory:');
    await handBuilt({ store, scorer: demoScorer }).start('run-1', [seed]);
    const major = defineAgent(defineContract({ ...demoSourceContract, version: '2.0.0' }), demoSource.run);
    const inv = invocations();
    const r = await handBuilt({ store, scorer: demoScorer, source: major, onInvoke: inv.onInvoke }).start('run-2', [seed]);
    expect(r.queue).toMatchObject({ pending: 0, done: 6, quarantined: 0, failed: 0 });
    expect(inv.calls.map((c) => c.split(':')[0])).toEqual(['demo-source']);
    expect(store.entityState('demo-003')).toBe('SCORED');
  });

  it('releases quarantined steps: a new run with a good model scores every item', async () => {
    const store = Store.open(':memory:');
    const bad = demoKernel({ store, llm: fakeLlm(() => JSON.stringify({ score: 99, reason: 'too keen' })) });
    await bad.supervisor.start('run-1', [seed]);
    const q = store.quarantinedSteps();
    expect(q).toHaveLength(5);
    expect(q.every((s) => s.agent_id === 'demo-scorer' && (s.detail ?? '').includes('G-POST'))).toBe(true);
    expect(store.entityState('demo-001')).toBe('QUARANTINED');
    for (const s of q) {
      expect(store.releaseQuarantine(s.step_key, 'release-x', '2026-10-08T08:00:00.000Z', bad.policyHash)).toMatchObject({ released: true, entities: [expect.any(String)] });
    }
    expect(store.quarantinedSteps()).toEqual([]);
    expect(store.entityState('demo-001')).toBe('DISCOVERED');
    expect(store.events('release-x').map((e) => e.kind)).toEqual(Array(5).fill('quarantine_released'));
    const good = demoLlm();
    const r = await demoKernel({ store, llm: good }).supervisor.start('run-2', [seed]);
    expect(r.queue).toMatchObject({ done: 6, quarantined: 0 });
    expect(good.calls).toHaveLength(5);
    for (const id of ['demo-001', 'demo-002', 'demo-003', 'demo-004', 'demo-005']) expect(store.entityState(id)).toBe('SCORED');
    expect(verifyChain(store)).toMatchObject({ ok: true });
  });

  it('does not release a step that is not quarantined', async () => {
    const k = demoKernel();
    await k.supervisor.start('run-1', [seed]);
    const done = JSON.parse(k.store.events('run-1').find((e) => e.kind === 'step_done')!.data).stepKey as string;
    const before = k.store.events().length;
    expect(k.store.releaseQuarantine(done, 'release-x', '2026-10-08T08:00:00.000Z', k.policyHash)).toEqual({ released: false, entities: [] });
    expect(k.store.releaseQuarantine('no-such-key', 'release-x', '2026-10-08T08:00:00.000Z', k.policyHash)).toEqual({ released: false, entities: [] });
    expect(k.store.getStep(done)?.status).toBe('done');
    expect(k.store.events()).toHaveLength(before);
  });
});

/** The demoKernel wiring, by hand, with a scorer that by default leaves `demo.scored` open. */
function handBuilt(o: {
  store: Store;
  llm?: LlmProvider;
  pipeline?: Pipeline;
  scorer?: typeof demoScorer;
  source?: typeof demoSource;
  onInvoke?: SupervisorDeps['onInvoke'];
  afterStep?: SupervisorDeps['afterStep'];
}): Supervisor {
  const lazyScorer = defineAgent(defineContract({ ...demoScorerContract, obligations: { adds: [], discharges: [] } }), demoScorer.run);
  const registry = new Registry();
  registry.register(o.source ?? demoSource);
  registry.register(o.scorer ?? lazyScorer);
  const guardrails = builtinGuardrails();
  const compiled = compileWiring(registry, o.pipeline ?? demoPipeline, guardrails);
  const policy = mergePolicy(PRODUCT_POLICY_V1, {});
  return new Supervisor({
    store: o.store,
    registry,
    compiled,
    guardrails,
    policy,
    policyHash: policyHash(policy),
    providers: { fetch: async () => ({ status: 404, text: async () => '' }), llm: o.llm ?? demoLlm() },
    clock: fixedClock('2026-10-08T07:00:00.000Z'),
    sleep: async () => {},
    tracker: {
      kind: 'demo-item',
      machine: demoMachine,
      keyOf: (env) => (env.type === 'DemoItem@1' || env.type === 'DemoScore@1' ? (env.payload as { id: string }).id : null),
      eventFor: (agentId, outcome) => (outcome === 'quarantined' ? 'trip' : agentId === 'demo-source' ? 'discovered' : agentId === 'demo-scorer' ? 'scored' : null),
    },
    ...(o.onInvoke ? { onInvoke: o.onInvoke } : {}),
    ...(o.afterStep ? { afterStep: o.afterStep } : {}),
  });
}
