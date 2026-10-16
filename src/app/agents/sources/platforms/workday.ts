import { z } from 'zod';
import { defineAgent, type Agent, type AgentContext } from '../../../../kernel/agent.js';
import { defineContract } from '../../../../kernel/contract.js';
import { KernelError } from '../../../../kernel/errors.js';
import { DEFAULT_RESIDENCE, type ResidenceScope } from '../../../geo/residence.js';
import { countriesIn, officeCity } from '../../../text/norm.js';
import { DiscoveryRequest, knownAts, RawPosting } from '../../../types.js';
import { finish, onlySeenBefore } from '../common.js';
import {
  chooseDetails,
  exactCountryRe,
  goneNote,
  HostRefused,
  hostRequest,
  PLATFORM_NOTE_PREFIXES,
  preferPostings as preferBy,
  refusal,
  REMOTE_TYPE,
  residenceOf,
  scopeMiss,
  scopeNotApplied,
  shapeError,
  titlePackOf,
  type HttpTool,
  type PlatformHosts,
  listName,
} from './shared.js';

// the shared host rules and title pre-filter, under the names Task 6 gave them

/** The per-run scopes cache key: India's is today's; another residence adds a separator no city name can contain. */
export const workdayScopesKey = (ref: string, cities: readonly string[], residence: ResidenceScope): string =>
  `${ref} ${cities.join(',')}${residence.isDefault ? '' : `\u0000res=${residence.code}`}`;

export { HostDisabled, RobotsDenied, titlePasses, type HttpTool, type TitlePack } from './shared.js';
export { HostRefused as WorkdayRefused };

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
 * Scope (Fix round 1, Decision A): the user can only take a job located in India or a remote one, so every read is
 * scoped by the board's own facets (`workdayScopes`), found on the unscoped first page (offset 0, read for its `facets`
 * only, and cached per company per run in the injected `WorkdayHosts`, never persisted):
 * - the India list (`appliedFacets` = an exact "India" value, or a known location facet's values naming an Indian
 *   place, whichever candidate has the largest facet count) and the remote list (the remote work-type values, taken out
 *   value by value, never their whole facet) are read,
 *   and their union is deduped by req id. A Workday facet matches ANY of a job's locations, so a "2 Locations" job
 *   with Bengaluru among them comes in through the India list;
 * - an office-city list per pack `eligibility.officeCities` entry whose location values the facets name ("India,
 *   Bengaluru", "India - Bangalore"; known location parameters only, never e.g. a delivery-hub facet): its postings,
 *   keyed by externalPath, carry those values as `officeLocations`, so a "2 Locations" job the detail
 *   budget does not reach is judged on Workday's own statement that one of its locations is that office (seen live
 *   2026-10-14: NVIDIA's India list alone has more title-passing India-named jobs than the 80 details, so no
 *   "N Locations" job got one);
 * - location facets naming neither India nor a remote type: the tenant has nothing the user can take, a named skip
 *   `no-india-or-remote-facet <company>: …`, nothing more read;
 * - no location facets at all (an unusual tenant): the unscoped list is read in full from that first page;
 * - every scoped list is checked against the discovery page's facet counts (Fix round 2): a page-1 total above the
 *   selected values' count sum + max(5, 5%) means Workday did not apply the scope (a stale or refused facet id): the
 *   step fails `input_rejected` `scope-not-applied <company> <list>`, and nothing is stamped;
 * - and from below (Fix round 3): a page-1 total under the largest single selected value's count − max(5, 5%) (a
 *   value count is never double-counted) is a stale facet id answering with too little, never a silent zero: the
 *   same `scope-not-applied` refusal;
 * - an office list must be a SUBSET of the India list (both are read, no extra request): one holding any other job was
 *   not applied (a small board answering in full under a small count), so it gets the named note
 *   `scope-not-applied <company> <city> office list: …; nothing stamped` and stamps nothing;
 * - one req posted twice ("_JR1" in Pune, "_JR1-1" in Bengaluru) is one posting: the office-listed one is kept, then
 *   one whose listed location names India, then the first seen (`preferPostings`, deterministic);
 * - accepted: the largest-count India choice prefers city values, so an ambiguous city value ("Delhi, NY", a
 *   "Hyderabad" in Pakistan) can widen the India read; eligibility still rejects those as non-Bengaluru onsite;
 * - the trade-off, by design: a job whose locations are all outside India and which is not tagged remote is never read.
 *
 * List: `POST https://<host>/wday/cxs/<tenant>/<site>/jobs` with `{"appliedFacets":{…},"limit":20,"offset":<n>,
 * "searchText":""}` (a limit over 20 answers 400), paged by `offset` until a page is empty or `offset >= total`.
 * Workday reports `total` on the first page only (later pages say 0), and caps it at WORKDAY_TOTAL_CEILING: past
 * offset 2000 it serves the first page again (seen live 2026-10-14 on NVIDIA, whose facets count 2,699 jobs). So:
 * - a page whose jobs were all seen before is `invalid_output` (the API ignored the offset), never more postings;
 * - a list (scoped, or the unscoped fallback) whose first page reports the ceiling cannot be read in full: it fails loudly;
 * - at most `workdayPagesPerList(office cities)` pages per list (WORKDAY_MAX_PAGES, less when the pack names several
 *   office cities, so the whole step stays within WORKDAY_MAX_REQUESTS, 90% of the step timeout at the 2 s spacing);
 *   a longer list fails loudly (`page cap reached`);
 * - the deterministic per-tenant refusals (the ceiling, the page cap, scope-not-applied) are `input_rejected`: they say
 *   nothing about the platform's health, so they never push the Workday breaker; transport failures and drift do;
 * - a list that ends before its reported total gets the note `short-list <company>: total N, listed M`.
 *
 * Detail: `GET https://<host>/wday/cxs/<tenant>/<site><externalPath>`, for at most WORKDAY_MAX_DETAILS jobs per
 * company per run, only for RANK-0 jobs (listed location naming India, India-remote included, or listed under an office
 * city: Fix round 2, the timing decision), and only for jobs whose title passes the cheap title pre-filter (`titlePasses`: no pack
 * `filters.roleDeny` pattern, eligibility's own rule 2, and every word of one `targets.titles` entry; only a budget
 * hint, the scorer decides relevance), ties by req id. "N Locations" and other jobs never get one. Jobs without a
 * detail get the named note `detail-budget <company>: N jobs without detail (k over the budget, m not India-named)`,
 * and they still flow, with a null detail. A detail answering 404 or
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
/** Details per company per run, for rank-0 jobs only (India-named, office-listed): Fix round 2, the timing decision. */
export const WORKDAY_MAX_DETAILS = 40;
/** Workday's `total` never exceeds this; a first page reporting it may hide more jobs. */
export const WORKDAY_TOTAL_CEILING = 2000;
/** The spacing of requests to one Workday host (spec §4: at least 2 s per host). */
export const WORKDAY_MIN_INTERVAL_MS = 2000;
/** The kernel's step maximum. */
export const WORKDAY_TIMEOUT_MS = 900_000;
/**
 * The requests one step may make at most: at the 2 s host spacing they fill 90% of the step timeout, so a capped list
 * fails loudly (`page cap reached`) before the step would time out. The pacing check divides the timeout by it.
 */
