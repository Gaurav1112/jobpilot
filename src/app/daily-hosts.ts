import { KernelError } from '../kernel/errors.js';
import { EIGHTFOLD_V2_MIN_INTERVAL_MS, type EightfoldHosts } from './agents/sources/platforms/eightfold.js';
import { ORACLE_MIN_INTERVAL_MS, type OracleHosts } from './agents/sources/platforms/oracle.js';
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
export function dailyPlatformHosts<S>(o: { readonly minIntervalMs: number; readonly unreadableRobots?: 'refuse' | 'allow' }): PlatformHosts<S> {
  const robots = new Map<string, Promise<RobotsVerdict>>();
  const disabled = new Map<string, string>();
  const scopes = new Map<string, S>();

  async function verdictOf(host: string, http: HttpTool): Promise<RobotsVerdict> {
    const r = await http.getPage(`https://${host}/robots.txt`, { minIntervalMs: o.minIntervalMs });
    if (isChallenge(r.status, r.body)) {
      disabled.set(host, 'challenge');
      throw new KernelError('challenged', `${host} answered its robots.txt with a challenge page (${r.status}): the host is disabled for this run, never retried around`);
    }
    if (r.status === 429) {
      disabled.set(host, 'http-429');
      throw new KernelError('rate_limit', `429 from ${host} for robots.txt: the host is disabled for this run`);
    }
    if (o.unreadableRobots === 'allow' && (r.status === 401 || r.status === 403)) return { kind: 'allow-all', why: `robots.txt ${r.status}: unreadable, read at the minimal rate` };
    return robotsVerdictOf(r.status, r.body);
  }

  function cached(host: string, http: HttpTool): Promise<RobotsVerdict> {
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
      return robotsDenial(await cached(host, http), new URL(`https://${host}${path}`));
    },
    // Task 8: the generic adapter may read the sitemaps robots.txt names (the same cached fetch)
    async sitemaps(host, http) {
      const v = await cached(host, http);
      return v.kind === 'rules' ? v.robots.sitemaps : [];
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
 * names readable by the generic adapter.
 */
export function dailyPageHosts(): PlatformHosts<never> {
  return dailyPlatformHosts({ minIntervalMs: PAGE_MIN_INTERVAL_MS });
}

/** What `appPageState` needs of the app store (its `platform_pages` table, migration 11). */
export interface PageStore {
  pageRecords(board: string): { url: string; fetchedOn: string; hash: string; raw: string | null }[];
  putPageRecord(board: string, url: string, fetchedOn: string, hash: string, raw: string | null): void;
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
      for (const r of store.pageRecords(board)) m.set(r.url, { fetchedOn: r.fetchedOn, hash: r.hash, raw: r.raw === null ? null : (JSON.parse(r.raw) as unknown) });
      return m;
    },
    put: (board, url, rec) => store.putPageRecord(board, url, rec.fetchedOn, rec.hash, rec.raw === null ? null : JSON.stringify(rec.raw)),
    forget: (board, url) => store.forgetPageRecord(board, url),
    retain: (board, urls) => store.retainPageRecords(board, urls),
  };
}

/**
 * The Oracle list-page ledger kept in the app DB (`app_settings`, key `oracle.pages.<IST day>.<board>`), so a retry or
 * a `run --refresh` on the same day shares the day's 10 pages (Task 7 fix round 2). Writing a day drops every other
 * day's entries. Trusted wiring code: the adapter sees only `PageLedger`.
 */
export function appPageLedger(store: { getSetting(key: string): string | undefined; setSetting(key: string, value: string): void; pruneSettings(prefix: string, keep: string): void }): PageLedger {
  const PREFIX = 'oracle.pages.';
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
