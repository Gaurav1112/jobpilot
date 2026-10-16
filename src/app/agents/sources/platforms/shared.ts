import { z } from 'zod';
import type { AgentContext } from '../../../../kernel/agent.js';
import { KernelError } from '../../../../kernel/errors.js';
import { compileSafePattern } from '../../../pack/regex.js';
import { countryDisplayOfToken, DEFAULT_RESIDENCE, residenceScope, type ResidenceScope } from '../../../geo/residence.js';
import { countriesIn, officeCity } from '../../../text/norm.js';
import type { RawPosting } from '../../../types.js';
import { finish } from '../common.js';

/**
 * What the registry platform adapters share (Workday, Task 6; Eightfold and Oracle Recruiting Cloud, Task 7): the
 * run's host state (robots.txt once per host per run, the hosts disabled in this run), one request under those host
 * rules, the cheap title pre-filter, the scope-applied bounds and the re-post preference. Each adapter keeps its own
 * endpoints, shapes and paging.
 */

/** The broker's HTTP tool, as an agent's context carries it. */
export type HttpTool = NonNullable<AgentContext['http']>;

/**
 * The run's view of one platform's hosts, built by the daily wiring (`daily-hosts.ts`, one per platform adapter, so a
 * dead tenant on one platform never touches another's) or the coverage verifier (the coverage gate): robots.txt once
 * per host per run, and the hosts disabled in this run.
 */
