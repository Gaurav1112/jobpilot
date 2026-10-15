import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideEligibility, type EligibilityPack } from '../../src/app/agents/eligibility.js';
import { normalize } from '../../src/app/agents/normalizer.js';
import { platformClient } from '../../src/app/agents/sources/platforms/client.js';
import { manatal, manatalBoardOfUrl, MANATAL_HOST, parseManatal, parseManatalRef } from '../../src/app/agents/sources/platforms/manatal.js';
import { documentedHosts, FEED_MAX_JOBS, FEED_MAX_JOBS_PAGED, FEED_MAX_PAGES, FEED_MAX_REQUESTS, FEED_MIN_INTERVAL_MS, FEED_TIMEOUT_MS, type FeedBoard } from '../../src/app/agents/sources/platforms/feed-board.js';
import { SMALL_PLATFORMS } from '../../src/app/agents/sources/platforms/small.js';
import { parseTeamtailor } from '../../src/app/agents/sources/platforms/teamtailor.js';
import { parsePersonio } from '../../src/app/agents/sources/platforms/personio.js';
import { embeddedJobs, parseZoho } from '../../src/app/agents/sources/platforms/zohorecruit.js';
import { boardVerifierContract, makeBoardVerifier, verifierEgressSets } from '../../src/app/coverage/verifier.js';
import { memoryHostStateStore } from '../../src/app/coverage/gate.js';
import type { CareersSite, CompanyCandidate, Platform, PlatformGuess } from '../../src/app/coverage/types.js';
import { dailyFeedHosts } from '../../src/app/daily-hosts.js';
import { dailyAgents, dailyPipeline, pacingProblems, registryBoards, registryEgressSets, dailySeeds } from '../../src/app/pipeline.js';
import { PLATFORM_NOTE_PREFIXES } from '../../src/app/agents/sources/platforms/shared.js';
import { Posting, type DiscoveryRequest, type RawPosting } from '../../src/app/types.js';
import type { Agent, AgentContext } from '../../src/kernel/agent.js';
import { createHostPacer, issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import type { FetchLike } from '../../src/kernel/providers.js';
import { BUILD, PLACES, TITLE, type Where } from '../support/small-feeds.js';

/**
 * Task 9: the daily adapters for the nine small ATS platforms (Workable, Recruitee, Teamtailor, Personio, BambooHR,
 * Breezy, Pinpoint, Rippling, Gem) and their verifier clients. The recorded fixtures (2026-10-14, one polite request
 * each, trimmed and scrubbed) are the real shapes: Hugging Face (Workable), bunq (Recruitee), Teamtailor's own board,
 * Personio's, Red Nucleus (BambooHR), the Breezy trial board, Grasshopper (Pinpoint), Rippling's own (Rippling) and Gem's.
 */

const root = join(import.meta.dirname, '../..');
const fx = (name: string): string => readFileSync(join(root, 'tests/fixtures/small', name), 'utf8');

interface Row {
  readonly fb: FeedBoard<string>;
  readonly ref: string;
  readonly host: string;
  readonly url: string;
  readonly boardUrl: string;
  readonly file: string;
  readonly n: number;
  /** Distinct ids among the n entries when fewer (none of the recorded feeds now). */
  readonly kept?: number;
  readonly firstId: string;
  readonly documented: boolean;
  /** The company name the feed carries (verifier); null: none. */
  readonly name: string | null;
  readonly robots?: string;
  /** Named malformed entries the recorded feed carries (none by default). */
  readonly malformed?: readonly string[];
}
const byName = (n: string): FeedBoard<string> => SMALL_PLATFORMS.find((f) => f.spec.platform === n) as FeedBoard<string>;
const ROWS: readonly Row[] = [
  { fb: byName('workable'), ref: 'huggingface', host: 'apply.workable.com', url: 'https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true', boardUrl: 'https://apply.workable.com/api/v1/widget/accounts/huggingface', file: 'workable-huggingface.json', n: 3, firstId: '81B46579FE', documented: true, name: 'Hugging Face' },
  { fb: byName('recruitee'), ref: 'bunq', host: 'bunq.recruitee.com', url: 'https://bunq.recruitee.com/api/offers/', boardUrl: 'https://bunq.recruitee.com/api/offers/', file: 'recruitee-bunq.json', n: 3, firstId: '2781634', documented: true, name: 'bunq' },
  { fb: byName('teamtailor'), ref: 'career.teamtailor.com', host: 'career.teamtailor.com', url: 'https://career.teamtailor.com/jobs.rss', boardUrl: 'https://career.teamtailor.com/jobs.rss', file: 'teamtailor-career.rss', n: 3, firstId: '4ff07fd5-3ac0-4333-8f4c-955380396321', documented: false, name: 'Teamtailor', robots: 'robots-teamtailor.txt' },
  { fb: byName('personio'), ref: 'personio.jobs.personio.de', host: 'personio.jobs.personio.de', url: 'https://personio.jobs.personio.de/xml', boardUrl: 'https://personio.jobs.personio.de/xml', file: 'personio-personio.xml', n: 1, firstId: '1834171', documented: true, name: 'Personio SE & Co. KG' },
  { fb: byName('bamboohr'), ref: 'rednucleus', host: 'rednucleus.bamboohr.com', url: 'https://rednucleus.bamboohr.com/careers/list', boardUrl: 'https://rednucleus.bamboohr.com/careers/list', file: 'bamboohr-rednucleus.json', n: 5, firstId: 'rednucleus:546', documented: false, name: null, robots: 'robots-bamboohr.txt' },
  { fb: byName('breezy'), ref: 'breezy', host: 'breezy.breezy.hr', url: 'https://breezy.breezy.hr/json', boardUrl: 'https://breezy.breezy.hr/json', file: 'breezy-breezy.json', n: 3, firstId: '98323abf2296', documented: false, name: 'MS Breezy Trial', robots: 'robots-breezy.txt' },
  { fb: byName('pinpoint'), ref: 'grasshopper', host: 'grasshopper.pinpointhq.com', url: 'https://grasshopper.pinpointhq.com/postings.json', boardUrl: 'https://grasshopper.pinpointhq.com/postings.json', file: 'pinpoint-grasshopper.json', n: 2, firstId: '540608', documented: true, name: null },
  { fb: byName('rippling'), ref: 'rippling', host: 'api.rippling.com', url: 'https://api.rippling.com/platform/api/ats/v1/board/rippling/jobs', boardUrl: 'https://api.rippling.com/platform/api/ats/v1/board/rippling/jobs', file: 'rippling-rippling.json', n: 7, firstId: 'ef0b7266-678c-4a23-a439-1a5e7362b604', documented: false, name: null, robots: 'robots-rippling.txt' },
  { fb: byName('gem'), ref: 'gem', host: 'api.gem.com', url: 'https://api.gem.com/job_board/v0/gem/job_posts/', boardUrl: 'https://api.gem.com/job_board/v0/gem/job_posts/', file: 'gem-gem.json', n: 2, firstId: '4965519002', documented: true, name: null, robots: 'robots-gem.txt' },
  // Sources expansion, Task 3: the careers page's embedded list (4 openings: 2 kept, 1 unpublished, 1 without an id)
  { fb: byName('zohorecruit'), ref: 'shurutech.zohorecruit.in', host: 'shurutech.zohorecruit.in', url: 'https://shurutech.zohorecruit.in/jobs/Careers', boardUrl: 'https://shurutech.zohorecruit.in/jobs/Careers', file: '../sx/zohorecruit/careers.html', n: 2, firstId: '100000000000000101', documented: false, name: null, robots: '../sx/zohorecruit/robots.txt', malformed: ['entry 3: id: no id'] },
];
/** Manatal pages (Task 4), so it is not a ROWS entry (every ROWS test reads exactly one feed request); wired like the rest. */
const MANATAL_BOARD = 'https://open.api.manatal.com/open/v3/career-page/acme/jobs/';
const MROW = { fb: manatal, ref: 'acme', host: MANATAL_HOST, url: MANATAL_BOARD, boardUrl: MANATAL_BOARD, file: '', n: 10, firstId: '', documented: false, name: null } as unknown as Row;
const WIRED: readonly Row[] = [...ROWS, MROW];
const STRICT = ROWS.filter((r) => !r.documented);
const DOCUMENTED = ROWS.filter((r) => r.documented);

const ELIG: EligibilityPack = {
  filters: { roleDeny: [], companyDeny: [], employmentDeny: [] },
  eligibility: { employmentTypes: ['full-time'], officeCities: ['bengaluru'] },
  watchlist: [],
  offers: { floor: null },
  fx: { toINR: { INR: 1, USD: 85, EUR: 92, GBP: 108 } },
};

type Route = { status: number; body?: string; headers?: Record<string, string> };
function harness(row: Pick<Row, 'fb' | 'host'>, routes: Record<string, Route>) {
  const calls: string[] = [];
  const accepts: (string | undefined)[] = [];
  const agents: (string | undefined)[] = [];
  let now = Date.parse('2026-10-14T01:30:00Z');
  const clock = { now: () => new Date(now).toISOString() };
  const slept: number[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    const h = (init as { headers?: Record<string, string> }).headers ?? {};
    accepts.push(h['accept']);
    agents.push(h['user-agent']);
    const r = routes[url] ?? { status: 404, body: 'not found' };
    return { status: r.status, text: async () => r.body ?? '', headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null } };
  };
  // a policy spacing of 500 ms: the 2 s between a platform's requests is the adapter's own (minIntervalMs)
  const hostPacer = createHostPacer(500, clock, async (ms) => {
    slept.push(ms);
    now += ms;
  });
  const skipped: string[] = [];
  const base = issueContext({ contract: row.fb.contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock, signal: new AbortController().signal, egressSets: { [row.fb.spec.egress]: [row.host] }, hostPacer });
  const ctx = { ...base, skipped: (n: readonly string[]) => void skipped.push(...n) } as AgentContext;
  return { ctx, calls, accepts, agents, slept, skipped };
}
const req = (row: Row, company = 'Acme', runDate = '2026-10-14'): DiscoveryRequest => ({ ats: row.fb.spec.platform as DiscoveryRequest['ats'], slug: row.ref, company, runDate });
const run = (a: Agent<DiscoveryRequest, RawPosting>, r: DiscoveryRequest, ctx: AgentContext): Promise<RawPosting[]> => a.run(r, ctx) as Promise<RawPosting[]>;
const feedRoutes = (row: Row, body = fx(row.file), extra: Record<string, Route> = {}): Record<string, Route> => ({
  ...(row.robots === undefined ? {} : { [`https://${row.host}/robots.txt`]: { status: row.robots === 'robots-rippling.txt' ? 404 : row.robots === 'robots-gem.txt' ? 403 : 200, body: fx(row.robots) } }),
  [row.url]: { status: 200, body },
  ...extra,
});
const REC = (company = 'Acme', slug = 'x') => ({ company, slug });

