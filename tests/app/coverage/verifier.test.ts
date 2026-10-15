import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ashbyUrl } from '../../../src/app/agents/sources/ashby.js';
import { greenhouseUrl } from '../../../src/app/agents/sources/greenhouse.js';
import { leverUrl } from '../../../src/app/agents/sources/lever.js';
import { BUILT_PLATFORMS, platformClient } from '../../../src/app/agents/sources/platforms/client.js';
import { memoryHostStateStore, makeRunGate } from '../../../src/app/coverage/gate.js';
import { boardVerifierContract, domainLabel, makeBoardVerifier, verifierEgressSets, verifierHosts } from '../../../src/app/coverage/verifier.js';
import { CompanyVerdict, Platform, type CareersSite, type CompanyCandidate, type PlatformGuess } from '../../../src/app/coverage/types.js';
import { issueContext } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import type { FetchLike } from '../../../src/kernel/providers.js';

const RUN = '2026-10-11';
const cand = (companyKey: string, name: string, over: Partial<CompanyCandidate> = {}): CompanyCandidate => ({
  companyKey,
  name,
  website: `https://www.${companyKey}`,
  careersUrl: null,
  source: 'yc',
  runDate: RUN,
  ...over,
});
const site = (c: CompanyCandidate, careersUrl = `https://www.${c.companyKey}/careers`, over: Partial<CareersSite> = {}): CareersSite => ({
  candidate: c,
  careersUrl,
  method: 'path',
  evidence: 'GET /careers 200',
  ...over,
});
const guess = (c: CompanyCandidate, platform: Platform | null, slug: string | null, over: Partial<PlatformGuess> = {}): PlatformGuess => ({
  site: site(c),
  platform,
  slug,
  boardUrl: null,
  signature: platform === null ? null : `${platform}:a`,
  routedFrom: null,
  evidence: [platform === null ? 'no-signature' : `detected: ${platform} ${slug}`],
  ...over,
});

interface Route {
  readonly status?: number;
  readonly body?: unknown;
  readonly location?: string;
}
function serve(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const r = routes[url] ?? { status: 404, body: 'Not Found' };
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null);
    return { status: r.status ?? 200, headers: { get: (n: string) => (n.toLowerCase() === 'location' ? (r.location ?? null) : null) }, text: async () => body };
  };
  return { fetch, calls };
}

const gh = (name: string | null, n = 2) => ({ jobs: Array.from({ length: n }, (_, i) => ({ id: 100 + i, title: `Engineer ${i}`, ...(name === null ? {} : { company_name: name }) })), meta: { total: n } });
const lever = (n = 2) => Array.from({ length: n }, (_, i) => ({ id: `lv-${i}`, text: `Engineer ${i}` }));
const ashby = (n = 2) => ({ apiVersion: '1', jobs: Array.from({ length: n }, (_, i) => ({ id: `ab-${i}`, title: `Engineer ${i}` })) });

function ctxFor(fetch: FetchLike, guesses: readonly PlatformGuess[]) {
  return issueContext({
    contract: boardVerifierContract,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: { fetch },
    clock: fixedClock('2026-10-11T01:30:00.000Z'),
    signal: new AbortController().signal,
    egressSets: verifierEgressSets(guesses),
  });
}

const fresh = () => ({ runKey: 'test', store: memoryHostStateStore() });

async function verify(g: PlatformGuess, fetch: FetchLike, agent = makeBoardVerifier(fresh()), egressFor: readonly PlatformGuess[] = [g]): Promise<CompanyVerdict> {
  const ctx = ctxFor(fetch, egressFor);
  const out = await agent.run(g, ctx);
  expect(out).toHaveLength(1);
  expect(ctx.denials()).toEqual([]);
  return CompanyVerdict.schema.parse(out[0]);
}

