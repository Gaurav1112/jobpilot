import { defineAgent, type Agent, type AgentContext } from '../../../../kernel/agent.js';
import { defineContract, type Contract } from '../../../../kernel/contract.js';
import { KernelError } from '../../../../kernel/errors.js';
import { DiscoveryRequest, knownAts, RawPosting } from '../../../types.js';
import type { SrcPageOptions } from './icims.js';
import { getListing, memoryPageState, PAGE_MAX_FETCHES, PAGE_MAX_HOPS, prefilter, readJobPages, type ListedJob, type PageListing } from './pages.js';
import { DEFAULT_RESIDENCE, type ResidenceScope } from '../../../geo/residence.js';
import { memoryPageLedger, namesOffice, namesResidence, refusal, residenceOf, titlePackOf, type HttpTool, type PlatformHosts } from './shared.js';

/**
 * The adapter JazzHR and Freshteam share (sources-expansion plan, Task 2). Both publish a server-rendered LISTING that
 * names every open job with its location, and a job page with a schema.org `JobPosting` JSON-LD block (freehire
 * `jazzhr.go`, `freshteam.go` at 3957f7b, MIT, read as a reference). Neither has a documented public API, so the strict
 * page rule of `pages.ts` applies, and both reuse `readJobPages` (budget PAGE_MAX_FETCHES per company per IST day,
 * rotation, keep-alive, `no-jobposting`, `detail-gone`).
 *
 * The platforms have no server-side filter, so the India/remote scope is applied to the LISTING (`scopeListed`), before
 * any job page is asked; the jobs left out are counted in one named note, never silently.
 */

/** A job a listing names, with the listing's own location words (null: the card names none). */
export interface ScopedJob extends ListedJob {
  readonly location: string | null;
  /** The listing's structured remote flag (Freshteam `data-portal-remote-location`); null: none. */
  readonly remote: boolean | null;
}

/** A remote word in a card's location ("Remote", "Remote - India", "Work from home"), word-bounded. */
export const REMOTE_WORD = /\b(?:remote|work\s+from\s+home|wfh|anywhere)\b/iu;

/**
 * The listing-level scope: a job is kept when its card names the residence country (`namesResidence`; India by default), one of the pack's office cities
 * (`namesOffice`), says remote (the flag, or REMOTE_WORD), or names no location at all (uncertain: its page decides).
 * The rest are counted in ONE named note `not-<token> <company>: N of M listed jobs outside <Country> and not remote (not
 * fetched)`. Order kept.
 */
export function scopeListed(jobs: readonly ScopedJob[], officeCities: readonly string[], company: string, ctx: AgentContext, scope: ResidenceScope = DEFAULT_RESIDENCE): ScopedJob[] {
  const kept = jobs.filter((j) => j.location === null || j.remote === true || REMOTE_WORD.test(j.location) || namesResidence(j.location, scope) || namesOffice(j.location, officeCities, scope));
  const out = jobs.length - kept.length;
  if (out > 0) ctx.skipped([`not-${scope.token} ${company}: ${out} of ${jobs.length} listed jobs outside ${scope.display} and not remote (not fetched)`]);
  return kept;
}

/** What a listing-pages platform supplies; everything else (requests, budget, state, refusals) is shared. */
export interface ListingPagesSpec {
  readonly platform: 'jazzhr' | 'freshteam';
  readonly label: string;
  readonly team: string;
  readonly egress: string;
  readonly parseRef: (ref: string) => string | null;
  readonly hostOf: (slug: string) => string;
  readonly boardOfUrl: (boardUrl: string) => string | null;
  /** The listing URL of page `n` (1-based). */
  readonly listingUrl: (slug: string, n: number) => string;
  /** A listing page that holds none of this is not a listing (a challenge page is told apart by it). */
  readonly marker: string;
  /** Linear-time parse of listing page `n`: its jobs, and whether the page links a next page. */
  readonly parseListing: (html: string, slug: string, n: number) => { readonly jobs: ScopedJob[]; readonly next: boolean };
  /** Listing pages read at most (JazzHR 1: one page names every job; Freshteam LISTING_MAX_PAGES). */
  readonly maxListingPages: number;
}

/** Listing pages per company at most; a listing that still links a next page after it is `input_rejected` `listing-cap`. */
export const LISTING_MAX_PAGES = 5;
/** A listing page larger than this is refused (`input_rejected`), never parsed. */
export const LISTING_MAX_BYTES = 4 * 1024 * 1024;
export const LISTING_TIMEOUT_MS = 900_000;
/** robots.txt, the listing pages, and every job page with its redirects. */
export const LISTING_MAX_REQUESTS = 1 + LISTING_MAX_PAGES + PAGE_MAX_FETCHES * (1 + PAGE_MAX_HOPS);

