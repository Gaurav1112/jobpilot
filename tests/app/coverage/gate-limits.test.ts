import { describe, expect, it } from 'vitest';
import { CANDIDATE_DEADLINE_MS, memoryHostStateStore, makeRunGate, REQUEST_TIMEOUT_MS } from '../../../src/app/coverage/gate.js';
import { careersLocatorContract, locatorEgressSets, makeCareersLocator } from '../../../src/app/coverage/locator.js';
import { CareersSite, type CompanyCandidate } from '../../../src/app/coverage/types.js';
import { issueContext } from '../../../src/kernel/broker.js';
import type { Clock } from '../../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import type { FetchLike } from '../../../src/kernel/providers.js';

const cand = (key: string): CompanyCandidate => ({ companyKey: key, name: key, website: `https://www.${key}`, careersUrl: null, source: 'yc', runDate: '2026-10-11' });

/** A fetch that never answers `slow` URLs (it rejects only when aborted) and serves 404 for the rest. */
function net(slow: (url: string) => boolean) {
  const calls: string[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push(url);
    if (!slow(url)) return Promise.resolve({ status: 404, headers: { get: () => null }, text: async () => 'Not Found' });
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted'))));
  };
  return { fetch, calls };
}

const ctxFor = (fetch: FetchLike, c: CompanyCandidate, clock: Clock) =>
  issueContext({ contract: careersLocatorContract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock, signal: new AbortController().signal, egressSets: locatorEgressSets([c]) });

describe('the gate\'s request timeout and candidate deadline', () => {
  it('the limits are named constants: 15 s a request, 90 s a candidate (under the 120 s step timeout)', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(CANDIDATE_DEADLINE_MS).toBe(90_000);
    expect(CANDIDATE_DEADLINE_MS + REQUEST_TIMEOUT_MS).toBeLessThan(careersLocatorContract.timeoutMs);
  });

  it('a request past the timeout is a miss with the reason "timeout"; the host is NOT disabled and the next probe goes on', async () => {
    const store = memoryHostStateStore();
    const gate = makeRunGate({ runKey: 'r', store });
    const c = cand('acme.test');
    // the homepage hangs; robots.txt and every other probe answer 404
    const n = net((u) => u === 'https://www.acme.test/');
    const t0 = Date.now();
    const [site] = await makeCareersLocator({ gate, requestTimeoutMs: 20 }).run(c, ctxFor(n.fetch, c, { now: () => new Date().toISOString() }));
    expect(Date.now() - t0).toBeLessThan(5000);
    const s = CareersSite.schema.parse(site);
    expect(s.method).toBe('none');
    expect(s.reasons?.join('\n')).toMatch(/homepage: timeout: request to www\.acme\.test timed out/);
    expect(n.calls).toContain('https://www.acme.test/careers');
    expect([...store.coverageHostState('r')]).toEqual([]);
    expect(gate.state.disabled.size).toBe(0);
  });

  it('a robots.txt that times out is not cached and not a disable: this step skips the host, a later step asks again', async () => {
    const store = memoryHostStateStore();
    const gate = makeRunGate({ runKey: 'r', store });
    const c = cand('acme.test');
    const n = net((u) => u === 'https://www.acme.test/robots.txt');
    const [site] = await makeCareersLocator({ gate, requestTimeoutMs: 20 }).run(c, ctxFor(n.fetch, c, { now: () => new Date().toISOString() }));
    expect(CareersSite.schema.parse(site).reasons?.join('\n')).toMatch(/robots-unavailable \(www\.acme\.test\)/);
    expect(gate.state.disabled.has('www.acme.test')).toBe(false);
    expect([...store.coverageHostState('r')]).toEqual([]);
    const before = n.calls.filter((u) => u === 'https://www.acme.test/robots.txt').length;
    await makeCareersLocator({ gate, requestTimeoutMs: 20 }).run(c, ctxFor(n.fetch, c, { now: () => new Date().toISOString() }));
    expect(n.calls.filter((u) => u === 'https://www.acme.test/robots.txt').length).toBeGreaterThan(before);
  });

  it('a candidate past its wall-clock deadline (injected clock) ends "none" with budget-exhausted:time, no further request', async () => {
    const c = cand('acme.test');
    let t = Date.parse('2026-10-11T01:30:00.000Z');
    // every request takes 40 s of the injected clock; robots.txt is absent, every page a 500 (so the probes go on)
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      t += 40_000;
      return url.endsWith('/robots.txt') ? { status: 404, headers: { get: () => null }, text: async () => 'Not Found' } : { status: 500, headers: { get: () => null }, text: async () => 'oops' };
    };
    const clock: Clock = { now: () => new Date(t).toISOString() };
    const [site] = await makeCareersLocator({ runKey: 'r', store: memoryHostStateStore() }).run(c, ctxFor(fetch, c, clock));
    const s = CareersSite.schema.parse(site);
    expect(s).toMatchObject({ method: 'none', careersUrl: null });
    expect(s.reasons).toContain('budget-exhausted:time');
    // robots.txt at 0 s, the homepage at 40 s, /careers at 80 s; /jobs would start at 120 s and never does
    expect(calls).toHaveLength(3);
  });

  it('the request-count budget keeps its own reason', async () => {
    const c = cand('acme.test');
    const fetch: FetchLike = async (url) => (url.endsWith('/robots.txt') ? { status: 404, text: async () => '' } : { status: 500, text: async () => 'oops' });
    const [site] = await makeCareersLocator({ runKey: 'r', store: memoryHostStateStore(), maxRequests: 2 }).run(c, ctxFor(fetch, c, { now: () => '2026-10-11T01:30:00.000Z' }));
    expect(CareersSite.schema.parse(site).reasons).toContain('budget-exhausted');
  });
});