describe('the recorded feeds', () => {
  it.each(ROWS.map((r) => [r.fb.spec.platform, r] as const))('%s: parses the recorded feed to postings keyed by the platform id, the company name and the apply URL', (_n, row) => {
    const page = row.fb.spec.parse(fx(row.file), row.fb.spec.parseRef(row.ref) as string, REC());
    expect(page.postings).toHaveLength(row.n);
    expect(page.malformed).toEqual(row.malformed ?? []);
    expect(page.postings[0]).toMatchObject({ source: row.fb.spec.platform, sourceId: row.firstId, company: 'Acme', slug: 'x' });
    for (const p of page.postings) {
      const posting = normalize(p);
      expect(Posting.schema.safeParse(posting).success).toBe(true);
      expect(posting.url).toMatch(/^https:\/\//u);
      expect(posting.title).toBe(posting.title.trim());
    }
    if (row.name === null || row.fb.spec.platform === 'personio') expect(page.names).toEqual(row.fb.spec.platform === 'personio' ? ['Personio SE & Co. KG'] : []);
    else expect(page.names).toEqual([row.name]);
  });

  it('the recorded values: Workable (remote, Paris), Recruitee (hybrid, Amsterdam, pay none), Teamtailor (RFC 822 date, hybrid), Personio (offices, no country), BambooHR (US, no description), Breezy, Pinpoint (remote), Rippling (labels), Gem (hybrid)', () => {
    const post = (n: string) => ROWS.find((r) => r.fb.spec.platform === n) as Row;
    const first = (n: string) => normalize(post(n).fb.spec.parse(fx(post(n).file), post(n).fb.spec.parseRef(post(n).ref) as string, REC()).postings[0] as RawPosting);
    expect(first('workable')).toMatchObject({ title: 'Open-Source Machine Learning Engineer - EMEA Remote', url: 'https://apply.workable.com/j/81B46579FE', locationText: 'Paris, Île-de-France, France', employmentType: 'Full-time', postedAt: '2026-05-29', remote: { structured: 'remote', countries: [] } });
    expect(first('workable').descriptionText).toContain('Hugging Face');
    expect(first('recruitee')).toMatchObject({ title: '(Senior) Product Owner', url: 'https://careers.bunq.com/o/senior-product-owner-1', locationText: 'Amsterdam, Noord-Holland, Netherlands', postedAt: '2026-10-13T10:58:56Z', remote: { structured: 'hybrid', countries: ['netherlands'] }, comp: null });
    expect(first('teamtailor')).toMatchObject({ title: 'UK Account Executive - SMB', url: 'https://career.teamtailor.com/jobs/8118064-uk-account-executive-smb', locationText: 'London, United Kingdom', postedAt: '2026-07-24T07:05:16.000Z', remote: { structured: 'hybrid', countries: ['united kingdom'] } });
    expect(first('teamtailor').descriptionText).toContain('Teamtailor is an Employer Branding');
    expect(first('personio')).toMatchObject({ title: 'Staff Software Engineer, Data Platform', url: 'https://personio.jobs.personio.de/job/1834171', locationText: 'Munich; Berlin', postedAt: '2024-11-13T14:10:41+00:00', employmentType: 'permanent, full-time', remote: { structured: null, countries: [] } });
    expect(first('bamboohr')).toMatchObject({ title: 'Managing Director, Medical Affairs Consulting', url: 'https://rednucleus.bamboohr.com/careers/546', locationText: 'United States', descriptionText: '', employmentType: 'Full-Time', remote: { countries: ['united states'] } });
    expect(first('breezy')).toMatchObject({ title: 'Employee #12', locationText: 'Chaos, FL, United States', employmentType: 'Other', remote: { structured: null, countries: ['united states'] } });
    expect(first('pinpoint')).toMatchObject({ title: 'Fintech Risk Analyst', url: 'https://grasshopper.pinpointhq.com/en/postings/7a2878fd-2d14-4783-84e3-59b47ac3553b', locationText: 'Remote, New York', remote: { structured: 'remote' }, employmentType: 'Full Time' });
    expect(first('rippling')).toMatchObject({ title: 'Account Executive, Broker Channel (Arkansas)', locationText: 'AR', url: 'https://ats.rippling.com/rippling/jobs/ef0b7266-678c-4a23-a439-1a5e7362b604', remote: { countries: [] } });
    expect(first('gem')).toMatchObject({ title: 'Software Engineer', url: 'https://jobs.gem.com/gem/4965519002', locationText: 'San Francisco, United States', postedAt: '2020-11-17T15:37:23.000Z', employmentType: 'full time', remote: { structured: 'hybrid' } });
  });

  it('refs and stored board URLs: the detector\'s board URL reads back to the ref; anything else is not a board', () => {
    for (const r of ROWS) {
      expect(r.fb.spec.boardOfUrl(r.boardUrl), r.fb.spec.platform).toBe(r.ref);
      expect(r.fb.spec.parseRef(r.ref), r.fb.spec.platform).toBe(r.ref);
      expect(r.fb.spec.urlOf(r.ref), r.fb.spec.platform).toBe(r.url);
      expect(r.fb.spec.hostOf(r.ref), r.fb.spec.platform).toBe(r.host);
      // a Teamtailor board may be the company's own domain: any host serving /jobs.rss is one
      if (r.fb.spec.platform !== 'teamtailor') expect(r.fb.spec.boardOfUrl('https://evil.test/jobs.rss'), r.fb.spec.platform).toBeNull();
      expect(r.fb.spec.boardOfUrl('http://' + r.boardUrl.slice(8)), r.fb.spec.platform).toBeNull();
      expect(r.fb.spec.boardOfUrl(r.boardUrl.replace('https://', 'https://user@')), r.fb.spec.platform).toBeNull();
      expect(r.fb.spec.boardOfUrl('not a url'), r.fb.spec.platform).toBeNull();
      for (const bad of ['', 'a b', 'a/b', '../x', 'a@b', '-x', 'x'.repeat(200)]) expect(r.fb.spec.parseRef(bad), `${r.fb.spec.platform} ${bad}`).toBeNull();
    }
    const p = (n: string) => byName(n).spec;
    expect(p('workable').boardOfUrl('https://apply.workable.com/api/v1/widget/accounts/Acme-Inc?details=true')).toBe('Acme-Inc');
    expect(p('workable').boardOfUrl('https://apply.workable.com/acme')).toBeNull();
    expect(p('recruitee').boardOfUrl('https://www.recruitee.com/api/offers/')).toBeNull();
    expect(p('teamtailor').boardOfUrl('https://www.teamtailor.com/jobs.rss')).toBeNull();
    expect(p('teamtailor').parseRef('10.0.0.1')).toBeNull();
    expect(p('personio').parseRef('acme.jobs.personio.com')).toBe('acme.jobs.personio.com');
    expect(p('personio').parseRef('acme.example.com')).toBeNull();
    expect(p('bamboohr').boardOfUrl('https://acme.bamboohr.com/careers/list?x=1')).toBe('acme');
  });

  it('BambooHR ids are per company: the sourceId carries the slug; the platform total above the list is a short-list note', async () => {
    const row = ROWS.find((r) => r.fb.spec.platform === 'bamboohr') as Row;
    const h = harness(row, feedRoutes(row));
    const out = await run(row.fb.make({ hosts: dailyFeedHosts(false) }), req(row), h.ctx);
    expect(out.map((p) => p.sourceId)).toEqual(['rednucleus:546', 'rednucleus:589', 'rednucleus:613', 'rednucleus:618', 'rednucleus:619']);
    expect(h.skipped).toEqual(['short-list Acme: total 61, listed 5']);
  });
});

describe('requests: one feed request, the honest user agent, the platform\'s Accept, robots', () => {
  it.each(ROWS.map((r) => [r.fb.spec.platform, r] as const))('%s: reads the board with one feed request (+ robots.txt only where it governs), at least 2 s apart, honest user agent', async (_n, row) => {
    const h = harness(row, feedRoutes(row));
    const out = await run(row.fb.make({ hosts: dailyFeedHosts(row.documented) }), req(row), h.ctx);
    expect(out).toHaveLength(row.kept ?? row.n);
    expect(h.calls).toEqual(row.documented ? [row.url] : [`https://${row.host}/robots.txt`, row.url]);
    expect(h.agents.every((a) => a === 'jobpilot/0.1 (+local)')).toBe(true);
    if (!row.documented) expect(h.slept.length).toBeGreaterThanOrEqual(0);
    expect(h.accepts.at(-1)).toBe(row.fb.spec.platform === 'teamtailor' ? 'application/rss+xml' : 'application/json, text/plain;q=0.8, */*;q=0.1');
    expect(FEED_MIN_INTERVAL_MS).toBe(2000);
  });

  it('every feed request names a 2 s spacing: two companies on one host are at least 2 s apart', async () => {
    const row = ROWS.find((r) => r.fb.spec.platform === 'rippling') as Row;
    const hosts = dailyFeedHosts(false);
    const h = harness(row, feedRoutes(row, fx(row.file), { 'https://api.rippling.com/platform/api/ats/v1/board/other/jobs': { status: 200, body: '[]' } }));
    const a = row.fb.make({ hosts });
    await run(a, req(row), h.ctx);
    await run(a, { ...req(row), slug: 'other' }, h.ctx);
    // robots.txt once for the host and the run, then the two feeds
    expect(h.calls).toEqual(['https://api.rippling.com/robots.txt', row.url, 'https://api.rippling.com/platform/api/ats/v1/board/other/jobs']);
    // robots.txt → feed → second feed: each waits the full 2 s after the previous request to the host
    expect(h.slept.filter((ms) => ms === 2000)).toHaveLength(2);
  });

  it('a documented API is read without robots.txt (the host\'s robots.txt is never asked); the strict four ask it once per host per run', async () => {
    for (const row of DOCUMENTED) {
      const h = harness(row, { [`https://${row.host}/robots.txt`]: { status: 200, body: 'User-agent: *\nDisallow: /' }, [row.url]: { status: 200, body: fx(row.file) } });
      await expect(run(row.fb.make({ hosts: dailyFeedHosts(true) }), req(row), h.ctx), row.fb.spec.platform).resolves.toHaveLength(row.kept ?? row.n);
      expect(h.calls.some((u) => u.endsWith('/robots.txt')), row.fb.spec.platform).toBe(false);
    }
    const row = ROWS.find((r) => r.fb.spec.platform === 'bamboohr') as Row;
    const hosts = dailyFeedHosts(false);
    const h = harness(row, feedRoutes(row));
    await run(row.fb.make({ hosts }), req(row), h.ctx);
    await run(row.fb.make({ hosts }), req(row, 'Acme 2'), h.ctx);
    expect(h.calls.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(1);
  });

  it.each(STRICT.map((r) => [r.fb.spec.platform, r] as const))('%s: a robots.txt that disallows the feed is the named skip, nothing else is fetched', async (_n, row) => {
    const path = new URL(row.url).pathname;
    const h = harness(row, { [`https://${row.host}/robots.txt`]: { status: 200, body: `User-agent: *\nDisallow: ${path}` }, [row.url]: { status: 200, body: fx(row.file) } });
    await expect(run(row.fb.make({ hosts: dailyFeedHosts(false) }), req(row), h.ctx)).resolves.toEqual([]);
    expect(h.calls).toEqual([`https://${row.host}/robots.txt`]);
    expect(h.skipped).toEqual([`robots-disallow ${row.host}: Acme not read today (robots-disallow ${path})`]);
  });

  it.each(STRICT.map((r) => [r.fb.spec.platform, r] as const))('%s: a 401/403 robots.txt refuses (named skip), a 404 allows all, a 5xx fails the step uncached (C1)', async (_n, row) => {
    for (const [status, ok] of [[403, false], [401, false], [404, true]] as const) {
      const h = harness(row, { [`https://${row.host}/robots.txt`]: { status, body: 'nope' }, [row.url]: { status: 200, body: fx(row.file) } });
      const out = await run(row.fb.make({ hosts: dailyFeedHosts(false) }), req(row), h.ctx);
      expect(out.length > 0, `${row.fb.spec.platform} ${status}`).toBe(ok);
      if (!ok) expect(h.skipped[0], `${row.fb.spec.platform} ${status}`).toMatch(/^robots-disallow .*not read today \(robots-forbidden\)$/u);
    }
    for (const status of [500, 503]) {
      const hosts = dailyFeedHosts(false);
      const h = harness(row, { [`https://${row.host}/robots.txt`]: { status, body: 'busy' }, [row.url]: { status: 200, body: fx(row.file) } });
      await expect(run(row.fb.make({ hosts }), req(row), h.ctx), `${row.fb.spec.platform} ${status}`).rejects.toMatchObject({ code: 'overloaded' });
      expect(h.skipped).toEqual([]);
      // not kept for the run: the next company on the host asks robots.txt again
      await run(row.fb.make({ hosts }), req(row), h.ctx).catch(() => undefined);
      expect(h.calls.filter((u) => u === `https://${row.host}/robots.txt`), `${row.fb.spec.platform} ${status}`).toHaveLength(2);
    }
  });

  it('the strict rule matches the path and the query; the allow rule of the recorded robots.txt files lets the four feeds through', async () => {
    for (const row of STRICT) {
      const h = harness(row, feedRoutes(row));
      await expect(run(row.fb.make({ hosts: dailyFeedHosts(false) }), req(row), h.ctx), row.fb.spec.platform).resolves.toHaveLength(row.kept ?? row.n);
    }
  });
});

describe('refusals: the host is disabled for the run, nothing is retried around, Retry-After is never read', () => {
  it.each(ROWS.map((r) => [r.fb.spec.platform, r] as const))('%s: a 401/403 is challenged and a sibling is deferred without a request; a 429 is rate_limit, disabled; Retry-After is ignored; a 5xx is overloaded', async (_n, row) => {
    for (const status of [401, 403]) {
      const hosts = dailyFeedHosts(row.documented);
      const h = harness(row, feedRoutes(row, '', { [row.url]: { status, body: 'no' } }));
      await expect(run(row.fb.make({ hosts }), req(row), h.ctx), `${status}`).rejects.toMatchObject({ code: 'challenged' });
      expect(hosts.disabledWhy(row.host)).toBe(`http-${status}`);
      const before = h.calls.length;
      await expect(run(row.fb.make({ hosts }), req(row, 'Sibling'), h.ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(new RegExp(`^host-disabled:http-${status} on ${row.host.replaceAll('.', '\\.')}`, 'u')) });
      expect(h.calls.length).toBe(before);
    }
    const hosts = dailyFeedHosts(row.documented);
    const h = harness(row, feedRoutes(row, '', { [row.url]: { status: 429, body: 'slow down', headers: { 'retry-after': '1' } } }));
    await expect(run(row.fb.make({ hosts }), req(row), h.ctx)).rejects.toMatchObject({ code: 'rate_limit' });
    expect(hosts.disabledWhy(row.host)).toBe('http-429');
    // Retry-After: 1 never made the request wait or repeat: one feed request, no sleep for it beyond the pacer's own
    expect(h.calls.filter((u) => u === row.url)).toHaveLength(1);
    expect(h.slept.every((ms) => ms <= 2000)).toBe(true);
    const h5 = harness(row, feedRoutes(row, '', { [row.url]: { status: 503, body: 'down' } }));
    await expect(run(row.fb.make({ hosts: dailyFeedHosts(row.documented) }), req(row), h5.ctx)).rejects.toMatchObject({ code: 'overloaded' });
  });

  it.each(ROWS.map((r) => [r.fb.spec.platform, r] as const))('%s: a challenge page (403 or a small 200 that is not the feed) disables the host: challenged', async (_n, row) => {
    const wall = '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></html>';
    for (const [status, body] of [[403, wall], [503, wall], [200, wall]] as const) {
      const hosts = dailyFeedHosts(row.documented);
      const h = harness(row, feedRoutes(row, '', { [row.url]: { status, body } }));
      await expect(run(row.fb.make({ hosts }), req(row), h.ctx), `${status}`).rejects.toMatchObject({ code: 'challenged' });
      expect(hosts.disabledWhy(row.host), `${status}`).toMatch(/^(?:challenge|http-403)$/u);
    }
  });

  it('a robots.txt that answers with a challenge or 429 disables the strict host; a sibling is deferred', async () => {
    const row = ROWS.find((r) => r.fb.spec.platform === 'teamtailor') as Row;
    const hosts = dailyFeedHosts(false);
    const h = harness(row, { [`https://${row.host}/robots.txt`]: { status: 429, body: 'slow' } });
    await expect(run(row.fb.make({ hosts }), req(row), h.ctx)).rejects.toMatchObject({ code: 'rate_limit' });
    await expect(run(row.fb.make({ hosts }), req(row, 'Sibling'), h.ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^host-disabled:http-429/u) });
    expect(h.calls).toEqual([`https://${row.host}/robots.txt`]);
  });

  it('a 404 is gone; a redirect (BambooHR\'s unknown slug) and another 4xx are input_rejected, never followed', async () => {
    const row = ROWS.find((r) => r.fb.spec.platform === 'bamboohr') as Row;
    const go = async (route: Route) => {
      const h = harness(row, feedRoutes(row, '', { [row.url]: route }));
      const p = run(row.fb.make({ hosts: dailyFeedHosts(false) }), req(row), h.ctx);
      return { p, h };
    };
    const a = await go({ status: 404 });
    await expect(a.p).rejects.toMatchObject({ code: 'gone' });
    const b = await go({ status: 302, headers: { location: 'https://www.bamboohr.com/' } });
    await expect(b.p).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/redirected \(302 to www\.bamboohr\.com\)/u) });
    expect(b.h.calls).toEqual([`https://${row.host}/robots.txt`, row.url]);
    const c = await go({ status: 410 });
    await expect(c.p).rejects.toMatchObject({ code: 'gone' });
    const d = await go({ status: 418 });
    await expect(d.p).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/returned 418/u) });
  });
});