export interface PlatformHosts<S = unknown> {
  /** Null when robots.txt lets jobpilot fetch `path` on `host`, else the reason (`robots-disallow /wday/…`, `robots-forbidden`, …). */
  robots(host: string, path: string, http: HttpTool): Promise<string | null>;
  disabledWhy(host: string): string | undefined;
  disable(host: string, why: string): void;
  /** Per-board discovery (facet scopes, an API flavour), cached for this run only (absent: discovered on every read). */
  readonly scopes?: Map<string, S>;
  /** The `Sitemap:` URLs of the host's robots.txt (Task 8, the generic adapter), in file order; absent or empty: none known. */
  sitemaps?(host: string, http: HttpTool): Promise<readonly string[]>;
  /** A fingerprint of the host's robots.txt answer (Task 8 fix round 2); absent: unknown. */
  robotsHash?(host: string, http: HttpTool): Promise<string>;
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

/** A 401 or 403 from a platform host: a refusal of the requester. The host is disabled for the run. */
export class HostRefused extends Error {
  constructor(
    readonly status: number,
    readonly host: string,
  ) {
    super(`${host} answered ${status}`);
    this.name = 'HostRefused';
  }
}

/**
 * Hosts no platform adapter may ever ask, checked at run time on every request (Task 8 fix round 2, mutant M16): the
 * SmartRecruiters Posting API. Its name is assembled here so the `src/` grep test for it stays meaningful: no other
 * source file may name it.
 */
const NEVER_READ: ReadonlySet<string> = new Set([['api', 'smartrecruiters', 'com'].join('.')]);

/**
 * One request with the run's host rules: a disabled host is never asked; robots.txt is checked for the path (and
 * query); 401/403 → the host is disabled and `HostRefused`; 429 (the broker's `rate_limit`) → disabled, rethrown.
 */
export async function hostRequest<R extends { status: number }>(http: HttpTool, hosts: PlatformHosts, host: string, url: string, send: () => Promise<R>): Promise<R> {
  if (NEVER_READ.has(host.toLowerCase())) throw new KernelError('policy_denied', `${host} is never read (its robots.txt admits only LinkedInBot, spec D3), whatever builds the request`);
  const off = hosts.disabledWhy(host);
  if (off !== undefined) throw new HostDisabled(host, off);
  const u = new URL(url);
  const denial = await hosts.robots(host, u.pathname + u.search, http);
  const off2 = hosts.disabledWhy(host);
  if (off2 !== undefined) throw new HostDisabled(host, off2);
  if (denial !== null) throw new RobotsDenied(host, denial);
  let r: R;
  try {
    r = await send();
  } catch (e) {
    if (e instanceof KernelError && e.code === 'rate_limit') hosts.disable(host, 'http-429');
    throw e;
  }
  if (r.status === 401 || r.status === 403) {
    hosts.disable(host, `http-${r.status}`);
    throw new HostRefused(r.status, host);
  }
  return r;
}

/**
 * The adapter's refusal mapping, the same for every platform: a robots.txt refusal is a named skip for the company
 * today (`robots-disallow <host>: <company> not read today (…)`, returns true); a host disabled earlier is a deferral
 * (`input_rejected`); a 401/403 is `challenged` (never retried around). Anything else is rethrown as it is.
 */
export function refusal(e: unknown, company: string, ctx: AgentContext): true {
  if (e instanceof RobotsDenied) {
    ctx.skipped([`robots-disallow ${e.host}: ${company} not read today (${e.reason})`]);
    return true;
  }
  if (e instanceof HostDisabled) throw new KernelError('input_rejected', `host-disabled:${e.why} on ${e.host}; ${company} deferred to the next run, never retried around`);
  if (e instanceof HostRefused) throw new KernelError('challenged', `${e.host} answered ${e.status}: the host is disabled for this run, never retried around`);
  throw e;
}

export function shapeError(what: string, r: { error: z.ZodError }): KernelError {
  const first = r.error.issues[0];
  const where = first === undefined ? '' : ` (${first.path.map(String).join('.') || 'root'}: ${first.message})`;
  return new KernelError('invalid_output', `${what}: response shape is not valid${where}`);
}

// ---------------------------------------------------------------------------
// The title pre-filter
// ---------------------------------------------------------------------------

/** The parts of the pack the adapters read: the title rules, and the office cities. */
export const TitlePack = z.object({
  filters: z.object({ roleDeny: z.array(z.string()) }),
  targets: z.object({ titles: z.array(z.string()) }),
  // the residence (profiles Task 14: any ISO country, default IN) and the office cities (eligibility rule 5e)
  eligibility: z.object({ residence: z.string().optional(), officeCities: z.array(z.string()).optional() }).optional(),
});
export type TitlePack = z.infer<typeof TitlePack>;

/**
 * The residence scope of the pack (profiles Task 14): `eligibility.residence`, upper-cased as eligibility reads it,
 * default `IN`. A code `norm.ts` does not know is `invalid_output` naming the adapter.
 */
export function residenceOf(pack: TitlePack, agent: string): ResidenceScope {
  return residenceOfCode(pack.eligibility?.residence, agent);
}

/**
 * The residence scope of a code (absent: `IN`), upper-cased; `invalid_output` naming the agent for a code `norm.ts`
 * does not know. `residenceOf` reads it from the pack; the feeds read it from the seed (`DiscoveryRequest.residence`,
 * profiles Task 15).
 */
export function residenceOfCode(residence: string | undefined, agent: string): ResidenceScope {
  const code = (residence ?? 'IN').toUpperCase();
  try {
    return residenceScope(code);
  } catch {
    throw new KernelError('invalid_output', `${agent}: eligibility.residence: unknown country code ${code}`);
  }
}

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

/** The pack, title rules checked; `invalid_output` naming the adapter when they are missing. */
export function titlePackOf(pack: unknown, agent: string): TitlePack {
  const r = TitlePack.safeParse(pack);
  if (!r.success) throw new KernelError('invalid_output', `${agent}: the pack is missing or lacks filters.roleDeny or targets.titles`);
  return r.data;
}

// ---------------------------------------------------------------------------
// Scopes: the applied-scope bounds, the remote type, India and office names
// ---------------------------------------------------------------------------

/** What the board's facet counts say a scoped list holds. */
export interface ScopeBounds {
  /** The sum of the selected values' counts (a job listed under two values counts twice: an upper bound). */
  readonly expected: number;
  /** The largest single selected value's count (never double-counted: a lower bound of the list). */
  readonly largest: number;
  /**
   * The facet list shows only the platform's top values (PCSX), so `expected` may miss smaller values naming the same
   * place: the upper slack widens to max(10, 10%). The lower bound is unchanged.
   */
  readonly truncated?: boolean;
}

/** The tolerance of the bounds: max(5, 5%); for a truncated facet list's upper bound, max(10, 10%). */
const slack = (n: number): number => Math.max(5, n * 0.05);
const wideSlack = (n: number): number => Math.max(10, n * 0.1);

/**
 * Whether a scoped list's reported total shows the platform applied the scope (Task 6, Fix rounds 2 and 3): null when
 * `largest − max(5, 5%) ≤ total ≤ expected + max(5, 5%)`, else why not. A total above the counts is a scope the
 * platform ignored (a stale or refused filter answering with the whole board); one below the largest value is a stale
 * filter answering with too little, never a silent zero.
 */
export function scopeMiss(total: number, b: ScopeBounds): string | null {
  if (total > b.expected + (b.truncated === true ? wideSlack(b.expected) : slack(b.expected))) return `total ${total}, the facet counts ${b.expected}`;
  if (total < b.largest - slack(b.largest)) return `total ${total}, below its largest facet value ${b.largest}`;
  return null;
}

/** The `input_rejected` refusal of a scope the platform did not apply: nothing is read from that list. */
export const scopeNotApplied = (company: string, list: string, why: string, platform: string): KernelError =>
  new KernelError('input_rejected', `scope-not-applied ${company} ${list} list: ${why}; ${platform} did not apply the scope, nothing read from it`);

/** A remote work-type value: the whole descriptor says remote ("Remote", "Virtual", "Work from home"), not a remote site ("California - Remote"). */
export const REMOTE_TYPE = /^\s*(?:fully\s+)?(?:remote|virtual|work\s+from\s+home|wfh|home[\s-]based)\s*$/iu;

/**
 * Whether a location value names the residence country: its name or one of its places (in the residence's own place
 * table), or its ISO code as the last of three or more parts ("Bengaluru, KA, IN", PCSX's standardized form). A
 * two-part "Indianapolis, IN" is a US state, never India; a platform's own country field (Oracle
 * `PrimaryLocationCountry`) is checked by the adapter itself.
 */
export function namesResidence(location: string, scope: ResidenceScope): boolean {
  if (countriesIn(location, scope.table).includes(scope.country)) return true;
  const parts = location.split(',').map((p) => p.trim());
  return parts.length >= 3 && parts[parts.length - 1] === scope.code;
}

/**
 * Names a board uses for the whole country (never a part of it: England, New Mexico). A country not listed here is
 * matched by its canonical name and display name only.
 */
const COUNTRY_NAME_SPELLINGS: Readonly<Record<string, readonly string[]>> = {
  'united states': ['united states of america', 'usa', 'us', 'u.s.', 'u.s.a.', 'u.s'],
  'united kingdom': ['uk', 'u.k.', 'great britain', 'britain'],
  'united arab emirates': ['uae', 'u.a.e.'],
  netherlands: ['the netherlands', 'holland'],
};

/** A facet value that is exactly the residence country, by any of its whole-country names, any case. India's is today's regex. */
export function exactCountryRe(scope: ResidenceScope): RegExp {
  if (scope.isDefault) return /^\s*india\s*$/iu;
  const names = [...new Set([scope.country, scope.display.toLowerCase(), ...(COUNTRY_NAME_SPELLINGS[scope.country] ?? [])])];
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`^\\s*(?:${alt})\\s*$`, 'iu');
}

