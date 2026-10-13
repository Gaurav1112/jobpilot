import { z } from 'zod';
import { defineAgent, type Agent, type AgentContext } from '../../../../kernel/agent.js';
import { defineContract } from '../../../../kernel/contract.js';
import { KernelError } from '../../../../kernel/errors.js';
import { compileSafePattern } from '../../../pack/regex.js';
import { countriesIn, officeCity } from '../../../text/norm.js';
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
 * Scope (Fix round 1, Decision A): the user can only take a job located in India or a remote one, so every read is
 * scoped by the board's own facets (`workdayScopes`), found on the unscoped first page (offset 0, read for its `facets`
 * only, and cached per company per run in the injected `WorkdayHosts`, never persisted):
 * - the India list (`appliedFacets` = the India value of the country facet, or, without a country level, the location
 *   values naming an Indian place) and the remote list (the remote work-type value, when the board has one) are read,
 *   and their union is deduped by req id. A Workday facet matches ANY of a job's locations, so a "2 Locations" job
 *   with Bengaluru among them comes in through the India list;
 * - an office-city list per pack `eligibility.officeCities` entry whose location values the facets name ("India,
 *   Bengaluru", "India - Bangalore"): its jobs carry those values as `officeLocations`, so a "2 Locations" job the detail
 *   budget does not reach is judged on Workday's own statement that one of its locations is that office (seen live
 *   2026-10-14: NVIDIA's India list alone has more title-passing India-named jobs than the 80 details, so no
 *   "N Locations" job got one);
 * - location facets naming neither India nor a remote type: the tenant has nothing the user can take, a named skip
 *   `no-india-or-remote-facet <company>: …`, nothing more read;
 * - no location facets at all (an unusual tenant): the unscoped list is read in full from that first page;
 * - the trade-off, by design: a job whose locations are all outside India and which is not tagged remote is never read.
 *
 * List: `POST https://<host>/wday/cxs/<tenant>/<site>/jobs` with `{"appliedFacets":{…},"limit":20,"offset":<n>,
 * "searchText":""}` (a limit over 20 answers 400), paged by `offset` until a page is empty or `offset >= total`.
 * Workday reports `total` on the first page only (later pages say 0), and caps it at WORKDAY_TOTAL_CEILING: past
 * offset 2000 it serves the first page again (seen live 2026-10-14 on NVIDIA, whose facets count 2,699 jobs). So:
 * - a page whose jobs were all seen before is `invalid_output` (the API ignored the offset), never more postings;
 * - a list (scoped, or the unscoped fallback) whose first page reports the ceiling cannot be read in full: it fails loudly;
 * - WORKDAY_MAX_PAGES pages per list per company per run; a list longer than that fails loudly (`page cap reached`);
 * - a list that ends before its reported total gets the note `short-list <company>: total N, listed M`.
 *
 * Detail: `GET https://<host>/wday/cxs/<tenant>/<site><externalPath>`, for at most WORKDAY_MAX_DETAILS jobs per
 * company per run, and only for jobs whose title passes the cheap title pre-filter (`titlePasses`: no pack
 * `filters.roleDeny` pattern, eligibility's own rule 2, and every word of one `targets.titles` entry; only a budget
 * hint, the scorer decides relevance). Jobs whose listed location names India, or listed under an office city, come first, then "N Locations", then
 * the rest, ties by req id (`locationRank`). Jobs past the budget get no detail: the named note
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
export const WORKDAY_MAX_DETAILS = 80;
/** Workday's `total` never exceeds this; a first page reporting it may hide more jobs. */
export const WORKDAY_TOTAL_CEILING = 2000;
/** The spacing of requests to one Workday host (spec §4: at least 2 s per host). */
export const WORKDAY_MIN_INTERVAL_MS = 2000;
/** The kernel's step maximum: robots + the discovery page + 100 pages of each of three lists (India, remote, one office city) + 80 details = 382 requests, 2.36 s each. */
export const WORKDAY_TIMEOUT_MS = 900_000;
/** Requests one step may make at most (the pacing check's arithmetic): robots.txt, the discovery page, the India, remote and one office list's pages, and the details. */
export const WORKDAY_MAX_REQUESTS = 1 + 1 + 3 * WORKDAY_MAX_PAGES + WORKDAY_MAX_DETAILS;
/** The symbolic egress resolved per run to the verified Workday companies' hosts. */
export const WORKDAY_EGRESS = 'registry:workday-hosts';

