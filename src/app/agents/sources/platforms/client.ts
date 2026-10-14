import { z } from 'zod';
import type { AgentContext } from '../../../../kernel/agent.js';
import { KernelError } from '../../../../kernel/errors.js';
import type { DiscoveryRequest, RawPosting } from '../../../types.js';
import { ASHBY_HOST, ashbyParse, ashbyUrl } from '../ashby.js';
import type { Parsed } from '../common.js';
import { GREENHOUSE_HOST, greenhouseParse, greenhouseUrl } from '../greenhouse.js';
import { LEVER_HOST, LEVER_PAGE_SIZE, leverParse, leverUrl } from '../lever.js';
import * as ef from './eightfold.js';
import * as orc from './oracle.js';
import { fetchIcimsListing, icimsBoardOfUrl, icimsSitemapUrl, parseIcimsRef } from './icims.js';
import { fetchJsonLdListing, jsonLdBoardOfUrl, jsonLdRef, parseJsonLdRef } from './jsonld-sitemap.js';
import { hiringOrganizationOf, readOneJobPage, type PageListing } from './pages.js';
import { fetchSrListing, parseSmartRecruitersRef, smartRecruitersBoardOfUrl, srListingUrl } from './smartrecruiters.js';
import { parseSuccessFactorsRef, readSitemal, sitemalUrl, successFactorsBoardOfUrl } from './successfactors.js';
import { HostRefused, type PlatformHosts } from './shared.js';
import { fetchListPage, pagePostings, parseWorkdayRef, workdayBoardOfUrl, workdayListUrl, workdayRef, WORKDAY_PAGE_SIZE, type WorkdayHosts } from './workday.js';

/**
 * The read side of each career platform, shared by the coverage run's board-verifier (Task 5) and the daily adapters
 * (Tasks 6-8 add one per platform). A client reads a board the way the platform's daily adapter does: the same host,
 * the same URL builder and the same parser (`greenhouseUrl` + `greenhouseParse`, ...), so a board the verifier accepts
 * is one the daily run can read. The daily adapters themselves are not changed: their step keys stay as on main.
 *
 * `readBoard` makes ONE request (Lever: the first page of LEVER_PAGE_SIZE, the daily adapter's page 1) and checks the
 * response shape with zod before the daily parser sees it. It throws:
 * - `BoardRefused` on 401 or 403 (the caller disables the host for the run, never retries around it);
 * - Workday only: `RobotsDenied` when robots.txt refuses the CXS path, `HostDisabled` when the host was disabled earlier
 *   in the run (both from workday.ts; nothing is fetched);
 * - `KernelError('gone')` on 404, as the daily adapters' `getBoard` does;
 * - `KernelError('invalid_output')` on any other 4xx or a response of the wrong shape;
 * - whatever the broker raises (`rate_limit` on 429, `overloaded` on 5xx, `network`, a timeout).
 *
 * The board-API rule (decided 2026-10-14): a client reads only the platform's DOCUMENTED PUBLIC job-board API
 * (Greenhouse Job Board API `boards-api.greenhouse.io`, Lever Postings API `api.lever.co`, Ashby posting API
 * `api.ashbyhq.com`), which each platform publishes for programmatic use. It does not fetch robots.txt for these
 * API hosts, exactly as the daily adapters do not (seen live 2026-10-13: Greenhouse disallows only `/embed/`, Lever
 * says `Allow: /`, Ashby answers 401 for robots.txt). robots.txt keeps governing every PAGE fetch: the careers
 * locator and the platform detector honour it for every request, through the coverage gate. If a board API answers
 * 401, 403 or 429, the verifier disables that API host for the rest of the run, with a named problem (a deferral),
 * and never retries around it.
 *
 * Workday (Task 6) is different: its CXS endpoint is the JSON the public careers page itself calls, not a documented
 * public API, so robots.txt applies to it. Its client reads the board's host from the detected board URL (each tenant
 * has its own host: `host` is null, `hostOf` gives it), checks that host's robots.txt for the CXS path through the
 * run's `WorkdayHosts` (the verifier passes one built on the coverage gate), and reads page 1 of the list with the
 * daily adapter's own request and parser (`fetchListPage`, `pagePostings`). Workday has no company-name field: the
 * board's name to compare is its tenant (`nameKey`), matched under the generic-label rules like a slug.
 *
 * Eightfold and Oracle Recruiting Cloud (Task 7) read the same way, with their daily adapters' own requests and
 * parsers, robots.txt governing (the careers page's own JSON; Oracle's REST resource):
 * - Eightfold: the tenant's careers page first (its embedded configuration names the API, v2 or PCSX: the other one
 *   answers 403), then page 1 of the unscoped list (2 requests). The detected API is returned as `stored` (slug
 *   `pcsx:<host>/<domain>` and that API's board URL), so the registry keeps it and the daily run skips the careers page. Neither API has a company-name field: the name to
 *   compare is the `domain` parameter's first label (`netflix.com` → `netflix`), under the generic-label rules;
 * - Oracle: page 1 of the unscoped requisition list. Its robots.txt answers 403 (the WAF): for this REST API that is
 *   "unknown", read at the minimal rate (`robotsUnreadable: 'allow'`, a controller decision; the coverage page crawler
 *   keeps refusing a 401/403 robots.txt for pages). No company-name field: the host's first label (`jpmc`) is
 *   compared, so a tenant label that is not the company's name is proposed "board name not available, please confirm".
 *
 * The page adapters (Task 8) read PAGES, so robots.txt governs them under the strict page rule (a 401/403 robots.txt
 * refuses): `readBoard` reads the listing once (iCIMS: the portal sitemap; SmartRecruiters: the jobs.smartrecruiters.com
 * listing; jsonld-sitemap: the site's sitemaps), requires at least one job URL (none: 0 jobs, proposed, no page
 * fetched), then fetches job pages in listing order, at most VERIFY_MAX_PAGES (3, fix round 2: a stale sitemap lists
 * gone pages first), until one has a valid JobPosting (none: `invalid_output`, a failed verdict). The board name is that JobPosting's `hiringOrganization.name`, matched by the existing name rules;
 * without one, proposed. SuccessFactors is read the way its daily adapter reads it: `sitemal.xml` streamed only up to
 * its first item, within the policy's response cap, and no job page is fetched (the daily postings come from the feed
 * itself, not job pages; an accepted deviation from "one job page with a valid JobPosting", Task 8 fix round 1); the
 * board name is that item's `g:employer`. A
 * 401/403 is `BoardRefused`, a 429 `rate_limit`, a challenge `challenged`: the verifier defers all three.
 *
 * Agent code (containment): it imports only kernel definitions, so the platform is a plain string here; the coverage
 * types' `Platform` enum is a superset of these keys.
 */

