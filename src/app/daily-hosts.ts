import { createHash } from 'node:crypto';
import { KernelError } from '../kernel/errors.js';
import { EIGHTFOLD_V2_MIN_INTERVAL_MS, type EightfoldHosts } from './agents/sources/platforms/eightfold.js';
import { ORACLE_MIN_INTERVAL_MS, type OracleHosts } from './agents/sources/platforms/oracle.js';
import { documentedHosts, FEED_MIN_INTERVAL_MS } from './agents/sources/platforms/feed-board.js';
import { PAGE_MIN_INTERVAL_MS, type PageRecord, type PageState } from './agents/sources/platforms/pages.js';
import type { HttpTool, PageLedger, PlatformHosts } from './agents/sources/platforms/shared.js';
import { WORKDAY_MIN_INTERVAL_MS, type WorkdayHosts } from './agents/sources/platforms/workday.js';
import { isChallenge } from './coverage/gate.js';
import { robotsDenial, robotsVerdictOf, type RobotsVerdict } from './coverage/robots.js';

/**
 * The daily run's host state for the registry platform adapters (Task 6: Workday; Task 7: Eightfold, Oracle), one per
 * adapter, built once per daily run by the wiring and handed to the adapter, so it never outlives the run and a dead
 * tenant on one platform never touches another's:
 * - robots.txt is fetched once per host per run, through the adapter's own broker context (its egress, the honest
 *   user agent, the platform's spacing), and matched with the coverage run's robots.txt rules (`coverage/robots.ts`:
 *   the parser, the matcher and the status rules; nothing of the coverage run's tables or run state). A robots.txt
 *   that fails to arrive (network, timeout) is not cached: the step fails and its retry asks again.
 * - `unreadableRobots: 'allow'` (Oracle Recruiting Cloud only, a controller decision): a robots.txt answering a plain
 *   401 or 403 (Oracle's WAF answers 403 for every robots.txt) is "unknown", not a refusal: RFC 9309 §2.3.1.3 lets a
 *   crawler access resources when robots.txt answers 4xx, and the spec (§4) reads it at the minimal rate. A challenge
 *   page or 429 still disables the host; a readable robots.txt still governs. The coverage page crawler keeps its
 *   stricter rule (401/403 robots.txt disables the host): that is for crawling pages, not this REST API.
 * - A host that answers a robots.txt with a challenge page or 429, or any request with 401, 403 or 429, is disabled
 *   for the rest of the run (in memory: a daily run is one process); the adapter never asks it again in this run.
 * - Each board's discovery (facet scopes, an API flavour) is kept for the run only, never persisted: a retry of the
 *   company skips it, the next run discovers again.
 */
export function dailyPlatformHosts<S>(o: {
  readonly minIntervalMs: number;
  readonly unreadableRobots?: 'refuse' | 'allow';
  /**
   * A robots.txt that never arrives (network, timeout): `fail` (the default) fails the step, uncached, so its retry asks
   * again; `unavailable` (the page adapters, Task 8 fix round 2) is the verdict `robots-unavailable` for the run, a
   * named skip like any other unreadable robots.txt.
   */
  readonly unreachableRobots?: 'fail' | 'unavailable';
}): PlatformHosts<S> {
  const robots = new Map<string, Promise<{ verdict: RobotsVerdict; hash: string }>>();
  const disabled = new Map<string, string>();
  const scopes = new Map<string, S>();

  async function verdictOf(host: string, http: HttpTool): Promise<{ verdict: RobotsVerdict; hash: string }> {
    let r: { status: number; body: string };
    try {
      r = await http.getPage(`https://${host}/robots.txt`, { minIntervalMs: o.minIntervalMs });
    } catch (e) {
      if (o.unreachableRobots === 'unavailable' && e instanceof KernelError && (e.code === 'network' || e.code === 'timeout')) {
        return { verdict: { kind: 'disallow-all', reason: 'robots-unavailable', why: `robots.txt unreachable (${e.code})` }, hash: `unreachable:${e.code}` };
      }
      throw e;
    }
    if (isChallenge(r.status, r.body)) {
      disabled.set(host, 'challenge');
      throw new KernelError('challenged', `${host} answered its robots.txt with a challenge page (${r.status}): the host is disabled for this run, never retried around`);
    }
    if (r.status === 429) {
      disabled.set(host, 'http-429');
      throw new KernelError('rate_limit', `429 from ${host} for robots.txt: the host is disabled for this run`);
    }
    const hash = createHash('sha256').update(`${r.status}\n${r.body}`).digest('hex').slice(0, 16);
    if (o.unreadableRobots === 'allow' && (r.status === 401 || r.status === 403)) return { verdict: { kind: 'allow-all', why: `robots.txt ${r.status}: unreadable, read at the minimal rate` }, hash };
    return { verdict: robotsVerdictOf(r.status, r.body), hash };
  }

  function cached(host: string, http: HttpTool): Promise<{ verdict: RobotsVerdict; hash: string }> {
    let p = robots.get(host);
    if (p === undefined) {
      p = verdictOf(host, http);
      robots.set(host, p);
      // only a settled verdict is kept: a robots.txt that never arrived is asked again by the next step
      p.catch(() => robots.delete(host));
    }
    return p;
  }

  return {
    async robots(host, path, http) {
      return robotsDenial((await cached(host, http)).verdict, new URL(`https://${host}${path}`));
    },
    // Task 8: the generic adapter may read the sitemaps robots.txt names (the same cached fetch)
    async sitemaps(host, http) {
      const v = (await cached(host, http)).verdict;
      return v.kind === 'rules' ? v.robots.sitemaps : [];
    },
    // Task 8 fix round 2: a fingerprint of the robots.txt answer, so a page it denied is planned again when it changes
    async robotsHash(host, http) {
      return (await cached(host, http)).hash;
    },
    scopes,
    disabledWhy: (host) => disabled.get(host),
    disable(host, why) {
      if (!disabled.has(host)) disabled.set(host, why);
    },
  };
}