/** The note prefixes of the named skips (problems.ts prints them as they are, never as "malformed"). */
export const WORKDAY_NOTE_PREFIXES = ['robots-disallow ', 'detail-budget ', 'detail-gone ', 'no-india-or-remote-facet ', 'short-list '] as const;

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
  /** The board's discovered scopes, cached for this run only (absent: discovered on every read). */
  readonly scopes?: Map<string, WorkdayScopes>;
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
// The title pre-filter and the facet scopes
// ---------------------------------------------------------------------------

/** The parts of the pack the adapter reads: the title rules. */
const TitlePack = z.object({
  filters: z.object({ roleDeny: z.array(z.string()) }),
  targets: z.object({ titles: z.array(z.string()) }),
  // the office cities (eligibility rule 5e), for the office-city lists only
  eligibility: z.object({ officeCities: z.array(z.string()).optional() }).optional(),
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

/** What a board's first-page facets let the adapter scope to: the India and remote-type lists, and whether it has location facets at all. */
export interface WorkdayScopes {
  /** `{ <facetParameter>: [ids] }` selecting jobs with any location in India; null when the facets name none. */
  readonly india: AppliedFacets | null;
  /** `{ <facetParameter>: [ids] }` selecting jobs of a remote work type; null when the board has no such facet. */
  readonly remote: AppliedFacets | null;
  /** Whether the board has location facets at all (a country, location or site facet). */
  readonly located: boolean;
  /** Per pack office city found among the location values: the facet selecting it and the values' descriptors. */
  readonly offices: readonly { readonly display: string; readonly facets: AppliedFacets; readonly labels: readonly string[] }[];
}

/** A remote work-type value: the whole descriptor says remote ("Remote", "Virtual", "Work from home"), not a remote site ("California - Remote"). */
const REMOTE_TYPE = /^\s*(?:fully\s+)?(?:remote|virtual|work\s+from\s+home|wfh|home[\s-]based)\s*$/iu;
const LOCATION_PARAM = /location|countr|site/iu;

/**
 * The scopes of a board, from the facets of its unscoped first page (Fix round 1, Decision A):
 * - India: the value whose descriptor is exactly "India" in any facet (a country level: NVIDIA's `locationHierarchy1`,
 *   Salesforce's Country facet); failing that, every value of the one location facet whose descriptors name an Indian
 *   place ("Pune, India", "Navi Mumbai, India (Finicity)": Mastercard, which has no country level);
 * - remote: the values of the first facet with a whole-descriptor remote work type (NVIDIA's "Location Type: Remote");
 *   site values like "California - Remote" are locations, not a type;
 * - located: any facet parameter naming a location, country or site.
 * Deterministic: facet order as served, values in order.
 */
export function workdayScopes(page: WorkdayListPage, officeCities: readonly string[] = []): WorkdayScopes {
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
  const ids = (vs: readonly FacetNode[]): string[] => vs.map((v) => v.id as string);
  const remoteGroup = groups.find((g) => g.values.some((v) => REMOTE_TYPE.test(v.descriptor ?? '')));
  const remote = remoteGroup === undefined ? null : { [remoteGroup.param]: ids(remoteGroup.values.filter((v) => REMOTE_TYPE.test(v.descriptor ?? ''))) };
  let india: AppliedFacets | null = null;
  for (const g of groups) {
    if (g === remoteGroup) continue;
    const exact = g.values.filter((v) => /^\s*india\s*$/iu.test(v.descriptor ?? ''));
    if (exact.length > 0) {
      india = { [g.param]: ids(exact) };
      break;
    }
  }
  if (india === null) {
    let best: { param: string; ids: string[] } | null = null;
    for (const g of groups) {
      if (g === remoteGroup || !LOCATION_PARAM.test(g.param)) continue;
      const named = ids(g.values.filter((v) => countriesIn(v.descriptor ?? '').includes('india')));
      if (named.length > 0 && (best === null || named.length > best.ids.length)) best = { param: g.param, ids: named };
    }
    india = best === null ? null : { [best.param]: best.ids };
  }
  const offices: { display: string; facets: AppliedFacets; labels: string[] }[] = [];
  const words = (d: string): string[] => d.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
  for (const city of officeCities.map(officeCity)) {
    if (offices.some((o) => o.display === city.display)) continue;
    const names = (d: string): boolean => {
      const w = ' ' + words(d).join(' ') + ' ';
      const places = countriesIn(d);
      return city.aliases.some((a) => w.includes(' ' + words(a).join(' ') + ' ')) && (places.length === 0 || places.includes('india'));
    };
    let best: FacetNode[] = [];
    let param = '';
    for (const g of groups) {
      if (g === remoteGroup || !LOCATION_PARAM.test(g.param)) continue;
      const hit = g.values.filter((v) => names(v.descriptor ?? ''));
      if (hit.length > best.length) {
        best = hit;
        param = g.param;
      }
    }
    if (best.length > 0) offices.push({ display: city.display, facets: { [param]: ids(best) }, labels: best.map((v) => v.descriptor as string) });
  }
  return { india, remote, located: groups.some((g) => LOCATION_PARAM.test(g.param)), offices };
}

// ---------------------------------------------------------------------------
// The daily adapter
// ---------------------------------------------------------------------------

export const srcWorkdayContract = defineContract({
  id: 'src-workday',
  // 1.1.0: the reads are scoped to the board's India and remote facets (Fix round 1)
  version: '1.1.0',
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

/** Sorted by sourceId (as `finish`), so the detail order is fixed for a given list. */
const bySourceId = (a: RawPosting, b: RawPosting): number => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);

/** The detail order by listed location: 0 when it names India (or an Indian place) or is listed under an office city, 1 for "N Locations", 2 for the rest. */
const locationRank = (p: RawPosting): number => {
  const raw = p.raw as WorkdayRaw;
  const text = raw.locationsText;
  if (countriesIn(text).includes('india') || (raw.officeLocations ?? []).length > 0) return 0;
  return /^\s*\d+\s+locations?\s*$/iu.test(text) ? 1 : 2;
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
    if (pages >= maxPages) throw new KernelError('invalid_output', `${what}: page cap reached at ${finish(all).length} postings (total ${total}, ${maxPages} pages)`);
    page = await fetchListPage(http, hosts, b, offset, facets);
    pages++;
  }
  // re-posts of one req are one posting (finish): the list is short only when it listed fewer entries than its total
  const postings = finish(all);
  if (listed < total) ctx.skipped([`short-list ${req.company}${label}: total ${total}, listed ${listed}`]);
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
    const ref = workdayRef(b);
    const cities = titles.data.eligibility?.officeCities ?? [];
    const cacheKey = `${ref} ${cities.join(',')}`;
    let scopes = o.hosts.scopes?.get(cacheKey);
    let first: WorkdayListPage | undefined;
    if (scopes === undefined) {
      first = await fetchListPage(http, o.hosts, b, 0);
      scopes = workdayScopes(first, cities);
      o.hosts.scopes?.set(cacheKey, scopes);
    }
    let postings: RawPosting[];
    const lists = ([['india', scopes.india], ['remote', scopes.remote]] as const).filter((x): x is readonly ['india' | 'remote', AppliedFacets] => x[1] !== null);
    if (lists.length > 0) {
      const all: RawPosting[] = [];
      for (const [name, facets] of lists) {
        const page1 = await fetchListPage(http, o.hosts, b, 0, facets);
        if (page1.total >= WORKDAY_TOTAL_CEILING) throw new KernelError('invalid_output', `${what}: the ${name} scoped list reports Workday's ${WORKDAY_TOTAL_CEILING} ceiling; it cannot be read in full`);
        all.push(...(await readList(http, o.hosts, b, req, facets, page1, o.maxPages, ctx, ` (${name} list)`)).postings);
      }
      // the office-city lists: which jobs Workday lists under an office city's location value
      const offices = new Map<string, string[]>();
      for (const office of scopes.offices) {
        const page1 = await fetchListPage(http, o.hosts, b, 0, office.facets);
        if (page1.total >= WORKDAY_TOTAL_CEILING) throw new KernelError('invalid_output', `${what}: the ${office.display} office list reports Workday's ${WORKDAY_TOTAL_CEILING} ceiling; it cannot be read in full`);
        const listed = (await readList(http, o.hosts, b, req, office.facets, page1, o.maxPages, ctx, ` (${office.display} list)`)).postings;
        for (const p of listed) offices.set(p.sourceId, [...(offices.get(p.sourceId) ?? []), ...office.labels]);
        all.push(...listed);
      }
      postings = finish(all).map((p) => (offices.has(p.sourceId) ? { ...p, raw: { ...(p.raw as WorkdayRaw), officeLocations: offices.get(p.sourceId) ?? [] } } : p));
    } else if (scopes.located) {
      ctx.skipped([`no-india-or-remote-facet ${req.company}: its location facets name neither India nor a remote type`]);
      return [];
    } else {
      first ??= await fetchListPage(http, o.hosts, b, 0);
      if (first.total >= WORKDAY_TOTAL_CEILING) throw new KernelError('invalid_output', `${what}: total ${first.total} is Workday's reporting ceiling and the board has no location facets to scope by; its list cannot be read in full`);
      postings = (await readList(http, o.hosts, b, req, {}, first, o.maxPages, ctx)).postings;
    }

    // details: title pre-filter, then India-named locations, then "N Locations", then the rest; ties by sourceId
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
