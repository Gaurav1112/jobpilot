import { describe, expect, it } from 'vitest';
import { checkJobPosting, findJobPosting, jsonLdBlocks, jsonLdJobPostings, keptJobPosting } from '../../src/app/agents/sources/jsonld.js';
import {
  getRuledPage,
  memoryPageState,
  PAGE_MAX_FETCHES,
  PAGE_MAX_HOPS,
  PAGE_STALE_DAYS,
  planPages,
  readJobPages,
  slugTitle,
  type ListedJob,
  type PageRecord,
} from '../../src/app/agents/sources/platforms/pages.js';
import { HostDisabled, HostRefused, RobotsDenied, type PlatformHosts } from '../../src/app/agents/sources/platforms/shared.js';
import { isSitemapIndex, sitemapLocs } from '../../src/app/text/sitemap.js';
import { dailyPlatformHosts } from '../../src/app/daily-hosts.js';
import type { RawPosting } from '../../src/app/types.js';
import type { AgentContext } from '../../src/kernel/agent.js';
import { createHostPacer, issueContext } from '../../src/kernel/broker.js';
import { defineContract } from '../../src/kernel/contract.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import type { FetchLike } from '../../src/kernel/providers.js';
import { DiscoveryRequest, RawPosting as RawPostingType } from '../../src/app/types.js';

/**
 * Task 8, the parts the four page adapters share: JSON-LD on a plain HTML page (factored out of careers.ts), the
 * sitemap reader (moved out of the coverage locator), the strict host rules for a page request, and the incremental
 * crawl: at most PAGE_MAX_FETCHES job pages per company per run, never-fetched pages first (sitemap order), then pages
 * last fetched over PAGE_STALE_DAYS ago (oldest first, ties by URL); a page fetched before keeps its posting.
 */

const MB = 1024 * 1024;
const rep = (x: string): string => x.repeat(Math.ceil(MB / x.length)).slice(0, MB);
const time = (f: () => unknown): number => {
  const t = performance.now();
  f();
  return performance.now() - t;
};
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const JOB = { '@type': 'JobPosting', title: 'Senior Software Engineer', description: '<p>Build services.</p>', datePosted: '2026-10-01', jobLocation: { '@type': 'Place', address: { addressLocality: 'Bengaluru', addressRegion: 'UNAVAILABLE', addressCountry: 'IN', streetAddress: '1 Road' } }, hiringOrganization: { '@type': 'Organization', name: 'Acme', sameAs: 'https://acme.test' } };

describe('jsonLdJobPostings (JSON-LD of a plain HTML page)', () => {
  it('reads plain, @graph, nested and array-typed JobPostings in document order; malformed blocks are counted', () => {
    const html = [
      '<html><head>',
      ld({ '@type': 'Organization', name: 'Acme' }),
      '<SCRIPT TYPE="Application/LD+JSON">{ broken',
      '</SCRIPT>',
      ld({ '@graph': [{ '@type': ['JobPosting'], title: 'B' }] }),
      "<script type='application/ld+json'>",
      JSON.stringify([{ '@type': 'JobPosting', title: 'C' }]),
      '</script>',
      '<script>{"@type":"JobPosting","title":"not ld"}</script>',
      '</head></html>',
    ].join('\n');
    expect(jsonLdJobPostings(html).map((n) => n.title)).toEqual(['B', 'C']);
    expect(jsonLdBlocks(html).malformed).toBe(1);
    expect(findJobPosting(jsonLdBlocks(html).blocks)?.title).toBe('B');
  });

  it('is linear on 1 MB adversarial pages (< 100 ms each)', () => {
    expect(time(() => jsonLdJobPostings(rep('<script type="application/ld+json">')))).toBeLessThan(100);
    expect(time(() => jsonLdJobPostings(rep('<script ')))).toBeLessThan(100);
    expect(time(() => jsonLdJobPostings(`<script ${rep('type ')}>x</script>`))).toBeLessThan(100);
    expect(time(() => jsonLdJobPostings(rep('<script type="application/ld+json">{}</script>')))).toBeLessThan(300);
    expect(time(() => jsonLdJobPostings(`<script type="application/ld+json">${rep('[')}</script>`))).toBeLessThan(100);
  });

  it('checks a node with zod and names the first issue; keeps only what the normalizer reads', () => {
    expect(checkJobPosting({ '@type': 'JobPosting', description: 'x' })).toEqual({ ok: false, why: 'title: Invalid input: expected string, received undefined' });
    expect(checkJobPosting({ '@type': 'JobPosting', title: '  ', description: 'x' })).toMatchObject({ ok: false, why: 'title: blank title' });
    expect(checkJobPosting({ ...JOB, jobLocationType: 5 })).toMatchObject({ ok: false, why: expect.stringMatching(/^jobLocationType/) });
    const c = checkJobPosting(JOB);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(keptJobPosting(c.posting)).toEqual({
      '@type': 'JobPosting',
      title: 'Senior Software Engineer',
      description: '<p>Build services.</p>',
      datePosted: '2026-10-01',
      jobLocation: [{ '@type': 'Place', address: { addressLocality: 'Bengaluru', addressCountry: 'IN' } }],
      hiringOrganization: { name: 'Acme' },
    });
  });
});

