import { z } from 'zod';
import { defineAgent, type Agent, type AgentContext } from '../../../../kernel/agent.js';
import { defineContract } from '../../../../kernel/contract.js';
import { KernelError } from '../../../../kernel/errors.js';
import { compileSafePattern } from '../../../pack/regex.js';
import { countriesIn } from '../../../text/norm.js';
import { DiscoveryRequest, knownAts, RawPosting } from '../../../types.js';
import { finish, onlySeenBefore } from '../common.js';

/**
 * Workday (career-sites spec §4, Task 6): the daily adapter for every verified registry company on Workday, and the
 * request and parse code the coverage verifier's Workday client shares.
 *
 * A Workday board is `<host>/<tenant>/<site>` (its `ref`, the DiscoveryRequest slug), e.g.
 * `nvidia.wd5.myworkdayjobs.com/nvidia/NVIDIAExternalCareerSite`. Its public careers page reads its jobs from the CXS
 * JSON the page itself calls (not a documented public API like Greenhouse's, Lever's or Ashby's), so:
 * - robots.txt applies: before any request to a host, its robots.txt is checked for the CXS path (once per host per
 *   run, by the injected `WorkdayHosts`). A disallow (or an unreadable or forbidden robots.txt) is a named skip
 *   `robots-disallow <host>` for that company today, never a fetch;
 * - every request waits WORKDAY_MIN_INTERVAL_MS after the previous one to the host (the broker's `minIntervalMs`);
 * - a 401, 403 or 429 (or a 401/403/429 robots.txt) disables the host for the run with a named problem: the step
 *   fails `challenged` (401, 403) or `rate_limit` (429), is never retried around, and a later company on the same host
 *   is deferred (`input_rejected`, `host-disabled:<why> on <host>`) without a request.
 *
 * List: `POST https://<host>/wday/cxs/<tenant>/<site>/jobs` with `{"appliedFacets":{},"limit":20,"offset":<n>,
 * "searchText":""}` (a limit over 20 answers 400), paged by `offset` until a page is empty or `offset >= total`.
 * Workday reports `total` on the first page only (later pages say 0), and caps it at WORKDAY_TOTAL_CEILING: past
 * offset 2000 it serves the first page again (seen live 2026-10-14 on NVIDIA, whose facets count 2,699 jobs). So:
 * - a page whose jobs were all seen before is `invalid_output` (the API ignored the offset), never more postings;
 * - a first page reporting the ceiling cannot be read in full: the list is re-read scoped to the board's India
 *   location facet (the user's rules only admit remote-India or an Indian office), with the named note
 *   `scope <company>: India location facet only (Workday reports its 2000 ceiling)`; a board without such a facet, or
 *   a scoped list still at the ceiling, fails loudly;
 * - WORKDAY_MAX_PAGES list pages per company per run; a list longer than that fails loudly (`page cap reached`);
 * - a list that ends before its reported total gets the note `short-list <company>: total N, listed M`.
 *
 * Detail: `GET https://<host>/wday/cxs/<tenant>/<site><externalPath>`, for at most WORKDAY_MAX_DETAILS jobs per
 * company per run, and only for jobs whose title passes the cheap title pre-filter (`titlePasses`: no pack
 * `filters.roleDeny` pattern, eligibility's own rule 2, and every word of one `targets.titles` entry). Jobs whose
 * listed location names India come first, then those naming no country, then the rest (`locationRank`). Jobs past the budget get no detail: the named note
 * `detail-budget <company>: N jobs without detail`, and they still flow, with a null detail. A detail answering 404 or
 * 410 is a gone job: dropped, with one note `detail-gone <company>: N jobs gone between list and detail (<ids>)`.
 *
 * Every response is checked with zod first; one missing an expected field (a page without `total` or `jobPostings`, a
 * detail without its title or description) is `invalid_output` for the step, never partially parsed. A list entry
 * without a title or /job/ path is not a posting (seen live 2026-10-14: Mastercard lists a bare
 * `{"bulletFields":["R-…"]}`): it is skipped with a note, as the other sources skip a malformed job, and a page of
 * nothing else is `invalid_output`. `raw` (normalizer mapper `workday`): `{ title, url, externalPath, locationsText, reqId, detail }`,
 * `url` = `https://<host>/<site><externalPath>`; the relative `postedOn` ("Posted Today") is dropped (its date is
 * null, ordered by first seen), so an unchanged job gives an unchanged raw on every day. `sourceId` = the job req id
 * (the `bulletFields` entry the externalPath ends with, `_<req id>`), else the externalPath; one req posted twice is
 * one posting (the first wins).
 */

