import { defineAgent, type Agent, type AgentContext } from '../../../../kernel/agent.js';
import { defineContract } from '../../../../kernel/contract.js';
import { KernelError } from '../../../../kernel/errors.js';
import { isSitemapIndex, sitemapLocs } from '../../../text/sitemap.js';
import { DiscoveryRequest, knownAts, RawPosting } from '../../../types.js';
import { getListing, memoryPageState, PAGE_MAX_FETCHES, PAGE_MAX_HOPS, prefilter, readJobPages, slugTitle, type ListedJob, type PageListing, type PageState } from './pages.js';
import { memoryPageLedger, refusal, titlePackOf, type HttpTool, type PageLedger, type PlatformHosts } from './shared.js';

/**
 * iCIMS (career-sites spec §4, Task 8): the daily adapter for every verified registry company on an iCIMS portal
 * (Atlassian's `careers-apac-atlassian.icims.com`), and the request and parse code the verifier's iCIMS client shares.
 *
 * A board is its portal host (`careers-<co>.icims.com`, the ref and the DiscoveryRequest slug, as the platform detector
 * names it). iCIMS has no public job API; its search page answered Atlassian with only a JavaScript redirect (the
 * research), so the adapter reads PAGES, under the strict page rule of `pages.ts` (robots.txt once per host per run,
 * 401/403 robots.txt refuses, refusals disable the host, ≥ 2 s per host):
 * - **Listing:** `GET https://<host>/sitemap.xml` (robots.txt names it; seen live: 66 `<loc>`s for Atlassian, one
 *   counted request). A job is a `<loc>` on the host whose path is `/jobs/<id>/<slug>/job`; its title for the pre-filter
 *   is the slug's words (`senior-backend-software-engineer`); its sourceId the numeric id. A sitemap index is refused
 *   by name (`input_rejected`: not seen on iCIMS, never guessed through). 404/410 is `gone`.
 * - **Job pages:** `<loc>?in_iframe=1`, the page with the JobPosting JSON-LD (seen live), robots.txt matched with the
 *   path and the query. At most PAGE_MAX_FETCHES per company per IST day, in the fair rotation; the rest queued by name;
 *   a page fetched before keeps its posting (`pages.ts`).
 * - `raw` (normalizer mapper `icims`, the careers JSON-LD mapping): `{ url, title, jsonLd }`, `url` the sitemap URL
 *   (without the query), `jsonLd` the kept JobPosting. Location from `jobLocation`, remote from `jobLocationType:
 *   TELECOMMUTE`, the remote scope from `applicantLocationRequirements`, exactly as the careers source.
 */

export const ICIMS_EGRESS = 'registry:icims-hosts';
export const ICIMS_TIMEOUT_MS = 900_000;
/** robots.txt, the sitemap, and every job page with its redirects. */
export const ICIMS_MAX_REQUESTS = 2 + PAGE_MAX_FETCHES * (1 + PAGE_MAX_HOPS);

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.icims\.com$/u;

/** The portal host of a ref; null when it is not an iCIMS portal (`www.icims.com` is the vendor's site). */
export function parseIcimsRef(ref: string): string | null {
  return HOST.test(ref) && !ref.startsWith('www.') ? ref : null;
}

/** The portal of a stored board URL (the detector's `https://<host>/sitemap.xml`, or any URL on the portal). */
export function icimsBoardOfUrl(boardUrl: string): string | null {
  try {
    const u = new URL(boardUrl);
    return u.protocol === 'https:' && u.port === '' ? parseIcimsRef(u.hostname.toLowerCase()) : null;
  } catch {
    return null;
  }
}

export const icimsSitemapUrl = (host: string): string => `https://${host}/sitemap.xml`;

/** The jobs of a portal's sitemap: `/jobs/<id>/<slug>/job` on the host, in sitemap order, read with `?in_iframe=1`. */
export function icimsJobs(xml: string, host: string): ListedJob[] {
  const out: ListedJob[] = [];
  for (const loc of sitemapLocs(xml)) {
    let u: URL;
    try {
      u = new URL(loc);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== host) continue;
    const p = u.pathname.split('/');
    // ['', 'jobs', '<id>', '<slug>', 'job']
    if (p.length !== 5 || p[1] !== 'jobs' || !/^\d{1,12}$/u.test(p[2] ?? '') || p[4] !== 'job') continue;
    const url = `https://${host}${u.pathname}`;
    out.push({ url, title: slugTitle(p[3] ?? ''), sourceId: p[2] as string, fetchUrl: `${url}?in_iframe=1` });
  }
  return out;
}

