import { z } from 'zod';
import { defineAgent, type Agent, type AgentContext } from '../../../../kernel/agent.js';
import { defineContract } from '../../../../kernel/contract.js';
import { KernelError } from '../../../../kernel/errors.js';
import { DiscoveryRequest, knownAts, RawPosting } from '../../../types.js';
import { onlySeenBefore } from '../common.js';
import {
  chooseDetails,
  goneNote,
  hostRequest,
  namesIndia,
  namesOffice,
  preferPostings,
  refusal,
  REMOTE_TYPE,
  scopeMiss,
  scopeNotApplied,
  shapeError,
  titlePackOf,
  type HttpTool,
  type PlatformHosts,
  type ScopeBounds,
} from './shared.js';

/**
 * Eightfold (career-sites spec §4, Task 7): the daily adapter for every verified registry company on Eightfold
 * (Microsoft, Netflix), and the request and parse code the coverage verifier's Eightfold client shares.
 *
 * A board is `<host>/<domain>` (its `ref`, the DiscoveryRequest slug, as the platform detector names it), e.g.
 * `explore.jobs.netflix.net/netflix.com`; the host is the tenant's own (`<co>.eightfold.ai` or a custom domain). Its
 * jobs are the JSON the public careers page itself calls, so:
 * - robots.txt applies: before any request to a host, its robots.txt is checked for the request's path and query
 *   (once per host per run, by the injected host state). Both recorded tenants say `Disallow: /` with `Allow:
 *   /careers`, `Allow: /api/apply`, `Allow: /api/pcsx` (seen live 2026-10-14). A disallow is the named skip
 *   `robots-disallow <host>: <company> not read today (…)`, nothing fetched;
 * - every request waits EIGHTFOLD_MIN_INTERVAL_MS (5 s) after the previous one to the host. Seen live 2026-10-14:
 *   Microsoft answered 429 to requests 2.5 s and 4 s apart, and 200 to API requests 6, 8 and 15 s apart; but the live
 *   daily check at 5 s was refused (429) about 20 s into the company, and a probe at 10 s answered 429 for about 30 s
 *   after the careers page, then 200 again. Microsoft's PCSX host throttles beyond what a fixed spacing avoids: the
 *   adapter does not work around it (the host is disabled for the run, a named problem), Netflix is not throttled;
 * - a 401, 403 or 429 (or a challenge/429 robots.txt) disables the host for the run: the step fails `challenged` (401,
 *   403) or `rate_limit` (429), is never retried around, and a later company on the same host is deferred
 *   (`input_rejected`, `host-disabled:<why> on <host>`) without a request.
 *
 * Two APIs, one per tenant (the research, and seen live): the older `v2` (`GET /api/apply/v2/jobs?domain=<d>&start=<n>
 * &num=10`, Netflix) and the newer `pcsx` (`GET /api/pcsx/search?domain=<d>&query=&location=<loc>&start=<n>
 * &sort_by=relevance`, Microsoft). Each tenant answers 403 on the other one ("PCSX is not enabled for this user",
 * "Not authorized for PCSX"), and a 403 disables the host, so the adapter never guesses: it reads the tenant's own
 * careers page (`/careers?domain=<d>`, allowed by robots.txt) once per company per run and takes the API from the
 * configuration element the page embeds (`id="pcsx-data"` → pcsx, `id="smartApplyData"` → v2, the markers the
 * platform detector already reads). A page naming neither is `input_rejected` (`eightfold-api-unknown`), never a guess.
 *
 * Scope (as Task 6, Decision A): the user can take a job located in India or a remote one, so the reads are scoped
 * with the platform's own location filter, from the facets of the unscoped first page (start 0, read for its facets
 * only; with the API, cached per company per run in the host state, never persisted):
 * - the India list: `location=India` (Eightfold's own location search), when the `locations` facet names India among
 *   its values ("Mumbai, MH, India", "Bengaluru, KA, India"). Its bounds are those values' counts;
 * - the remote list (v2 only): a work-type facet's remote value (Netflix `Work Type: remote`, as `Work Type=remote`).
 *   PCSX shows no remote count (its "Remote" location value is the sentinel 999999, never a count), so a PCSX board has
 *   no remote list; its India search includes India's remote jobs itself (`includeRemote`, seen live);
 * - every scoped list's first-page `count` is checked against those counts (`scopeMiss`: the sum + max(5, 5%) above,
 *   the largest value − max(5, 5%) below): outside them the step fails `input_rejected` `scope-not-applied`, nothing
 *   read from it. Seen live: Netflix India 9 (facet 9), remote 113 (facet 112); Microsoft India 253 (Bengaluru 131 +
 *   Hyderabad 117: the PCSX facet list shows only its top values, so a board whose India values are not among them
 *   has no India list);
 * - no office-city lists: unlike Workday's "2 Locations", every Eightfold job lists each of its locations by name
 *   (`locations`), so an office city is read from the job's own location values, never invented;
 * - a `locations` facet naming neither India nor a remote type: the named skip `no-india-or-remote-facet`; no
 *   `locations` facet at all: the unscoped list, read from that first page;
 * - the union is deduped by the platform job id: the posting naming an office city wins, then one naming India, then
 *   the first seen (`preferPostings`);
 * - by design, a job located only outside India and not of a remote type is never read.
 *
 * Paging: `start` += EIGHTFOLD_PAGE_SIZE (10, fixed: `num` is ignored) until a page is empty or `start >= count` (the
 * first page's), at most `eightfoldPagesPerList()` pages per list (EIGHTFOLD_MAX_PAGES, less so the whole step stays
 * within EIGHTFOLD_MAX_REQUESTS, 90% of the step timeout at the 5 s spacing); a longer list fails loudly (`page cap
 * reached`, `input_rejected`). A page whose jobs were all seen before is `invalid_output` (the API ignored `start`). A
 * list ending before its count gets the note `short-list <company>: count N, listed M`.
 *
 * Detail (v2 `GET /api/apply/v2/jobs/<id>?domain=<d>`, pcsx `GET /api/pcsx/position_details?position_id=<id>
 * &domain=<d>&hl=en`): only for rank-0 jobs (a location naming India, India-remote included) whose title passes the
 * pre-filter, at most EIGHTFOLD_MAX_DETAILS per company per run, ties by id; the rest flow without one, with the named
 * note `detail-budget <company>: …`. A detail answering 404/410 is a gone job: dropped, with a `detail-gone` note.
 *
 * Every response is zod-checked first; one missing an expected field (a page without `count` or `positions`, a detail
 * without its name or description) is `invalid_output`, never partially parsed. A list entry without an id or a name is
 * skipped with a note; a page of nothing else is `invalid_output`. `raw` (normalizer mapper `eightfold`): `{ api,
 * title, url, id, locations, standardizedLocations, workLocationOption, department, postedTs, detail }`; `url` =
 * `https://<host>/careers/job/<id>` (the recorded `canonicalPositionUrl` / `publicUrl` pattern); `postedTs` is the
 * epoch-seconds creation (v2 `t_create`) or posting (pcsx `postedTs`) time, absent → null. The volatile `t_update`,
 * scores and stars are dropped, so an unchanged job gives an unchanged raw. `sourceId` = the platform job id.
 */

