import { defineAgent, type Agent, type AgentContext } from '../../../../kernel/agent.js';
import { defineContract } from '../../../../kernel/contract.js';
import { KernelError } from '../../../../kernel/errors.js';
import { isSitemapIndex, sitemapLocs } from '../../../text/sitemap.js';
import { DiscoveryRequest, knownAts, RawPosting } from '../../../types.js';
import { careersSourceId } from '../careers.js';
import { getListing, looksLikeSitemap, memoryPageState, PAGE_MAX_FETCHES, PAGE_MAX_HOPS, prefilter, readJobPages, slugTitle, type ListedJob, type PageListing } from './pages.js';
import { memoryPageLedger, refusal, titlePackOf, type HttpTool, type PlatformHosts } from './shared.js';
import type { SrcPageOptions } from './icims.js';

/**
 * The generic `jsonld-sitemap` adapter (career-sites spec §4, Task 8): an in-house careers site with no ATS signature
 * whose job pages carry JobPosting JSON-LD (the platform detector's `jsonld-sitemap` verdict, e.g. Okta's
 * `www.okta.com`). Plain HTTP, no browser, under the strict page rule of `pages.ts`.
 *
 * A board is `<host>` or `<host><path prefix>` (its ref, the DiscoveryRequest slug). The detector stores the host (slug)
 * and `https://<host>/sitemap.xml` (board URL); a registry slug that carries a path prefix on the same host
 * (`www.acme.test/careers/jobs/`) narrows the job URLs to it.
 *
 * **Listing:** `https://<host>/sitemap.xml`; when that is gone (404/410), the `Sitemap:` URLs robots.txt names on the
 * same host, in file order, the first that answers. A sitemap index is followed on the same host, breadth first: its
 * child sitemaps whose path names careers or jobs (`career`, `job`) when there are any, else every child. Every sitemap
 * request counts toward JSONLD_LISTING_MAX_REQUESTS per company per run; an index needing more is refused loudly before
 * any child is read (`listing-cap`, `input_rejected`), never truncated. No sitemap at all is refused by name.
 *
 * **The job-URL rule (controller decision 7, documented):** a `<loc>` on the board's host (https) is a job page when
 * - with a stored prefix: its path starts with the prefix and goes on after it; else
 * - its path has a segment `careers`, `career`, `jobs`, `job`, `positions`, `position`, `openings`, `vacancies` or
 *   `opportunities` (any case) with at least one segment after it;
 * - and in both cases, its last segment holds a digit or a hyphen: a job slug (`principal-software-engineer-7781674`),
 *   not a section name (`/company/careers/ga/`, `/jobs/`).
 * A page this admits that is not a job (a hyphenated section page) has no JobPosting: named once (`no-jobposting`) and
 * not fetched again within the week. Its title for the pre-filter is the last segment's words; its sourceId
 * `careersSourceId(url)` (sha256 of the URL without query or fragment, 16 hex).
 *
 * **Job pages:** budget, rotation, keep-alive and the JSON-LD check of `pages.ts`; redirects followed on the same host
 * (Okta moves `/company/careers/<slug>/` to `/company/careers/rd/<slug>/`, seen live). `raw` (normalizer mapper
 * `jsonld-sitemap`, the careers JSON-LD mapping): `{ url, title, jsonLd }`.
 */

export const JSONLD_EGRESS = 'registry:jsonld-hosts';
export const JSONLD_TIMEOUT_MS = 900_000;
/** Sitemap requests (the first, robots.txt's, an index's children) per company per run. */
export const JSONLD_LISTING_MAX_REQUESTS = 10;
/** robots.txt, the sitemaps, and every job page with its redirects. */
export const JSONLD_MAX_REQUESTS = 1 + JSONLD_LISTING_MAX_REQUESTS + PAGE_MAX_FETCHES * (1 + PAGE_MAX_HOPS);