/** How a residence's own scoped list is named in notes: India's as today ('india'), others by country ('United States'). */
export const listName = (scope: ResidenceScope): string => (scope.isDefault ? 'india' : scope.display);

/** `namesResidence` for India, today's residence. */
export const namesIndia = (location: string): boolean => namesResidence(location, DEFAULT_RESIDENCE);

/** Whether a location value names one of the pack's office cities (by its aliases, word-bounded), and no country but the residence's (default India). */
export function namesOffice(location: string, officeCities: readonly string[], scope: ResidenceScope = DEFAULT_RESIDENCE): boolean {
  const w = (d: string): string => ' ' + d.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x !== '').join(' ') + ' ';
  const text = w(location);
  const places = countriesIn(location, scope.table);
  if (places.length > 0 && !places.includes(scope.country)) return false;
  return officeCities.map((c) => officeCity(c, scope.table)).some((c) => c.aliases.some((a) => text.includes(w(a))));
}

/**
 * One posting per platform id (sourceId), across a company's lists: the lowest `pref` wins (Task 7: office-named,
 * then India-named, then the rest), ties to the first seen; sorted by sourceId (as `finish`).
 */
export function preferPostings(postings: readonly RawPosting[], pref: (p: RawPosting) => number): RawPosting[] {
  const best = new Map<string, RawPosting>();
  for (const p of postings) {
    const had = best.get(p.sourceId);
    if (had === undefined || pref(p) < pref(had)) best.set(p.sourceId, p);
  }
  return finish([...best.values()]);
}

