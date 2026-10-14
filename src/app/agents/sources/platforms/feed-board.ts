import { defineAgent, type Agent, type AgentContext } from '../../../../kernel/agent.js';
import { defineContract, type Contract } from '../../../../kernel/contract.js';
import { KernelError } from '../../../../kernel/errors.js';
import { hasChallengeMarker, isChallenge } from '../../../challenge.js';
import { DiscoveryRequest, knownAts, RawPosting } from '../../../types.js';
import { finish } from '../common.js';
import { hostRequest, refusal, type HttpTool, type PlatformHosts } from './shared.js';

/** Host state for a DOCUMENTED public API: robots.txt is never asked; the disabled hosts are kept for the run. */
export function documentedHosts(): PlatformHosts<never> {
  const disabled = new Map<string, string>();
  return {
    robots: () => Promise.resolve(null),
    disabledWhy: (host) => disabled.get(host),
    disable(host, why) {
      if (!disabled.has(host)) disabled.set(host, why);
    },
  };
}

/**
 * The small ATS platforms (career-sites spec §4, Task 9: Workable, Recruitee, Teamtailor, Personio, BambooHR, Breezy,
 * Pinpoint, Rippling, Gem) publish a board as ONE feed: one GET returns every open job. `feedBoard(spec)` is the part
 * their adapters and verifier clients share, and nothing more: the request under the run's host rules, the status
 * mapping, the caps, the malformed-entry skip, the refusal mapping, the contract and the agent. Each platform keeps its
 * own endpoint, its own shapes (`parse`) and its own raw posting.
 *
 * The rules, the same for all nine:
 * - **robots.txt.** `hostRequest` with the run's host state (`daily-hosts.ts`). A platform whose feed is its DOCUMENTED
 *   public API (Workable's widget API, Recruitee's Careers Site API, Personio's XML feed, Pinpoint's JSON feed, Gem's Job
 *   Board API; each is described in the vendor's own developer documentation as the way to read a board) is read as
 *   Greenhouse, Lever and Ashby are: robots.txt is not asked, but a 401/403/429 still disables the host for the run. The
 *   other four (Teamtailor's RSS, BambooHR's, Breezy's and Rippling's board JSON, the public pages' own data) are read
 *   under the strict page rule: robots.txt once per host per run, a refusal is the named skip `robots-disallow …`.
 * - **Refusals.** 401/403 (`challenged`) and 429 (`rate_limit`) disable the host for the run, a bot-wall page disables
 *   it (`challenged`); a company on a disabled host is deferred (`input_rejected` `host-disabled:`). Nothing is retried
 *   around, and Retry-After is never read. A 5xx is `overloaded`, a transport retry.
 * - **Pacing.** The honest user agent (the broker's), at least FEED_MIN_INTERVAL_MS between requests to a host, one
 *   feed request per company per run (FEED_MAX_REQUESTS bounds it with robots.txt, for the pacing arithmetic).
 * - **Caps, loud.** None of the nine feeds pages (each answers every job in one response); FEED_MAX_PAGES (10) is the
 *   most list pages a feed adapter may ever ask, which the pacing arithmetic assumes. A feed with more than
 *   FEED_MAX_JOBS jobs is `input_rejected` (`job-cap`), never truncated.
 * - **Shapes.** A response that is not the feed it should be (not JSON or XML, a missing envelope or list) is a
 *   page-level problem: `input_rejected`, nothing read from it, never partially parsed. One entry missing a required
 *   field is skipped with the named note `<platform> <company> entry <i>: <why>`, unless every entry is (schema drift:
 *   `input_rejected`).
 * - **No detail fetches.** The feeds carry the title and the location (the description too, where the platform
 *   publishes it); the adapters never ask a job page.
 */

export const FEED_MIN_INTERVAL_MS = 2000;
export const FEED_MAX_PAGES = 10;
export const FEED_MAX_JOBS = 5000;
/** robots.txt and the feed pages: the pacing check divides the step timeout by it. */
export const FEED_MAX_REQUESTS = 1 + FEED_MAX_PAGES;
export const FEED_TIMEOUT_MS = 300_000;
/** A 2xx this small that fails to parse and carries a bot-wall marker is a challenge page. */
const CHALLENGE_MAX_BYTES = 32 * 1024;

