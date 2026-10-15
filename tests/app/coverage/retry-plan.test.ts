import { describe, expect, it } from 'vitest';
import { makeRunGate, memoryHostStateStore, TRANSIENT_DISABLE_MS } from '../../../src/app/coverage/gate.js';
import { MAX_REQUEUES, retryPlan, REQUEUED, TRANSIENT_RETRY_AFTER_MS } from '../../../src/app/coverage/pipeline.js';
import { Store } from '../../../src/kernel/store/store.js';

const T0 = '2026-10-11T02:00:00.000Z';
const after = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();
const RUN = 'coverage-2026-10-11.locate';
const AGENT = 'careers-locator';

/** A stage run with one failed (or skipped) item `e1`, its last event as given, and `requeues` earlier re-queues. */
function stage(last: { kind: 'step_failed' | 'step_skipped'; data: Record<string, unknown> }, requeues = 0) {
  const store = Store.open(':memory:');
  store.startRun(RUN, 'jobpilot-coverage/locate@1.0.0', 'p', T0);
  store.enqueue(RUN, 0, AGENT, 'e1');
  for (let i = 0; i < requeues; i++) store.appendEvent(RUN, T0, REQUEUED, { agent: AGENT, envelopeId: 'e1', why: 'network' }, 'p');
  store.markQueue(RUN, AGENT, 'e1', last.kind === 'step_failed' ? 'failed' : 'skipped');
  store.appendEvent(RUN, T0, last.kind, { agent: AGENT, envelopeId: 'e1', ...last.data }, 'p');
  return store;
}
const gate = () => makeRunGate({ runKey: 'coverage-2026-10-11', store: memoryHostStateStore() });
const plan = (store: Store, g = gate(), now: string) => {
  const p = retryPlan(store, RUN, g, now);
  return { due: p.now.map((d) => d.why), waiting: p.waiting };
};

describe('C1-c: the re-queue plan of a stage run', () => {
  it('a transient failure (network, timeout, overloaded) waits TRANSIENT_RETRY_AFTER_MS, then is due', () => {
    for (const error of ['network', 'timeout', 'overloaded']) {
      const s = stage({ kind: 'step_failed', data: { error, detail: 'x' } });
      expect(plan(s, gate(), after(TRANSIENT_RETRY_AFTER_MS - 1))).toEqual({ due: [], waiting: 1 });
      expect(plan(s, gate(), after(TRANSIENT_RETRY_AFTER_MS))).toEqual({ due: [error], waiting: 0 });
    }
  });

  it('a step skipped by an open breaker is due the same way', () => {
    const s = stage({ kind: 'step_skipped', data: { reason: 'breaker_open' } });
    expect(plan(s, gate(), after(1000))).toEqual({ due: [], waiting: 1 });
    expect(plan(s, gate(), after(TRANSIENT_RETRY_AFTER_MS))).toEqual({ due: ['breaker_open'], waiting: 0 });
  });

  it('a step deferred behind a robots-transient host waits for its hour; behind a 429 it is due once the 429 expired (#31); behind a run-long disable never', () => {
    const detail = (why: string) => `skipped by run state set by another candidate (homepage: host-disabled:${why} on www.acme.test)`;
    const g = gate();
    g.disable('www.acme.test', 'robots-transient', T0);
    const s = stage({ kind: 'step_failed', data: { error: 'input_rejected', detail: detail('robots-transient') } });
    expect(plan(s, g, after(TRANSIENT_DISABLE_MS - 1))).toEqual({ due: [], waiting: 1 });
    expect(plan(s, g, after(TRANSIENT_DISABLE_MS))).toEqual({ due: ['host re-enabled'], waiting: 0 });

    const g429 = gate();
    g429.disable('www.acme.test', 'http-429', T0);
    const s429 = stage({ kind: 'step_failed', data: { error: 'input_rejected', detail: detail('http-429') } });
    expect(plan(s429, g429, after(TRANSIENT_DISABLE_MS))).toEqual({ due: [], waiting: 0 });
    expect(plan(s429, g429, after(24 * 60 * 60_000))).toEqual({ due: ['host re-enabled'], waiting: 0 });

    const g403 = gate();
    g403.disable('www.acme.test', 'http-403', T0);
    expect(plan(stage({ kind: 'step_failed', data: { error: 'input_rejected', detail: detail('http-403') } }), g403, after(7 * 24 * 60 * 60_000))).toEqual({ due: [], waiting: 0 });
  });

  it(`a step re-queued ${MAX_REQUEUES} times is left as it is; any other failure is never re-queued`, () => {
    expect(plan(stage({ kind: 'step_failed', data: { error: 'network', detail: 'x' } }, MAX_REQUEUES), gate(), after(TRANSIENT_RETRY_AFTER_MS))).toEqual({ due: [], waiting: 0 });
    expect(plan(stage({ kind: 'step_failed', data: { error: 'network', detail: 'x' } }, MAX_REQUEUES - 1), gate(), after(TRANSIENT_RETRY_AFTER_MS))).toEqual({ due: ['network'], waiting: 0 });
    for (const error of ['invalid_output', 'gone', 'policy_denied', 'input_rejected']) {
      expect(plan(stage({ kind: 'step_failed', data: { error, detail: 'x' } }), gate(), after(7 * 24 * 60 * 60_000))).toEqual({ due: [], waiting: 0 });
    }
    expect(plan(stage({ kind: 'step_skipped', data: { reason: 'budget' } }), gate(), after(7 * 24 * 60 * 60_000))).toEqual({ due: [], waiting: 0 });
  });
});

describe('one re-queue budget per step per run (sleep-safe review I3)', () => {
  it(`the supervisor's wake re-queues count against MAX_REQUEUES (${MAX_REQUEUES} in all)`, () => {
    const s = Store.open(':memory:');
    s.startRun(RUN, 'jobpilot-coverage/locate@1.0.0', 'p', T0);
    s.enqueue(RUN, 0, AGENT, 'e1');
    s.appendEvent(RUN, T0, REQUEUED, { agent: AGENT, envelopeId: 'e1', why: 'network' }, 'p');
    for (let i = 0; i < MAX_REQUEUES - 1; i++) s.appendEvent(RUN, T0, 'wake_requeued', { agent: AGENT, envelopeId: 'e1', attempt: i + 1 }, 'p');
    s.markQueue(RUN, AGENT, 'e1', 'failed');
    s.appendEvent(RUN, T0, 'step_failed', { agent: AGENT, envelopeId: 'e1', error: 'network', detail: 'x' }, 'p');
    expect(plan(s, gate(), after(TRANSIENT_RETRY_AFTER_MS))).toEqual({ due: [], waiting: 0 });
    // one wake re-queue fewer: due again
    const t = Store.open(':memory:');
    t.startRun(RUN, 'jobpilot-coverage/locate@1.0.0', 'p', T0);
    t.enqueue(RUN, 0, AGENT, 'e1');
    t.appendEvent(RUN, T0, 'wake_requeued', { agent: AGENT, envelopeId: 'e1', attempt: 1 }, 'p');
    t.markQueue(RUN, AGENT, 'e1', 'failed');
    t.appendEvent(RUN, T0, 'step_failed', { agent: AGENT, envelopeId: 'e1', error: 'network', detail: 'x' }, 'p');
    expect(plan(t, gate(), after(TRANSIENT_RETRY_AFTER_MS))).toEqual({ due: ['network'], waiting: 0 });
  });
});