export const EIGHTFOLD_PAGE_SIZE = 10;
export const EIGHTFOLD_MAX_PAGES = 100;
export const EIGHTFOLD_MAX_DETAILS = 40;
/** The spacing of requests to one Eightfold host (Microsoft answered 429 at 2.5 s and 4 s; spec §4: at least 2 s). */
export const EIGHTFOLD_MIN_INTERVAL_MS = 5000;
export const EIGHTFOLD_TIMEOUT_MS = 900_000;
/** The requests one step may make at most: 90% of the step timeout at the 5 s spacing. */
export const EIGHTFOLD_MAX_REQUESTS = Math.floor((EIGHTFOLD_TIMEOUT_MS * 0.9) / EIGHTFOLD_MIN_INTERVAL_MS);
/** robots.txt, the careers page and the discovery page, set aside with the details before the lists share the rest. */
const FIXED_REQUESTS = 3;
/** The page cap of each list: the India and remote lists share what robots.txt, the careers page, discovery and the details leave. */
export function eightfoldPagesPerList(lists = 2): number {
  return Math.min(EIGHTFOLD_MAX_PAGES, Math.floor((EIGHTFOLD_MAX_REQUESTS - FIXED_REQUESTS - EIGHTFOLD_MAX_DETAILS) / Math.max(1, lists)));
}
/** A facet count at or above this is a sentinel ("Remote": 999999), never a count. */
export const EIGHTFOLD_COUNT_SENTINEL = 999_999;
/** The symbolic egress resolved per run to the verified Eightfold companies' hosts. */
export const EIGHTFOLD_EGRESS = 'registry:eightfold-hosts';

