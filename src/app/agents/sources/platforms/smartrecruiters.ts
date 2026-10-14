import { defineAgent, type Agent, type AgentContext } from '../../../../kernel/agent.js';
import { defineContract } from '../../../../kernel/contract.js';
import { KernelError } from '../../../../kernel/errors.js';
import { decodeEntities } from '../../../text/html.js';
import { DiscoveryRequest, knownAts, RawPosting } from '../../../types.js';
import { anchorHrefs, getListing, memoryPageState, PAGE_MAX_FETCHES, PAGE_MAX_HOPS, prefilter, readJobPages, slugTitle, type ListedJob, type PageListing } from './pages.js';
import { memoryPageLedger, refusal, titlePackOf, type HttpTool, type PlatformHosts } from './shared.js';
import type { SrcPageOptions } from './icims.js';

/**
 * SmartRecruiters job pages (career-sites spec §4 and D3, Task 8): the daily adapter for every verified registry company
 * on SmartRecruiters (Bosch, `BoschGroup`), and the code the verifier's SmartRecruiters client shares.
 *
 * The SmartRecruiters Posting API is NEVER used: its host's robots.txt admits only LinkedInBot (spec D3; a test greps
 * `src/` for that host name). Only the public pages on SR_HOSTS are read, as robots.txt allows, under the strict page
 * rule of `pages.ts`:
 * - **Listing:** `GET https://jobs.smartrecruiters.com/<CompanyId>` (the ref, the company id, its case kept). A
 *   redirect to the same company on `careers.smartrecruiters.com` is followed, after that host's robots.txt. Seen live
 *   (2026-10-14): Bosch's listing answers 301 to `careers.smartrecruiters.com/BoschGroup`, whose robots.txt answers 302
 *   to another host: under the project's robots rule (a robots.txt redirected to another host is unavailable, the
 *   coverage gate's rule since Task 3) that host is `robots-unavailable`, so Bosch is the named skip
 *   `robots-disallow careers.smartrecruiters.com: Bosch not read today (robots-unavailable)` every day, nothing read.
 *   A listing page that is read gives its job links `https://jobs.smartrecruiters.com/<CompanyId>/<id>-<slug>` (the
 *   numeric id the sourceId, the slug's words the pre-filter title). A listing that links a further page of itself
 *   (`?page=`, `offset=`) is refused loudly (`listing-paged`, `input_rejected`): this build reads one page, never a
 *   silent first page. No listing page has been seen live (robots), so this parse is checked on a fixture only.
 * - **Job pages:** each job link on `jobs.smartrecruiters.com`, its JobPosting JSON-LD; budget, rotation and keep-alive
 *   as `pages.ts`. Seen live: Bosch's job page carries schema.org MICRODATA, not JSON-LD, so it is the named skip
 *   `no-jobposting …: no JobPosting JSON-LD`, never parsed by guesswork.
 * - `raw` (normalizer mapper `smartrecruiters`, the careers JSON-LD mapping): `{ url, title, jsonLd }`.
 */

export const SR_EGRESS = 'registry:smartrecruiters-hosts';
/** The only SmartRecruiters hosts read: the public job pages (sorted). */
export const SR_HOSTS: readonly string[] = ['careers.smartrecruiters.com', 'jobs.smartrecruiters.com'];
const JOBS_HOST = 'jobs.smartrecruiters.com';
export const SR_TIMEOUT_MS = 900_000;
/** Both hosts' robots.txt, the listing (one redirect), and every job page with its redirects. */
export const SR_MAX_REQUESTS = 4 + PAGE_MAX_FETCHES * (1 + PAGE_MAX_HOPS);

const COMPANY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
const RESERVED = new Set(['api', 'oneclick-ui', 'sr-jobs', 'robots.txt', 'sitemap.xml']);

/** The company id of a ref; null when it is not one. */
export function parseSmartRecruitersRef(ref: string): string | null {
  return COMPANY.test(ref) && !RESERVED.has(ref.toLowerCase()) ? ref : null;
}

/** The company id of a stored board URL (`https://jobs.smartrecruiters.com/<CompanyId>`). */
export function smartRecruitersBoardOfUrl(boardUrl: string): string | null {
  try {
    const u = new URL(boardUrl);
    if (u.protocol !== 'https:' || u.port !== '' || !SR_HOSTS.includes(u.hostname.toLowerCase())) return null;
    const p = u.pathname.split('/').filter((x) => x !== '');
    return p.length === 1 ? parseSmartRecruitersRef(p[0] as string) : null;
  } catch {
    return null;
  }
}

export const srListingUrl = (company: string): string => `https://${JOBS_HOST}/${company}`;

const onSr = (u: URL): boolean => SR_HOSTS.includes(u.hostname.toLowerCase());
const onJobs = (u: URL): boolean => u.hostname.toLowerCase() === JOBS_HOST;

