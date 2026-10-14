import { describe, expect, it } from 'vitest';
import {
  DISABLE_EXPIRY_MS,
  makeRunGate,
  memoryHostStateStore,
  OFFLINE_AFTER_NETWORK_ERRORS,
  TRANSIENT_DISABLE_MS,
  stepFetcher,
  type RunGate,
} from '../../../src/app/coverage/gate.js';
import { careersLocatorContract, locatorEgressSets, makeCareersLocator } from '../../../src/app/coverage/locator.js';
import { CareersSite, type CompanyCandidate } from '../../../src/app/coverage/types.js';
import { networkKind } from '../../../src/app/net.js';
import { issueContext } from '../../../src/kernel/broker.js';
import type { Clock } from '../../../src/kernel/clock.js';
import { KernelError } from '../../../src/kernel/errors.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import type { FetchLike, FetchResponse } from '../../../src/kernel/providers.js';

const T0 = '2026-10-11T02:00:00.000Z';
const at = (h: number): string => new Date(Date.parse(T0) + h * 3_600_000).toISOString();
const cand = (key: string): CompanyCandidate => ({ companyKey: key, name: key, website: `https://www.${key}`, careersUrl: null, source: 'yc', runDate: '2026-10-11' });

const res = (status: number, body = ''): FetchResponse => ({ status, headers: { get: () => null }, text: async () => body });
/** A failed fetch the way undici fails one: a TypeError whose `cause` has the system code. */
const sysFail = (code: string): never => {
  throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
};

/** A fetch answered by `route` per URL (an Error thrown there is the transport failure); every URL asked is in `calls`. */
function net(route: (url: string) => FetchResponse | 'reset' | 'nxdomain' | 'cert' | 'refused') {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const r = route(url);
    if (r === 'reset') return sysFail('ECONNRESET');
    if (r === 'nxdomain') return sysFail('ENOTFOUND');
    if (r === 'cert') return sysFail('ERR_TLS_CERT_ALTNAME_INVALID');
    if (r === 'refused') return sysFail('ECONNREFUSED');
    return r;
  };
  return { fetch, calls };
}

const clockAt = (iso: () => string): Clock => ({ now: iso });
const ctxFor = (fetch: FetchLike, c: CompanyCandidate, clock: Clock, signal = new AbortController().signal) =>
  issueContext({ contract: careersLocatorContract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock, signal, egressSets: locatorEgressSets([c]) });

/** Runs the locator for `c` on `gate` at `now`: its site, or the KernelError it failed with. */
async function locate(gate: RunGate, fetch: FetchLike, c: CompanyCandidate, now: string): Promise<CareersSite | KernelError> {
  try {
    const [site] = await makeCareersLocator({ gate }).run(c, ctxFor(fetch, c, clockAt(() => now)));
    return CareersSite.schema.parse(site);
  } catch (e) {
    if (e instanceof KernelError) return e;
    throw e;
  }
}