export type EightfoldApi = 'v2' | 'pcsx';

export interface EightfoldBoard {
  readonly host: string;
  /** The tenant's `domain` parameter (`netflix.com`). */
  readonly domain: string;
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

/** `<host>/<domain>` → the board; null when it is not one. */
export function parseEightfoldRef(ref: string): EightfoldBoard | null {
  const [host, domain, ...rest] = ref.split('/');
  if (host === undefined || domain === undefined || rest.length > 0) return null;
  if (!HOSTNAME.test(host) || !HOSTNAME.test(domain)) return null;
  return { host, domain };
}

export const eightfoldRef = (b: EightfoldBoard): string => `${b.host}/${b.domain}`;

/** The board of a stored board URL (`https://<host>/api/apply/v2/jobs?domain=<d>`, the registry's board_url, or a PCSX search URL). */
export function eightfoldBoardOfUrl(boardUrl: string): EightfoldBoard | null {
  let u: URL;
  try {
    u = new URL(boardUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.port !== '' || (u.pathname !== '/api/apply/v2/jobs' && u.pathname !== '/api/pcsx/search')) return null;
  return parseEightfoldRef(`${u.hostname.toLowerCase()}/${(u.searchParams.get('domain') ?? '').trim().toLowerCase()}`);
}

/** The platform's own filters of one list (`location=India`, `Work Type=remote`); empty for the unscoped list. */
export type EightfoldQuery = Readonly<Record<string, string>>;

const qs = (pairs: readonly (readonly [string, string])[]): string => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

export const eightfoldCareersUrl = (b: EightfoldBoard): string => `https://${b.host}/careers?${qs([['domain', b.domain]])}`;

export function eightfoldListUrl(b: EightfoldBoard, api: EightfoldApi, start: number, query: EightfoldQuery = {}): string {
  const extra = Object.entries(query).sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0));
  if (api === 'v2') return `https://${b.host}/api/apply/v2/jobs?${qs([['domain', b.domain], ['start', String(start)], ['num', String(EIGHTFOLD_PAGE_SIZE)], ...extra])}`;
  const location = query['location'] ?? '';
  const rest = extra.filter(([k]) => k !== 'location');
  return `https://${b.host}/api/pcsx/search?${qs([['domain', b.domain], ['query', ''], ['location', location], ['start', String(start)], ['sort_by', 'relevance'], ...rest])}`;
}

export const eightfoldDetailUrl = (b: EightfoldBoard, api: EightfoldApi, id: string): string =>
  api === 'v2'
    ? `https://${b.host}/api/apply/v2/jobs/${encodeURIComponent(id)}?${qs([['domain', b.domain]])}`
    : `https://${b.host}/api/pcsx/position_details?${qs([['position_id', id], ['domain', b.domain], ['hl', 'en']])}`;

/** The job's public page (the recorded `canonicalPositionUrl` / `publicUrl`): what the user opens and applies on. */
export const eightfoldJobUrl = (b: EightfoldBoard, id: string): string => `https://${b.host}/careers/job/${encodeURIComponent(id)}`;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const Id = z.union([z.number().int().nonnegative(), z.string().regex(/^[A-Za-z0-9_-]+$/u)]);
const Name = z.string().refine((t) => t.trim() !== '', 'blank name');
const Strings = z.array(z.string()).nullish();
const Text = z.string().nullish();
const Ts = z.number().nullish();