describe('platformClient', () => {
  it('reads Greenhouse, Lever, Ashby, Workday, Eightfold and Oracle with the daily adapters\' own URLs; every other platform is not built', () => {
    // Task 8 added the page platforms (their clients are tested in sources-pagesites.test.ts)
    // Task 9 added the nine small platforms (their clients are tested in sources-small.test.ts)
    expect(BUILT_PLATFORMS).toEqual(['ashby', 'bamboohr', 'breezy', 'eightfold', 'gem', 'greenhouse', 'icims', 'jsonld-sitemap', 'lever', 'oracle', 'personio', 'pinpoint', 'recruitee', 'rippling', 'smartrecruiters', 'successfactors', 'teamtailor', 'workable', 'workday']);
    // Task 7: Eightfold and Oracle read each tenant's own host; robots.txt governs both, Oracle's 403 is "unknown"
    const ef = platformClient('eightfold');
    expect(ef?.refOf('explore.jobs.netflix.net/netflix.com', 'https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com')).toBe('explore.jobs.netflix.net/netflix.com');
    expect(ef?.hostOf('explore.jobs.netflix.net/netflix.com')).toBe('explore.jobs.netflix.net');
    expect(ef?.boardUrl('explore.jobs.netflix.net/netflix.com')).toBe('https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com&start=0&num=10');
    expect([ef?.host, ef?.robots, ef?.robotsUnreadable]).toEqual([null, true, undefined]);
    const oc = platformClient('oracle');
    expect(oc?.refOf('jpmc.fa.oraclecloud.com/CX_1001', JPM_BOARD)).toBe('jpmc.fa.oraclecloud.com/CX_1001');
    expect([oc?.host, oc?.robots, oc?.robotsUnreadable]).toEqual([null, true, 'allow']);
    expect(platformClient('greenhouse')?.boardUrl('acme')).toBe(greenhouseUrl('acme'));
    expect(platformClient('lever')?.boardUrl('acme')).toBe(leverUrl('acme', 0));
    expect(platformClient('ashby')?.boardUrl('Acme Co')).toBe(ashbyUrl('Acme Co'));
    expect(platformClient('greenhouse')?.host).toBe('boards-api.greenhouse.io');
    expect(platformClient('lever')?.host).toBe('api.lever.co');
    expect(platformClient('ashby')?.host).toBe('api.ashbyhq.com');
    // Workday: one host per tenant, read from the detected board URL; robots.txt governs it
    const wd = platformClient('workday');
    expect(wd?.host).toBeNull();
    expect(wd?.robots).toBe(true);
    expect(wd?.refOf('nvidia/NVIDIAExternalCareerSite', NV_BOARD)).toBe('nvidia.wd5.myworkdayjobs.com/nvidia/NVIDIAExternalCareerSite');
    expect(wd?.refOf('nvidia/NVIDIAExternalCareerSite', null)).toBeNull();
    expect(wd?.boardUrl('nvidia.wd5.myworkdayjobs.com/nvidia/NVIDIAExternalCareerSite')).toBe(NV_BOARD);
    expect(platformClient('greenhouse')?.robots).toBe(false);
    for (const p of Platform.options.filter((p) => !BUILT_PLATFORMS.includes(p))) expect(platformClient(p)).toBeNull();
  });

  it('reads the recorded GitLab board: its company name and every job, through the daily parser', async () => {
    const json = JSON.parse(readFileSync(new URL('../../fixtures/sources/greenhouse-gitlab.json', import.meta.url), 'utf8')) as { jobs: unknown[] };
    const n = serve({ [greenhouseUrl('gitlab')]: { body: json } });
    const ctx = ctxFor(n.fetch, [guess(cand('gitlab.com', 'GitLab'), 'greenhouse', 'gitlab')]);
    const r = await platformClient('greenhouse')!.readBoard('gitlab', ctx.http!);
    expect(r).toMatchObject({ boardName: 'GitLab', boardNames: ['GitLab'], complete: true, url: greenhouseUrl('gitlab') });
    expect(r.jobs).toHaveLength(json.jobs.length);
    expect(r.jobs[0]).toMatchObject({ source: 'greenhouse', slug: 'gitlab' });
  });
});

const JPM_BOARD = 'https://jpmc.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=CX_1001';
const NV_HOST = 'nvidia.wd5.myworkdayjobs.com';
const NV_BOARD = `https://${NV_HOST}/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs`;
const nvFixture = (): { robots: string; pages: unknown[] } => JSON.parse(readFileSync(new URL('../../fixtures/sources/workday-nvidia.json', import.meta.url), 'utf8')) as { robots: string; pages: unknown[] };
const nvGuess = (name = 'NVIDIA', key = 'nvidia.com') => guess(cand(key, name), 'workday', 'nvidia/NVIDIAExternalCareerSite', { boardUrl: NV_BOARD });

/** The verifier's Workday read: method and body recorded per request. */
function serveWorkday(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(`${init.method ?? 'GET'} ${url}${init.body === undefined ? '' : ` ${init.body}`}`);
    const r = routes[url] ?? { status: 404, body: 'Not Found' };
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null);
    return { status: r.status ?? 200, text: async () => body };
  };
  return { fetch, calls };
}

