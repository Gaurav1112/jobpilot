import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decideEligibility, type EligibilityPack } from '../../src/app/agents/eligibility.js';
import { normalize } from '../../src/app/agents/normalizer.js';
import {
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
  WORKDAY_MAX_DETAILS,
  WORKDAY_MAX_REQUESTS,
  workdayPagesPerList,
  WORKDAY_MIN_INTERVAL_MS,
  workdayScopes,
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
  /** The unscoped first page recorded for facet discovery (location facets kept). */
  readonly discovery: Fixture['pages'][number];
  /** The first page of each scoped list, recorded live. */
  readonly scoped: { readonly india: Fixture['pages'][number]; readonly remote?: Fixture['pages'][number] };
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
  /** The scoped lists, by the exact appliedFacets JSON of a request, else by its facet parameter (one per request). */
  readonly scopes?: Readonly<Record<string, { readonly jobs: readonly Posted[]; readonly total?: number }>>;
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
        const keys = Object.keys(q.appliedFacets);
        expect(keys.length).toBeLessThanOrEqual(1);
        const scoped = keys.length > 0;
        const scope = scoped ? (b.scopes?.[JSON.stringify(q.appliedFacets)] ?? b.scopes?.[keys[0] as string]) : undefined;
        if (scoped && scope === undefined) return { status: 400, text: async () => '' };
        const jobs = scope?.jobs ?? b.jobs;
        const total = scoped ? (scope?.total ?? jobs.length) : (b.total ?? jobs.length);
        let offset = b.ignoreOffset === true ? 0 : q.offset;
        if (b.wrapAt !== undefined && offset >= b.wrapAt) offset = 0;
        return ok({ total: q.offset === 0 ? total : 0, jobPostings: jobs.slice(offset, offset + 20), ...(q.offset === 0 && !scoped && b.facets ? { facets: b.facets } : {}) });
      }
      if ((init.method ?? 'GET') === 'GET' && u.pathname.startsWith(`${base}/job/`)) {
        const path = u.pathname.slice(base.length);
        const listed = [...b.jobs, ...Object.values(b.scopes ?? {}).flatMap((x) => x.jobs)].find((j) => j.externalPath === path);
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
    expect(err).toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/page cap reached at 60 postings \(total 70, 3 pages\)/) });
  });

  it('a page repeating earlier postings (Workday ignoring the offset) fails loudly', async () => {
    const err = await runOn([board({ jobs: jobs(45, () => 'Account Executive'), ignoreOffset: true })]).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/offset 20 repeats earlier postings/) });
  });

  it("the unscoped fallback (no location facets) at Workday's 2000 ceiling fails loudly: it cannot be read in full", async () => {
    const err = await runOn([board({ jobs: jobs(20, () => 'Account Executive'), total: 2000 })]).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/total 2000 is Workday's reporting ceiling/) });
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
    expect(skips).toEqual(['detail-budget Acme: 3 jobs without detail (3 over the budget, 0 not India-named)']);
    expect(out).toHaveLength(8);
    expect(out.filter((p) => (p.raw as WorkdayRaw).detail !== null).map((p) => p.sourceId)).toEqual(['JR1000', 'JR1001']);
  });

  it('details go only to rank 0 (India-named or office-listed), ties by req id', async () => {
    const list: Posted[] = [
      { ...job(0), locationsText: 'US, CA, Santa Clara' },
      { ...job(1), locationsText: '2 Locations' },
      { ...job(2), locationsText: 'Israel, Yokneam' },
      { ...job(3), locationsText: 'California - San Francisco' },
      { ...job(4), locationsText: 'India - Bangalore' },
      { ...job(5), locationsText: 'Bangalore, Karnataka, India' },
      { ...job(6), locationsText: '12 Locations' },
    ];
    const details = Object.fromEntries(list.map((j) => [j.externalPath, detail(j.title)]));
    const { calls, skips } = await runOn([board({ jobs: list, details })], { maxDetails: 5 });
    // Fix round 2: only rank 0 (India-named, office-listed) gets a detail; "N Locations" and the rest never do
    expect(detailsOf(calls).map((c) => c.url.split('_').pop())).toEqual(['JR1004', 'JR1005']);
    expect(skips).toEqual(['detail-budget Acme: 5 jobs without detail (0 over the budget, 5 not India-named)']);
    expect(WORKDAY_MAX_DETAILS).toBe(40);
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
  });
});