const V2Position = z.object({ id: Id, name: Name, locations: Strings, location: Text, work_location_option: Text, department: Text, t_create: Ts }).passthrough();
const PcsxPosition = z.object({ id: Id, name: Name, locations: Strings, standardizedLocations: Strings, workLocationOption: Text, department: Text, postedTs: Ts }).passthrough();
const V2Page = z.object({ count: z.number().int().nonnegative(), positions: z.array(z.unknown()), facets: z.record(z.string(), z.unknown()).nullish() }).passthrough();
const PcsxPage = z
  .object({
    data: z
      .object({
        count: z.number().int().nonnegative(),
        positions: z.array(z.unknown()),
        filterDef: z.object({ facets: z.record(z.string(), z.unknown()).nullish() }).passthrough().nullish(),
      })
      .passthrough(),
  })
  .passthrough();
const V2Detail = z.object({ id: Id, name: Name, job_description: z.string() }).passthrough();
const PcsxDetail = z.object({ data: z.object({ id: Id, name: Name, jobDescription: z.string(), efcustomTextWorkSite: Strings, efcustomTextEmploymentType: Strings }).passthrough() }).passthrough();

/** One list entry, the same for both APIs. */
export interface EightfoldPosition {
  readonly id: string;
  readonly title: string;
  readonly locations: readonly string[];
  readonly standardizedLocations: readonly string[];
  readonly workLocationOption: string | null;
  readonly department: string | null;
  readonly postedTs: number | null;
}

/** One facet: its name and its values with their counts (null: a sentinel or no number). */
export interface EightfoldFacet {
  readonly name: string;
  readonly values: readonly { readonly value: string; readonly count: number | null }[];
}

export interface EightfoldListPage {
  readonly count: number;
  readonly positions: readonly EightfoldPosition[];
  readonly facets: readonly EightfoldFacet[];
  /** Positions on the page of entries without an id or a name. */
  readonly malformed: readonly number[];
  /** Every entry the page listed, malformed ones included. */
  readonly listed: number;
}

const countOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < EIGHTFOLD_COUNT_SENTINEL ? v : null);
const strings = (v: readonly string[] | null | undefined): string[] => (v ?? []).map((s) => s.trim()).filter((s) => s !== '');
const text = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** v2 facets: `{name: {value: count}}`; PCSX: `{name: [[value, count], …]}`. Anything else is not a facet. */
function facetsOf(raw: Record<string, unknown> | null | undefined): EightfoldFacet[] {
  const out: EightfoldFacet[] = [];
  for (const [name, v] of Object.entries(raw ?? {})) {
    if (Array.isArray(v)) {
      const values = v.flatMap((e) => (Array.isArray(e) && typeof e[0] === 'string' ? [{ value: e[0], count: countOf(e[1]) }] : []));
      out.push({ name, values });
    } else if (typeof v === 'object' && v !== null) {
      out.push({ name, values: Object.entries(v as Record<string, unknown>).map(([value, n]) => ({ value, count: countOf(n) })) });
    }
  }
  return out;
}

/**
 * A list page of either API, shape-checked. A page missing `count` or `positions` is `invalid_output`, never partially
 * parsed. An entry without an id or a name is not a posting: skipped by position (the adapter notes it), unless every
 * entry of the page is one (schema drift: `invalid_output`).
 */