describe('board-verifier: Workday (robots.txt applies; the tenant is the board name)', () => {
  it('verifies the recorded NVIDIA board: robots.txt first, then page 1 of the CXS list by POST; the tenant matches the domain label', async () => {
    const fx = nvFixture();
    const n = serveWorkday({ [`https://${NV_HOST}/robots.txt`]: { body: fx.robots }, [NV_BOARD]: { body: fx.pages[0] } });
    expect(verifierHosts(nvGuess())).toEqual([NV_HOST]);
    const v = await verify(nvGuess(), n.fetch);
    expect(v).toMatchObject({ status: 'verified', boardName: null, jobsSeen: 20 });
    expect(v.reasons).toEqual(["workday board nvidia/NVIDIAExternalCareerSite: 20+ open jobs; workday tenant 'nvidia' matches 'NVIDIA'"]);
    expect(n.calls).toEqual([`GET https://${NV_HOST}/robots.txt`, `POST ${NV_BOARD} {"appliedFacets":{},"limit":20,"offset":0,"searchText":""}`]);
  });

  it('a tenant that is neither the name nor the domain label is proposed: board name not available', async () => {
    const fx = nvFixture();
    const n = serveWorkday({ [`https://${NV_HOST}/robots.txt`]: { body: fx.robots }, [NV_BOARD]: { body: fx.pages[0] } });
    const v = await verify(nvGuess('Mellanox Technologies', 'mellanox.com'), n.fetch);
    expect(v.status).toBe('proposed');
    expect(v.reasons).toEqual(['board name not available, please confirm', "workday tenant 'nvidia' is neither 'Mellanox Technologies' nor the domain label 'mellanox'"]);
  });

  it('a robots.txt disallowing the CXS path: proposed, the board never read', async () => {
    const n = serveWorkday({ [`https://${NV_HOST}/robots.txt`]: { body: 'User-agent: *\nDisallow: /wday/\n' }, [NV_BOARD]: { body: nvFixture().pages[0] } });
    const v = await verify(nvGuess(), n.fetch);
    expect(v.status).toBe('proposed');
    expect(v.reasons[0]).toBe(`robots-disallow /wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs on ${NV_HOST}: the board was not read, please confirm`);
    expect(n.calls).toEqual([`GET https://${NV_HOST}/robots.txt`]);
  });

  it('403 on the list: the host is disabled and the step deferred, never retried around', async () => {
    const n = serveWorkday({ [`https://${NV_HOST}/robots.txt`]: { body: '' }, [NV_BOARD]: { status: 403, body: '' } });
    const agent = makeBoardVerifier(fresh());
    const ctx = ctxFor(n.fetch, [nvGuess()]);
    await expect(agent.run(nvGuess(), ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^host-disabled:http-403 on nvidia\.wd5\.myworkdayjobs\.com/) });
    await expect(agent.run(nvGuess(), ctxFor(n.fetch, [nvGuess()]))).rejects.toMatchObject({ code: 'input_rejected' });
    expect(n.calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
  });

  it('a list missing expected fields fails the board; a guess without a board URL is proposed, nothing fetched', async () => {
    const n = serveWorkday({ [`https://${NV_HOST}/robots.txt`]: { body: '' }, [NV_BOARD]: { body: { jobPostings: [] } } });
    const v = await verify(nvGuess(), n.fetch);
    expect(v.status).toBe('failed');
    expect(v.reasons[0]).toMatch(/list: response shape is not valid \(total/);
    const bare = guess(cand('nvidia.com', 'NVIDIA'), 'workday', 'nvidia/NVIDIAExternalCareerSite');
    const n2 = serveWorkday({});
    expect(await verify(bare, n2.fetch)).toMatchObject({ status: 'proposed', reasons: ['no readable workday board in nvidia/NVIDIAExternalCareerSite, please confirm'] });
    expect(n2.calls).toEqual([]);
  });
});

describe('board-verifier: the hard gate (2xx, valid shape, at least 1 job, same company)', () => {
  it('verifies a Greenhouse board whose own company name matches', async () => {
    const g = guess(cand('acme.test', 'Acme, Inc.'), 'greenhouse', 'acme');
    const n = serve({ [greenhouseUrl('acme')]: { body: gh('Acme') } });
    const v = await verify(g, n.fetch);
    expect(v).toMatchObject({ status: 'verified', boardName: 'Acme', jobsSeen: 2 });
    expect(n.calls).toEqual([greenhouseUrl('acme')]);
  });

  it('a different board name is proposed with the spec\'s reason', async () => {
    const v = await verify(guess(cand('acme.test', 'Acme Robotics'), 'greenhouse', 'acme'), serve({ [greenhouseUrl('acme')]: { body: gh('Acme Holdings') } }).fetch);
    expect(v).toMatchObject({ status: 'proposed', boardName: 'Acme Holdings', jobsSeen: 2 });
    expect(v.reasons).toContain("board name 'Acme Holdings' ≈ 'Acme Robotics', please confirm");
  });

  it('a board name equal to the registrable domain label verifies', async () => {
    const v = await verify(guess(cand('purestorage.com', 'Pure Storage Inc'), 'greenhouse', 'purestorage'), serve({ [greenhouseUrl('purestorage')]: { body: gh('purestorage') } }).fetch);
    expect(v.status).toBe('verified');
  });

  it('several company names on one board is proposed', async () => {
    const body = { jobs: [{ id: 1, title: 'A', company_name: 'Acme' }, { id: 2, title: 'B', company_name: 'Other Co' }] };
    const v = await verify(guess(cand('acme.test', 'Acme'), 'greenhouse', 'acme'), serve({ [greenhouseUrl('acme')]: { body } }).fetch);
    expect(v).toMatchObject({ status: 'proposed', boardName: null });
    expect(v.reasons.join('\n')).toMatch(/several company names \(Acme, Other Co\)/);
  });

  it('0 jobs is proposed, even with the right name', async () => {
    const v = await verify(guess(cand('acme.test', 'Acme'), 'greenhouse', 'acme'), serve({ [greenhouseUrl('acme')]: { body: { jobs: [], meta: { total: 0 } } } }).fetch);
    expect(v).toMatchObject({ status: 'proposed', jobsSeen: 0 });
    expect(v.reasons).toContain('board has 0 open jobs');
  });

  it('Lever and Ashby give no company name: the slug is checked against the name and the domain label', async () => {
    const ok = await verify(guess(cand('palantir.com', 'Palantir Technologies'), 'lever', 'palantir'), serve({ [leverUrl('palantir', 0)]: { body: lever() } }).fetch);
    expect(ok).toMatchObject({ status: 'verified', boardName: null, jobsSeen: 2 });
    const label = await verify(guess(cand('notion.so', 'Notion Labs'), 'ashby', 'notion'), serve({ [ashbyUrl('notion')]: { body: ashby() } }).fetch);
    expect(label.status).toBe('verified');
    const other = await verify(guess(cand('beta.test', 'Beta Labs'), 'lever', 'gammacorp'), serve({ [leverUrl('gammacorp', 0)]: { body: lever() } }).fetch);
    expect(other).toMatchObject({ status: 'proposed', boardName: null });
    expect(other.reasons).toContain('board name not available, please confirm');
  });

  it('a generic domain label never verifies through the label route (carry 2)', async () => {
    const c = cand('jobs.test', 'Acme Robotics', { website: 'https://jobs.test' });
    const v = await verify(guess(c, 'lever', 'jobs'), serve({ [leverUrl('jobs', 0)]: { body: lever() } }).fetch);
    expect(v.status).toBe('proposed');
    const g2 = await verify(guess(c, 'greenhouse', 'jobs'), serve({ [greenhouseUrl('jobs')]: { body: gh('Jobs') } }).fetch);
    expect(g2.status).toBe('proposed');
  });

  it('a missing board (404) is failed: a URL-only detection of a dead board never verifies (carry 8)', async () => {
    const dead = guess(cand('example.test', 'Example Missing'), 'greenhouse', 'nosuchboardjobpilottest', { evidence: ['detected: greenhouse nosuchboardjobpilottest', 'greenhouse nosuchboardjobpilottest via url'] });
    const v = await verify(dead, serve({}).fetch);
    expect(v).toMatchObject({ status: 'failed', boardName: null, jobsSeen: null });
    expect(v.reasons.join('\n')).toMatch(/board not found \(404\)/);
    const ab = await verify(guess(cand('example.test', 'Example Missing'), 'ashby', 'no-such-board-jobpilot-test'), serve({}).fetch);
    expect(ab.status).toBe('failed');
  });

  it('a response of the wrong shape is failed, never partially read', async () => {
    const noTitle = await verify(guess(cand('acme.test', 'Acme'), 'greenhouse', 'acme'), serve({ [greenhouseUrl('acme')]: { body: { jobs: [{ id: 1, company_name: 'Acme' }] } } }).fetch);
    expect(noTitle.status).toBe('failed');
    expect(noTitle.reasons.join('\n')).toMatch(/response shape is not valid/);
    const notArray = await verify(guess(cand('acme.test', 'Acme'), 'lever', 'acme'), serve({ [leverUrl('acme', 0)]: { body: { postings: [] } } }).fetch);
    expect(notArray.status).toBe('failed');
    const html = await verify(guess(cand('acme.test', 'Acme'), 'ashby', 'acme'), serve({ [ashbyUrl('acme')]: { body: '<html>oops</html>' } }).fetch);
    expect(html.status).toBe('failed');
  });

  it('a board read past the request timeout FAILS the step with timeout (C1: never a failed verdict, never a disable)', async () => {
    const hang: FetchLike = (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted'))));
    const store = memoryHostStateStore();
    const g = guess(cand('acme.test', 'Acme'), 'greenhouse', 'acme');
    await expect(makeBoardVerifier({ runKey: 'r', store, requestTimeoutMs: 20 }).run(g, ctxFor(hang, [g]))).rejects.toMatchObject({ code: 'timeout', message: expect.stringMatching(/timed out after 20 ms/) });
    expect([...store.coverageHostState('r')]).toEqual([]);
  });

  it('a board read that fails with a network error FAILS the step with network (C1: an outage never adds a failed week)', async () => {
    const reset: FetchLike = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    };
    const g = guess(cand('acme.test', 'Acme'), 'greenhouse', 'acme');
    await expect(makeBoardVerifier(fresh()).run(g, ctxFor(reset, [g]))).rejects.toMatchObject({ code: 'network' });
  });

  it('C1-e: a documented API read ignores a robots.txt state set by page crawling; only a refusal (401/403/429/challenge) defers it', async () => {
    const g = guess(cand('acme.test', 'Acme'), 'greenhouse', 'acme');
    const n = serve({ [greenhouseUrl('acme')]: { body: gh('Acme') } });
    for (const why of ['robots-transient', 'robots-unavailable', 'no-such-host', 'robots-forbidden']) {
      const gate = makeRunGate({ runKey: 'r', store: memoryHostStateStore() });
      gate.disable('boards-api.greenhouse.io', why, '2026-10-11T01:30:00.000Z');
      expect((await verify(g, n.fetch, makeBoardVerifier({ gate }))).status).toBe('verified');
    }
    for (const why of ['http-401', 'http-403', 'http-429', 'challenge']) {
      const gate = makeRunGate({ runKey: 'r', store: memoryHostStateStore() });
      gate.disable('boards-api.greenhouse.io', why, '2026-10-11T01:30:00.000Z');
      await expect(makeBoardVerifier({ gate }).run(g, ctxFor(n.fetch, [g]))).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(new RegExp(`host-disabled:${why} on boards-api\\.greenhouse\\.io`)) });
    }
  });

  it('a board API that redirects is a failed verdict "board API redirected off-platform", never a policy denial or a step error', async () => {
    const g = guess(cand('acme.test', 'Acme'), 'greenhouse', 'acme');
    const n = serve({ [greenhouseUrl('acme')]: { status: 301, location: 'https://www.acme.test/careers' } });
    const v = await verify(g, n.fetch); // verify() also asserts ctx.denials() is empty
    expect(v.status).toBe('failed');
    expect(v.reasons.join('\n')).toMatch(/board API redirected off-platform \(301 to www\.acme\.test\)/);
    expect(n.calls).toEqual([greenhouseUrl('acme')]);
  });

  it('a 5xx reads as the broker\'s code through the page read: the step FAILS overloaded (C1), never a failed verdict', async () => {
    const g = guess(cand('acme.test', 'Acme'), 'lever', 'acme');
    await expect(makeBoardVerifier(fresh()).run(g, ctxFor(serve({ [leverUrl('acme', 0)]: { status: 503, body: 'down' } }).fetch, [g]))).rejects.toMatchObject({ code: 'overloaded', message: expect.stringMatching(/503/) });
  });

  it('a platform without an adapter is proposed with "adapter not built yet", nothing fetched (carry 12)', async () => {
    const n = serve({});
    // Task 9 built the last of the nine small platforms: every platform the detector can name has a client now, so the
    // path is exercised with a name this build does not know (the CompanyVerdict schema is not applied to it)
    const g = { ...guess(cand('acme.test', 'Acme'), 'gem', 'acme'), platform: 'avature' as never };
    const ctx = ctxFor(n.fetch, [g]);
    const out = await makeBoardVerifier(fresh()).run(g, ctx);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: 'proposed', boardName: null, jobsSeen: null });
    expect((out[0] as { reasons: string[] }).reasons[0]).toBe('adapter not built yet: avature');
    expect(n.calls).toEqual([]);
    expect(verifierHosts(g)).toEqual([]);
  });

  it('no platform: proposed, the detector\'s reasons carried, nothing fetched (carry 9)', async () => {
    const n = serve({});
    const g = guess(cand('acme.test', 'Acme'), null, null, { evidence: ['unfetched: redirected to https://jobs.example/acme', 'redirected (target unfetched)'], site: site(cand('acme.test', 'Acme'), 'https://jobs.acme.test/', { method: 'subdomain', evidence: 'GET jobs.acme.test/ redirected (target unfetched)' }) });
    const v = await verify(g, n.fetch);
    expect(v.status).toBe('proposed');
    expect(v.reasons.join('\n')).toMatch(/no platform detected: unfetched: redirected/);
    expect(v.reasons.join('\n')).toMatch(/target unfetched/);
    expect(n.calls).toEqual([]);
  });
});

