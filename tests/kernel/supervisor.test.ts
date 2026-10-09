import { describe, expect, it } from 'vitest';
import { defineAgent } from '../../src/kernel/agent.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { defineContract } from '../../src/kernel/contract.js';
import { KernelError } from '../../src/kernel/errors.js';
import { fakeFetch, fakeLlm } from '../../src/kernel/fakes.js';
import { builtinGuardrails } from '../../src/kernel/guardrails/builtin.js';
import { mergePolicy, policyHash, PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import type { LlmProvider } from '../../src/kernel/providers.js';
import { Registry } from '../../src/kernel/registry.js';
import { verifyChain } from '../../src/kernel/store/audit.js';
import { Store } from '../../src/kernel/store/store.js';
import { StateMachine } from '../../src/kernel/state-machine.js';
import { Supervisor, type SupervisorDeps, type Tracker } from '../../src/kernel/supervisor.js';
import { compileWiring, type Pipeline } from '../../src/kernel/wiring.js';
import { defineType } from '../../src/kernel/types.js';
import { z } from 'zod';
import { demoScorer, demoScorerContract, demoSource, demoSourceContract } from '../../src/demo/agents.js';
import { demoKernel } from '../../src/demo/kernel.js';
import { demoLlm, demoPipeline, demoTracker } from '../../src/demo/pipeline.js';

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
    expect(a.store.dump('entities', 'kind, entity_id')).toBe(b.store.dump('entities', 'kind, entity_id'));
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
    expect(store.dump('entities', 'kind, entity_id')).toBe(clean.store.dump('entities', 'kind, entity_id'));
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
    const r = await demoKernel({ llm: demoLlm(0.01), userPolicy: { maxUsdPerRun: 0.03 } }).supervisor.start('run-1', [seed]);
    expect(r.queue).toMatchObject({ done: 4, skipped: 2 });
    expect(r.costUsd).toBeCloseTo(0.03);
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

  it('keeps open obligations across a resume when the discharger finishes with no outputs', async () => {
    const store = Store.open(':memory:');
    const crashing = handBuilt({ store, afterStep: (n) => { if (n === 3) throw new Error('simulated crash'); } });
    await expect(crashing.start('run-1', [seed])).rejects.toThrow('simulated crash');
    const r = await handBuilt({ store }).resume('run-1');
    expect(r.queue).toMatchObject({ done: 6, failed: 0, quarantined: 0 });
    for (const id of ['demo-001', 'demo-002', 'demo-003', 'demo-004', 'demo-005']) expect(store.entityState(id)).toBe('DISCOVERED');
    expect(r.openObligations).toHaveLength(5);
    for (const o of r.openObligations) {
      expect(o.ids).toEqual(['demo.scored']);
      expect(store.getEnvelope(o.envelopeId).type).toBe('DemoItem@1');
    }
    expect([...r.openObligations].map((o) => o.envelopeId)).toEqual([...r.openObligations].map((o) => o.envelopeId).sort());
  });

  it('reports the open obligations of inputs whose step is done with zero outputs', async () => {
    const store = Store.open(':memory:');
    const r = await handBuilt({ store }).start('run-1', [{ count: 3, prefix: 'demo' }]);
    expect(r.queue).toMatchObject({ done: 4, failed: 0 });
    expect(r.openObligations).toHaveLength(3);
    for (const o of r.openObligations) {
      expect(o.ids).toEqual(['demo.scored']);
      expect(store.getEnvelope(o.envelopeId).type).toBe('DemoItem@1');
    }
    expect(store.entityState('demo-001')).toBe('DISCOVERED');
  });

  it('still blocks the success state while an obligation is open', async () => {
    const store = Store.open(':memory:');
    const early: Tracker = {
      kind: 'demo-early',
      machine: new StateMachine({ id: 'early', initial: 'NEW', terminal: ['SCORED'], success: ['SCORED'], transitions: [{ from: 'NEW', on: 'scored', to: 'SCORED' }] }),
      keyOf: (env) => (env.type === 'DemoItem@1' ? `early-${(env.payload as { id: string }).id}` : null),
      eventFor: (agentId, outcome) => (outcome === 'done' && agentId === 'demo-source' ? 'scored' : null),
    };
    await handBuilt({ store, scorer: demoScorer, trackers: [demoTracker, early] }).start('run-1', [{ count: 2, prefix: 'demo' }]);
    const blocked = store.events('run-1').filter((e) => e.kind === 'obligation_blocked').map((e) => JSON.parse(e.data) as { entity: string; ids: string[] });
    expect(blocked.map((b) => b.entity)).toEqual(['early-demo-001', 'early-demo-002']);
    expect(blocked.every((b) => b.ids.join() === 'demo.scored')).toBe(true);
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

  it('does not trust past outputs of a minor version whose security-relevant fields differ (fail closed)', async () => {
    const store = Store.open(':memory:');
    await handBuilt({ store, scorer: demoScorer }).start('run-1', [seed]);
    const minor = defineAgent(defineContract({ ...demoSourceContract, version: '1.1.0', dataClasses: { in: ['P0'], out: ['P0', 'P1'] }, emits: 'P1' }), demoSource.run);
    const inv = invocations();
    const r = await handBuilt({ store, scorer: demoScorer, source: minor, onInvoke: inv.onInvoke }).start('run-2', [seed]);
    expect(inv.calls.filter((c) => c.startsWith('demo-scorer:'))).toEqual([]);
    expect(r.queue).toMatchObject({ done: 1, quarantined: 5 });
    const trips = store.events('run-2').filter((e) => e.kind === 'step_quarantined').map((e) => JSON.parse(e.data) as { agent: string; verdict: { id: string } });
    expect(trips.every((t) => t.agent === 'demo-scorer' && t.verdict.id === 'G-LINEAGE')).toBe(true);
    expect(store.contracts().find((c) => c.version === '1.0.0' && c.agent_id === 'demo-source')?.shape).toMatchObject({ version: '1.0.0', kind: 'deterministic' });
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
      expect(store.releaseQuarantine(s.step_key, 'release-x', '2026-10-08T08:00:00.000Z', bad.policyHash)).toEqual({ released: true, entities: [{ kind: 'demo-item', entityId: expect.any(String) }], skipped: [] });
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

  it('lists and releases a door trip (no step row): after the cause is fixed a new run scores the item', async () => {
    const store = Store.open(':memory:');
    const p1src = defineAgent(defineContract({ ...demoSourceContract, dataClasses: { in: ['P0'], out: ['P0', 'P1'] }, emits: 'P1' }), demoSource.run);
    const r1 = await handBuilt({ store, scorer: demoScorer, source: p1src }).start('run-1', [seed]);
    expect(r1.queue).toMatchObject({ done: 1, quarantined: 5 });
    expect(store.entityState('demo-001')).toBe('QUARANTINED');
    const q = store.quarantinedSteps();
    expect(q).toHaveLength(5);
    for (const s of q) {
      expect(store.getStep(s.step_key)).toBeUndefined();
      expect(s.agent_id).toBe('demo-scorer');
      expect(s.detail ?? '').toContain('G-DATACLASS');
    }
    const policy = mergePolicy(PRODUCT_POLICY_V1, {});
    for (const s of q) {
      expect(store.releaseQuarantine(s.step_key, 'release-x', '2026-10-08T08:00:00.000Z', policyHash(policy))).toEqual({ released: true, entities: [{ kind: 'demo-item', entityId: expect.any(String) }], skipped: [] });
    }
    expect(store.quarantinedSteps()).toEqual([]);
    expect(store.entityState('demo-001')).toBe('DISCOVERED');
    expect(store.releaseQuarantine(q[0]!.step_key, 'release-x', '2026-10-08T08:00:00.000Z', policyHash(policy))).toEqual({ released: false, entities: [], skipped: [] });
    const fixed = defineAgent(defineContract({ ...demoSourceContract, version: '2.0.0' }), demoSource.run);
    const r2 = await handBuilt({ store, scorer: demoScorer, source: fixed }).start('run-2', [seed]);
    expect(r2.queue).toMatchObject({ done: 6, quarantined: 0 });
    for (const id of ['demo-001', 'demo-002', 'demo-003', 'demo-004', 'demo-005']) expect(store.entityState(id)).toBe('SCORED');
    expect(verifyChain(store)).toMatchObject({ ok: true });
  });

  it('leaves an entity that moved on since the trip, keeps its transition row and reports it as skipped', async () => {
    const store = Store.open(':memory:');
    const bad = demoKernel({ store, llm: fakeLlm(() => JSON.stringify({ score: 99, reason: 'too keen' })) });
    await bad.supervisor.start('run-1', [{ count: 2, prefix: 'demo' }]);
    const q = store.quarantinedSteps();
    expect(q).toHaveLength(2);
    const trip = (key: string) =>
      store.db.prepare(`SELECT entity_id, to_state FROM entity_transitions WHERE step_key = ? AND outcome = 'quarantined'`).get(key) as { entity_id: string; to_state: string };
    const [moved, kept] = q.map((s) => s.step_key) as [string, string];
    const movedId = trip(moved).entity_id;
    expect(trip(moved).to_state).toBe('QUARANTINED');
    // someone advanced the entity by hand after the trip
    store.db.prepare(`UPDATE entities SET state = 'SCORED' WHERE kind = 'demo-item' AND entity_id = ?`).run(movedId);
    const movedRef = { kind: 'demo-item', entityId: movedId };
    expect(store.releaseQuarantine(moved, 'release-x', '2026-10-08T08:00:00.000Z', bad.policyHash)).toEqual({ released: true, entities: [], skipped: [movedRef] });
    expect(store.entityState(movedId, 'demo-item')).toBe('SCORED');
    expect(trip(moved)).toEqual({ entity_id: movedId, to_state: 'QUARANTINED' });
    expect(store.getStep(moved)).toBeUndefined();
    const ev = store.events('release-x').at(-1)!;
    expect(JSON.parse(ev.data)).toEqual({ stepKey: moved, entities: [], skipped: [movedRef] });
    // releasing it again reverts nothing and deletes no step row: not released, no event
    const events = store.events().length;
    expect(store.releaseQuarantine(moved, 'release-x', '2026-10-08T08:00:00.000Z', bad.policyHash)).toEqual({ released: false, entities: [], skipped: [movedRef] });
    expect(store.events()).toHaveLength(events);
    // the untouched one is reverted as before
    const keptId = trip(kept).entity_id;
    expect(store.releaseQuarantine(kept, 'release-x', '2026-10-08T08:00:00.000Z', bad.policyHash)).toEqual({ released: true, entities: [{ kind: 'demo-item', entityId: keptId }], skipped: [] });
    expect(store.entityState(keptId, 'demo-item')).toBe('DISCOVERED');
    expect(verifyChain(store)).toMatchObject({ ok: true });
  });

  it('does not release a step that is not quarantined', async () => {
    const k = demoKernel();
    await k.supervisor.start('run-1', [seed]);
    const done = JSON.parse(k.store.events('run-1').find((e) => e.kind === 'step_done')!.data).stepKey as string;
    const before = k.store.events().length;
    expect(k.store.releaseQuarantine(done, 'release-x', '2026-10-08T08:00:00.000Z', k.policyHash)).toEqual({ released: false, entities: [], skipped: [] });
    expect(k.store.releaseQuarantine('no-such-key', 'release-x', '2026-10-08T08:00:00.000Z', k.policyHash)).toEqual({ released: false, entities: [], skipped: [] });
    expect(k.store.getStep(done)?.status).toBe('done');
    expect(k.store.events()).toHaveLength(before);
  });

  /** A second view: one entity per score, whose event depends on the envelope's payload. */
  const scoreTracker: Tracker = {
    kind: 'demo-score',
    machine: new StateMachine({ id: 'demo-score', initial: 'NEW', terminal: ['HIGH', 'LOW'], transitions: [{ from: 'NEW', on: 'high', to: 'HIGH' }, { from: 'NEW', on: 'low', to: 'LOW' }] }),
    keyOf: (env) => (env.type === 'DemoScore@1' ? `score-${(env.payload as { id: string }).id}` : null),
    eventFor: (_agent, outcome, env) => (outcome === 'done' ? ((env.payload as { score: number }).score >= 5 ? 'high' : 'low') : null),
  };

  it('applies every tracker independently, and passes the envelope to eventFor', async () => {
    const store = Store.open(':memory:');
    const r = await handBuilt({ store, scorer: demoScorer, trackers: [demoTracker, scoreTracker] }).start('run-1', [seed]);
    expect(r.queue).toMatchObject({ done: 6, failed: 0 });
    const scores = store.envelopesOfStep(JSON.parse(store.events('run-1').filter((e) => e.kind === 'step_done').at(-1)!.data).stepKey);
    const s = scores[0]!.payload as { id: string; score: number };
    expect(store.entityState(s.id)).toBe('SCORED');
    expect(store.entityState(`score-${s.id}`)).toBe(s.score >= 5 ? 'HIGH' : 'LOW');
    for (const id of ['demo-001', 'demo-002', 'demo-003', 'demo-004', 'demo-005']) {
      expect(store.entityState(id)).toBe('SCORED');
      expect(['HIGH', 'LOW']).toContain(store.entityState(`score-${id}`));
    }
  });

  it('gives each tracker its own entity namespace, even when two key the same id', async () => {
    const store = Store.open(':memory:');
    const seen: Tracker = {
      kind: 'seen-item',
      machine: new StateMachine({ id: 'seen-item', initial: 'NEW', terminal: ['SEEN'], transitions: [{ from: 'NEW', on: 'seen', to: 'SEEN' }] }),
      keyOf: (env) => (env.type === 'DemoItem@1' ? (env.payload as { id: string }).id : null),
      eventFor: (agentId, outcome) => (outcome === 'done' && agentId === 'demo-source' ? 'seen' : null),
    };
    const r = await handBuilt({ store, scorer: demoScorer, trackers: [demoTracker, seen] }).start('run-1', [seed]);
    expect(r.queue).toMatchObject({ done: 6, failed: 0 });
    expect(store.events('run-1').filter((e) => e.kind === 'transition_rejected' || e.kind === 'tracker_error')).toEqual([]);
    for (const id of ['demo-001', 'demo-002', 'demo-003', 'demo-004', 'demo-005']) {
      expect(store.entityState(id, 'demo-item')).toBe('SCORED');
      expect(store.entityState(id, 'seen-item')).toBe('SEEN');
    }
    expect(() => store.entityState('demo-001')).toThrow(/ambiguous/);
    expect(store.entityState('no-such-id')).toBeUndefined();
  });

  it('a throwing eventFor is audited and does not wedge the run or the other trackers', async () => {
    const store = Store.open(':memory:');
    const badEvent: Tracker = { ...scoreTracker, kind: 'bad-event', eventFor: () => { throw new Error('eventFor exploded'); } };
    const r = await handBuilt({ store, scorer: demoScorer, trackers: [demoTracker, badEvent] }).start('run-1', [seed]);
    expect(r.queue).toMatchObject({ pending: 0, done: 6, failed: 0 });
    const errors = store.events('run-1').filter((e) => e.kind === 'tracker_error').map((e) => JSON.parse(e.data) as { tracker: string; agent: string; stepKey: string; message: string });
    expect(errors).toHaveLength(5);
    expect(errors[0]).toMatchObject({ tracker: 'bad-event', agent: 'demo-scorer', message: 'eventFor exploded', stepKey: expect.any(String) });
    expect(store.entityState('demo-003')).toBe('SCORED');
  });

  it('a throwing keyOf quarantines the step with verdict G-TRACKER: nothing is routed or kept', async () => {
    const store = Store.open(':memory:');
    const broken: Tracker = { ...scoreTracker, kind: 'broken', keyOf: (env) => { if (env.type === 'DemoScore@1') throw new Error('keyOf exploded'); return null; } };
    const r = await handBuilt({ store, scorer: demoScorer, trackers: [demoTracker, broken] }).start('run-1', [seed]);
    expect(r.queue).toMatchObject({ pending: 0, done: 1, quarantined: 5, failed: 0 });
    const trips = store.events('run-1').filter((e) => e.kind === 'step_quarantined').map((e) => JSON.parse(e.data) as { agent: string; stepKey: string; persisted: boolean; verdict: { id: string; verdict: string; detail: string } });
    expect(trips).toHaveLength(5);
    for (const t of trips) {
      expect(t).toMatchObject({ agent: 'demo-scorer', persisted: true, verdict: { id: 'G-TRACKER', verdict: 'trip', detail: expect.stringContaining('keyOf exploded') } });
      expect(store.getStep(t.stepKey)).toMatchObject({ status: 'quarantined' });
      expect(JSON.parse(store.getStep(t.stepKey)!.detail!)).toEqual([t.verdict]);
      expect(store.envelopesOfStep(t.stepKey)).toEqual([]);
    }
    expect(store.entityState('demo-003', 'demo-item')).toBe('QUARANTINED');
    expect(store.quarantinedSteps().map((q) => q.step_key).sort()).toEqual(trips.map((t) => t.stepKey).sort());
    // A second run replays the quarantine instead of running the scorer again.
    const inv = invocations();
    const r2 = await handBuilt({ store, scorer: demoScorer, trackers: [demoTracker, broken], onInvoke: inv.onInvoke }).start('run-2', [seed]);
    expect(r2.queue).toMatchObject({ done: 1, quarantined: 5 });
    expect(inv.calls).toEqual([]);
  });
  /** demoTracker, except keyOf now throws on DemoItem@1: a tracker code change, so a replayed step trips. */
  const itemBreaker: Tracker = { ...demoTracker, keyOf: (env) => { if (env.type === 'DemoItem@1') throw new Error('keyOf regressed'); return demoTracker.keyOf(env); } };

  it('G-TRACKER on a replayed step is run-local: earlier runs keep their history, a fixed tracker heals', async () => {
    const store = Store.open(':memory:');
    await handBuilt({ store, scorer: demoScorer }).start('run-1', [seed]);
    const steps = store.dump('steps', 'step_key');
    const envelopes = store.dump('envelopes', 'envelope_id');
    const r2 = await handBuilt({ store, scorer: demoScorer, trackers: [itemBreaker] }).start('run-2', [seed]);
    expect(r2.queue).toMatchObject({ pending: 0, done: 0, quarantined: 1 });
    const trip = store.events('run-2').find((e) => e.kind === 'step_quarantined');
    expect(JSON.parse(trip!.data)).toMatchObject({ side: 'tracker', persisted: false, verdict: { id: 'G-TRACKER' } });
    expect(store.dump('steps', 'step_key')).toBe(steps);
    expect(store.dump('envelopes', 'envelope_id')).toBe(envelopes);
    expect(store.quarantinedSteps()).toEqual([]);
    const inv = invocations();
    const r3 = await handBuilt({ store, scorer: demoScorer, onInvoke: inv.onInvoke }).start('run-3', [seed]);
    expect(r3.queue).toMatchObject({ done: 6, quarantined: 0 });
    expect(r3.replayed).toBe(6);
    expect(inv.calls).toEqual([]);
  });

  it('G-TRACKER on a replayed step does not wedge the resume of a crashed run', async () => {
    const store = Store.open(':memory:');
    const crashing = handBuilt({ store, scorer: demoScorer, afterStep: (n) => { if (n === 3) throw new Error('simulated crash'); } });
    await expect(crashing.start('run-1', [seed])).rejects.toThrow('simulated crash');
    const r2 = await handBuilt({ store, scorer: demoScorer, trackers: [itemBreaker] }).start('run-2', [seed]);
    expect(r2.queue).toMatchObject({ quarantined: 1 });
    const r1 = await handBuilt({ store, scorer: demoScorer }).resume('run-1');
    expect(r1.queue).toMatchObject({ pending: 0, done: 6, failed: 0, quarantined: 0 });
    expect(store.entityState('demo-005', 'demo-item')).toBe('SCORED');
  });
});

/** The demoKernel wiring, by hand, with a scorer that by default declares `demo.scored` but finishes with no outputs, leaving it open. */
function handBuilt(o: {
  store: Store;
  llm?: LlmProvider;
  pipeline?: Pipeline;
  scorer?: typeof demoScorer;
  source?: typeof demoSource;
  onInvoke?: SupervisorDeps['onInvoke'];
  trackers?: readonly Tracker[];
  afterStep?: SupervisorDeps['afterStep'];
}): Supervisor {
  const emptyScorer = defineAgent(demoScorerContract, async () => []);
  const registry = new Registry();
  registry.register(o.source ?? demoSource);
  registry.register(o.scorer ?? emptyScorer);
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
    trackers: o.trackers ?? [demoTracker],
    ...(o.onInvoke ? { onInvoke: o.onInvoke } : {}),
    ...(o.afterStep ? { afterStep: o.afterStep } : {}),
  });
}

describe('G-BUDGET: an over-priced model call stops that agent for the rest of the run', () => {
  it('pays for exactly one 0.4 call when usdPerCall is 0.15, and skips the other four items', async () => {
    const store = Store.open(':memory:');
    const pricey = defineAgent(
      defineContract({ ...demoScorerContract, budget: { usdPerCall: 0.15, usdPerRun: 1.0 }, breaker: { consecutiveFailures: 10 } }),
      demoScorer.run,
    );
    const r = await handBuilt({ store, scorer: pricey, llm: fakeLlm(() => JSON.stringify({ score: 5, reason: 'ok' }), { usdPerCall: 0.4 }) }).start('r', [
      { count: 5, prefix: 'demo' },
    ]);
    expect(store.runCost('r')).toBeCloseTo(0.4, 10);
    expect(r.queue).toMatchObject({ failed: 1, skipped: 4 });
    const failed = store.events('r').filter((e) => e.kind === 'step_failed').map((e) => JSON.parse(e.data) as { error: string });
    expect(failed).toEqual([expect.objectContaining({ error: 'budget_exceeded' })]);
    const skipped = store.events('r').filter((e) => e.kind === 'step_skipped').map((e) => JSON.parse(e.data) as { reason: string; detail?: string });
    expect(skipped).toHaveLength(4);
    for (const s of skipped) {
      expect(s).toMatchObject({ reason: 'budget', detail: 'G-BUDGET: demo-scorer made a call above usdPerCall earlier in this run' });
    }
  });
});

describe('v1 kernel extensions: supervisor', () => {
  const Req = defineType('PaceReq', 1, z.object({ n: z.number().int().positive() }).strict());
  const Ref = defineType('PaceRef', 1, z.object({ id: z.string() }).strict());
  const Detail = defineType('PaceDetail', 1, z.object({ id: z.string(), title: z.string(), owner: z.string() }).strict());
  const HOST = 'jobs.example.test';
  const common = { version: '1.0.0', dataClasses: { in: ['P0' as const], out: ['P0' as const] }, budget: { usdPerCall: 0, usdPerRun: 0 }, timeoutMs: 1_000 };
  const lister = defineAgent(
    defineContract({ ...common, id: 'pace-lister', description: 'Lists job refs from one board', skills: ['listing'], team: 'pace-src', kind: 'io', consumes: Req, produces: Ref, capabilities: { http: true }, egress: [HOST] }),
    async (req: { n: number }, ctx) => {
      const { json } = await ctx.http!.getJson(`https://${HOST}/list?n=${req.n}`);
      return (json as string[]).map((id) => ({ id }));
    },
  );
  const packSeen: unknown[] = [];
  const detailer = defineAgent(
    defineContract({ ...common, id: 'pace-detailer', description: 'Fetches one job detail', skills: ['detailing'], team: 'pace-det', kind: 'io', consumes: Ref, produces: Detail, capabilities: { http: true, pack: true }, egress: [HOST] }),
    async (ref: { id: string }, ctx) => {
      packSeen.push(ctx.pack);
      const { json } = await ctx.http!.getJson(`https://${HOST}/job/${ref.id}`);
      return [{ id: ref.id, title: (json as { title: string }).title, owner: (ctx.pack as { name: string }).name }];
    },
  );
  const pipeline: Pipeline = {
    id: 'pace',
    version: '1.0.0',
    seed: { type: Req, guarantees: [] },
    teams: [
      { id: 'pace-src', lead: 'pace-src-lead', members: ['pace-lister'], exitGuarantees: [], breaker: { consecutiveFailures: 3 } },
      { id: 'pace-det', lead: 'pace-det-lead', members: ['pace-detailer'], exitGuarantees: [], breaker: { consecutiveFailures: 3 } },
    ],
    edges: [
      { type: 'PaceReq@1', to: 'pace-lister' },
      { type: 'PaceRef@1', to: 'pace-detailer' },
    ],
  };
  const build = (store: Store, slept: number[], pack: unknown, packHash: string, inv?: ReturnType<typeof invocations>) => {
    const registry = new Registry();
    registry.register(lister);
    registry.register(detailer);
    const guardrails = builtinGuardrails();
    const policy = mergePolicy(PRODUCT_POLICY_V1, {});
    const fetch = fakeFetch({
      [`https://${HOST}/list?n=2`]: { body: '["a","b"]' },
      [`https://${HOST}/job/a`]: { body: '{"title":"A"}' },
      [`https://${HOST}/job/b`]: { body: '{"title":"B"}' },
    });
    const sup = new Supervisor({
      store,
      registry,
      compiled: compileWiring(registry, pipeline, guardrails),
      guardrails,
      policy,
      policyHash: policyHash(policy),
      providers: { fetch },
      clock: fixedClock('2026-10-08T07:00:00.000Z'),
      sleep: async (ms) => {
        slept.push(ms);
      },
      pack,
      packHash,
      ...(inv ? { onInvoke: inv.onInvoke } : {}),
    });
    return { sup, fetch };
  };

  it('paces requests to one host across agents: every request after the first waits at least minHostIntervalMs', async () => {
    const slept: number[] = [];
    const { sup, fetch } = build(Store.open(':memory:'), slept, { name: 'Asha Rao' }, 'pack-1');
    const r = await sup.start('run-1', [{ n: 2 }]);
    expect(r.queue).toMatchObject({ done: 3, failed: 0 });
    expect(fetch.calls).toHaveLength(3);
    expect(slept).toHaveLength(2);
    for (const ms of slept) expect(ms).toBeGreaterThanOrEqual(PRODUCT_POLICY_V1.minHostIntervalMs);
  });

  it('freezes one deep copy of the pack: the caller\'s object stays mutable, typed arrays do not break it', async () => {
    packSeen.length = 0;
    const pack = { name: 'Asha Rao', tags: ['go'], bytes: new Uint8Array([1, 2]) };
    const r = await build(Store.open(':memory:'), [], pack, 'pack-1').sup.start('run-1', [{ n: 2 }]);
    expect(r.queue).toMatchObject({ done: 3, failed: 0 });
    expect(Object.isFrozen(pack)).toBe(false);
    expect(Object.isFrozen(pack.tags)).toBe(false);
    const seen = packSeen[0] as typeof pack;
    expect(seen).not.toBe(pack);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen.tags)).toBe(true);
    expect(packSeen[1]).toBe(seen);
  });

  it('passes the pack to pack agents, and a pack edit re-runs only the agents that read it', async () => {
    packSeen.length = 0;
    const store = Store.open(':memory:');
    const r1 = await build(store, [], { name: 'Asha Rao' }, 'pack-1').sup.start('run-1', [{ n: 2 }]);
    expect(r1.queue).toMatchObject({ done: 3 });
    expect(packSeen).toEqual([{ name: 'Asha Rao' }, { name: 'Asha Rao' }]);
    const inv = invocations();
    const same = await build(store, [], { name: 'Asha Rao' }, 'pack-1', inv).sup.start('run-2', [{ n: 2 }]);
    expect(same.replayed).toBe(3);
    expect(inv.calls).toEqual([]);
    const edited = await build(store, [], { name: 'Asha R.' }, 'pack-2', inv).sup.start('run-3', [{ n: 2 }]);
    expect(inv.calls.map((c) => c.split(':')[0])).toEqual(['pace-detailer', 'pace-detailer']);
    expect(edited.replayed).toBe(1);
    expect(packSeen.slice(2)).toEqual([{ name: 'Asha R.' }, { name: 'Asha R.' }]);
  });
});