const IN_NV = '2fcb99c455831013ea52b82135ba3266';
const REMOTE_NV = '0c3f5f117e9a0101f63dc469c3010000';
const SF_COUNTRY = 'CF_-_REC_-_LRV_-_Job_Posting_Anchor_-_Country_from_Job_Posting_Location_Extended';
const SF_INDIA = 'c4f78be1a8f14da0ab49ce1162348a5e';
const NV_SCOPES = () => workdayScopes(parseListPage(fixture('nvidia').discovery, 'nvidia'), ['bengaluru']);
const NV_INDIA = () => NV_SCOPES().india?.facets ?? {};
const NV_OFFICE = () => NV_SCOPES().offices[0]?.facets ?? {};
const SF_SCOPES = () => workdayScopes(parseListPage(fixture('salesforce').discovery, 'sf'), ['bengaluru']);
const key = (f: object): string => JSON.stringify(f);
/** The facets with each leaf value's count replaced by `count(descriptor)` (undefined keeps it): small test boards need counts their lists can meet. */
const recount = (facets: readonly unknown[], count: (descriptor: string) => number | undefined): unknown[] =>
  JSON.parse(JSON.stringify(facets), (k, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && 'descriptor' in v && 'count' in v) {
      const c = count(String((v as { descriptor: unknown }).descriptor));
      return c === undefined ? v : { ...(v as object), count: c };
    }
    return v;
  }) as unknown[];
const appliedOf = (calls: { method: string; url: string; body?: unknown }[]) => lists(calls).map((c) => (c.body as { appliedFacets: unknown; offset: number }).appliedFacets);

