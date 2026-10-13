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
 * Oracle Recruiting Cloud, the Candidate Experience REST API (career-sites spec §4, Task 7): the daily adapter for every
 * verified registry company on Oracle (JPMorgan Chase), and the request and parse code the verifier's Oracle client
 * shares.
 *
 * A board is `<host>/<siteNumber>` (its `ref`, the DiscoveryRequest slug, as the platform detector names it), e.g.
 * `jpmc.fa.oraclecloud.com/CX_1001`. Its jobs are the REST resource the public Candidate Experience site itself calls.
 *
 * robots.txt (a controller decision, 2026-10-14): Oracle's WAF answers 403 for robots.txt ("W4S-402: Blocked by
 * WAF4SaaS", seen live), so it cannot be read. The approved spec (§4) says "robots unreadable (403): minimal rate", and
 * RFC 9309 §2.3.1.3 lets a crawler access resources when robots.txt answers 4xx. So, for this REST API only:
 * - robots.txt is still fetched once per host per run; a plain 401 or 403 is "unknown" (`dailyOracleHosts`,
 *   `unreadableRobots: 'allow'`), and the API is then read at the minimal rate: ORACLE_MIN_INTERVAL_MS (5 s) between
 *   requests to the host, and at most ORACLE_MAX_PAGES (10) list pages per company per day, the discovery page
 *   included;
 * - a robots.txt that becomes readable and disallows the REST path is the named skip `robots-disallow <host>: <company>
 *   not read today (…)`, nothing fetched; a challenge page or 429 on it disables the host;
 * - a 401, 403 or 429 from the API itself disables the host for the run: the step fails `challenged` (401, 403) or
 *   `rate_limit` (429), named, never retried around; a later company on the host is deferred without a request.
 * The coverage page crawler keeps its stricter rule (a 401/403 robots.txt disables the host); it does not apply here.
 *
 * List: `GET https://<host>/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true
 * &expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=<s>,facetsList=LOCATIONS%3BWORKPLACE_TYPES,
 * limit=100,offset=<n>[,locationId=<id>][,selectedWorkplaceTypesFacet=<id>]`, paged by `offset` += ORACLE_PAGE_SIZE until
 * the requisition list is empty or `offset >= TotalJobsCount`. The research recorded `limit=25`; seen live 2026-10-14
 * the API serves 100 (JPMorgan's India list, 297 jobs, in 3 pages instead of 12), which keeps a large India list within
 * the 10-page budget. A read needing more fails loudly (`page cap reached`, `input_rejected`), never truncated. A page
 * whose requisitions were all seen before is `invalid_output` (the API ignored the offset). A list ending before its
 * total gets the note `short-list <company> (<list>): total N, listed M`.
 *
 * Scope (as Task 6, Decision A), from the facets of the unscoped first page (offset 0; cached per company per run):
 * - the India list: `locationId=<Id>` of the `locationsFacet` value that is exactly "India" (the country level of
 *   Oracle's location hierarchy; JPMorgan: 297, as its scoped total). Its bounds are that value's count;
 * - the remote list: `selectedWorkplaceTypesFacet=<Id>` of a `workplaceTypesFacet` value whose name is a remote type
 *   ("Remote"; JPMorgan lists only "On-site", so this filter is not seen live: a wrong filter answers with the whole
 *   board, which the bounds refuse loudly);
 * - each scoped first page's `TotalJobsCount` is checked against the counts (`scopeMiss`: the sum + max(5, 5%), the
 *   largest − max(5, 5%)): outside them the step fails `input_rejected` `scope-not-applied`, nothing read from it;
 * - no office-city lists: every requisition names its locations (`PrimaryLocation`, `secondaryLocations`), so an
 *   office city is read from the job's own location values, never invented;
 * - location facets naming neither India nor a remote type: the named skip `no-india-or-remote-facet`; no location
 *   facets at all: the unscoped list, read from that first page (within the same 10 pages);
 * - one requisition in two lists is one posting (by its Id): the one naming an office city, then India, then the first;
 * - by design, a job located only outside India and not of a remote workplace type is never read.
 *
 * Detail: `GET …/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id="<id>",siteNumber=<s>`, only
 * for rank-0 jobs (a location naming India) whose title passes the pre-filter, at most ORACLE_MAX_DETAILS per company
 * per run, ties by Id; the rest flow without one (`detail-budget` note). An empty `items` (or 404/410) is a gone job:
 * dropped, with a `detail-gone` note. Only the posting fields are kept: never the contact name or e-mail, the hiring
 * manager or the office address `expand=all` also returns.
 *
 * Every response is zod-checked first; one missing an expected field (no `items`, a search without `TotalJobsCount` or
 * `requisitionList`, a detail without `Title` or `ExternalDescriptionStr`) is `invalid_output`, never partially parsed. A
 * requisition without an Id or a Title is skipped with a note; a page of nothing else is `invalid_output`. `raw`
 * (normalizer mapper `oracle`): `{ title, url, id, primaryLocation, primaryCountry, secondaryLocations, postedDate,
 * workplaceTypeCode, shortDescription, detail }`; `url` = `https://<host>/hcmUI/CandidateExperience/en/sites/<s>/job/<Id>`
 * (the recorded apply URL); `postedDate` is Oracle's `PostedDate` (YYYY-MM-DD), absent → null. The volatile relevancy and
 * distance fields are dropped. `sourceId` = the requisition Id.
 */

export const ORACLE_PAGE_SIZE = 100;
/** List pages per company per day, the discovery page included (the minimal rate of an unreadable robots.txt). */
export const ORACLE_MAX_PAGES = 10;
export const ORACLE_MAX_DETAILS = 40;
/** The spacing of requests to one Oracle host: the minimal rate of an unreadable robots.txt. */
export const ORACLE_MIN_INTERVAL_MS = 5000;
export const ORACLE_TIMEOUT_MS = 900_000;
/** robots.txt, the list pages and the details: the pacing check divides the timeout by it. */
export const ORACLE_MAX_REQUESTS = 1 + ORACLE_MAX_PAGES + ORACLE_MAX_DETAILS;
/** The symbolic egress resolved per run to the verified Oracle companies' hosts. */
export const ORACLE_EGRESS = 'registry:oracle-hosts';

const LIST_PATH = '/hcmRestApi/resources/latest/recruitingCEJobRequisitions';
const DETAIL_PATH = '/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails';

export interface OracleBoard {
  readonly host: string;
  /** The Candidate Experience site number (`CX_1001`). */
  readonly site: string;
}

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.oraclecloud\.com$/u;
const SITE = /^[A-Za-z0-9_-]{1,64}$/u;

/** `<host>/<site>` → the board; null when it is not one. */
export function parseOracleRef(ref: string): OracleBoard | null {
  const [host, site, ...rest] = ref.split('/');
  if (host === undefined || site === undefined || rest.length > 0) return null;
  if (!HOST.test(host) || !SITE.test(site)) return null;
  return { host, site };
}

export const oracleRef = (b: OracleBoard): string => `${b.host}/${b.site}`;

/** The board of a stored board URL (the registry's board_url: the list resource with `finder=findReqs;siteNumber=<s>`). */
export function oracleBoardOfUrl(boardUrl: string): OracleBoard | null {
  let u: URL;
  try {
    u = new URL(boardUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.pathname !== LIST_PATH) return null;
  let site = '';
  for (const part of (u.searchParams.get('finder') ?? '').split(/[;,]/u)) if (part.startsWith('siteNumber=')) site = part.slice('siteNumber='.length);
  return parseOracleRef(`${u.hostname.toLowerCase()}/${site}`);
}

/** The finder filters of one list (`locationId`, `selectedWorkplaceTypesFacet`); empty for the unscoped list. */
export interface OracleQuery {
  readonly locationId?: string;
  readonly selectedWorkplaceTypesFacet?: string;
}

const FILTER = /^[A-Za-z0-9_]{1,64}$/u;

export function oracleListUrl(b: OracleBoard, offset: number, q: OracleQuery = {}): string {
  const filters = (['locationId', 'selectedWorkplaceTypesFacet'] as const).flatMap((k) => {
    const v = q[k];
    if (v === undefined) return [];
    if (!FILTER.test(v)) throw new KernelError('invalid_output', `oracle: ${k} '${v.slice(0, 40)}' is not a facet id`);
    return [`,${k}=${v}`];
  });
  return `https://${b.host}${LIST_PATH}?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${b.site},facetsList=LOCATIONS%3BWORKPLACE_TYPES,limit=${ORACLE_PAGE_SIZE},offset=${offset}${filters.join('')}`;
}

export function oracleDetailUrl(b: OracleBoard, id: string): string {
  if (!FILTER.test(id)) throw new KernelError('invalid_output', `oracle: requisition id '${id.slice(0, 40)}' is not an id`);
  return `https://${b.host}${DETAIL_PATH}?expand=all&onlyData=true&finder=ById;Id=%22${id}%22,siteNumber=${b.site}`;
}

/** The job's public page on the Candidate Experience site (what the user opens and applies on). */
export const oracleJobUrl = (b: OracleBoard, id: string): string => `https://${b.host}/hcmUI/CandidateExperience/en/sites/${b.site}/job/${encodeURIComponent(id)}`;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const Id = z.union([z.string().regex(FILTER), z.number().int().nonnegative().transform(String)]);
const Text = z.string().nullish();
const Facet = z.object({ Id: z.union([z.string(), z.number()]), Name: z.string(), TotalCount: z.number().int().nonnegative() }).passthrough();
const Secondary = z.object({ Name: Text, CountryCode: Text }).passthrough();
const Requisition = z
  .object({
    Id,
    Title: z.string().refine((t) => t.trim() !== '', 'blank title'),
    PostedDate: Text,
    PrimaryLocation: Text,
    PrimaryLocationCountry: Text,
    secondaryLocations: z.array(Secondary).nullish(),
    WorkplaceTypeCode: Text,
    ShortDescriptionStr: Text,
  })
  .passthrough();
const Search = z
  .object({
    TotalJobsCount: z.number().int().nonnegative(),
    requisitionList: z.array(z.unknown()),
    locationsFacet: z.array(Facet).nullish(),
    workplaceTypesFacet: z.array(Facet).nullish(),
  })
  .passthrough();
const ListResponse = z.object({ items: z.array(Search).min(1) }).passthrough();
const Detail = z
  .object({
    Id,
    Title: z.string(),
    ExternalDescriptionStr: z.string(),
    ExternalResponsibilitiesStr: Text,
    ExternalQualificationsStr: Text,
    JobSchedule: Text,
    WorkplaceTypeCode: Text,
  })
  .passthrough();
const DetailResponse = z.object({ items: z.array(Detail) }).passthrough();

export interface OracleLocation {
  readonly name: string;
  /** ISO-2 (`IN`); null when absent. */
  readonly country: string | null;
}

export interface OracleRequisition {
  readonly id: string;
  readonly title: string;
  readonly primaryLocation: string | null;
  readonly primaryCountry: string | null;
  readonly secondaryLocations: readonly OracleLocation[];
  readonly postedDate: string | null;
  readonly workplaceTypeCode: string | null;
  readonly shortDescription: string | null;
}

export interface OracleFacetValue {
  readonly id: string;
  readonly name: string;
  readonly count: number;
}

export interface OracleListPage {
  readonly total: number;
  readonly requisitions: readonly OracleRequisition[];
  readonly locations: readonly OracleFacetValue[];
  readonly workplaceTypes: readonly OracleFacetValue[];
  readonly malformed: readonly number[];
  readonly listed: number;
}

const text = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const facetValues = (f: readonly z.infer<typeof Facet>[] | null | undefined): OracleFacetValue[] => (f ?? []).map((v) => ({ id: String(v.Id), name: v.Name.trim(), count: v.TotalCount }));

/**
 * A list page, shape-checked: `items[0]` is the search. A response without `items`, `TotalJobsCount` or
 * `requisitionList` is `invalid_output`, never partially parsed. A requisition without an Id or a Title is skipped by
 * position (the adapter notes it), unless every one of the page is (schema drift: `invalid_output`).
 */
export function parseListPage(json: unknown, what: string): OracleListPage {
  const r = ListResponse.safeParse(json);
  if (!r.success) throw shapeError(`${what} list`, r);
  const s = r.data.items[0] as z.infer<typeof Search>;
  const requisitions: OracleRequisition[] = [];
  const malformed: number[] = [];
  s.requisitionList.forEach((e, i) => {
    const q = Requisition.safeParse(e);
    if (!q.success) return void malformed.push(i);
    const p = q.data;
    requisitions.push({
      id: p.Id,
      title: p.Title.trim(),
      primaryLocation: text(p.PrimaryLocation),
      primaryCountry: text(p.PrimaryLocationCountry),
      secondaryLocations: (p.secondaryLocations ?? []).flatMap((x) => (text(x.Name) === null ? [] : [{ name: text(x.Name) as string, country: text(x.CountryCode) }])),
      postedDate: text(p.PostedDate),
      workplaceTypeCode: text(p.WorkplaceTypeCode),
      shortDescription: text(p.ShortDescriptionStr),
    });
  });
  if (malformed.length > 0 && requisitions.length === 0) throw new KernelError('invalid_output', `${what} list: all ${malformed.length} entries lack an Id or a Title`);
  return { total: s.TotalJobsCount, requisitions, locations: facetValues(s.locationsFacet), workplaceTypes: facetValues(s.workplaceTypesFacet), malformed, listed: s.requisitionList.length };
}

/** What a detail adds to a posting (null when it was not fetched). */
export interface OracleDetailRaw {
  readonly title: string;
  /** The description, responsibilities and qualifications HTML, in that order, joined. */
  readonly description: string;
  /** `JobSchedule` ("Full time"); null when absent. */
  readonly schedule: string | null;
  readonly workplaceTypeCode: string | null;
}

/** A detail, shape-checked; null when the finder found nothing (a gone job). Only the posting fields are kept. */
export function parseDetail(json: unknown, what: string): OracleDetailRaw | null {
  const r = DetailResponse.safeParse(json);
  if (!r.success) throw shapeError(`${what} detail`, r);
  const d = r.data.items[0];
  if (d === undefined) return null;
  const parts = [d.ExternalDescriptionStr, d.ExternalResponsibilitiesStr, d.ExternalQualificationsStr].map((x) => x ?? '').filter((x) => x.trim() !== '');
  return { title: d.Title.trim(), description: parts.join('\n'), schedule: text(d.JobSchedule), workplaceTypeCode: text(d.WorkplaceTypeCode) };
}

export interface OracleRaw {
  readonly title: string;
  readonly url: string;
  readonly id: string;
  readonly primaryLocation: string | null;
  readonly primaryCountry: string | null;
  readonly secondaryLocations: readonly OracleLocation[];
  /** `PostedDate` (YYYY-MM-DD); null when absent. */
  readonly postedDate: string | null;
  /** `ORA_REMOTE`, `ORA_HYBRID`, `ORA_ON_SITE`; null when absent. */
  readonly workplaceTypeCode: string | null;
  /** The list's short description (the only description without a detail). */
  readonly shortDescription: string | null;
  readonly detail: OracleDetailRaw | null;
}

/** One page's postings, each without its detail. */
export function pagePostings(b: OracleBoard, page: OracleListPage, req: Pick<DiscoveryRequest, 'company' | 'slug'>): RawPosting[] {
  return page.requisitions.map((p) => {
    const raw: OracleRaw = {
      title: p.title,
      url: oracleJobUrl(b, p.id),
      id: p.id,
      primaryLocation: p.primaryLocation,
      primaryCountry: p.primaryCountry,
      secondaryLocations: p.secondaryLocations,
      postedDate: p.postedDate,
      workplaceTypeCode: p.workplaceTypeCode,
      shortDescription: p.shortDescription,
      detail: null,
    };
    return { source: 'oracle', sourceId: p.id, company: req.company, slug: req.slug, raw };
  });
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type OracleHosts = PlatformHosts<OracleScopes>;

const reqOpts = (timeoutMs: number | undefined) => ({ minIntervalMs: ORACLE_MIN_INTERVAL_MS, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

/** One list page, shape-checked. A 404 is a retired site (`gone`), any other 4xx `invalid_output`. */
export async function fetchListPage(http: HttpTool, hosts: OracleHosts, b: OracleBoard, offset: number, q: OracleQuery = {}, timeoutMs?: number): Promise<OracleListPage> {
  const url = oracleListUrl(b, offset, q);
  const { status, json } = await hostRequest(http, hosts, b.host, url, () => http.getJson(url, reqOpts(timeoutMs)));
  if (status === 404 || status === 410) throw new KernelError('gone', `oracle site not found: ${oracleRef(b)}`);
  if (status >= 300) throw new KernelError('invalid_output', `${b.host} returned ${status} for the ${b.site} list at offset ${offset}`);
  return parseListPage(json, `oracle ${oracleRef(b)}`);
}

/** One requisition's detail, shape-checked; null when it is gone (404/410, or an empty finder result). */
export async function fetchDetail(http: HttpTool, hosts: OracleHosts, b: OracleBoard, id: string, timeoutMs?: number): Promise<OracleDetailRaw | null> {
  const url = oracleDetailUrl(b, id);
  const { status, json } = await hostRequest(http, hosts, b.host, url, () => http.getJson(url, reqOpts(timeoutMs)));
  if (status === 404 || status === 410) return null;
  if (status >= 300) throw new KernelError('invalid_output', `${b.host} returned ${status} for a ${b.site} requisition detail`);
  return parseDetail(json, `oracle ${oracleRef(b)}`);
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export interface OracleScope extends ScopeBounds {
  readonly query: OracleQuery;
}

export interface OracleScopes {
  /** `locationId` of the exact "India" location value; null when the facets name none. */
  readonly india: OracleScope | null;
  /** `selectedWorkplaceTypesFacet` of a remote workplace type; null when there is none. */
  readonly remote: OracleScope | null;
  /** Whether the search has location facet values at all. */
  readonly located: boolean;
}

/** The scopes of a site from its unscoped first page's facets (served order; the first match). */
export function oracleScopes(page: OracleListPage): OracleScopes {
  const india = page.locations.find((v) => /^\s*india\s*$/iu.test(v.name) && FILTER.test(v.id));
  const remote = page.workplaceTypes.find((v) => (REMOTE_TYPE.test(v.name) || v.id === 'ORA_REMOTE') && FILTER.test(v.id));
  return {
    india: india === undefined ? null : { query: { locationId: india.id }, expected: india.count, largest: india.count },
    remote: remote === undefined ? null : { query: { selectedWorkplaceTypesFacet: remote.id }, expected: remote.count, largest: remote.count },
    located: page.locations.length > 0,
  };
}

// ---------------------------------------------------------------------------
// The daily adapter
// ---------------------------------------------------------------------------

export const srcOracleContract = defineContract({
  id: 'src-oracle',
  version: '1.0.0',
  description: 'Reads one verified Oracle Recruiting Cloud company\'s India-located or remote requisition lists, with details for the titles the pre-filter passes, at the minimal rate of an unreadable robots.txt, within a per-company page budget',
  skills: ['job-sourcing'],
  // Its own team (spec §6): a dead Oracle tenant never opens a breaker for another platform or the ATS sources.
  team: 'sourcing-oracle',
  kind: 'io',
  consumes: DiscoveryRequest,
  produces: RawPosting,
  requires: [knownAts],
  capabilities: { http: true, pack: true },
  egress: [ORACLE_EGRESS],
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: ORACLE_TIMEOUT_MS,
  // 429 is never retried (the host is disabled); a retry starts the company again, so at most one.
  retry: { max: 1, on: ['overloaded', 'network'], backoffMs: [8000] },
});

export interface SrcOracleOptions {
  readonly hosts: OracleHosts;
  readonly maxPages?: number;
  readonly maxDetails?: number;
}

const rawOf = (p: RawPosting): OracleRaw => p.raw as OracleRaw;
const placesOf = (r: OracleRaw): string[] => [...(r.primaryLocation === null ? [] : [r.primaryLocation]), ...r.secondaryLocations.map((l) => l.name)];
/** Rank 0 for details: a location (or its country code) naming India. */
const indiaNamed = (p: RawPosting): boolean => {
  const r = rawOf(p);
  return r.primaryCountry === 'IN' || r.secondaryLocations.some((l) => l.country === 'IN') || placesOf(r).some(namesIndia);
};

/** The company's list-page budget for the day: every list page counts, the discovery page included. */
interface PageBudget {
  used: number;
  readonly max: number;
}

async function readList(http: HttpTool, hosts: OracleHosts, b: OracleBoard, req: DiscoveryRequest, q: OracleQuery, first: OracleListPage, budget: PageBudget, ctx: AgentContext, label: string): Promise<RawPosting[]> {
  const what = `oracle ${req.company}`;
  const all: RawPosting[] = [];
  const seen = new Set<string>();
  const total = first.total;
  let page = first;
  let listed = 0;
  for (let offset = 0; ; ) {
    if (page.listed === 0) break;
    if (onlySeenBefore(seen, page.requisitions.map((r) => r.id))) throw new KernelError('invalid_output', `${what}: the page at offset ${offset} repeats earlier postings (Oracle ignored the offset)`);
    if (page.malformed.length > 0) ctx.skipped(page.malformed.map((i) => `oracle ${req.company}${label} offset ${offset} entry ${i}: no Id or Title`));
    all.push(...pagePostings(b, page, req));
    listed += page.listed;
    offset += ORACLE_PAGE_SIZE;
    if (offset >= total) break;
    page = await nextPage(http, hosts, b, offset, q, budget, `${what}${label}: page cap reached at ${listed} postings (total ${total}; ${budget.max} list pages per company per day, discovery included)`);
  }
  if (listed < total) ctx.skipped([`short-list ${req.company}${label}: total ${total}, listed ${listed}`]);
  return all;
}

/** A list page within the company's daily page budget; past it, the loud `input_rejected` refusal `capMessage`. */
async function nextPage(http: HttpTool, hosts: OracleHosts, b: OracleBoard, offset: number, q: OracleQuery, budget: PageBudget, capMessage: string): Promise<OracleListPage> {
  if (budget.used >= budget.max) throw new KernelError('input_rejected', capMessage);
  budget.used++;
  return fetchListPage(http, hosts, b, offset, q);
}

async function runCompany(req: DiscoveryRequest, ctx: AgentContext, o: Required<SrcOracleOptions>): Promise<RawPosting[]> {
  const http = ctx.http;
  if (!http) throw new KernelError('policy_denied', 'no http capability issued');
  const b = parseOracleRef(req.slug);
  if (b === null) throw new KernelError('invalid_output', `oracle: ${req.slug} is not <host>/<siteNumber>`);
  const pack = titlePackOf(ctx.pack, 'src-oracle');
  const offices = pack.eligibility?.officeCities ?? [];
  const budget: PageBudget = { used: 0, max: o.maxPages };
  const what = `oracle ${req.company}`;
  try {
    const key = oracleRef(b);
    let scopes = o.hosts.scopes?.get(key);
    let first: OracleListPage | undefined;
    if (scopes === undefined) {
      first = await nextPage(http, o.hosts, b, 0, {}, budget, `${what}: page cap reached before discovery`);
      scopes = oracleScopes(first);
      o.hosts.scopes?.set(key, scopes);
    }
    const lists = ([['india', scopes.india], ['remote', scopes.remote]] as const).filter((x): x is readonly ['india' | 'remote', OracleScope] => x[1] !== null);
    const all: RawPosting[] = [];
    if (lists.length > 0) {
      for (const [name, sc] of lists) {
        const page1 = await nextPage(http, o.hosts, b, 0, sc.query, budget, `${what} (${name} list): page cap reached before its first page (${budget.max} list pages per company per day, discovery included)`);
        const miss = scopeMiss(page1.total, sc);
        if (miss !== null) throw scopeNotApplied(req.company, name, miss, 'Oracle');
        all.push(...(await readList(http, o.hosts, b, req, sc.query, page1, budget, ctx, ` (${name} list)`)));
      }
    } else if (scopes.located) {
      ctx.skipped([`no-india-or-remote-facet ${req.company}: its location facets name neither India nor a remote workplace type`]);
      return [];
    } else {
      first ??= await nextPage(http, o.hosts, b, 0, {}, budget, `${what}: page cap reached before the unscoped list`);
      all.push(...(await readList(http, o.hosts, b, req, {}, first, budget, ctx, '')));
    }
    const postings = preferPostings(all, (p) => (placesOf(rawOf(p)).some((l) => namesOffice(l, offices)) ? 0 : indiaNamed(p) ? 1 : 2));

    const chosen = chooseDetails(postings, { pack, title: (p) => rawOf(p).title, rank0: indiaNamed, max: o.maxDetails, company: req.company, ctx });
    const details = new Map<string, OracleDetailRaw | null>();
    for (const p of chosen) details.set(p.sourceId, await fetchDetail(http, o.hosts, b, p.sourceId));
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

/** Builds `src-oracle` for one run, on the run's host state (robots.txt cache, disabled hosts, discovered scopes). */
export function makeSrcOracle(o: SrcOracleOptions): Agent<DiscoveryRequest, RawPosting> {
  const opts: Required<SrcOracleOptions> = { hosts: o.hosts, maxPages: Math.min(o.maxPages ?? ORACLE_MAX_PAGES, ORACLE_MAX_PAGES), maxDetails: o.maxDetails ?? ORACLE_MAX_DETAILS };
  return defineAgent(srcOracleContract, (req, ctx) => (req.ats === 'oracle' ? runCompany(req, ctx, opts) : Promise.resolve([])));
}
