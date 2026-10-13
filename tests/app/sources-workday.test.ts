import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decideEligibility, type EligibilityPack } from '../../src/app/agents/eligibility.js';
import { normalize } from '../../src/app/agents/normalizer.js';
import {
  indiaFacet,
  makeSrcWorkday,
  parseListPage,
  parseWorkdayRef,
  reqIdOf,
  srcWorkdayContract,
  titlePasses,
  workdayBoardOfUrl,
  workdayDetailUrl,
  workdayJobUrl,
  workdayListUrl,
  WORKDAY_MIN_INTERVAL_MS,
  type WorkdayHosts,
  type WorkdayRaw,
} from '../../src/app/agents/sources/platforms/workday.js';
import { dailyWorkdayHosts } from '../../src/app/daily-hosts.js';
import { Posting, RawPosting, type DiscoveryRequest } from '../../src/app/types.js';
import { createHostPacer, issueContext } from '../../src/kernel/broker.js';
import { KernelError } from '../../src/kernel/errors.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import type { FetchLike } from '../../src/kernel/providers.js';

interface Fixture {
  readonly board: string;
  readonly robots: string;
  readonly pages: { total: number; jobPostings: { title: string; externalPath: string; locationsText?: string; bulletFields?: string[] }[]; facets?: unknown[] }[];
  readonly indiaPages?: Fixture['pages'];
  readonly indiaFacet?: Record<string, string[]>;
  readonly details: Record<string, { jobPostingInfo: Record<string, unknown> }>;
}
const fixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`../fixtures/sources/workday-${name}.json`, import.meta.url), 'utf8')) as Fixture;

const PACK = { filters: { roleDeny: ['\\bqa\\b', '\\bintern(ship)?\\b', 'designer', 'hardware engineer', '^manager\\b'] }, targets: { titles: ['software engineer', 'senior engineer', 'staff engineer', 'lead engineer'] } };

type Posted = { title: string; externalPath: string; locationsText?: string; bulletFields?: string[] };
interface Board {
  readonly host: string;
  readonly tenant: string;
  readonly site: string;
  /** Every job, in list order. */
  readonly jobs: readonly Posted[];
  /** The `total` the first page reports (default: the job count). Later pages report 0, as Workday does. */
  readonly total?: number;
  /** Past this offset Workday serves the first page again (its 2000 ceiling); default never. */
  readonly wrapAt?: number;
  /** The scoped list served for a request with any applied facet. */
  readonly scoped?: { readonly jobs: readonly Posted[]; readonly total?: number };
  readonly facets?: unknown[];
  readonly robots?: { readonly status?: number; readonly body: string };
  readonly details?: Readonly<Record<string, unknown>>;
  /** Status for any list request (401, 403, 429, 404, ...). */
  readonly listStatus?: number;
  readonly ignoreOffset?: boolean;
  /** Serve a plain detail for any listed job not in `details`. */
  readonly anyDetail?: boolean;
}

/** A fake Workday host: robots.txt, the CXS list (POST, paged by offset) and job details (GET). */
function workday(boards: readonly Board[]) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ method: init.method ?? 'GET', url, ...(init.body !== undefined ? { body: JSON.parse(init.body) as unknown } : {}) });
    const u = new URL(url);
    const ok = (o: unknown) => ({ status: 200, text: async () => JSON.stringify(o) });
    const nf = { status: 404, text: async () => 'not found' };
    for (const b of boards) {
      if (u.hostname !== b.host) continue;
      if (u.pathname === '/robots.txt') return { status: b.robots?.status ?? 200, text: async () => b.robots?.body ?? 'User-agent: *\nDisallow: /refreshFacet/\n' };
      const base = `/wday/cxs/${b.tenant}/${b.site}`;
      if (init.method === 'POST' && u.pathname === `${base}/jobs`) {
        if (b.listStatus !== undefined) return { status: b.listStatus, text: async () => '' };
        const q = JSON.parse(init.body ?? '{}') as { offset: number; limit: number; appliedFacets: Record<string, unknown> };
        expect(q.limit).toBe(20);
        const scoped = Object.keys(q.appliedFacets).length > 0;
        const jobs = scoped ? (b.scoped?.jobs ?? []) : b.jobs;
        const total = scoped ? (b.scoped?.total ?? jobs.length) : (b.total ?? jobs.length);
        let offset = b.ignoreOffset === true ? 0 : q.offset;
        if (b.wrapAt !== undefined && offset >= b.wrapAt) offset = 0;
        return ok({ total: q.offset === 0 ? total : 0, jobPostings: jobs.slice(offset, offset + 20), ...(q.offset === 0 && !scoped && b.facets ? { facets: b.facets } : {}) });
      }
      if ((init.method ?? 'GET') === 'GET' && u.pathname.startsWith(`${base}/job/`)) {
        const path = u.pathname.slice(base.length);
        const listed = b.jobs.find((j) => j.externalPath === path);
        const d = b.details?.[path] ?? (b.anyDetail === true && listed !== undefined ? detail(listed.title) : undefined);
        if (d === undefined) return nf;
        if (typeof d === 'number') return { status: d, text: async () => '' };
        return ok(d);
      }
    }
    return nf;
  };
  return { fetch, calls };
}