export interface ListingPagesBoard {
  readonly spec: ListingPagesSpec;
  readonly contract: Contract<DiscoveryRequest, RawPosting>;
  /** Every listing page (robots.txt first, 2 s apart), as the board's jobs: the verifier's read and the adapter's. */
  fetchListing(http: HttpTool, hosts: PlatformHosts, slug: string, timeoutMs?: number): Promise<PageListing & { readonly jobs: readonly ScopedJob[] }>;
  make(o: SrcPageOptions): Agent<DiscoveryRequest, RawPosting>;
}

const sameHost = (host: string) => (u: URL): boolean => u.hostname.toLowerCase() === host;

export function listingPagesBoard(spec: ListingPagesSpec): ListingPagesBoard {
  const contract = defineContract({
    id: `src-${spec.platform}`,
    version: '1.0.0',
    description: `Reads one verified ${spec.label} company's India or remote job pages from its listing, at most forty new or stale pages per day, under the strict page robots rule`,
    skills: ['job-sourcing'],
    // Its own team (spec §6): a dead tenant never opens a breaker for another platform.
    team: spec.team,
    kind: 'io',
    consumes: DiscoveryRequest,
    produces: RawPosting,
    requires: [knownAts],
    capabilities: { http: true, pack: true },
    egress: [spec.egress],
    dataClasses: { in: ['P0'], out: ['P0'] },
    budget: { usdPerCall: 0, usdPerRun: 0 },
    timeoutMs: LISTING_TIMEOUT_MS,
    // 429 is never retried (the host is disabled); a retry starts the company again, so at most one.
    retry: { max: 1, on: ['overloaded', 'network'], backoffMs: [8000] },
  });

  async function fetchListing(http: HttpTool, hosts: PlatformHosts, slug: string, timeoutMs?: number): Promise<PageListing & { readonly jobs: readonly ScopedJob[] }> {
    const host = spec.hostOf(slug);
    const what = `${spec.label} ${slug}`;
    const seen = new Map<string, ScopedJob>();
    for (let n = 1; n <= spec.maxListingPages; n++) {
      const { body } = await getListing(http, hosts, spec.listingUrl(slug, n), what, sameHost(host), (b) => b.includes(spec.marker), timeoutMs);
      if (body.length > LISTING_MAX_BYTES) throw new KernelError('input_rejected', `${what}: listing page ${n} is larger than ${LISTING_MAX_BYTES} bytes; nothing read`);
      const page = spec.parseListing(body, slug, n);
      let fresh = 0;
      for (const j of page.jobs) {
        if (seen.has(j.sourceId)) continue;
        seen.set(j.sourceId, j);
        fresh++;
      }
      if (!page.next || fresh === 0) break;
      if (n === spec.maxListingPages) throw new KernelError('input_rejected', `listing-cap ${what}: still more pages after ${n}; nothing read, never truncated`);
    }
    const jobs = [...seen.values()];
    return { jobs, listed: new Set(jobs.map((j) => j.url)) };
  }

  async function runCompany(req: DiscoveryRequest, ctx: AgentContext, o: Required<SrcPageOptions>): Promise<RawPosting[]> {
    const http = ctx.http;
    if (!http) throw new KernelError('policy_denied', 'no http capability issued');
    const slug = spec.parseRef(req.slug);
    if (slug === null) throw new KernelError('invalid_output', `${spec.platform}: ${req.slug} is not a ${spec.label} board`);
    const host = spec.hostOf(slug);
    const pack = titlePackOf(ctx.pack, contract.id);
    try {
      const listing = await fetchListing(http, o.hosts, slug);
      const scoped = scopeListed(listing.jobs, pack.eligibility?.officeCities ?? [], req.company, ctx, residenceOf(pack, contract.id));
      const jobs = prefilter(scoped, pack, req.company, ctx);
      return await readJobPages({ http, hosts: o.hosts, ctx, company: req.company, board: `${spec.platform} ${slug}`, runDate: req.runDate, jobs, listed: listing.listed, state: o.state, max: o.maxPages, ledger: o.ledger, source: spec.platform, slug: req.slug, follow: sameHost(host) });
    } catch (e) {
      refusal(e, req.company, ctx);
      return [];
    }
  }

  function make(o: SrcPageOptions): Agent<DiscoveryRequest, RawPosting> {
    const opts: Required<SrcPageOptions> = { hosts: o.hosts, state: o.state ?? memoryPageState(), ledger: o.ledger ?? memoryPageLedger(), maxPages: Math.min(o.maxPages ?? PAGE_MAX_FETCHES, PAGE_MAX_FETCHES) };
    return defineAgent(contract, (req, ctx) => (req.ats === spec.platform ? runCompany(req, ctx, opts) : Promise.resolve([])));
  }

  return { spec, contract, fetchListing, make };
}