/** The broker's HTTP tool, as an agent's context carries it. */
export type HttpTool = NonNullable<AgentContext['http']>;

export interface BoardRead {
  /** The board's own company name, when the platform gives one and every job agrees on it; else null. */
  readonly boardName: string | null;
  /** Every distinct company name the board's jobs carry, sorted (more than one: the board is not one company's). */
  readonly boardNames: readonly string[];
  readonly jobs: readonly RawPosting[];
  /** False when the board has more jobs than this one request returned (a full Lever page, a Workday total over 20). */
  readonly complete: boolean;
  /** The URL read. */
  readonly url: string;
  /** When the platform gives no board name: the part of the board id to compare with the company (Workday: the tenant); null to use the slug. */
  readonly nameKey: string | null;
  /**
   * What the registry should store for this board instead of the detection's slug and board URL (Eightfold: the API
   * variant detected at verify time, `pcsx:<host>/<domain>`, and that API's list URL); absent: the detection's.
   */
  readonly stored?: { readonly slug: string; readonly boardUrl: string };
}

/** What a read may be given: a per-request timeout, and (Workday, Eightfold, Oracle) the run's host state for robots.txt and refusals. */
export interface ReadOptions {
  readonly timeoutMs?: number;
  readonly hosts?: PlatformHosts;
}

export interface PlatformClient {
  readonly platform: string;
  /** The one host the client reads from (the verifier's egress for this platform); null when each board has its own (Workday). */
  readonly host: string | null;
  /** Whether robots.txt governs the read (a page's own JSON rather than a documented public API): the caller passes `hosts`. */
  readonly robots: boolean;
  /** A 401/403 robots.txt: refused (the default) or "unknown", read at the minimal rate (Oracle Recruiting Cloud, a controller decision). */
  readonly robotsUnreadable?: 'refuse' | 'allow';
  /** The board id the client reads, from a detection's slug and board URL (Workday: `<host>/<tenant>/<site>`); null when they name none. */
  readonly refOf: (slug: string, boardUrl: string | null) => string | null;
  /** The host a board id is read from. */
  readonly hostOf: (ref: string) => string | null;
  readonly boardUrl: (ref: string) => string;
  /** `timeoutMs`: a per-request timeout (the coverage verifier's); absent, only the step timeout applies. */
  readBoard(ref: string, http: HttpTool, opts?: ReadOptions): Promise<BoardRead>;
}

