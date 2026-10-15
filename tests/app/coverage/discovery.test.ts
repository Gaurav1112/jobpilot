import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_ALLOW_LIST, capabilityProblems } from '../../../src/app/allow-list.js';
import { DISCOVERY_MAX_QUERIES, discoveryQueries, makeSrcFreehireDiscovery, srcFreehireDiscoveryContract } from '../../../src/app/coverage/discovery.js';
import { makeRunGate, memoryHostStateStore } from '../../../src/app/coverage/gate.js';
import type { FreehireFinding, FreehireQuery } from '../../../src/app/coverage/types.js';
import { issueContext, type HostPacer } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import type { FetchLike } from '../../../src/kernel/providers.js';

const root = join(import.meta.dirname, '../../..');
const FIX = join(root, 'tests/fixtures/sx/freehire');
const WEEK = '2026-10-18';
const page = (id: string): string => readFileSync(join(FIX, 'discovery', `${id}.json`), 'utf8');
const queryId = (url: string): string => {
  const q = new URL(url).searchParams.get('q') ?? '';
  const found = discoveryQueries(WEEK, ['Pune', 'Hyderabad']).find((x) => x.url === url);
  if (found === undefined) throw new Error(`unexpected request: ${q}`);
  return found.queryId;
};

function ctxFor(fetch: FetchLike, waits: number[] = []) {
  const hostPacer: HostPacer = { wait: async (_h, ms) => void waits.push(ms ?? 0) };
  return issueContext({ contract: srcFreehireDiscoveryContract(), policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock: fixedClock('2026-10-18T02:00:00Z'), signal: new AbortController().signal, hostPacer });
}

/** Serves the recorded pages by query id; `override` answers a query differently. Every URL asked is in `calls`. */
function freehire(override: Record<string, { status: number; body: string }> = {}): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign(
    async (url: string) => {
      calls.push(url);
      const id = queryId(url);
      const o = override[id];
      if (o !== undefined) return { status: o.status, text: async () => o.body };
      return { status: 200, text: async () => page(id) };
    },
    { calls },
  );
}

const q = (id: string): FreehireQuery => discoveryQueries(WEEK, ['Pune', 'Hyderabad']).find((x) => x.queryId === id) as FreehireQuery;
const boards = (f: readonly FreehireFinding[]) => f.flatMap((x) => (x.kind === 'board' ? [x] : []));
const leads = (f: readonly FreehireFinding[]) => f.flatMap((x) => (x.kind === 'lead' ? [x] : []));