export const WORKDAY_PAGE_SIZE = 20;
export const WORKDAY_MAX_PAGES = 100;
export const WORKDAY_MAX_DETAILS = 40;
/** Workday's `total` never exceeds this; a first page reporting it may hide more jobs. */
export const WORKDAY_TOTAL_CEILING = 2000;
/** The spacing of requests to one Workday host (spec §4: at least 2 s per host). */
export const WORKDAY_MIN_INTERVAL_MS = 2000;
/** The kernel's step maximum: robots + 100 list pages + 40 details + one scoped first page = 142 requests, 6.3 s each. */
export const WORKDAY_TIMEOUT_MS = 900_000;
/** Requests one step may make at most: robots.txt, the first page, the scoped re-read's pages and the details. */
export const WORKDAY_MAX_REQUESTS = 1 + 1 + WORKDAY_MAX_PAGES + WORKDAY_MAX_DETAILS;
/** The symbolic egress resolved per run to the verified Workday companies' hosts. */
export const WORKDAY_EGRESS = 'registry:workday-hosts';

/** The note prefixes of the named skips (problems.ts prints them as they are, never as "malformed"). */
export const WORKDAY_NOTE_PREFIXES = ['robots-disallow ', 'detail-budget ', 'detail-gone ', 'scope ', 'short-list '] as const;

export interface WorkdayBoard {
  readonly host: string;
  readonly tenant: string;
  readonly site: string;
}

const HOST = /^[a-z0-9-]+\.(?:wd\d+\.)?(?:myworkdayjobs|myworkdaysite)\.com$/u;
const SEG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** `<host>/<tenant>/<site>` → the board; null when it is not one. */
export function parseWorkdayRef(ref: string): WorkdayBoard | null {
  const [host, tenant, site, ...rest] = ref.split('/');
  if (host === undefined || tenant === undefined || site === undefined || rest.length > 0) return null;
  if (!HOST.test(host) || !SEG.test(tenant) || !SEG.test(site)) return null;
  return { host, tenant, site };
}

export const workdayRef = (b: WorkdayBoard): string => `${b.host}/${b.tenant}/${b.site}`;

/** The board of a stored CXS list URL (`https://<host>/wday/cxs/<tenant>/<site>/jobs`, the registry's board_url). */
export function workdayBoardOfUrl(boardUrl: string): WorkdayBoard | null {
  let u: URL;
  try {
    u = new URL(boardUrl);
  } catch {
    return null;
  }
  const p = u.pathname.split('/').filter((s) => s !== '');
  if (u.protocol !== 'https:' || p.length !== 5 || p[0] !== 'wday' || p[1] !== 'cxs' || p[4] !== 'jobs') return null;
  return parseWorkdayRef(`${u.hostname.toLowerCase()}/${p[2] ?? ''}/${p[3] ?? ''}`);
}

export const workdayListUrl = (b: WorkdayBoard): string => `https://${b.host}/wday/cxs/${b.tenant}/${b.site}/jobs`;
export const workdayDetailUrl = (b: WorkdayBoard, externalPath: string): string => `https://${b.host}/wday/cxs/${b.tenant}/${b.site}${externalPath}`;
/** The job's public page (what the user opens and applies on); a `myworkdaysite.com` board lives under `/recruiting/<tenant>/`. */
export const workdayJobUrl = (b: WorkdayBoard, externalPath: string): string =>
  b.host.endsWith('.myworkdaysite.com') ? `https://${b.host}/recruiting/${b.tenant}/${b.site}${externalPath}` : `https://${b.host}/${b.site}${externalPath}`;

export type AppliedFacets = Readonly<Record<string, readonly string[]>>;
export const workdayListBody = (offset: number, appliedFacets: AppliedFacets = {}) => ({ appliedFacets, limit: WORKDAY_PAGE_SIZE, offset, searchText: '' });

/** A job path: `/job/<location>/<title>_<req id>`, plain path characters only. */
const EXTERNAL_PATH = /^\/job\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]+$/u;