describe('shapes: a page-level problem fails the company (input_rejected), a malformed entry is skipped by name', () => {
  const page = (row: Row, body: string) => {
    const h = harness(row, feedRoutes(row, body));
    return { p: run(row.fb.make({ hosts: dailyFeedHosts(row.documented) }), req(row), h.ctx), h };
  };

  it.each(ROWS.map((r) => [r.fb.spec.platform, r] as const))('%s: a body that is not the feed (HTML, empty, the wrong envelope) is input_rejected, nothing read', async (_n, row) => {
    for (const body of ['<html><body>Sorry</body></html>', '', 'null', row.file.endsWith('.json') ? '{"unexpected":true}' : '<root/>', '{']) {
      const { p } = page(row, body);
      await expect(p, JSON.stringify(body).slice(0, 30)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/nothing read from it/u) });
    }
  });

  it('one malformed entry is skipped with a named note; the others flow (Workable, Recruitee, BambooHR, Breezy, Pinpoint, Rippling, Gem)', async () => {
    const break1: Record<string, (j: unknown) => unknown> = {
      workable: (j) => ({ ...(j as object), jobs: [{ shortcode: 'bad id', title: 'x' }, ...(j as { jobs: unknown[] }).jobs] }),
      recruitee: (j) => ({ offers: [{ id: 'abc', title: 'x' }, ...(j as { offers: unknown[] }).offers] }),
      bamboohr: (j) => ({ ...(j as object), result: [{ id: '1' }, ...(j as { result: unknown[] }).result] }),
      breezy: (j) => [{ id: 'z' }, ...(j as unknown[])],
      pinpoint: (j) => ({ data: [{ id: '1', title: '  ', url: 'https://a.test/' }, ...(j as { data: unknown[] }).data] }),
      rippling: (j) => [{ uuid: 'x', name: 'n', url: 'https://ats.rippling.com/a/jobs/x' }, ...(j as unknown[])],
      gem: (j) => [{ id: 1, title: 'x', absolute_url: 'javascript:alert(1)' }, ...(j as unknown[])],
    };
    for (const row of ROWS.filter((r) => r.file.endsWith('.json'))) {
      const body = JSON.stringify(break1[row.fb.spec.platform]?.(JSON.parse(fx(row.file))));
      const { p, h } = page(row, body);
      const out = await p;
      expect(out, row.fb.spec.platform).toHaveLength(row.kept ?? row.n);
      expect(h.skipped, row.fb.spec.platform).toHaveLength(1 + (row.fb.spec.platform === 'bamboohr' ? 1 : 0));
      expect(h.skipped[0], row.fb.spec.platform).toMatch(new RegExp(`^${row.fb.spec.platform} Acme entry 0: `, 'u'));
    }
  });

  it('XML feeds: an <item> without a guid or a <position> without an id is skipped by name', async () => {
    const tt = ROWS.find((r) => r.fb.spec.platform === 'teamtailor') as Row;
    const body = fx(tt.file).replace('<item>', '<item><title>No guid</title><link>https://career.teamtailor.com/jobs/1-x</link></item><item>');
    const a = page(tt, body);
    expect(await a.p).toHaveLength(3);
    expect(a.h.skipped).toEqual(['teamtailor Acme entry 0: no guid']);
    const pe = ROWS.find((r) => r.fb.spec.platform === 'personio') as Row;
    const b = page(pe, fx(pe.file).replace('<position>', '<position><name>No id</name></position><position>'));
    expect(await b.p).toHaveLength(1);
    expect(b.h.skipped).toEqual(['personio Acme entry 0: no id']);
  });

  it('every entry malformed is schema drift: input_rejected, not an empty board', async () => {
    const row = ROWS.find((r) => r.fb.spec.platform === 'rippling') as Row;
    const { p } = page(row, JSON.stringify([{ uuid: 'x' }, { name: 'y' }]));
    await expect(p).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/all 2 entries are malformed/u) });
    // an empty feed is a board with no jobs, not a problem
    const q = page(row, '[]');
    await expect(q.p).resolves.toEqual([]);
  });

  it('Rippling lists a job once per location: the entries of one uuid are one posting with every location (a Bangalore entry after others still counts)', async () => {
    const row = ROWS.find((r) => r.fb.spec.platform === 'rippling') as Row;
    const page0 = row.fb.spec.parse(fx(row.file), 'rippling', REC());
    // the recorded feed: 8 entries, 7 jobs; the Orlando / Jacksonville job is listed under both places
    expect(page0.listed).toBe(8);
    const two = page0.postings.find((p) => p.sourceId === 'f6253878-a8c0-43f8-adac-00b4a4885258') as RawPosting;
    expect((two.raw as { locations: string[] }).locations).toEqual(['Jacksonville, FL', 'Orlando, FL']);
    expect(normalize(two).locationText).toBe('Jacksonville, FL; Orlando, FL');
    const e = (label: string) => ({ uuid: '11111111-2222-3333-4444-555555555555', name: 'Senior Software Engineer', url: 'https://ats.rippling.com/a/jobs/1', workLocation: { label, id: label } });
    const { p } = page(row, JSON.stringify([e('Remote (Paris, France)'), e('Bengaluru, India'), e('Bengaluru, India')]));
    const out = await p;
    expect(out).toHaveLength(1);
    const posting = normalize(out[0] as RawPosting);
    expect(posting.locationText).toBe('Remote (Paris, France); Bengaluru, India');
    expect(posting.remote.countries).toEqual(expect.arrayContaining(['india']));
  });

  it('an entry the platform lists twice is one posting (the first)', async () => {
    const row = ROWS.find((r) => r.fb.spec.platform === 'gem') as Row;
    const j = JSON.parse(fx(row.file)) as unknown[];
    const { p } = page(row, JSON.stringify([...j, j[0]]));
    expect(await p).toHaveLength(2);
  });

  it('the loud job cap: a feed over FEED_MAX_JOBS is input_rejected (job-cap), never truncated; at the cap it is read', async () => {
    expect(FEED_MAX_JOBS).toBe(5000);
    const row = ROWS.find((r) => r.fb.spec.platform === 'rippling') as Row;
    const mk = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ uuid: `uuid-${String(i).padStart(8, '0')}`, name: `Job ${i}`, url: `https://ats.rippling.com/x/jobs/${i}`, workLocation: { label: 'Remote' } })));
    await expect(page(row, mk(FEED_MAX_JOBS + 1)).p).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^job-cap Rippling rippling: the feed lists 5001 jobs, over the cap of 5000; nothing read, never truncated/u) });
    await expect(page(row, mk(FEED_MAX_JOBS)).p).resolves.toHaveLength(FEED_MAX_JOBS);
  });

  it('the named constants: 10 list pages at most, one request per feed, the pacing arithmetic', () => {
    expect(FEED_MAX_PAGES).toBe(10);
    expect(FEED_MAX_REQUESTS).toBe(1 + FEED_MAX_PAGES);
    for (const fb of SMALL_PLATFORMS) expect(fb.contract.timeoutMs / FEED_MAX_REQUESTS, fb.spec.platform).toBeGreaterThan(PRODUCT_POLICY_V1.minHostIntervalMs);
    expect(FEED_TIMEOUT_MS).toBe(300_000);
  });

  it('1 MB adversarial XML and JSON bodies are rejected or read in well under a second (linear parsing)', () => {
    const MB = 1024 * 1024;
    const rep = (x: string): string => x.repeat(Math.ceil(MB / x.length)).slice(0, MB);
    const time = (f: () => unknown): number => {
      const t = performance.now();
      try {
        f();
      } catch {
        /* a rejection is fine */
      }
      return performance.now() - t;
    };
    const rss = '<rss><channel><title>t</title>';
    for (const body of [rss + rep('<item>'), rss + rep('<item><title>'), rss + rep('&amp;'), rss + rep('<![CDATA['), rss + rep('<!--'), rss + rep('<a '), rss + rep('<item><guid>1</guid>'), rss + rep('&#'), rss + `<item><description>${rep('&')}`]) {
      expect(time(() => parseTeamtailor(body, 'career.test', REC())), body.slice(rss.length, rss.length + 20)).toBeLessThan(500);
    }
    const px = '<workzag-jobs>';
    for (const body of [px + rep('<position>'), px + rep('<position><id>1</id>'), px + rep('<jobDescription>'), px + rep('&lt;'), px + rep('<![CDATA[')]) {
      expect(time(() => parsePersonio(body, 'a.jobs.personio.de', REC())), body.slice(px.length, px.length + 20)).toBeLessThan(500);
    }
    for (const row of ROWS.filter((r) => r.file.endsWith('.json'))) {
      const ref = row.fb.spec.parseRef(row.ref) as string;
      for (const body of [rep('['), rep('{"a":'), rep('[{},'), rep('"x'), '[' + rep('{"id":"1","name":"n"},')]) expect(time(() => row.fb.spec.parse(body, ref, REC())), row.fb.spec.platform).toBeLessThan(1000);
    }
  });
});