/**
 * The company's job links on a listing page, in page order, deduplicated (`/<CompanyId>/<id>-<slug>` on
 * jobs.smartrecruiters.com, the company id compared without case). A link to a further page of the listing is refused.
 */
export function srJobs(html: string, company: string, pageUrl: string): PageListing {
  const out: ListedJob[] = [];
  const seen = new Set<string>();
  const co = company.toLowerCase();
  for (const href of anchorHrefs(html)) {
    let u: URL;
    try {
      u = new URL(decodeEntities(href), pageUrl);
    } catch {
      continue;
    }
    if (!onSr(u)) continue;
    const p = u.pathname.split('/').filter((x) => x !== '');
    if ((p[0] ?? '').toLowerCase() !== co) continue;
    if (p.length === 1 && (u.searchParams.has('page') || u.searchParams.has('offset'))) {
      throw new KernelError('input_rejected', `listing-paged ${company}: the listing links a further page (${u.pathname}${u.search}), which this build does not follow; nothing read`);
    }
    const m = p.length === 2 && onJobs(u) ? /^(\d{6,20})-(.+)$/u.exec(p[1] as string) : null;
    if (m === null) continue;
    const url = `https://${JOBS_HOST}/${p[0]}/${p[1]}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: slugTitle(m[2] as string), sourceId: m[1] as string, fetchUrl: url });
  }
  return { jobs: out, listed: seen };
}

/** The company's listing (robots.txt first; one redirect to careers.smartrecruiters.com, after its robots.txt), as its jobs. */
export async function fetchSrListing(http: HttpTool, hosts: PlatformHosts, company: string, timeoutMs?: number): Promise<PageListing> {
  const sameCompany = (u: URL): boolean => onSr(u) && u.pathname.split('/').filter((x) => x !== '')[0]?.toLowerCase() === company.toLowerCase();
  // a listing's expected content is a job link of the company (for the challenge check)
  const marker = `/${company.toLowerCase()}/`;
  const hasJobLink = (body: string): boolean => anchorHrefs(body).some((h) => h.toLowerCase().includes(marker));
  const page = await getListing(http, hosts, srListingUrl(company), `smartrecruiters ${company}`, sameCompany, hasJobLink, timeoutMs);
  return srJobs(page.body, company, page.url);
}

export const srcSmartRecruitersContract = defineContract({
  id: 'src-smartrecruiters',
  version: '1.1.0',
  description: 'Reads one verified SmartRecruiters company\'s public job pages from its listing, never the posting API, at most forty new or stale pages per day',
  skills: ['job-sourcing'],
  team: 'sourcing-smartrecruiters',
  kind: 'io',
  consumes: DiscoveryRequest,
  produces: RawPosting,
  requires: [knownAts],
  capabilities: { http: true, pack: true },
  egress: [SR_EGRESS],
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: SR_TIMEOUT_MS,
  retry: { max: 1, on: ['overloaded', 'network'], backoffMs: [8000] },
});

async function runCompany(req: DiscoveryRequest, ctx: AgentContext, o: Required<SrcPageOptions>): Promise<RawPosting[]> {
  const http = ctx.http;
  if (!http) throw new KernelError('policy_denied', 'no http capability issued');
  const company = parseSmartRecruitersRef(req.slug);
  if (company === null) throw new KernelError('invalid_output', `smartrecruiters: ${req.slug} is not a company id`);
  const pack = titlePackOf(ctx.pack, 'src-smartrecruiters');
  try {
    const listing = await fetchSrListing(http, o.hosts, company);
    const jobs = prefilter(listing.jobs, pack, req.company, ctx);
    return await readJobPages({ http, hosts: o.hosts, ctx, company: req.company, board: `smartrecruiters ${company}`, runDate: req.runDate, jobs, listed: listing.listed, state: o.state, max: o.maxPages, ledger: o.ledger, source: 'smartrecruiters', slug: req.slug, follow: onJobs });
  } catch (e) {
    refusal(e, req.company, ctx);
    return [];
  }
}

/** Builds `src-smartrecruiters` for one run, on the run's host state and the page state. */
export function makeSrcSmartRecruiters(o: SrcPageOptions): Agent<DiscoveryRequest, RawPosting> {
  const opts: Required<SrcPageOptions> = { hosts: o.hosts, state: o.state ?? memoryPageState(), ledger: o.ledger ?? memoryPageLedger(), maxPages: Math.min(o.maxPages ?? PAGE_MAX_FETCHES, PAGE_MAX_FETCHES) };
  return defineAgent(srcSmartRecruitersContract, (req, ctx) => (req.ats === 'smartrecruiters' ? runCompany(req, ctx, opts) : Promise.resolve([])));
}