describe('board-verifier: politeness and memo safety', () => {
  it('a 429 disables the host for the run and defers the step; a sibling is deferred without a request', async () => {
    const store = memoryHostStateStore();
    const gate = makeRunGate({ runKey: 'run-1', store });
    const agent = makeBoardVerifier({ gate });
    const a = guess(cand('a.test', 'A'), 'greenhouse', 'a');
    const b = guess(cand('b.test', 'B'), 'greenhouse', 'b');
    const n = serve({ [greenhouseUrl('a')]: { status: 429, body: 'slow down' }, [greenhouseUrl('b')]: { body: gh('B') } });
    await expect(agent.run(a, ctxFor(n.fetch, [a, b]))).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringContaining('host-disabled:http-429') });
    expect([...store.coverageHostState('run-1')]).toEqual([['boards-api.greenhouse.io', 'http-429']]);
    await expect(agent.run(b, ctxFor(n.fetch, [a, b]))).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringContaining('host-disabled:http-429') });
    expect(n.calls).toEqual([greenhouseUrl('a')]);
    // the same run resumed (a new verifier on the same key and store) still knows
    const resumed = makeBoardVerifier({ runKey: 'run-1', store });
    await expect(resumed.run(b, ctxFor(n.fetch, [b]))).rejects.toMatchObject({ code: 'input_rejected' });
    expect(n.calls).toHaveLength(1);
  });

  it('a 401 or 403 disables the host too (never retried around)', async () => {
    for (const status of [401, 403]) {
      const store = memoryHostStateStore();
      const agent = makeBoardVerifier({ runKey: 'r', store });
      const a = guess(cand('a.test', 'A'), 'lever', 'a');
      await expect(agent.run(a, ctxFor(serve({ [leverUrl('a', 0)]: { status, body: 'no' } }).fetch, [a]))).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringContaining(`host-disabled:http-${status}`) });
      expect([...store.coverageHostState('r')]).toEqual([['api.lever.co', `http-${status}`]]);
    }
  });

  it('a host disabled by another agent of the same run (the shared gate) defers without a request', async () => {
    const gate = makeRunGate(fresh());
    gate.disable('api.ashbyhq.com', 'challenge', '2026-10-11T01:30:00.000Z');
    const n = serve({});
    const a = guess(cand('a.test', 'A'), 'ashby', 'a');
    await expect(makeBoardVerifier({ gate }).run(a, ctxFor(n.fetch, [a]))).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringContaining('host-disabled:challenge') });
    expect(n.calls).toEqual([]);
  });

  it('egress: exactly the read hosts of the detected, built platforms', () => {
    const gs = [guess(cand('a.test', 'A'), 'greenhouse', 'a'), guess(cand('b.test', 'B'), 'lever', 'b'), guess(cand('c.test', 'C'), 'workday', 'c/x'), guess(cand('d.test', 'D'), null, null)];
    expect(verifierEgressSets(gs)).toEqual({ 'coverage:candidate-hosts': ['api.lever.co', 'boards-api.greenhouse.io'] });
    expect(boardVerifierContract).toMatchObject({ id: 'board-verifier', team: 'coverage-verifier', kind: 'io', egress: ['coverage:candidate-hosts'] });
    expect(boardVerifierContract.retry.max).toBe(0);
  });

  it('domainLabel is the registrable domain\'s first label', () => {
    expect(domainLabel('purestorage.com')).toBe('purestorage');
    expect(domainLabel('foo.co.uk')).toBe('foo');
    expect(domainLabel('acme.github.io')).toBe('acme');
  });
});