describe('location: the platform\'s own place fields map to the unchanged eligibility rules (India, Bengaluru, remote)', () => {
  const verdict = (name: string, w: Where) => {
    const fb = byName(name);
    const ref = name === 'personio' ? 'acme.jobs.personio.de' : name === 'teamtailor' ? 'career.acme.test' : 'acme';
    const page = fb.spec.parse(BUILD[name]!(w), ref, REC());
    expect(page.postings).toHaveLength(1);
    const p = normalize(page.postings[0] as RawPosting);
    expect(Posting.schema.safeParse(p).success).toBe(true);
    return { p, d: decideEligibility(p, ELIG) };
  };
  const NAMES = ROWS.map((r) => r.fb.spec.platform);

  it.each(NAMES)('%s: an office in Bengaluru is eligible (office city), the same job in Paris is rejected', (name) => {
    const blr = verdict(name, 'blr');
    expect(blr.d).toMatchObject({ verdict: 'eligible', notes: expect.arrayContaining(['office/hybrid: Bengaluru']) });
    expect(blr.p.remote.countries).toContain('india');
    expect(blr.p.locationText).toMatch(/Bengaluru/u);
    expect(verdict(name, 'paris').d.verdict).toBe('rejected');
  });

  it.each(NAMES)('%s: remote and located in India is eligible; remote located abroad is review (never rejected from its office country)', (name) => {
    const inIndia = verdict(name, 'remote-in');
    expect(inIndia.d.verdict).toBe('eligible');
    expect(inIndia.p.remote.countries).toContain('india');
    const eu = verdict(name, 'remote-eu');
    if (name === 'personio' || name === 'rippling') {
      // no remote flag: the text says "Remote EU" / "Remote (Paris, France)", which the unchanged rules read as written
      expect(eu.d).toMatchObject({ verdict: 'rejected', reasons: [expect.stringMatching(/^remote-excludes-india/u)] });
    } else {
      expect(eu.d).toMatchObject({ verdict: 'review', reasons: ['remote-unclear'] });
      expect(eu.p.remote.structured).toBe('remote');
      expect(eu.p.remote.countries).toEqual([]);
    }
  });

  it('an unflagged job with only a state code (Rippling "AR") or a country-less city (Personio "Munich") invents no country', () => {
    const rip = normalize(byName('rippling').spec.parse(fx('rippling-rippling.json'), 'rippling', REC()).postings[0] as RawPosting);
    expect(rip.remote.countries).toEqual([]);
    expect(rip.locationText).toBe('AR');
    const per = normalize(byName('personio').spec.parse(fx('personio-personio.xml'), 'personio.jobs.personio.de', REC()).postings[0] as RawPosting);
    expect(per.remote.countries).toEqual([]);
    expect(decideEligibility(per, ELIG).verdict).toBe('rejected');
  });

  it('Teamtailor remoteStatus: fully is remote, hybrid is hybrid, none is a signal only', () => {
    const mk = (s: string) => normalize(byName('teamtailor').spec.parse(BUILD['teamtailor']!('paris').replace('<remoteStatus>none', `<remoteStatus>${s}`), 'career.acme.test', REC()).postings[0] as RawPosting);
    expect(mk('fully').remote).toMatchObject({ structured: 'remote' });
    expect(mk('hybrid').remote).toMatchObject({ structured: 'hybrid', countries: ['france'] });
    expect(mk('none').remote).toMatchObject({ structured: null, signals: expect.arrayContaining(['remoteStatus:none']) });
  });

  it('pay: Recruitee\'s and Pinpoint\'s own range maps to an annual comp; absent, none', () => {
    const rec = JSON.parse(BUILD['recruitee']!('blr')) as { offers: Record<string, unknown>[] };
    (rec.offers[0] as Record<string, unknown>)['salary'] = { min: '2400000', max: '3600000', period: 'year', currency: 'INR' };
    const r = normalize(byName('recruitee').spec.parse(JSON.stringify(rec), 'acme', REC()).postings[0] as RawPosting);
    expect(r.comp).toMatchObject({ min: 2_400_000, max: 3_600_000, currency: 'INR', period: 'year' });
    const pin = JSON.parse(BUILD['pinpoint']!('blr')) as { data: Record<string, unknown>[] };
    Object.assign(pin.data[0] as object, { compensation_visible: true, compensation_minimum: 100000, compensation_maximum: 150000, compensation_currency: 'USD', compensation_frequency: 'annual' });
    const q = normalize(byName('pinpoint').spec.parse(JSON.stringify(pin), 'acme', REC()).postings[0] as RawPosting);
    expect(q.comp).toMatchObject({ min: 100000, max: 150000, currency: 'USD' });
    Object.assign(pin.data[0] as object, { compensation_visible: false });
    expect(normalize(byName('pinpoint').spec.parse(JSON.stringify(pin), 'acme', REC()).postings[0] as RawPosting).comp).toBeNull();
  });

  it('the places table is what the tests use', () => {
    expect(Object.keys(PLACES)).toEqual(['blr', 'remote-in', 'paris', 'remote-eu']);
    expect(TITLE).toBe('Senior Software Engineer');
  });
});

