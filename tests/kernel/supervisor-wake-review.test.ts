import { describe, expect, it } from 'vitest';
import { defineAgent } from '../../src/kernel/agent.js';
import { demoKernel } from '../../src/demo/kernel.js';
import { demoAgents, demoLlm } from '../../src/demo/pipeline.js';
import { AwakeClock } from '../../src/kernel/awake.js';
import { KernelError } from '../../src/kernel/errors.js';
import { manualTimers, type ManualTimers } from '../../src/kernel/fakes.js';
import type { LlmProvider } from '../../src/kernel/providers.js';
import { Store } from '../../src/kernel/store/store.js';
import { MAX_WAKE_REQUEUES } from '../../src/kernel/supervisor.js';

/** The sleep-safe review's supervisor findings: probes only on network errors (I1), one re-queue budget (I3), the
 * breaker reset after a wake re-queue, and the event order at the end of a run. */
const seed = { count: 5, prefix: 'demo' };
const TEN_MINUTES = 10 * 60_000;
const kinds = (store: Store, kind: string, run = 'run-1') => store.events(run).filter((e) => e.kind === kind).map((e) => JSON.parse(e.data) as Record<string, unknown>);
const enotfound = (): Error => Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
const wake = (t: ManualTimers): void => {
  t.suspend(TEN_MINUTES);
  t.advance(1_000);
};

describe('supervisor wake rule: review fixes', () => {
  it('I1: a per-host timeout or a 5xx with no wake asks no online probe; a network error does', async () => {
    for (const [err, probes] of [[() => new KernelError('timeout', 'request to x timed out'), 0], [() => new KernelError('overloaded', '503 from x'), 0], [enotfound, 1]] as const) {
      const t = manualTimers();
      let asked = 0;
      const ok = demoLlm();
      const llm: LlmProvider = { ...ok, complete: async () => { throw err(); } };
      await demoKernel({ llm, awake: new AwakeClock(t), online: async () => { asked++; return true; } }).supervisor.start('run-1', [seed]);
      expect(asked, String(err().message)).toBe(probes); // one probe, then cached
    }
  });

  it('I3: re-queues by another layer (requeueEvents) and wake re-queues share one budget of MAX_WAKE_REQUEUES', async () => {
    const t = manualTimers();
    const store = Store.open(':memory:');
    const ok = demoLlm();
    let calls = 0;
    const llm: LlmProvider = {
      ...ok,
      complete: async () => {
        if (++calls === 7) wake(t); // the third pass starts after a wake (passes 1 and 2 make 3 calls each: the breaker opens)
        throw enotfound();
      },
    };
    const own = new Map<string, number>();
    const { supervisor } = demoKernel({
      store, llm, awake: new AwakeClock(t), online: async () => true, requeueEvents: ['ext.requeued'],
      // another layer (as coverage's retry) re-queues each failed or skipped item twice by its own count
      beforeFinish: () => {
        for (const q of store.queueItems('run-1')) {
          if (q.status !== 'failed' && q.status !== 'skipped') continue;
          const n = own.get(q.envelope_id) ?? 0;
          if (n >= 2) continue;
          own.set(q.envelope_id, n + 1);
          store.requeue('run-1', q.agent_id, q.envelope_id);
          store.appendEvent('run-1', '2026-10-08T07:00:00.000Z', 'ext.requeued', { agent: q.agent_id, envelopeId: q.envelope_id }, 'p');
        }
        return null;
      },
    });
    await supervisor.start('run-1', [seed]);
    const per = new Map<string, number>();
    for (const e of [...kinds(store, 'ext.requeued'), ...kinds(store, 'wake_requeued')]) per.set(String(e['envelopeId']), (per.get(String(e['envelopeId'])) ?? 0) + 1);
    expect(kinds(store, 'wake_requeued').length).toBeGreaterThan(0);
    expect(Math.max(...per.values())).toBeLessThanOrEqual(MAX_WAKE_REQUEUES);
  });

  it('a wake re-queue resets only the breakers of the re-queued agents and teams', async () => {
    const t = manualTimers();
    const store = Store.open(':memory:');
    const [source, scorer] = demoAgents;
    let sourceCalls = 0;
    // seed "a" fails (network) just after a wake on its first run; seed "b" is fine; every score is invalid
    const flakySource = defineAgent(source.contract, async (req, ctx) => {
      if (req.prefix === 'a' && sourceCalls++ === 0) {
        wake(t);
        throw new KernelError('network', 'fetch failed (ENOTFOUND)');
      }
      return source.run(req as never, ctx);
    });
    const badScorer = defineAgent(scorer.contract, async () => {
      throw new KernelError('invalid_output', 'the model answered nonsense');
    });
    const r = await demoKernel({ store, agents: [flakySource, badScorer], awake: new AwakeClock(t), online: async () => true }).supervisor.start('run-1', [
      { count: 5, prefix: 'a' },
      { count: 5, prefix: 'b' },
    ]);
    expect(kinds(store, 'wake_requeued')).toHaveLength(1);
    // the evaluation breaker opened on b's scores and stays open for a's: 3 failed, the 7 others skipped
    expect(r.queue).toMatchObject({ failed: 3, skipped: 7 });
  });

  it('resumed_from_sleep is never appended after run_finished', async () => {
    const t = manualTimers();
    const store = Store.open(':memory:');
    let first = true;
    await demoKernel({
      store, awake: new AwakeClock(t), online: async () => true,
      beforeFinish: () => {
        if (first) wake(t); // a wake while the run finishes
        first = false;
        return null;
      },
    }).supervisor.start('run-1', [seed]);
    const order = store.events('run-1').map((e) => e.kind);
    expect(order).toContain('resumed_from_sleep');
    expect(order.at(-1)).toBe('run_finished');
  });
});