export interface JsonLdBoard {
  readonly host: string;
  /** A path prefix the job URLs must start with (`/careers/jobs/`); null: the default rule. */
  readonly prefix: string | null;
}

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;
const PREFIX = /^\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]{0,200}$/u;

/** `<host>` or `<host>/<prefix>` → the board; null when it is not one. */
export function parseJsonLdRef(ref: string): JsonLdBoard | null {
  const slash = ref.indexOf('/');
  const host = slash < 0 ? ref : ref.slice(0, slash);
  const prefix = slash < 0 ? null : ref.slice(slash);
  if (!HOST.test(host) || (prefix !== null && (!PREFIX.test(prefix) || prefix === '/'))) return null;
  return { host, prefix };
}

export const jsonLdRef = (b: JsonLdBoard): string => `${b.host}${b.prefix ?? ''}`;

/** The host of a stored board URL (the detector's `https://<host>/sitemap.xml`). */
export function jsonLdBoardOfUrl(boardUrl: string): string | null {
  try {
    const u = new URL(boardUrl);
    return u.protocol === 'https:' && u.port === '' && HOST.test(u.hostname.toLowerCase()) ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

const JOB_WORDS: ReadonlySet<string> = new Set(['careers', 'career', 'jobs', 'job', 'positions', 'position', 'openings', 'vacancies', 'opportunities']);

/** The job URLs among a sitemap's `<loc>`s (the rule in the header), in sitemap order, deduplicated. */
export function jsonLdJobUrls(locs: readonly string[], b: JsonLdBoard): ListedJob[] {
  const out: ListedJob[] = [];
  const seen = new Set<string>();
  for (const loc of locs) {
    let u: URL;
    try {
      u = new URL(loc);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' || u.port !== '' || u.hostname.toLowerCase() !== b.host) continue;
    const segs = u.pathname.split('/').filter((s) => s !== '');
    const last = segs[segs.length - 1] ?? '';
    if (!/[\d-]/u.test(last)) continue;
    if (b.prefix !== null) {
      if (!u.pathname.startsWith(b.prefix) || u.pathname.length <= b.prefix.length) continue;
    } else {
      const i = segs.findIndex((s) => JOB_WORDS.has(s.toLowerCase()));
      if (i < 0 || i >= segs.length - 1) continue;
    }
    u.search = '';
    u.hash = '';
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({ url: u.href, title: slugTitle(last), sourceId: careersSourceId(u.href), fetchUrl: u.href });
  }
  return out;
}

const sameHost = (host: string) => (u: URL): boolean => u.hostname.toLowerCase() === host;
const onHost = (host: string, url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.port === '' && u.hostname.toLowerCase() === host;
  } catch {
    return false;
  }
};

/** The board's sitemaps (see the header), as its jobs. */
export async function fetchJsonLdListing(http: HttpTool, hosts: PlatformHosts, b: JsonLdBoard, company: string, timeoutMs?: number): Promise<PageListing> {
  const what = `jsonld-sitemap ${company}`;
  let requests = 0;
  const read = async (url: string): Promise<{ url: string; body: string } | null> => {
    requests++;
    try {
      return await getListing(http, hosts, url, what, sameHost(b.host), looksLikeSitemap, timeoutMs);
    } catch (e) {
      if (e instanceof KernelError && e.code === 'gone') return null;
      throw e;
    }
  };
  let first = await read(`https://${b.host}/sitemap.xml`);
  if (first === null) {
    const named = ((await hosts.sitemaps?.(b.host, http)) ?? []).filter((s) => onHost(b.host, s) && new URL(s).pathname !== '/sitemap.xml');
    for (const s of named) {
      if (requests >= JSONLD_LISTING_MAX_REQUESTS) throw new KernelError('input_rejected', `listing-cap ${company}: robots.txt names more sitemaps than ${JSONLD_LISTING_MAX_REQUESTS} requests reach, none answered; nothing read`);
      first = await read(s);
      if (first !== null) break;
    }
  }
  if (first === null) throw new KernelError('input_rejected', `${what}: no sitemap (/sitemap.xml answered 404 or 410, and robots.txt names none on ${b.host} that answers); nothing read`);
  const locs: string[] = [];
  const queue = [first];
  for (let doc = queue.shift(); doc !== undefined; doc = queue.shift()) {
    if (!isSitemapIndex(doc.body)) {
      locs.push(...sitemapLocs(doc.body));
      continue;
    }
    const children = sitemapLocs(doc.body).filter((c) => onHost(b.host, c));
    const jobish = children.filter((c) => /career|job/iu.test(new URL(c).pathname));
    const next = jobish.length > 0 ? jobish : children;
    if (requests + next.length > JSONLD_LISTING_MAX_REQUESTS) {
      throw new KernelError('input_rejected', `listing-cap ${company}: the sitemap index ${new URL(doc.url).pathname} needs ${next.length} more sitemap requests, over ${JSONLD_LISTING_MAX_REQUESTS} per run; nothing read, never truncated`);
    }
    for (const c of next) {
      const d = await read(c);
      if (d === null) throw new KernelError('gone', `${what}: the sitemap ${c} answered 404 or 410`);
      queue.push(d);
    }
  }
  const jobs = jsonLdJobUrls(locs, b);
  return { jobs, listed: new Set(jobs.map((j) => j.url)) };
}

export const srcJsonLdContract = defineContract({
  id: 'src-jsonld-sitemap',
  version: '1.4.0',
  description: 'Reads one verified in-house careers site\'s JobPosting pages from its sitemap, at most forty new or stale pages per day, under the strict page robots rule',
  skills: ['job-sourcing'],
  team: 'sourcing-jsonld',
  kind: 'io',
  consumes: DiscoveryRequest,
  produces: RawPosting,
  requires: [knownAts],
  capabilities: { http: true, pack: true },
  egress: [JSONLD_EGRESS],
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: JSONLD_TIMEOUT_MS,
  retry: { max: 1, on: ['overloaded', 'network'], backoffMs: [8000] },
});

async function runCompany(req: DiscoveryRequest, ctx: AgentContext, o: Required<SrcPageOptions>): Promise<RawPosting[]> {
  const http = ctx.http;
  if (!http) throw new KernelError('policy_denied', 'no http capability issued');
  const b = parseJsonLdRef(req.slug);
  if (b === null) throw new KernelError('invalid_output', `jsonld-sitemap: ${req.slug} is not <host> or <host>/<path prefix>`);
  const pack = titlePackOf(ctx.pack, 'src-jsonld-sitemap');
  try {
    const listing = await fetchJsonLdListing(http, o.hosts, b, req.company);
    const jobs = prefilter(listing.jobs, pack, req.company, ctx);
    return await readJobPages({ http, hosts: o.hosts, ctx, company: req.company, board: `jsonld-sitemap ${jsonLdRef(b)}`, runDate: req.runDate, jobs, listed: listing.listed, state: o.state, max: o.maxPages, ledger: o.ledger, source: 'jsonld-sitemap', slug: req.slug, follow: sameHost(b.host) });
  } catch (e) {
    refusal(e, req.company, ctx);
    return [];
  }
}

/** Builds `src-jsonld-sitemap` for one run, on the run's host state and the page state. */
export function makeSrcJsonLd(o: SrcPageOptions): Agent<DiscoveryRequest, RawPosting> {
  const opts: Required<SrcPageOptions> = { hosts: o.hosts, state: o.state ?? memoryPageState(), ledger: o.ledger ?? memoryPageLedger(), maxPages: Math.min(o.maxPages ?? PAGE_MAX_FETCHES, PAGE_MAX_FETCHES) };
  return defineAgent(srcJsonLdContract, (req, ctx) => (req.ats === 'jsonld-sitemap' ? runCompany(req, ctx, opts) : Promise.resolve([])));
}