describe('a 429 disable expires after 24 h within the run; every other disable lasts the run', () => {
  it('the gate re-enables a 429 host after HTTP_429_EXPIRY_MS (persisted time), never a 403, robots or challenge one', async () => {
    const { HTTP_429_EXPIRY_MS } = await import('../../../src/app/coverage/gate.js');
    expect(HTTP_429_EXPIRY_MS).toBe(24 * 60 * 60_000);
    const store = memoryHostStateStore();
    const gate = makeRunGate({ runKey: 'r', store });
    const T = '2026-10-11T02:00:00.000Z';
    const later = (h: number) => new Date(Date.parse(T) + h * 3_600_000).toISOString();
    gate.disable('api.lever.co', 'http-429', T);
    gate.disable('www.acme.test', 'http-403', T);
    gate.disable('www.beta.test', 'challenge', T);
    gate.disable('www.gamma.test', 'robots-forbidden', T);
    expect(gate.disabledWhy('api.lever.co', later(23.9))).toBe('http-429');
    // a resumed run (a new gate on the same key) knows when it was disabled
    const resumed = makeRunGate({ runKey: 'r', store });
    expect(resumed.disabledWhy('api.lever.co', later(23.9))).toBe('http-429');
    expect(resumed.disabledWhy('api.lever.co', later(24))).toBeUndefined();
    expect([...store.coverageHostState('r')].map(([h]) => h)).not.toContain('api.lever.co');
    for (const h of ['www.acme.test', 'www.beta.test', 'www.gamma.test']) expect(resumed.disabledWhy(h, later(100))).toBeDefined();
    // once re-enabled, a new 429 disables it again from its new time
    resumed.disable('api.lever.co', 'http-429', later(30));
    expect(resumed.disabledWhy('api.lever.co', later(31))).toBe('http-429');
  });
});

describe('the AppStore keeps the disable times (migration 10 coverage_host_state.at)', () => {
  it('a 429 expiry lifts the row; a re-disable gets the new time', async () => {
    const { AppStore } = await import('../../../src/app/store/app-store.js');
    const { Store } = await import('../../../src/kernel/store/store.js');
    const app = AppStore.on(Store.open(':memory:'));
    const gate = makeRunGate({ runKey: 'coverage-2026-10-11', store: app });
    gate.disable('api.lever.co', 'http-429', '2026-10-11T02:00:00.000Z');
    expect([...app.coverageHostTimes('coverage-2026-10-11')]).toEqual([['api.lever.co', '2026-10-11T02:00:00.000Z']]);
    expect(makeRunGate({ runKey: 'coverage-2026-10-11', store: app }).disabledWhy('api.lever.co', '2026-10-12T01:59:00.000Z')).toBe('http-429');
    expect(gate.disabledWhy('api.lever.co', '2026-10-12T02:00:00.000Z')).toBeUndefined();
    expect([...app.coverageHostState('coverage-2026-10-11')]).toEqual([]);
    gate.disable('api.lever.co', 'http-429', '2026-10-12T03:00:00.000Z');
    expect([...app.coverageHostTimes('coverage-2026-10-11')]).toEqual([['api.lever.co', '2026-10-12T03:00:00.000Z']]);
  });
});