describe('discoveryQueries', () => {
  const PARAMS = new Set(['q', 'q_fields', 'open_within_days', 'sort', 'order', 'limit', 'source_exclude']);

  it('one office city: 8 queries (q1 for pune, no q2), each URL exactly as built, no enrichment parameter', () => {
    const qs = discoveryQueries(WEEK, ['Pune']);
    expect(qs.map((x) => x.queryId)).toEqual(['q1', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9']);
    expect(qs[0]?.url).toBe(
      'https://freehire.me/api/v1/jobs/search?q=%22senior%20backend%20pune%22&q_fields=title,location&open_within_days=7&sort=created_at&order=desc&limit=100&source_exclude=powertofly,adzuna',
    );
    expect(qs[1]?.url).toBe(
      'https://freehire.me/api/v1/jobs/search?q=%22senior%20backend%20india%22&q_fields=title,location&open_within_days=7&sort=created_at&order=desc&limit=100&source_exclude=powertofly,adzuna',
    );
    for (const x of qs) {
      expect(x.week).toBe(WEEK);
      expect([...new URL(x.url).searchParams.keys()].every((k) => PARAMS.has(k))).toBe(true);
      expect(new URL(x.url).searchParams.get('q_fields')).toBe('title,location');
    }
  });

  it('three office cities: two city queries, 9 in all, never more than the maximum; none: 7', () => {
    const qs = discoveryQueries(WEEK, ['Pune', 'Hyderabad', 'Chennai']);
    expect(qs.map((x) => x.queryId)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9']);
    expect(qs.length).toBeLessThanOrEqual(DISCOVERY_MAX_QUERIES);
    expect(decodeURIComponent(qs[1]?.url ?? '')).toContain('"senior backend hyderabad"');
    expect(discoveryQueries(WEEK, [])).toHaveLength(7);
    // a city named twice (alias spellings) is one query
    expect(discoveryQueries(WEEK, ['Pune', 'pune'])).toHaveLength(8);
  });
});

describe('src-freehire-discovery: the contract', () => {
  it('io, its own team, freehire.me only, no LLM, never retries', () => {
    const c = srcFreehireDiscoveryContract();
    expect(c).toMatchObject({ id: 'src-freehire-discovery', version: '1.0.0', kind: 'io', team: 'coverage-freehire', egress: ['freehire.me'], capabilities: { http: true }, timeoutMs: 60_000 });
    expect(c.skills).toEqual(['board-discovery']);
    expect(c.capabilities.llm).toBeFalsy();
    expect(c.retry).toEqual({ max: 0, on: [], backoffMs: [] });
  });

  it('the allow-list lets only this agent contact freehire.me', () => {
    expect(CAPABILITY_ALLOW_LIST.freehireEgress).toEqual(['src-freehire-discovery']);
    expect(capabilityProblems([srcFreehireDiscoveryContract()])).toEqual([]);
    const other = { ...srcFreehireDiscoveryContract(), id: 'src-other' };
    expect(capabilityProblems([other])).toEqual([expect.stringContaining('src-other declares egress freehire.me')]);
  });
});

describe('src-freehire-discovery: a recorded page', () => {
  it('a board for a real name, leads, the unreadable dropped, utm stripped, and the counts in one note', async () => {
    const agent = makeSrcFreehireDiscovery();
    const ctx = ctxFor(freehire());
    const f = await agent.run(q('q3'), ctx);
    // the real, named boards
    expect(boards(f).map((b) => [b.platform, b.ref, b.company, b.evidence])).toEqual([
      ['greenhouse', 'twilio', 'Twilio', 'india'],
      ['icims', 'careers-atlassian.icims.com', 'Atlassian', 'india'],
      ['manatal', 'pradeepit', 'PradeepIT Consulting Services Pvt Ltd', 'india'],
    ]);
    const twilio = boards(f)[0];
    expect(twilio?.boardUrl).toBe('https://boards-api.greenhouse.io/v1/boards/twilio/jobs?content=true&pay_transparency=true');
    expect(twilio?.example).toEqual({ title: 'Staff Software Engineer (L4)', location: 'Remote - India', url: 'https://job-boards.greenhouse.io/twilio/jobs/8236865' });
    // the leads: a platform jobpilot cannot read (remotedotcom, ukg), in key order, tracking stripped
    expect(leads(f).map((l) => [l.leadKey, l.source, l.company, l.postedAt, l.evidence])).toEqual([
      ['remotedotcom::staff-engineer-backend-j1wocvrk', 'remotedotcom', 'HighLevel', '2026-09-21', 'india'],
      ['ukg:recruiting.ultipro.com/epr1000epsus/10653576-f6a1-4d69-8a9c-a0a96124abda:454729d3-5bb8-4003-bd0e-66ef47724f24', 'ukg', 'CAI Software', '2026-10-07', 'india'],
    ]);
    for (const x of f) expect(JSON.stringify(x)).not.toContain('utm_');
    // dropped: Argentina (sezzle), no location (zoho), Singapore (whatjobs-sg), New York (adzuna) = 4 not India/worldwide;
    // unnamed: jobgether, the Oracle tenant, the Workday tenant, tilthq = 4; denied: whatjobs-in = 1; the closed row is skipped
    expect(ctx.skips()).toEqual([
      'freehire q3: 15 rows, 3 boards, 2 leads, 9 dropped (4 not India/worldwide tech, 4 unnamed, 1 denied)',
      'freehire q3: 52 more matches not read (one page per query)',
    ]);
    // the output is sorted: boards (platform, ref), then leads (key)
    expect(f.map((x) => x.kind)).toEqual(['board', 'board', 'board', 'lead', 'lead']);
  });

  it('every fixture query page parses without an outage', async () => {
    const agent = makeSrcFreehireDiscovery();
    const f = freehire();
    for (const x of discoveryQueries(WEEK, ['Pune', 'Hyderabad'])) {
      const ctx = ctxFor(f);
      await agent.run(x, ctx);
      expect(ctx.skips().every((s) => !s.includes('freehire-outage'))).toBe(true);
      expect(ctx.skips()[0]).toMatch(new RegExp(`^freehire ${x.queryId}: \\d+ rows`));
    }
  });

  it('reads only the documented fields: no enrichment field is in any finding', async () => {
    const f = await makeSrcFreehireDiscovery().run(q('q3'), ctxFor(freehire()));
    const text = JSON.stringify(f);
    for (const k of ['enrichment', 'countries', 'regions', 'work_mode', 'skills', 'reality', 'category']) expect(text).not.toContain(`"${k}"`);
  });

  it('requests are at least 2000 ms apart (the pacer is asked for the interval on every request)', async () => {
    const agent = makeSrcFreehireDiscovery();
    const waits: number[] = [];
    const f = freehire();
    await agent.run(q('q3'), ctxFor(f, waits));
    await agent.run(q('q4'), ctxFor(f, waits));
    expect(waits).toHaveLength(2);
    expect(waits.every((w) => w >= 2000)).toBe(true);
  });

  it('a request that is not a freehire API URL is rejected, nothing sent', async () => {
    const f = freehire();
    await expect(makeSrcFreehireDiscovery().run({ week: WEEK, queryId: 'q3', url: 'https://elsewhere.example/api/v1/jobs/search?q=x' }, ctxFor(f))).rejects.toMatchObject({ code: 'input_rejected' });
    expect(f.calls).toEqual([]);
  });
});

describe('src-freehire-discovery: it fails closed', () => {
  it('ignored_params: no findings and one named outage note', async () => {
    const ctx = ctxFor(freehire({ q3: { status: 200, body: readFileSync(join(FIX, 'search-ignored.json'), 'utf8') } }));
    const f = await makeSrcFreehireDiscovery().run(q('q3'), ctx);
    expect(f).toEqual([]);
    expect(ctx.skips()).toHaveLength(1);
    expect(ctx.skips()[0]).toMatch(/^freehire-outage q3: freehire ignored parameters: \S+/);
  });

  it('a body that is not the envelope, and rows that all fail the shape: an outage each', async () => {
    const a = ctxFor(freehire({ q3: { status: 200, body: '<html>maintenance</html>' } }));
    expect(await makeSrcFreehireDiscovery().run(q('q3'), a)).toEqual([]);
    expect(a.skips()).toEqual(['freehire-outage q3: freehire answered something that is not JSON']);
    const b = ctxFor(freehire({ q3: { status: 200, body: readFileSync(join(FIX, 'search-shape.json'), 'utf8') } }));
    expect(await makeSrcFreehireDiscovery().run(q('q3'), b)).toEqual([]);
    expect(b.skips()[0]).toMatch(/^freehire-outage q3: /);
  });

  it('a 503 is an outage for that query only: no findings, the step is done, the next query is still asked', async () => {
    const agent = makeSrcFreehireDiscovery();
    const f = freehire({ q3: { status: 503, body: 'down' } });
    const a = ctxFor(f);
    expect(await agent.run(q('q3'), a)).toEqual([]);
    expect(a.skips()).toEqual(['freehire-outage q3: freehire answered 503']);
    const b = ctxFor(f);
    expect((await agent.run(q('q4'), b)).length).toBeGreaterThan(0);
    expect(f.calls).toHaveLength(2);
  });

  it('a transport failure is an outage note, not a failed step', async () => {
    const { KernelError } = await import('../../../src/kernel/errors.js');
    const boom: FetchLike = async () => {
      throw new KernelError('timeout', 'timed out');
    };
    const ctx = ctxFor(boom);
    expect(await makeSrcFreehireDiscovery().run(q('q3'), ctx)).toEqual([]);
    expect(ctx.skips()[0]).toMatch(/^freehire-outage q3: /);
  });

  it('a 429 disables freehire.me for the run: the remaining queries make no request', async () => {
    const agent = makeSrcFreehireDiscovery();
    const f = freehire({ q3: { status: 429, body: 'slow down' } });
    const a = ctxFor(f);
    expect(await agent.run(q('q3'), a)).toEqual([]);
    expect(a.skips()[0]).toMatch(/^freehire-outage q3: freehire answered 429; host-disabled:http-429 on freehire\.me/);
    for (const id of ['q4', 'q5']) {
      const c = ctxFor(f);
      expect(await agent.run(q(id), c)).toEqual([]);
      expect(c.skips()).toEqual([`freehire-outage ${id}: host-disabled:http-429 on freehire.me`]);
    }
    expect(f.calls).toHaveLength(1);
  });

  it('401 and 403 disable the host too', async () => {
    for (const status of [401, 403]) {
      const agent = makeSrcFreehireDiscovery();
      const f = freehire({ q3: { status, body: 'no' } });
      await agent.run(q('q3'), ctxFor(f));
      const c = ctxFor(f);
      await agent.run(q('q4'), c);
      expect(c.skips()).toEqual([`freehire-outage q4: host-disabled:http-${status} on freehire.me`]);
      expect(f.calls).toHaveLength(1);
    }
  });

  it('a Cloudflare challenge page disables the host like a 429', async () => {
    const agent = makeSrcFreehireDiscovery();
    const f = freehire({ q3: { status: 503, body: '<title>Just a moment...</title><div id="cf-chl-widget"></div>' } });
    const a = ctxFor(f);
    expect(await agent.run(q('q3'), a)).toEqual([]);
    expect(a.skips()[0]).toContain('host-disabled:challenge');
    const b = ctxFor(f);
    await agent.run(q('q4'), b);
    expect(b.skips()).toEqual(['freehire-outage q4: host-disabled:challenge on freehire.me']);
    expect(f.calls).toHaveLength(1);
  });

  it('a resume (a fresh agent on the same run gate) keeps the host disabled: q4 makes no request', async () => {
    const store = memoryHostStateStore();
    const f = freehire({ q3: { status: 429, body: 'x' } });
    await makeSrcFreehireDiscovery({ gate: makeRunGate({ runKey: 'coverage-2026-10-18', store }) }).run(q('q3'), ctxFor(f));
    expect(store.coverageHostState('coverage-2026-10-18').get('freehire.me')).toBe('http-429');
    // the run paused; the next invocation builds a new gate from the store and a new agent
    const c = ctxFor(f);
    expect(await makeSrcFreehireDiscovery({ gate: makeRunGate({ runKey: 'coverage-2026-10-18', store }) }).run(q('q4'), c)).toEqual([]);
    expect(c.skips()).toEqual(['freehire-outage q4: host-disabled:http-429 on freehire.me']);
    expect(f.calls).toHaveLength(1);
    // another run id (the next week's run) starts with the host enabled
    const d = ctxFor(freehire());
    expect((await makeSrcFreehireDiscovery({ gate: makeRunGate({ runKey: 'coverage-2026-10-25', store }) }).run(q('q4'), d)).length).toBeGreaterThan(0);
  });

  it('a fresh agent without a gate (the next run) starts with the host enabled', async () => {
    const f = freehire({ q3: { status: 429, body: 'x' } });
    await makeSrcFreehireDiscovery().run(q('q3'), ctxFor(f));
    const c = ctxFor(freehire());
    expect((await makeSrcFreehireDiscovery().run(q('q4'), c)).length).toBeGreaterThan(0);
  });
});