describe('Fix round 1: every Workday read is scoped to the India and remote facets', () => {
  it('discovers the facets of the three recorded tenants', () => {
    const scopes = (name: string) => workdayScopes(parseListPage(fixture(name).discovery, name));
    // NVIDIA: an exact "India" country value (253) and its India site values (355, the larger: chosen); a location type (Remote, 576)
    const nv = scopes('nvidia');
    expect(Object.keys(nv.india?.facets ?? {})).toEqual(['locations']);
    expect(nv.india?.expected).toBe(355);
    expect(nv.india?.facets['locations']).not.toContain(IN_NV);
    expect(nv.remote).toEqual({ facets: { locationHierarchy2: [REMOTE_NV] }, expected: 576, largest: 576 });
    expect(nv.located).toBe(true);
    expect(nv.offices).toEqual([]);
    // Salesforce: the anchor Country "India" (109) loses to its India site values (236); its "X - Remote" sites are locations, not a remote type
    const sf = scopes('salesforce');
    expect(Object.keys(sf.india?.facets ?? {})).toEqual(['locations']);
    expect(sf.india?.expected).toBe(236);
    expect(sf.remote).toBeNull();
    // Mastercard: no country level; its sites naming an Indian place stand in for it
    const mc = scopes('mastercard');
    expect(mc.remote).toBeNull();
    expect(mc.located).toBe(true);
    expect(Object.keys(mc.india?.facets ?? {})).toEqual(['locations']);
    const groups = fixture('mastercard').discovery.facets as { values: { values: { descriptor: string; id: string }[] }[] }[];
    const mcValues = groups[0]?.values[0]?.values ?? [];
    expect(mc.india?.facets['locations']).toEqual(mcValues.filter((v) => /\bIndia\b/.test(v.descriptor)).map((v) => v.id));
    expect(mc.india?.facets['locations']?.length).toBeGreaterThan(5);
    // the recorded scoped first pages: what those facets select live
    expect(fixture('nvidia').scoped.india.total).toBe(253);
    expect(fixture('nvidia').scoped.remote?.total).toBe(576);
    expect(fixture('mastercard').scoped.india.total).toBe(251);
  });

  it('reads the union of the India and remote lists, deduped by req id; a 2-Locations job with Bengaluru comes in through the India facet', async () => {
    const facets = recount(fixture('nvidia').discovery.facets ?? [], () => 1);
    const india: Posted[] = [
      job(1, 'Senior Software Engineer', 'India, Bengaluru'),
      { title: 'Senior Software Engineer, Platform', externalPath: '/job/US-CA-Santa-Clara/Platform_JR2001', locationsText: '2 Locations', bulletFields: ['JR2001'] },
      job(3, 'Senior Software Engineer', 'India, Remote'),
    ];
    const remote: Posted[] = [job(3, 'Senior Software Engineer', 'India, Remote'), job(4, 'Senior Software Engineer', 'US, Remote')];
    const details = {
      ...Object.fromEntries([...india, ...remote].map((j) => [j.externalPath, detail(j.title)])),
      '/job/US-CA-Santa-Clara/Platform_JR2001': detail('Senior Software Engineer, Platform', { location: 'US, CA, Santa Clara', additionalLocations: ['India, Bengaluru'], country: { descriptor: 'United States of America' } }),
    };
    const worldwide = jobs(25, () => 'Account Executive', () => 'Germany, Munich');
    // Fix round 2: the 2-Locations job gets its detail as an office-listed (rank-0) job
    const office = { [key(NV_OFFICE())]: { jobs: [india[1] as Posted] } };
    const { out, calls } = await runOn([board({ jobs: worldwide, total: 2000, facets, scopes: { [key(NV_INDIA())]: { jobs: india }, locationHierarchy2: { jobs: remote }, ...office }, details })], { pack: { ...PACK, eligibility: { officeCities: ['bengaluru'] } } });
    expect(appliedOf(calls)).toEqual([{}, NV_INDIA(), { locationHierarchy2: [REMOTE_NV] }, NV_OFFICE()]);
    expect(out.map((p) => p.sourceId)).toEqual(['JR1001', 'JR1003', 'JR1004', 'JR2001']);
    const two = normalize(out.find((p) => p.sourceId === 'JR2001') as RawPosting);
    expect(two.locationText).toBe('US, CA, Santa Clara; India, Bengaluru');
    expect(decideEligibility(two, ELIG)).toMatchObject({ verdict: 'eligible', notes: expect.arrayContaining(['office/hybrid: Bengaluru']) });
  });

  it('the recorded Salesforce India list carries its "2 Locations" jobs into the read', async () => {
    const fx = fixture('salesforce');
    const india = fx.scoped.india.jobPostings;
    expect(india.filter((j) => j.locationsText === '2 Locations').length).toBeGreaterThan(0);
    const sf: Board = { host: 'salesforce.wd12.myworkdayjobs.com', tenant: 'salesforce', site: 'External_Career_Site', jobs: fx.pages[0]?.jobPostings ?? [], total: 1520, facets: recount(fx.discovery.facets ?? [], () => 3), scopes: { [key(SF_SCOPES().india?.facets ?? {})]: { jobs: india } }, robots: { body: fx.robots }, anyDetail: true };
    const { out, calls } = await runOn([sf]);
    expect(lists(calls)).toHaveLength(2);
    expect(out.map((p) => (p.raw as WorkdayRaw).externalPath).sort()).toEqual(india.map((j) => j.externalPath).sort());
    expect(out.some((p) => (p.raw as WorkdayRaw).externalPath === '/job/India---Bangalore/Technical-Architect---Agentforce-Revenue-Management_JR350992-1')).toBe(true);
  });

  it('location facets naming neither India nor a remote type: a named skip, nothing read past discovery', async () => {
    const facets = [{ facetParameter: 'locationMainGroup', values: [{ facetParameter: 'locationCountry', descriptor: 'Country', values: [{ descriptor: 'Germany', id: 'de', count: 4 }, { descriptor: 'United States', id: 'us', count: 9 }] }] }];
    const { out, calls, skips } = await runOn([board({ jobs: jobs(13, () => 'Senior Software Engineer', () => 'Germany, Munich'), facets })]);
    expect(out).toEqual([]);
    expect(lists(calls)).toHaveLength(1);
    expect(skips).toEqual(['no-india-or-remote-facet Acme: its location facets name neither India nor a remote type']);
  });

  it('no India value but a remote type: only the remote list is read', async () => {
    const facets = [
      { facetParameter: 'locationCountry', descriptor: 'Country', values: [{ descriptor: 'Germany', id: 'de', count: 4 }] },
      { facetParameter: 'remoteType', descriptor: 'Remote Type', values: [{ descriptor: 'Remote', id: 'r', count: 2 }, { descriptor: 'On-site', id: 'o', count: 2 }] },
    ];
    const { out, calls } = await runOn([board({ jobs: jobs(4, () => 'Account Executive'), facets, scopes: { remoteType: { jobs: jobs(2, () => 'Account Executive', () => 'Remote') } } })]);
    expect(appliedOf(calls)).toEqual([{}, { remoteType: ['r'] }]);
    expect(out).toHaveLength(2);
  });

  it('no location facets at all: the unscoped read, the discovery page being its page 1', async () => {
    const { out, calls } = await runOn([board({ jobs: jobs(25, () => 'Account Executive') })]);
    expect(lists(calls).map((c) => c.body)).toEqual([
      { appliedFacets: {}, limit: 20, offset: 0, searchText: '' },
      { appliedFacets: {}, limit: 20, offset: 20, searchText: '' },
    ]);
    expect(out).toHaveLength(25);
  });

  it('a scoped list at the 2000 ceiling fails loudly', async () => {
    const facets = fixture('salesforce').discovery.facets ?? [];
    const err = await runOn([board({ jobs: jobs(1), facets, scopes: { [key(SF_SCOPES().india?.facets ?? {})]: { jobs: jobs(20, () => 'Account Executive'), total: 2000 } } })]).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/scoped list reports Workday's 2000 ceiling/) });
  });

  it('the discovered facets are cached per company per run: a second read the same run skips discovery; a new run discovers again', async () => {
    const facets = recount(fixture('salesforce').discovery.facets ?? [], () => 1);
    const b = board({ jobs: jobs(3), facets, scopes: { [key(SF_SCOPES().india?.facets ?? {})]: { jobs: jobs(2, () => 'Account Executive') } } });
    const hosts = dailyWorkdayHosts();
    const net = workday([b]);
    const agent = makeSrcWorkday({ hosts });
    await agent.run(reqFor(b), context(net.fetch, [HOST]).ctx);
    await agent.run(reqFor(b), context(net.fetch, [HOST]).ctx);
    expect(appliedOf(net.calls)).toEqual([{}, SF_SCOPES().india?.facets, SF_SCOPES().india?.facets]);
    const net2 = workday([b]);
    await makeSrcWorkday({ hosts: dailyWorkdayHosts() }).run(reqFor(b), context(net2.fetch, [HOST]).ctx);
    expect(appliedOf(net2.calls)[0]).toEqual({});
  });
});