describe('C1: the gate splits robots.txt outcomes into definitive and transient', () => {
  it('the limits are named constants: a transient disable lasts 1 h, a 429 24 h; 5 network errors in a row ask whether the machine is offline', () => {
    expect(TRANSIENT_DISABLE_MS).toBe(60 * 60_000);
    expect(DISABLE_EXPIRY_MS).toEqual({ 'http-429': 24 * 60 * 60_000, 'robots-transient': TRANSIENT_DISABLE_MS });
    expect(OFFLINE_AFTER_NETWORK_ERRORS).toBe(5);
  });

  it('classifies transport failures: no-such-host only by name, refused and bad certificates definitive, the rest transient', () => {
    expect(networkKind(new KernelError('network', 'x', 'ENOTFOUND'))).toBe('no-such-host');
    expect(networkKind(new KernelError('network', 'x', 'ECONNREFUSED'))).toBe('definitive');
    expect(networkKind(new KernelError('network', 'x', 'CERT_HAS_EXPIRED'))).toBe('definitive');
    expect(networkKind(new KernelError('network', 'x', 'ERR_TLS_CERT_ALTNAME_INVALID'))).toBe('definitive');
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_SOCKET']) expect(networkKind(new KernelError('network', 'x', code))).toBe('transient');
    expect(networkKind(new KernelError('network', 'x'))).toBe('transient');
    expect(networkKind(new KernelError('timeout', 'x'))).toBe('transient');
  });

  it('a robots.txt network error: the step FAILS (network), the host is disabled only for 1 h (persisted with its time), never cached', async () => {
    const store = memoryHostStateStore();
    const gate = makeRunGate({ runKey: 'r', store });
    let down = true;
    const n = net((u) => (u === 'https://www.acme.test/robots.txt' && down ? 'reset' : u === 'https://www.acme.test/' ? res(200, '<p>home</p>') : u === 'https://www.acme.test/careers' ? res(200, 'jobs') : res(404)));
    const r = await locate(gate, n.fetch, cand('acme.test'), at(0));
    expect(r).toBeInstanceOf(KernelError);
    expect((r as KernelError).code).toBe('network');
    expect([...store.coverageHostState('r')]).toContainEqual(['www.acme.test', 'robots-transient']);
    expect(store.coverageHostTimes('r').get('www.acme.test')).toBe(at(0));
    expect(gate.state.robots.has('www.acme.test')).toBe(false);
    // within the hour the host stays off; after it, robots.txt is asked again and the host is read
    down = false;
    expect(gate.disabledWhy('www.acme.test', at(0.99))).toBe('robots-transient');
    const later = await locate(gate, n.fetch, cand('acme.test'), at(1));
    expect(later).toMatchObject({ method: 'path', careersUrl: 'https://www.acme.test/careers' });
    expect(n.calls.filter((u) => u === 'https://www.acme.test/robots.txt')).toHaveLength(2);
    expect([...store.coverageHostState('r')]).toEqual([]);
  });

  it('a 5xx robots.txt that recovers an hour later: the host is read then (C1 test b)', async () => {
    const store = memoryHostStateStore();
    const gate = makeRunGate({ runKey: 'r', store });
    let status = 503;
    const n = net((u) => (u === 'https://www.acme.test/robots.txt' ? res(status, 'busy') : u === 'https://www.acme.test/' ? res(200, '<p>home</p>') : u === 'https://www.acme.test/careers' ? res(200, 'jobs') : res(404)));
    const r = await locate(gate, n.fetch, cand('acme.test'), at(0));
    expect(r).toMatchObject({ code: 'overloaded' });
    expect(gate.disabledWhy('www.acme.test', at(0.5))).toBe('robots-transient');
    status = 200;
    expect(await locate(gate, n.fetch, cand('acme.test'), at(1.01))).toMatchObject({ method: 'path' });
  });

  it('a step aborted while its robots.txt is in flight: the host is not disabled for the run (C1 test c)', async () => {
    const store = memoryHostStateStore();
    const gate = makeRunGate({ runKey: 'r', store });
    const step = new AbortController();
    const fetch: FetchLike = (url, init) =>
      url.endsWith('/robots.txt')
        ? new Promise((_r, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
            setTimeout(() => step.abort(new DOMException('step timed out', 'TimeoutError')), 5);
          })
        : Promise.resolve(res(404));
    const c = cand('acme.test');
    await expect(makeCareersLocator({ gate }).run(c, ctxFor(fetch, c, clockAt(() => at(0)), step.signal))).rejects.toBeInstanceOf(KernelError);
    expect(gate.disabledWhy('www.acme.test', at(0))).toBe('robots-transient');
    expect(gate.disabledWhy('www.acme.test', at(1))).toBeUndefined();
  });

  it('a name that does not exist (ENOTFOUND) while online is no-such-host for the run; while offline it is transient (C1 test d)', async () => {
    const online = makeRunGate({ runKey: 'r', store: memoryHostStateStore(), online: async () => true });
    const n = net((u) => (u.startsWith('https://www.acme.test/') ? 'nxdomain' : res(404)));
    const r = await locate(online, n.fetch, cand('acme.test'), at(0));
    expect(r).toMatchObject({ method: 'none' }); // a finished answer: the company's site does not exist
    expect(online.disabledWhy('www.acme.test', at(100))).toBe('no-such-host');
    const offline = makeRunGate({ runKey: 'r2', store: memoryHostStateStore(), online: async () => false });
    expect(await locate(offline, n.fetch, cand('acme.test'), at(0))).toMatchObject({ code: 'network' });
    expect(offline.disabledWhy('www.acme.test', at(0))).toBe('robots-transient');
    expect(offline.disabledWhy('www.acme.test', at(1))).toBeUndefined();
  });

  it('unchanged: 401/403 robots.txt is robots-forbidden, another 4xx robots-unavailable, a bad certificate robots-unavailable, all for the run', async () => {
    const gate = makeRunGate({ runKey: 'r', store: memoryHostStateStore() });
    const answers: Record<string, FetchResponse | 'cert' | 'refused'> = { 'a.test': res(403), 'b.test': res(400), 'c.test': 'cert', 'd.test': 'refused' };
    const n = net((u) => {
      const host = new URL(u).hostname.replace(/^www\./, '');
      return u.endsWith('/robots.txt') && answers[host] !== undefined ? (answers[host] as FetchResponse) : res(404);
    });
    for (const k of Object.keys(answers)) expect(await locate(gate, n.fetch, cand(k), at(0))).toMatchObject({ method: 'none' });
    expect(gate.disabledWhy('www.a.test', at(100))).toBe('robots-forbidden');
    expect(gate.disabledWhy('www.b.test', at(100))).toBe('robots-unavailable');
    expect(gate.disabledWhy('www.c.test', at(100))).toBe('robots-unavailable');
    expect(gate.disabledWhy('www.d.test', at(100))).toBe('robots-unavailable');
  });

  it('a page probe that fails transiently: a "none" resting on it FAILS; a site found anyway is still found', async () => {
    const gate = makeRunGate({ runKey: 'r', store: memoryHostStateStore() });
    const reset = net((u) => (u === 'https://www.acme.test/' ? 'reset' : res(404)));
    expect(await locate(gate, reset.fetch, cand('acme.test'), at(0))).toMatchObject({ code: 'network' });
    const five = net((u) => (u === 'https://www.beta.test/' ? res(502) : res(404)));
    expect(await locate(gate, five.fetch, cand('beta.test'), at(0))).toMatchObject({ code: 'overloaded' });
    const found = net((u) => (u === 'https://www.gamma.test/' ? 'reset' : u === 'https://www.gamma.test/careers' ? res(200, 'jobs') : res(404)));
    expect(await locate(gate, found.fetch, cand('gamma.test'), at(0))).toMatchObject({ method: 'path' });
  });
});