export function parseListPage(api: EightfoldApi, json: unknown, what: string): EightfoldListPage {
  let count: number;
  let entries: unknown[];
  let facets: EightfoldFacet[];
  if (api === 'v2') {
    const r = V2Page.safeParse(json);
    if (!r.success) throw shapeError(`${what} list`, r);
    count = r.data.count;
    entries = r.data.positions;
    facets = facetsOf(r.data.facets);
  } else {
    const r = PcsxPage.safeParse(json);
    if (!r.success) throw shapeError(`${what} list`, r);
    count = r.data.data.count;
    entries = r.data.data.positions;
    facets = facetsOf(r.data.data.filterDef?.facets);
  }
  const positions: EightfoldPosition[] = [];
  const malformed: number[] = [];
  entries.forEach((e, i) => {
    if (api === 'v2') {
      const q = V2Position.safeParse(e);
      if (!q.success) return void malformed.push(i);
      const p = q.data;
      const locations = strings(p.locations);
      positions.push({
        id: String(p.id),
        title: p.name.trim(),
        locations: locations.length > 0 ? locations : strings(p.location === null || p.location === undefined ? [] : [p.location]),
        standardizedLocations: [],
        workLocationOption: text(p.work_location_option),
        department: text(p.department),
        postedTs: typeof p.t_create === 'number' && Number.isFinite(p.t_create) ? p.t_create : null,
      });
    } else {
      const q = PcsxPosition.safeParse(e);
      if (!q.success) return void malformed.push(i);
      const p = q.data;
      positions.push({
        id: String(p.id),
        title: p.name.trim(),
        locations: strings(p.locations),
        standardizedLocations: strings(p.standardizedLocations),
        workLocationOption: text(p.workLocationOption),
        department: text(p.department),
        postedTs: typeof p.postedTs === 'number' && Number.isFinite(p.postedTs) ? p.postedTs : null,
      });
    }
  });
  if (malformed.length > 0 && positions.length === 0) throw new KernelError('invalid_output', `${what} list: all ${malformed.length} entries lack an id or a name`);
  return { count, positions, facets, malformed, listed: entries.length };
}

/** What a detail adds to a posting (null when it was not fetched). */
export interface EightfoldDetailRaw {
  readonly title: string;
  /** The job description HTML. */
  readonly description: string;
  /** PCSX's work-site field ("3 days / week in-office"); null when absent. */
  readonly workSite: string | null;
  /** PCSX's employment type ("Full-Time"); null when absent. */
  readonly employmentType: string | null;
}

export function parseDetail(api: EightfoldApi, json: unknown, what: string): EightfoldDetailRaw {
  if (api === 'v2') {
    const r = V2Detail.safeParse(json);
    if (!r.success) throw shapeError(`${what} detail`, r);
    return { title: r.data.name.trim(), description: r.data.job_description, workSite: null, employmentType: null };
  }
  const r = PcsxDetail.safeParse(json);
  if (!r.success) throw shapeError(`${what} detail`, r);
  const d = r.data.data;
  return { title: d.name.trim(), description: d.jobDescription, workSite: strings(d.efcustomTextWorkSite)[0] ?? null, employmentType: strings(d.efcustomTextEmploymentType)[0] ?? null };
}

export interface EightfoldRaw {
  readonly api: EightfoldApi;
  readonly title: string;
  readonly url: string;
  readonly id: string;
  readonly locations: readonly string[];
  /** PCSX's normalised locations ("Bengaluru, KA, IN"); empty on v2. */
  readonly standardizedLocations: readonly string[];
  readonly workLocationOption: string | null;
  readonly department: string | null;
  /** Epoch seconds (v2 `t_create`, pcsx `postedTs`); null when absent. */
  readonly postedTs: number | null;
  readonly detail: EightfoldDetailRaw | null;
}