/** What a feed's parser returns: the postings, and a named reason per entry it skipped. */
export interface FeedPage {
  readonly postings: RawPosting[];
  /** `entry <i>: <why>` for each entry skipped. */
  readonly malformed: string[];
  /** Entries the feed listed, malformed ones included. */
  readonly listed: number;
  /** Every distinct company name the feed carries, sorted (the verifier compares it). */
  readonly names: readonly string[];
  /** The platform's own total, where it states one (BambooHR `meta.totalCount`); null otherwise. */
  readonly total: number | null;
}

export interface FeedSpec<B> {
  /** The Ats / source name, `workable`. */
  readonly platform: string;
  /** The vendor name for messages and descriptions. */
  readonly label: string;
  readonly team: string;
  readonly egress: string;
  /** Whether the feed is the platform's documented public API (no robots.txt; see the header). */
  readonly documented: boolean;
  /** The one host every board of the platform is read from (verifier egress); null when each board has its own. */
  readonly fixedHost: string | null;
  readonly parseRef: (ref: string) => B | null;
  readonly refOf: (b: B) => string;
  readonly hostOf: (b: B) => string;
  readonly urlOf: (b: B) => string;
  /** The board of a stored board URL (the registry's board_url); null when it is not one. */
  readonly boardOfUrl: (boardUrl: string) => B | null;
  /** The part of the board to compare with the company name when the feed names none (Personio: the host's first label); absent: the slug. */
  readonly nameKey?: (b: B) => string | null;
  /** Teamtailor: the one alternative Accept the broker allows. */
  readonly accept?: 'application/rss+xml';
  /** Parses a 2xx body; throws `input_rejected` for a page-level shape problem. */
  readonly parse: (body: string, b: B, req: Pick<DiscoveryRequest, 'company' | 'slug'>) => FeedPage;
}

/** A page-level problem of a feed: `input_rejected`, nothing read. */
export const feedProblem = (what: string, why: string): KernelError => new KernelError('input_rejected', `${what}: ${why}; nothing read from it`);

/** The first line of a zod error as a reason (`jobs: Required`). */
export function zodWhy(e: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  const first = e.issues[0];
  return first === undefined ? 'invalid' : `${first.path.map(String).join('.') || 'root'}: ${first.message}`;
}

export interface FeedBoard<B> {
  readonly spec: FeedSpec<B>;
  readonly contract: Contract<DiscoveryRequest, RawPosting>;
  /** One feed request under the run's host rules, parsed; throws as the header says. */
  fetchFeed(http: HttpTool, hosts: PlatformHosts, b: B, req: Pick<DiscoveryRequest, 'company' | 'slug'>, timeoutMs?: number): Promise<FeedPage>;
  /** Builds the agent for one run on the run's host state. */
  make(o: { readonly hosts: PlatformHosts }): Agent<DiscoveryRequest, RawPosting>;
}

