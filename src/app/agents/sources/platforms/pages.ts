import type { AgentContext } from '../../../../kernel/agent.js';
import { KernelError } from '../../../../kernel/errors.js';
import { hasChallengeMarker, isChallenge } from '../../../challenge.js';
import type { RawPosting } from '../../../types.js';
import { dayNumber } from '../careers.js';
import { finish } from '../common.js';
import { checkJobPosting, jsonLdJobPostings, keptJobPosting } from '../jsonld.js';
import { sha256Hex } from '../sha256.js';
import { goneNote, hostRequest, RobotsDenied, titlePasses, type HttpTool, type PageLedger, type PlatformHosts, type TitlePack } from './shared.js';

/**
 * The page crawl the four page adapters share (Task 8: iCIMS, SuccessFactors pages, SmartRecruiters, the generic
 * `jsonld-sitemap`). These read job PAGES and sitemaps, not a documented public API, so the strict page rule applies:
 *
 * - **robots.txt** once per host per run (the daily host state, `daily-hosts.ts`, with the coverage robots matcher, path
 *   and query): 404/410 allows all; 401/403 refuses the host (`robots-forbidden`); any other 3xx/4xx, a 5xx or no answer
 *   refuses it (`robots-unavailable`); a challenge or 429 on it disables the host. A disallowed job page is never asked,
 *   only counted (`robots-disallow <host>: N job pages of <company> not read (…)`).
 * - **Refusals:** a 401/403 on any page disables the host (`HostRefused`), a 429 disables it (`rate_limit`), a challenge
 *   page disables it (`challenged`): a 403/429/503 with a bot-wall marker, or a 2xx under PAGE_CHALLENGE_MAX_BYTES with a
 *   marker and no JobPosting (real job pages are larger: 40-130 KB seen live, and one SmartRecruiters page names
 *   `challenge-platform` in a beacon script). Never retried around; Retry-After is never honoured. A 5xx is a transport
 *   failure (`overloaded`), retried only by the contract.
 * - **Redirects:** at most PAGE_MAX_HOPS, each one robots-checked, and only where the adapter's `follow` allows (the
 *   board's own host: SuccessFactors moves `/job/<title>/<id>/` to `/job/<title>/<n>-en_US/`, seen live). A redirect
 *   anywhere else is never followed (`page-moved`).
 *
 * **Robots-denied pages (fix round 2):** robots.txt is asked before a page is counted: a denied page costs no request
 * and no budget, is named, and is recorded (`robots-denied:<robots.txt fingerprint>`), so it leaves the plan until
 * robots.txt changes or its week is over. A page that answers another 4xx keeps its earlier posting (asked again next
 * week); only 404/410 is gone.
 *
 * Accepted as they are (review, fix round 2): a page whose JobPosting names no location maps to an empty location and
 * the existing eligibility decides (it may reject; eligibility is out of this task's scope); a JSON-LD title keeps
 * whatever markup the site put in it, as the careers source does (the normalizer reads it as text).
 *
 * **Budget and rotation (controller decision 3; fix rounds 1 and 2):** at most PAGE_MAX_FETCHES job pages per company per IST
 * day (`req.runDate`), counted across the day's runs (a retry, a `run --refresh`) in a `PageLedger` (the daily wiring's
 * app-DB ledger, `appPageLedger(app, PAGE_LEDGER_PREFIX)`, as Oracle's list pages), each page counted before it is
 * requested; chosen by `planPages` within what is left of the day's budget (stale pages first, up to
 * PAGE_STALE_RESERVE, whenever there are any): (a) pages never fetched, in listing order; (b) then pages last fetched more than
 * PAGE_STALE_DAYS days ago, oldest first, ties by URL. The rest are queued by name (`page-budget <company>: N job pages
 * queued (…)`), never silently dropped. The listing's own requests are counted by each adapter, separately.
 *
 * **Keep-alive:** each fetched page's outcome is kept in the page state (`PageState`, the app DB in a daily run: URL →
 * the IST day of its last fetch, a content hash, the raw posting or null). A listed job whose page was fetched before
 * (fresh, or stale but over today's budget) emits that stored raw posting again, byte for byte, so it flows through the
 * normal pipeline (its normalizer and later steps replay) and its job row stays seen, exactly as a careers link that
 * replays from the store. A job the listing no longer names loses its record and is never emitted. A listed job never
 * fetched is never a posting. The page state never enters a step key or a pack hash.
 *
 * **Parsing:** the page's JobPosting JSON-LD (`jsonLdJobPostings`), the first node that passes `checkJobPosting` (zod),
 * kept as `keptJobPosting` (only the fields the normalizer reads). A page with none is named (`no-jobposting
 * <company>: …`, with the zod issue) and recorded, so it is not fetched again within the week. A gone page (404/410) is
 * dropped with a `detail-gone` note; like a page redirected off the board (`page-moved`) it is recorded without a
 * posting, so a stale listing that still names it does not spend the budget on it again within the week.
 */