const job = (i: number, title = `Senior Software Engineer ${i}`, locationsText = 'India, Bengaluru'): Posted => ({ title, externalPath: `/job/India-Bengaluru/Job-${i}_JR${1000 + i}`, locationsText, bulletFields: [`JR${1000 + i}`] });
const jobs = (n: number, title?: (i: number) => string, where?: (i: number) => string): Posted[] => Array.from({ length: n }, (_, i) => job(i, title?.(i), where?.(i)));
const detail = (title: string, more: Record<string, unknown> = {}) => ({ jobPostingInfo: { title, jobDescription: `<p>${title}: build services in Java.</p>`, location: 'India, Bengaluru', timeType: 'Full time', country: { descriptor: 'India' }, ...more } });

const HOST = 'acme.wd5.myworkdayjobs.com';
const board = (b: Partial<Board> = {}): Board => ({ host: HOST, tenant: 'acme', site: 'External', jobs: [], ...b });
const reqFor = (b: { host: string; tenant: string; site: string }, company = 'Acme'): DiscoveryRequest => ({ ats: 'workday', slug: `${b.host}/${b.tenant}/${b.site}`, company, runDate: '2026-10-14' });

/** A step context like the supervisor's: the registry hosts as egress, the pack, a host pacer on a moving clock. */
function context(fetch: FetchLike, hosts: readonly string[], pack: unknown = PACK) {
  let now = Date.parse('2026-10-14T01:30:00Z');
  const clock = { now: () => new Date(now).toISOString() };
  const slept: number[] = [];
  const hostPacer = createHostPacer(PRODUCT_POLICY_V1.minHostIntervalMs, clock, async (ms) => {
    slept.push(ms);
    now += ms;
  });
  const ctx = issueContext({
    contract: srcWorkdayContract,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: { fetch },
    clock,
    signal: new AbortController().signal,
    egressSets: { 'registry:workday-hosts': [...hosts] },
    pack,
    hostPacer,
  });
  return { ctx, slept };
}

async function runOn(boards: readonly Board[], opts: { maxPages?: number; maxDetails?: number; hosts?: WorkdayHosts; pack?: unknown; req?: DiscoveryRequest } = {}) {
  const net = workday(boards);
  const hosts = opts.hosts ?? dailyWorkdayHosts();
  const agent = makeSrcWorkday({ hosts, ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}), ...(opts.maxDetails !== undefined ? { maxDetails: opts.maxDetails } : {}) });
  const { ctx, slept } = context(net.fetch, [...new Set(boards.map((b) => b.host))], opts.pack ?? PACK);
  const b0 = boards[0] as Board;
  const out = await agent.run(opts.req ?? reqFor(b0), ctx);
  return { out, calls: net.calls, skips: ctx.skips(), slept, ctx, hosts, agent };
}

const lists = (calls: { method: string; url: string; body?: unknown }[]) => calls.filter((c) => c.method === 'POST');
const detailsOf = (calls: { method: string; url: string }[]) => calls.filter((c) => c.method === 'GET' && c.url.includes('/job/'));