/** A 401 or 403 from the platform's host: a refusal of the requester, not a fact about the board. */
export class BoardRefused extends Error {
  constructor(
    readonly status: number,
    readonly host: string,
  ) {
    super(`${host} answered ${status}`);
    this.name = 'BoardRefused';
  }
}

const JobId = z.union([z.number(), z.string()]);
const SHAPES = {
  greenhouse: z.object({ jobs: z.array(z.object({ id: JobId, title: z.string(), company_name: z.string().nullish() }).passthrough()) }).passthrough(),
  lever: z.array(z.object({ id: z.string(), text: z.string() }).passthrough()),
  ashby: z.object({ jobs: z.array(z.object({ id: z.string(), title: z.string() }).passthrough()) }).passthrough(),
} as const;

/** The daily parsers read only `slug` and `company` of the request; the rest is a placeholder. */
const requestFor = (ats: 'greenhouse' | 'lever' | 'ashby', slug: string): DiscoveryRequest => ({ ats, slug, company: slug, runDate: '1970-01-01' });

/**
 * One GET of the board, read with the broker's `getPage` (the same URL, method, headers, pacing and size cap as the
 * daily adapter's `getJson`; redirects are never followed by either). `getPage` reports a 3xx instead of recording a
 * policy denial, so a board API that redirects (off-platform, a retired board) is a finding about the board, not a
 * failure of the step: `invalid_output` "board API redirected off-platform". 429 and 5xx keep the broker's codes.
 */
async function getJson(http: HttpTool, url: string, host: string, slug: string, timeoutMs?: number): Promise<unknown> {
  const { status, body, location } = await http.getPage(url, timeoutMs === undefined ? undefined : { timeoutMs });
  if (status >= 300 && status < 400) {
    let to = 'nowhere';
    try {
      to = location === null ? to : new URL(location, url).hostname;
    } catch {
      to = 'an invalid Location';
    }
    throw new KernelError('invalid_output', `board API redirected off-platform (${status} to ${to})`);
  }
  if (status === 429) throw new KernelError('rate_limit', `429 from ${host}`);
  if (status >= 500) throw new KernelError('overloaded', `${status} from ${host}`);
  if (status === 401 || status === 403) throw new BoardRefused(status, host);
  if (status === 404) throw new KernelError('gone', `board not found: ${slug}`);
  if (status < 200 || status >= 300) throw new KernelError('invalid_output', `${host} returned ${status} for ${slug}`);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new KernelError('invalid_output', `response from ${host} is not valid JSON`);
  }
}

function checkShape(platform: keyof typeof SHAPES, slug: string, json: unknown): void {
  const r = SHAPES[platform].safeParse(json);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first === undefined ? '' : ` (${first.path.map(String).join('.') || 'root'}: ${first.message})`;
    throw new KernelError('invalid_output', `${platform} board ${slug}: response shape is not valid${where}`);
  }
}

const distinctNames = (jobs: readonly unknown[]): string[] =>
  [...new Set(jobs.map((j) => (typeof j === 'object' && j !== null ? (j as { company_name?: unknown }).company_name : undefined)).filter((n): n is string => typeof n === 'string' && n.trim() !== '').map((n) => n.trim()))].sort();

const read = (parsed: Parsed, names: readonly string[], complete: boolean, url: string): BoardRead => ({
  boardName: names.length === 1 ? (names[0] as string) : null,
  boardNames: names,
  jobs: parsed.postings,
  complete,
  url,
  nameKey: null,
});

/** A single-host client's board id is its slug. */
const singleHost = (host: string) => ({ host, robots: false, refOf: (slug: string) => slug, hostOf: () => host });

/** A Workday board id: the stored board URL's, or `<host>/<tenant>/<site>` itself. */
const workdayRefOf = (slug: string, boardUrl: string | null): string | null => {
  const b = (boardUrl === null ? null : workdayBoardOfUrl(boardUrl)) ?? parseWorkdayRef(slug);
  return b === null ? null : workdayRef(b);
};