describe('Fix round 1 (live finding): office-city lists label "N Locations" jobs the detail budget cannot reach', () => {
  const OFFICE_PACK = { ...PACK, eligibility: { officeCities: ['bengaluru'] } };

  it("discovers the office city's location values in the recorded facets", () => {
    const nv = workdayScopes(parseListPage(fixture('nvidia').discovery, 'nvidia'), ['bengaluru']);
    expect(nv.offices).toEqual([{ display: 'Bengaluru', facets: { locations: ['91336993fab910af6d6fb9748af4c1df'] }, expected: 204, largest: 204, labels: ['India, Bengaluru'] }]);
    const sf = workdayScopes(parseListPage(fixture('salesforce').discovery, 'sf'), ['bengaluru']);
    expect(sf.offices.map((o) => o.labels)).toEqual([['India - Bangalore']]);
    // Mastercard has no Bengaluru location: no office list
    expect(workdayScopes(parseListPage(fixture('mastercard').discovery, 'mc'), ['bengaluru']).offices).toEqual([]);
    // no office cities in the pack: no office lists
    expect(workdayScopes(parseListPage(fixture('nvidia').discovery, 'nvidia')).offices).toEqual([]);
  });

  it('a "2 Locations" job without a detail, listed under the Bengaluru value, carries that label and passes as a Bengaluru office', async () => {
    const facets = recount(fixture('nvidia').discovery.facets ?? [], () => 1);
    const multi: Posted = { title: 'Account Executive', externalPath: '/job/US-CA-Santa-Clara/AE_JR3001', locationsText: '2 Locations', bulletFields: ['JR3001'] };
    const pune: Posted = { title: 'Account Executive', externalPath: '/job/India-Pune/AE_JR3002', locationsText: '2 Locations', bulletFields: ['JR3002'] };
    const { out, calls } = await runOn([board({ jobs: [], facets, scopes: { [key(NV_INDIA())]: { jobs: [multi, pune] }, locationHierarchy2: { jobs: [] }, [key(NV_OFFICE())]: { jobs: [multi] } } })], { pack: OFFICE_PACK });
    expect(appliedOf(calls)).toEqual([{}, NV_INDIA(), { locationHierarchy2: [REMOTE_NV] }, { locations: ['91336993fab910af6d6fb9748af4c1df'] }]);
    const byId = Object.fromEntries(out.map((p) => [p.sourceId, p]));
    expect((byId['JR3001']?.raw as WorkdayRaw).officeLocations).toEqual(['India, Bengaluru']);
    expect((byId['JR3002']?.raw as WorkdayRaw).officeLocations).toEqual([]);
    const p = normalize(byId['JR3001'] as RawPosting);
    expect(p.locationText).toBe('2 Locations; India, Bengaluru');
    expect(decideEligibility({ ...p, title: 'Senior Software Engineer' }, ELIG)).toMatchObject({ verdict: 'eligible', notes: expect.arrayContaining(['office/hybrid: Bengaluru']) });
    // the other "2 Locations" job stays generic: not guessed
    expect(normalize(byId['JR3002'] as RawPosting).locationText).toBe('2 Locations');
  });

  it('a detail wins over the office label; office-listed jobs rank with the India-named ones for details', async () => {
    const facets = recount(fixture('nvidia').discovery.facets ?? [], () => 1);
    const list: Posted[] = [
      { title: 'Senior Software Engineer', externalPath: '/job/X/A_JR4001', locationsText: '2 Locations', bulletFields: ['JR4001'] },
      { title: 'Senior Software Engineer', externalPath: '/job/X/B_JR4002', locationsText: '3 Locations', bulletFields: ['JR4002'] },
      { title: 'Senior Software Engineer', externalPath: '/job/X/C_JR4003', locationsText: 'India, Pune', bulletFields: ['JR4003'] },
    ];
    const details = { '/job/X/B_JR4002': detail('Senior Software Engineer', { location: 'US, CA, Santa Clara', additionalLocations: ['India, Bengaluru'] }) };
    const { out, calls } = await runOn([board({ jobs: [], facets, details, anyDetail: true, scopes: { [key(NV_INDIA())]: { jobs: list }, locationHierarchy2: { jobs: [] }, [key(NV_OFFICE())]: { jobs: [list[1] as Posted] } } })], { pack: OFFICE_PACK, maxDetails: 2 });
    expect(detailsOf(calls).map((c) => c.url.split('_').pop())).toEqual(['JR4002', 'JR4003']);
    const b = normalize(out.find((p) => p.sourceId === 'JR4002') as RawPosting);
    expect(b.locationText).toBe('US, CA, Santa Clara; India, Bengaluru');
  });
});