/** Sorted by sourceId (as `finish`), so the detail order is fixed for a given list. */
export const bySourceId = (a: RawPosting, b: RawPosting): number => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);

/**
 * The detail choice: rank-0 title-passing jobs, ties by sourceId, at most `max`; the named note for the rest
 * (`detail-budget <company>: N jobs without detail (k over the budget, m not India-named)`, the residence's display
 * name in place of India), never silent.
 */
export function chooseDetails(postings: readonly RawPosting[], o: { pack: TitlePack; title: (p: RawPosting) => string; rank0: (p: RawPosting) => boolean; max: number; company: string; ctx: AgentContext; residence?: ResidenceScope }): RawPosting[] {
  const wanted = postings.filter((p) => titlePasses(o.title(p), o.pack));
  const rank0 = wanted.filter(o.rank0).sort(bySourceId);
  const chosen = rank0.slice(0, o.max);
  if (wanted.length > chosen.length) {
    o.ctx.skipped([`detail-budget ${o.company}: ${wanted.length - chosen.length} jobs without detail (${rank0.length - chosen.length} over the budget, ${wanted.length - rank0.length} not ${(o.residence ?? DEFAULT_RESIDENCE).display}-named)`]);
  }
  return chosen;
}

/** The named note for jobs gone between list and detail (404/410 on the detail): `detail-gone <company>: N jobs gone …`. */
export function goneNote(company: string, gone: readonly string[]): string {
  return `detail-gone ${company}: ${gone.length} ${gone.length === 1 ? 'job' : 'jobs'} gone between list and detail (${gone.slice(0, 5).join(', ')}${gone.length > 5 ? ', …' : ''})`;
}

/**
 * List pages a board used on one IST day, across a day's runs (a retry, a `run --refresh`): Oracle's "10 list pages per
 * company per day" (Task 7 fix round 2). The daily wiring injects one backed by the app DB (`appPageLedger`); without
 * one, an in-memory ledger per adapter instance (one run).
 */
export interface PageLedger {
  used(day: string, board: string): number;
  add(day: string, board: string, pages: number): void;
}

export function memoryPageLedger(): PageLedger {
  const m = new Map<string, number>();
  return {
    used: (day, board) => m.get(`${day} ${board}`) ?? 0,
    add: (day, board, pages) => void m.set(`${day} ${board}`, (m.get(`${day} ${board}`) ?? 0) + pages),
  };
}

/** The note prefixes of the named skips every platform adapter may record (problems.ts prints them as they are). */
export const PLATFORM_NOTE_PREFIXES = [
  'robots-disallow ', 'detail-budget ', 'detail-gone ', 'no-india-or-remote-facet ', 'scope-not-applied ', 'short-list ',
  // Task 8, the page adapters (pages.ts)
  'page-budget ', 'title-prefilter ', 'no-jobposting ', 'page-moved ', 'page-error ', 'not-india ', 'malformed-entries ', 'listing-cap ',
  // Task 9, the small platforms (feed-board.ts, rippling.ts)
  'rippling-uuid-conflict ',
  // Sources expansion Task 9, the stored freehire leads (freehire-leads.ts)
  'freehire-leads: ',
] as const;

/**
 * Profiles Task 13: the facet skip for any residence, `no-<token>-or-remote-facet ` (`no-india-or-remote-facet `,
 * `no-united-states-or-remote-facet `), where the token is the residence country with spaces as hyphens.
 */
const FACET_SKIP = /^no-[a-z]+(?:-[a-z]+)*-or-remote-facet /;
export const isPlatformFacetSkip = (note: string): boolean => FACET_SKIP.test(note);

/**
 * Profiles Task 14: the label of a residence-named platform skip, else null: the facet skip for any residence
 * (`no-germany-or-remote-facet`), and SuccessFactors' outside-the-residence skip for any residence country
 * (`not-india`, `not-germany`: the token must be a known country's).
 */
export function residenceSkipLabel(note: string): string | null {
  if (isPlatformFacetSkip(note)) return note.slice(0, note.indexOf(' '));
  const m = /^not-([a-z]+(?:-[a-z]+)*) /.exec(note);
  return m !== null && countryDisplayOfToken(m[1] as string) !== m[1] ? `not-${m[1] as string}` : null;
}
