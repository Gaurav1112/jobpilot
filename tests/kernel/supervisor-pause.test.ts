import { describe, expect, it } from 'vitest';
import { demoKernel } from '../../src/demo/kernel.js';
import { Store } from '../../src/kernel/store/store.js';

const seed = { count: 5, prefix: 'demo' };

describe('supervisor pauseBefore: a cooperative pause between steps', () => {
  it('stops before the next step, leaves the run incomplete, and a resume finishes it with nothing executed twice', async () => {
    const store = Store.open(':memory:');
    let steps = 0;
    const calls: string[] = [];
    const k = demoKernel({ store, onInvoke: (a, s) => calls.push(`${a}:${s}`), afterStep: () => void steps++, pauseBefore: () => (steps >= 2 ? 'slice limit' : null) });
    const r = await k.supervisor.start('run-1', [seed]);
    expect(r.status).toBe('paused');
    expect(r.queue).toMatchObject({ done: 2, pending: 4 });
    expect(store.getRun('run-1')?.status).not.toBe('completed');
    expect(store.events('run-1').filter((e) => e.kind === 'run_paused').map((e) => JSON.parse(e.data))).toEqual([{ reason: 'slice limit', pending: 4 }]);
    expect(store.events('run-1').some((e) => e.kind === 'run_finished')).toBe(false);
    const resumed = await demoKernel({ store, onInvoke: (a, s) => calls.push(`${a}:${s}`) }).supervisor.resume('run-1');
    expect(resumed.status).toBe('completed');
    expect(resumed.queue).toEqual({ pending: 0, done: 6, failed: 0, quarantined: 0, skipped: 0 });
    expect(new Set(calls).size).toBe(calls.length);
    expect(calls).toHaveLength(6);
  });

  it('without the hook nothing changes: the run completes', async () => {
    const r = await demoKernel().supervisor.start('run-1', [seed]);
    expect(r.status).toBe('completed');
  });
});