/** Job-page fetches per company per IST day, across the day's runs. */
export const PAGE_MAX_FETCHES = 40;
/** The app_settings key prefix of the daily page ledger (`pages.fetched.<IST day>.<board>`). */
export const PAGE_LEDGER_PREFIX = 'pages.fetched.';
/** A page last fetched more than this many days ago is fetched again when the budget allows. */
export const PAGE_STALE_DAYS = 7;
/** Of the day's budget, this many fetches go to stale pages first whenever there are any (fix round 2). */
export const PAGE_STALE_RESERVE = 10;
/** The page-state hash of a page robots.txt denied: `robots-denied:<robots.txt fingerprint>`. */
export const ROBOTS_DENIED = 'robots-denied:';
/** Redirects followed per page, within the board's host. */
export const PAGE_MAX_HOPS = 3;
/** The spacing of page requests to one host. */
export const PAGE_MIN_INTERVAL_MS = 2000;
/** A 2xx this small, without a JobPosting but with a bot-wall marker, is a challenge page. */
export const PAGE_CHALLENGE_MAX_BYTES = 32 * 1024;

/** What the page state keeps of one fetched job page. */
export interface PageRecord {
  /** The IST day (`req.runDate`) of the last fetch. */
  readonly fetchedOn: string;
  /** sha256 of the raw posting's JSON (of the empty string when the page had no posting). */
  readonly hash: string;
  /** The raw posting the page gave (what the adapter emitted), or null when it had none. */
  readonly raw: unknown;
}

/**
 * The page state across daily runs (the daily wiring injects one backed by the app DB, `appPageState`; without one, in
 * memory per adapter instance). `board` is `<platform> <ref>`.
 */
export interface PageState {
  records(board: string): ReadonlyMap<string, PageRecord>;
  put(board: string, url: string, rec: PageRecord): void;
  forget(board: string, url: string): void;
  /** Drops the board's records of URLs not in `urls` (the listing no longer names them). */
  retain(board: string, urls: ReadonlySet<string>): void;
}

export function memoryPageState(): PageState {
  const m = new Map<string, Map<string, PageRecord>>();
  const of = (board: string): Map<string, PageRecord> => {
    let b = m.get(board);
    if (b === undefined) m.set(board, (b = new Map()));
    return b;
  };
  return {
    records: (board) => new Map(of(board)),
    put: (board, url, rec) => void of(board).set(url, rec),
    forget: (board, url) => void of(board).delete(url),
    retain(board, urls) {
      for (const u of [...of(board).keys()]) if (!urls.has(u)) of(board).delete(u);
    },
  };
}

/** One job a listing names: its public URL (the identity), a title when the listing gives one, its platform id, and the URL to fetch. */
export interface ListedJob {
  readonly url: string;
  readonly title: string | null;
  readonly sourceId: string;
  readonly fetchUrl: string;
}