const ListPosting = z
  .object({
    title: z.string().refine((t) => t.trim() !== '', 'blank title'),
    externalPath: z.string().regex(EXTERNAL_PATH, 'not a /job/ path'),
    locationsText: z.string().optional(),
    bulletFields: z.array(z.string()).optional(),
  })
  .passthrough();
const FacetValue: z.ZodType<FacetNode> = z.lazy(() =>
  z.object({ descriptor: z.string().optional(), id: z.string().optional(), count: z.number().optional(), facetParameter: z.string().optional(), values: z.array(FacetValue).optional() }).passthrough(),
);
interface FacetNode {
  readonly descriptor?: string | undefined;
  readonly id?: string | undefined;
  readonly count?: number | undefined;
  readonly facetParameter?: string | undefined;
  readonly values?: readonly FacetNode[] | undefined;
}
const ListPage = z.object({ total: z.number().int().nonnegative(), jobPostings: z.array(z.unknown()), facets: z.array(FacetValue).optional() }).passthrough();
type ListPosting = z.infer<typeof ListPosting>;

/** One list page: its valid postings, and the positions of the entries that are not postings (no title or path). */
export interface WorkdayListPage {
  readonly total: number;
  readonly jobPostings: readonly ListPosting[];
  readonly facets?: readonly FacetNode[] | undefined;
  /** Positions on the page of entries without a title or externalPath (seen live: Mastercard lists a bare `{bulletFields}`). */
  readonly malformed: readonly number[];
  /** Every entry the page listed, malformed ones included. */
  readonly count: number;
}