const sameHost = (host: string) => (u: URL): boolean => u.hostname.toLowerCase() === host;

/** The portal's sitemap (one request, robots.txt first), as its jobs. */
export async function fetchIcimsListing(http: HttpTool, hosts: PlatformHosts, host: string, timeoutMs?: number): Promise<PageListing> {
  const { body } = await getListing(http, hosts, icimsSitemapUrl(host), `icims ${host}`, sameHost(host), timeoutMs);
  if (isSitemapIndex(body)) throw new KernelError('input_rejected', `icims ${host}: the sitemap is a sitemap index, which this adapter does not read; nothing read`);
  if (!/<urlset[\s>]/iu.test(body.slice(0, 4096))) throw new KernelError('input_rejected', `icims ${host}: sitemap.xml is not a sitemap; nothing read`);
  const jobs = icimsJobs(body, host);
  return { jobs, listed: new Set(jobs.map((j) => j.url)) };
}

export const srcIcimsContract = defineContract({
  id: 'src-icims',
  version: '1.1.0',
  description: 'Reads one verified iCIMS company\'s job pages from its portal sitemap, at most forty new or stale pages per day, under the strict page robots rule',
  skills: ['job-sourcing'],
  // Its own team (spec §6): a dead iCIMS portal never opens a breaker for another platform or the ATS sources.
  team: 'sourcing-icims',
  kind: 'io',
  consumes: DiscoveryRequest,
  produces: RawPosting,
  requires: [knownAts],
  capabilities: { http: true, pack: true },
  egress: [ICIMS_EGRESS],
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: ICIMS_TIMEOUT_MS,
  // 429 is never retried (the host is disabled); a retry starts the company again, so at most one.
  retry: { max: 1, on: ['overloaded', 'network'], backoffMs: [8000] },
});

export interface SrcPageOptions {
  readonly hosts: PlatformHosts;
  /** The page state across runs (the daily wiring's app DB); default in memory, this adapter's runs only. */
  readonly state?: PageState;
  /** The day's job pages per board across runs (the daily wiring's app-DB ledger); default in memory, this adapter's runs only. */
  readonly ledger?: PageLedger;
  /** The job-page budget per company per IST day (at most PAGE_MAX_FETCHES). */
  readonly maxPages?: number;
}

async function runCompany(req: DiscoveryRequest, ctx: AgentContext, o: Required<SrcPageOptions>): Promise<RawPosting[]> {
  const http = ctx.http;
  if (!http) throw new KernelError('policy_denied', 'no http capability issued');
  const host = parseIcimsRef(req.slug);
  if (host === null) throw new KernelError('invalid_output', `icims: ${req.slug} is not an iCIMS portal host`);
  const pack = titlePackOf(ctx.pack, 'src-icims');
  try {
    const listing = await fetchIcimsListing(http, o.hosts, host);
    const jobs = prefilter(listing.jobs, pack, req.company, ctx);
    return await readJobPages({ http, hosts: o.hosts, ctx, company: req.company, board: `icims ${host}`, runDate: req.runDate, jobs, listed: listing.listed, state: o.state, max: o.maxPages, ledger: o.ledger, source: 'icims', slug: req.slug, follow: sameHost(host) });
  } catch (e) {
    refusal(e, req.company, ctx);
    return [];
  }
}

/** Builds `src-icims` for one run, on the run's host state (robots.txt cache, disabled hosts) and the page state. */
export function makeSrcIcims(o: SrcPageOptions): Agent<DiscoveryRequest, RawPosting> {
  const opts: Required<SrcPageOptions> = { hosts: o.hosts, state: o.state ?? memoryPageState(), ledger: o.ledger ?? memoryPageLedger(), maxPages: Math.min(o.maxPages ?? PAGE_MAX_FETCHES, PAGE_MAX_FETCHES) };
  return defineAgent(srcIcimsContract, (req, ctx) => (req.ats === 'icims' ? runCompany(req, ctx, opts) : Promise.resolve([])));
}