export function feedBoard<B>(spec: FeedSpec<B>): FeedBoard<B> {
  const contract = defineContract({
    id: `src-${spec.platform}`,
    version: '1.0.0',
    description: `Reads one verified ${spec.label} company's whole job feed in one request, ${spec.documented ? 'its documented public API' : 'under the strict page robots rule'}, at least two seconds apart, nothing beyond the feed`,
    skills: ['job-sourcing'],
    // Its own team (spec §6): a dead tenant on this platform never opens a breaker for another platform or the ATS sources.
    team: spec.team,
    kind: 'io',
    consumes: DiscoveryRequest,
    produces: RawPosting,
    requires: [knownAts],
    capabilities: { http: true },
    egress: [spec.egress],
    dataClasses: { in: ['P0'], out: ['P0'] },
    budget: { usdPerCall: 0, usdPerRun: 0 },
    timeoutMs: FEED_TIMEOUT_MS,
    // 429 is never retried (the host is disabled); a retry starts the company again, so at most one.
    retry: { max: 1, on: ['overloaded', 'network'], backoffMs: [8000] },
  });

  async function fetchFeed(http: HttpTool, hosts: PlatformHosts, b: B, req: Pick<DiscoveryRequest, 'company' | 'slug'>, timeoutMs?: number): Promise<FeedPage> {
    const url = spec.urlOf(b);
    const host = spec.hostOf(b);
    const ref = spec.refOf(b);
    const opts = { minIntervalMs: FEED_MIN_INTERVAL_MS, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(spec.accept === undefined ? {} : { accept: spec.accept }) };
    const r = await hostRequest(http, hosts, host, url, () => http.getPage(url, opts));
    if (isChallenge(r.status, r.body)) {
      hosts.disable(host, 'challenge');
      throw new KernelError('challenged', `${host} answered with a challenge page (${r.status}): the host is disabled for this run, never retried around`);
    }
    if (r.status === 429) {
      hosts.disable(host, 'http-429');
      throw new KernelError('rate_limit', `429 from ${host}: the host is disabled for this run, never retried around`);
    }
    if (r.status >= 500) throw new KernelError('overloaded', `${r.status} from ${host}`);
    if (r.status === 404 || r.status === 410) throw new KernelError('gone', `${spec.label} board not found: ${ref}`);
    if (r.status >= 300 && r.status < 400) {
      let to = 'nowhere';
      try {
        to = r.location === null ? to : new URL(r.location, url).hostname;
      } catch {
        to = 'an invalid Location';
      }
      throw feedProblem(`${spec.label} ${ref}`, `the feed redirected (${r.status} to ${to}), a redirect is never followed`);
    }
    if (r.status < 200 || r.status >= 300) throw feedProblem(`${spec.label} ${ref}`, `${host} returned ${r.status}`);
    let page: FeedPage;
    try {
      page = spec.parse(r.body, b, req);
    } catch (e) {
      if (e instanceof KernelError && e.code === 'input_rejected' && r.body.length <= CHALLENGE_MAX_BYTES && hasChallengeMarker(r.body)) {
        hosts.disable(host, 'challenge');
        throw new KernelError('challenged', `${host} answered with a challenge page (${r.status}): the host is disabled for this run, never retried around`);
      }
      throw e;
    }
    if (page.listed > FEED_MAX_JOBS) throw new KernelError('input_rejected', `job-cap ${spec.label} ${ref}: the feed lists ${page.listed} jobs, over the cap of ${FEED_MAX_JOBS}; nothing read, never truncated`);
    if (page.listed > 0 && page.postings.length === 0) throw feedProblem(`${spec.label} ${ref}`, `all ${page.listed} entries are malformed (${page.malformed[0] ?? ''})`);
    return page;
  }

  async function runCompany(req: DiscoveryRequest, ctx: AgentContext, hosts: PlatformHosts): Promise<RawPosting[]> {
    const http = ctx.http;
    if (!http) throw new KernelError('policy_denied', 'no http capability issued');
    const b = spec.parseRef(req.slug);
    if (b === null) throw new KernelError('invalid_output', `${spec.platform}: ${req.slug} is not a ${spec.label} board`);
    try {
      const page = await fetchFeed(http, hosts, b, req);
      if (page.malformed.length > 0) ctx.skipped(page.malformed.map((m) => `${spec.platform} ${req.company} ${m}`));
      if (page.total !== null && page.total > page.listed) ctx.skipped([`short-list ${req.company}: total ${page.total}, listed ${page.listed}`]);
      return finish(page.postings);
    } catch (e) {
      refusal(e, req.company, ctx);
      return [];
    }
  }

  return {
    spec,
    contract,
    fetchFeed,
    make: (o) => defineAgent(contract, (req, ctx) => (req.ats === spec.platform ? runCompany(req, ctx, o.hosts) : Promise.resolve([]))),
  };
}

// ---------------------------------------------------------------------------
// Helpers the platform parsers share
// ---------------------------------------------------------------------------

/** A board URL as a URL when it is plain `https` (no port, no credentials, no fragment worth reading); else null. */
export function plainHttps(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.port === '' && u.username === '' && u.password === '' ? u : null;
  } catch {
    return null;
  }
}

/** Parses a JSON body; a body that is not JSON is a page-level problem. */
export function jsonBody(body: string, what: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw feedProblem(what, 'the response is not JSON');
  }
}

/** A trimmed non-blank string, else null. */
export const textOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** `https://…` only (a posting URL the platform gave); null otherwise. */
export function httpsUrl(v: unknown): string | null {
  const t = textOf(v);
  if (t === null) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

export const sortedNames = (names: Iterable<string | null>): string[] => [...new Set([...names].filter((n): n is string => n !== null))].sort();