describe('Fix round 2: facet safety, rank-0 details, a scaled request cap', () => {
  const OFFICE = { ...PACK, eligibility: { officeCities: ['bengaluru'] } };
  const page = (facets: unknown[]) => parseListPage({ total: 10, jobPostings: [], facets }, 'probe');

  it('I1: a plain "Remote" value does not take over its facet: India and the office come from the other values (probe A)', () => {
    const facets = [{ facetParameter: 'locations', values: [{ descriptor: 'Remote', id: 'rem', count: 7 }, { descriptor: 'Bengaluru, India', id: 'blr', count: 5 }, { descriptor: 'Pune, India', id: 'pnq', count: 3 }, { descriptor: 'Austin, TX', id: 'aus', count: 9 }] }];
    expect(workdayScopes(page(facets), ['bengaluru'])).toEqual({
      india: { facets: { locations: ['blr', 'pnq'] }, expected: 8, largest: 5 },
      remote: { facets: { locations: ['rem'] }, expected: 7, largest: 7 },
      located: true,
      offices: [{ display: 'Bengaluru', facets: { locations: ['blr'] }, expected: 5, largest: 5, labels: ['Bengaluru, India'] }],
    });
  });

  it('I1: with a country facet present too, the office list still comes from the site facet holding "Remote" (probe B)', () => {
    const facets = [
      { facetParameter: 'locationCountry', values: [{ descriptor: 'India', id: 'in', count: 20 }, { descriptor: 'United States', id: 'us', count: 40 }] },
      { facetParameter: 'locations', values: [{ descriptor: 'Remote', id: 'rem', count: 7 }, { descriptor: 'Bengaluru, India', id: 'blr', count: 5 }] },
    ];
    const s = workdayScopes(page(facets), ['bengaluru']);
    expect(s.india).toEqual({ facets: { locationCountry: ['in'] }, expected: 20, largest: 20 });
    expect(s.remote).toEqual({ facets: { locations: ['rem'] }, expected: 7, largest: 7 });
    expect(s.offices).toEqual([{ display: 'Bengaluru', facets: { locations: ['blr'] }, expected: 5, largest: 5, labels: ['Bengaluru, India'] }]);
  });

  it('minor 1: an unknown facet parameter (a delivery hub) is never an office list, and gives India only through an exact "India" value (probe C)', () => {
    const hub = [
      { facetParameter: 'workSiteHub', values: [{ descriptor: 'Bangalore Hub - Global Delivery', id: 'hub', count: 50 }, { descriptor: 'Hyderabad Hub, India', id: 'hyd', count: 9 }] },
      { facetParameter: 'locationCountry', values: [{ descriptor: 'India', id: 'in', count: 12 }] },
    ];
    const s = workdayScopes(page(hub), ['bengaluru']);
    expect(s.offices).toEqual([]);
    expect(s.india).toEqual({ facets: { locationCountry: ['in'] }, expected: 12, largest: 12 });
    const exactOnly = [{ facetParameter: 'workSiteHub', values: [{ descriptor: 'India', id: 'hin', count: 3 }, { descriptor: 'Pune, India', id: 'hp', count: 2 }] }];
    expect(workdayScopes(page(exactOnly), ['bengaluru'])).toMatchObject({ india: { facets: { workSiteHub: ['hin'] }, expected: 3 }, offices: [] });
  });

  it('minor 2: several India candidates: the largest count wins, ties in served order', () => {
    const tie = [
      { facetParameter: 'locationCountry', values: [{ descriptor: 'India', id: 'a', count: 10 }] },
      { facetParameter: 'Location_Country', values: [{ descriptor: 'India', id: 'b', count: 10 }] },
    ];
    expect(workdayScopes(page(tie)).india).toEqual({ facets: { locationCountry: ['a'] }, expected: 10, largest: 10 });
    const bigger = [tie[0], { facetParameter: 'Location_Country', values: [{ descriptor: 'India', id: 'b', count: 11 }] }];
    expect(workdayScopes(page(bigger)).india).toEqual({ facets: { Location_Country: ['b'] }, expected: 11, largest: 11 });
  });

  it('I2: a scoped list Workday did not apply (its total above the facet counts) fails as scope-not-applied, and nothing is stamped', async () => {
    // the real counts (India city values 355, Bengaluru 204); no remote type, so the remote list is not in play
    const facets = recount(fixture('nvidia').discovery.facets ?? [], (d) => (/^remote$/i.test(d) ? 0 : undefined));
    const whole = jobs(300, () => 'Account Executive', () => '2 Locations');
    // the office list answers with the whole board: 300 > 204 + 5%
    const err = await runOn([board({ jobs: [], facets, scopes: { [key(NV_INDIA())]: { jobs: jobs(250) }, locationHierarchy2: { jobs: [] }, [key(NV_OFFICE())]: { jobs: whole } } })], { pack: OFFICE }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^scope-not-applied Acme Bengaluru list: total 300, the facet counts 204/) });
    // drift within max(5, 5%) is accepted
    const ok = await runOn([board({ jobs: [], facets, scopes: { [key(NV_INDIA())]: { jobs: jobs(250, () => 'Account Executive') }, locationHierarchy2: { jobs: [] }, [key(NV_OFFICE())]: { jobs: jobs(214, () => 'Account Executive') } } })], { pack: OFFICE });
    expect(ok.out.length).toBeGreaterThan(200);
    // the India list too
    const err2 = await runOn([board({ jobs: [], facets, scopes: { [key(NV_INDIA())]: { jobs: jobs(400, () => 'Account Executive') }, locationHierarchy2: { jobs: [] } } })]).catch((e: unknown) => e);
    expect(err2).toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^scope-not-applied Acme india list: total 400, the facet counts 355/) });
  });

  it('minor 3: the office stamp is keyed by externalPath: a re-post in another city never takes the label', async () => {
    const facets = recount(fixture('nvidia').discovery.facets ?? [], () => 1);
    const pune: Posted = { title: 'Account Executive', externalPath: '/job/India-Pune/AE_JR1', locationsText: '2 Locations', bulletFields: ['JR1'] };
    const blr: Posted = { title: 'Account Executive', externalPath: '/job/India-Bengaluru/AE_JR1-1', locationsText: '2 Locations', bulletFields: ['JR1'] };
    const { out } = await runOn([board({ jobs: [], facets, scopes: { [key(NV_INDIA())]: { jobs: [pune, blr] }, locationHierarchy2: { jobs: [] }, [key(NV_OFFICE())]: { jobs: [blr] } } })], { pack: OFFICE });
    // one req is one posting; the label stays with the posting Workday listed under Bengaluru (round 3: that re-post is kept)
    expect(out).toHaveLength(1);
    expect((out[0]?.raw as WorkdayRaw).externalPath).toBe('/job/India-Bengaluru/AE_JR1-1');
    expect((out[0]?.raw as WorkdayRaw).officeLocations).toEqual(['India, Bengaluru']);
    expect(out.some((p) => (p.raw as WorkdayRaw).externalPath === '/job/India-Pune/AE_JR1' && ((p.raw as WorkdayRaw).officeLocations ?? []).length > 0)).toBe(false);
  });

  it('minor 4: deterministic per-tenant refusals are input_rejected (no breaker); drift stays invalid_output', async () => {
    const cap = await runOn([board({ jobs: jobs(70, () => 'Account Executive') })], { maxPages: 3 }).catch((e: unknown) => e);
    expect(cap).toMatchObject({ code: 'input_rejected' });
    const ceiling = await runOn([board({ jobs: jobs(20, () => 'Account Executive'), total: 2000 })]).catch((e: unknown) => e);
    expect(ceiling).toMatchObject({ code: 'input_rejected' });
    const repeat = await runOn([board({ jobs: jobs(45, () => 'Account Executive'), ignoreOffset: true })]).catch((e: unknown) => e);
    expect(repeat).toMatchObject({ code: 'invalid_output' });
  });

  it('minor 5: an office list at the 2000 ceiling fails loudly', async () => {
    const facets = recount(fixture('nvidia').discovery.facets ?? [], () => 1);
    const err = await runOn([board({ jobs: [], facets, scopes: { [key(NV_INDIA())]: { jobs: jobs(3) }, locationHierarchy2: { jobs: [] }, [key(NV_OFFICE())]: { jobs: jobs(20, () => 'Account Executive'), total: 2000 } } })], { pack: OFFICE }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/the Bengaluru office list reports Workday's 2000 ceiling/) });
  });

  it('timing: "N Locations" and other ranks never get a detail even with budget left; India-remote locations do', async () => {
    const list: Posted[] = [job(1, 'Senior Software Engineer', 'India, Remote'), job(2, 'Senior Software Engineer', '2 Locations'), job(3, 'Senior Software Engineer', 'US, Remote')];
    const details = Object.fromEntries(list.map((j) => [j.externalPath, detail(j.title)]));
    const { calls, skips } = await runOn([board({ jobs: list, details })]);
    expect(detailsOf(calls).map((c) => c.url.split('_').pop())).toEqual(['JR1001']);
    expect(skips).toEqual(['detail-budget Acme: 2 jobs without detail (0 over the budget, 2 not India-named)']);
  });

  it('timing: the per-list page cap scales with the office cities, so the worst case at 2 s spacing ends before the step timeout', () => {
    for (const offices of [0, 1, 2, 3]) {
      const lists = 2 + offices;
      const pages = workdayPagesPerList(offices);
      const worst = 1 + 1 + lists * pages + WORKDAY_MAX_DETAILS;
      expect(worst, `${offices} office cities`).toBeLessThanOrEqual(WORKDAY_MAX_REQUESTS);
      expect(worst * WORKDAY_MIN_INTERVAL_MS, `${offices} office cities`).toBeLessThan(srcWorkdayContract.timeoutMs);
      expect(pages).toBeGreaterThan(0);
    }
    expect(workdayPagesPerList(0)).toBe(100);
  });

  it('timing: the scaled cap is applied to every list of a board with office cities', async () => {
    const facets = [{ facetParameter: 'locationCountry', values: [{ descriptor: 'India', id: 'in', count: 20 * workdayPagesPerList(3) + 1 }] }];
    const cities = ['bengaluru', 'pune', 'hyderabad'];
    const err = await runOn([board({ jobs: [], facets, scopes: { locationCountry: { jobs: jobs(20 * workdayPagesPerList(3) + 1, () => 'Account Executive') } } })], { pack: { ...PACK, eligibility: { officeCities: cities } } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'input_rejected', message: expect.stringMatching(new RegExp(`${workdayPagesPerList(3)} pages\\)`)) });
  });
});

