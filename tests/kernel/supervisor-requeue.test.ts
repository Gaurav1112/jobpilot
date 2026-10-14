import { describe, expect, it } from 'vitest';
import { demoKernel } from '../../src/demo/kernel.js';
import { demoLlm } from '../../src/demo/pipeline.js';
import type { LlmProvider } from '../../src/kernel/providers.js';
import { Store } from '../../src/kernel/store/store.js';

const seed = { count: 5, prefix: 'demo' };

/** The demo model, failing (a plain error: the broker maps it to `network`) while `down()` says so. */
function flakyLlm(down: () => boolean): LlmProvider {
  const ok = demoLlm();
  return {
    ...ok,
    complete: async (req, signal) => {
      if (down()) throw new Error('socket hang up');
      return ok.complete(req, signal);
    },
  };
}

describe('Store.requeue: a failed or skipped queue item goes back to pending', () => {
  it('re-queues failed and skipped items only, and says whether it did', async () => {
    const store = Store.open(':memory:');
    const { supervisor } = demoKernel({ store, llm: flakyLlm(() => true) });
    const r = await supervisor.start('run-1', [seed]);
    expect(r.queue.failed).toBeGreaterThan(0);
    expect(r.queue.skipped).toBeGreaterThan(0);
    const items = store.queueItems('run-1');
    const failed = items.find((q) => q.status === 'failed')!;
    const skipped = items.find((q) => q.status === 'skipped')!;
    const done = items.find((q) => q.status === 'done')!;
    expect(store.requeue('run-1', failed.agent_id, failed.envelope_id)).toBe(true);
    expect(store.requeue('run-1', skipped.agent_id, skipped.envelope_id)).toBe(true);
    expect(store.requeue('run-1', done.agent_id, done.envelope_id)).toBe(false);
    expect(store.queueCounts('run-1').pending).toBe(2);
  });
});

describe('supervisor beforeFinish: re-queue or hold a run whose queue is empty', () => {
  it('items re-queued by the hook run again, with fresh breakers, and the run completes', async () => {
    const store = Store.open(':memory:');
    let down = true;
    let asked = 0;
    const { supervisor } = demoKernel({
      store,
      llm: flakyLlm(() => down),
      beforeFinish: () => {
        asked++;
        if (asked > 1) return null;
        down = false; // the outage is over
        for (const q of store.queueItems('run-1')) if (q.status === 'failed' || q.status === 'skipped') store.requeue('run-1', q.agent_id, q.envelope_id);
        return null;
      },
    });
    const r = await supervisor.start('run-1', [seed]);
    expect(store.events('run-1').some((e) => e.kind === 'breaker_open')).toBe(true); // the outage tripped the breaker
    expect(r.status).toBe('completed');
    expect(r.queue).toMatchObject({ pending: 0, failed: 0, skipped: 0 });
    expect(asked).toBe(2);
    expect(store.events('run-1').filter((e) => e.kind === 'run_requeued')).toHaveLength(1);
  });

  it('a reason from the hook pauses the run (incomplete); a resume without it completes', async () => {
    const store = Store.open(':memory:');
    const r = await demoKernel({ store, beforeFinish: () => 'retry wait' }).supervisor.start('run-1', [seed]);
    expect(r.status).toBe('paused');
    expect(store.getRun('run-1')?.status).not.toBe('completed');
    expect(store.events('run-1').filter((e) => e.kind === 'run_paused').map((e) => JSON.parse(e.data))).toEqual([{ reason: 'retry wait', pending: 0 }]);
    const again = await demoKernel({ store }).supervisor.resume('run-1');
    expect(again.status).toBe('completed');
  });

  it('a hook that re-queues nothing and gives no reason finishes the run, asked once', async () => {
    let asked = 0;
    const r = await demoKernel({
      beforeFinish: () => {
        asked++;
        return null;
      },
    }).supervisor.start('run-1', [seed]);
    expect(r.status).toBe('completed');
    expect(asked).toBe(1);
  });
});