/** A title from a URL slug (`senior-backend-engineer` → `senior backend engineer`); null when it holds no word. */
export function slugTitle(segment: string): string | null {
  let s: string;
  try {
    s = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const t = s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /\p{L}/u.test(t) ? t : null;
}

/** The title pre-filter on the listing's titles (a job without one is never skipped), the skipped ones counted by name. */
export function prefilter(jobs: readonly ListedJob[], pack: TitlePack, company: string, ctx: AgentContext): ListedJob[] {
  const passing = jobs.filter((j) => j.title === null || titlePasses(j.title, pack));
  const skipped = jobs.length - passing.length;
  if (skipped > 0) ctx.skipped([`title-prefilter ${company}: ${skipped} of ${jobs.length} listed jobs not fetched (the title pre-filter)`]);
  return passing;
}

export interface PagePlan {
  /** Every page to fetch today, in priority order (the walk spends the budget along it, robots-denied pages free). */
  readonly order: readonly ListedJob[];
  /** The first `max` of `order`: what is fetched when no page is denied. */
  readonly fetch: readonly ListedJob[];
  /** Listed jobs fetched before and not planned: fresh ones, and stale ones past the budget (their stored posting is emitted). */
  readonly keep: readonly ListedJob[];
  /** Of `order` past `max`: never-fetched ones and stale ones. */
  readonly queuedNew: number;
  readonly queuedStale: number;
  /** The stale jobs (so a walk that stops early still keeps them). */
  readonly stale: ReadonlySet<string>;
}

const ageOf = (runDate: string, fetchedOn: string): number => {
  try {
    return dayNumber(runDate) - dayNumber(fetchedOn);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/**
 * The fair daily rotation (see the header): stale pages (last fetched over PAGE_STALE_DAYS ago, oldest first, ties by
 * URL) take the first min(PAGE_STALE_RESERVE, max) places when there are any, so kept postings are refreshed even while
 * new URLs keep arriving; then never-fetched pages in listing order; then the remaining stale pages. A stale reserve
 * with fewer stale pages goes to new pages.
 */
export function planPages(jobs: readonly ListedJob[], records: ReadonlyMap<string, PageRecord>, runDate: string, max: number): PagePlan {
  const fresh: ListedJob[] = [];
  const never: ListedJob[] = [];
  const stale: { job: ListedJob; on: string }[] = [];
  const seen = new Set<string>();
  for (const j of jobs) {
    if (seen.has(j.url)) continue;
    seen.add(j.url);
    const r = records.get(j.url);
    if (r === undefined) never.push(j);
    else if (ageOf(runDate, r.fetchedOn) <= PAGE_STALE_DAYS) fresh.push(j);
    else stale.push({ job: j, on: r.fetchedOn });
  }
  stale.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : a.job.url < b.job.url ? -1 : a.job.url > b.job.url ? 1 : 0));
  const staleJobs = stale.map((x) => x.job);
  const reserve = Math.min(PAGE_STALE_RESERVE, Math.max(0, max));
  const order = [...staleJobs.slice(0, reserve), ...never, ...staleJobs.slice(reserve)];
  const first = order.slice(0, Math.max(0, max));
  const fetched = new Set(first.map((j) => j.url));
  const staleSet = new Set(staleJobs.map((j) => j.url));
  return {
    order,
    fetch: first,
    keep: [...fresh, ...staleJobs.filter((j) => !fetched.has(j.url))],
    queuedNew: never.filter((j) => !fetched.has(j.url)).length,
    queuedStale: staleJobs.filter((j) => !fetched.has(j.url)).length,
    stale: staleSet,
  };
}

export type PageAnswer =
  | { readonly kind: 'ok'; readonly url: string; readonly body: string }
  | { readonly kind: 'gone'; readonly status: number }
  | { readonly kind: 'moved'; readonly to: string }
  | { readonly kind: 'error'; readonly status: number };

export interface PageRequestOptions {
  /** Which redirect targets may be followed (the board's own host). */
  readonly follow: (u: URL) => boolean;
  readonly minIntervalMs?: number;
  readonly timeoutMs?: number;
  /**
   * Whether a 2xx body holds what this kind of page should (a sitemap's `<urlset>`, a listing's job links, a job page's
   * JobPosting); default: it names `JobPosting`. A small 2xx with a bot-wall marker is a challenge only without it, so a
   * page that merely loads a captcha script is read (fix round 2).
   */
  readonly expected?: (body: string) => boolean;
}

/**
 * One page under the strict host rules (see the header): robots.txt and disabled hosts per hop, refusals disable the
 * host, a 5xx is `overloaded`, redirects within `follow` (at most PAGE_MAX_HOPS).
 */
export async function getRuledPage(http: HttpTool, hosts: PlatformHosts, url: string, o: PageRequestOptions): Promise<PageAnswer> {
  let at = url;
  for (let hop = 0; hop <= PAGE_MAX_HOPS; hop++) {
    const host = new URL(at).hostname;
    const opts = { minIntervalMs: o.minIntervalMs ?? PAGE_MIN_INTERVAL_MS, ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }) };
    const target = at;
    const r = await hostRequest(http, hosts, host, target, () => http.getPage(target, opts));
    const expected = o.expected ?? ((b: string) => b.includes('JobPosting'));
    const small = r.status >= 200 && r.status < 300 && r.body.length <= PAGE_CHALLENGE_MAX_BYTES && hasChallengeMarker(r.body) && !expected(r.body);
    if (isChallenge(r.status, r.body) || small) {
      hosts.disable(host, 'challenge');
      throw new KernelError('challenged', `${host} answered with a challenge page (${r.status}): the host is disabled for this run, never retried around`);
    }
    if (r.status === 429) {
      hosts.disable(host, 'http-429');
      throw new KernelError('rate_limit', `429 from ${host}: the host is disabled for this run, never retried around`);
    }
    if (r.status >= 500) throw new KernelError('overloaded', `${r.status} from ${host}`);
    if (r.status >= 300 && r.status < 400) {
      let to: URL;
      try {
        to = new URL(r.location ?? '', at);
      } catch {
        return { kind: 'moved', to: 'an invalid Location' };
      }
      if (r.location === null || to.protocol !== 'https:' || !o.follow(to)) return { kind: 'moved', to: r.location === null ? 'nowhere' : to.hostname };
      at = to.href;
      continue;
    }
    if (r.status === 404 || r.status === 410) return { kind: 'gone', status: r.status };
    if (r.status < 200 || r.status >= 300) return { kind: 'error', status: r.status };
    return { kind: 'ok', url: at, body: r.body };
  }
  return { kind: 'moved', to: `more than ${PAGE_MAX_HOPS} redirects` };
}