describe('Workday board refs and URLs', () => {
  it('builds the CXS list and detail URLs and the public job URL', () => {
    const b = parseWorkdayRef('nvidia.wd5.myworkdayjobs.com/nvidia/NVIDIAExternalCareerSite');
    expect(b).toEqual({ host: 'nvidia.wd5.myworkdayjobs.com', tenant: 'nvidia', site: 'NVIDIAExternalCareerSite' });
    if (b === null) throw new Error('no board');
    expect(workdayListUrl(b)).toBe('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs');
    const path = '/job/India-Bengaluru/Senior-DevOps-Engineer_JR2026776';
    expect(workdayDetailUrl(b, path)).toBe('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/India-Bengaluru/Senior-DevOps-Engineer_JR2026776');
    expect(workdayJobUrl(b, path)).toBe('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/India-Bengaluru/Senior-DevOps-Engineer_JR2026776');
    // the recorded detail's own externalUrl is the URL we build
    const d = fixture('nvidia').details[path];
    expect(d?.jobPostingInfo['externalUrl']).toBe(workdayJobUrl(b, path));
    const site = parseWorkdayRef('wd3.myworkdaysite.com/acme/Careers');
    expect(site === null ? null : workdayJobUrl(site, '/job/X_R1')).toBe('https://wd3.myworkdaysite.com/recruiting/acme/Careers/job/X_R1');
  });

  it('reads the board from a stored board URL, and refuses anything else', () => {
    expect(workdayBoardOfUrl('https://mastercard.wd1.myworkdayjobs.com/wday/cxs/mastercard/CorporateCareers/jobs')).toEqual({ host: 'mastercard.wd1.myworkdayjobs.com', tenant: 'mastercard', site: 'CorporateCareers' });
    for (const bad of ['https://evil.test/wday/cxs/a/b/jobs', 'http://a.wd1.myworkdayjobs.com/wday/cxs/a/b/jobs', 'https://a.wd1.myworkdayjobs.com/a/b', 'not a url', 'https://a.wd1.myworkdayjobs.com/wday/cxs/a/b/c/jobs']) expect(workdayBoardOfUrl(bad), bad).toBeNull();
    for (const bad of ['a.wd1.myworkdayjobs.com/a', 'evil.test/a/b', 'a.wd1.myworkdayjobs.com/a/b/c', 'a.wd1.myworkdayjobs.com/../b']) expect(parseWorkdayRef(bad), bad).toBeNull();
  });

  it('takes the req id from the bullet field the externalPath ends with (a re-post too), else none', () => {
    expect(reqIdOf({ externalPath: '/job/Israel-Yokneam/Senior-Board-Design-Hardware-Engineer_JR2027490-1', bulletFields: ['JR2027490'] })).toBe('JR2027490');
    expect(reqIdOf({ externalPath: '/job/Pune-India/Lead-Technical-Program-Manager_R-292398-1', bulletFields: ['R-292398'] })).toBe('R-292398');
    expect(reqIdOf({ externalPath: '/job/X/Y_JR1', bulletFields: ['Pune, India', 'JR1'] })).toBe('JR1');
    expect(reqIdOf({ externalPath: '/job/X/Y_JR1', bulletFields: ['JR2'] })).toBeNull();
    expect(reqIdOf({ externalPath: '/job/X/Y_JR1' })).toBeNull();
  });
});