describe('C1: a run of network errors asks whether the machine is offline', () => {
  const probe = (gate: RunGate, fetch: FetchLike, hosts: string[]) => {
    const c = cand('acme.test');
    const ctx = issueContext({ contract: careersLocatorContract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock: clockAt(() => at(0)), signal: new AbortController().signal, egressSets: { 'coverage:candidate-hosts': hosts } });
    void c;
    return stepFetcher({ ctx, gate, planned: new Set(hosts), acceptMoved: () => false, maxRequests: 100 });
  };
  const hosts = ['h1.test', 'h2.test', 'h3.test', 'h4.test', 'h5.test', 'h6.test'];

  it(`${OFFLINE_AFTER_NETWORK_ERRORS} network errors in a row and the offline check says offline: the gate reports offline`, async () => {
    let asked = 0;
    const gate = makeRunGate({ runKey: 'r', store: memoryHostStateStore(), online: async () => (asked++, false) });
    const f = probe(gate, net(() => 'reset').fetch, hosts);
    for (const h of hosts.slice(0, OFFLINE_AFTER_NETWORK_ERRORS - 1)) await f.fetchUrl(`https://${h}/robots.txt`, false);
    expect(gate.offline()).toBe(false);
    expect(asked).toBe(0);
    await f.fetchUrl(`https://${hosts[4]}/robots.txt`, false);
    expect(asked).toBe(1);
    expect(gate.offline()).toBe(true);
  });

  it('online after all (a run of dead hosts): not offline; any answer resets the count', async () => {
    const online = makeRunGate({ runKey: 'r', store: memoryHostStateStore(), online: async () => true });
    const f = probe(online, net(() => 'reset').fetch, hosts);
    for (const h of hosts) await f.fetchUrl(`https://${h}/robots.txt`, false);
    expect(online.offline()).toBe(false);
    let asked = 0;
    const gate = makeRunGate({ runKey: 'r2', store: memoryHostStateStore(), online: async () => (asked++, false) });
    const g = probe(gate, net((u) => (u.startsWith('https://h3.test/') ? res(404) : 'reset')).fetch, hosts);
    for (const h of hosts) await g.fetchUrl(`https://${h}/robots.txt`, false);
    expect(asked).toBe(0); // 2 errors, an answer, 3 errors: never 5 in a row
    expect(gate.offline()).toBe(false);
  });
});
