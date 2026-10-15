import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalize } from '../../src/app/agents/normalizer.js';
import { platformClient } from '../../src/app/agents/sources/platforms/client.js';
import { FRESHTEAM_EGRESS, freshteam, freshteamBoardOfUrl, freshteamListingUrl, parseFreshteamListing, parseFreshteamRef } from '../../src/app/agents/sources/platforms/freshteam.js';
import { anchorText, JAZZHR_EGRESS, jazzhr, jazzhrBoardOfUrl, parseJazzhrListing, parseJazzhrRef } from '../../src/app/agents/sources/platforms/jazzhr.js';
import { LISTING_MAX_BYTES, LISTING_MAX_PAGES, scopeListed, type ScopedJob } from '../../src/app/agents/sources/platforms/listing-pages.js';
import { dailyPageHosts } from '../../src/app/daily-hosts.js';
import { dailyAgents, dailyPipeline, registryBoards, registryEgressSets } from '../../src/app/pipeline.js';
import { Posting, type DiscoveryRequest, type RawPosting } from '../../src/app/types.js';
import type { AgentContext } from '../../src/kernel/agent.js';
import { createHostPacer, issueContext } from '../../src/kernel/broker.js';
import type { AnyContract } from '../../src/kernel/contract.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import type { FetchLike } from '../../src/kernel/providers.js';

/**
 * Sources expansion, Task 2: the JazzHR and Freshteam adapters (an HTML listing, a listing-level India/remote scope,
 * JSON-LD job pages) and their verifier clients. The listings are the 2026-10-15 recordings trimmed to the job cards
 * (JazzHR's second card carries a Pune location, set by hand); the job pages are small hand-written JSON-LD pages on the
 * real shape, with a fictional company.
 */

const root = join(import.meta.dirname, '../..');
const fx = (name: string): string => readFileSync(join(root, 'tests/fixtures/sx', name), 'utf8');

const PACK_ALL_TITLES = { filters: { roleDeny: [] }, targets: { titles: [] }, eligibility: { officeCities: [] } };

type Route = { status: number; body?: string; headers?: Record<string, string> };

function harness(egress: string, host: string, routes: Record<string, Route>, pack: unknown, contract: AnyContract) {
  const calls: string[] = [];
  let now = Date.parse('2026-10-15T01:30:00Z');
  const clock = { now: () => new Date(now).toISOString() };
  const slept: number[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const r = routes[url] ?? { status: 404, body: 'not found' };
    return { status: r.status, text: async () => r.body ?? '', headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null } };
  };
  const hostPacer = createHostPacer(PRODUCT_POLICY_V1.minHostIntervalMs, clock, async (ms) => {
    slept.push(ms);
    now += ms;
  });
  const skipped: string[] = [];
  const base = issueContext({ contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock, signal: new AbortController().signal, egressSets: { [egress]: [host] }, pack, hostPacer });
  const ctx = { ...base, skipped: (n: readonly string[]) => void skipped.push(...n) } as AgentContext;
  return { ctx, calls, slept, skipped };
}
const req = (ats: DiscoveryRequest['ats'], slug: string, company = 'Acme', runDate = '2026-10-15'): DiscoveryRequest => ({ ats, slug, company, runDate });
const valid = (raw: RawPosting) => {
  const p = normalize(raw);
  expect(Posting.schema.safeParse(p).success).toBe(true);
  return p;
};

const JZ = 'baxterplanning.applytojob.com';
const JZ_REMOTE = `https://${JZ}/apply/LuHTxCmJVv/Business-Development-Representative`;
const JZ_PUNE = `https://${JZ}/apply/Mn2qS5X8cV/Director-Of-Quality`;
const jzRoutes = (extra: Record<string, Route> = {}): Record<string, Route> => ({
  [`https://${JZ}/robots.txt`]: { status: 200, body: fx('jazzhr/robots.txt') },
  [`https://${JZ}/apply`]: { status: 200, body: fx('jazzhr/listing.html') },
  [JZ_REMOTE]: { status: 200, body: fx('jazzhr/job-remote.html') },
  [JZ_PUNE]: { status: 200, body: fx('jazzhr/job-pune.html') },
  ...extra,
});
const jzHarness = (routes: Record<string, Route>, host = JZ) => harness(JAZZHR_EGRESS, host, routes, PACK_ALL_TITLES, jazzhr.contract);