// ---------------------------------------------------------------------------
// Task 7: Eightfold and Oracle Recruiting Cloud
// ---------------------------------------------------------------------------

const recorded = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../fixtures/sources/${name}.json`, import.meta.url), 'utf8')) as T;
interface EfFixture {
  readonly robots: string;
  readonly careersPage: string;
  readonly discovery: unknown;
}

describe('board-verifier: Eightfold (the careers page names the API; the domain label is the board name)', () => {
  const NF = 'explore.jobs.netflix.net';
  const MS = 'apply.careers.microsoft.com';
  const nfGuess = (name = 'Netflix', key = 'netflix.com') => guess(cand(key, name), 'eightfold', `${NF}/netflix.com`, { boardUrl: `https://${NF}/api/apply/v2/jobs?domain=netflix.com` });

  it('verifies the recorded Netflix board (v2): robots.txt, the careers page, then page 1; the domain label matches', async () => {
    const fx = recorded<EfFixture>('eightfold-netflix');
    const n = serve({ [`https://${NF}/robots.txt`]: { body: fx.robots }, [`https://${NF}/careers?domain=netflix.com`]: { body: fx.careersPage }, [`https://${NF}/api/apply/v2/jobs?domain=netflix.com&start=0&num=10`]: { body: fx.discovery } });
    const v = await verify(nfGuess(), n.fetch);
    expect(v.status).toBe('verified');
    expect(v.reasons).toEqual(["eightfold board explore.jobs.netflix.net/netflix.com: 3+ open jobs; eightfold tenant 'netflix' matches 'Netflix'"]);
    expect(n.calls).toEqual([`https://${NF}/robots.txt`, `https://${NF}/careers?domain=netflix.com`, `https://${NF}/api/apply/v2/jobs?domain=netflix.com&start=0&num=10`]);
  });

  it('fix round 1: a verified Eightfold verdict stores the detected API variant in its slug and the matching board URL (no migration)', async () => {
    const fx = recorded<EfFixture>('eightfold-netflix');
    const n = serve({ [`https://${NF}/robots.txt`]: { body: fx.robots }, [`https://${NF}/careers?domain=netflix.com`]: { body: fx.careersPage }, [`https://${NF}/api/apply/v2/jobs?domain=netflix.com&start=0&num=10`]: { body: fx.discovery } });
    const v = await verify(nfGuess(), n.fetch);
    expect(v.guess.slug).toBe('v2:explore.jobs.netflix.net/netflix.com');
    expect(v.guess.boardUrl).toBe('https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com');
    const ms = recorded<EfFixture>('eightfold-microsoft');
    const pcsx = `https://${MS}/api/pcsx/search?domain=microsoft.com&query=&location=&start=0&sort_by=relevance`;
    const m = serve({ [`https://${MS}/robots.txt`]: { body: ms.robots }, [`https://${MS}/careers?domain=microsoft.com`]: { body: ms.careersPage }, [pcsx]: { body: ms.discovery } });
    const mv = await verify(guess(cand('microsoft.com', 'Microsoft'), 'eightfold', `${MS}/microsoft.com`, { boardUrl: `https://${MS}/api/apply/v2/jobs?domain=microsoft.com` }), m.fetch);
    expect(mv.status).toBe('verified');
    expect(mv.guess.slug).toBe('pcsx:apply.careers.microsoft.com/microsoft.com');
    expect(mv.guess.boardUrl).toBe('https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com');
    // a re-verify of a stored variant detects again (weekly) and keeps one variant prefix
    const again = await verify(guess(cand('microsoft.com', 'Microsoft'), 'eightfold', 'pcsx:apply.careers.microsoft.com/microsoft.com', { boardUrl: mv.guess.boardUrl }), serve({ [`https://${MS}/robots.txt`]: { body: ms.robots }, [`https://${MS}/careers?domain=microsoft.com`]: { body: ms.careersPage }, [pcsx]: { body: ms.discovery } }).fetch);
    expect(again.guess.slug).toBe('pcsx:apply.careers.microsoft.com/microsoft.com');
  });

  it('verifies the recorded Microsoft board through PCSX only (its v2 answers 403, never asked)', async () => {
    const fx = recorded<EfFixture>('eightfold-microsoft');
    const pcsx = `https://${MS}/api/pcsx/search?domain=microsoft.com&query=&location=&start=0&sort_by=relevance`;
    const n = serve({ [`https://${MS}/robots.txt`]: { body: fx.robots }, [`https://${MS}/careers?domain=microsoft.com`]: { body: fx.careersPage }, [pcsx]: { body: fx.discovery } });
    const v = await verify(guess(cand('microsoft.com', 'Microsoft'), 'eightfold', `${MS}/microsoft.com`, { boardUrl: `https://${MS}/api/apply/v2/jobs?domain=microsoft.com` }), n.fetch);
    expect(v.status).toBe('verified');
    expect(v.reasons[0]).toMatch(/^eightfold board apply\.careers\.microsoft\.com\/microsoft\.com: 3\+ open jobs; eightfold tenant 'microsoft' matches 'Microsoft'$/);
    expect(n.calls.some((c) => c.includes('/api/apply/'))).toBe(false);
  });

  it('a domain label that is not the company is proposed "board name not available, please confirm"; a robots disallow is proposed, unread', async () => {
    const fx = recorded<EfFixture>('eightfold-netflix');
    const routes = { [`https://${NF}/robots.txt`]: { body: fx.robots }, [`https://${NF}/careers?domain=netflix.com`]: { body: fx.careersPage }, [`https://${NF}/api/apply/v2/jobs?domain=netflix.com&start=0&num=10`]: { body: fx.discovery } };
    const v = await verify(nfGuess('Acme Streaming', 'acmestreaming.com'), serve(routes).fetch);
    expect(v.status).toBe('proposed');
    expect(v.reasons).toEqual(['board name not available, please confirm', "eightfold tenant 'netflix' is neither 'Acme Streaming' nor the domain label 'acmestreaming'"]);
    const n = serve({ ...routes, [`https://${NF}/robots.txt`]: { body: 'User-agent: *\nDisallow: /\n' } });
    const d = await verify(nfGuess(), n.fetch);
    expect(d).toMatchObject({ status: 'proposed', reasons: [expect.stringMatching(/^robots-disallow \/careers on explore\.jobs\.netflix\.net: the board was not read, please confirm$/), `detected: eightfold ${NF}/netflix.com`] });
    expect(n.calls).toEqual([`https://${NF}/robots.txt`]);
  });

  it('fix round 2: a careers-page 429 or challenge is a deferral (host-disabled), never a failed verdict, so no fail week', async () => {
    const fx = recorded<EfFixture>('eightfold-netflix');
    for (const [careers, why] of [[{ status: 429, body: 'Please try again later' }, 'http-429'], [{ status: 200, body: '<title>Just a moment...</title>' }, 'challenge']] as const) {
      const n = serve({ [`https://${NF}/robots.txt`]: { body: fx.robots }, [`https://${NF}/careers?domain=netflix.com`]: careers });
      const agent = makeBoardVerifier(fresh());
      await expect(agent.run(nfGuess(), ctxFor(n.fetch, [nfGuess()])), why).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(new RegExp(`^host-disabled:${why} on explore\\.jobs\\.netflix\\.net`)) });
      // nothing past the careers page
      expect(n.calls).toEqual([`https://${NF}/robots.txt`, `https://${NF}/careers?domain=netflix.com`]);
    }
  });

  it('a 403 from the list disables the host and defers the step', async () => {
    const fx = recorded<EfFixture>('eightfold-netflix');
    const n = serve({ [`https://${NF}/robots.txt`]: { body: fx.robots }, [`https://${NF}/careers?domain=netflix.com`]: { body: fx.careersPage }, [`https://${NF}/api/apply/v2/jobs?domain=netflix.com&start=0&num=10`]: { status: 403, body: '{}' } });
    const agent = makeBoardVerifier(fresh());
    await expect(agent.run(nfGuess(), ctxFor(n.fetch, [nfGuess()]))).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^host-disabled:http-403 on explore\.jobs\.netflix\.net/) });
  });
});