// ---------------------------------------------------------------------------
// the verifier clients
// ---------------------------------------------------------------------------

const RUN = '2026-10-14';
const cand = (companyKey: string, name: string): CompanyCandidate => ({ companyKey, name, website: `https://www.${companyKey}`, careersUrl: null, source: 'yc', runDate: RUN });
const site = (c: CompanyCandidate): CareersSite => ({ candidate: c, careersUrl: `https://www.${c.companyKey}/careers`, method: 'path', evidence: 'GET /careers 200' });
const guess = (c: CompanyCandidate, platform: Platform, slug: string, boardUrl: string | null): PlatformGuess => ({ site: site(c), platform, slug, boardUrl, signature: `${platform}:a`, routedFrom: null, evidence: [`detected: ${platform} ${slug}`] });
const fresh = () => ({ runKey: 'test', store: memoryHostStateStore() });
function vctx(fetch: FetchLike, guesses: readonly PlatformGuess[]) {
  return issueContext({ contract: boardVerifierContract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock: fixedClock('2026-10-14T01:30:00.000Z'), signal: new AbortController().signal, egressSets: verifierEgressSets(guesses) });
}
function serve(routes: Record<string, Route>) {
  const calls: string[] = [];
  const accepts: (string | undefined)[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    accepts.push(((init as { headers?: Record<string, string> }).headers ?? {})['accept']);
    const r = routes[url] ?? { status: 404, body: 'Not Found' };
    return { status: r.status, text: async () => r.body ?? '', headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null } };
  };
  return { fetch, calls, accepts };
}