const CLIENTS: Readonly<Record<string, PlatformClient>> = {
  greenhouse: {
    platform: 'greenhouse',
    ...singleHost(GREENHOUSE_HOST),
    boardUrl: greenhouseUrl,
    async readBoard(slug, http, opts) {
      const url = greenhouseUrl(slug);
      const json = await getJson(http, url, GREENHOUSE_HOST, slug, opts?.timeoutMs);
      checkShape('greenhouse', slug, json);
      const jobs = (json as { jobs: unknown[] }).jobs;
      return read(greenhouseParse(json, requestFor('greenhouse', slug)), distinctNames(jobs), true, url);
    },
  },
  lever: {
    platform: 'lever',
    ...singleHost(LEVER_HOST),
    boardUrl: (slug) => leverUrl(slug, 0),
    async readBoard(slug, http, opts) {
      const url = leverUrl(slug, 0);
      const json = await getJson(http, url, LEVER_HOST, slug, opts?.timeoutMs);
      checkShape('lever', slug, json);
      // Lever's postings carry no company name.
      return read(leverParse(json, requestFor('lever', slug)), [], (json as unknown[]).length < LEVER_PAGE_SIZE, url);
    },
  },
  ashby: {
    platform: 'ashby',
    ...singleHost(ASHBY_HOST),
    boardUrl: ashbyUrl,
    async readBoard(slug, http, opts) {
      const url = ashbyUrl(slug);
      const json = await getJson(http, url, ASHBY_HOST, slug, opts?.timeoutMs);
      checkShape('ashby', slug, json);
      // Ashby's job-board response carries no company name.
      return read(ashbyParse(json, requestFor('ashby', slug)), [], true, url);
    },
  },
  workday: {
    platform: 'workday',
    host: null,
    robots: true,
    refOf: workdayRefOf,
    hostOf: (ref) => parseWorkdayRef(ref)?.host ?? null,
    boardUrl: (ref) => {
      const b = parseWorkdayRef(ref);
      if (b === null) throw new KernelError('invalid_output', `workday: ${ref} is not <host>/<tenant>/<site>`);
      return workdayListUrl(b);
    },
    async readBoard(ref, http, opts) {
      const b = parseWorkdayRef(ref);
      if (b === null) throw new KernelError('invalid_output', `workday: ${ref} is not <host>/<tenant>/<site>`);
      if (opts?.hosts === undefined) throw new KernelError('policy_denied', 'workday: robots.txt applies, and no host state was given');
      // the daily adapter's own request (POST, page 1, the 2 s spacing, robots.txt) and parser
      let page;
      try {
        page = await fetchListPage(http, opts.hosts as WorkdayHosts, b, 0, {}, opts.timeoutMs);
      } catch (e) {
        // the host state has already disabled the host; the caller defers, as for any refused board API
        if (e instanceof HostRefused) throw new BoardRefused(e.status, e.host);
        throw e;
      }
      const jobs = pagePostings(b, page, { company: b.tenant, slug: ref });
      return { boardName: null, boardNames: [], jobs, complete: page.total <= WORKDAY_PAGE_SIZE, url: workdayListUrl(b), nameKey: b.tenant };
    },
  },
  eightfold: {
    platform: 'eightfold',
    host: null,
    robots: true,
    refOf: (slug, boardUrl) => {
      const b = (boardUrl === null ? null : ef.eightfoldBoardOfUrl(boardUrl)) ?? ef.parseEightfoldRef(slug);
      return b === null ? null : ef.eightfoldRef(b);
    },
    hostOf: (ref) => ef.parseEightfoldRef(ref)?.host ?? null,
    boardUrl: (ref) => ef.eightfoldListUrl(boardOf(ref, ef.parseEightfoldRef, 'eightfold', '<host>/<domain>'), 'v2', 0),
    async readBoard(ref, http, opts) {
      const b = boardOf(ref, ef.parseEightfoldRef, 'eightfold', '<host>/<domain>');
      const hosts = hostsOf(opts, 'eightfold') as ef.EightfoldHosts;
      // the daily adapter's own requests (the careers page for the API, then page 1; v2 2 s, PCSX 10 s spacing; robots.txt) and parser
      const { api, page } = await refused(async () => {
        const a = await ef.fetchApi(http, hosts, b, ef.eightfoldRef(b), opts?.timeoutMs);
        return { api: a, page: await ef.fetchListPage(http, hosts, b, a, 0, {}, opts?.timeoutMs) };
      });
      const jobs = ef.pagePostings(b, api, page, { company: b.domain, slug: ref });
      const plain = { host: b.host, domain: b.domain };
      return {
        boardName: null,
        boardNames: [],
        jobs,
        complete: page.count <= ef.EIGHTFOLD_PAGE_SIZE,
        url: ef.eightfoldListUrl(b, api, 0),
        nameKey: b.domain.split('.')[0] ?? b.domain,
        // the variant, detected here once a week, is stored for the daily run (Fix round 1)
        stored: { slug: ef.eightfoldRef({ ...plain, api }), boardUrl: ef.eightfoldStoredBoardUrl(plain, api) },
      };
    },
  },
  oracle: {
    platform: 'oracle',
    host: null,
    robots: true,
    robotsUnreadable: 'allow',
    refOf: (slug, boardUrl) => {
      const b = (boardUrl === null ? null : orc.oracleBoardOfUrl(boardUrl)) ?? orc.parseOracleRef(slug);
      return b === null ? null : orc.oracleRef(b);
    },
    hostOf: (ref) => orc.parseOracleRef(ref)?.host ?? null,
    boardUrl: (ref) => orc.oracleListUrl(boardOf(ref, orc.parseOracleRef, 'oracle', '<host>/<siteNumber>'), 0),
    async readBoard(ref, http, opts) {
      const b = boardOf(ref, orc.parseOracleRef, 'oracle', '<host>/<siteNumber>');
      const hosts = hostsOf(opts, 'oracle') as orc.OracleHosts;
      const page = await refused(() => orc.fetchListPage(http, hosts, b, 0, {}, opts?.timeoutMs));
      const jobs = orc.pagePostings(b, page, { company: b.site, slug: ref });
      return { boardName: null, boardNames: [], jobs, complete: page.total <= orc.ORACLE_PAGE_SIZE, url: orc.oracleListUrl(b, 0), nameKey: b.host.split('.')[0] ?? b.host };
    },
  },
};

