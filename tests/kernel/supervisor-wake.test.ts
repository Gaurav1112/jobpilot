import { describe, expect, it } from 'vitest';
import { demoKernel } from '../../src/demo/kernel.js';
import { demoLlm } from '../../src/demo/pipeline.js';
import { AwakeClock } from '../../src/kernel/awake.js';
import { KernelError } from '../../src/kernel/errors.js';
import { manualTimers, type ManualTimers } from '../../src/kernel/fakes.js';
import type { LlmProvider } from '../../src/kernel/providers.js';
import { Store } from '../../src/kernel/store/store.js';
import { MAX_WAKE_REQUEUES, ONLINE_MAX_POLLS, ONLINE_POLL_MS, WAKE_GRACE_MS } from '../../src/kernel/supervisor.js';

/**
 * A run that sleeps (a closed lid) and wakes: transport failures right after the wake, or while the online check says
 * offline, are not final; the step is re-queued and runs again in the same run once the online check passes (at most
 * MAX_WAKE_REQUEUES times). The awake clock runs on `manualTimers`; `suspend` is a Mac asleep.
 */
const seed = { count: 5, prefix: 'demo' };
const TEN_MINUTES = 10 * 60_000;
const kinds = (store: Store, kind: string) => store.events('run-1').filter((e) => e.kind === kind).map((e) => JSON.parse(e.data) as Record<string, unknown>);

/** The demo model: the first call sleeps 10 minutes and wakes; it then fails as `fail()` says (null: answers). */
function sleepyLlm(t: ManualTimers, fail: () => Error | null): LlmProvider & { calls: () => number } {
  const ok = demoLlm();
  let n = 0;
  return {
    ...ok,
    calls: () => n,
    complete: async (req, signal) => {
      if (n++ === 0) {
        t.suspend(TEN_MINUTES);
        t.advance(1_000); // a DarkWake: the awake clock detects the gap
      }
      const e = fail();
      if (e !== null) throw e;
      return ok.complete(req, signal);
    },
  };
}

const enotfound = (): Error => Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });

describe('supervisor: waking from sleep mid-run', () => {
  it('the named constants', () => {
    expect(WAKE_GRACE_MS).toBe(120_000);
    expect(MAX_WAKE_REQUEUES).toBe(3);
  });

  it('transport failures just after a detected wake are re-queued and succeed on retry, after the online check passes', async () => {
    const t = manualTimers();
    let netUp = false;
    let asked = 0;
    const store = Store.open(':memory:');
    const llm = sleepyLlm(t, () => (netUp ? null : enotfound()));
    const { supervisor } = demoKernel({
      store,
      llm,
      awake: new AwakeClock(t),
      online: async () => {
        asked++;
        netUp = true; // the Wi-Fi is back
        return true;
      },
    });
    const r = await supervisor.start('run-1', [seed]);
    expect(r.status).toBe('completed');
    expect(r.queue).toMatchObject({ pending: 0, failed: 0, skipped: 0 });
    expect(kinds(store, 'resumed_from_sleep')).toHaveLength(1);
    expect(kinds(store, 'resumed_from_sleep')[0]?.['sleptMs']).toBeGreaterThanOrEqual(TEN_MINUTES);
    const due = kinds(store, 'wake_retry_due');
    expect(due.length).toBeGreaterThan(0);
    expect(due.every((d) => d['why'] === 'after-wake')).toBe(true);
    expect(kinds(store, 'wake_requeued')).toHaveLength(due.length);
    expect(kinds(store, 'breaker_open')).toEqual([]); // a failure that is not final trips nothing
    expect(asked).toBe(1); // asked once, at the re-queue: it passed, so no further polls
  });

  it('a sustained outage still fails after MAX_WAKE_REQUEUES retries', async () => {
    const t = manualTimers();
    const store = Store.open(':memory:');
    const { supervisor } = demoKernel({ store, llm: sleepyLlm(t, enotfound), awake: new AwakeClock(t), online: async () => true });
    const r = await supervisor.start('run-1', [seed]);
    expect(r.status).toBe('completed');
    expect(r.queue.failed + r.queue.skipped).toBeGreaterThan(0);
    expect(r.queue.done).toBeLessThan(store.queueItems('run-1').length);
    const perItem = new Map<string, number>();
    for (const d of kinds(store, 'wake_requeued')) perItem.set(String(d['envelopeId']), (perItem.get(String(d['envelopeId'])) ?? 0) + 1);
    expect(perItem.size).toBeGreaterThan(0);
    expect([...perItem.values()].every((n) => n === MAX_WAKE_REQUEUES)).toBe(true);
  });

  it('an outage the online check never sees end: the waiting is bounded and the steps fail as before', async () => {
    const t = manualTimers();
    const store = Store.open(':memory:');
    const slept: number[] = [];
    const { supervisor } = demoKernel({ store, llm: sleepyLlm(t, enotfound), awake: new AwakeClock(t), online: async () => false, sleep: async (ms) => void slept.push(ms) });
    const r = await supervisor.start('run-1', [seed]);
    expect(r.status).toBe('completed');
    expect(r.queue.failed).toBeGreaterThan(0);
    expect(kinds(store, 'wake_requeued')).toEqual([]);
    expect(kinds(store, 'wake_retry_abandoned').length).toBeGreaterThan(0);
    expect(slept.filter((ms) => ms === ONLINE_POLL_MS)).toHaveLength(ONLINE_MAX_POLLS - 1);
  });

  it('a non-transport failure after a wake fails at once: nothing is re-queued', async () => {
    const t = manualTimers();
    const store = Store.open(':memory:');
    const llm = sleepyLlm(t, () => new KernelError('invalid_output', 'the model answered nonsense'));
    const { supervisor } = demoKernel({ store, llm, awake: new AwakeClock(t), online: async () => true });
    const r = await supervisor.start('run-1', [seed]);
    expect(kinds(store, 'resumed_from_sleep')).toHaveLength(1);
    expect(r.queue.failed).toBeGreaterThan(0);
    expect(kinds(store, 'wake_retry_due')).toEqual([]);
    expect(kinds(store, 'wake_requeued')).toEqual([]);
  });

  it('without a wake, a transport failure while the online check says offline is re-queued once it is back online', async () => {
    const t = manualTimers();
    const store = Store.open(':memory:');
    let netUp = false;
    let checks = 0;
    const ok = demoLlm();
    const llm: LlmProvider = { ...ok, complete: async (req, signal) => { if (!netUp) throw enotfound(); return ok.complete(req, signal); } };
    const { supervisor } = demoKernel({
      store,
      llm,
      awake: new AwakeClock(t),
      online: async () => {
        // offline at the failure; back on the next check, during the wait
        if (checks++ === 0) return false;
        netUp = true;
        return true;
      },
    });
    const r = await supervisor.start('run-1', [seed]);
    expect(r.queue).toMatchObject({ failed: 0, skipped: 0 });
    expect(kinds(store, 'resumed_from_sleep')).toEqual([]);
    expect(kinds(store, 'wake_retry_due').every((d) => d['why'] === 'offline')).toBe(true);
    expect(kinds(store, 'wake_requeued').length).toBeGreaterThan(0);
  });

  it('without a wake and online, a transport failure is final as before (no re-queue, the breaker counts it)', async () => {
    const t = manualTimers();
    const store = Store.open(':memory:');
    const ok = demoLlm();
    const llm: LlmProvider = { ...ok, complete: async () => { throw enotfound(); } };
    const r = await demoKernel({ store, llm, awake: new AwakeClock(t), online: async () => true }).supervisor.start('run-1', [seed]);
    expect(r.queue.failed).toBeGreaterThan(0);
    expect(r.queue.skipped).toBeGreaterThan(0);
    expect(kinds(store, 'wake_retry_due')).toEqual([]);
    expect(kinds(store, 'breaker_open').length).toBeGreaterThan(0);
  });

  it('a transport failure more than WAKE_GRACE_MS after the wake is final (online)', async () => {
    const t = manualTimers();
    const store = Store.open(':memory:');
    const ok = demoLlm();
    let n = 0;
    const llm: LlmProvider = {
      ...ok,
      complete: async () => {
        if (n++ === 0) {
          t.suspend(TEN_MINUTES);
          t.advance(1_000);
          t.advance(WAKE_GRACE_MS); // long awake after the wake
        }
        throw enotfound();
      },
    };
    const r = await demoKernel({ store, llm, awake: new AwakeClock(t), online: async () => true }).supervisor.start('run-1', [seed]);
    expect(kinds(store, 'resumed_from_sleep')).toHaveLength(1);
    expect(r.queue.failed).toBeGreaterThan(0);
    expect(kinds(store, 'wake_retry_due')).toEqual([]);
  });
});