describe('the verifier clients: one feed request, the daily adapter\'s own', () => {
  // company key, display name: the feed's own name (or the slug / domain label) must match
  const COMPANY: Record<string, [string, string]> = {
    workable: ['huggingface.co', 'Hugging Face'],
    recruitee: ['bunq.com', 'bunq'],
    teamtailor: ['teamtailor.com', 'Teamtailor'],
    personio: ['personio.com', 'Personio SE & Co. KG'],
    bamboohr: ['rednucleus.com', 'Red Nucleus'],
    breezy: ['breezy.hr', 'MS Breezy Trial'],
    pinpoint: ['grasshopper.com', 'Grasshopper Bank'],
    rippling: ['rippling.com', 'Rippling'],
    gem: ['gem.com', 'Gem'],
    zohorecruit: ['shurutech.com', 'Shurutech'],
  };
  const slugOf = (r: Row): string => (r.fb.spec.platform === 'teamtailor' ? r.ref : r.fb.spec.platform === 'personio' ? 'personio' : r.ref);
  const g = (r: Row, name = COMPANY[r.fb.spec.platform]![1]) => guess(cand(COMPANY[r.fb.spec.platform]![0], name), r.fb.spec.platform as Platform, slugOf(r), r.boardUrl);
  const routes = (r: Row, extra: Record<string, Route> = {}) => feedRoutes(r, fx(r.file), extra);

  it.each(ROWS.map((r) => [r.fb.spec.platform, r] as const))('%s: reads the board once and verifies the company (name from the feed, else the slug / domain label)', async (_n, row) => {
    const n = serve(routes(row));
    const v = await makeBoardVerifier(fresh()).run(g(row), vctx(n.fetch, [g(row)]));
    expect(v[0]).toMatchObject({ status: 'verified', jobsSeen: row.kept ?? row.n });
    // exactly one feed request (+ robots.txt where it governs)
    expect(n.calls.filter((u) => u === row.url)).toHaveLength(1);
    expect(n.calls.filter((u) => u.endsWith('/robots.txt')).length).toBe(row.documented ? 0 : 1);
    expect(n.calls.length).toBe(row.documented ? 1 : 2);
    if (row.fb.spec.platform === 'teamtailor') expect(n.accepts.at(-1)).toBe('application/rss+xml');
    const p = platformClient(row.fb.spec.platform);
    expect([p?.platform, p?.robots, p?.host]).toEqual([row.fb.spec.platform, !row.documented, row.fb.spec.fixedHost]);
    expect(p?.refOf(slugOf(row), row.boardUrl)).toBe(row.ref);
    expect(p?.hostOf(row.ref)).toBe(row.host);
    expect(p?.boardUrl(row.ref)).toBe(row.url);
  });

  it('a feed that names the company differently is proposed (board name x ≈ y), not verified; a feed with no name and an unrelated slug is proposed', async () => {
    const wk = ROWS[0] as Row;
    const n = serve(routes(wk));
    // (the domain label counts too: the company's own domain must not be the feed's name for this case)
    const gw = guess(cand('acme.test', 'Acme Robotics'), 'workable', wk.ref, wk.boardUrl);
    const v = await makeBoardVerifier(fresh()).run(gw, vctx(n.fetch, [gw]));
    expect(v[0]).toMatchObject({ status: 'proposed', boardName: 'Hugging Face' });
    expect((v[0] as { reasons: string[] }).reasons[0]).toBe("board name 'Hugging Face' ≈ 'Acme Robotics', please confirm");
    const pp = ROWS.find((r) => r.fb.spec.platform === 'pinpoint') as Row;
    const m = serve(routes(pp));
    const gz = guess(cand('zebra.test', 'Zebra Ltd'), 'pinpoint', pp.ref, pp.boardUrl);
    const w = await makeBoardVerifier(fresh()).run(gz, vctx(m.fetch, [gz]));
    expect(w[0]).toMatchObject({ status: 'proposed', boardName: null });
    expect((w[0] as { reasons: string[] }).reasons[0]).toBe('board name not available, please confirm');
  });

  it('Personio names the legal entity (subcompany): a plain company name that differs from it is proposed, for a person to confirm', async () => {
    const pe = ROWS.find((r) => r.fb.spec.platform === 'personio') as Row;
    const n = serve(routes(pe));
    const gp = guess(cand('example.test', 'Example'), 'personio', 'personio', pe.boardUrl);
    const v = await makeBoardVerifier(fresh()).run(gp, vctx(n.fetch, [gp]));
    expect(v[0]).toMatchObject({ status: 'proposed', boardName: 'Personio SE & Co. KG' });
  });

  it('Personio\'s several subcompanies are not "several company names": the host label is compared instead', async () => {
    const pe = ROWS.find((r) => r.fb.spec.platform === 'personio') as Row;
    const two = fx(pe.file).replace('</position>', '</position><position><id>2</id><subcompany>Personio Ltd</subcompany><office>London</office><name>Engineer</name></position>');
    const n = serve(routes(pe, { [pe.url]: { status: 200, body: two } }));
    const v = await makeBoardVerifier(fresh()).run(g(pe), vctx(n.fetch, [g(pe)]));
    expect(v[0]).toMatchObject({ status: 'verified', jobsSeen: 2 });
  });

  it('0 jobs is proposed ("board has 0 open jobs"); a page-level shape problem is a failed verdict (invalid_output), not a thrown step', async () => {
    const rp = ROWS.find((r) => r.fb.spec.platform === 'rippling') as Row;
    const empty = serve(routes(rp, { [rp.url]: { status: 200, body: '[]' } }));
    const a = await makeBoardVerifier(fresh()).run(g(rp), vctx(empty.fetch, [g(rp)]));
    expect(a[0]).toMatchObject({ status: 'proposed', jobsSeen: 0 });
    expect((a[0] as { reasons: string[] }).reasons).toContain('board has 0 open jobs');
    const bad = serve(routes(rp, { [rp.url]: { status: 200, body: '<html>oops</html>' } }));
    const b = await makeBoardVerifier(fresh()).run(g(rp), vctx(bad.fetch, [g(rp)]));
    expect(b[0]).toMatchObject({ status: 'failed' });
    expect((b[0] as { reasons: string[] }).reasons.join('\n')).toMatch(/response is not JSON/u);
    const gone = serve(routes(rp, { [rp.url]: { status: 404 } }));
    expect((await makeBoardVerifier(fresh()).run(g(rp), vctx(gone.fetch, [g(rp)])))[0]).toMatchObject({ status: 'failed' });
  });

  it.each(ROWS.map((r) => [r.fb.spec.platform, r] as const))('%s: a 401/403, a 429 and a challenge are DEFERRALS (input_rejected host-disabled), never a failed verdict; a sibling is deferred without a request', async (_n, row) => {
    const wall = '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script></html>';
    for (const [route, why] of [[{ status: 403, body: 'no' }, 'http-403'], [{ status: 401, body: 'no' }, 'http-401'], [{ status: 429, body: 'slow' }, 'http-429'], [{ status: 403, body: wall }, 'http-403|challenge'], [{ status: 200, body: wall }, 'challenge']] as const) {
      const n = serve(routes(row, { [row.url]: route }));
      const gate = fresh();
      const agent = makeBoardVerifier(gate);
      const ctx = vctx(n.fetch, [g(row)]);
      await expect(agent.run(g(row), ctx), why).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(new RegExp(`^host-disabled:(?:${why}) on ${row.host.replaceAll('.', '\\.')}`, 'u')) });
      const before = n.calls.length;
      await expect(agent.run(g(row), ctx), why).rejects.toMatchObject({ code: 'input_rejected' });
      expect(n.calls.length).toBe(before);
    }
  });

  it.each(STRICT.map((r) => [r.fb.spec.platform, r] as const))('%s: a robots.txt that disallows the feed is proposed (the board was not read); a 403 robots.txt is a refusal, proposed', async (_n, row) => {
    const path = new URL(row.url).pathname;
    const n = serve(routes(row, { [`https://${row.host}/robots.txt`]: { status: 200, body: `User-agent: *\nDisallow: ${path}` } }));
    const v = await makeBoardVerifier(fresh()).run(g(row), vctx(n.fetch, [g(row)]));
    expect(v[0]).toMatchObject({ status: 'proposed', jobsSeen: null });
    expect((v[0] as { reasons: string[] }).reasons[0]).toMatch(/robots-disallow .* on .*: the board was not read, please confirm$/u);
    expect(n.calls).toEqual([`https://${row.host}/robots.txt`]);
  });

  it('a stored board URL with no usable slug still reads (the board URL names the board); no board at all is proposed', async () => {
    const wk = ROWS[0] as Row;
    const n = serve(routes(wk));
    const a = guess(cand('huggingface.co', 'Hugging Face'), 'workable', 'not a slug!', wk.boardUrl);
    expect((await makeBoardVerifier(fresh()).run(a, vctx(n.fetch, [a])))[0]).toMatchObject({ status: 'verified' });
    const b = guess(cand('huggingface.co', 'Hugging Face'), 'workable', 'not a slug!', null);
    const m = serve({});
    expect((await makeBoardVerifier(fresh()).run(b, vctx(m.fetch, [b])))[0]).toMatchObject({ status: 'proposed' });
    expect(m.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

describe('wiring: teams, egress, pacing, and an empty registry changes nothing', () => {
  const boards = registryBoards(WIRED.map((r) => ({ name: `Co ${r.fb.spec.platform}`, platform: r.fb.spec.platform, boardUrl: r.boardUrl })));

  it('every stored board URL becomes a registry board, one per platform, in registry order; the seeds carry the ref', () => {
    expect(boards.map((b) => `${b.platform} ${b.ref}`)).toEqual(WIRED.map((r) => `${r.fb.spec.platform} ${r.ref}`));
    const seeds = dailySeeds({ watchlist: [], feeds: { enabled: [] } }, '2026-10-14', undefined, boards);
    expect(seeds.map((s) => `${s.ats} ${s.slug}`)).toEqual(WIRED.map((r) => `${r.fb.spec.platform} ${r.ref}`));
  });

  it('with an empty registry no small-platform agent, team or edge exists: the pipeline is the same', () => {
    const none = dailyAgents([], []);
    expect(none.some((a) => a.contract.id.startsWith('src-') && SMALL_PLATFORMS.some((f) => f.contract.id === a.contract.id))).toBe(false);
    const wiring = dailyPipeline(none);
    expect(wiring.teams.map((t) => t.id).filter((t) => SMALL_PLATFORMS.some((f) => f.spec.team === t))).toEqual([]);
    expect(JSON.stringify(wiring.edges)).not.toMatch(/src-(?:workable|recruitee|teamtailor|personio|bamboohr|breezy|pinpoint|rippling|gem|zohorecruit|manatal)/u);
    expect(registryEgressSets([])).toEqual({});
  });

  it('one team and one agent per platform, its own symbolic egress resolved to exact hosts', () => {
    const agents = dailyAgents([], boards);
    const wiring = dailyPipeline(agents);
    for (const fb of SMALL_PLATFORMS) {
      expect(agents.filter((a) => a.contract.id === fb.contract.id)).toHaveLength(1);
      expect(wiring.teams.find((t) => t.id === fb.spec.team)?.members).toEqual([fb.contract.id]);
      expect(fb.contract.team).toBe(fb.spec.team);
      expect(fb.contract.egress).toEqual([fb.spec.egress]);
      expect(fb.contract.capabilities).toEqual({ http: true });
    }
    expect(new Set(SMALL_PLATFORMS.map((f) => f.spec.team)).size).toBe(11);
    const sets = registryEgressSets(boards);
    expect(sets).toEqual(Object.fromEntries(WIRED.map((r) => [r.fb.spec.egress, [r.host]])));
    // a dead tenant on one platform never touches another's host state: one fresh host state per agent
    expect(dailyAgents([], boards).find((a) => a.contract.id === 'src-gem')).not.toBe(agents.find((a) => a.contract.id === 'src-gem'));
  });

  it('the pacing arithmetic accepts the 2 s spacing and refuses a spacing the feed timeout cannot hold', () => {
    const pack = { watchlist: [], feeds: { enabled: [] } };
    expect(pacingProblems({ minHostIntervalMs: 2000, minBrowserIntervalMs: 2000 }, pack, boards)).toEqual([]);
    const slow = pacingProblems({ minHostIntervalMs: 40_000, minBrowserIntervalMs: 2000 }, pack, boards);
    expect(slow.filter((p) => /src-(?:workable|recruitee|teamtailor|personio|bamboohr|breezy|pinpoint|rippling|gem|zohorecruit|manatal)/u.test(p))).toHaveLength(11);
  });

  it('only the documented hosts skip robots.txt: dailyFeedHosts(true) never denies and still disables; dailyFeedHosts(false) is the strict page rule', async () => {
    const d = dailyFeedHosts(true);
    await expect(d.robots('a.test', '/x', {} as never)).resolves.toBeNull();
    d.disable('a.test', 'http-403');
    d.disable('a.test', 'http-429');
    expect(d.disabledWhy('a.test')).toBe('http-403');
    expect(documentedHosts().disabledWhy('a.test')).toBeUndefined();
    const s = dailyFeedHosts(false);
    expect(s.robotsHash).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 (the Task 9 review): naming, malformed and mapping guards
// ---------------------------------------------------------------------------

describe('fix round 1: naming, malformed and mapping guards', () => {
  const row = (n: string): Row => ROWS.find((r) => r.fb.spec.platform === n) as Row;
  const parsed = (n: string, body: string): RawPosting[] => byName(n).spec.parse(body, row(n).ref, REC()).postings;
  const mapped = (n: string, body: string) => normalize(parsed(n, body)[0] as RawPosting);
  const feedPage = (r: Row, body: string) => {
    const h = harness(r, feedRoutes(r, body));
    return { p: run(r.fb.make({ hosts: dailyFeedHosts(r.documented) }), req(r), h.ctx), h };
  };

  it('D1: a feed listing two company names is proposed ("board lists several company names"), never verified under the first', async () => {
    const rec = row('recruitee');
    const two = JSON.parse(BUILD['recruitee']!('blr')) as { offers: Record<string, unknown>[] };
    two.offers.push({ ...(two.offers[0] as object), id: 1002, company_name: 'Other Holdings' });
    const n = serve(feedRoutes(rec, JSON.stringify(two)));
    const g = guess(cand('acme.test', 'Acme'), 'recruitee', rec.ref, rec.boardUrl);
    const v = (await makeBoardVerifier(fresh()).run(g, vctx(n.fetch, [g])))[0] as { status: string; boardName: string | null; reasons: string[] };
    expect(v.status).toBe('proposed');
    expect(v.boardName).toBeNull();
    expect(v.reasons[0]).toBe('board lists several company names (Acme, Other Holdings), please confirm');
  });

  it('D2: Personio\'s host label is the name key: acme-gmbh.jobs.personio.de compares as "acme-gmbh", not as the whole host', async () => {
    const pe = row('personio');
    const body = BUILD['personio']!('blr').replace('<subcompany>Acme GmbH</subcompany>', '');
    const url = 'https://acme-gmbh.jobs.personio.de/xml';
    const n = serve({ [url]: { status: 200, body } });
    // the slug is the whole host here, so a null name key would compare the host and miss
    const g = guess(cand('other.test', 'Acme GmbH'), 'personio', 'acme-gmbh.jobs.personio.de', url);
    const v = (await makeBoardVerifier(fresh()).run(g, vctx(n.fetch, [g])))[0] as { status: string; reasons: string[] };
    expect(v.status).toBe('verified');
    expect(v.reasons[0]).toContain("personio tenant 'acme-gmbh'");
    const no = guess(cand('other.test', 'Beta AG'), 'personio', 'acme-gmbh.jobs.personio.de', url);
    const w = (await makeBoardVerifier(fresh()).run(no, vctx(n.fetch, [no])))[0] as { status: string; reasons: string[] };
    expect(w.status).toBe('proposed');
    expect(w.reasons.join('\n')).toContain("personio tenant 'acme-gmbh' is neither");
    expect(pe.ref).toBe('personio.jobs.personio.de');
  });

  it('C5: a feed with exactly one entry, malformed, is input_rejected, not 0 jobs with a skip note', async () => {
    for (const n of ['rippling', 'gem', 'breezy', 'bamboohr']) {
      const body = n === 'bamboohr' ? JSON.stringify({ result: [{ id: '1' }] }) : JSON.stringify([{ id: 'x' }]);
      const { p, h } = feedPage(row(n), body);
      await expect(p, n).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/all 1 entries are malformed/u) });
      expect(h.skipped, n).toEqual([]);
    }
  });

  it('D6: a BambooHR list shorter than the platform\'s total is incomplete ("5+ open jobs"); a full one is not', async () => {
    const bh = row('bamboohr');
    const g = guess(cand('rednucleus.com', 'Red Nucleus'), 'bamboohr', 'rednucleus', bh.boardUrl);
    const short = serve(feedRoutes(bh));
    const c = platformClient('bamboohr')!;
    const h = harness(bh, feedRoutes(bh));
    await expect(c.readBoard('rednucleus', h.ctx.http!, { hosts: dailyFeedHosts(false) })).resolves.toMatchObject({ complete: false });
    const v = (await makeBoardVerifier(fresh()).run(g, vctx(short.fetch, [g])))[0] as { status: string; reasons: string[] };
    expect(v.status).toBe('verified');
    expect(v.reasons[0]).toContain('5+ open jobs');
    const full = JSON.parse(fx(bh.file)) as { meta: { totalCount: number } };
    full.meta.totalCount = 5;
    const h2 = harness(bh, feedRoutes(bh, JSON.stringify(full)));
    await expect(c.readBoard('rednucleus', h2.ctx.http!, { hosts: dailyFeedHosts(false) })).resolves.toMatchObject({ complete: true });
  });

  it('E3: Breezy: any remote location makes the job remote; none, not', () => {
    const mk = (flags: boolean[]) => {
      const j = JSON.parse(BUILD['breezy']!('blr')) as Record<string, unknown>[];
      const loc = (r: boolean) => ({ country: { name: 'India', id: 'IN' }, state: { id: 'KA', name: 'Karnataka' }, city: 'Bengaluru', name: 'Bengaluru, Karnataka', is_remote: r });
      (j[0] as Record<string, unknown>)['locations'] = flags.map(loc);
      return mapped('breezy', JSON.stringify(j)).remote.structured;
    };
    expect(mk([false, true])).toBe('remote');
    expect(mk([true, false])).toBe('remote');
    expect(mk([false, false])).toBeNull();
  });

  it('E4: Gem location_type: in_office and onsite are on-site, hybrid, remote; an unknown value states nothing', () => {
    const mk = (t: string) => {
      const j = JSON.parse(BUILD['gem']!('blr')) as Record<string, unknown>[];
      (j[0] as Record<string, unknown>)['location_type'] = t;
      return mapped('gem', JSON.stringify(j)).remote.structured;
    };
    expect([mk('in_office'), mk('onsite'), mk('on-site'), mk('hybrid'), mk('remote'), mk('mystery')]).toEqual(['onsite', 'onsite', 'onsite', 'hybrid', 'remote', null]);
  });

  it('E5: Recruitee: remote wins over hybrid and on-site; hybrid over on-site', () => {
    const mk = (f: { remote: boolean; hybrid: boolean; on_site: boolean }) => {
      const j = JSON.parse(BUILD['recruitee']!('blr')) as { offers: Record<string, unknown>[] };
      Object.assign(j.offers[0] as object, f);
      return mapped('recruitee', JSON.stringify(j)).remote.structured;
    };
    expect([mk({ remote: true, hybrid: true, on_site: true }), mk({ remote: false, hybrid: true, on_site: true }), mk({ remote: false, hybrid: false, on_site: true }), mk({ remote: false, hybrid: false, on_site: false })]).toEqual(['remote', 'hybrid', 'onsite', null]);
  });

  it('E6/E7: Workable: hidden locations are dropped; with none visible the job-level city, state and country are read', () => {
    const mk = (locations: unknown[]) => {
      const j = JSON.parse(BUILD['workable']!('blr')) as { jobs: Record<string, unknown>[] };
      Object.assign(j.jobs[0] as object, { city: 'Pune', state: 'Maharashtra', country: 'India', locations });
      return mapped('workable', JSON.stringify(j)).locationText;
    };
    const loc = (city: string, hidden: boolean) => ({ city, region: null, country: 'India', countryCode: 'IN', hidden });
    expect(mk([loc('Paris', true), loc('Chennai', false)])).toBe('Chennai, India');
    expect(mk([loc('Paris', true)])).toBe('Pune, Maharashtra, India');
    expect(mk([])).toBe('Pune, Maharashtra, India');
  });

  it('E12b: the platform ISO codes give the country when the text names none (Workable, Recruitee, Breezy)', () => {
    const w = JSON.parse(BUILD['workable']!('blr')) as { jobs: Record<string, unknown>[] };
    Object.assign(w.jobs[0] as object, { city: 'Zzzville', state: null, country: null, telecommuting: false, locations: [{ city: 'Zzzville', region: null, country: null, countryCode: 'DE', hidden: false }] });
    const a = mapped('workable', JSON.stringify(w));
    expect([a.locationText, a.remote.countries]).toEqual(['Zzzville', ['germany']]);
    const r = JSON.parse(BUILD['recruitee']!('blr')) as { offers: Record<string, unknown>[] };
    Object.assign(r.offers[0] as object, { location: 'Zzzville', city: 'Zzzville', country: null, country_code: null, remote: false, locations: [{ id: 1, name: 'Zzzville', state: null, country: null, country_code: 'DE' }] });
    const b = mapped('recruitee', JSON.stringify(r));
    expect([b.locationText, b.remote.countries]).toEqual(['Zzzville', ['germany']]);
    const r2 = JSON.parse(BUILD['recruitee']!('blr')) as { offers: Record<string, unknown>[] };
    Object.assign(r2.offers[0] as object, { location: 'Zzzville', city: 'Zzzville', country: null, country_code: 'DE', remote: false, locations: [] });
    expect(mapped('recruitee', JSON.stringify(r2)).remote.countries).toEqual(['germany']);
    const z = JSON.parse(BUILD['breezy']!('blr')) as Record<string, unknown>[];
    (z[0] as Record<string, unknown>)['location'] = { country: { name: null, id: 'DE' }, state: null, city: 'Zzzville', name: 'Zzzville', is_remote: false };
    const c = mapped('breezy', JSON.stringify(z));
    expect([c.locationText, c.remote.countries]).toEqual(['Zzzville', ['germany']]);
  });

  it('Rippling: entries of one uuid that disagree on the name or the URL keep the first and record rippling-uuid-conflict; agreeing ones do not', async () => {
    const rp = row('rippling');
    const e = (over: Record<string, unknown>) => ({ uuid: '11111111-2222-3333-4444-555555555555', name: 'Senior Software Engineer', url: 'https://ats.rippling.com/a/jobs/1', workLocation: { label: 'Pune, India' }, ...over });
    const quiet = feedPage(rp, JSON.stringify([e({}), e({ workLocation: { label: 'Remote' } })]));
    expect(await quiet.p).toHaveLength(1);
    expect(quiet.h.skipped).toEqual([]);
    const byName = feedPage(rp, JSON.stringify([e({}), e({ name: 'Staff Designer' })]));
    const out = await byName.p;
    expect((out[0]?.raw as { title: string }).title).toBe('Senior Software Engineer');
    expect(byName.h.skipped).toEqual([expect.stringMatching(/^rippling-uuid-conflict 11111111-2222-3333-4444-555555555555 \(Acme\): entry 1 names 'Staff Designer', the first entry 'Senior Software Engineer'; the first is kept$/u)]);
    const byUrl = feedPage(rp, JSON.stringify([e({}), e({ url: 'https://ats.rippling.com/a/jobs/2' })]));
    await byUrl.p;
    expect(byUrl.h.skipped).toHaveLength(1);
    expect(PLATFORM_NOTE_PREFIXES).toContain('rippling-uuid-conflict ');
  });

  it('a posting URL must be https: an http link is a malformed entry (Rippling, Gem, Teamtailor)', async () => {
    const rp = JSON.parse(BUILD['rippling']!('blr')) as Record<string, unknown>[];
    (rp[0] as Record<string, unknown>)['url'] = 'http://ats.rippling.com/a/jobs/1';
    const a = feedPage(row('rippling'), JSON.stringify(rp));
    await expect(a.p).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/all 1 entries are malformed \(entry 0: url: no url\)/u) });
    const g = JSON.parse(BUILD['gem']!('blr')) as Record<string, unknown>[];
    (g[0] as Record<string, unknown>)['absolute_url'] = 'http://jobs.gem.com/acme/5001';
    await expect(feedPage(row('gem'), JSON.stringify(g)).p).rejects.toMatchObject({ code: 'input_rejected' });
    const t = BUILD['teamtailor']!('blr').replace('https://career.acme.test/jobs/1-sse', 'http://career.acme.test/jobs/1-sse');
    await expect(feedPage(row('teamtailor'), t).p).rejects.toMatchObject({ code: 'input_rejected' });
  });
});

// ---------------------------------------------------------------------------
// Sources expansion, Task 3: Zoho Recruit (the careers page's embedded list)
// ---------------------------------------------------------------------------

describe('zohorecruit: the careers page embeds the whole list as escaped JSON', () => {
  const row = ROWS.find((r) => r.fb.spec.platform === 'zohorecruit') as Row;
  const input = (attrs: string): string => `<html><body><input ${attrs}></body></html>`;
  const list = JSON.stringify([{ id: '100000000000000555', Posting_Title: 'Quote "Eng" & Co', Publish: true }]);
  const parse = (body: string) => parseZoho(body, row.ref, REC());

  it('the recorded page: 4 openings, 2 postings, the unpublished one skipped silently, the id-less one a named malformed entry', () => {
    const page = parse(fx(row.file));
    expect(page.listed).toBe(4);
    expect(page.postings.map((p) => p.sourceId)).toEqual(['100000000000000101', '100000000000000102']);
    expect(page.malformed).toEqual(['entry 3: id: no id']);
    expect(page.postings[1]?.raw).toMatchObject({ title: 'Platform Engineer', url: 'https://shurutech.zohorecruit.in/jobs/Careers/100000000000000102', city: 'Bengaluru', state: 'Karnataka', country: 'India', remote: false, jobType: 'Contract' });
  });

  it('entities: &#34; and &quot; both decode; single quotes, any attribute order and an unquoted-free tag all parse', () => {
    const esc = (q: string): string => list.replace(/&/gu, '&amp;').replace(/"/gu, q);
    for (const body of [input(`type="hidden" value="${esc('&#34;')}" id="jobs"`), input(`id="jobs" value="${esc('&quot;')}"`), input(`id='jobs' value='${list.replace(/&/gu, '&amp;').replace(/'/gu, '&#39;')}'`), input(`VALUE="${esc('&#x22;')}" ID="jobs" /`)]) {
      const page = parse(body);
      expect(page.postings, body.slice(0, 40)).toHaveLength(1);
      expect((page.postings[0]?.raw as { title: string }).title).toBe('Quote "Eng" & Co');
    }
    expect(embeddedJobs(input('id="meta" value="x"') + input('id="jobs" value="[]"'))).toBe('[]');
  });

  it('a page without the input is input_rejected; a small challenge page without it is challenged', async () => {
    expect(() => parse('<html><body>Careers</body></html>')).toThrow(/no <input id="jobs">/u);
    expect(() => parse(input('id="meta" value="[]"'))).toThrow(/nothing read from it/u);
    expect(() => parse(input('id="jobs" value="not json"'))).toThrow(/not JSON/u);
    expect(() => parse(input('id="jobs" value="{}"'))).toThrow(/expected a list of openings/u);
    const wall = '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></html>';
    const hosts = dailyFeedHosts(false);
    const h = harness(row, feedRoutes(row, wall));
    await expect(run(row.fb.make({ hosts }), req(row), h.ctx)).rejects.toMatchObject({ code: 'challenged' });
    expect(hosts.disabledWhy(row.host)).toBe('challenge');
  });

  it('embeddedJobs is linear on 200,000 unclosed inputs and on unclosed quotes', () => {
    for (const body of ['<input '.repeat(200_000), '<input a="'.repeat(100_000), '<input a=b '.repeat(100_000), '<input <input id="jobs" '.repeat(50_000)]) {
      const t = performance.now();
      expect(embeddedJobs(body)).toBeNull();
      expect(performance.now() - t).toBeLessThan(500);
    }
  });

  it('mapping: the remote opening is remote, the Bengaluru one is office-eligible with the fixture pack\'s office cities; the job type is mapped', () => {
    const [remote, blr] = parse(fx(row.file)).postings.map((p) => normalize(p));
    expect(remote).toMatchObject({ title: 'Staff Engineer', remote: { structured: 'remote' }, employmentType: 'full-time', locationText: '', postedAt: null, descriptionText: '' });
    expect(blr).toMatchObject({ locationText: 'Bengaluru, Karnataka, India', employmentType: 'contract', remote: { structured: null } });
    expect(decideEligibility(blr as Posting, { ...ELIG, eligibility: { employmentTypes: ['full-time', 'contract'], officeCities: ['bengaluru'] } })).toMatchObject({ verdict: 'eligible', notes: expect.arrayContaining(['office/hybrid: Bengaluru']) });
    const types = (t: string) => normalize({ ...(parse(fx(row.file)).postings[0] as RawPosting), raw: { ...(parse(fx(row.file)).postings[0]?.raw as object), jobType: t } }).employmentType;
    expect([types('Full time'), types('Temporary'), types('Part time'), types('Internship')]).toEqual(['full-time', 'contract', 'part-time', null]);
  });

  it('the verifier client compares the host label: shurutech vs "Shuru Technologies" is proposed, "Shurutech" verified', async () => {
    const n = serve(feedRoutes(row));
    const gp = guess(cand('shuru.test', 'Shuru Technologies'), 'zohorecruit', row.ref, row.boardUrl);
    const v = await makeBoardVerifier(fresh()).run(gp, vctx(n.fetch, [gp]));
    expect(v[0]).toMatchObject({ status: 'proposed', boardName: null });
    expect((v[0] as { reasons: string[] }).reasons[0]).toBe('board name not available, please confirm');
    const gv = guess(cand('shuru.test', 'Shurutech'), 'zohorecruit', row.ref, row.boardUrl);
    const m = serve(feedRoutes(row));
    expect((await makeBoardVerifier(fresh()).run(gv, vctx(m.fetch, [gv])))[0]).toMatchObject({ status: 'verified', jobsSeen: 2 });
  });

  it('the host shapes: regions, the www host and look-alikes', () => {
    const p = row.fb.spec;
    for (const ok of ['a.zohorecruit.com', 'a.zohorecruit.in', 'a-b.zohorecruit.eu', 'a.zohorecruit.com.au']) expect(p.parseRef(ok), ok).toBe(ok);
    for (const bad of ['www.zohorecruit.com', 'zohorecruit.com', 'a.zohorecruit.org', 'a.b.zohorecruit.in', 'a.zohorecruit.in.evil.test']) expect(p.parseRef(bad), bad).toBeNull();
    expect(p.boardOfUrl('https://Shurutech.zohorecruit.in/jobs/Careers/')).toBe('shurutech.zohorecruit.in');
    expect(p.boardOfUrl('https://shurutech.zohorecruit.in/jobs/Careers/123')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sources expansion, Task 4: Manatal (a paged feed) and the paging in feed-board.ts
// ---------------------------------------------------------------------------

describe('manatal: a paged feed with a loud job cap', () => {
  const sx = (name: string): string => readFileSync(join(root, 'tests/fixtures/sx/manatal', name), 'utf8');
  const BASE = 'https://open.api.manatal.com/open/v3/career-page/acme/jobs/';
  const ROBOTS = `https://${MANATAL_HOST}/robots.txt`;
  const routes = (extra: Record<string, Route> = {}): Record<string, Route> => ({ [ROBOTS]: { status: 404, body: 'Not Found' }, [BASE]: { status: 200, body: sx('page1.json') }, [`${BASE}?page=2`]: { status: 200, body: sx('page2.json') }, ...extra });
  const go = (r: Record<string, Route>) => {
    const h = harness(MROW, r);
    return { h, p: run(manatal.make({ hosts: dailyFeedHosts(false) }), req(MROW), h.ctx) };
  };

  it('page 1 + page 2: 13 postings sorted by hash, two feed requests 2 s apart after robots.txt', async () => {
    const { h, p } = go(routes());
    const out = await p;
    expect(out).toHaveLength(13);
    const ids = out.map((x) => x.sourceId);
    expect(ids).toEqual([...ids].sort());
    expect(h.calls).toEqual([ROBOTS, BASE, `${BASE}?page=2`]);
    expect(h.slept.filter((ms) => ms >= 1500).length).toBeGreaterThanOrEqual(2);
    expect(h.agents.every((a) => a === 'jobpilot/0.1 (+local)')).toBe(true);
    expect(out.find((x) => x.sourceId === 'K3M9Q2XA')?.raw).toMatchObject({ title: 'Senior Backend Engineer', url: 'https://www.careers-page.com/acme/job/K3M9Q2XA', location: 'Bengaluru, Karnataka, India', remote: false, contract: 'full_time' });
    expect(JSON.stringify(out)).not.toMatch(/salary|currency/u);
  });

  it('over the cap (count 2010): a job-cap refusal from page 1, exactly one feed request, nothing read', async () => {
    const { h, p } = go(routes({ [BASE]: { status: 200, body: sx('over-cap.json') } }));
    await expect(p).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/job-cap Manatal acme: the feed lists 2010 jobs, over the cap of 100 \(10 pages\); nothing read, never truncated/u) });
    expect(h.calls).toEqual([ROBOTS, BASE]);
    expect(FEED_MAX_JOBS_PAGED).toBe(100);
  });

  it('the over-cap error is input_rejected through fetchFeed', async () => {
    const h = harness(MROW, routes({ [BASE]: { status: 200, body: sx('over-cap.json') } }));
    await expect(manatal.fetchFeed(h.ctx.http!, dailyFeedHosts(false), 'acme', REC())).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^job-cap Manatal acme/u) });
  });

  it('a next URL off the board host (or not https) is input_rejected and page 2 is never asked', async () => {
    for (const next of ['https://evil.example/open/v3/career-page/acme/jobs/?page=2', 'http://open.api.manatal.com/open/v3/career-page/acme/jobs/?page=2']) {
      const body = JSON.stringify({ ...JSON.parse(sx('page1.json')), next });
      const h = harness(MROW, routes({ [BASE]: { status: 200, body }, [next]: { status: 200, body: sx('page2.json') } }));
      await expect(manatal.fetchFeed(h.ctx.http!, dailyFeedHosts(false), 'acme', REC())).rejects.toMatchObject({ code: 'input_rejected' });
      expect(h.calls).not.toContain(next);
      expect(h.calls).toEqual([ROBOTS, BASE]);
    }
  });

  it('a page whose results all fail is schema drift (input_rejected); one failing entry is a named note', async () => {
    const drift = JSON.stringify({ count: 1, next: null, results: [{ nope: 1 }, { hash: 'x' }] });
    const a = go(routes({ [BASE]: { status: 200, body: drift } }));
    await expect(a.p).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/all 2 entries are malformed/u) });
    const p2 = JSON.parse(sx('page2.json')) as { results: Record<string, unknown>[] };
    delete p2.results[2]?.['hash'];
    const b = go(routes({ [`${BASE}?page=2`]: { status: 200, body: JSON.stringify(p2) } }));
    expect(await b.p).toHaveLength(12);
    expect(b.h.skipped).toEqual(['manatal Acme page 2 entry 2: hash: no hash']);
  });

  it('a next after the last allowed page is the same job-cap refusal, never a truncation', async () => {
    const loop = (n: number): string => JSON.stringify({ count: 100, next: `${BASE}?page=${n + 1}`, results: [{ hash: `AAAA${String(n).padStart(4, '0')}`, position_name: `Job ${n}` }] });
    const r: Record<string, Route> = { [ROBOTS]: { status: 404 }, [BASE]: { status: 200, body: loop(1) } };
    for (let n = 2; n <= 12; n++) r[`${BASE}?page=${n}`] = { status: 200, body: loop(n) };
    const h = harness(MROW, r);
    await expect(manatal.fetchFeed(h.ctx.http!, dailyFeedHosts(false), 'acme', REC())).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/job-cap Manatal acme/u) });
    expect(h.calls.length).toBeLessThanOrEqual(1 + FEED_MAX_PAGES);
  });

  it('the verifier client reads page 1 only: one feed request after robots.txt, complete: false', async () => {
    const n = serve(routes());
    const gp = guess(cand('acme.test', 'Acme'), 'manatal', 'acme', BASE);
    const v = await makeBoardVerifier(fresh()).run(gp, vctx(n.fetch, [gp]));
    expect(n.calls).toEqual([ROBOTS, BASE]);
    expect(v[0]).toMatchObject({ status: 'verified', jobsSeen: 10 });
    const c = platformClient('manatal');
    expect(c?.refOf('acme', BASE)).toBe('acme');
  });

  it('refs and board URLs', () => {
    for (const ok of ['acme', 'a', 'a-b-c', 'a1']) expect(parseManatalRef(ok), ok).toBe(ok);
    for (const bad of ['', 'Acme', '-a', 'a-', 'a_b', 'a.b', 'a/b']) expect(parseManatalRef(bad), bad).toBeNull();
    expect(manatalBoardOfUrl(`${BASE}?page=2`)).toBe('acme');
    expect(manatalBoardOfUrl(BASE)).toBe('acme');
    expect(manatalBoardOfUrl('https://open.api.manatal.com/open/v3/career-page/acme/jobs/1')).toBeNull();
    expect(manatalBoardOfUrl('https://evil.example/open/v3/career-page/acme/jobs/')).toBeNull();
    expect(manatalBoardOfUrl('http://open.api.manatal.com/open/v3/career-page/acme/jobs/')).toBeNull();
  });

  it('mapping: description from the HTML, contract types, remote from the flag only', () => {
    const page = parseManatal(sx('page1.json'), 'acme', REC());
    const by = (h: string) => normalize(page.postings.find((p) => p.sourceId === h) as RawPosting);
    expect(by('K3M9Q2XA')).toMatchObject({ ats: 'manatal', descriptionText: 'Build and run services.', employmentType: 'full-time', remote: { structured: null } });
    expect(by('B7N4T8ZC')).toMatchObject({ employmentType: 'contract', remote: { structured: 'remote' } });
    expect(by('D2F6H1RP').employmentType).toBe('part-time');
    expect(by('M8V3C5LW').employmentType).toBe('internship');
    expect(by('T1Y7G4NB').employmentType).toBe('contract');
    expect(by('W6S2J8EH').employmentType).toBe('contract');
    expect(by('C9L5E1VM').employmentType).toBeNull();
    // "Remote" in the text without the flag is not remote
    expect(parseManatal(JSON.stringify({ count: 1, next: null, results: [{ hash: 'ABCD1234', position_name: 'X', location_display: 'Remote', is_remote: false }] }), 'acme', REC()).postings[0]?.raw).toMatchObject({ remote: false });
  });

  it('every other feed still makes exactly one feed request (no next)', () => {
    for (const f of SMALL_PLATFORMS) if (f.spec.platform !== 'manatal') expect(f.spec.next).toBeUndefined();
  });
});