/** A page platform's read: the listing, then one job page for the board name (see the header). */
async function pageRead(platform: string, ref: string, http: HttpTool, opts: ReadOptions | undefined, url: string, listing: (hosts: PlatformHosts) => Promise<PageListing>, follow: (u: URL) => boolean): Promise<BoardRead> {
  const hosts = hostsOf(opts, platform);
  return refused(async () => {
    const l = await listing(hosts);
    const jobs: RawPosting[] = l.jobs.map((j) => ({ source: platform, sourceId: j.sourceId, company: ref, slug: ref, raw: { url: j.url, title: j.title } }));
    const first = l.jobs[0];
    if (first === undefined) return { boardName: null, boardNames: [], jobs, complete: true, url, nameKey: null };
    const ld = await readOneJobPage(http, hosts, l.jobs, follow, `${platform} ${ref}`, opts?.timeoutMs);
    const name = hiringOrganizationOf(ld);
    return { boardName: name, boardNames: name === null ? [] : [name], jobs, complete: true, url, nameKey: null };
  });
}

const sameHostAs = (host: string) => (u: URL): boolean => u.hostname.toLowerCase() === host;

const PAGE_CLIENTS: Readonly<Record<string, PlatformClient>> = {
  icims: {
    platform: 'icims',
    host: null,
    robots: true,
    refOf: (slug, boardUrl) => (boardUrl === null ? null : icimsBoardOfUrl(boardUrl)) ?? parseIcimsRef(slug),
    hostOf: (ref) => parseIcimsRef(ref),
    boardUrl: (ref) => icimsSitemapUrl(boardOf(ref, parseIcimsRef, 'icims', '<portal host>')),
    readBoard(ref, http, opts) {
      const host = boardOf(ref, parseIcimsRef, 'icims', '<portal host>');
      return pageRead('icims', ref, http, opts, icimsSitemapUrl(host), (hosts) => fetchIcimsListing(http, hosts, host, opts?.timeoutMs), sameHostAs(host));
    },
  },
  smartrecruiters: {
    platform: 'smartrecruiters',
    host: 'jobs.smartrecruiters.com',
    robots: true,
    refOf: (slug, boardUrl) => (boardUrl === null ? null : smartRecruitersBoardOfUrl(boardUrl)) ?? parseSmartRecruitersRef(slug),
    hostOf: (ref) => (parseSmartRecruitersRef(ref) === null ? null : 'jobs.smartrecruiters.com'),
    boardUrl: (ref) => srListingUrl(boardOf(ref, parseSmartRecruitersRef, 'smartrecruiters', '<company id>')),
    readBoard(ref, http, opts) {
      const co = boardOf(ref, parseSmartRecruitersRef, 'smartrecruiters', '<company id>');
      return pageRead('smartrecruiters', ref, http, opts, srListingUrl(co), (hosts) => fetchSrListing(http, hosts, co, opts?.timeoutMs), sameHostAs('jobs.smartrecruiters.com'));
    },
  },
  'jsonld-sitemap': {
    platform: 'jsonld-sitemap',
    host: null,
    robots: true,
    refOf: (slug, boardUrl) => {
      const s = parseJsonLdRef(slug);
      const h = boardUrl === null ? null : jsonLdBoardOfUrl(boardUrl);
      if (h === null) return s === null ? null : jsonLdRef(s);
      return s !== null && s.host === h ? jsonLdRef(s) : h;
    },
    hostOf: (ref) => parseJsonLdRef(ref)?.host ?? null,
    boardUrl: (ref) => `https://${boardOf(ref, parseJsonLdRef, 'jsonld-sitemap', '<host>[/<path prefix>]').host}/sitemap.xml`,
    readBoard(ref, http, opts) {
      const b = boardOf(ref, parseJsonLdRef, 'jsonld-sitemap', '<host>[/<path prefix>]');
      return pageRead('jsonld-sitemap', ref, http, opts, `https://${b.host}/sitemap.xml`, (hosts) => fetchJsonLdListing(http, hosts, b, b.host, opts?.timeoutMs), sameHostAs(b.host));
    },
  },
  successfactors: {
    platform: 'successfactors',
    host: null,
    robots: true,
    refOf: (slug, boardUrl) => (boardUrl === null ? null : successFactorsBoardOfUrl(boardUrl)) ?? (boardUrl === null ? parseSuccessFactorsRef(slug) : null),
    hostOf: (ref) => parseSuccessFactorsRef(ref),
    boardUrl: (ref) => sitemalUrl(boardOf(ref, parseSuccessFactorsRef, 'successfactors', '<site host>')),
    async readBoard(ref, http, opts) {
      const host = boardOf(ref, parseSuccessFactorsRef, 'successfactors', '<site host>');
      const hosts = hostsOf(opts, 'successfactors');
      // up to the first item only, within the policy's response cap (no httpStream capability needed)
      const feed = await refused(() => readSitemal(http, hosts, host, host, { maxBytes: VERIFY_STREAM_BYTES, stopAfter: 1, ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) }));
      const first = feed.items[0];
      const jobs: RawPosting[] = first === undefined ? [] : [{ source: 'successfactors', sourceId: first.id, company: host, slug: ref, raw: { url: first.link, title: first.title } }];
      const name = first?.employer ?? null;
      return { boardName: name, boardNames: name === null ? [] : [name], jobs, complete: false, url: sitemalUrl(host), nameKey: null };
    },
  },
};