describe('Fix round 3: scope lower bound, office subset, re-post preference', () => {
  const OFFICE = { ...PACK, eligibility: { officeCities: ['bengaluru'] } };

  it('1: a scoped list far below its largest selected value (a stale facet id answering 0) is scope-not-applied, never a silent zero', async () => {
    const facets = fixture('nvidia').discovery.facets ?? [];
    const zero = await runOn([board({ jobs: [], facets, scopes: { [key(NV_INDIA())]: { jobs: [] }, locationHierarchy2: { jobs: [] } } })]).catch((e: unknown) => e);
    expect(zero).toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^scope-not-applied Acme india list: total 0, below its largest facet value 204/) });
    // a value count is never double-counted: the India "Bengaluru" value alone holds 204, so the bound is 204 − 5% = 193.8
    const nearly = await runOn([board({ jobs: [], facets, scopes: { [key(NV_INDIA())]: { jobs: jobs(190, () => 'Account Executive') }, locationHierarchy2: { jobs: jobs(560, () => 'Account Executive', () => 'US, Remote').map((j, i) => ({ ...j, externalPath: `/job/R/x_JR${9000 + i}`, bulletFields: [`JR${9000 + i}`] })) } } })]).catch((e: unknown) => e);
    expect(nearly).toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/india list: total 190, below its largest facet value 204/) });
    const ok = await runOn([board({ jobs: [], facets, scopes: { [key(NV_INDIA())]: { jobs: jobs(194 + 6, () => 'Account Executive') }, locationHierarchy2: { jobs: jobs(560, () => 'Account Executive', () => 'US, Remote').map((j, i) => ({ ...j, externalPath: `/job/R/x_JR${9000 + i}`, bulletFields: [`JR${9000 + i}`] })) } } })]);
    expect(ok.out.length).toBe(760);
  });

  it('2: two postings of one req: the office-listed one wins, then the India-named one, then the first seen', async () => {
    const facets = recount(fixture('nvidia').discovery.facets ?? [], () => 1);
    const pune: Posted = { title: 'Account Executive', externalPath: '/job/India-Pune/AE_JR1', locationsText: '2 Locations', bulletFields: ['JR1'] };
    const blr: Posted = { title: 'Account Executive', externalPath: '/job/India-Bengaluru/AE_JR1-1', locationsText: '2 Locations', bulletFields: ['JR1'] };
    const india = [pune, blr];
    const { out } = await runOn([board({ jobs: [], facets, scopes: { [key(NV_INDIA())]: { jobs: india }, locationHierarchy2: { jobs: [] }, [key(NV_OFFICE())]: { jobs: [blr] } } })], { pack: OFFICE });
    const jr1 = out.filter((p) => p.sourceId === 'JR1');
    expect(jr1).toHaveLength(1);
    expect((jr1[0]?.raw as WorkdayRaw).externalPath).toBe('/job/India-Bengaluru/AE_JR1-1');
    expect((jr1[0]?.raw as WorkdayRaw).officeLocations).toEqual(['India, Bengaluru']);
    // no office listing: an India-named re-post beats an earlier "N Locations" one
    const multi: Posted = { title: 'Account Executive', externalPath: '/job/X/AE_JR2', locationsText: '3 Locations', bulletFields: ['JR2'] };
    const named: Posted = { title: 'Account Executive', externalPath: '/job/India-Pune/AE_JR2-1', locationsText: 'India, Pune', bulletFields: ['JR2'] };
    const r2 = await runOn([board({ jobs: [multi, named] })]);
    expect((r2.out[0]?.raw as WorkdayRaw).externalPath).toBe('/job/India-Pune/AE_JR2-1');
  });

  it('3: probe E: an office list holding jobs outside the India list (a Bengaluru count of 2 on a board of 7) stamps nothing', async () => {
    const facets = [{ facetParameter: 'locations', values: [{ descriptor: 'Bengaluru, India', id: 'blr', count: 2 }, { descriptor: 'Pune, India', id: 'pnq', count: 1 }, { descriptor: 'Austin, TX', id: 'aus', count: 4 }] }];
    const all = [job(1, 'Account Executive', 'Bengaluru, India'), job(2, 'Account Executive', 'Bengaluru, India'), job(3, 'Account Executive', 'Pune, India'), ...[4, 5, 6, 7].map((i) => job(i, 'Account Executive', 'Austin, TX'))];
    const { out, skips } = await runOn([board({ jobs: all, facets, scopes: { [key({ locations: ['blr', 'pnq'] })]: { jobs: all.slice(0, 3) }, [key({ locations: ['blr'] })]: { jobs: all } } })], { pack: OFFICE });
    expect(skips).toContain('scope-not-applied Acme Bengaluru office list: 4 of its 7 jobs are not in the India list; nothing stamped');
    expect(out).toHaveLength(3);
    for (const p of out) expect((p.raw as WorkdayRaw).officeLocations).toEqual([]);
    // the same board with the office list applied: both Bengaluru jobs stamped
    const good = await runOn([board({ jobs: all, facets, scopes: { [key({ locations: ['blr', 'pnq'] })]: { jobs: all.slice(0, 3) }, [key({ locations: ['blr'] })]: { jobs: all.slice(0, 2) } } })], { pack: OFFICE });
    expect(good.skips).toEqual([]);
    expect(good.out.filter((p) => ((p.raw as WorkdayRaw).officeLocations ?? []).length > 0).map((p) => p.sourceId)).toEqual(['JR1001', 'JR1002']);
  });
});