describe('JazzHR listing', () => {
  it('parses every card: token, title, location, absolute URL', () => {
    const l = parseJazzhrListing(fx('jazzhr/listing.html'), 'baxterplanning');
    expect(l.next).toBe(false);
    expect(l.jobs.map((j) => [j.sourceId, j.title, j.location])).toEqual([
      ['LuHTxCmJVv', 'Business Development Representative', 'Remote'],
      ['Mn2qS5X8cV', 'Director of Quality', 'Pune, India'],
    ]);
    expect(l.jobs[0]?.url).toBe('https://baxterplanning.applytojob.com/apply/LuHTxCmJVv/Business-Development-Representative');
    expect(l.jobs[0]?.fetchUrl).toBe(l.jobs[0]?.url);
  });

  it('ignores anchors to other hosts or other paths', () => {
    const html = '<li class="list-group-item"><a href="https://evil.example/apply/AAAAAAAA/x">x</a></li><li class="list-group-item"><a href="/apply/jobs">all</a></li>';
    expect(parseJazzhrListing(html, 'acme').jobs).toEqual([]);
  });

  it('reads a relative job link, and a card without a location as null', () => {
    const html = '<li class="list-group-item"><h3><a href="/apply/AbCdEf1234/Staff-Engineer">Staff &amp; Lead\n  Engineer</a></h3></li>';
    expect(parseJazzhrListing(html, 'acme').jobs).toEqual([
      { url: 'https://acme.applytojob.com/apply/AbCdEf1234/Staff-Engineer', fetchUrl: 'https://acme.applytojob.com/apply/AbCdEf1234/Staff-Engineer', sourceId: 'AbCdEf1234', title: 'Staff & Lead Engineer', location: null, remote: null },
    ]);
    expect(anchorText('<a href="/x">  </a><a href="/y">Y</a>', '/x')).toBeNull();
    expect(anchorText('<a href="/x">X</a>', '/missing')).toBeNull();
  });

  it('is linear on a 2 MB adversarial page (no backtracking)', () => {
    const html = '<li class="list-group-item">' + '<a href="/apply/'.repeat(100_000);
    const t0 = performance.now();
    parseJazzhrListing(html, 'acme');
    expect(performance.now() - t0).toBeLessThan(500);
    const many = '<li class="list-group-item"><a href="/apply/AbCdEf1234/x">t</a>'.repeat(20_000);
    const t1 = performance.now();
    expect(parseJazzhrListing(many, 'acme').jobs).toHaveLength(20_000);
    expect(performance.now() - t1).toBeLessThan(1500);
  });

  it('refs: a tenant label; a stored board URL on that host', () => {
    expect(parseJazzhrRef('baxterplanning')).toBe('baxterplanning');
    expect(parseJazzhrRef('www')).toBeNull();
    expect(parseJazzhrRef('a.b')).toBeNull();
    expect(jazzhrBoardOfUrl(`https://${JZ}/apply`)).toBe('baxterplanning');
    expect(jazzhrBoardOfUrl('https://www.applytojob.com/apply')).toBeNull();
    expect(jazzhrBoardOfUrl('https://acme.example/apply')).toBeNull();
    expect(jazzhrBoardOfUrl('http://acme.applytojob.com/apply')).toBeNull();
  });
});