describe('board-verifier: Oracle Recruiting Cloud (a 403 robots.txt is unknown; the host label is the board name)', () => {
  const JPM = 'jpmc.fa.oraclecloud.com';
  const page1 = `https://${JPM}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=CX_1001,facetsList=LOCATIONS%3BWORKPLACE_TYPES,limit=100,offset=0`;
  const jpmGuess = () => guess(cand('jpmorganchase.com', 'JPMorgan Chase'), 'oracle', `${JPM}/CX_1001`, { boardUrl: JPM_BOARD });
  const fx = () => recorded<{ robots: { status: number; body: string }; discovery: unknown }>('oracle-jpmorgan');

  it('reads the recorded JPMorgan page 1 past its 403 robots.txt (the host is not disabled); "jpmc" is not the company: proposed, please confirm', async () => {
    const n = serve({ [`https://${JPM}/robots.txt`]: { status: 403, body: fx().robots.body }, [page1]: { body: fx().discovery } });
    const v = await verify(jpmGuess(), n.fetch);
    expect(v.status).toBe('proposed');
    expect(v.reasons).toEqual(['board name not available, please confirm', "oracle tenant 'jpmc' is neither 'JPMorgan Chase' nor the domain label 'jpmorganchase'"]);
    expect(v.jobsSeen).toBe(3);
    expect(n.calls).toEqual([`https://${JPM}/robots.txt`, page1]);
  });

  it('a readable robots.txt disallowing the REST path is proposed, unread; a 403 from the API defers the step', async () => {
    const n = serve({ [`https://${JPM}/robots.txt`]: { body: 'User-agent: *\nDisallow: /hcmRestApi/\n' }, [page1]: { body: fx().discovery } });
    const v = await verify(jpmGuess(), n.fetch);
    expect(v).toMatchObject({ status: 'proposed', reasons: [expect.stringMatching(/^robots-disallow \/hcmRestApi\/resources\/latest\/recruitingCEJobRequisitions on jpmc\.fa\.oraclecloud\.com: the board was not read/), `detected: oracle ${JPM}/CX_1001`] });
    expect(n.calls).toEqual([`https://${JPM}/robots.txt`]);
    const r = serve({ [`https://${JPM}/robots.txt`]: { status: 403, body: '' }, [page1]: { status: 403, body: '' } });
    await expect(makeBoardVerifier(fresh()).run(jpmGuess(), ctxFor(r.fetch, [jpmGuess()]))).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^host-disabled:http-403 on jpmc\.fa\.oraclecloud\.com/) });
  });

  it('C1: a robots.txt that fails in transport or answers 5xx is not "unavailable": the step fails and is asked again later', async () => {
    const fiveHundred = serve({ [`https://${JPM}/robots.txt`]: { status: 502, body: '' }, [page1]: { body: fx().discovery } });
    await expect(makeBoardVerifier(fresh()).run(jpmGuess(), ctxFor(fiveHundred.fetch, [jpmGuess()]))).rejects.toMatchObject({ code: 'network', message: expect.stringMatching(/robots-transient/) });
    const reset: FetchLike = async (url, init) => {
      if (url.endsWith('/robots.txt')) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
      return fiveHundred.fetch(url, init);
    };
    await expect(makeBoardVerifier(fresh()).run(jpmGuess(), ctxFor(reset, [jpmGuess()]))).rejects.toMatchObject({ code: 'network' });
    expect(fiveHundred.calls).not.toContain(page1);
  });
});

