import { describe, expect, it } from 'vitest';
import { KernelError } from '../../src/kernel/errors.js';
import { fakeLlm } from '../../src/kernel/fakes.js';
import { verifyChain } from '../../src/kernel/store/audit.js';
import { Store } from '../../src/kernel/store/store.js';
import { demoKernel } from '../../src/demo/kernel.js';

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
    await demoKernel({ store }).supervisor.start('run-1', [seed]);
    await expect(demoKernel({ store, userPolicy: { maxUsdPerRun: 1 } }).supervisor.resume('run-1')).rejects.toThrow(/different policy/);
  });
});