describe('src-workday paging', () => {
  it('pages by offset until offset >= the first page total (total is reported on page 1 only)', async () => {
    const { out, calls } = await runOn([board({ jobs: jobs(45, () => 'Account Executive') })]);
    expect(lists(calls).map((c) => (c.body as { offset: number }).offset)).toEqual([0, 20, 40]);
    expect(lists(calls).every((c) => JSON.stringify(c.body) === JSON.stringify({ appliedFacets: {}, limit: 20, offset: (c.body as { offset: number }).offset, searchText: '' }))).toBe(true);
    expect(out).toHaveLength(45);
    for (const p of out) expect(RawPosting.schema.safeParse(p).success).toBe(true);
    // sorted by sourceId, the req id
    expect(out[0]?.sourceId).toBe('JR1000');
  });

  it('stops on an empty page before the total, with a named note', async () => {
    const { out, skips } = await runOn([board({ jobs: jobs(25, () => 'Account Executive'), total: 60 })]);
    expect(out).toHaveLength(25);
    expect(skips).toEqual(['short-list Acme: total 60, listed 25']);
  });

  it('cap: a list longer than the page cap fails loudly, never truncated', async () => {
    const err = await runOn([board({ jobs: jobs(70, () => 'Account Executive') })], { maxPages: 3 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KernelError);
    expect(err).toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/page cap reached at 60 postings \(total 70, 3 pages\)/) });
  });

  it('a page repeating earlier postings (Workday ignoring the offset) fails loudly', async () => {
    const err = await runOn([board({ jobs: jobs(45, () => 'Account Executive'), ignoreOffset: true })]).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/offset 20 repeats earlier postings/) });
  });

  it("Workday's 2000 ceiling: the list is re-read scoped to the India location facet, with a named note", async () => {
    const facets = fixture('nvidia').pages[0]?.facets ?? [];
    const page = parseListPage({ total: 2000, jobPostings: [], facets }, 'nvidia');
    // the country-level value of the recorded NVIDIA facets
    expect(indiaFacet(page)).toEqual({ locationHierarchy1: ['2fcb99c455831013ea52b82135ba3266'] });
    const { out, calls, skips } = await runOn([board({ jobs: jobs(40, () => 'Account Executive', () => 'US, CA, Santa Clara'), total: 2000, wrapAt: 2000, facets, scoped: { jobs: jobs(30, () => 'Account Executive') } })]);
    expect(lists(calls).map((c) => c.body)).toEqual([
      { appliedFacets: {}, limit: 20, offset: 0, searchText: '' },
      { appliedFacets: { locationHierarchy1: ['2fcb99c455831013ea52b82135ba3266'] }, limit: 20, offset: 0, searchText: '' },
      { appliedFacets: { locationHierarchy1: ['2fcb99c455831013ea52b82135ba3266'] }, limit: 20, offset: 20, searchText: '' },
    ]);
    expect(out).toHaveLength(30);
    expect(skips).toEqual(['scope Acme: India location facet only (Workday reports its 2000 ceiling)']);
  });

  it('the ceiling with no India facet, or a scoped list still at the ceiling, fails loudly', async () => {
    const none = await runOn([board({ jobs: jobs(20, () => 'Account Executive'), total: 2000, facets: [] })]).catch((e: unknown) => e);
    expect(none).toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/no India location facet/) });
    const facets = [{ facetParameter: 'locations', values: [{ descriptor: 'Pune, India', id: 'p', count: 3000 }, { descriptor: 'Gurgaon, India', id: 'g', count: 1 }, { descriptor: 'Lisbon, Portugal', id: 'l', count: 1 }] }];
    expect(indiaFacet(parseListPage({ total: 2000, jobPostings: [], facets }, 'x'))).toEqual({ locations: ['p', 'g'] });
    const still = await runOn([board({ jobs: jobs(20, () => 'Account Executive'), total: 2000, facets, scoped: { jobs: jobs(20, () => 'Account Executive'), total: 2000 } })]).catch((e: unknown) => e);
    expect(still).toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/still reports Workday's 2000 ceiling/) });
  });

  it('a response missing an expected field is invalid_output, never partially parsed', async () => {
    expect(() => parseListPage({ jobPostings: [] }, 'workday x')).toThrow(/workday x list: response shape is not valid \(total/);
    expect(() => parseListPage({ total: 3 }, 'workday x')).toThrow(/\(jobPostings/);
    // a page whose every entry lacks a title or path is drift, not an empty page
    expect(() => parseListPage({ total: 2, jobPostings: [{ bulletFields: ['R-1'] }, { title: 'x' }] }, 'workday x')).toThrow(/all 2 entries lack a title or a \/job\/ externalPath/);
    const noDescription = { jobPostingInfo: { title: 'Senior Software Engineer 0' } };
    await expect(runOn([board({ jobs: jobs(1), details: { [job(0).externalPath]: noDescription } })])).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/detail: response shape is not valid \(jobPostingInfo\.jobDescription/) });
  });

  it('a list entry that is not a posting (seen live: a bare bulletFields) is skipped with a note, counted as listed', async () => {
    const list = [...jobs(3, () => 'Account Executive'), { bulletFields: ['R-290229'] } as unknown as Posted];
    const { out, skips } = await runOn([board({ jobs: list })]);
    expect(out).toHaveLength(3);
    expect(skips).toEqual(['workday Acme offset 0 entry 3: no title or /job/ externalPath']);
  });

  it('one req posted twice is one posting (the req id is the sourceId); without a req id the path is', async () => {
    const twice: Posted[] = [
      { title: 'Account Executive', externalPath: '/job/A/Account-Executive_JR7', locationsText: 'India, Pune', bulletFields: ['JR7'] },
      { title: 'Account Executive', externalPath: '/job/B/Account-Executive_JR7-1', locationsText: 'India, Mumbai', bulletFields: ['JR7'] },
      { title: 'Account Executive', externalPath: '/job/C/Account-Executive_X', locationsText: 'India, Mumbai' },
    ];
    const { out, skips } = await runOn([board({ jobs: twice })]);
    expect(out.map((p) => p.sourceId)).toEqual(['/job/C/Account-Executive_X', 'JR7']);
    expect((out[1]?.raw as WorkdayRaw).externalPath).toBe('/job/A/Account-Executive_JR7');
    // three listed for a total of three: not a short list, though two are one posting
    expect(skips).toEqual([]);
  });

  it('a retired board (404) is gone', async () => {
    await expect(runOn([board({ listStatus: 404 })])).rejects.toMatchObject({ code: 'gone' });
  });

  it('answers only workday requests', async () => {
    const agent = makeSrcWorkday({ hosts: dailyWorkdayHosts() });
    const { ctx } = context(workday([]).fetch, []);
    await expect(agent.run({ ats: 'greenhouse', slug: 'x', company: 'X', runDate: '2026-10-14' }, ctx)).resolves.toEqual([]);
  });
});