describe('board-verifier: the page platforms (Task 8: strict robots, a JobPosting on one job page, refusals deferred)', () => {
  const page = (name: string): string => readFileSync(new URL(`../../fixtures/pages/${name}`, import.meta.url), 'utf8');
  const IC = 'careers-apac-atlassian.icims.com';
  const JOB = `https://${IC}/jobs/25565/senior-backend-software-engineer/job?in_iframe=1`;
  const icGuess = () => guess(cand('atlassian.com', 'Atlassian'), 'icims', IC, { boardUrl: `https://${IC}/sitemap.xml` });
  const routes = (over: Record<string, Route> = {}): Record<string, Route> => ({
    [`https://${IC}/robots.txt`]: { body: page('icims-atlassian-robots.txt') },
    [`https://${IC}/sitemap.xml`]: { body: page('icims-atlassian-sitemap.xml') },
    [JOB]: { body: page('icims-atlassian-job-25565.html') },
    ...over,
  });

  it('Atlassian (recorded): verified by the JobPosting\'s hiringOrganization, 65 jobs, 3 requests', async () => {
    const n = serve(routes());
    expect(verifierHosts(icGuess())).toEqual([IC]);
    const v = await verify(icGuess(), n.fetch);
    expect(v).toMatchObject({ status: 'verified', boardName: 'Atlassian', jobsSeen: 65 });
    expect(n.calls).toEqual([`https://${IC}/robots.txt`, `https://${IC}/sitemap.xml`, JOB]);
  });

  it('the strict robots rule: a 403 robots.txt refuses the host, the step is deferred, nothing else fetched', async () => {
    const n = serve(routes({ [`https://${IC}/robots.txt`]: { status: 403, body: 'denied' } }));
    await expect(makeBoardVerifier(fresh()).run(icGuess(), ctxFor(n.fetch, [icGuess()]))).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^host-disabled:robots-forbidden on careers-apac-atlassian\.icims\.com/) });
    expect(n.calls).toEqual([`https://${IC}/robots.txt`]);
  });

  it('a 429 or a challenge on the job page is a deferral (host-disabled), never a failed verdict', async () => {
    for (const [answer, why] of [[{ status: 429, body: 'slow down' }, 'http-429'], [{ status: 503, body: '<title>Just a moment...</title>' }, 'challenge']] as const) {
      const n = serve(routes({ [JOB]: answer }));
      await expect(makeBoardVerifier(fresh()).run(icGuess(), ctxFor(n.fetch, [icGuess()])), why).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(new RegExp(`^host-disabled:${why} on careers-apac-atlassian\\.icims\\.com`)) });
    }
  });

  it('a job page without a valid JobPosting is a failed verdict; an empty sitemap is proposed (0 jobs)', async () => {
    const bad = await verify(icGuess(), serve(routes({ [JOB]: { body: '<html>no ld</html>' } })).fetch);
    expect(bad.status).toBe('failed');
    expect(bad.reasons.join('\n')).toMatch(/no valid JobPosting/);
    const none = await verify(icGuess(), serve(routes({ [`https://${IC}/sitemap.xml`]: { body: '<urlset></urlset>' } })).fetch);
    expect(none).toMatchObject({ status: 'proposed', jobsSeen: 0 });
  });

  it('SmartRecruiters (Bosch, the live shape): the listing moves to careers.smartrecruiters.com, whose robots.txt is unavailable to the gate: deferred, never read', async () => {
    const g = guess(cand('bosch.com', 'Bosch'), 'smartrecruiters', 'BoschGroup', { boardUrl: 'https://jobs.smartrecruiters.com/BoschGroup' });
    const n = serve({ 'https://jobs.smartrecruiters.com/robots.txt': { status: 404, body: 'nf' }, 'https://jobs.smartrecruiters.com/BoschGroup': { status: 301, location: 'https://careers.smartrecruiters.com/BoschGroup' } });
    await expect(makeBoardVerifier(fresh()).run(g, ctxFor(n.fetch, [g]))).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^host-disabled:robots-unavailable on careers\.smartrecruiters\.com/) });
    expect(n.calls).toEqual(['https://jobs.smartrecruiters.com/robots.txt', 'https://jobs.smartrecruiters.com/BoschGroup']);
  });

  it('SuccessFactors (HCLTech, recorded): the feed up to its first item; g:employer is not the candidate\'s name, so proposed', async () => {
    const HCL = 'careers.hcltech.com';
    const g = guess(cand('hcltech.com', 'HCLTech'), 'successfactors', HCL, { boardUrl: `https://${HCL}/sitemal.xml` });
    const n = serve({ [`https://${HCL}/robots.txt`]: { body: page('successfactors-hcltech-robots.txt') }, [`https://${HCL}/sitemal.xml`]: { body: page('successfactors-hcltech-sitemal.xml') } });
    const v = await verify(g, n.fetch);
    expect(v).toMatchObject({ status: 'proposed', boardName: 'HCL Technologies Limited', jobsSeen: 1 });
    expect(v.reasons[0]).toMatch(/^board name 'HCL Technologies Limited' ≈ 'HCLTech', please confirm$/);
  });
});

it('a UKG guess is Proposed with the robots reason, nothing fetched', async () => {
  const { fetch, calls } = serve({});
  const v = await verify(guess(cand('acme.com', 'Acme'), 'ukg', 'recruiting.ultipro.com/acme1/10653576-f6a1-4d69-8a9c-a0a96124abda'), fetch);
  expect(v.status).toBe('proposed');
  expect(v.reasons[0]).toMatch(/^ukg: not read: robots\.txt disallows \*\/JobBoardView/);
  expect(calls).toEqual([]);
});