describe('Freshteam listing', () => {
  it('parses cards: id, title, location (entities decoded), remote flag, and the next link', () => {
    const l = parseFreshteamListing(fx('freshteam/listing.html'), 'acme', 1);
    expect(l.next).toBe(true);
    expect(l.jobs.map((j) => [j.sourceId, j.title, j.location, j.remote])).toEqual([
      ['5tkrOTL3Ap8y', 'Software Engineer (Backend)', 'Pune, India', false],
      ['owvrsM53ohRL', 'Senior Engineer & Platform', 'Bengaluru, India', false],
      ['Ab12Cd34Ef56', 'Staff Engineer', 'Austin, TX', false],
    ]);
    expect(l.jobs[0]?.url).toBe('https://acme.freshteam.com/jobs/5tkrOTL3Ap8y/software-engineer-backend');
    const p2 = parseFreshteamListing(fx('freshteam/listing-page2.html'), 'acme', 2);
    expect(p2.next).toBe(false);
    expect(p2.jobs.map((j) => [j.sourceId, j.remote])).toEqual([['owvrsM53ohRL', false], ['-j3B-P8yuEdJ', true]]);
  });

  it('refs and URLs', () => {
    expect(parseFreshteamRef('acme')).toBe('acme');
    expect(parseFreshteamRef('assets')).toBeNull();
    expect(freshteamListingUrl('acme', 1)).toBe('https://acme.freshteam.com/jobs');
    expect(freshteamListingUrl('acme', 3)).toBe('https://acme.freshteam.com/jobs?page=3');
    expect(freshteamBoardOfUrl('https://acme.freshteam.com/jobs')).toBe('acme');
    expect(freshteamBoardOfUrl('https://cdn.freshteam.com/jobs')).toBeNull();
    expect(freshteamBoardOfUrl('https://acme.example/jobs')).toBeNull();
  });

  it('ignores job links of another host or a wrong id, and is linear on an adversarial page', () => {
    const html = '<a href="https://evil.example/jobs/AbCdEf123456/x">x</a><a href="/jobs/short/x">y</a><a href="/jobs/AbCdEf123456/">z</a>';
    expect(parseFreshteamListing(html, 'acme').jobs).toEqual([]);
    const t0 = performance.now();
    parseFreshteamListing('<a href="/jobs/AbCdEf123456/x" data-portal-location="'.repeat(60_000), 'acme');
    parseFreshteamListing('<a '.repeat(500_000), 'acme');
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('scopeListed', () => {
  const job = (id: string, location: string | null, remote: boolean | null = null): ScopedJob => ({ url: `https://a.example/${id}`, fetchUrl: `https://a.example/${id}`, sourceId: id, title: 'Engineer', location, remote });
  it('keeps India, office, remote and unknown; counts the rest in one note', () => {
    const skipped: string[] = [];
    const ctx = { skipped: (n: readonly string[]) => void skipped.push(...n) } as unknown as AgentContext;
    const kept = scopeListed([job('a', 'Pune, India'), job('b', 'Austin, TX'), job('c', 'Remote'), job('d', null), job('e', 'Barcelona'), job('f', 'Chennai', true)], [], 'Acme', ctx);
    expect(kept.map((j) => j.sourceId)).toEqual(['a', 'c', 'd', 'f']);
    expect(skipped).toEqual(['not-india Acme: 2 of 6 listed jobs outside India and not remote (not fetched)']);
  });
  it('keeps a pack office city, makes no note when nothing is left out', () => {
    const skipped: string[] = [];
    const ctx = { skipped: (n: readonly string[]) => void skipped.push(...n) } as unknown as AgentContext;
    expect(scopeListed([job('a', 'Bengaluru'), job('b', 'Work from home')], ['bengaluru'], 'Acme', ctx).map((j) => j.sourceId)).toEqual(['a', 'b']);
    expect(skipped).toEqual([]);
  });
});

describe('src-jazzhr', () => {
  it('robots.txt first, then the listing, then only in-scope title-passing job pages, 2 s apart', async () => {
    const h = jzHarness(jzRoutes());
    const out = await jazzhr.make({ hosts: dailyPageHosts() }).run(req('jazzhr', 'baxterplanning'), h.ctx);
    expect(h.calls[0]).toBe(`https://${JZ}/robots.txt`);
    expect(h.calls[1]).toBe(`https://${JZ}/apply`);
    expect(h.calls).toHaveLength(4);
    const posted = out as RawPosting[];
    expect(posted.map((p) => p.sourceId)).toEqual(['LuHTxCmJVv', 'Mn2qS5X8cV']);
    expect(Math.min(...h.slept.filter((s) => s > 0))).toBeGreaterThanOrEqual(2000 - 500);
    for (const p of posted) valid(p);
    expect(valid(posted[0] as RawPosting)).toMatchObject({ ats: 'jazzhr', source: 'jazzhr', title: 'Business Development Representative', url: JZ_REMOTE });
    expect(valid(posted[0] as RawPosting).remote.structured).toBe('remote');
  });

  it('a listing job outside India and not remote is not fetched: one named note', async () => {
    const listing = fx('jazzhr/listing.html').replace('Pune, India', 'Austin, TX');
    const h = jzHarness(jzRoutes({ [`https://${JZ}/apply`]: { status: 200, body: listing } }));
    const out = (await jazzhr.make({ hosts: dailyPageHosts() }).run(req('jazzhr', 'baxterplanning'), h.ctx)) as RawPosting[];
    expect(out.map((p) => p.sourceId)).toEqual(['LuHTxCmJVv']);
    expect(h.calls).not.toContain(JZ_PUNE);
    expect(h.skipped).toEqual(['not-india Acme: 1 of 2 listed jobs outside India and not remote (not fetched)']);
  });

  it('the pack\'s title rules pre-filter the listing before any page is asked', async () => {
    const pack = { ...PACK_ALL_TITLES, targets: { titles: ['director quality'] } };
    const h = harness(JAZZHR_EGRESS, JZ, jzRoutes(), pack, jazzhr.contract);
    const out = (await jazzhr.make({ hosts: dailyPageHosts() }).run(req('jazzhr', 'baxterplanning'), h.ctx)) as RawPosting[];
    expect(out.map((p) => p.sourceId)).toEqual(['Mn2qS5X8cV']);
    expect(h.calls).not.toContain(JZ_REMOTE);
    expect(h.skipped).toContainEqual('title-prefilter Acme: 1 of 2 listed jobs not fetched (the title pre-filter)');
  });

  it('a robots disallow of /apply is a named skip, no listing request', async () => {
    const h = jzHarness(jzRoutes({ [`https://${JZ}/robots.txt`]: { status: 200, body: 'User-agent: *\nDisallow: /apply\n' } }));
    const out = await jazzhr.make({ hosts: dailyPageHosts() }).run(req('jazzhr', 'baxterplanning'), h.ctx);
    expect(out).toEqual([]);
    expect(h.calls).toEqual([`https://${JZ}/robots.txt`]);
    expect(h.skipped).toEqual([expect.stringMatching(new RegExp(`^robots-disallow ${JZ.replaceAll('.', '\\.')}: Acme not read today \\(`, 'u'))]);
  });

  it('403 on the listing disables the host: challenged, never retried; a second company on that host is deferred', async () => {
    const hosts = dailyPageHosts();
    const h = jzHarness(jzRoutes({ 'https://acme.applytojob.com/robots.txt': { status: 200, body: fx('jazzhr/robots.txt') }, 'https://acme.applytojob.com/apply': { status: 403, body: 'Forbidden' } }), 'acme.applytojob.com');
    const agent = jazzhr.make({ hosts });
    await expect(agent.run(req('jazzhr', 'acme'), h.ctx)).rejects.toMatchObject({ code: 'challenged' });
    expect(hosts.disabledWhy('acme.applytojob.com')).toBe('http-403');
    const before = h.calls.length;
    await expect(agent.run(req('jazzhr', 'acme', 'Acme Two'), h.ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringContaining('host-disabled:http-403 on acme.applytojob.com') });
    expect(h.calls.length).toBe(before);
  });

  it('a challenge page (cf-chl) on the listing is challenged', async () => {
    const hosts = dailyPageHosts();
    const h = jzHarness(jzRoutes({ [`https://${JZ}/apply`]: { status: 200, body: '<html><head><title>Just a moment...</title></head><body>cf-chl-bypass</body></html>' } }));
    await expect(jazzhr.make({ hosts }).run(req('jazzhr', 'baxterplanning'), h.ctx)).rejects.toMatchObject({ code: 'challenged' });
    expect(hosts.disabledWhy(JZ)).toBe('challenge');
    expect(h.calls).toEqual([`https://${JZ}/robots.txt`, `https://${JZ}/apply`]);
  });

  it('a listing over LISTING_MAX_BYTES is input_rejected, never parsed', async () => {
    const big = fx('jazzhr/listing.html') + ' '.repeat(LISTING_MAX_BYTES);
    const h = jzHarness(jzRoutes({ [`https://${JZ}/apply`]: { status: 200, body: big } }));
    await expect(jazzhr.make({ hosts: dailyPageHosts() }).run(req('jazzhr', 'baxterplanning'), h.ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringContaining('larger than') });
    expect(h.calls).toEqual([`https://${JZ}/robots.txt`, `https://${JZ}/apply`]);
  });

  it('a missing board (404 on the listing) is gone; a redirect off the host is input_rejected', async () => {
    const gone = jzHarness(jzRoutes({ [`https://${JZ}/apply`]: { status: 404, body: 'nf' } }));
    await expect(jazzhr.make({ hosts: dailyPageHosts() }).run(req('jazzhr', 'baxterplanning'), gone.ctx)).rejects.toMatchObject({ code: 'gone' });
    const moved = jzHarness(jzRoutes({ [`https://${JZ}/apply`]: { status: 302, headers: { location: 'https://elsewhere.example/apply' } } }));
    await expect(jazzhr.make({ hosts: dailyPageHosts() }).run(req('jazzhr', 'baxterplanning'), moved.ctx)).rejects.toMatchObject({ code: 'input_rejected' });
  });

  it('a job page without a JobPosting is named (no-jobposting) and not emitted; a gone page is detail-gone', async () => {
    const h = jzHarness(jzRoutes({ [JZ_REMOTE]: { status: 200, body: '<html><body>nothing</body></html>' }, [JZ_PUNE]: { status: 404, body: 'gone' } }));
    const out = await jazzhr.make({ hosts: dailyPageHosts() }).run(req('jazzhr', 'baxterplanning'), h.ctx);
    expect(out).toEqual([]);
    expect(h.skipped.some((n) => n.startsWith('no-jobposting Acme: 1 job pages'))).toBe(true);
    expect(h.skipped.some((n) => n.startsWith('detail-gone Acme'))).toBe(true);
  });

  it('only a jazzhr request is served, and only a jazzhr slug', async () => {
    const h = jzHarness(jzRoutes());
    const agent = jazzhr.make({ hosts: dailyPageHosts() });
    expect(await agent.run(req('freshteam', 'acme'), h.ctx)).toEqual([]);
    await expect(agent.run(req('jazzhr', 'www'), h.ctx)).rejects.toMatchObject({ code: 'invalid_output' });
    expect(h.calls).toEqual([]);
  });
});

const FT = 'acme.freshteam.com';
const FT_JOB = 'https://acme.freshteam.com/jobs/5tkrOTL3Ap8y/software-engineer-backend';
const FT_JOB2 = 'https://acme.freshteam.com/jobs/owvrsM53ohRL/senior-engineer-platform';
const FT_JOB3 = 'https://acme.freshteam.com/jobs/-j3B-P8yuEdJ/lead-engineer-remote';
const ftRoutes = (extra: Record<string, Route> = {}): Record<string, Route> => ({
  [`https://${FT}/robots.txt`]: { status: 200, body: fx('freshteam/robots.txt') },
  [freshteamListingUrl('acme', 1)]: { status: 200, body: fx('freshteam/listing.html') },
  [freshteamListingUrl('acme', 2)]: { status: 200, body: fx('freshteam/listing-page2.html') },
  [FT_JOB]: { status: 200, body: fx('freshteam/job.html') },
  [FT_JOB2]: { status: 200, body: fx('freshteam/job.html') },
  [FT_JOB3]: { status: 200, body: fx('freshteam/job.html') },
  ...extra,
});
const ftHarness = (routes: Record<string, Route>) => harness(FRESHTEAM_EGRESS, FT, routes, PACK_ALL_TITLES, freshteam.contract);

describe('src-freshteam', () => {
  it('reads page 2 when page 1 links it, stops at a page with no next, dedupes ids, scopes the listing', async () => {
    const h = ftHarness(ftRoutes());
    const out = (await freshteam.make({ hosts: dailyPageHosts() }).run(req('freshteam', 'acme'), h.ctx)) as RawPosting[];
    expect(h.calls.slice(0, 3)).toEqual([`https://${FT}/robots.txt`, freshteamListingUrl('acme', 1), freshteamListingUrl('acme', 2)]);
    // 4 distinct ids; the Austin job is outside India and not remote
    expect(h.skipped).toContainEqual('not-india Acme: 1 of 4 listed jobs outside India and not remote (not fetched)');
    expect(h.calls.slice(3)).toEqual([FT_JOB, FT_JOB2, FT_JOB3]);
    expect(out.map((p) => p.sourceId).sort()).toEqual(['-j3B-P8yuEdJ', '5tkrOTL3Ap8y', 'owvrsM53ohRL']);
    expect(h.slept.filter((s) => s > 0).every((s) => s >= 1500)).toBe(true);
  });

  it('stops at a page that adds no new id, even if it links a next page', async () => {
    const same = fx('freshteam/listing.html');
    const h = ftHarness(ftRoutes({ [freshteamListingUrl('acme', 2)]: { status: 200, body: same.replace('page=2', 'page=3') } }));
    // page 2 here repeats page 1's ids and links page 3: not read
    await freshteam.make({ hosts: dailyPageHosts() }).run(req('freshteam', 'acme'), h.ctx);
    expect(h.calls).not.toContain(freshteamListingUrl('acme', 3));
  });

  it('a listing still linking a next page after LISTING_MAX_PAGES is input_rejected listing-cap', async () => {
    const page = (n: number) => `<a href="/jobs/${String(n).padStart(12, 'x')}/role-${n}" data-portal-location="Remote" data-portal-remote-location=true><div class="job-title">Engineer ${n}</div></a><a href="/jobs?page=${n + 1}">next</a>`;
    const routes: Record<string, Route> = { 'https://acme.freshteam.com/robots.txt': { status: 200, body: fx('freshteam/robots.txt') } };
    for (let n = 1; n <= LISTING_MAX_PAGES; n++) routes[freshteamListingUrl('acme', n)] = { status: 200, body: page(n) };
    const h = ftHarness(routes);
    await expect(freshteam.make({ hosts: dailyPageHosts() }).run(req('freshteam', 'acme'), h.ctx)).rejects.toMatchObject({
      code: 'input_rejected',
      message: expect.stringMatching(/^listing-cap Freshteam acme: still more pages after 5; nothing read, never truncated/u),
    });
    expect(h.calls.filter((u) => u.includes('/jobs/') && !u.includes('?page'))).toEqual([]);
  });

  it('maps "remote": "true" to a remote posting, for Freshteam only', () => {
    const jsonLd = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/su.exec(fx('freshteam/job.html'))?.[1] ?? '{}') as Record<string, unknown>;
    expect(jsonLd.remote).toBe('true');
    const raw = (source: string): RawPosting => ({ source, sourceId: 'x', company: 'Acme', slug: 'acme', raw: { url: FT_JOB, title: 'Software Engineer (Backend)', jsonLd } });
    expect(valid(raw('freshteam')).remote.structured).toBe('remote');
    expect(valid(raw('jazzhr')).remote.structured).not.toBe('remote');
  });

  it('a stored page keeps the flag through the crawl (the kept JobPosting carries it)', async () => {
    const h = ftHarness(ftRoutes());
    const out = (await freshteam.make({ hosts: dailyPageHosts() }).run(req('freshteam', 'acme'), h.ctx)) as RawPosting[];
    expect(valid(out.find((p) => p.sourceId === '5tkrOTL3Ap8y') as RawPosting).remote.structured).toBe('remote');
  });
});

describe('verifier clients', () => {
  const hosts = () => dailyPageHosts();
  it('jazzhr: listing then one job page; hiringOrganization names the board', async () => {
    const c = platformClient('jazzhr')!;
    expect(c.refOf('ignored', `https://${JZ}/apply`)).toBe('baxterplanning');
    expect(c.hostOf('baxterplanning')).toBe(JZ);
    expect(c.boardUrl('baxterplanning')).toBe(`https://${JZ}/apply`);
    const h = jzHarness(jzRoutes());
    const read = await c.readBoard('baxterplanning', h.ctx.http!, { hosts: hosts() });
    expect(read).toMatchObject({ boardName: 'Example Planning', boardNames: ['Example Planning'], complete: true, nameKey: null, url: `https://${JZ}/apply` });
    expect(read.jobs).toHaveLength(2);
    expect(h.calls).toEqual([`https://${JZ}/robots.txt`, `https://${JZ}/apply`, JZ_REMOTE]);
  });

  it('freshteam: a board with 0 listed jobs is proposed, no job page fetched', async () => {
    const c = platformClient('freshteam')!;
    const empty = '<html><body><div class="job-list" data-portal-location-filter>No openings</div></body></html>';
    const h = ftHarness(ftRoutes({ [freshteamListingUrl('acme', 1)]: { status: 200, body: empty } }));
    const read = await c.readBoard('acme', h.ctx.http!, { hosts: hosts() });
    expect(read).toMatchObject({ boardName: null, boardNames: [], jobs: [], complete: true });
    expect(h.calls).toEqual([`https://${FT}/robots.txt`, freshteamListingUrl('acme', 1)]);
  });

  it('freshteam: reads every listing page, one job page names the board', async () => {
    const c = platformClient('freshteam')!;
    const h = ftHarness(ftRoutes());
    const read = await c.readBoard('acme', h.ctx.http!, { hosts: hosts() });
    expect(read.jobs).toHaveLength(4);
    expect(read.boardName).toBe('Example Systems');
    expect(h.calls).toEqual([`https://${FT}/robots.txt`, freshteamListingUrl('acme', 1), freshteamListingUrl('acme', 2), FT_JOB]);
  });

  it('a 403 on the listing is a refusal the verifier defers', async () => {
    const c = platformClient('jazzhr')!;
    const h = jzHarness(jzRoutes({ [`https://${JZ}/apply`]: { status: 403, body: 'no' } }));
    await expect(c.readBoard('baxterplanning', h.ctx.http!, { hosts: hosts() })).rejects.toMatchObject({ name: 'BoardRefused' });
  });
});

describe('daily wiring', () => {
  it('no jazzhr/freshteam agent without a registry board of theirs', () => {
    const ids = dailyAgents([], []).map((a) => a.contract.id);
    expect(ids).not.toContain('src-jazzhr');
    expect(ids).not.toContain('src-freshteam');
  });

  it('a verified board wires its agent, team, edge and egress hosts', () => {
    const boards = registryBoards([
      { platform: 'jazzhr', boardUrl: `https://${JZ}/apply`, name: 'Baxter' },
      { platform: 'freshteam', boardUrl: 'https://acme.freshteam.com/jobs', name: 'Acme' },
    ] as never);
    expect(boards.map((b) => [b.platform, b.ref])).toEqual([['jazzhr', 'baxterplanning'], ['freshteam', 'acme']]);
    const agents = dailyAgents([], boards);
    const ids = agents.map((a) => a.contract.id);
    expect(ids).toContain('src-jazzhr');
    expect(ids).toContain('src-freshteam');
    const pipe = dailyPipeline(agents);
    expect(pipe.teams.map((t) => t.id)).toEqual(expect.arrayContaining(['sourcing-jazzhr', 'sourcing-freshteam']));
    expect(pipe.edges).toContainEqual({ type: 'DiscoveryRequest@1', to: 'src-jazzhr' });
    expect(pipe.edges).toContainEqual({ type: 'DiscoveryRequest@1', to: 'src-freshteam' });
    expect(registryEgressSets(boards)).toMatchObject({ [JAZZHR_EGRESS]: [JZ], [FRESHTEAM_EGRESS]: [FT] });
  });
});