describe('the sitemap reader (shared with the coverage locator)', () => {
  it('reads locs and tells an index from a urlset', () => {
    expect(sitemapLocs('<urlset><url><loc>https://a.test/jobs/1/x/job</loc></url></urlset>')).toEqual(['https://a.test/jobs/1/x/job']);
    expect(isSitemapIndex('<?xml version="1.0"?><sitemapindex xmlns="x"><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>')).toBe(true);
    expect(isSitemapIndex('<urlset><url><loc>x</loc></url></urlset>')).toBe(false);
  });
});

describe('slugTitle', () => {
  it('reads a title from a URL slug; none when the slug has no word', () => {
    expect(slugTitle('senior-backend-software-engineer')).toBe('senior backend software engineer');
    expect(slugTitle('smb%2b-account-executive')).toBe('smb+ account executive');
    expect(slugTitle('principal-software-engineer-7781674')).toBe('principal software engineer 7781674');
    expect(slugTitle('Track-Manager-Jenkins%2CWindows-PowerShell')).toBe('Track Manager Jenkins,Windows PowerShell');
    expect(slugTitle('12345')).toBeNull();
    expect(slugTitle('%zz')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The incremental crawl
// ---------------------------------------------------------------------------

const job = (n: string): ListedJob => ({ url: `https://jobs.acme.test/jobs/${n}`, title: null, sourceId: n, fetchUrl: `https://jobs.acme.test/jobs/${n}` });
const rec = (fetchedOn: string): PageRecord => ({ fetchedOn, hash: 'h', raw: { url: 'x', title: 't', jsonLd: null } });

describe('planPages: the fair daily rotation', () => {
  it('never-fetched pages first in sitemap order, then stale ones oldest first (ties by URL); fresh ones are kept', () => {
    const jobs = ['u3', 'u1', 'u5', 'u2', 'u4', 'u6'].map(job);
    const records = new Map<string, PageRecord>([
      [job('u1').url, rec('2026-10-01')],
      [job('u2').url, rec('2026-10-10')],
      [job('u4').url, rec('2026-09-30')],
      [job('u6').url, rec('2026-09-30')],
    ]);
    const p = planPages(jobs, records, '2026-10-14', 4);
    expect(p.fetch.map((j) => j.sourceId)).toEqual(['u3', 'u5', 'u4', 'u6']);
    expect(p.keep.map((j) => j.sourceId).sort()).toEqual(['u1', 'u2']);
    expect(p).toMatchObject({ queuedNew: 0, queuedStale: 1 });
    const q = planPages(jobs, records, '2026-10-14', 1);
    expect(q.fetch.map((j) => j.sourceId)).toEqual(['u3']);
    expect(q).toMatchObject({ queuedNew: 1, queuedStale: 3 });
  });

  it(`a page fetched ${PAGE_STALE_DAYS} days ago is still fresh; one day more is stale`, () => {
    const jobs = [job('a'), job('b')];
    const records = new Map([
      [job('a').url, rec('2026-10-07')],
      [job('b').url, rec('2026-10-06')],
    ]);
    expect(planPages(jobs, records, '2026-10-14', 40).fetch.map((j) => j.sourceId)).toEqual(['b']);
    expect(PAGE_MAX_FETCHES).toBe(40);
  });
});

const T = { title: 'Senior Software Engineer', description: '<p>Build services.</p>' };
const page = (o: Record<string, unknown>): string => `<html><body><h1>job</h1>${ld({ '@type': 'JobPosting', ...o })}</body></html>`;
const resp = (status: number, body = '', headers: Record<string, string> = {}) => ({ status, text: async () => body, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } });

const probe = defineContract({
  id: 'probe-pages',
  version: '1.0.0',
  description: 'Reads job pages for the shared crawl tests',
  skills: ['testing'],
  team: 'demo',
  kind: 'io',
  consumes: DiscoveryRequest,
  produces: RawPostingType,
  capabilities: { http: true },
  egress: ['jobs.acme.test', 'other.test'],
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 600_000,
});

function harness(routes: Record<string, () => { status: number; text: () => Promise<string>; headers?: { get(n: string): string | null } }>) {
  const calls: string[] = [];
  let now = Date.parse('2026-10-14T01:30:00Z');
  const clock = { now: () => new Date(now).toISOString() };
  const slept: number[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const r = routes[url];
    return r === undefined ? resp(404, 'nf') : r();
  };
  const hostPacer = createHostPacer(PRODUCT_POLICY_V1.minHostIntervalMs, clock, async (ms) => {
    slept.push(ms);
    now += ms;
  });
  const skipped: string[] = [];
  const base = issueContext({ contract: probe, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock, signal: new AbortController().signal, hostPacer });
  const ctx = { ...base, skipped: (notes: readonly string[]) => void skipped.push(...notes) } as AgentContext;
  return { ctx, calls, slept, skipped, hosts: dailyPlatformHosts<never>({ minIntervalMs: 2000 }) };
}

const crawl = (h: ReturnType<typeof harness>, jobs: readonly ListedJob[], state = memoryPageState(), runDate = '2026-10-14', max = 2): Promise<RawPosting[]> =>
  readJobPages({ http: h.ctx.http!, hosts: h.hosts as PlatformHosts, ctx: h.ctx, company: 'Acme', board: 'icims jobs.acme.test', runDate, jobs, listed: new Set(jobs.map((j) => j.url)), state, max, source: 'icims', slug: 'jobs.acme.test', follow: (u) => u.hostname === 'jobs.acme.test' });

describe('readJobPages: budget, rotation and keep-alive', () => {
  const ROBOTS = 'https://jobs.acme.test/robots.txt';
  const routes = (extra: Record<string, () => ReturnType<typeof resp>> = {}) => ({
    [ROBOTS]: () => resp(200, 'User-agent: *\nDisallow: /jobs/blocked\n'),
    [job('a').url]: () => resp(200, page({ ...T, title: 'A' })),
    [job('b').url]: () => resp(200, page({ ...T, title: 'B' })),
    [job('c').url]: () => resp(200, page({ ...T, title: 'C' })),
    ...extra,
  });

  it('fetches at most the budget, queues the rest by name, and a second run reads only what it has not read', async () => {
    const state = memoryPageState();
    const jobs = [job('a'), job('b'), job('c')];
    const h1 = harness(routes());
    const first = await crawl(h1, jobs, state);
    expect(first.map((p) => (p.raw as { title: string }).title)).toEqual(['A', 'B']);
    expect(h1.calls).toEqual([ROBOTS, job('a').url, job('b').url]);
    expect(h1.skipped).toEqual(['page-budget Acme: 1 job pages queued (1 never fetched, 0 stale kept from their last fetch)']);
    expect(h1.slept.every((ms) => ms >= 2000)).toBe(true);

    const h2 = harness(routes());
    const second = await crawl(h2, jobs, state);
    expect(h2.calls).toEqual([ROBOTS, job('c').url]);
    expect(second.map((p) => (p.raw as { title: string }).title).sort()).toEqual(['A', 'B', 'C']);
    // a kept posting is the very posting first emitted (so every later step replays)
    expect(second.find((p) => p.sourceId === 'a')).toEqual(first.find((p) => p.sourceId === 'a'));
    expect(h2.skipped).toEqual([]);
  });

  it('a listing that drops a job drops its kept posting and its record', async () => {
    const state = memoryPageState();
    await crawl(harness(routes()), [job('a'), job('b')], state);
    const h = harness(routes());
    const out = await crawl(h, [job('b')], state);
    expect(out.map((p) => p.sourceId)).toEqual(['b']);
    expect([...state.records('icims jobs.acme.test').keys()]).toEqual([job('b').url]);
  });

  it('a gone page (404/410) is dropped with a named note; a robots-disallowed page is skipped by name, never fetched', async () => {
    const h = harness(routes({ [job('a').url]: () => resp(410, 'gone') }));
    const out = await crawl(h, [job('a'), job('blocked'), job('b')], memoryPageState(), '2026-10-14', 40);
    expect(out.map((p) => p.sourceId)).toEqual(['b']);
    expect(h.calls).not.toContain(job('blocked').url);
    expect(h.skipped).toEqual([
      'detail-gone Acme: 1 job gone between list and detail (a)',
      'robots-disallow jobs.acme.test: 1 job pages of Acme not read (robots-disallow /jobs/blocked)',
    ]);
  });

  it('a gone page a stale listing still names is not fetched again within the week (live: 11 of Okta\'s sitemap URLs answered 404)', async () => {
    const state = memoryPageState();
    await crawl(harness(routes({ [job('a').url]: () => resp(404, 'nf') })), [job('a')], state);
    const h = harness(routes());
    expect(await crawl(h, [job('a')], state)).toEqual([]);
    expect(h.calls).toEqual([]);
    const later = harness(routes());
    expect((await crawl(later, [job('a')], state, '2026-10-22')).map((p) => p.sourceId)).toEqual(['a']);
  });

  it('a page without a valid JobPosting is named (with the zod issue) and not fetched again within the week', async () => {
    const state = memoryPageState();
    const h = harness(routes({ [job('a').url]: () => resp(200, '<html>no ld</html>'), [job('b').url]: () => resp(200, page({ description: 'x' })) }));
    expect(await crawl(h, [job('a'), job('b')], state)).toEqual([]);
    expect(h.skipped).toEqual(['no-jobposting Acme: 2 job pages without a valid JobPosting (a: no JobPosting JSON-LD; b: title: Invalid input: expected string, received undefined)']);
    const h2 = harness(routes());
    await crawl(h2, [job('a'), job('b')], state);
    // nothing to fetch: not even robots.txt is asked
    expect(h2.calls).toEqual([]);
  });

  it(`follows at most ${PAGE_MAX_HOPS} redirects on the board's host; one leaving it is named, never followed`, async () => {
    const h = harness(
      routes({
        [job('a').url]: () => resp(302, '', { location: '/jobs/a-en_US/' }),
        'https://jobs.acme.test/jobs/a-en_US/': () => resp(200, page({ ...T, title: 'A' })),
        [job('b').url]: () => resp(301, '', { location: 'https://other.test/x' }),
      }),
    );
    const out = await crawl(h, [job('a'), job('b')]);
    expect(out.map((p) => [p.sourceId, (p.raw as { url: string }).url])).toEqual([['a', job('a').url]]);
    expect(h.calls).not.toContain('https://other.test/x');
    expect(h.skipped).toEqual(['page-moved Acme: 1 job pages redirected off the board (b to other.test)']);
  });

  it('a 403 disables the host (HostRefused), a 429 disables it (rate_limit), a challenge disables it (challenged); never retried around', async () => {
    const h403 = harness(routes({ [job('a').url]: () => resp(403, 'denied') }));
    await expect(crawl(h403, [job('a'), job('b')])).rejects.toBeInstanceOf(HostRefused);
    expect(h403.hosts.disabledWhy('jobs.acme.test')).toBe('http-403');
    const h429 = harness(routes({ [job('a').url]: () => resp(429, 'slow down', { 'retry-after': '600' }) }));
    await expect(crawl(h429, [job('a'), job('b')])).rejects.toMatchObject({ code: 'rate_limit' });
    expect(h429.hosts.disabledWhy('jobs.acme.test')).toBe('http-429');
    expect(h429.calls).toEqual([ROBOTS, job('a').url]);
    expect(h429.slept.every((ms) => ms < 600_000)).toBe(true);
    const hc = harness(routes({ [job('a').url]: () => resp(503, '<title>Just a moment...</title>') }));
    await expect(crawl(hc, [job('a')])).rejects.toMatchObject({ code: 'challenged' });
    expect(hc.hosts.disabledWhy('jobs.acme.test')).toBe('challenge');
    const hs = harness(routes({ [job('a').url]: () => resp(200, '<html><title>Just a moment...</title>cf-chl</html>') }));
    await expect(crawl(hs, [job('a')])).rejects.toMatchObject({ code: 'challenged' });
    // a sibling on the disabled host is never asked
    await expect(crawl(h403, [job('c')])).rejects.toBeInstanceOf(HostDisabled);
  });

  it('a 5xx is a transport failure (overloaded: the contract retries), the host stays enabled', async () => {
    const h = harness(routes({ [job('a').url]: () => resp(502, 'bad gateway') }));
    await expect(crawl(h, [job('a')])).rejects.toMatchObject({ code: 'overloaded' });
    expect(h.hosts.disabledWhy('jobs.acme.test')).toBeUndefined();
  });

  it('the strict robots rule: a 401/403 robots.txt refuses (robots-forbidden), a 5xx or other 4xx too (robots-unavailable), a 404 allows all', async () => {
    for (const [status, reason] of [
      [403, 'robots-forbidden'],
      [401, 'robots-forbidden'],
      [500, 'robots-unavailable'],
      [418, 'robots-unavailable'],
      [302, 'robots-unavailable'],
    ] as const) {
      const h = harness(routes({ [ROBOTS]: () => resp(status, 'x') }));
      const answer = getRuledPage(h.ctx.http!, h.hosts as PlatformHosts, job('a').url, { follow: () => true });
      await expect(answer).rejects.toBeInstanceOf(RobotsDenied);
      await expect(answer).rejects.toMatchObject({ reason: reason });
      expect(h.calls).toEqual([ROBOTS]);
    }
    const ok = harness(routes({ [ROBOTS]: () => resp(404, 'nf') }));
    await expect(getRuledPage(ok.ctx.http!, ok.hosts as PlatformHosts, job('a').url, { follow: () => true })).resolves.toMatchObject({ kind: 'ok' });
  });
});

describe('appPageState: the page state in the app DB (migration 11, platform_pages)', () => {
  it('round-trips records per board, forgets and retains; nothing written until a page adapter runs', async () => {
    const { AppStore } = await import('../../src/app/store/app-store.js');
    const { Store } = await import('../../src/kernel/store/store.js');
    const { appPageState } = await import('../../src/app/daily-hosts.js');
    const app = AppStore.on(Store.open(':memory:'));
    expect(app.kernel.db.prepare(`SELECT COUNT(*) AS n FROM platform_pages`).get()).toEqual({ n: 0 });
    const s = appPageState(app);
    const raw = { url: 'https://a.test/jobs/1', title: 'Engineer', jsonLd: { '@type': 'JobPosting', title: 'Engineer', description: 'x' } };
    s.put('icims a.test', 'https://a.test/jobs/1', { fetchedOn: '2026-10-14', hash: 'h1', raw });
    s.put('icims a.test', 'https://a.test/jobs/2', { fetchedOn: '2026-10-13', hash: 'h2', raw: null });
    s.put('icims b.test', 'https://b.test/jobs/1', { fetchedOn: '2026-10-14', hash: 'h3', raw: null });
    expect([...s.records('icims a.test').entries()]).toEqual([
      ['https://a.test/jobs/1', { fetchedOn: '2026-10-14', hash: 'h1', raw }],
      ['https://a.test/jobs/2', { fetchedOn: '2026-10-13', hash: 'h2', raw: null }],
    ]);
    s.put('icims a.test', 'https://a.test/jobs/2', { fetchedOn: '2026-10-14', hash: 'h2b', raw: null });
    expect(s.records('icims a.test').get('https://a.test/jobs/2')?.hash).toBe('h2b');
    s.retain('icims a.test', new Set(['https://a.test/jobs/2']));
    expect([...s.records('icims a.test').keys()]).toEqual(['https://a.test/jobs/2']);
    s.forget('icims a.test', 'https://a.test/jobs/2');
    expect(s.records('icims a.test').size).toBe(0);
    // another board is untouched
    expect(s.records('icims b.test').size).toBe(1);
  });
});