const Country = z.object({ descriptor: z.string().optional(), alpha2Code: z.string().optional() }).passthrough();
export const WorkdayDetail = z
  .object({
    jobPostingInfo: z
      .object({
        title: z.string(),
        jobDescription: z.string(),
        location: z.string().optional(),
        additionalLocations: z.array(z.string()).optional(),
        timeType: z.string().optional(),
        remoteType: z.string().optional(),
        jobReqId: z.string().optional(),
        country: Country.optional(),
        jobRequisitionLocation: z.object({ country: Country.optional() }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type WorkdayDetail = z.infer<typeof WorkdayDetail>;

function shapeError(what: string, r: { error: z.ZodError }): KernelError {
  const first = r.error.issues[0];
  const where = first === undefined ? '' : ` (${first.path.map(String).join('.') || 'root'}: ${first.message})`;
  return new KernelError('invalid_output', `${what}: response shape is not valid${where}`);
}

/**
 * A list page, shape-checked. A page missing `total` or `jobPostings` is `invalid_output`, never partially parsed. An
 * entry without a title or a /job/ externalPath is not a posting: it is skipped by position (the adapter notes it, as
 * the other sources note a malformed job), unless every entry of the page is one, which is schema drift:
 * `invalid_output`.
 */
export function parseListPage(json: unknown, what: string): WorkdayListPage {
  const r = ListPage.safeParse(json);
  if (!r.success) throw shapeError(`${what} list`, r);
  const ok: ListPosting[] = [];
  const malformed: number[] = [];
  r.data.jobPostings.forEach((p, i) => {
    const q = ListPosting.safeParse(p);
    if (q.success) ok.push(q.data);
    else malformed.push(i);
  });
  if (malformed.length > 0 && ok.length === 0) throw new KernelError('invalid_output', `${what} list: all ${malformed.length} entries lack a title or a /job/ externalPath`);
  return { total: r.data.total, jobPostings: ok, facets: r.data.facets, malformed, count: r.data.jobPostings.length };
}

export function parseDetail(json: unknown, what: string): WorkdayDetail {
  const r = WorkdayDetail.safeParse(json);
  if (!r.success) throw shapeError(`${what} detail`, r);
  return r.data;
}

/** The job req id: the `bulletFields` entry the externalPath ends with (`…_JR2026776`, `…_R-292398-1`), else null. */
export function reqIdOf(p: { readonly externalPath: string; readonly bulletFields?: readonly string[] | undefined }): string | null {
  const tail = p.externalPath.slice(p.externalPath.lastIndexOf('_') + 1);
  for (const b of p.bulletFields ?? []) {
    const id = b.trim();
    if (id === '' || !/^[A-Za-z0-9-]+$/u.test(id)) continue;
    // `…_JR2026776`, or a re-post `…_JR2027490-1`
    if (tail === id || (tail.startsWith(`${id}-`) && /^\d+$/u.test(tail.slice(id.length + 1)))) return id;
  }
  return null;
}

/** What a detail adds to a posting (null when it was not fetched). */
export interface WorkdayDetailRaw {
  readonly title: string;
  readonly description: string;
  readonly location: string | null;
  readonly additionalLocations: readonly string[];
  readonly country: string | null;
  readonly remoteType: string | null;
  readonly timeType: string | null;
}

export interface WorkdayRaw {
  readonly title: string;
  readonly url: string;
  readonly externalPath: string;
  readonly locationsText: string;
  readonly reqId: string | null;
  readonly detail: WorkdayDetailRaw | null;
}

export function detailRaw(d: WorkdayDetail): WorkdayDetailRaw {
  const i = d.jobPostingInfo;
  const country = i.country?.alpha2Code ?? i.jobRequisitionLocation?.country?.alpha2Code ?? i.country?.descriptor ?? null;
  return {
    title: i.title,
    description: i.jobDescription,
    location: i.location ?? null,
    additionalLocations: i.additionalLocations ?? [],
    country,
    remoteType: i.remoteType ?? null,
    timeType: i.timeType ?? null,
  };
}

/** One page's postings, each without its detail. */
export function pagePostings(b: WorkdayBoard, page: WorkdayListPage, req: Pick<DiscoveryRequest, 'company' | 'slug'>): RawPosting[] {
  return page.jobPostings.map((p) => {
    const reqId = reqIdOf(p);
    const raw: WorkdayRaw = { title: p.title, url: workdayJobUrl(b, p.externalPath), externalPath: p.externalPath, locationsText: p.locationsText ?? '', reqId, detail: null };
    return { source: 'workday', sourceId: reqId ?? p.externalPath, company: req.company, slug: req.slug, raw };
  });
}

// ---------------------------------------------------------------------------
// Host state: robots.txt and disabled hosts, injected by the run (trusted code)
// ---------------------------------------------------------------------------

/** The broker's HTTP tool, as an agent's context carries it. */
export type HttpTool = NonNullable<AgentContext['http']>;

/**
 * The run's view of the Workday hosts, built by the daily wiring (`daily-hosts.ts`) or the coverage verifier (the
 * coverage gate): robots.txt once per host per run, and the hosts disabled in this run.
 */
export interface WorkdayHosts {
  /** Null when robots.txt lets jobpilot fetch `path` on `host`, else the reason (`robots-disallow /wday/…`, `robots-forbidden`, …). */
  robots(host: string, path: string, http: HttpTool): Promise<string | null>;
  disabledWhy(host: string): string | undefined;
  disable(host: string, why: string): void;
}

/** robots.txt refuses the board's host or path. */
export class RobotsDenied extends Error {
  constructor(
    readonly host: string,
    readonly reason: string,
  ) {
    super(`robots-disallow ${host} (${reason})`);
    this.name = 'RobotsDenied';
  }
}

/** The host was disabled earlier in this run (by this company or another). */
export class HostDisabled extends Error {
  constructor(
    readonly host: string,
    readonly why: string,
  ) {
    super(`host-disabled:${why} on ${host}`);
    this.name = 'HostDisabled';
  }
}

/** A 401 or 403 from a Workday host: a refusal of the requester. The host is disabled for the run. */
export class WorkdayRefused extends Error {
  constructor(
    readonly status: number,
    readonly host: string,
  ) {
    super(`${host} answered ${status}`);
    this.name = 'WorkdayRefused';
  }
}

/** The request options every Workday request carries: the 2 s host spacing, and the caller's timeout. */
const reqOpts = (timeoutMs: number | undefined) => ({ minIntervalMs: WORKDAY_MIN_INTERVAL_MS, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

/**
 * One Workday request with the run's host rules: a disabled host is never asked; robots.txt is checked for the path;
 * 401/403 → the host is disabled and `WorkdayRefused`; 429 → disabled and the broker's `rate_limit`.
 */
async function hostRequest(
  http: HttpTool,
  hosts: WorkdayHosts,
  b: WorkdayBoard,
  url: string,
  send: () => Promise<{ status: number; json: unknown }>,
): Promise<{ status: number; json: unknown }> {
  const off = hosts.disabledWhy(b.host);
  if (off !== undefined) throw new HostDisabled(b.host, off);
  const denial = await hosts.robots(b.host, new URL(url).pathname, http);
  const off2 = hosts.disabledWhy(b.host);
  if (off2 !== undefined) throw new HostDisabled(b.host, off2);
  if (denial !== null) throw new RobotsDenied(b.host, denial);
  let r: { status: number; json: unknown };
  try {
    r = await send();
  } catch (e) {
    if (e instanceof KernelError && e.code === 'rate_limit') hosts.disable(b.host, 'http-429');
    throw e;
  }
  if (r.status === 401 || r.status === 403) {
    hosts.disable(b.host, `http-${r.status}`);
    throw new WorkdayRefused(r.status, b.host);
  }
  return r;
}

/** One list page (POST), shape-checked. A 404 is a retired board (`gone`), any other 4xx `invalid_output`. */
export async function fetchListPage(
  http: HttpTool,
  hosts: WorkdayHosts,
  b: WorkdayBoard,
  offset: number,
  facets: AppliedFacets = {},
  timeoutMs?: number,
): Promise<WorkdayListPage> {
  const url = workdayListUrl(b);
  const { status, json } = await hostRequest(http, hosts, b, url, () => http.postJson(url, workdayListBody(offset, facets), reqOpts(timeoutMs)));
  if (status === 404 || status === 410) throw new KernelError('gone', `workday board not found: ${workdayRef(b)}`);
  if (status >= 300) throw new KernelError('invalid_output', `${b.host} returned ${status} for the ${b.tenant}/${b.site} list at offset ${offset}`);
  return parseListPage(json, `workday ${workdayRef(b)}`);
}

/** One job's detail (GET), shape-checked; null when the job is gone (404/410). */
export async function fetchDetail(http: HttpTool, hosts: WorkdayHosts, b: WorkdayBoard, externalPath: string, timeoutMs?: number): Promise<WorkdayDetail | null> {
  const url = workdayDetailUrl(b, externalPath);
  const { status, json } = await hostRequest(http, hosts, b, url, () => http.getJson(url, reqOpts(timeoutMs)));
  if (status === 404 || status === 410) return null;
  if (status >= 300) throw new KernelError('invalid_output', `${b.host} returned ${status} for a ${b.tenant}/${b.site} job detail`);
  return parseDetail(json, `workday ${workdayRef(b)}`);
}

// ---------------------------------------------------------------------------
// The title pre-filter and the India facet
// ---------------------------------------------------------------------------

/** The parts of the pack the adapter reads: the title rules. */
const TitlePack = z.object({
  filters: z.object({ roleDeny: z.array(z.string()) }),
  targets: z.object({ titles: z.array(z.string()) }),
});
export type TitlePack = z.infer<typeof TitlePack>;

const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter((w) => w !== '');

/**
 * The cheap title pre-filter: no `filters.roleDeny` pattern matches (eligibility rule 2, the same compiled patterns),
 * and, when `targets.titles` is not empty, every word of one target title is a word of the title ("senior engineer"
 * passes "Senior DevOps Engineer"). It only decides which jobs get a detail; eligibility still judges every job.
 */
export function titlePasses(title: string, pack: TitlePack): boolean {
  if (pack.filters.roleDeny.some((p) => p.trim() !== '' && compileSafePattern(p).test(title))) return false;
  if (pack.targets.titles.length === 0) return true;
  const have = new Set(words(title));
  return pack.targets.titles.some((t) => {
    const want = words(t);
    return want.length > 0 && want.every((w) => have.has(w));
  });
}

/** The India location facet of a first page: `{ <facetParameter>: [ids] }`, or null when the board has none. */
export function indiaFacet(page: WorkdayListPage): AppliedFacets | null {
  const groups: { param: string; values: FacetNode[] }[] = [];
  const walk = (nodes: readonly FacetNode[], param: string | undefined): void => {
    for (const n of nodes) {
      if (n.values !== undefined) walk(n.values, n.facetParameter ?? param);
      else if (param !== undefined && n.id !== undefined && n.descriptor !== undefined) {
        let g = groups.find((x) => x.param === param);
        if (g === undefined) {
          g = { param, values: [] };
          groups.push(g);
        }
        g.values.push(n);
      }
    }
  };
  walk(page.facets ?? [], undefined);
  // a country-level value first ("India"), else every value of the one group naming India most often ("Pune, India")
  for (const g of groups) {
    const exact = g.values.filter((v) => (v.descriptor ?? '').trim().toLowerCase() === 'india');
    if (exact.length > 0) return { [g.param]: exact.map((v) => v.id as string) };
  }
  let best: { param: string; ids: string[] } | null = null;
  for (const g of groups) {
    const ids = g.values.filter((v) => /\bindia\b/iu.test(v.descriptor ?? '')).map((v) => v.id as string);
    if (ids.length > 0 && (best === null || ids.length > best.ids.length)) best = { param: g.param, ids };
  }
  return best === null ? null : { [best.param]: best.ids };
}

// ---------------------------------------------------------------------------
// The daily adapter
// ---------------------------------------------------------------------------

export const srcWorkdayContract = defineContract({
  id: 'src-workday',
  version: '1.0.0',
  description: 'Reads one verified Workday company\'s job list in full, with job details for the titles the pre-filter passes, within a per-company request budget, honouring robots.txt per host',
  skills: ['job-sourcing'],
  // Its own team (spec §6): a dead Workday tenant never opens a breaker for another platform or the ATS sources.
  team: 'sourcing-workday',
  kind: 'io',
  consumes: DiscoveryRequest,
  produces: RawPosting,
  requires: [knownAts],
  capabilities: { http: true, httpPost: true, pack: true },
  egress: [WORKDAY_EGRESS],
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: WORKDAY_TIMEOUT_MS,
  // 429 is never retried (the host is disabled); a retry starts the company again, so at most one.
  retry: { max: 1, on: ['overloaded', 'network'], backoffMs: [8000] },
});

export interface SrcWorkdayOptions {
  readonly hosts: WorkdayHosts;
  readonly maxPages?: number;
  readonly maxDetails?: number;
}

/** Sorted by sourceId (as `finish`), so the detail order is fixed for a given list. */
const bySourceId = (a: RawPosting, b: RawPosting): number => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);

/**
 * The detail order by listed location: 0 when it names India (or an Indian city), 1 when it names no country at all
 * ("2 Locations", or a US-state form like "California - San Francisco" that the place table does not know), 2 when it
 * names only other countries. Seen live 2026-10-14: without the first rank, Salesforce's 40 details went to state-named
 * US jobs ahead of its "India - Bangalore" ones.
 */
const locationRank = (p: RawPosting): number => {
  const c = countriesIn((p.raw as WorkdayRaw).locationsText);
  return c.includes('india') ? 0 : c.length === 0 ? 1 : 2;
};

/** Pages the list from offset 0 under `facets`, starting from its first page (already read): at most `maxPages` pages. */
async function readList(
  http: HttpTool,
  hosts: WorkdayHosts,
  b: WorkdayBoard,
  req: DiscoveryRequest,
  facets: AppliedFacets,
  first: WorkdayListPage,
  maxPages: number,
  ctx: AgentContext,
): Promise<{ postings: RawPosting[]; pages: number }> {
  const what = `workday ${req.company}`;
  const all: RawPosting[] = [];
  const seen = new Set<string>();
  const total = first.total;
  let page = first;
  let pages = 1;
  let listed = 0;
  for (let offset = 0; ; ) {
    if (page.count === 0) break;
    const paths = page.jobPostings.map((p) => p.externalPath);
    if (onlySeenBefore(seen, paths)) throw new KernelError('invalid_output', `${what}: the page at offset ${offset} repeats earlier postings (Workday ignored the offset)`);
    if (page.malformed.length > 0) ctx.skipped(page.malformed.map((i) => `workday ${req.company} offset ${offset} entry ${i}: no title or /job/ externalPath`));
    all.push(...pagePostings(b, page, req));
    listed += page.count;
    offset += WORKDAY_PAGE_SIZE;
    if (offset >= total) break;
    if (pages >= maxPages) throw new KernelError('invalid_output', `${what}: page cap reached at ${finish(all).length} postings (total ${total}, ${maxPages} pages)`);
    page = await fetchListPage(http, hosts, b, offset, facets);
    pages++;
  }
  // re-posts of one req are one posting (finish): the list is short only when it listed fewer entries than its total
  const postings = finish(all);
  if (listed < total) ctx.skipped([`short-list ${req.company}: total ${total}, listed ${listed}`]);
  return { postings, pages };
}

async function runCompany(req: DiscoveryRequest, ctx: AgentContext, o: Required<SrcWorkdayOptions>): Promise<RawPosting[]> {
  const http = ctx.http;
  if (!http) throw new KernelError('policy_denied', 'no http capability issued');
  const b = parseWorkdayRef(req.slug);
  if (b === null) throw new KernelError('invalid_output', `workday: ${req.slug} is not <host>/<tenant>/<site>`);
  const titles = TitlePack.safeParse(ctx.pack);
  if (!titles.success) throw new KernelError('invalid_output', 'src-workday: the pack is missing or lacks filters.roleDeny or targets.titles');
  const what = `workday ${req.company}`;
  try {
    let first = await fetchListPage(http, o.hosts, b, 0);
    let facets: AppliedFacets = {};
    if (first.total >= WORKDAY_TOTAL_CEILING) {
      const india = indiaFacet(first);
      if (india === null) throw new KernelError('invalid_output', `${what}: total ${first.total} is Workday's reporting ceiling and the board has no India location facet; its list cannot be read in full`);
      facets = india;
      first = await fetchListPage(http, o.hosts, b, 0, facets);
      if (first.total >= WORKDAY_TOTAL_CEILING) throw new KernelError('invalid_output', `${what}: the India-scoped list still reports Workday's ${WORKDAY_TOTAL_CEILING} ceiling; it cannot be read in full`);
      ctx.skipped([`scope ${req.company}: India location facet only (Workday reports its ${WORKDAY_TOTAL_CEILING} ceiling)`]);
    }
    const { postings } = await readList(http, o.hosts, b, req, facets, first, o.maxPages, ctx);

    // details: title pre-filter, then India-possible locations first, then sourceId
    const wanted = postings
      .filter((p) => titlePasses((p.raw as WorkdayRaw).title, titles.data))
      .sort((x, y) => locationRank(x) - locationRank(y) || bySourceId(x, y));
    const chosen = wanted.slice(0, o.maxDetails);
    if (wanted.length > chosen.length) ctx.skipped([`detail-budget ${req.company}: ${wanted.length - chosen.length} jobs without detail`]);
    const details = new Map<string, WorkdayDetailRaw | null>();
    for (const p of chosen) {
      const raw = p.raw as WorkdayRaw;
      const d = await fetchDetail(http, o.hosts, b, raw.externalPath);
      details.set(p.sourceId, d === null ? null : detailRaw(d));
    }
    const gone = [...details.entries()].filter(([, d]) => d === null).map(([id]) => id);
    if (gone.length > 0) ctx.skipped([`detail-gone ${req.company}: ${gone.length} ${gone.length === 1 ? 'job' : 'jobs'} gone between list and detail (${gone.slice(0, 5).join(', ')}${gone.length > 5 ? ', …' : ''})`]);
    return postings
      .filter((p) => !gone.includes(p.sourceId))
      .map((p) => {
        const d = details.get(p.sourceId);
        return d === undefined || d === null ? p : { ...p, raw: { ...(p.raw as WorkdayRaw), detail: d } };
      });
  } catch (e) {
    if (e instanceof RobotsDenied) {
      ctx.skipped([`robots-disallow ${e.host}: ${req.company} not read today (${e.reason})`]);
      return [];
    }
    if (e instanceof HostDisabled) throw new KernelError('input_rejected', `host-disabled:${e.why} on ${e.host}; ${req.company} deferred to the next run, never retried around`);
    if (e instanceof WorkdayRefused) throw new KernelError('challenged', `${e.host} answered ${e.status}: the host is disabled for this run, never retried around`);
    throw e;
  }
}

/** Builds `src-workday` for one run, on the run's host state (robots.txt cache and disabled hosts). */
export function makeSrcWorkday(o: SrcWorkdayOptions): Agent<DiscoveryRequest, RawPosting> {
  const opts: Required<SrcWorkdayOptions> = { hosts: o.hosts, maxPages: o.maxPages ?? WORKDAY_MAX_PAGES, maxDetails: o.maxDetails ?? WORKDAY_MAX_DETAILS };
  return defineAgent(srcWorkdayContract, (req, ctx) => (req.ats === 'workday' ? runCompany(req, ctx, opts) : Promise.resolve([])));
}