/** The raw posting of a JSON-LD page (normalizer mappers `icims`, `smartrecruiters`, `jsonld-sitemap`: the careers shape). */
export interface PageRaw {
  readonly url: string;
  readonly title: string;
  readonly jsonLd: Record<string, unknown>;
}

export interface ReadPagesOptions {
  readonly http: HttpTool;
  readonly hosts: PlatformHosts;
  readonly ctx: AgentContext;
  readonly company: string;
  /** `<platform> <ref>`: the page state's key. */
  readonly board: string;
  readonly runDate: string;
  /** The listed jobs to consider (title pre-filter applied), in listing order. */
  readonly jobs: readonly ListedJob[];
  /** Every URL the listing names (before any filter): records of other URLs are dropped. */
  readonly listed: ReadonlySet<string>;
  readonly state: PageState;
  /** The company's job-page budget for its IST day. */
  readonly max: number;
  /** The day's job pages per board, across the day's runs (each page counted before it is requested). */
  readonly ledger: PageLedger;
  readonly source: string;
  readonly slug: string;
  readonly follow: (u: URL) => boolean;
  /** The raw posting of a page's JobPosting; default `PageRaw`. */
  readonly toRaw?: (job: ListedJob, jsonLd: Record<string, unknown>) => unknown;
}

const shortList = (xs: readonly string[]): string => `${xs.slice(0, 5).join('; ')}${xs.length > 5 ? '; …' : ''}`;