export const WORKDAY_MAX_REQUESTS = Math.floor((WORKDAY_TIMEOUT_MS * 0.9) / WORKDAY_MIN_INTERVAL_MS);
/**
 * The page cap of each list when the pack names `officeCities` office cities: robots.txt, the discovery page and the
 * details are set aside, and the rest is shared by the India, remote and office lists (at most WORKDAY_MAX_PAGES each).
 */
export function workdayPagesPerList(officeCities: number): number {
  return Math.min(WORKDAY_MAX_PAGES, Math.floor((WORKDAY_MAX_REQUESTS - 2 - WORKDAY_MAX_DETAILS) / (2 + Math.max(0, officeCities))));
}
/** The symbolic egress resolved per run to the verified Workday companies' hosts. */
export const WORKDAY_EGRESS = 'registry:workday-hosts';

/** The note prefixes of the named skips (problems.ts prints them as they are, never as "malformed"). */
export const WORKDAY_NOTE_PREFIXES = PLATFORM_NOTE_PREFIXES;

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
  /**
   * The office-city location values of the board's facets this job is listed under ("India, Bengaluru"): Workday's own
   * statement that one of its locations is there. It lets a "2 Locations" job the detail budget did not reach be
   * judged on that place instead of being rejected as an unknown location. Empty when it is listed under none.
   */
  readonly officeLocations?: readonly string[];
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
    const raw: WorkdayRaw = { title: p.title, url: workdayJobUrl(b, p.externalPath), externalPath: p.externalPath, locationsText: p.locationsText ?? '', reqId, detail: null, officeLocations: [] };
    return { source: 'workday', sourceId: reqId ?? p.externalPath, company: req.company, slug: req.slug, raw };
  });
}