/** The Workday adapter's host state (Task 6): robots.txt at the 2 s Workday spacing; a 401/403 robots.txt refuses. */
export function dailyWorkdayHosts(): WorkdayHosts {
  return dailyPlatformHosts({ minIntervalMs: WORKDAY_MIN_INTERVAL_MS });
}

/**
 * The Eightfold adapter's host state (Task 7): robots.txt at the 2 s spacing (the API requests widen it per variant:
 * PCSX 10 s); a 401/403 robots.txt refuses.
 */
export function dailyEightfoldHosts(): EightfoldHosts {
  return dailyPlatformHosts({ minIntervalMs: EIGHTFOLD_V2_MIN_INTERVAL_MS });
}

/** The Oracle Recruiting Cloud adapter's host state (Task 7): a 401/403 robots.txt is unreadable, read at the minimal 5 s rate. */
export function dailyOracleHosts(): OracleHosts {
  return dailyPlatformHosts({ minIntervalMs: ORACLE_MIN_INTERVAL_MS, unreadableRobots: 'allow' });
}

/**
 * A page adapter's host state (Task 8: iCIMS, SuccessFactors, SmartRecruiters, jsonld-sitemap): the strict page rule,
 * robots.txt at the 2 s page spacing, a 401/403 robots.txt refuses (never `unreadableRobots`), the sitemaps robots.txt
 * names readable by the generic adapter; an unreachable robots.txt is `robots-unavailable` (a named skip, fix round 2).
 */
export function dailyPageHosts(): PlatformHosts<never> {
  return dailyPlatformHosts({ minIntervalMs: PAGE_MIN_INTERVAL_MS, unreadableRobots: 'refuse', unreachableRobots: 'unavailable' });
}

/**
 * A small-platform feed adapter's host state (Task 9). A feed that is the platform's DOCUMENTED public API (Workable,
 * Recruitee, Personio, Pinpoint, Gem) is read as Greenhouse, Lever and Ashby are: robots.txt is not asked, so it never
 * denies; the disabled hosts are still kept, so a 401/403/429 or a challenge ends the host's reads for the run. Any other
 * feed (Teamtailor, BambooHR, Breezy, Rippling) is under the strict page rule (`dailyPageHosts`: robots.txt once per
 * host per run at the 2 s spacing, a 401/403 robots.txt refuses, an unreachable one is `robots-unavailable`).
 */
export function dailyFeedHosts(documented: boolean): PlatformHosts<never> {
  if (!documented) return dailyPlatformHosts({ minIntervalMs: FEED_MIN_INTERVAL_MS, unreadableRobots: 'refuse', unreachableRobots: 'unavailable' });
  return documentedHosts();
}

/** What `appPageState` needs of the app store (its `platform_pages` table, migration 11). */
export interface PageStore {
  pageRecords(board: string): { url: string; fetchedOn: string; hash: string; raw: string | null; errors: number }[];
  putPageRecord(board: string, url: string, fetchedOn: string, hash: string, raw: string | null, errors?: number): void;
  forgetPageRecord(board: string, url: string): void;
  retainPageRecords(board: string, urls: ReadonlySet<string>): void;
}

/**
 * The page adapters' state across daily runs (Task 8), in the app DB (`platform_pages`, migration 11): per board
 * (`<platform> <ref>`) and job URL, the IST day of the last fetch, a content hash and the raw posting (JSON) or null.
 * Read once per board per step. Trusted wiring code: the adapters see only `PageState`. Rows exist only for boards a
 * page adapter read, so with an empty registry the table stays empty; it never enters a step key or a pack hash.
 */
export function appPageState(store: PageStore): PageState {
  return {
    records(board) {
      const m = new Map<string, PageRecord>();
      for (const r of store.pageRecords(board)) m.set(r.url, { fetchedOn: r.fetchedOn, hash: r.hash, raw: r.raw === null ? null : (JSON.parse(r.raw) as unknown), ...(r.errors > 0 ? { errors: r.errors } : {}) });
      return m;
    },
    put: (board, url, rec) => store.putPageRecord(board, url, rec.fetchedOn, rec.hash, rec.raw === null ? null : JSON.stringify(rec.raw), rec.errors ?? 0),
    forget: (board, url) => store.forgetPageRecord(board, url),
    retain: (board, urls) => store.retainPageRecords(board, urls),
  };
}

/**
 * The Oracle list-page ledger kept in the app DB (`app_settings`, key `oracle.pages.<IST day>.<board>`), so a retry or
 * a `run --refresh` on the same day shares the day's 10 pages (Task 7 fix round 2). Writing a day drops every other
 * day's entries. Task 8 fix round 1: the page adapters' job pages use the same ledger under `PAGE_LEDGER_PREFIX`
 * (`pages.fetched.<IST day>.<platform> <ref>`, 40 per company per day). Trusted wiring code: the adapter sees only `PageLedger`.
 */
export function appPageLedger(store: { getSetting(key: string): string | undefined; setSetting(key: string, value: string): void; pruneSettings(prefix: string, keep: string): void }, prefix = 'oracle.pages.'): PageLedger {
  const PREFIX = prefix;
  const key = (day: string, board: string): string => `${PREFIX}${day}.${board}`;
  const used = (day: string, board: string): number => {
    const n = Number(store.getSetting(key(day, board)) ?? '0');
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  };
  return {
    used,
    add(day, board, pages) {
      store.pruneSettings(PREFIX, `${PREFIX}${day}.`);
      store.setSetting(key(day, board), String(used(day, board) + pages));
    },
  };
}
