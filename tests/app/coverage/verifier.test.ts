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
  it('reads Greenhouse, Lever and Ashby with the daily adapters\' own URLs; every other platform is not built', () => {
    expect(BUILT_PLATFORMS).toEqual(['ashby', 'greenhouse', 'lever']);
    expect(platformClient('greenhouse')?.boardUrl('acme')).toBe(greenhouseUrl('acme'));
    expect(platformClient('lever')?.boardUrl('acme')).toBe(leverUrl('acme', 0));
    expect(platformClient('ashby')?.boardUrl('Acme Co')).toBe(ashbyUrl('Acme Co'));
    expect(platformClient('greenhouse')?.host).toBe('boards-api.greenhouse.io');
    expect(platformClient('lever')?.host).toBe('api.lever.co');
    expect(platformClient('ashby')?.host).toBe('api.ashbyhq.com');
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

  it('a board read past the request timeout is failed with the reason, never a step error, never a disable', async () => {
    const hang: FetchLike = (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted'))));
    const store = memoryHostStateStore();
    const v = await verify(guess(cand('acme.test', 'Acme'), 'greenhouse', 'acme'), hang, makeBoardVerifier({ runKey: 'r', store, requestTimeoutMs: 20 }));
    expect(v.status).toBe('failed');
    expect(v.reasons.join('\n')).toMatch(/timed out after 20 ms/);
    expect([...store.coverageHostState('r')]).toEqual([]);
  });

  it('a board API that redirects is a failed verdict "board API redirected off-platform", never a policy denial or a step error', async () => {
    const g = guess(cand('acme.test', 'Acme'), 'greenhouse', 'acme');
    const n = serve({ [greenhouseUrl('acme')]: { status: 301, location: 'https://www.acme.test/careers' } });
    const v = await verify(g, n.fetch); // verify() also asserts ctx.denials() is empty
    expect(v.status).toBe('failed');
    expect(v.reasons.join('\n')).toMatch(/board API redirected off-platform \(301 to www\.acme\.test\)/);
    expect(n.calls).toEqual([greenhouseUrl('acme')]);
  });

  it('a 5xx still reads as the broker\'s code through the page read: a failed verdict', async () => {
    const v = await verify(guess(cand('acme.test', 'Acme'), 'lever', 'acme'), serve({ [leverUrl('acme', 0)]: { status: 503, body: 'down' } }).fetch);
    expect(v.status).toBe('failed');
    expect(v.reasons.join('\n')).toMatch(/503/);
  });

  it('a platform without an adapter is proposed with "adapter not built yet", nothing fetched (carry 12)', async () => {
    const n = serve({});
    const v = await verify(guess(cand('nvidia.com', 'NVIDIA'), 'workday', 'nvidia/NVIDIAExternalCareerSite'), n.fetch);
    expect(v).toMatchObject({ status: 'proposed', boardName: null, jobsSeen: null });
    expect(v.reasons[0]).toBe('adapter not built yet: workday');
    expect(n.calls).toEqual([]);
    expect(verifierHosts(guess(cand('nvidia.com', 'NVIDIA'), 'workday', 'x'))).toEqual([]);
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