// ---------------------------------------------------------------------------
// Host state: robots.txt and disabled hosts, injected by the run (trusted code)
// ---------------------------------------------------------------------------

/**
 * The run's view of the Workday hosts, built by the daily wiring (`daily-hosts.ts`) or the coverage verifier (the
 * coverage gate): robots.txt once per host per run, the hosts disabled in this run, and each board's discovered scopes.
 */
export type WorkdayHosts = PlatformHosts<WorkdayScopes>;

/** The request options every Workday request carries: the 2 s host spacing, and the caller's timeout. */
const reqOpts = (timeoutMs: number | undefined) => ({ minIntervalMs: WORKDAY_MIN_INTERVAL_MS, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

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
  const { status, json } = await hostRequest(http, hosts, b.host, url, () => http.postJson(url, workdayListBody(offset, facets), reqOpts(timeoutMs)));
  if (status === 404 || status === 410) throw new KernelError('gone', `workday board not found: ${workdayRef(b)}`);
  if (status >= 300) throw new KernelError('invalid_output', `${b.host} returned ${status} for the ${b.tenant}/${b.site} list at offset ${offset}`);
  return parseListPage(json, `workday ${workdayRef(b)}`);
}

/** One job's detail (GET), shape-checked; null when the job is gone (404/410). */
export async function fetchDetail(http: HttpTool, hosts: WorkdayHosts, b: WorkdayBoard, externalPath: string, timeoutMs?: number): Promise<WorkdayDetail | null> {
  const url = workdayDetailUrl(b, externalPath);
  const { status, json } = await hostRequest(http, hosts, b.host, url, () => http.getJson(url, reqOpts(timeoutMs)));
  if (status === 404 || status === 410) return null;
  if (status >= 300) throw new KernelError('invalid_output', `${b.host} returned ${status} for a ${b.tenant}/${b.site} job detail`);
  return parseDetail(json, `workday ${workdayRef(b)}`);
}

// ---------------------------------------------------------------------------
// The title pre-filter and the facet scopes
// ---------------------------------------------------------------------------

/** One scoped list: the facet selection, and how many jobs the discovery page's facet counts say it holds. */
export interface WorkdayScope {
  readonly facets: AppliedFacets;
  /** The sum of the selected values' `count` (a job listed under two values counts twice: an upper bound). */
  readonly expected: number;
  /** The largest single selected value's `count` (never double-counted: a lower bound of the list). */
  readonly largest: number;
}

/** What a board's first-page facets let the adapter scope to: the India, remote-type and office-city lists. */
export interface WorkdayScopes {
  /** Jobs with any location in India; null when the facets name none. */
  readonly india: WorkdayScope | null;
  /** Jobs of a remote work type; null when the board has no such value. */
  readonly remote: WorkdayScope | null;
  /** Whether the board has location facets at all (a country, location or site facet). */
  readonly located: boolean;
  /** Per pack office city found among the known location facets' values: its list and the values' descriptors. */
  readonly offices: readonly (WorkdayScope & { readonly display: string; readonly labels: readonly string[] })[];
}

/**
 * The location facet parameters seen on real tenants (the recorded NVIDIA, Salesforce and Mastercard boards, the
 * careers-sites research): only these may scope by city values or stamp an office. `locationHierarchy2` is NVIDIA's
 * location TYPE (Office/Remote), so it is not here. An unknown parameter ("workSiteHub: Bangalore Hub - Global
 * Delivery") gives India only through a value that is exactly "India", and never an office.
 */
export const KNOWN_LOCATION_PARAMS: readonly string[] = [
  'locations', 'locationCountry', 'Location_Country', 'locationHierarchy1', 'primaryLocation', 'Location', 'location',
  'locationRegionStateProvince', 'Location_Region_State_Province', 'locationCity', 'Location_City',
];
/** A parameter that is at least location-like: decides only between the named skip and the unscoped read. */
const LOCATION_LIKE = /location|countr|site/iu;

/**
 * The scopes of a board, from the facets of its unscoped first page (Fix round 1, Decision A; Fix round 2):
 * - remote values are taken out VALUE by value (the whole descriptor a remote type), never their whole facet, so a
 *   `locations` facet holding "Remote" next to "Bengaluru, India" still gives India and the office;
 * - India: every candidate is collected, and the one with the LARGEST facet count wins (ties: served order): each
 *   facet's value that is exactly "India" (any parameter), and, per known location parameter, its values naming an
 *   Indian place ("Pune, India", "Navi Mumbai, India (Finicity)"). A larger count covers more jobs: Salesforce's
 *   anchor Country "India" (109, a job's primary country) loses to its India site values (236);
 * - remote: the remote values of the first facet holding one;
 * - offices: per pack office city, the values of a KNOWN location parameter naming it (and no country but India),
 *   from the parameter with the most such values;
 * - located: any location-like parameter.
 * Deterministic: facet order as served, values in order. `expected` feeds the scope-not-applied check.
 * Profiles Task 14: India is the residence `scope` (default IN): its display name, its places, its office table.
 */
export function workdayScopes(page: WorkdayListPage, officeCities: readonly string[] = [], scope: ResidenceScope = DEFAULT_RESIDENCE): WorkdayScopes {
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
  const countOf = (v: FacetNode): number => (typeof v.count === 'number' && Number.isFinite(v.count) ? v.count : 0);
  const scopeOf = (param: string, vs: readonly FacetNode[]): WorkdayScope => ({
    facets: { [param]: vs.map((v) => v.id as string) },
    expected: vs.reduce((n, v) => n + countOf(v), 0),
    largest: vs.reduce((n, v) => Math.max(n, countOf(v)), 0),
  });
  const isRemote = (v: FacetNode): boolean => REMOTE_TYPE.test(v.descriptor ?? '');
  const known = (param: string): boolean => KNOWN_LOCATION_PARAMS.includes(param);

  const remoteGroup = groups.find((g) => g.values.some(isRemote));
  const remote = remoteGroup === undefined ? null : scopeOf(remoteGroup.param, remoteGroup.values.filter(isRemote));

  const exactRe = exactCountryRe(scope);
  const candidates: WorkdayScope[] = [];
  for (const g of groups) {
    const exact = g.values.filter((v) => !isRemote(v) && exactRe.test(v.descriptor ?? ''));
    if (exact.length > 0) candidates.push(scopeOf(g.param, exact));
  }
  for (const g of groups) {
    if (!known(g.param)) continue;
    const named = g.values.filter((v) => !isRemote(v) && !exactRe.test(v.descriptor ?? '') && countriesIn(v.descriptor ?? '', scope.table).includes(scope.country));
    if (named.length > 0) candidates.push(scopeOf(g.param, named));
  }
  let india: WorkdayScope | null = null;
  for (const c of candidates) if (india === null || c.expected > india.expected) india = c;

  const offices: (WorkdayScope & { display: string; labels: string[] })[] = [];
  const words = (d: string): string[] => d.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
  for (const city of officeCities.map((c) => officeCity(c, scope.table))) {
    if (offices.some((o) => o.display === city.display)) continue;
    const names = (d: string): boolean => {
      const w = ' ' + words(d).join(' ') + ' ';
      const places = countriesIn(d, scope.table);
      return city.aliases.some((a) => w.includes(' ' + words(a).join(' ') + ' ')) && (places.length === 0 || places.includes(scope.country));
    };
    let best: FacetNode[] = [];
    let param = '';
    for (const g of groups) {
      if (!known(g.param)) continue;
      const hit = g.values.filter((v) => !isRemote(v) && names(v.descriptor ?? ''));
      if (hit.length > best.length) {
        best = hit;
        param = g.param;
      }
    }
    if (best.length > 0) offices.push({ display: city.display, ...scopeOf(param, best), labels: best.map((v) => v.descriptor as string) });
  }
  return { india, remote, located: groups.some((g) => known(g.param) || LOCATION_LIKE.test(g.param)), offices };
}

// ---------------------------------------------------------------------------
// The daily adapter
// ---------------------------------------------------------------------------

export const srcWorkdayContract = defineContract({
  id: 'src-workday',
  // 1.1.0: the reads are scoped to the board's India and remote facets (Fix round 1); 1.2.0: DiscoveryRequest/Posting.ats gained eightfold, oracle (Task 7)
  version: '1.5.0',
  description: 'Reads one verified Workday company\'s India-located or remote job lists, with job details for the titles the pre-filter passes, within a per-company request budget, honouring robots.txt per host',
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

/** The detail order by listed location: 0 when it names the residence (India: or an Indian place) or is listed under an office city, 1 for "N Locations", 2 for the rest. */
const locationRank = (p: RawPosting, scope: ResidenceScope): number => {
  const raw = p.raw as WorkdayRaw;
  const text = raw.locationsText;
  if (countriesIn(text, scope.table).includes(scope.country) || (raw.officeLocations ?? []).length > 0) return 0;
  return /^\s*\d+\s+locations?\s*$/iu.test(text) ? 1 : 2;
};

/** Each posting once, by externalPath (unique per posting), the first seen kept. */
function byPath(postings: readonly RawPosting[]): RawPosting[] {
  const seen = new Map<string, RawPosting>();
  for (const p of postings) {
    const path = (p.raw as WorkdayRaw).externalPath;
    if (!seen.has(path)) seen.set(path, p);
  }
  return [...seen.values()];
}

/**
 * One posting per req id (a req posted twice, "_JR1" in Pune and "_JR1-1" in Bengaluru, is one job): the office-listed
 * one wins, then one whose listed location names India, then the first seen; sorted by sourceId (as `finish`).
 */
function preferPostings(postings: readonly RawPosting[], scope: ResidenceScope): RawPosting[] {
  const pref = (p: RawPosting): number => {
    const raw = p.raw as WorkdayRaw;
    if ((raw.officeLocations ?? []).length > 0) return 0;
    return countriesIn(raw.locationsText, scope.table).includes(scope.country) ? 1 : 2;
  };
  return preferBy(byPath(postings), pref);
}

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
  label = '',
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
    if (pages >= maxPages) throw new KernelError('input_rejected', `${what}: page cap reached at ${finish(all).length} postings (total ${total}, ${maxPages} pages)`);
    page = await fetchListPage(http, hosts, b, offset, facets);
    pages++;
  }
  // every posting by its path (re-posts of one req are chosen between later, `preferPostings`); the list is short only when it listed fewer entries than its total
  const postings = byPath(all);
  if (listed < total) ctx.skipped([`short-list ${req.company}${label}: total ${total}, listed ${listed}`]);
  return { postings, pages };
}

async function runCompany(req: DiscoveryRequest, ctx: AgentContext, o: Required<SrcWorkdayOptions>): Promise<RawPosting[]> {
  const http = ctx.http;
  if (!http) throw new KernelError('policy_denied', 'no http capability issued');
  const b = parseWorkdayRef(req.slug);
  if (b === null) throw new KernelError('invalid_output', `workday: ${req.slug} is not <host>/<tenant>/<site>`);
  const titles = { data: titlePackOf(ctx.pack, 'src-workday') };
  const residence = residenceOf(titles.data, 'src-workday');
  const what = `workday ${req.company}`;
  try {
    const ref = workdayRef(b);
    const cities = titles.data.eligibility?.officeCities ?? [];
    // the scopes depend on the residence (India's key is today's)
    const cacheKey = workdayScopesKey(ref, cities, residence);
    let scopes = o.hosts.scopes?.get(cacheKey);
    let first: WorkdayListPage | undefined;
    if (scopes === undefined) {
      first = await fetchListPage(http, o.hosts, b, 0);
      scopes = workdayScopes(first, cities, residence);
      o.hosts.scopes?.set(cacheKey, scopes);
    }
    let postings: RawPosting[];
    const maxPages = Math.min(o.maxPages, workdayPagesPerList(new Set(cities.map((c) => officeCity(c, residence.table).display)).size));
    /** Page 1 of a scoped list (`list`: "the india scoped list"; `name`: "india"), refused when Workday did not apply the scope or reports its ceiling. */
    const scopedFirst = async (list: string, name: string, sc: WorkdayScope): Promise<WorkdayListPage> => {
      const page1 = await fetchListPage(http, o.hosts, b, 0, sc.facets);
      if (page1.total >= WORKDAY_TOTAL_CEILING) throw new KernelError('input_rejected', `${what}: ${list} reports Workday's ${WORKDAY_TOTAL_CEILING} ceiling; it cannot be read in full`);
      // a scope Workday ignored (a stale or refused facet id) answers with more jobs than its facet values hold, or
      // with less than its largest selected value: never read, never a silent zero
      const miss = scopeMiss(page1.total, sc);
      if (miss !== null) throw scopeNotApplied(req.company, name, miss, 'Workday');
      return page1;
    };
    const lists = ([['india', scopes.india], ['remote', scopes.remote]] as const).filter((x): x is readonly ['india' | 'remote', WorkdayScope] => x[1] !== null);
    if (lists.length > 0) {
      const all: RawPosting[] = [];
      const indiaRead = new Set<string>();
      for (const [key, sc] of lists) {
        // the residence list's name in requests' notes is the residence token ('india' for IN)
        const name = key === 'india' ? listName(residence) : key;
        const page1 = await scopedFirst(`the ${name} scoped list`, name, sc);
        const read = (await readList(http, o.hosts, b, req, sc.facets, page1, maxPages, ctx, ` (${name} list)`)).postings;
        if (key === 'india') for (const p of read) indiaRead.add((p.raw as WorkdayRaw).externalPath);
        all.push(...read);
      }
      // the office-city lists: which postings (by externalPath, unique per posting) Workday lists under an office value.
      // An office list must be a subset of the India list (both are read): one holding any other job was not applied
      // (a small board answering in full under a small count), so nothing from it is stamped.
      const offices = new Map<string, string[]>();
      for (const office of scopes.offices) {
        const page1 = await scopedFirst(`the ${office.display} office list`, office.display, office);
        const listed = (await readList(http, o.hosts, b, req, office.facets, page1, maxPages, ctx, ` (${office.display} list)`)).postings;
        const outside = listed.filter((p) => !indiaRead.has((p.raw as WorkdayRaw).externalPath)).length;
        if (outside > 0) {
          ctx.skipped([`scope-not-applied ${req.company} ${office.display} office list: ${outside} of its ${listed.length} jobs are not in the ${residence.display} list; nothing stamped`]);
          continue;
        }
        for (const p of listed) {
          const path = (p.raw as WorkdayRaw).externalPath;
          offices.set(path, [...(offices.get(path) ?? []), ...office.labels]);
        }
      }
      postings = preferPostings(
        all.map((p) => {
          const labels = offices.get((p.raw as WorkdayRaw).externalPath);
          return labels === undefined ? p : { ...p, raw: { ...(p.raw as WorkdayRaw), officeLocations: labels } };
        }),
        residence,
      );
    } else if (scopes.located) {
      ctx.skipped([`no-${residence.token}-or-remote-facet ${req.company}: its location facets name neither ${residence.display} nor a remote type`]);
      return [];
    } else {
      first ??= await fetchListPage(http, o.hosts, b, 0);
      if (first.total >= WORKDAY_TOTAL_CEILING) throw new KernelError('input_rejected', `${what}: total ${first.total} is Workday's reporting ceiling and the board has no location facets to scope by; its list cannot be read in full`);
      postings = preferPostings((await readList(http, o.hosts, b, req, {}, first, maxPages, ctx)).postings, residence);
    }

    // details: rank-0 title-passing jobs only (India-named, India-remote, office-listed), ties by sourceId, at most the budget
    const chosen = chooseDetails(postings, { pack: titles.data, title: (p) => (p.raw as WorkdayRaw).title, rank0: (p) => locationRank(p, residence) === 0, max: o.maxDetails, company: req.company, ctx, residence });
    const details = new Map<string, WorkdayDetailRaw | null>();
    for (const p of chosen) {
      const raw = p.raw as WorkdayRaw;
      const d = await fetchDetail(http, o.hosts, b, raw.externalPath);
      details.set(p.sourceId, d === null ? null : detailRaw(d));
    }
    const gone = [...details.entries()].filter(([, d]) => d === null).map(([id]) => id);
    if (gone.length > 0) ctx.skipped([goneNote(req.company, gone)]);
    return postings
      .filter((p) => !gone.includes(p.sourceId))
      .map((p) => {
        const d = details.get(p.sourceId);
        return d === undefined || d === null ? p : { ...p, raw: { ...(p.raw as WorkdayRaw), detail: d } };
      });
  } catch (e) {
    refusal(e, req.company, ctx);
    return [];
  }
}

/** Builds `src-workday` for one run, on the run's host state (robots.txt cache and disabled hosts). */
export function makeSrcWorkday(o: SrcWorkdayOptions): Agent<DiscoveryRequest, RawPosting> {
  const opts: Required<SrcWorkdayOptions> = { hosts: o.hosts, maxPages: o.maxPages ?? WORKDAY_MAX_PAGES, maxDetails: o.maxDetails ?? WORKDAY_MAX_DETAILS };
  return defineAgent(srcWorkdayContract, (req, ctx) => (req.ats === 'workday' ? runCompany(req, ctx, opts) : Promise.resolve([])));
}