describe('src-workday details: the title pre-filter and the per-company budget', () => {
  it('the cheap title pre-filter: no roleDeny pattern, and every word of one target title', () => {
    expect(titlePasses('Senior DevOps Engineer', PACK)).toBe(true);
    expect(titlePasses('Lead Software Engineer, Python/Flask', PACK)).toBe(true);
    expect(titlePasses('Software QA Engineer', PACK)).toBe(false);
    expect(titlePasses('Software Engineering Intern', PACK)).toBe(false);
    expect(titlePasses('Account Executive', PACK)).toBe(false);
    expect(titlePasses('Account Executive', { filters: { roleDeny: [] }, targets: { titles: [] } })).toBe(true);
  });

  it('budget stop: details for the first N passing jobs only, a named note for the rest, and every job still flows', async () => {
    const list = [...jobs(5), ...jobs(3, () => 'Account Executive').map((j, i) => ({ ...j, externalPath: `/job/X/AE_JR${2000 + i}`, bulletFields: [`JR${2000 + i}`] }))];
    const details = Object.fromEntries(list.map((j) => [j.externalPath, detail(j.title)]));
    const { out, calls, skips } = await runOn([board({ jobs: list, details })], { maxDetails: 2 });
    expect(detailsOf(calls).map((c) => c.url.split('_').pop())).toEqual(['JR1000', 'JR1001']);
    expect(skips).toEqual(['detail-budget Acme: 3 jobs without detail']);
    expect(out).toHaveLength(8);
    expect(out.filter((p) => (p.raw as WorkdayRaw).detail !== null).map((p) => p.sourceId)).toEqual(['JR1000', 'JR1001']);
  });

  it('locations naming India get the details first, then those naming no country, then the rest', async () => {
    const list: Posted[] = [
      { ...job(0), locationsText: 'US, CA, Santa Clara' },
      { ...job(1), locationsText: '2 Locations' },
      { ...job(2), locationsText: 'Israel, Yokneam' },
      { ...job(3), locationsText: 'California - San Francisco' },
      { ...job(4), locationsText: 'India - Bangalore' },
      { ...job(5), locationsText: 'Bangalore, Karnataka, India' },
    ];
    const details = Object.fromEntries(list.map((j) => [j.externalPath, detail(j.title)]));
    const { calls, skips } = await runOn([board({ jobs: list, details })], { maxDetails: 3 });
    expect(detailsOf(calls).map((c) => c.url.split('_').pop())).toEqual(['JR1004', 'JR1005', 'JR1001']);
    expect(skips).toEqual(['detail-budget Acme: 3 jobs without detail']);
  });

  it('a detail that answers 404 is a gone job: dropped, with one named note', async () => {
    const { out, skips } = await runOn([board({ jobs: jobs(2), details: { [job(0).externalPath]: detail(job(0).title) } })]);
    expect(out.map((p) => p.sourceId)).toEqual(['JR1000']);
    expect(skips).toEqual(['detail-gone Acme: 1 job gone between list and detail (JR1001)']);
  });

  it('every request to the host is at least 2 s after the previous one', async () => {
    const list = jobs(25);
    const details = Object.fromEntries(list.map((j) => [j.externalPath, detail(j.title)]));
    const { calls, slept } = await runOn([board({ jobs: list, details })], { maxDetails: 3 });
    // robots.txt, 2 list pages, 3 details: five waits of the Workday spacing (the policy's own is 1 s)
    expect(calls).toHaveLength(6);
    expect(slept).toEqual([2000, 2000, 2000, 2000, 2000]);
    expect(WORKDAY_MIN_INTERVAL_MS).toBe(2000);
  });
});