/**
 * The verifier's SuccessFactors read stops at the first item, within the policy's response cap: it needs a
 * `maxResponseBytes` of at least this (accepted, fix round 2; the product policy's is 16 MB).
 */
const VERIFY_STREAM_BYTES = 8 * 1024 * 1024;

/** The board of a ref, or `invalid_output` naming the platform's ref shape. */
function boardOf<B>(ref: string, parse: (r: string) => B | null, platform: string, shape: string): B {
  const b = parse(ref);
  if (b === null) throw new KernelError('invalid_output', `${platform}: ${ref} is not ${shape}`);
  return b;
}

/** The host state a robots-governed read needs; `policy_denied` when the caller gave none. */
function hostsOf(opts: ReadOptions | undefined, platform: string): PlatformHosts {
  if (opts?.hosts === undefined) throw new KernelError('policy_denied', `${platform}: robots.txt applies, and no host state was given`);
  return opts.hosts;
}

/** A host's 401/403 as `BoardRefused` (the host state has already disabled it; the caller defers, as for any refused board API). */
async function refused<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof HostRefused) throw new BoardRefused(e.status, e.host);
    throw e;
  }
}

/** The platform's read client, or null when this build has no adapter for it yet (Tasks 6-8 add them). */
export function platformClient(platform: string): PlatformClient | null {
  if (Object.hasOwn(CLIENTS, platform)) return CLIENTS[platform] as PlatformClient;
  return Object.hasOwn(PAGE_CLIENTS, platform) ? (PAGE_CLIENTS[platform] as PlatformClient) : null;
}

/** The platforms this build can read (and so verify), sorted. */
export const BUILT_PLATFORMS: readonly string[] = [...Object.keys(CLIENTS), ...Object.keys(PAGE_CLIENTS)].sort();