/** The crawl of one company's job pages (see the header): its postings, sorted by sourceId, and the named notes. */
export async function readJobPages(o: ReadPagesOptions): Promise<RawPosting[]> {
  o.state.retain(o.board, o.listed);
  const records = new Map(o.state.records(o.board));
  // a page robots.txt denied is planned again once robots.txt changes (its fingerprint) or its week is over
  const deniedHosts = new Set<string>();
  for (const j of o.jobs) if (records.get(j.url)?.hash.startsWith(ROBOTS_DENIED) === true) deniedHosts.add(new URL(j.fetchUrl).hostname);
  const robotsNow = new Map<string, string | null>();
  for (const h of deniedHosts) robotsNow.set(h, o.hosts.robotsHash === undefined ? null : await o.hosts.robotsHash(h, o.http));
  for (const j of o.jobs) {
    const r = records.get(j.url);
    const now = robotsNow.get(new URL(j.fetchUrl).hostname);
    if (r !== undefined && r.hash.startsWith(ROBOTS_DENIED) && now !== null && now !== undefined && r.hash !== `${ROBOTS_DENIED}${now}`) records.delete(j.url);
  }
  const left = Math.max(0, o.max - o.ledger.used(o.runDate, o.board));
  const plan = planPages(o.jobs, records, o.runDate, left);
  const out: RawPosting[] = [];
  const gone: string[] = [];
  const denied: string[] = [];
  let deniedWhy = '';
  let deniedHost = '';
  const none: string[] = [];
  const moved: string[] = [];
  const errors: string[] = [];
  const emit = (j: ListedJob, raw: unknown): void => void out.push({ source: o.source, sourceId: j.sourceId, company: o.company, slug: o.slug, raw });
  const record = (j: ListedJob, hash: string, raw: unknown): void => o.state.put(o.board, j.url, { fetchedOn: o.runDate, hash, raw });
  const empty = (j: ListedJob, why: string): void => {
    none.push(`${j.sourceId}: ${why}`);
    record(j, sha256Hex(''), null);
  };
  const deny = async (j: ListedJob, host: string, reason: string): Promise<void> => {
    denied.push(j.sourceId);
    deniedWhy ||= reason;
    deniedHost ||= host;
    const fp = o.hosts.robotsHash === undefined ? 'unknown' : await o.hosts.robotsHash(host, o.http);
    record(j, `${ROBOTS_DENIED}${fp}`, null);
  };

  let budget = left;
  const done = new Set<string>();
  let queuedNew = 0;
  let queuedStale = 0;
  for (const j of plan.order) {
    if (budget <= 0) {
      if (plan.stale.has(j.url)) queuedStale++;
      else queuedNew++;
      continue;
    }
    const u = new URL(j.fetchUrl);
    // robots.txt first: a denied page costs no request and no budget, and leaves the plan (fix round 2)
    const why = await o.hosts.robots(u.hostname, u.pathname + u.search, o.http);
    if (why !== null) {
      await deny(j, u.hostname, why);
      done.add(j.url);
      continue;
    }
    budget--;
    done.add(j.url);
    // counted before it is asked: a page that fails still spends the day's budget
    o.ledger.add(o.runDate, o.board, 1);
    let a: PageAnswer;
    try {
      a = await getRuledPage(o.http, o.hosts, j.fetchUrl, { follow: o.follow });
    } catch (e) {
      if (!(e instanceof RobotsDenied)) throw e;
      // a redirect hop robots.txt denies
      await deny(j, e.host, e.reason);
      continue;
    }
    // a gone or moved page is recorded without a posting: a listing that still names it (a stale sitemap: 11 of
    // Okta's, seen live) does not spend the budget on it again within the week; the record goes with the listing entry
    if (a.kind === 'gone') {
      record(j, sha256Hex(''), null);
      gone.push(j.sourceId);
      continue;
    }
    if (a.kind === 'moved') {
      record(j, sha256Hex(''), null);
      moved.push(`${j.sourceId} to ${a.to}`);
      continue;
    }
    if (a.kind === 'error') {
      errors.push(`${j.sourceId}: ${a.status}`);
      // only 404/410 is gone: a stale page's good posting is kept, and asked again next week (fix round 2)
      const before = records.get(j.url);
      if (before !== undefined && before.raw !== null && !before.hash.startsWith(ROBOTS_DENIED)) {
        record(j, before.hash, before.raw);
        emit(j, before.raw);
      } else record(j, sha256Hex(''), null);
      continue;
    }
    const nodes = jsonLdJobPostings(a.body);
    if (nodes.length === 0) {
      empty(j, 'no JobPosting JSON-LD');
      continue;
    }
    const checked = nodes.map(checkJobPosting);
    const valid = checked.find((c) => c.ok);
    if (valid === undefined || !valid.ok) {
      const first = checked[0];
      empty(j, first !== undefined && !first.ok ? first.why : 'not a JobPosting');
      continue;
    }
    const jsonLd = keptJobPosting(valid.posting);
    const raw = o.toRaw ? o.toRaw(j, jsonLd) : ({ url: j.url, title: valid.posting.title.trim(), jsonLd } satisfies PageRaw);
    record(j, sha256Hex(JSON.stringify(raw)), raw);
    emit(j, raw);
  }
  // fresh pages, and stale ones today's budget did not reach, keep their stored posting
  for (const j of [...plan.keep, ...plan.order.filter((x) => plan.stale.has(x.url) && !done.has(x.url))]) {
    const r = records.get(j.url);
    if (r !== undefined && r.raw !== null && !done.has(j.url)) emit(j, r.raw);
  }

  const notes: string[] = [];
  const queued = queuedNew + queuedStale;
  if (queued > 0) notes.push(`page-budget ${o.company}: ${queued} job pages queued (${queuedNew} never fetched, ${queuedStale} stale kept from their last fetch)`);
  if (gone.length > 0) notes.push(goneNote(o.company, gone));
  if (denied.length > 0) notes.push(`robots-disallow ${deniedHost}: ${denied.length} job pages of ${o.company} not read (${deniedWhy})`);
  if (none.length > 0) notes.push(`no-jobposting ${o.company}: ${none.length} job pages without a valid JobPosting (${shortList(none)})`);
  if (moved.length > 0) notes.push(`page-moved ${o.company}: ${moved.length} job pages redirected off the board (${shortList(moved)})`);
  if (errors.length > 0) notes.push(`page-error ${o.company}: ${errors.length} job pages answered an error (${shortList(errors)})`);
  if (notes.length > 0) o.ctx.skipped(notes);
  return finish(out);
}

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * The `href` of every `<a>` of a page, in document order (raw, entities not decoded). Linear: each `<a` and the `>`
 * closing its tag are found by forward searches, the attributes are read once, and the scan resumes after that `>`.
 */