describe('src-workday robots.txt and refusals', () => {
  it('a robots.txt disallowing the CXS path is a named skip for the company today: nothing else is fetched', async () => {
    const { out, calls, skips } = await runOn([board({ jobs: jobs(3), robots: { body: 'User-agent: *\nDisallow: /wday/\n' } })]);
    expect(out).toEqual([]);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /robots.txt']);
    expect(skips).toEqual(['robots-disallow acme.wd5.myworkdayjobs.com: Acme not read today (robots-disallow /wday/cxs/acme/External/jobs)']);
  });

  it('a forbidden (401/403) or unavailable (5xx) robots.txt is a skip too; a 404 robots.txt allows all', async () => {
    for (const [status, why] of [[403, 'robots-forbidden'], [500, 'robots-unavailable']] as const) {
      const { out, skips } = await runOn([board({ jobs: jobs(1), robots: { status, body: '' } })]);
      expect(out).toEqual([]);
      expect(skips[0]).toContain(`(${why})`);
    }
    const { out } = await runOn([board({ jobs: jobs(1, () => 'Account Executive'), robots: { status: 404, body: '' } })]);
    expect(out).toHaveLength(1);
  });

  it('robots.txt is fetched once per host per run, shared by the companies on that host', async () => {
    const hosts = dailyWorkdayHosts();
    const a = board({ site: 'External', jobs: jobs(1, () => 'Account Executive') });
    const b = board({ site: 'Campus', jobs: jobs(1, () => 'Account Executive') });
    const net = workday([a, b]);
    const agent = makeSrcWorkday({ hosts });
    const { ctx } = context(net.fetch, [HOST]);
    await agent.run(reqFor(a), ctx);
    await agent.run(reqFor(b, 'Acme Campus'), ctx);
    expect(net.calls.filter((c) => c.url.endsWith('/robots.txt'))).toHaveLength(1);
    expect(lists(net.calls)).toHaveLength(2);
  });

  it('403 on the list: challenged, the host disabled for the run; the next company on that host is deferred without a request', async () => {
    const hosts = dailyWorkdayHosts();
    const a = board({ site: 'External', listStatus: 403 });
    const b = board({ site: 'Campus', jobs: jobs(1) });
    const net = workday([a, b]);
    const agent = makeSrcWorkday({ hosts });
    const { ctx } = context(net.fetch, [HOST]);
    await expect(agent.run(reqFor(a), ctx)).rejects.toMatchObject({ code: 'challenged', message: expect.stringMatching(/answered 403: the host is disabled for this run, never retried around/) });
    const before = net.calls.length;
    await expect(agent.run(reqFor(b), ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^host-disabled:http-403 on acme\.wd5\.myworkdayjobs\.com/) });
    expect(net.calls.length).toBe(before);
    expect(hosts.disabledWhy(HOST)).toBe('http-403');
  });

  it('429: rate_limit, the host disabled, and the contract never retries a rate limit', async () => {
    const { ctx } = context(workday([board({ listStatus: 429 })]).fetch, [HOST]);
    const hosts = dailyWorkdayHosts();
    await expect(makeSrcWorkday({ hosts }).run(reqFor(board()), ctx)).rejects.toMatchObject({ code: 'rate_limit' });
    expect(hosts.disabledWhy(HOST)).toBe('http-429');
    expect(srcWorkdayContract.retry.on).not.toContain('rate_limit');
    expect(srcWorkdayContract.team).toBe('sourcing-workday');
  });

  it('a host outside the run egress is refused by the broker (exact hosts only)', async () => {
    const net = workday([board({ jobs: jobs(1) })]);
    const { ctx } = context(net.fetch, ['other.wd1.myworkdayjobs.com']);
    await expect(makeSrcWorkday({ hosts: dailyWorkdayHosts() }).run(reqFor(board()), ctx)).rejects.toThrow(/G-EGRESS/);
    expect(net.calls).toEqual([]);
  });
});