/** One page's postings, each without its detail. */
export function pagePostings(b: EightfoldBoard, api: EightfoldApi, page: EightfoldListPage, req: Pick<DiscoveryRequest, 'company' | 'slug'>): RawPosting[] {
  return page.positions.map((p) => {
    const raw: EightfoldRaw = {
      api,
      title: p.title,
      url: eightfoldJobUrl(b, p.id),
      id: p.id,
      locations: p.locations,
      standardizedLocations: p.standardizedLocations,
      workLocationOption: p.workLocationOption,
      department: p.department,
      postedTs: p.postedTs,
      detail: null,
    };
    return { source: 'eightfold', sourceId: p.id, company: req.company, slug: req.slug, raw };
  });
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** The discovery the host state caches per board per run: the API, and the scopes its first page's facets give. */
export interface EightfoldDiscovery {
  readonly api: EightfoldApi;
  readonly scopes: EightfoldScopes;
}
export type EightfoldHosts = PlatformHosts<EightfoldDiscovery>;

const reqOpts = (timeoutMs: number | undefined) => ({ minIntervalMs: EIGHTFOLD_MIN_INTERVAL_MS, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

const PCSX_MARKER = /\bid\s*=\s*["']pcsx-data["']/u;
const V2_MARKER = /\bid\s*=\s*["']smartApplyData["']/u;

/** Which API a careers page's embedded configuration names; null when neither. */
export function eightfoldApiOfPage(html: string): EightfoldApi | null {
  if (PCSX_MARKER.test(html)) return 'pcsx';
  if (V2_MARKER.test(html)) return 'v2';
  return null;
}

/** The tenant's API, from its careers page (one GET, robots.txt checked). A 404 is a retired board (`gone`). */
export async function fetchApi(http: HttpTool, hosts: EightfoldHosts, b: EightfoldBoard, company: string, timeoutMs?: number): Promise<EightfoldApi> {
  const url = eightfoldCareersUrl(b);
  const r = await hostRequest(http, hosts, b.host, url, () => http.getPage(url, reqOpts(timeoutMs)));
  if (r.status === 404 || r.status === 410) throw new KernelError('gone', `eightfold board not found: ${eightfoldRef(b)}`);
  if (r.status >= 300) throw new KernelError('invalid_output', `${b.host} returned ${r.status} for the ${b.domain} careers page`);
  const api = eightfoldApiOfPage(r.body);
  if (api === null) throw new KernelError('input_rejected', `eightfold-api-unknown ${company}: the careers page of ${eightfoldRef(b)} embeds neither pcsx-data nor smartApplyData; its API is not guessed`);
  return api;
}

/** One list page, shape-checked. A 404 is a retired board (`gone`), any other 4xx `invalid_output`. */
export async function fetchListPage(http: HttpTool, hosts: EightfoldHosts, b: EightfoldBoard, api: EightfoldApi, start: number, query: EightfoldQuery = {}, timeoutMs?: number): Promise<EightfoldListPage> {
  const url = eightfoldListUrl(b, api, start, query);
  const { status, json } = await hostRequest(http, hosts, b.host, url, () => http.getJson(url, reqOpts(timeoutMs)));
  if (status === 404 || status === 410) throw new KernelError('gone', `eightfold board not found: ${eightfoldRef(b)}`);
  if (status >= 300) throw new KernelError('invalid_output', `${b.host} returned ${status} for the ${b.domain} list at start ${start}`);
  return parseListPage(api, json, `eightfold ${eightfoldRef(b)}`);
}

/** One job's detail, shape-checked; null when the job is gone (404/410). */
export async function fetchDetail(http: HttpTool, hosts: EightfoldHosts, b: EightfoldBoard, api: EightfoldApi, id: string, timeoutMs?: number): Promise<EightfoldDetailRaw | null> {
  const url = eightfoldDetailUrl(b, api, id);
  const { status, json } = await hostRequest(http, hosts, b.host, url, () => http.getJson(url, reqOpts(timeoutMs)));
  if (status === 404 || status === 410) return null;
  if (status >= 300) throw new KernelError('invalid_output', `${b.host} returned ${status} for a ${b.domain} job detail`);
  return parseDetail(api, json, `eightfold ${eightfoldRef(b)}`);
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/** One scoped list: the platform's own filter, and the bounds the discovery page's facet counts give it. */
export interface EightfoldScope extends ScopeBounds {
  readonly query: EightfoldQuery;
}

export interface EightfoldScopes {
  /** `location=India`, when the `locations` facet names India; else null. */
  readonly india: EightfoldScope | null;
  /** A work-type facet's remote value (v2); else null. */
  readonly remote: EightfoldScope | null;
  /** Whether the board has a `locations` facet at all. */
  readonly located: boolean;
}

/**
 * The scopes of a board from its unscoped first page's facets: India from the `locations` values naming India (their
 * counts the bounds; a sentinel count is no count), remote from the first other facet holding a remote-type value with
 * a count (v2 only: PCSX has none). Deterministic: facets and values in served order.
 */
export function eightfoldScopes(api: EightfoldApi, page: EightfoldListPage): EightfoldScopes {
  const locations = page.facets.find((f) => f.name.toLowerCase() === 'locations');
  const india = (locations?.values ?? []).filter((v) => v.count !== null && namesIndia(v.value));
  const counts = india.map((v) => v.count as number);
  let remote: EightfoldScope | null = null;
  if (api === 'v2') {
    for (const f of page.facets) {
      if (f === locations) continue;
      const v = f.values.find((x) => x.count !== null && REMOTE_TYPE.test(x.value));
      if (v !== undefined) {
        remote = { query: { [f.name]: v.value }, expected: v.count as number, largest: v.count as number };
        break;
      }
    }
  }
  return {
    india: india.length === 0 ? null : { query: { location: 'India' }, expected: counts.reduce((a, n) => a + n, 0), largest: Math.max(...counts) },
    remote,
    located: locations !== undefined,
  };
}

// ---------------------------------------------------------------------------
// The daily adapter
// ---------------------------------------------------------------------------

export const srcEightfoldContract = defineContract({
  id: 'src-eightfold',
  version: '1.0.0',
  description: 'Reads one verified Eightfold company\'s India-located or remote job lists, with job details for the titles the pre-filter passes, within a per-company request budget, honouring robots.txt per host',
  skills: ['job-sourcing'],
  // Its own team (spec §6): a dead Eightfold tenant never opens a breaker for another platform or the ATS sources.
  team: 'sourcing-eightfold',
  kind: 'io',
  consumes: DiscoveryRequest,
  produces: RawPosting,
  requires: [knownAts],
  capabilities: { http: true, pack: true },
  egress: [EIGHTFOLD_EGRESS],
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: EIGHTFOLD_TIMEOUT_MS,
  // 429 is never retried (the host is disabled); a retry starts the company again, so at most one.
  retry: { max: 1, on: ['overloaded', 'network'], backoffMs: [8000] },
});

export interface SrcEightfoldOptions {
  readonly hosts: EightfoldHosts;
  readonly maxPages?: number;
  readonly maxDetails?: number;
}

const rawOf = (p: RawPosting): EightfoldRaw => p.raw as EightfoldRaw;
const placesOf = (r: EightfoldRaw): readonly string[] => [...r.locations, ...r.standardizedLocations];
/** Rank 0 for details: a listed location naming India (India-remote included). */
const indiaNamed = (p: RawPosting): boolean => placesOf(rawOf(p)).some(namesIndia);

/** Pages one list from start 0, its first page already read: at most `maxPages` pages, never truncated silently. */
async function readList(http: HttpTool, o: Required<SrcEightfoldOptions>, b: EightfoldBoard, api: EightfoldApi, req: DiscoveryRequest, query: EightfoldQuery, first: EightfoldListPage, ctx: AgentContext, label: string): Promise<RawPosting[]> {
  const what = `eightfold ${req.company}`;
  const all: RawPosting[] = [];
  const seen = new Set<string>();
  const count = first.count;
  let page = first;
  let pages = 1;
  let listed = 0;
  for (let start = 0; ; ) {
    if (page.listed === 0) break;
    if (onlySeenBefore(seen, page.positions.map((p) => p.id))) throw new KernelError('invalid_output', `${what}: the page at start ${start} repeats earlier postings (Eightfold ignored the start)`);
    if (page.malformed.length > 0) ctx.skipped(page.malformed.map((i) => `eightfold ${req.company}${label} start ${start} entry ${i}: no id or name`));
    all.push(...pagePostings(b, api, page, req));
    listed += page.listed;
    start += EIGHTFOLD_PAGE_SIZE;
    if (start >= count) break;
    if (pages >= o.maxPages) throw new KernelError('input_rejected', `${what}${label}: page cap reached at ${listed} postings (count ${count}, ${o.maxPages} pages)`);
    page = await fetchListPage(http, o.hosts, b, api, start, query);
    pages++;
  }
  if (listed < count) ctx.skipped([`short-list ${req.company}${label}: count ${count}, listed ${listed}`]);
  return all;
}

async function runCompany(req: DiscoveryRequest, ctx: AgentContext, o: Required<SrcEightfoldOptions>): Promise<RawPosting[]> {
  const http = ctx.http;
  if (!http) throw new KernelError('policy_denied', 'no http capability issued');
  const b = parseEightfoldRef(req.slug);
  if (b === null) throw new KernelError('invalid_output', `eightfold: ${req.slug} is not <host>/<domain>`);
  const pack = titlePackOf(ctx.pack, 'src-eightfold');
  const offices = pack.eligibility?.officeCities ?? [];
  try {
    const key = eightfoldRef(b);
    let found = o.hosts.scopes?.get(key);
    let first: EightfoldListPage | undefined;
    if (found === undefined) {
      const api = await fetchApi(http, o.hosts, b, req.company);
      first = await fetchListPage(http, o.hosts, b, api, 0);
      found = { api, scopes: eightfoldScopes(api, first) };
      o.hosts.scopes?.set(key, found);
    }
    const { api, scopes } = found;
    const lists = ([['india', scopes.india], ['remote', scopes.remote]] as const).filter((x): x is readonly ['india' | 'remote', EightfoldScope] => x[1] !== null);
    const maxPages = Math.min(o.maxPages, eightfoldPagesPerList(lists.length));
    const all: RawPosting[] = [];
    if (lists.length > 0) {
      for (const [name, sc] of lists) {
        const page1 = await fetchListPage(http, o.hosts, b, api, 0, sc.query);
        const miss = scopeMiss(page1.count, sc);
        if (miss !== null) throw scopeNotApplied(req.company, name, miss, 'Eightfold');
        all.push(...(await readList(http, { ...o, maxPages }, b, api, req, sc.query, page1, ctx, ` (${name} list)`)));
      }
    } else if (scopes.located) {
      ctx.skipped([`no-india-or-remote-facet ${req.company}: its locations facet names neither India nor a remote type`]);
      return [];
    } else {
      first ??= await fetchListPage(http, o.hosts, b, api, 0);
      all.push(...(await readList(http, { ...o, maxPages: Math.min(o.maxPages, eightfoldPagesPerList(1)) }, b, api, req, {}, first, ctx, '')));
    }
    // one posting per job id: the one naming an office city, then one naming India, then the first seen
    const postings = preferPostings(all, (p) => (placesOf(rawOf(p)).some((l) => namesOffice(l, offices)) ? 0 : indiaNamed(p) ? 1 : 2));

    const chosen = chooseDetails(postings, { pack, title: (p) => rawOf(p).title, rank0: indiaNamed, max: o.maxDetails, company: req.company, ctx });
    const details = new Map<string, EightfoldDetailRaw | null>();
    for (const p of chosen) details.set(p.sourceId, await fetchDetail(http, o.hosts, b, api, p.sourceId));
    const gone = [...details.entries()].filter(([, d]) => d === null).map(([id]) => id);
    if (gone.length > 0) ctx.skipped([goneNote(req.company, gone)]);
    return postings
      .filter((p) => !gone.includes(p.sourceId))
      .map((p) => {
        const d = details.get(p.sourceId);
        return d === undefined || d === null ? p : { ...p, raw: { ...rawOf(p), detail: d } };
      });
  } catch (e) {
    refusal(e, req.company, ctx);
    return [];
  }
}

/** Builds `src-eightfold` for one run, on the run's host state (robots.txt cache, disabled hosts, discovery). */
export function makeSrcEightfold(o: SrcEightfoldOptions): Agent<DiscoveryRequest, RawPosting> {
  const opts: Required<SrcEightfoldOptions> = { hosts: o.hosts, maxPages: o.maxPages ?? EIGHTFOLD_MAX_PAGES, maxDetails: o.maxDetails ?? EIGHTFOLD_MAX_DETAILS };
  return defineAgent(srcEightfoldContract, (req, ctx) => (req.ats === 'eightfold' ? runCompany(req, ctx, opts) : Promise.resolve([])));
}