export function anchorHrefs(html: string): string[] {
  const out: string[] = [];
  const open = /<a\s/gi;
  let o = open.exec(html);
  while (o !== null) {
    const gt = html.indexOf('>', open.lastIndex);
    if (gt < 0) break;
    const m = HREF.exec(html.slice(open.lastIndex, gt));
    if (m !== null) out.push((m[1] ?? m[2] ?? m[3] ?? '').trim());
    open.lastIndex = gt + 1;
    o = open.exec(html);
  }
  return out;
}

/**
 * A listing or sitemap request under the same host rules (robots.txt, refusals, redirects within `follow`): its body.
 * 404/410 is `gone` (a retired board: never a breaker); a redirect elsewhere or another status is `input_rejected` (a
 * deterministic fact about this tenant, named).
 */
export async function getListing(
  http: HttpTool,
  hosts: PlatformHosts,
  url: string,
  what: string,
  follow: (u: URL) => boolean,
  expected: (body: string) => boolean,
  timeoutMs?: number,
): Promise<{ readonly url: string; readonly body: string }> {
  const a = await getRuledPage(http, hosts, url, { follow, expected, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  if (a.kind === 'gone') throw new KernelError('gone', `${what}: ${url} answered ${a.status}`);
  if (a.kind === 'moved') throw new KernelError('input_rejected', `${what}: ${url} redirected off the board (to ${a.to}); nothing read`);
  if (a.kind === 'error') throw new KernelError('input_rejected', `${what}: ${url} answered ${a.status}; nothing read`);
  return { url: a.url, body: a.body };
}

/** What a page adapter's listing gives: the jobs in listing order, and every URL it names (for the page state). */
export interface PageListing {
  readonly jobs: readonly ListedJob[];
  readonly listed: ReadonlySet<string>;
}

/** A sitemap document's expected content (`<urlset>` or `<sitemapindex>`), for the challenge check. */
export const looksLikeSitemap = (body: string): boolean => /<(?:urlset|sitemapindex)[\s>]/iu.test(body);

/** Job pages the verifier tries, in listing order, before a failed verdict (a stale sitemap lists gone pages first). */
export const VERIFY_MAX_PAGES = 3;

/**
 * The verifier's job page: the first of the first VERIFY_MAX_PAGES listed jobs with a valid JobPosting, or
 * `invalid_output` naming why each failed. A refusal (robots, 401/403, 429, a challenge) ends the read at once.
 */
export async function readOneJobPage(http: HttpTool, hosts: PlatformHosts, jobs: readonly ListedJob[], follow: (u: URL) => boolean, what: string, timeoutMs?: number): Promise<Record<string, unknown>> {
  const why: string[] = [];
  const tried = jobs.slice(0, VERIFY_MAX_PAGES);
  for (const job of tried) {
    const a = await getRuledPage(http, hosts, job.fetchUrl, { follow, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    if (a.kind !== 'ok') {
      why.push(`${job.url}: ${a.kind === 'moved' ? `moved to ${a.to}` : `answered ${a.status}`}`);
      continue;
    }
    const checked = jsonLdJobPostings(a.body).map(checkJobPosting);
    const valid = checked.find((c) => c.ok);
    if (valid !== undefined && valid.ok) return keptJobPosting(valid.posting);
    const first = checked[0];
    why.push(`${job.url}: ${first === undefined ? 'no JobPosting JSON-LD' : first.ok ? '' : first.why}`);
  }
  throw new KernelError('invalid_output', `${what}: no valid JobPosting on ${tried.length} job pages (${why.join('; ')})`);
}

/** The board name of a kept JobPosting (`hiringOrganization.name`), or null. */
export const hiringOrganizationOf = (jsonLd: Record<string, unknown>): string | null => {
  const org = jsonLd.hiringOrganization;
  const name = typeof org === 'object' && org !== null ? (org as { name?: unknown }).name : undefined;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
};