/** The eligibility rules of the user's kind: remote from India, or a Bengaluru office. */
const ELIG: EligibilityPack = {
  filters: { roleDeny: [], companyDeny: [], employmentDeny: [] },
  eligibility: { employmentTypes: ['full-time'], officeCities: ['bengaluru'] },
  watchlist: [],
  offers: { floor: null },
  fx: { toINR: { INR: 1, USD: 85, EUR: 92, GBP: 108 } },
};

function posting(raw: Partial<WorkdayRaw> & { detail?: WorkdayRaw['detail'] }): ReturnType<typeof normalize> {
  const r: WorkdayRaw = { title: 'Senior Software Engineer', url: 'https://acme.wd5.myworkdayjobs.com/External/job/X/Y_JR1', externalPath: '/job/X/Y_JR1', locationsText: '', reqId: 'JR1', detail: null, ...raw };
  const p = normalize({ source: 'workday', sourceId: 'JR1', company: 'Acme', slug: 'acme.wd5.myworkdayjobs.com/acme/External', raw: r });
  expect(Posting.schema.safeParse(p).success).toBe(true);
  return p;
}

describe('Workday postings: mapping and the existing eligibility', () => {
  it('maps the recorded NVIDIA detail into Posting fields; the relative date is null', async () => {
    const fx = fixture('nvidia');
    const path = '/job/India-Bengaluru/Senior-DevOps-Engineer_JR2026776';
    const net = workday([{ host: 'nvidia.wd5.myworkdayjobs.com', tenant: 'nvidia', site: 'NVIDIAExternalCareerSite', jobs: [...(fx.pages[0]?.jobPostings ?? []), ...(fx.pages[1]?.jobPostings ?? [])], total: 40, robots: { body: fx.robots }, details: fx.details, anyDetail: true }]);
    const agent = makeSrcWorkday({ hosts: dailyWorkdayHosts() });
    const { ctx } = context(net.fetch, ['nvidia.wd5.myworkdayjobs.com']);
    const out = await agent.run(reqFor({ host: 'nvidia.wd5.myworkdayjobs.com', tenant: 'nvidia', site: 'NVIDIAExternalCareerSite' }, 'NVIDIA'), ctx);
    expect(out).toHaveLength(40);
    const devops = out.find((p) => p.sourceId === 'JR2026776');
    expect((devops?.raw as WorkdayRaw).detail).not.toBeNull();
    // nothing request-time in raw: the relative "Posted Today" is not kept
    expect(JSON.stringify(devops?.raw)).not.toMatch(/Posted/);
    const p = normalize(devops as RawPosting);
    expect(p).toMatchObject({
      ats: 'workday',
      source: 'workday',
      title: 'Senior DevOps Engineer',
      url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/India-Bengaluru/Senior-DevOps-Engineer_JR2026776',
      locationText: 'India, Bengaluru',
      employmentType: 'Full time',
      postedAt: null,
    });
    expect(p.remote.countries).toEqual(['india']);
    expect(p.descriptionText).toMatch(/HPC Infrastructure/);
    expect(decideEligibility(p, ELIG)).toMatchObject({ verdict: 'eligible', notes: expect.arrayContaining(['office/hybrid: Bengaluru']) });
  });

  it('Salesforce remoteType: "Office - Based" is onsite, "Office Tech-Flexible" hybrid, both kept as signals', () => {
    const fx = fixture('salesforce');
    const india = fx.details['/job/India---Bangalore/Principal-Sales-Support-Engineer--ES-_JR354838']?.jobPostingInfo as Record<string, unknown>;
    const p = posting({ detail: { title: String(india['title']), description: String(india['jobDescription']), location: String(india['location']), additionalLocations: [], country: 'IN', remoteType: String(india['remoteType']), timeType: 'Full time' } });
    expect(p.remote.structured).toBe('onsite');
    expect(p.remote.signals).toContain('remoteType:Office - Based');
    expect(decideEligibility(p, ELIG)).toMatchObject({ verdict: 'eligible', notes: expect.arrayContaining(['office/hybrid: Bengaluru']) });
    const us = posting({ detail: { title: 'Staff Software Engineer', description: '<p>x</p>', location: 'California - San Francisco', additionalLocations: ['Georgia - Atlanta'], country: 'US', remoteType: 'Office Tech-Flexible', timeType: 'Full time' } });
    expect(us.remote.structured).toBe('hybrid');
    expect(decideEligibility(us, ELIG).verdict).toBe('rejected');
  });

  it('"Bengaluru, India" and "Bangalore, Karnataka, India" without a detail pass as a Bengaluru office', () => {
    for (const where of ['Bengaluru, India', 'Bangalore, Karnataka, India', 'India, Bengaluru']) {
      const p = posting({ locationsText: where });
      expect(p.descriptionText).toBe('');
      expect(decideEligibility(p, ELIG), where).toMatchObject({ verdict: 'eligible', notes: expect.arrayContaining(['office/hybrid: Bengaluru']) });
    }
    expect(decideEligibility(posting({ locationsText: 'Pune, India' }), ELIG)).toMatchObject({ verdict: 'rejected', reasons: ['onsite'] });
    expect(decideEligibility(posting({ locationsText: 'India, Remote' }), ELIG).verdict).toBe('eligible');
  });

  it('"2 Locations" is a generic location field: it reaches the JD-label path and is never guessed', () => {
    // no detail, no description: nothing names a place, so it is not admitted on a guess
    expect(decideEligibility(posting({ locationsText: '2 Locations' }), ELIG)).toMatchObject({ verdict: 'rejected', reasons: ['onsite'] });
    // the description's label line stands in for the generic field
    const labelled = (where: string) => posting({ locationsText: '2 Locations', detail: { title: 'Senior Software Engineer', description: `<p>Location: ${where}</p><p>Build services.</p>`, location: null, additionalLocations: [], country: null, remoteType: null, timeType: 'Full time' } });
    // a detail with no location keeps the list's "2 Locations"
    expect(labelled('Bengaluru, India').locationText).toBe('2 Locations');
    expect(decideEligibility(labelled('Bengaluru, India'), ELIG)).toMatchObject({ verdict: 'eligible', notes: expect.arrayContaining(['office/hybrid: Bengaluru']) });
    expect(decideEligibility(labelled('Hyderabad, India'), ELIG).verdict).toBe('rejected');
    // a non-generic location never takes the label
    const pune = posting({ locationsText: 'Pune, India', detail: { title: 'Senior Software Engineer', description: '<p>Location: Bengaluru</p>', location: 'Pune, India', additionalLocations: [], country: 'IN', remoteType: null, timeType: 'Full time' } });
    expect(decideEligibility(pune, ELIG).verdict).toBe('rejected');
    // with a detail, the real locations replace "2 Locations": an additional Bengaluru location passes
    const two = posting({ locationsText: '2 Locations', detail: { title: 'Senior Software Engineer', description: '<p>x</p>', location: 'US, CA, Santa Clara', additionalLocations: ['India, Bengaluru'], country: 'US', remoteType: null, timeType: 'Full time' } });
    expect(two.locationText).toBe('US, CA, Santa Clara; India, Bengaluru');
    expect(decideEligibility(two, ELIG)).toMatchObject({ verdict: 'eligible', notes: expect.arrayContaining(['office/hybrid: Bengaluru']) });
  });

  it('a job without a detail flows with an empty description: eligibility judges it on its listed location alone', () => {
    const p = posting({ title: 'Senior Software Engineer', locationsText: 'India, Bengaluru' });
    expect(p).toMatchObject({ descriptionText: '', comp: null, yearsRequired: null, employmentType: null });
    expect(decideEligibility(p, ELIG)).toMatchObject({ verdict: 'eligible', notes: ['office/hybrid: Bengaluru', 'pay not disclosed'] });
  });

  it('the recorded fixtures parse: NVIDIA, Salesforce and Mastercard page 1 have 20 jobs each, every job with a req id', () => {
    for (const name of ['nvidia', 'salesforce', 'mastercard']) {
      const fx = fixture(name);
      const page = parseListPage(fx.pages[0], name);
      expect(page.jobPostings, name).toHaveLength(20);
      for (const j of page.jobPostings) expect(reqIdOf(j), `${name} ${j.externalPath}`).not.toBeNull();
    }
    expect(fixture('nvidia').pages[0]?.total).toBe(2000);
    expect(fixture('nvidia').pages[1]?.total).toBe(0);
    expect(indiaFacet(parseListPage(fixture('salesforce').pages[0], 'sf'))).toEqual(fixture('salesforce').indiaFacet);
  });
});
