import { FactStatus } from '../pack/schema.js';
import type { Fact } from '../pack/schema.js';
import type { Posting } from '../types.js';
import { dirname } from 'node:path';
import { Store } from '../../kernel/store/store.js';
import { checkHome, fileWarning, homeWarning, warnOnce } from '../home.js';
import type { CompanyVerdict, Platform } from '../coverage/types.js';
import { GENERIC_LABELS, normalCompanyName } from '../coverage/names.js';
import { companyKeys, jobKeys, jobOfCompany, type CompanyJobs } from '../coverage/company-jobs.js';
import type { AtsIdPlatform, AtsRef } from '../text/ats-id.js';
import { boardRefOf, splitPostingSourceId } from '../text/norm.js';
import { ATS_SOURCES, linkJobs, type LinkRow } from './links.js';
import { APP_MIGRATIONS, COMPANY_OVERRIDES, COMPANY_STATUSES, DOCS_STATES, GIG_DOCS_STATES, GIG_KINDS, GIG_LISTS, GIG_STATUSES, JOB_STATUSES, NETWORK_STATUSES } from './schema.js';

export type JobStatus = (typeof JOB_STATUSES)[number];
/**
 * How far the user got with a job. Used only to show one status for a cross-source group whose rows were imported
 * with different statuses: the furthest wins. `rejected` (by the employer) follows applying.
 */
export const STATUS_PRECEDENCE: Readonly<Record<JobStatus, number>> = { new: 0, skipped: 1, approved: 2, applied: 3, rejected: 4, interview: 5, offer: 6 };
export type DocsState = (typeof DOCS_STATES)[number];
export type Verdict = 'eligible' | 'rejected' | 'review';
/**
 * The comp-first band (spec §7). `disclosed`: an eligible job with a disclosed maximum at or above the floor;
 * `undisclosed`: an eligible job with no disclosed maximum; `review`: a review verdict, or a row no run has assessed
 * yet (a Desk import). `rejected` and `below-floor` (a score under minFit, or a disclosed maximum under the floor) are
 * listed only when a filter asks for them.
 */
export type Band = 'disclosed' | 'undisclosed' | 'review' | 'below-floor' | 'rejected';
export const DEFAULT_BANDS: readonly Band[] = ['disclosed', 'undisclosed', 'review'];
const BAND_RANK: Readonly<Record<Band, number>> = { disclosed: 0, undisclosed: 1, review: 2, 'below-floor': 3, rejected: 4 };
export { ATS_SOURCES };

export interface Doc {
  readonly kind: 'resume' | 'cover';
  readonly format: 'pdf' | 'docx' | 'html';
  readonly path: string;
  readonly sha256: string;
  readonly pages: number | null;
  readonly qaOk: boolean;
}

/** The run-owned columns of a job, plus the posting identity and the time it was seen. Never status or note. */
export interface JobUpsert {
  /** `jobKey(source, sourceId)`: the row identity. */
  readonly jobKey: string;
  /** `dedupeKey(company, title, location)`: links cross-source listings of one job. */
  readonly dedupeKey: string;
  readonly source: string;
  readonly sourceId: string;
  readonly company: string;
  readonly title: string;
  readonly url: string;
  readonly ats: string;
  readonly location: string;
  readonly remote: Posting['remote'] | null;
  readonly comp?: Posting['comp'];
  readonly compMinInr: number | null;
  readonly compMaxInr: number | null;
  readonly compBasis: 'base' | 'unknown' | null;
  readonly score: number | null;
  readonly breakdown: readonly { readonly label: string; readonly points: number }[] | null;
  readonly verdict: Verdict | null;
  readonly reasons: readonly string[];
  readonly notes: readonly string[];
  readonly jdText: string;
  /** Covered and missing JD terms from the writing team, for the job detail page. */
  readonly terms: { readonly covered: readonly string[]; readonly missing: readonly string[] } | null;
  readonly recommendedFormat: 'pdf' | 'docx' | null;
  readonly docsState: DocsState;
  readonly docsDetail: string | null;
  readonly postedAt: string | null;
  /** The resume plan's unplaced fact ids (citeable facts dated inside no role); default none. */
  readonly unplaced?: readonly string[];
  /** When this posting was seen: sets last_seen, and first_seen on insert. */
  readonly at: string;
  /** Task 10: the posting's board or feed (`Posting.slug`), for the same-source rule of the ATS-id match. */
  readonly slug?: string;
  /** Task 10: the job's ATS id (`atsRefOf(posting)`); absent or null: none, the v1 dedupe key alone links it. */
  readonly atsJob?: AtsRef | null;
}

/** A Desk row: run-owned columns plus the user-owned ones it carries over. Only `migrateDesk` writes these. */
export interface JobImport extends JobUpsert {
  readonly status: JobStatus;
  readonly note: string;
  readonly appliedAt: string | null;
  /** When the Desk last changed the status, for the migration's history entry. */
  readonly statusAt: string;
}

export interface JobView {
  readonly jobKey: string;
  readonly dedupeKey: string;
  readonly source: string;
  readonly sourceId: string;
  /** The preferred row of this job's cross-source group, when this row is a duplicate listing; else null. */
  readonly duplicateOf: string | null;
  /** On a preferred row: the sources of its duplicate listings, sorted ("also listed on"). */
  readonly alsoListedOn: string[];
  readonly company: string;
  readonly title: string;
  readonly url: string;
  readonly ats: string;
  readonly location: string;
  readonly remote: Posting['remote'] | null;
  readonly comp: Posting['comp'];
  readonly compMinInr: number | null;
  readonly compMaxInr: number | null;
  readonly compBasis: 'base' | 'unknown' | null;
  readonly score: number | null;
  readonly breakdown: { label: string; points: number }[] | null;
  readonly verdict: Verdict | null;
  readonly reasons: string[];
  readonly notes: string[];
  readonly jdText: string;
  readonly terms: { covered: string[]; missing: string[] } | null;
  readonly recommendedFormat: 'pdf' | 'docx' | null;
  readonly docsState: DocsState;
  readonly docsDetail: string | null;
  readonly postedAt: string | null;
  /** The resume plan's unplaced fact ids, sorted: the dashboard asks the user to fix their dates. */
  readonly unplaced: string[];
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** The group's status (see `AppStore`): a duplicate shows its preferred row's. */
  readonly status: JobStatus;
  readonly note: string;
  readonly appliedAt: string | null;
  /** When a run's notification announced this job (m8); null until then. */
  readonly notifiedAt: string | null;
  /** Review I2: the fact ids the current documents cite, sorted; null when not known (yet). */
  readonly citedFacts: string[] | null;
  readonly band: Band;
}

export interface JobDetail extends JobView {
  readonly sources: { source: string; sourceId: string }[];
  readonly docs: Doc[];
  /** This row's status history; a group status change is recorded on every row of the group. */
  readonly history: { from: JobStatus | null; to: JobStatus; at: string; by: 'user' | 'migration' }[];
}

/** One applied snapshot: the files the user sent on `day` (`applied-<day>/`), read-only, with their sha256. */
export interface SnapshotFile {
  readonly kind: Doc['kind'];
  readonly format: Doc['format'];
  /** Relative to the out root: `<jobKey>/applied-<day>/<kind>.<format>`. */
  readonly path: string;
  readonly sha256: string;
}
export interface Snapshot {
  readonly day: string;
  readonly at: string;
  readonly files: SnapshotFile[];
}
export type HistoryEntry = JobDetail['history'][number];

export interface JobFilter {
  readonly status?: readonly JobStatus[];
  /** Default `DEFAULT_BANDS`: rejected and below-floor jobs appear only when asked for. */
  readonly band?: readonly Band[];
  /** Rows without a score never pass a minimum. */
  readonly minScore?: number;
  /** Case-insensitive substring of company or title. */
  readonly text?: string;
  /** The comp floor in INR per year; a disclosed maximum under it is `below-floor`. Omitted: no comp floor. */
  readonly floorInr?: number;
  /** Also list duplicate listings (rows with `duplicateOf` set). Default false. */
  readonly duplicates?: boolean;
  /** Only the jobs of this registry company (the Companies tab's links), matched by `jobOfCompany` (its key, board or name). */
  readonly companyOf?: CompanyJobs;
}

/** One page of the jobs list (`listJobsPage`). */
export interface JobsPage {
  readonly jobs: JobView[];
  readonly page: number;
  readonly pages: number;
  readonly total: number;
  readonly newCount: number;
  readonly hiddenCount: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly at: string;
  readonly counts: unknown;
  readonly packHash: string;
  readonly policyHash: string;
  /** Run warnings (a crashed run left alone, a notifier failure, …). */
  readonly warnings?: readonly string[];
  /** The run's problems (`runProblems`): failed, gone, input-rejected, skipped and quarantined items. */
  readonly problems?: readonly unknown[];
}

interface JobRowDb {
  job_key: string;
  source: string;
  source_id: string;
  dedupe_key: string;
  duplicate_of: string | null;
  company: string;
  title: string;
  url: string;
  ats: string;
  location: string;
  remote: string | null;
  comp: string | null;
  comp_min_inr: number | null;
  comp_max_inr: number | null;
  comp_basis: 'base' | 'unknown' | null;
  score: number | null;
  breakdown: string | null;
  verdict: Verdict | null;
  reasons: string;
  notes: string;
  jd_text: string;
  terms: string | null;
  recommended_format: 'pdf' | 'docx' | null;
  docs_state: DocsState;
  docs_detail: string | null;
  posted_at: string | null;
  unplaced: string;
  first_seen: string;
  last_seen: string;
  status: JobStatus;
  note: string;
  applied_at: string | null;
  notified_at: string | null;
  cited_facts: string | null;
}

/** Every jobs column but the description (`jd_text`): what the jobs list reads (dashboard-perf fix 2). */
const LEAN_COLUMNS = [
  'job_key', 'source', 'source_id', 'dedupe_key', 'duplicate_of', 'company', 'title', 'url', 'ats', 'location', 'remote', 'comp', 'comp_min_inr',
  'comp_max_inr', 'comp_basis', 'score', 'breakdown', 'verdict', 'reasons', 'notes', 'terms', 'recommended_format', 'docs_state', 'docs_detail',
  'posted_at', 'unplaced', 'first_seen', 'last_seen', 'status', 'note', 'applied_at', 'notified_at', 'cited_facts',
].join(', ');
const ALL_BANDS: readonly Band[] = ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'];

/**
 * The jobs list's SQL functions, on this connection (once): the JS rules `listJobs` applies, so the SQL path cannot
 * drift from them. Deterministic, pure, no I/O.
 * - `jp_text_match(company, title, q)`: `company.toLowerCase().includes(q) || title.toLowerCase().includes(q)` (q lower-cased).
 * - `jp_job_of_company(company, url, source, source_id, norm, domain, board)`: `jobOfCompany(jobKeys(row), {norm, domain, board})`.
 * - `jp_epoch_ms(iso)`: `Date.parse(iso)`, NULL when it does not parse (`NaN > x` is false, as NULL is in SQL).
 */
const LIST_FUNCTIONS = new WeakSet<object>();
function registerListFunctions(db: import('better-sqlite3').Database): void {
  if (LIST_FUNCTIONS.has(db)) return;
  const opts = { deterministic: true, directOnly: true } as const;
  db.function('jp_text_match', opts, (company: unknown, title: unknown, q: unknown) =>
    String(company).toLowerCase().includes(String(q)) || String(title).toLowerCase().includes(String(q)) ? 1 : 0,
  );
  db.function('jp_job_of_company', opts, (company: unknown, url: unknown, source: unknown, sourceId: unknown, norm: unknown, domain: unknown, board: unknown) =>
    jobOfCompany(jobKeys({ company: String(company), url: String(url), source: String(source), sourceId: String(sourceId) }), {
      norm: String(norm),
      domain: domain === null ? null : String(domain),
      board: board === null ? null : String(board),
    })
      ? 1
      : 0,
  );
  db.function('jp_epoch_ms', opts, (iso: unknown) => {
    const ms = Date.parse(String(iso));
    return Number.isNaN(ms) ? null : ms;
  });
  LIST_FUNCTIONS.add(db);
}

/** Job keys per envelope query in `contractPostings` (well under SQLite's bound-parameter limit). */
const POSTING_BATCH = 500;
/** How far back a stored daily contract job is still seeded as a board gig. */
export const BOARD_SEED_DAYS = 14;

const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));
const parse = <T>(s: string | null): T | null => (s === null ? null : (JSON.parse(s) as T));
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Run-owned columns, in the order `runParams` binds them. */
const RUN_COLUMNS = [
  'dedupe_key', 'company', 'title', 'url', 'ats', 'location', 'remote', 'comp', 'comp_min_inr', 'comp_max_inr', 'comp_basis', 'score',
  'breakdown', 'verdict', 'reasons', 'notes', 'jd_text', 'terms', 'recommended_format', 'docs_state', 'docs_detail', 'posted_at',
  'unplaced',
] as const;

function runParams(r: JobUpsert): unknown[] {
  return [
    r.dedupeKey, r.company, r.title, r.url, r.ats, r.location, json(r.remote), json(r.comp ?? null), r.compMinInr, r.compMaxInr, r.compBasis,
    r.score, json(r.breakdown), r.verdict, JSON.stringify(r.reasons), JSON.stringify(r.notes), r.jdText, json(r.terms), r.recommendedFormat,
    r.docsState, r.docsDetail, r.postedAt, JSON.stringify([...(r.unplaced ?? [])].sort()),
  ];
}

function assertStatus(s: string): asserts s is JobStatus {
  if (!(JOB_STATUSES as readonly string[]).includes(s)) throw new Error(`invalid job status ${s}; expected one of ${JOB_STATUSES.join(', ')}`);
}

/** A company's name as the ATS-id match compares it (the coverage name matcher's), or '' for a generic name (never matched). */
function companyNormOf(company: string): string {
  const n = normalCompanyName(company);
  return GENERIC_LABELS.has(n.replace(/ /gu, '')) ? '' : n;
}

interface LinkRowDb {
  job_key: string;
  source: string;
  first_seen: string;
  dedupe_key: string;
  duplicate_of: string | null;
  platform: AtsIdPlatform | null;
  board: string | null;
  ats_id: string | null;
  slug: string | null;
  company_norm: string | null;
  notified_at: string | null;
  t_board: string | null;
  t_id: string | null;
  t_company: string | null;
}
const LINK_COLUMNS = `j.job_key, j.source, j.first_seen, j.dedupe_key, j.duplicate_of, a.platform, a.board, a.ats_id, a.slug, a.company_norm, j.notified_at, b.board AS t_board, b.platform_id AS t_id, b.company_norm AS t_company`;
const LINK_FROM = `jobs j LEFT JOIN job_ats a ON a.job_key = j.job_key LEFT JOIN job_board_ids b ON b.job_key = j.job_key`;

/**
 * The app catalogue, beside the kernel's tables in the same DB file.
 *
 * - **One posting, one job.** The row identity is `jobKey(source, sourceId)`: two postings from one source are two jobs
 *   even with the same title, and a re-emitted posting is a newer version of its row (an upsert).
 * - **Cross-source duplicates.** Rows with one `dedupe_key` from *different* sources are one job listed twice. All are
 *   kept; every row whose source differs from the group's preferred row (`preferred`: ATS over feed, then earliest
 *   first_seen, then job key) points at it through `duplicate_of`. Rows from the preferred row's own source stay
 *   separate jobs. `listJobs` hides duplicates by default and gives the preferred row `alsoListedOn`.
 * - **One job through two sources (Task 10).** Rows of one company with the same ATS job id (`job_ats`, from
 *   `atsRefOf(posting)`: a company page's `gh_jid` and the Greenhouse board job, a Workday req id) are one job too, the
 *   earliest first_seen primary; see `linkJobs` (store/links.ts) for the exact rule, which falls back to the dedupe key
 *   unchanged. Every write re-links the closure of the rows it touches (their dedupe groups and their companies' ATS
 *   rows), so the result does not depend on the order rows arrive in.
 * - **User-owned columns.** Runs write only run-owned columns (`upsertJob`). Status and note belong to the user and
 *   live on the preferred row: `setStatus` and `setNote` on any row of a group write the whole group (history on the
 *   preferred row), and every row shows the group's status (the furthest, for rows imported with different ones) and
 *   its distinct notes joined.
 */
export class AppStore {
  private constructor(
    readonly kernel: Store,
    private readonly owned: boolean,
  ) {}

  /** Opens the DB file: the kernel's migrations first (through `Store.open`), then the app's. `close` closes both. */
  /**
   * The DB file lives in the jobpilot home. Its directory is never chmodded (see `app/home.ts`); an open home, or a DB
   * file jobpilot may not tighten, gets one warning per process. The DB itself is 0600 (`Store.open`).
   */
  static open(path: string, opts: { readonly timeoutMs?: number } = {}): AppStore {
    const onDisk = path !== ':memory:' && path !== '';
    if (onDisk) checkHome(dirname(path));
    const kernel = Store.open(path, {
      ...opts,
      onLooseFile: (f, why) => warnOnce(why === 'link' ? fileWarning(f) : homeWarning(dirname(path))),
    });
    try {
      return AppStore.migrate(kernel, true);
    } catch (err) {
      kernel.close();
      throw err;
    }
  }

  /** The app catalogue on an already open kernel store (same connection). `close` leaves the kernel store open. */
  static on(kernel: Store): AppStore {
    return AppStore.migrate(kernel, false);
  }

  private static migrate(kernel: Store, owned: boolean): AppStore {
    const db = kernel.db;
    // Up to date: read only, so opening never waits for a run's write lock (the dashboard reads during a run).
    const current = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_schema'`).get() !== undefined
      ? (db.prepare(`SELECT version FROM app_schema WHERE id = 1`).get() as { version: number } | undefined)?.version
      : undefined;
    if (current === APP_MIGRATIONS.length) return new AppStore(kernel, owned);
    db.exec(`CREATE TABLE IF NOT EXISTS app_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
    db.prepare(`INSERT OR IGNORE INTO app_schema (id, version) VALUES (1, 0)`).run();
    const readVersion = (): number => {
      const v = (db.prepare(`SELECT version FROM app_schema WHERE id = 1`).get() as { version: number }).version;
      if (v > APP_MIGRATIONS.length) throw new Error(`app schema version ${v} is newer than this jobpilot (${APP_MIGRATIONS.length})`);
      return v;
    };
    // Final review I2: concurrent openers (the dashboard, a run, a CLI command) serialise. Each migration runs in a
    // BEGIN IMMEDIATE transaction that reads the version again first and applies only if it is still the one this
    // opener expected; an opener that lost the race sees the new version and applies nothing.
    for (let v = readVersion(); v < APP_MIGRATIONS.length; v = readVersion()) {
      const m = APP_MIGRATIONS[v] ?? '';
      const step = (): void => {
        if (readVersion() !== v) return; // another opener applied it while this one waited for the write lock
        if (typeof m === 'string') db.exec(m);
        else {
          m.run(db);
          const broken = db.pragma('foreign_key_check') as unknown[];
          if (broken.length > 0) throw new Error(`app migration ${v + 1} would break ${broken.length} foreign keys`);
        }
        db.prepare(`UPDATE app_schema SET version = ? WHERE id = 1`).run(v + 1);
      };
      if (typeof m === 'string') {
        db.transaction(step).immediate();
        continue;
      }
      // A table rebuild: foreign keys off around the transaction (they cannot change inside one), checked before commit.
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(step).immediate();
      } finally {
        db.pragma('foreign_keys = ON');
      }
    }
    return new AppStore(kernel, owned);
  }

  close(): void {
    if (this.owned) this.kernel.close();
  }

  schemaVersion(): number {
    return (this.kernel.db.prepare(`SELECT version FROM app_schema WHERE id = 1`).get() as { version: number }).version;
  }

  private get db() {
    return this.kernel.db;
  }

  tx<T>(fn: () => T): T {
    return this.kernel.tx(fn);
  }

  private row(jobKey: string): JobRowDb | undefined {
    return this.db.prepare(`SELECT * FROM jobs WHERE job_key = ?`).get(jobKey) as JobRowDb | undefined;
  }

  /** The posting must not already be another job, and the job key must not belong to another posting. */
  private assertIdentity(r: Pick<JobUpsert, 'jobKey' | 'source' | 'sourceId'>, existing: JobRowDb | undefined): void {
    const other = this.db.prepare(`SELECT job_key FROM job_sources WHERE source = ? AND source_id = ?`).get(r.source, r.sourceId) as
      | { job_key: string }
      | undefined;
    if (other && other.job_key !== r.jobKey) throw new Error(`posting ${r.source}:${r.sourceId} is already job ${other.job_key}, not ${r.jobKey}`);
    if (existing && (existing.source !== r.source || existing.source_id !== r.sourceId)) {
      throw new Error(`job ${r.jobKey} is posting ${existing.source}:${existing.source_id}, not ${r.source}:${r.sourceId}`);
    }
  }

  private insert(r: JobUpsert, user: { status: JobStatus; note: string; appliedAt: string | null } | undefined): void {
    this.db
      .prepare(
        `INSERT INTO jobs (job_key, source, source_id, ${RUN_COLUMNS.join(', ')}, first_seen, last_seen, status, note, applied_at)
         VALUES (?, ?, ?, ${RUN_COLUMNS.map(() => '?').join(', ')}, ?, ?, ?, ?, ?)`,
      )
      .run(r.jobKey, r.source, r.sourceId, ...runParams(r), r.at, r.at, user?.status ?? 'new', user?.note ?? '', user?.appliedAt ?? null);
    this.db.prepare(`INSERT INTO job_sources (job_key, source, source_id) VALUES (?, ?, ?)`).run(r.jobKey, r.source, r.sourceId);
  }

  /**
   * Inserts the job, or updates its run-owned columns and `last_seen` (never `status`, `note`, `applied_at` or
   * `first_seen`), then re-links its dedupe group (and its old one, when the dedupe key changed). An observation older
   * than the row's `last_seen` is `stale` and changes nothing: an older run never overwrites newer data, and
   * `last_seen` never moves backwards. The same time again (re-projecting one run) is applied.
   */
  upsertJob(r: JobUpsert): { jobKey: string; inserted: boolean; stale: boolean; notes?: string[] } {
    return this.tx(() => {
      const cur = this.row(r.jobKey);
      this.assertIdentity(r, cur);
      if (cur && r.at < cur.last_seen) return { jobKey: r.jobKey, inserted: false, stale: true };
      if (cur) {
        this.db
          .prepare(`UPDATE jobs SET ${RUN_COLUMNS.map((c) => `${c} = ?`).join(', ')}, last_seen = ? WHERE job_key = ?`)
          .run(...runParams(r), r.at, r.jobKey);
      } else {
        this.insert(r, undefined);
      }
      const companies = [...this.putAts(r), ...this.putBoardId(r)];
      const notes = this.relink([r.dedupeKey, ...(cur && cur.dedupe_key !== r.dedupeKey ? [cur.dedupe_key] : [])], companies);
      return { jobKey: r.jobKey, inserted: !cur, stale: false, ...(notes.length > 0 ? { notes } : {}) };
    });
  }

  /**
   * Task 10: records (or clears) the job's ATS id in `job_ats`; returns the companies whose ATS rows must be re-linked
   * (the new one and, when it changed, the old one).
   */
  private putAts(r: JobUpsert): string[] {
    const old = this.db.prepare(`SELECT company_norm FROM job_ats WHERE job_key = ?`).get(r.jobKey) as { company_norm: string } | undefined;
    this.db.prepare(`DELETE FROM job_ats WHERE job_key = ?`).run(r.jobKey);
    const companyNorm = companyNormOf(r.company);
    const a = r.atsJob;
    const out = old === undefined ? [] : [old.company_norm];
    if (a === undefined || a === null || companyNorm === '') return out;
    this.db
      .prepare(`INSERT INTO job_ats (job_key, platform, board, ats_id, slug, company_norm) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(r.jobKey, a.platform, a.board, a.id, r.slug ?? '', companyNorm);
    return old?.company_norm === companyNorm ? out : [...out, companyNorm];
  }

  /**
   * Fix round 5: records (or clears) a tenant-scoped posting's board ref and platform id in `job_board_ids`; returns the
   * companies whose rows must be re-linked (the new one and, when it changed, the old one).
   */
  private putBoardId(r: JobUpsert): string[] {
    const old = this.db.prepare(`SELECT company_norm FROM job_board_ids WHERE job_key = ?`).get(r.jobKey) as { company_norm: string } | undefined;
    this.db.prepare(`DELETE FROM job_board_ids WHERE job_key = ?`).run(r.jobKey);
    const companyNorm = companyNormOf(r.company);
    const t = splitPostingSourceId(r.source, r.sourceId);
    const out = old === undefined ? [] : [old.company_norm];
    if (t === null || companyNorm === '') return out;
    this.db.prepare(`INSERT INTO job_board_ids (job_key, source, board, platform_id, company_norm) VALUES (?, ?, ?, ?, ?)`).run(r.jobKey, r.source, t.board, t.id, companyNorm);
    return old?.company_norm === companyNorm ? out : [...out, companyNorm];
  }

  /**
   * Fix round 5: the registry's CURRENT boards (`registryBoards(verifiedCompanies())`: verified, approved or failing,
   * never rejected), which tell one job under a retired board ref (linked) from two live tenants of one company (never
   * linked). The daily run sets it before projecting; without it no board-ref link is made (uncertain: never merge).
   */
  useRegistryBoards(boards: readonly { readonly platform: string; readonly company: string; readonly ref: string }[]): void {
    const m = new Map<string, Set<string>>();
    for (const b of boards) {
      const k = `${companyNormOf(b.company)}\u0000${b.platform}`;
      m.set(k, (m.get(k) ?? new Set()).add(boardRefOf(b.ref)));
    }
    this.currentBoards = m;
  }

  private currentBoards: Map<string, Set<string>> | null = null;

  /**
   * Migration only. A new posting is inserted with the Desk's status, note and applied_at and a `migration` history
   * entry (`inserted`). A posting a run found first, whose group's status nobody ever set (no history on any row of
   * its cross-source group), takes them too (`attached`). Otherwise it is left alone (`present`): a re-run, or the
   * user's own word.
   */
  importJob(r: JobImport): 'inserted' | 'attached' | 'present' {
    assertStatus(r.status);
    return this.tx(() => {
      const cur = this.row(r.jobKey);
      this.assertIdentity(r, cur);
      let outcome: 'inserted' | 'attached' | 'present';
      if (!cur) {
        this.insert(r, { status: r.status, note: r.note, appliedAt: r.appliedAt });
        this.history(r.jobKey, null, r.status, r.statusAt, 'migration');
        outcome = 'inserted';
      } else if (!this.groupHasHistory(r.jobKey)) {
        this.db
          .prepare(`UPDATE jobs SET status = ?, note = ?, applied_at = ? WHERE job_key = ?`)
          .run(r.status, cur.note === '' ? r.note : cur.note, cur.applied_at ?? r.appliedAt, r.jobKey);
        this.history(r.jobKey, cur.status, r.status, r.statusAt, 'migration');
        outcome = 'attached';
      } else {
        outcome = 'present';
      }
      // A Desk row is a job the user already knows: it is never announced as new (R-I2).
      if (outcome !== 'present') this.db.prepare(`UPDATE jobs SET notified_at = ? WHERE job_key = ? AND notified_at IS NULL`).run(r.statusAt, r.jobKey);
      this.relink([r.dedupeKey], []);
      return outcome;
    });
  }

  /** Whether any row of the job's group has a status history entry (the user, or an earlier import, decided). */
  private groupHasHistory(jobKey: string): boolean {
    const { top, dups } = this.group(jobKey);
    const keys = [top, ...dups].map((r) => r.job_key);
    return this.db.prepare(`SELECT 1 FROM status_history WHERE job_key IN (${keys.map(() => '?').join(', ')}) LIMIT 1`).get(...keys) !== undefined;
  }

  /**
   * Recomputes `duplicate_of` over the closure of the given dedupe groups and companies: every row of a dedupe group in
   * it, every ATS-id row of a company in it, until nothing new joins (so a job linked through either rule is always
   * re-linked whole). Returns the ATS-id collision notes (`linkJobs`).
   */
  private relink(dedupeKeys: readonly string[], companies: readonly string[]): string[] {
    const rows = new Map<string, LinkRowDb>();
    const doneDedupe = new Set<string>();
    const doneCompany = new Set<string>();
    const dq = [...dedupeKeys];
    const cq = [...companies];
    const byDedupe = this.db.prepare(`SELECT ${LINK_COLUMNS} FROM ${LINK_FROM} WHERE j.dedupe_key = ?`);
    const byCompany = this.db.prepare(`SELECT ${LINK_COLUMNS} FROM ${LINK_FROM} WHERE a.company_norm = ? OR b.company_norm = ?`);
    const add = (list: LinkRowDb[]): void => {
      for (const r of list) {
        if (rows.has(r.job_key)) continue;
        rows.set(r.job_key, r);
        dq.push(r.dedupe_key);
        if (r.company_norm !== null) cq.push(r.company_norm);
        if (r.t_company !== null) cq.push(r.t_company);
      }
    };
    // A row's old group is inside this closure: every link was made over the same two relations, and a write that
    // changes a row's dedupe key or company seeds the old ones too (upsertJob, putAts).
    while (dq.length > 0 || cq.length > 0) {
      for (const d of dq.splice(0)) if (!doneDedupe.has(d)) (doneDedupe.add(d), add(byDedupe.all(d) as LinkRowDb[]));
      for (const c of cq.splice(0)) if (!doneCompany.has(c) && c !== '') (doneCompany.add(c), add(byCompany.all(c, c) as LinkRowDb[]));
    }
    if (rows.size === 0) return [];
    const linkRows: LinkRow[] = [...rows.values()].map((r) => ({
      jobKey: r.job_key,
      source: r.source,
      firstSeen: r.first_seen,
      dedupeKey: r.dedupe_key,
      ats: r.platform === null || r.ats_id === null || r.company_norm === null ? null : { platform: r.platform, board: r.board, id: r.ats_id, slug: r.slug ?? '', companyNorm: r.company_norm },
      tenant: r.t_board === null || r.t_id === null || r.t_company === null ? null : { board: r.t_board, id: r.t_id, companyNorm: r.t_company },
    }));
    const current = this.currentBoards;
    const { duplicateOf, notes, slots } = linkJobs(
      linkRows,
      (companyNorm, platform) => this.registryBoards(companyNorm, platform),
      current === null ? null : (companyNorm, source) => current.get(`${companyNorm}\u0000${source}`) ?? new Set(),
    );
    const set = this.db.prepare(`UPDATE jobs SET duplicate_of = ? WHERE job_key = ?`);
    // Fix rounds 1-2 (I2b): announced never regresses for the same job. A row whose group changes carries its old
    // group's earliest announcement, unless its ATS id proves it another job (another id of the company within its
    // `idScope`: any board for Greenhouse, Lever, Ashby, the same board otherwise): that one is announced on its own.
    const oldGroups = new Map<string, LinkRowDb[]>();
    for (const r of rows.values()) {
      const root = r.duplicate_of ?? r.job_key;
      oldGroups.set(root, [...(oldGroups.get(root) ?? []), r]);
    }
    const stamp = this.db.prepare(`UPDATE jobs SET notified_at = ? WHERE job_key = ? AND notified_at IS NULL`);
    for (const r of [...rows.values()].sort((a, b) => cmp(a.job_key, b.job_key))) {
      const dup = duplicateOf.get(r.job_key) ?? null;
      if (dup === r.duplicate_of) continue;
      set.run(dup, r.job_key);
      // the row itself may stay in: its own id never contradicts itself, and its own time is NULL here (else no stamp)
      const others = oldGroups.get(r.duplicate_of ?? r.job_key) ?? [];
      const mine = slots.get(r.job_key);
      const another = mine !== undefined && others.some((m) => slots.get(m.job_key)?.scope === mine.scope && slots.get(m.job_key)?.id !== mine.id);
      // fix round 6: leaving a retired-ref link, the row carries the announcement only with its partner's title and place
      // (its dedupe key); else it is another job. A partner is another row of its source: rows of one source share a
      // group only through such a link (or a Workday ATS key), never on one board (v1 and the collision rule keep those
      // apart), so no board or id test is needed
      const partners = r.t_id === null ? [] : others.filter((m) => m !== r && m.source === r.source);
      const retitled = partners.length > 0 && !partners.some((m) => m.dedupe_key === r.dedupe_key);
      const was = others.map((m) => m.notified_at).filter((n): n is string => n !== null).sort()[0];
      if (was !== undefined && !another && !retitled) stamp.run(was, r.job_key);
    }
    return notes;
  }

  /**
   * Task 10: the boards of `platform` that the verified registry (verified or failing, never rejected) names for the
   * company (by the name matcher's normalisation): with the company's other rows, how a bare `gh_jid` finds its board.
   */
  private registryBoards(companyNorm: string, platform: AtsIdPlatform): string[] {
    // only a bare gh_jid is board-less (text/ats-id.ts); Greenhouse board tokens are case-insensitive
    if (platform !== 'greenhouse') return [];
    const rows = this.db
      .prepare(`SELECT name, platform_slug FROM companies WHERE platform = ? AND platform_slug IS NOT NULL AND status IN ('verified', 'failing') AND (user_override IS NULL OR user_override <> 'rejected')`)
      .all(platform) as { name: string; platform_slug: string }[];
    return rows.filter((r) => companyNormOf(r.name) === companyNorm).map((r) => r.platform_slug.trim().toLowerCase());
  }

  private history(jobKey: string, from: JobStatus | null, to: JobStatus, at: string, by: 'user' | 'migration'): void {
    this.db.prepare(`INSERT INTO status_history (job_key, "from", "to", at, by) VALUES (?, ?, ?, ?, ?)`).run(jobKey, from, to, at, by);
  }

  /** The preferred row of `jobKey`'s group and the rows that point at it. */
  private group(jobKey: string): { top: JobRowDb; dups: JobRowDb[] } {
    const r = this.row(jobKey);
    if (!r) throw new Error(`unknown job ${jobKey}`);
    const top = r.duplicate_of === null ? r : (this.row(r.duplicate_of) as JobRowDb);
    const dups = this.db.prepare(`SELECT * FROM jobs WHERE duplicate_of = ? ORDER BY job_key`).all(top.job_key) as JobRowDb[];
    return { top, dups };
  }

  /**
   * Sets the user status of the job's whole group (the preferred row and its duplicates). Every row shows the group's
   * status, so when that changes each row gets its own history entry, and a row that later leaves the group still has
   * the history of the status it carries. Returns false (and records nothing) when every row already has `to`.
   */
  setStatus(jobKey: string, to: JobStatus, by: 'user' | 'migration', at: string): boolean {
    assertStatus(to);
    return this.tx(() => {
      const { top, dups } = this.group(jobKey);
      const rows = [top, ...dups];
      if (rows.every((r) => r.status === to)) return false;
      const shown = groupStatus(rows);
      const set = this.db.prepare(`UPDATE jobs SET status = ? WHERE job_key = ?`);
      // The first time the group becomes applied is its applied date (a Desk import keeps its own).
      const stamp = to === 'applied' && rows.every((r) => r.applied_at === null);
      for (const r of rows) {
        set.run(to, r.job_key);
        if (stamp) this.db.prepare(`UPDATE jobs SET applied_at = ? WHERE job_key = ?`).run(at, r.job_key);
        if (shown !== to) this.history(r.job_key, shown, to, at, by);
      }
      return true;
    });
  }

  /** Sets the note of the job's whole group. */
  setNote(jobKey: string, note: string): void {
    this.tx(() => {
      const { top, dups } = this.group(jobKey);
      const set = this.db.prepare(`UPDATE jobs SET note = ? WHERE job_key = ?`);
      for (const r of [top, ...dups]) set.run(note, r.job_key);
    });
  }

  /** Replaces the job's documents with `docs` (an empty list clears them). */
  /**
   * Replaces a job's documents. `citedFacts` (review I2): the fact ids they cite, when the caller knows them; otherwise
   * they are unknown (NULL) until `citedFactsFromKernel` finds the rendered plan behind the files.
   */
  putDocs(jobKey: string, docs: readonly Doc[], citedFacts: readonly string[] | null = null): void {
    this.tx(() => {
      this.db.prepare(`DELETE FROM job_docs WHERE job_key = ?`).run(jobKey);
      const ins = this.db.prepare(`INSERT INTO job_docs (job_key, kind, format, path, sha256, pages, qa_ok) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const d of docs) ins.run(jobKey, d.kind, d.format, d.path, d.sha256, d.pages, d.qaOk ? 1 : 0);
      this.setCitedFacts(jobKey, docs.length === 0 ? [] : citedFacts);
    });
  }

  /** Review I2: records the fact ids a job's current documents cite (sorted, unique), or NULL for unknown. */
  setCitedFacts(jobKey: string, ids: readonly string[] | null): void {
    this.db.prepare(`UPDATE jobs SET cited_facts = ? WHERE job_key = ?`).run(ids === null ? null : JSON.stringify([...new Set(ids)].sort()), jobKey);
  }

  /** Review I2: sets only the docs state and detail (the stale pass); the documents themselves are kept. */
  setDocsState(jobKey: string, state: DocsState, detail: string | null): void {
    this.db.prepare(`UPDATE jobs SET docs_state = ?, docs_detail = ? WHERE job_key = ?`).run(state, detail, jobKey);
  }

  /**
   * Review I2: the plan behind a job's current documents, from the kernel's stored `Rendered` envelopes (same
   * connection, read only): the one whose files are exactly the job's recorded documents (path and sha256).
   */
  renderedPlanOf(jobKey: string): unknown {
    const want = (this.db.prepare(`SELECT path, sha256 FROM job_docs WHERE job_key = ? ORDER BY path`).all(jobKey) as { path: string; sha256: string }[])
      .map((d) => `${d.path}\u0000${d.sha256}`)
      .join('\n');
    if (want === '') return undefined;
    const rows = this.db
      .prepare(`SELECT body FROM envelopes WHERE type = 'Rendered@1' AND json_extract(body, '$.payload.jobKey') = ? ORDER BY envelope_id`)
      .all(jobKey) as { body: string }[];
    for (const r of rows) {
      const p = (JSON.parse(r.body) as { payload?: { files?: { path: string; sha256: string }[]; plan?: unknown } }).payload;
      const got = (p?.files ?? []).map((f) => `${f.path}\u0000${f.sha256}`).sort().join('\n');
      if (got === want) return p?.plan;
    }
    return undefined;
  }

  getJob(jobKey: string): JobDetail | undefined {
    const row = this.row(jobKey);
    if (!row) return undefined;
    const { top, dups } = this.group(jobKey);
    const docs = (
      this.db.prepare(`SELECT kind, format, path, sha256, pages, qa_ok FROM job_docs WHERE job_key = ? ORDER BY kind, format`).all(jobKey) as {
        kind: Doc['kind'];
        format: Doc['format'];
        path: string;
        sha256: string;
        pages: number | null;
        qa_ok: number;
      }[]
    ).map((d) => ({ kind: d.kind, format: d.format, path: d.path, sha256: d.sha256, pages: d.pages, qaOk: d.qa_ok === 1 }));
    const history = this.db.prepare(`SELECT "from", "to", at, by FROM status_history WHERE job_key = ? ORDER BY seq`).all(jobKey) as JobDetail['history'];
    return { ...view(row, top, dups), sources: [{ source: row.source, sourceId: row.source_id }], docs, history };
  }

  /**
   * Comp-first (spec §7): disclosed comp at or above the floor by max INR desc, then undisclosed, then review; within
   * each band by score desc (no score last), then first_seen desc, then job key, a total order. Rejected and
   * below-floor jobs follow in that band order only when `filter.band` names them; duplicate listings only when
   * `filter.duplicates` is set.
   */
  listJobs(filter: JobFilter = {}): JobView[] {
    const bands = new Set(filter.band ?? DEFAULT_BANDS);
    const statuses = filter.status === undefined ? undefined : new Set<string>(filter.status);
    const text = filter.text?.toLowerCase();
    const company = filter.companyOf === undefined ? undefined : companyKeys(filter.companyOf);
    const all = this.db.prepare(`SELECT * FROM jobs ORDER BY job_key`).all() as JobRowDb[];
    const byKey = new Map(all.map((r) => [r.job_key, r]));
    const dupsOf = new Map<string, JobRowDb[]>();
    for (const r of all) if (r.duplicate_of !== null) dupsOf.set(r.duplicate_of, [...(dupsOf.get(r.duplicate_of) ?? []), r]);
    const rows = all
      .filter((r) => filter.duplicates === true || r.duplicate_of === null)
      .map((r) => {
        const top = r.duplicate_of === null ? r : (byKey.get(r.duplicate_of) as JobRowDb);
        return view(r, top, dupsOf.get(top.job_key) ?? [], filter.floorInr);
      });
    return rows
      .filter((j) => bands.has(j.band))
      .filter((j) => statuses === undefined || statuses.has(j.status))
      .filter((j) => filter.minScore === undefined || (j.score !== null && j.score >= filter.minScore))
      .filter((j) => text === undefined || j.company.toLowerCase().includes(text) || j.title.toLowerCase().includes(text))
      .filter((j) => company === undefined || jobOfCompany(jobKeys(j), company))
      .sort(
        (a, b) =>
          BAND_RANK[a.band] - BAND_RANK[b.band] ||
          (a.band === 'disclosed' ? (b.compMaxInr ?? 0) - (a.compMaxInr ?? 0) : 0) ||
          (b.score ?? -Infinity) - (a.score ?? -Infinity) ||
          cmp(b.firstSeen, a.firstSeen) ||
          cmp(a.jobKey, b.jobKey),
      );
  }

  /**
   * dashboard-perf fix 2: one page of `listJobs(filter)` and its counts, with the band, every filter, the sort, the
   * paging and the counts done in SQL over the list's columns only (never the description, `jd_text`, which holds most
   * of the table's bytes in overflow pages). The same rows in the same order as `listJobs(filter).slice(...)` (pinned by
   * tests/app/jobs-page.test.ts), every `JobView` field but `jdText`, which is ''.
   *
   * - `page` is clamped to 1..pages; `pages` is at least 1. Offset paging: the dashboard has numbered pages, and the
   *   offset walks the covering index `jobs_list` (migration 16), not the table.
   * - `newCount`: the listed rows first seen after `newAfterMs` (epoch ms, as `Date.parse`).
   * - `hiddenCount`: the rows every other filter passes whose band is not listed (the "N hidden" line).
   * - Only the shown rows and their groups' rows are read in full (by key).
   */
  listJobsPage(filter: JobFilter, opts: { readonly page: number; readonly size: number; readonly newAfterMs: number }): JobsPage {
    registerListFunctions(this.db);
    const listed = new Set(filter.band ?? DEFAULT_BANDS);
    const where: string[] = [];
    const args: Record<string, unknown> = { floor: filter.floorInr ?? null };
    if (filter.duplicates !== true) where.push('j.duplicate_of IS NULL');
    if (filter.minScore !== undefined) {
      where.push('j.score >= @minScore');
      args['minScore'] = filter.minScore;
    }
    if (filter.text !== undefined) {
      where.push('jp_text_match(j.company, j.title, @text) = 1');
      args['text'] = filter.text.toLowerCase();
    }
    if (filter.companyOf !== undefined) {
      const c = companyKeys(filter.companyOf);
      where.push('jp_job_of_company(j.company, j.url, j.source, j.source_id, @cNorm, @cDomain, @cBoard) = 1');
      Object.assign(args, { cNorm: c.norm, cDomain: c.domain, cBoard: c.board });
    }
    if (filter.status !== undefined) {
      // the group's status: the furthest of the preferred row's and its duplicates' (`groupStatus`)
      const prec = (col: string): string => `CASE ${col} ${JOB_STATUSES.map((st) => `WHEN '${st}' THEN ${STATUS_PRECEDENCE[st]}`).join(' ')} END`;
      const wanted = [...new Set(filter.status)].map((st) => STATUS_PRECEDENCE[st]);
      where.push(
        `MAX(${prec(`CASE WHEN j.duplicate_of IS NULL THEN j.status ELSE (SELECT t.status FROM jobs t WHERE t.job_key = j.duplicate_of) END`)},
             COALESCE((SELECT MAX(${prec('d.status')}) FROM jobs d WHERE d.duplicate_of = COALESCE(j.duplicate_of, j.job_key)), -1))
         IN (${wanted.length === 0 ? 'NULL' : wanted.join(', ')})`,
      );
    }
    // `bandOf`, as a rank (BAND_RANK)
    const band = `CASE WHEN j.verdict = 'rejected' THEN 4 WHEN j.docs_state = 'below-floor' THEN 3 WHEN j.verdict = 'eligible' THEN
      CASE WHEN j.comp_max_inr IS NULL THEN 1 WHEN @floor IS NOT NULL AND j.comp_max_inr < @floor THEN 3 ELSE 0 END ELSE 2 END`;
    const base = `SELECT j.job_key, j.score, j.first_seen, j.comp_max_inr, ${band} AS band FROM jobs j${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}`;
    const counts = this.db
      .prepare(`SELECT band, COUNT(*) AS n, SUM(CASE WHEN jp_epoch_ms(first_seen) > @newAfter THEN 1 ELSE 0 END) AS fresh FROM (${base}) GROUP BY band`)
      .all({ ...args, newAfter: opts.newAfterMs }) as { band: number; n: number; fresh: number }[];
    const ranks = ALL_BANDS.filter((b) => listed.has(b)).map((b) => BAND_RANK[b]);
    let total = 0;
    let newCount = 0;
    let hiddenCount = 0;
    for (const c of counts) {
      if (ranks.includes(c.band)) {
        total += c.n;
        newCount += c.fresh;
      } else hiddenCount += c.n;
    }
    const pages = Math.max(1, Math.ceil(total / opts.size));
    const page = Math.min(Math.max(1, opts.page), pages);
    const keys = total === 0
      ? []
      : (this.db
          .prepare(
            `SELECT job_key FROM (${base}) WHERE band IN (${ranks.join(', ')})
             ORDER BY band, CASE WHEN band = 0 THEN comp_max_inr END DESC, score DESC, first_seen DESC, job_key LIMIT @limit OFFSET @offset`,
          )
          .all({ ...args, limit: opts.size, offset: (page - 1) * opts.size }) as { job_key: string }[]).map((r) => r.job_key);
    return { jobs: this.leanViews(keys, filter.floorInr), page, pages, total, newCount, hiddenCount };
  }

  /**
   * dashboard-perf: what the Companies tab matches jobs on (`jobKeys`) and counts, for every listed job (no duplicate
   * listing) of every band, by job key: `listJobs({ band: every band })` without materialising whole rows. `rejected`
   * is its band (`bandOf` gives `rejected` for a rejected verdict whatever the floor).
   */
  companyJobRefs(): { jobKey: string; company: string; url: string; source: string; sourceId: string; rejected: boolean }[] {
    const rows = this.db
      .prepare(`SELECT job_key, company, url, source, source_id, verdict FROM jobs WHERE duplicate_of IS NULL ORDER BY job_key`)
      .all() as { job_key: string; company: string; url: string; source: string; source_id: string; verdict: Verdict | null }[];
    return rows.map((r) => ({ jobKey: r.job_key, company: r.company, url: r.url, source: r.source, sourceId: r.source_id, rejected: r.verdict === 'rejected' }));
  }

  /** `JobView`s of these keys, in this order, read by key without the description (`jdText` is ''). */
  private leanViews(keys: readonly string[], floorInr: number | undefined): JobView[] {
    if (keys.length === 0) return [];
    const byKeys = (col: 'job_key' | 'duplicate_of', ks: readonly string[]): JobRowDb[] =>
      ks.length === 0
        ? []
        : (this.db.prepare(`SELECT ${LEAN_COLUMNS} FROM jobs WHERE ${col} IN (${ks.map(() => '?').join(', ')}) ORDER BY job_key`).all(...ks) as Omit<JobRowDb, 'jd_text'>[]).map(
            (r) => ({ ...r, jd_text: '' }),
          );
    const rows = new Map(byKeys('job_key', keys).map((r) => [r.job_key, r]));
    const tops = new Map([...rows.values()].filter((r) => r.duplicate_of === null).map((r) => [r.job_key, r]));
    const missing = [...new Set([...rows.values()].map((r) => r.duplicate_of).filter((k): k is string => k !== null && !tops.has(k)))];
    for (const r of byKeys('job_key', missing)) tops.set(r.job_key, r);
    const dupsOf = new Map<string, JobRowDb[]>();
    for (const d of byKeys('duplicate_of', [...tops.keys()])) dupsOf.set(d.duplicate_of as string, [...(dupsOf.get(d.duplicate_of as string) ?? []), d]);
    return keys.map((k) => {
      const r = rows.get(k) as JobRowDb;
      const top = r.duplicate_of === null ? r : (tops.get(r.duplicate_of) as JobRowDb);
      return view(r, top, dupsOf.get(top.job_key) ?? [], floorInr);
    });
  }

  /** The user's fact status overrides, by fact id, for `loadPack`. */
  factOverrides(): Record<string, Fact['status']> {
    const rows = this.db.prepare(`SELECT fact_id, status FROM fact_overrides ORDER BY fact_id`).all() as { fact_id: string; status: Fact['status'] }[];
    return Object.fromEntries(rows.map((r) => [r.fact_id, r.status]));
  }

  setFactOverride(factId: string, status: Fact['status'], at: string): void {
    if (!FactStatus.safeParse(status).success) throw new Error(`invalid fact status ${String(status)}`);
    this.db
      .prepare(`INSERT INTO fact_overrides (fact_id, status, at) VALUES (?, ?, ?) ON CONFLICT (fact_id) DO UPDATE SET status = excluded.status, at = excluded.at`)
      .run(factId, status, at);
  }

  /** Marks the jobs a notification announced, once: an already announced job keeps its first time. */
  markNotified(jobKeys: readonly string[], at: string): void {
    this.tx(() => {
      const upd = this.db.prepare(`UPDATE jobs SET notified_at = ? WHERE job_key = ? AND notified_at IS NULL`);
      for (const k of jobKeys) upd.run(at, k);
    });
  }

  /** An app setting (`render.nonce`, …), or undefined when unset. */
  getSetting(key: string): string | undefined {
    return (this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  /** Drops the settings whose key starts with `prefix` but not with `keep` (exact prefixes, no LIKE wildcards). */
  pruneSettings(prefix: string, keep: string): void {
    this.db.prepare(`DELETE FROM app_settings WHERE substr(key, 1, ?) = ? AND substr(key, 1, ?) <> ?`).run(prefix.length, prefix, keep.length, keep);
  }

  /** A page adapter board's page records (Task 8, `platform_pages`), by URL. */
  pageRecords(board: string): { url: string; fetchedOn: string; hash: string; raw: string | null; errors: number }[] {
    return (this.db.prepare(`SELECT url, fetched_on, hash, raw, errors FROM platform_pages WHERE board = ? ORDER BY url`).all(board) as { url: string; fetched_on: string; hash: string; raw: string | null; errors: number }[]).map((r) => ({
      url: r.url,
      fetchedOn: r.fetched_on,
      hash: r.hash,
      raw: r.raw,
      errors: r.errors,
    }));
  }

  putPageRecord(board: string, url: string, fetchedOn: string, hash: string, raw: string | null, errors = 0): void {
    this.db
      .prepare(
        `INSERT INTO platform_pages (board, url, fetched_on, hash, raw, errors) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (board, url) DO UPDATE SET fetched_on = excluded.fetched_on, hash = excluded.hash, raw = excluded.raw, errors = excluded.errors`,
      )
      .run(board, url, fetchedOn, hash, raw, errors);
  }

  forgetPageRecord(board: string, url: string): void {
    this.db.prepare(`DELETE FROM platform_pages WHERE board = ? AND url = ?`).run(board, url);
  }

  /** Drops the board's records of URLs not in `urls`. */
  retainPageRecords(board: string, urls: ReadonlySet<string>): void {
    this.tx(() => {
      const del = this.db.prepare(`DELETE FROM platform_pages WHERE board = ? AND url = ?`);
      for (const r of this.db.prepare(`SELECT url FROM platform_pages WHERE board = ?`).all(board) as { url: string }[]) if (!urls.has(r.url)) del.run(board, r.url);
    });
  }

  /** Records (or re-records, for a re-projected run) one run's summary. */
  recordRun(s: RunSummary): void {
    this.db
      .prepare(
        `INSERT INTO runs_summary (run_id, at, counts, pack_hash, policy_hash, warnings, problems) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET at = excluded.at, counts = excluded.counts, pack_hash = excluded.pack_hash,
           policy_hash = excluded.policy_hash, warnings = excluded.warnings, problems = excluded.problems`,
      )
      .run(s.runId, s.at, JSON.stringify(s.counts), s.packHash, s.policyHash, JSON.stringify(s.warnings ?? []), JSON.stringify(s.problems ?? []));
  }

  /** Whether the job has an applied snapshot for `day` (YYYY-MM-DD). */
  hasSnapshot(jobKey: string, day: string): boolean {
    return this.db.prepare(`SELECT 1 FROM job_snapshots WHERE job_key = ? AND day = ? LIMIT 1`).get(jobKey, day) !== undefined;
  }

  /** Records one applied snapshot (its files are already on disk, read-only). Append-only: a second one for the day throws. */
  putSnapshot(jobKey: string, day: string, files: readonly SnapshotFile[], at: string): void {
    this.tx(() => {
      const ins = this.db.prepare(`INSERT INTO job_snapshots (job_key, day, kind, format, path, sha256, at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const f of files) ins.run(jobKey, day, f.kind, f.format, f.path, f.sha256, at);
    });
  }

  /** The job's applied snapshots, newest day first; files by kind, then format. */
  snapshots(jobKey: string): Snapshot[] {
    const rows = this.db
      .prepare(`SELECT day, kind, format, path, sha256, at FROM job_snapshots WHERE job_key = ? ORDER BY day DESC, kind, format`)
      .all(jobKey) as (SnapshotFile & { day: string; at: string })[];
    const out: Snapshot[] = [];
    for (const r of rows) {
      let s = out.at(-1);
      if (s?.day !== r.day) out.push((s = { day: r.day, at: r.at, files: [] }));
      s.files.push({ kind: r.kind, format: r.format, path: r.path, sha256: r.sha256 });
    }
    return out;
  }

  /** Records one download of a job's document (`resume.pdf`, …) with the sha256 of the bytes served. */
  recordDownload(jobKey: string, file: string, sha256: string, at: string): void {
    this.db.prepare(`INSERT INTO job_downloads (job_key, file, sha256, at) VALUES (?, ?, ?, ?)`).run(jobKey, file, sha256, at);
  }

  /** The job's downloads, oldest first. */
  downloads(jobKey: string): { file: string; sha256: string; at: string }[] {
    return this.db.prepare(`SELECT file, sha256, at FROM job_downloads WHERE job_key = ? ORDER BY seq`).all(jobKey) as { file: string; sha256: string; at: string }[];
  }

  /** The status history of each listed job that has one, oldest first (the jobs list shows Desk imports' history). */
  histories(jobKeys: readonly string[]): Record<string, HistoryEntry[]> {
    const out: Record<string, HistoryEntry[]> = {};
    if (jobKeys.length === 0) return out;
    const rows = this.db
      .prepare(`SELECT job_key, "from", "to", at, by FROM status_history WHERE job_key IN (${jobKeys.map(() => '?').join(', ')}) ORDER BY job_key, seq`)
      .all(...jobKeys) as (HistoryEntry & { job_key: string })[];
    for (const { job_key, ...h } of rows) (out[job_key] ??= []).push(h);
    return out;
  }

  /** The latest `n` runs, newest first. */
  listRuns(n: number): RunSummary[] {
    const rows = this.db.prepare(`SELECT * FROM runs_summary ORDER BY at DESC, run_id DESC LIMIT ?`).all(n) as RunRowDb[];
    return rows.map(runOf);
  }

  /** The newest recorded run whose id starts with `prefix` (`daily-`), if any. */
  latestRun(prefix: string): RunSummary | undefined {
    const row = this.db
      .prepare(`SELECT * FROM runs_summary WHERE substr(run_id, 1, ?) = ? ORDER BY at DESC, run_id DESC LIMIT 1`)
      .get(prefix.length, prefix) as RunRowDb | undefined;
    return row ? runOf(row) : undefined;
  }

  // ---- Freelance (Task 9): gigs, their documents, run summaries and source health. -------------------------------

  /**
   * Inserts the gig, or updates its run-owned columns and `last_seen` (never status, note, applied_at, notified_at or
   * first_seen), then re-links its dedupe group (and the old one when the key changed). An observation older than the
   * row's `last_seen` is `stale` and changes nothing, as `upsertJob`.
   */
  upsertGig(r: GigUpsert): { gigKey: string; inserted: boolean; stale: boolean } {
    return this.tx(() => {
      const cur = this.db.prepare(`SELECT platform, source_id, dedupe_key, last_seen FROM gigs WHERE gig_key = ?`).get(r.gigKey) as
        | { platform: string; source_id: string; dedupe_key: string; last_seen: string }
        | undefined;
      if (cur && (cur.platform !== r.platform || cur.source_id !== r.sourceId)) throw new Error(`gig ${r.gigKey} is ${cur.platform}:${cur.source_id}, not ${r.platform}:${r.sourceId}`);
      if (cur && r.at < cur.last_seen) return { gigKey: r.gigKey, inserted: false, stale: true };
      const params = gigParams(r);
      if (cur) {
        this.db.prepare(`UPDATE gigs SET ${GIG_RUN_COLUMNS.map((c) => `${c} = ?`).join(', ')}, last_seen = ? WHERE gig_key = ?`).run(...params, r.at, r.gigKey);
        if (cur.dedupe_key !== r.dedupeKey) this.relinkGigs(cur.dedupe_key);
      } else {
        this.db
          .prepare(`INSERT INTO gigs (gig_key, platform, source_id, ${GIG_RUN_COLUMNS.join(', ')}, first_seen, last_seen) VALUES (?, ?, ?, ${GIG_RUN_COLUMNS.map(() => '?').join(', ')}, ?, ?)`)
          .run(r.gigKey, r.platform, r.sourceId, ...params, r.at, r.at);
      }
      this.relinkGigs(r.dedupeKey);
      return { gigKey: r.gigKey, inserted: !cur, stale: false };
    });
  }

  /**
   * `duplicate_of` for one gig dedupe group, the v1 rule: the earliest first_seen row (then gig key) is the group's
   * row; every row from another platform points at it, and rows from its own platform stay separate gigs.
   */
  private relinkGigs(dedupeKey: string): void {
    const rows = (this.db.prepare(`SELECT gig_key, platform, first_seen, duplicate_of FROM gigs WHERE dedupe_key = ?`).all(dedupeKey) as {
      gig_key: string;
      platform: string;
      first_seen: string;
      duplicate_of: string | null;
    }[]).sort((a, b) => cmp(a.first_seen, b.first_seen) || cmp(a.gig_key, b.gig_key));
    const top = rows[0];
    if (!top) return;
    const set = this.db.prepare(`UPDATE gigs SET duplicate_of = ? WHERE gig_key = ?`);
    for (const r of rows) {
      const dup = r !== top && r.platform !== top.platform ? top.gig_key : null;
      if (dup !== r.duplicate_of) set.run(dup, r.gig_key);
    }
  }

  /** Replaces a gig's documents (an empty list clears them). */
  putGigDocs(gigKey: string, docs: readonly GigDoc[]): void {
    this.tx(() => {
      this.db.prepare(`DELETE FROM gig_docs WHERE gig_key = ?`).run(gigKey);
      const ins = this.db.prepare(`INSERT INTO gig_docs (gig_key, kind, format, path, sha256, pages) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const d of docs) ins.run(gigKey, d.kind, d.format, d.path, d.sha256, d.pages);
    });
  }

  getGig(gigKey: string): (GigView & { readonly docs: GigDoc[] }) | undefined {
    const row = this.db.prepare(`SELECT * FROM gigs WHERE gig_key = ?`).get(gigKey) as GigRowDb | undefined;
    if (!row) return undefined;
    const docs = this.db.prepare(`SELECT kind, format, path, sha256, pages FROM gig_docs WHERE gig_key = ? ORDER BY kind, format`).all(gigKey) as GigDoc[];
    return { ...gigView(row), docs };
  }

  /** Every gig by gig key; duplicate listings only with `duplicates`. */
  listGigs(o: { readonly duplicates?: boolean } = {}): GigView[] {
    const rows = this.db.prepare(`SELECT * FROM gigs ${o.duplicates === true ? '' : 'WHERE duplicate_of IS NULL'} ORDER BY gig_key`).all() as GigRowDb[];
    return rows.map(gigView);
  }

  /** Marks the gigs a notification announced, once: an already announced gig keeps its first time. */
  markGigsNotified(gigKeys: readonly string[], at: string): void {
    this.tx(() => {
      const upd = this.db.prepare(`UPDATE gigs SET notified_at = ? WHERE gig_key = ? AND notified_at IS NULL`);
      for (const k of gigKeys) upd.run(at, k);
    });
  }

  /** Records (or re-records) one freelance run's summary. */
  recordGigRun(s: RunSummary): void {
    this.db
      .prepare(
        `INSERT INTO gig_runs_summary (run_id, at, counts, pack_hash, policy_hash, warnings, problems) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET at = excluded.at, counts = excluded.counts, pack_hash = excluded.pack_hash,
           policy_hash = excluded.policy_hash, warnings = excluded.warnings, problems = excluded.problems`,
      )
      .run(s.runId, s.at, JSON.stringify(s.counts), s.packHash, s.policyHash, JSON.stringify(s.warnings ?? []), JSON.stringify(s.problems ?? []));
  }

  /** The newest recorded freelance run, if any. */
  latestGigRun(): RunSummary | undefined {
    const row = this.db.prepare(`SELECT * FROM gig_runs_summary ORDER BY at DESC, run_id DESC LIMIT 1`).get() as RunRowDb | undefined;
    return row ? runOf(row) : undefined;
  }

  /**
   * The stored daily jobs that are contract, freelance or part-time (their reasons include `employment:contract`,
   * `employment:freelance` or `employment:part-time`), seen at or after `since` (the run passes now minus
   * BOARD_SEED_DAYS), not skipped or rejected by the user, duplicate listings left out, by job key; each with the
   * Posting@1 the daily normalizer emitted for it: the newest stored Posting@1 envelope with that job key (same
   * connection, read only). The jobs table keeps columns, not the posting (no slug, employment type or remote
   * signals), so the envelope is the exact posting and nothing is rebuilt or guessed. The envelopes are read in one
   * pass per batch of at most 500 keys (`IN`, newest rowid per key), never one scan per job. `missing` lists the job
   * keys with no stored posting (a Desk import): they are not seeded.
   */
  contractPostings(since: string): { postings: { jobKey: string; posting: unknown }[]; missing: string[] } {
    const keys = (
      this.db
        .prepare(
          `SELECT job_key FROM jobs WHERE duplicate_of IS NULL AND last_seen >= ? AND status NOT IN ('skipped', 'rejected') AND EXISTS (
             SELECT 1 FROM json_each(jobs.reasons) WHERE value IN ('employment:contract', 'employment:freelance', 'employment:part-time')
           ) ORDER BY job_key`,
        )
        .all(since) as { job_key: string }[]
    ).map((r) => r.job_key);
    const bodies = new Map<string, string>();
    for (let i = 0; i < keys.length; i += POSTING_BATCH) {
      const batch = keys.slice(i, i + POSTING_BATCH);
      const rows = this.db
        .prepare(
          `SELECT k, body FROM (
             SELECT json_extract(body, '$.payload.jobKey') AS k, max(rowid) AS r FROM envelopes
             WHERE type = 'Posting@1' AND json_extract(body, '$.payload.jobKey') IN (${batch.map(() => '?').join(', ')})
             GROUP BY k
           ) JOIN envelopes ON envelopes.rowid = r`,
        )
        .all(...batch) as { k: string; body: string }[];
      for (const r of rows) bodies.set(r.k, r.body);
    }
    const postings: { jobKey: string; posting: unknown }[] = [];
    const missing: string[] = [];
    for (const jobKey of keys) {
      const body = bodies.get(jobKey);
      if (body === undefined) missing.push(jobKey);
      else postings.push({ jobKey, posting: (JSON.parse(body) as { payload: unknown }).payload });
    }
    return { postings, missing };
  }

  /**
   * Adds one run's counts to `source_health` for (platform, week), once per run and platform: false (nothing added)
   * when this run was already counted for the platform. `probeFailures` is the platform's new streak of runs whose
   * every fetch failed (it replaces the stored value; the caller carries it across weeks).
   */
  addSourceHealth(runId: string, platform: string, week: string, d: SourceHealthDelta): boolean {
    return this.tx(() => {
      const fresh = this.db.prepare(`INSERT OR IGNORE INTO source_health_runs (run_id, platform) VALUES (?, ?)`).run(runId, platform).changes === 1;
      if (!fresh) return false;
      this.db
        .prepare(
          `INSERT INTO source_health (platform, week, fetched, eligible, above_floor, shortlisted, runs, failed_runs, probe_failures)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT (platform, week) DO UPDATE SET fetched = fetched + excluded.fetched, eligible = eligible + excluded.eligible,
             above_floor = above_floor + excluded.above_floor, shortlisted = shortlisted + excluded.shortlisted, runs = runs + 1,
             failed_runs = failed_runs + excluded.failed_runs, probe_failures = excluded.probe_failures`,
        )
        .run(platform, week, d.fetched, d.eligible, d.aboveFloor, d.shortlisted, d.failed ? 1 : 0, d.probeFailures);
      return true;
    });
  }

  /**
   * Marks a run as seen for a platform without counting it into `source_health` (no row, no week, no probe streak):
   * a `source_health_runs` row whose platform column holds `<platform>:<note>` (freelance §4.5: a Gmail run whose
   * messages were all read but none parsed is `gmail:no-parser`, neither a failure nor a zero-yield week). False when
   * the run was already marked.
   */
  markSourceRun(runId: string, platform: string, note: string): boolean {
    return this.db.prepare(`INSERT OR IGNORE INTO source_health_runs (run_id, platform) VALUES (?, ?)`).run(runId, `${platform}:${note}`).changes === 1;
  }

  /** The notes `markSourceRun` left for a run, as `<platform>:<note>`, sorted. */
  sourceRunNotes(runId: string): string[] {
    return (this.db.prepare(`SELECT platform FROM source_health_runs WHERE run_id = ? AND platform LIKE '%:%' ORDER BY platform`).all(runId) as { platform: string }[]).map((r) => r.platform);
  }

  /**
   * Adds one failed probe (`jobpilot sources probe`) to `source_health.probe_failures` for (platform, week). A probe is
   * not a run: `runs` and the other counts are untouched, and a row it creates has `runs` 0.
   */
  addProbeFailure(platform: string, week: string): void {
    this.db
      .prepare(`INSERT INTO source_health (platform, week, probe_failures) VALUES (?, ?, 1) ON CONFLICT (platform, week) DO UPDATE SET probe_failures = probe_failures + 1`)
      .run(platform, week);
  }

  /** The source health rows, by platform then week. */
  sourceHealth(platform?: string): SourceHealthRow[] {
    const rows = (
      platform === undefined
        ? this.db.prepare(`SELECT * FROM source_health ORDER BY platform, week`).all()
        : this.db.prepare(`SELECT * FROM source_health WHERE platform = ? ORDER BY week`).all(platform)
    ) as SourceHealthDb[];
    return rows.map((r) => ({
      platform: r.platform, week: r.week, fetched: r.fetched, eligible: r.eligible, aboveFloor: r.above_floor, shortlisted: r.shortlisted,
      applied: r.applied, replied: r.replied, won: r.won, runs: r.runs, failedRuns: r.failed_runs, probeFailures: r.probe_failures,
    }));
  }

  // ---- Freelance (Task 10): the dashboard's user-owned writes and its reads of the run's envelopes. ----------------

  /**
   * Sets a gig's status (the user's, never a run's) and logs the transition in `gig_status_history`. The first time it
   * becomes `applied` stamps `applied_at`. Status lives on each row: a duplicate listing keeps its own. Returns
   * undefined when there is no such gig, `changed: false` (and logs nothing) when it already has `to`.
   */
  setGigStatus(gigKey: string, to: GigStatus, at: string): { changed: boolean; from: GigStatus } | undefined {
    if (!(GIG_STATUSES as readonly string[]).includes(to)) throw new Error(`not a gig status: ${String(to)}`);
    return this.tx(() => {
      const cur = this.db.prepare(`SELECT status, applied_at FROM gigs WHERE gig_key = ?`).get(gigKey) as { status: GigStatus; applied_at: string | null } | undefined;
      if (!cur) return undefined;
      if (cur.status === to) return { changed: false, from: cur.status };
      this.db.prepare(`UPDATE gigs SET status = ? WHERE gig_key = ?`).run(to, gigKey);
      if (to === 'applied' && cur.applied_at === null) this.db.prepare(`UPDATE gigs SET applied_at = ? WHERE gig_key = ?`).run(at, gigKey);
      this.db.prepare(`INSERT INTO gig_status_history (gig_key, "from", "to", at, by) VALUES (?, ?, ?, ?, 'user')`).run(gigKey, cur.status, to, at);
      return { changed: true, from: cur.status };
    });
  }

  /** A gig's status history, oldest first. */
  gigHistory(gigKey: string): GigHistoryEntry[] {
    return this.db.prepare(`SELECT "from", "to", at, by FROM gig_status_history WHERE gig_key = ? ORDER BY seq`).all(gigKey) as GigHistoryEntry[];
  }

  /** Every gig status transition with the gig's platform, oldest first (the Sources tab counts the user's outcomes). */
  gigTransitions(): { gigKey: string; platform: string; to: GigStatus; at: string }[] {
    return this.db
      .prepare(`SELECT h.gig_key AS gigKey, g.platform AS platform, h."to" AS "to", h.at AS at FROM gig_status_history h JOIN gigs g ON g.gig_key = h.gig_key ORDER BY h.seq`)
      .all() as { gigKey: string; platform: string; to: GigStatus; at: string }[];
  }

  /** Records one applied snapshot of a gig (its files are already on disk, read-only). Append-only. */
  putGigSnapshot(gigKey: string, day: string, files: readonly GigDoc[], at: string): void {
    this.tx(() => {
      const ins = this.db.prepare(`INSERT INTO gig_snapshots (gig_key, day, kind, format, path, sha256, at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const f of files) ins.run(gigKey, day, f.kind, f.format, f.path, f.sha256, at);
    });
  }

  /** A gig's applied snapshots, newest day first; files by path. */
  gigSnapshots(gigKey: string): GigSnapshot[] {
    const rows = this.db
      .prepare(`SELECT day, kind, format, path, sha256, at FROM gig_snapshots WHERE gig_key = ? ORDER BY day DESC, path`)
      .all(gigKey) as (Omit<GigDoc, 'pages'> & { day: string; at: string })[];
    const out: GigSnapshot[] = [];
    for (const r of rows) {
      let s = out.at(-1);
      if (s?.day !== r.day) out.push((s = { day: r.day, at: r.at, files: [] }));
      s.files.push({ kind: r.kind, format: r.format, path: r.path, sha256: r.sha256, pages: null });
    }
    return out;
  }

  /**
   * What a run knew about each gig that the gig row does not keep, from the kernel's stored envelopes (same connection,
   * read only): the newest `Gig@1` (duration, time zone, skills) and the `GigRendered@1` whose files are exactly the
   * gig's recorded documents (path and sha256), so its plan (coverage, the facts behind each line) is the one behind
   * the files. Both are `undefined` when not on record. Read in batches of at most 500 keys.
   */
  gigExtras(gigKeys: readonly string[]): Record<string, { gig: unknown; rendered: unknown }> {
    const out: Record<string, { gig: unknown; rendered: unknown }> = {};
    for (const k of gigKeys) out[k] = { gig: undefined, rendered: undefined };
    for (let i = 0; i < gigKeys.length; i += POSTING_BATCH) {
      const batch = gigKeys.slice(i, i + POSTING_BATCH);
      const marks = batch.map(() => '?').join(', ');
      const gigs = this.db
        .prepare(
          `SELECT k, body FROM (
             SELECT json_extract(body, '$.payload.gigKey') AS k, max(rowid) AS r FROM envelopes
             WHERE type = 'Gig@1' AND json_extract(body, '$.payload.gigKey') IN (${marks}) GROUP BY k
           ) JOIN envelopes ON envelopes.rowid = r`,
        )
        .all(...batch) as { k: string; body: string }[];
      for (const r of gigs) (out[r.k] as { gig: unknown }).gig = (JSON.parse(r.body) as { payload: unknown }).payload;
      const docs = this.db.prepare(`SELECT gig_key, path, sha256 FROM gig_docs WHERE gig_key IN (${marks}) ORDER BY gig_key, path`).all(...batch) as { gig_key: string; path: string; sha256: string }[];
      const want = new Map<string, string>();
      for (const d of docs) want.set(d.gig_key, `${want.has(d.gig_key) ? `${want.get(d.gig_key) as string}\n` : ''}${d.path}\u0000${d.sha256}`);
      const keyed = [...want.keys()];
      if (keyed.length === 0) continue;
      const rendered = this.db
        .prepare(`SELECT json_extract(body, '$.payload.gigKey') AS k, body FROM envelopes WHERE type = 'GigRendered@1' AND json_extract(body, '$.payload.gigKey') IN (${keyed.map(() => '?').join(', ')}) ORDER BY rowid DESC`)
        .all(...keyed) as { k: string; body: string }[];
      for (const r of rendered) {
        const slot = out[r.k] as { rendered: unknown };
        if (slot.rendered !== undefined) continue;
        const p = (JSON.parse(r.body) as { payload?: { files?: { path: string; sha256: string }[] } }).payload;
        const got = (p?.files ?? []).map((f) => `${f.path}\u0000${f.sha256}`).sort().join('\n');
        if (got === want.get(r.k)) slot.rendered = p;
      }
    }
    return out;
  }

  /** The user's status of each network that has one. */
  networkStatuses(): Record<string, { status: NetworkStatus; updatedAt: string }> {
    const rows = this.db.prepare(`SELECT network_id, status, updated_at FROM network_status ORDER BY network_id`).all() as { network_id: string; status: NetworkStatus; updated_at: string }[];
    return Object.fromEntries(rows.map((r) => [r.network_id, { status: r.status, updatedAt: r.updated_at }]));
  }

  /** Sets a network's status (the user's). */
  setNetworkStatus(networkId: string, status: NetworkStatus, at: string): void {
    if (!(NETWORK_STATUSES as readonly string[]).includes(status)) throw new Error(`not a network status: ${String(status)}`);
    this.db
      .prepare(`INSERT INTO network_status (network_id, status, updated_at) VALUES (?, ?, ?) ON CONFLICT (network_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`)
      .run(networkId, status, at);
  }

  /** Disables `host` for the coverage run `runKey`. The first reason stays (a later one for the same host is ignored). */
  disableCoverageHost(runKey: string, host: string, reason: string, at: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO coverage_host_state (run_key, host, reason, at) VALUES (?, ?, ?, ?)`).run(runKey, host, reason, at);
  }

  /** When each host of coverage run `runKey` was disabled, host to ISO time, by host. */
  coverageHostTimes(runKey: string): Map<string, string> {
    const rows = this.db.prepare(`SELECT host, at FROM coverage_host_state WHERE run_key = ? ORDER BY host`).all(runKey) as { host: string; at: string }[];
    return new Map(rows.map((r) => [r.host, r.at]));
  }

  /** Re-enables `host` for coverage run `runKey` (a 429 disable that expired). */
  enableCoverageHost(runKey: string, host: string): void {
    this.db.prepare(`DELETE FROM coverage_host_state WHERE run_key = ? AND host = ?`).run(runKey, host);
  }

  /** The hosts disabled so far in coverage run `runKey`, host to reason, by host. */
  coverageHostState(runKey: string): Map<string, string> {
    const rows = this.db.prepare(`SELECT host, reason FROM coverage_host_state WHERE run_key = ? ORDER BY host`).all(runKey) as { host: string; reason: string }[];
    return new Map(rows.map((r) => [r.host, r.reason]));
  }

  /**
   * Records one coverage verdict for a company (the weekly run). The user's override always wins: a rejected company
   * stays `rejected` (only `coverage_status` and `updated_at` move), an approved one is `verified` whatever the verdict says short of a
   * failure. A failed verdict keeps the last known platform and board; a verified company that fails 3 weeks running
   * becomes `failing` (shown, never silently removed), and a verified verdict resets the count.
   * `countFailure: false` (a second coverage run in the same coverage week): a failed verdict on a known company
   * keeps its fail count, status and failing-since as they are (the week's failure was already counted); only the
   * reasons and `updated_at` move. Default true.
   */
  upsertCompanyVerdict(v: CompanyVerdict, at: string, opts: { readonly countFailure?: boolean } = {}): void {
    const cand = v.guess.site.candidate;
    this.tx(() => {
      const prev = this.db.prepare(`SELECT * FROM companies WHERE company_key = ?`).get(cand.companyKey) as CompanyRowDb | undefined;
      if (prev?.user_override === 'rejected') {
        // rejected stays rejected; only what coverage alone decides is kept, so an Undo restores it (a failure keeps a
        // live coverage status, fail weeks are not counted while the user has it rejected)
        const live = prev.coverage_status === 'verified' || prev.coverage_status === 'failing';
        const natural: CompanyStatus = v.status === 'failed' ? (live ? (prev.coverage_status as CompanyStatus) : 'failed') : v.status;
        this.db.prepare(`UPDATE companies SET coverage_status = ?, updated_at = ? WHERE company_key = ?`).run(natural, at, cand.companyKey);
        return;
      }
      const failed = v.status === 'failed';
      const keep = <T>(fresh: T | null, old: T | null | undefined): T | null => (failed ? (old ?? fresh) : fresh);
      const wasLive = prev !== undefined && (prev.status === 'verified' || prev.status === 'failing');
      let status: CompanyStatus;
      // the status the verdicts alone give it (no override): what undoing an approve restores
      let natural: CompanyStatus;
      let failWeeks = 0;
      let failingSince: string | null = null;
      let lastVerified = prev?.last_verified ?? null;
      if (v.status === 'verified') {
        status = 'verified';
        natural = 'verified';
        lastVerified = at;
      } else if (v.status === 'proposed') {
        status = prev?.user_override === 'approved' ? 'verified' : 'proposed';
        natural = 'proposed';
      } else if (opts.countFailure === false && prev !== undefined) {
        failWeeks = prev.fail_weeks;
        failingSince = prev.failing_since;
        status = prev.status;
        natural = prev.coverage_status ?? prev.status;
      } else {
        failWeeks = (prev?.fail_weeks ?? 0) + 1;
        failingSince = prev?.failing_since ?? at;
        status = wasLive ? (failWeeks >= FAIL_WEEKS_TO_FAILING ? 'failing' : 'verified') : 'failed';
        natural = status;
      }
      this.db
        .prepare(
          `INSERT INTO companies (company_key, name, website, careers_url, platform, platform_slug, board_url, status, reasons, source, jobs_seen, last_verified, failing_since, fail_weeks, user_override, updated_at, coverage_status)
           VALUES (@key, @name, @website, @careersUrl, @platform, @slug, @boardUrl, @status, @reasons, @source, @jobsSeen, @lastVerified, @failingSince, @failWeeks, @override, @at, @natural)
           ON CONFLICT (company_key) DO UPDATE SET name = excluded.name, website = excluded.website, careers_url = excluded.careers_url, platform = excluded.platform,
             platform_slug = excluded.platform_slug, board_url = excluded.board_url, status = excluded.status, reasons = excluded.reasons, source = excluded.source,
             jobs_seen = excluded.jobs_seen, last_verified = excluded.last_verified, failing_since = excluded.failing_since, fail_weeks = excluded.fail_weeks,
             updated_at = excluded.updated_at, coverage_status = excluded.coverage_status`,
        )
        .run({
          key: cand.companyKey, name: cand.name, website: cand.website,
          careersUrl: v.guess.site.careersUrl ?? cand.careersUrl ?? (failed ? (prev?.careers_url ?? null) : null),
          platform: keep(v.guess.platform, prev?.platform), slug: keep(v.guess.slug, prev?.platform_slug), boardUrl: keep(v.guess.boardUrl, prev?.board_url),
          status, reasons: JSON.stringify(v.reasons), source: cand.source, jobsSeen: keep(v.jobsSeen, prev?.jobs_seen),
          lastVerified, failingSince, failWeeks, override: prev?.user_override ?? null, at, natural,
        });
    });
  }

  /**
   * The user's approve or reject of a company (null clears it, the dashboard's Undo). Rejecting sets the status
   * `rejected`; approving promotes a proposed or rejected company that has a platform to `verified`; clearing either
   * restores what the coverage verdicts alone last decided (`coverage_status`, kept up to date while it is rejected;
   * `proposed` when coverage has decided nothing yet). False when there is no
   * such company.
   */
  setCompanyOverride(companyKey: string, override: CompanyOverride | null, at: string): boolean {
    if (override !== null && !(COMPANY_OVERRIDES as readonly string[]).includes(override)) throw new Error(`not a company override: ${String(override)}`);
    return this.tx(() => {
      const prev = this.db.prepare(`SELECT * FROM companies WHERE company_key = ?`).get(companyKey) as CompanyRowDb | undefined;
      if (prev === undefined) return false;
      let status = prev.status;
      if (override === 'rejected') status = 'rejected';
      else if (override === 'approved' && (prev.status === 'proposed' || prev.status === 'rejected')) status = prev.platform !== null ? 'verified' : 'proposed';
      else if (override === null && prev.status === 'rejected') status = prev.coverage_status ?? 'proposed';
      else if (override === null && prev.user_override === 'approved') status = prev.coverage_status ?? 'proposed';
      this.db.prepare(`UPDATE companies SET user_override = ?, status = ?, updated_at = ? WHERE company_key = ?`).run(override, status, at, companyKey);
      return true;
    });
  }

  /** The companies the daily adapters read: verified, or failing (shown and still tried so they can recover). Never rejected, proposed or failed. By key. */
  verifiedCompanies(): Company[] {
    const rows = this.db
      .prepare(`SELECT * FROM companies WHERE status IN ('verified', 'failing') AND (user_override IS NULL OR user_override <> 'rejected') ORDER BY company_key`)
      .all() as CompanyRowDb[];
    return rows.map(companyOf);
  }

  /** One registry row, or undefined. */
  getCompany(companyKey: string): Company | undefined {
    const r = this.db.prepare(`SELECT * FROM companies WHERE company_key = ?`).get(companyKey) as CompanyRowDb | undefined;
    return r === undefined ? undefined : companyOf(r);
  }

  /**
   * The Companies tab's "Add company" (Task 11): records the user's pick as a `proposed` registry row (source `pick`,
   * no platform yet) with the reason ADDED_PICK_REASON, for the next coverage run (which seeds every registry pick,
   * `registryPickItems`) or "resolve now" to verify. Never touches the pack. False, with nothing written, when the
   * company key is already in the registry.
   */
  addCompanyPick(p: { readonly companyKey: string; readonly name: string; readonly website: string }, at: string): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO companies (company_key, name, website, careers_url, platform, platform_slug, board_url, status, reasons, source, jobs_seen, last_verified, failing_since, fail_weeks, user_override, updated_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 'proposed', ?, 'pick', NULL, NULL, NULL, 0, NULL, ?) ON CONFLICT (company_key) DO NOTHING`,
      )
      .run(p.companyKey, p.name, p.website, JSON.stringify([ADDED_PICK_REASON]), at);
    return r.changes === 1;
  }

  /**
   * Logs one action the user took on the dashboard (an approve, a reject, an added company, a resolve) as an event in
   * the kernel's hash-chained log, under the run id USER_ACTIONS_RUN: `kind` names it, `data` says what changed.
   */
  logUserAction(kind: string, data: unknown, at: string): void {
    this.kernel.appendEvent(USER_ACTIONS_RUN, at, kind, data, '');
  }

  /** The logged user actions, oldest first. */
  userActions(): { readonly at: string; readonly kind: string; readonly data: unknown }[] {
    return this.kernel.events(USER_ACTIONS_RUN).map((e) => ({ at: e.at, kind: e.kind, data: JSON.parse(e.data) as unknown }));
  }

  /**
   * Companies the user added on the dashboard that no coverage verdict has decided yet (source `pick`, no coverage
   * status) and that are not rejected: what the Add form's cap counts.
   */
  pendingAddedPicks(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM companies WHERE source = 'pick' AND coverage_status IS NULL AND status <> 'rejected' AND (user_override IS NULL OR user_override <> 'rejected')`)
        .get() as { n: number }
    ).n;
  }

  /** Every company, or those with the given status, platform or source; by key. */
  listCompanies(filter: { readonly status?: CompanyStatus; readonly platform?: Platform; readonly source?: string } = {}): Company[] {
    const where: string[] = [];
    const args: string[] = [];
    for (const [col, val] of [['status', filter.status], ['platform', filter.platform], ['source', filter.source]] as const) {
      if (val === undefined) continue;
      where.push(`${col} = ?`);
      args.push(val);
    }
    const sql = `SELECT * FROM companies${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY company_key`;
    return (this.db.prepare(sql).all(...args) as CompanyRowDb[]).map(companyOf);
  }

  /** Replaces a job's documents and their state (docs rebuild): no other column is touched. False when there is no such job. */
  setDocs(jobKey: string, state: DocsState, detail: string | null, docs: readonly Doc[], citedFacts: readonly string[] | null = null): boolean {
    return this.tx(() => {
      const r = this.db.prepare(`UPDATE jobs SET docs_state = ?, docs_detail = ? WHERE job_key = ?`).run(state, detail, jobKey);
      if (r.changes === 0) return false;
      this.putDocs(jobKey, docs, citedFacts);
      return true;
    });
  }
}

export type GigStatus = (typeof GIG_STATUSES)[number];
export type GigDocsState = (typeof GIG_DOCS_STATES)[number];
export type GigList = (typeof GIG_LISTS)[number];
export type NetworkStatus = (typeof NETWORK_STATUSES)[number];
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];
export type CompanyOverride = (typeof COMPANY_OVERRIDES)[number];

/** The reason on a company the user added on the dashboard, until a coverage run (or resolve now) verifies it. */
export const ADDED_PICK_REASON = 'added by you, resolves on the next coverage run';
/** The run id under which the dashboard logs the user's actions in the event chain (never a pipeline run). */
export const USER_ACTIONS_RUN = 'dashboard';

/** A verified company that fails this many weeks running becomes `failing` (spec §3). */
const FAIL_WEEKS_TO_FAILING = 3;

interface CompanyRowDb {
  company_key: string; name: string; website: string; careers_url: string | null; platform: Platform | null; platform_slug: string | null;
  board_url: string | null; status: CompanyStatus; reasons: string; source: string; jobs_seen: number | null; last_verified: string | null;
  failing_since: string | null; fail_weeks: number; user_override: CompanyOverride | null; updated_at: string; coverage_status: CompanyStatus | null;
}

/** One registry row. */
export interface Company {
  readonly companyKey: string;
  readonly name: string;
  readonly website: string;
  readonly careersUrl: string | null;
  readonly platform: Platform | null;
  readonly platformSlug: string | null;
  readonly boardUrl: string | null;
  readonly status: CompanyStatus;
  readonly reasons: string[];
  readonly source: string;
  readonly jobsSeen: number | null;
  readonly lastVerified: string | null;
  readonly failingSince: string | null;
  readonly failWeeks: number;
  readonly userOverride: CompanyOverride | null;
  readonly updatedAt: string;
  /** The status the coverage verdicts alone give it (no override); null before any verdict. */
  readonly coverageStatus: CompanyStatus | null;
}

function companyOf(r: CompanyRowDb): Company {
  return {
    companyKey: r.company_key, name: r.name, website: r.website, careersUrl: r.careers_url, platform: r.platform, platformSlug: r.platform_slug,
    boardUrl: r.board_url, status: r.status, reasons: JSON.parse(r.reasons) as string[], source: r.source, jobsSeen: r.jobs_seen,
    lastVerified: r.last_verified, failingSince: r.failing_since, failWeeks: r.fail_weeks, userOverride: r.user_override, updatedAt: r.updated_at,
    coverageStatus: r.coverage_status,
  };
}

export interface GigHistoryEntry {
  readonly from: GigStatus | null;
  readonly to: GigStatus;
  readonly at: string;
  readonly by: 'user' | 'migration';
}

/** One applied snapshot of a gig: the exact files the user sent, kept read-only under `gigs/<gigKey>/applied-<day>/`. */
export interface GigSnapshot {
  readonly day: string;
  readonly at: string;
  readonly files: GigDoc[];
}

export interface GigDoc {
  readonly kind: 'proposal' | 'pitch' | 'resume';
  readonly format: 'txt' | 'pdf' | 'docx';
  readonly path: string;
  readonly sha256: string;
  readonly pages: number | null;
}

/** The run-owned columns of a gig, its identity and the time it was seen. Never status, note or notified_at. */
export interface GigUpsert {
  readonly gigKey: string;
  readonly dedupeKey: string;
  readonly platform: string;
  readonly sourceId: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly client: unknown;
  readonly kind: (typeof GIG_KINDS)[number];
  readonly budget: unknown;
  /** The RatedGig rate, or null when the gig was not rated. */
  readonly rate: unknown;
  readonly hours: unknown;
  readonly verdict: Verdict | null;
  readonly reasons: readonly string[];
  readonly notes: readonly string[];
  readonly flags: readonly { readonly id: string; readonly detail: string }[];
  readonly fit: number | null;
  readonly breakdown: Readonly<Record<string, number>> | null;
  readonly list: GigList | null;
  readonly docsState: GigDocsState;
  readonly docsDetail: string | null;
  readonly postedAt: string | null;
  readonly at: string;
}

export interface GigView extends Omit<GigUpsert, 'at' | 'flags' | 'reasons' | 'notes' | 'breakdown'> {
  readonly duplicateOf: string | null;
  readonly flags: { id: string; detail: string }[];
  readonly reasons: string[];
  readonly notes: string[];
  readonly breakdown: Record<string, number> | null;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly status: GigStatus;
  readonly note: string;
  readonly appliedAt: string | null;
  readonly notifiedAt: string | null;
}

export interface SourceHealthDelta {
  readonly fetched: number;
  readonly eligible: number;
  readonly aboveFloor: number;
  readonly shortlisted: number;
  /** Whether any of the platform's fetches failed in the run (adds 1 to `failed_runs`). */
  readonly failed: boolean;
  readonly probeFailures: number;
}

export interface SourceHealthRow {
  readonly platform: string;
  readonly week: string;
  readonly fetched: number;
  readonly eligible: number;
  readonly aboveFloor: number;
  readonly shortlisted: number;
  readonly applied: number;
  readonly replied: number;
  readonly won: number;
  /** Runs counted into this row. */
  readonly runs: number;
  readonly failedRuns: number;
  readonly probeFailures: number;
}

interface SourceHealthDb {
  platform: string;
  week: string;
  fetched: number;
  eligible: number;
  above_floor: number;
  shortlisted: number;
  applied: number;
  replied: number;
  won: number;
  runs: number;
  failed_runs: number;
  probe_failures: number;
}

interface GigRowDb {
  gig_key: string;
  dedupe_key: string;
  duplicate_of: string | null;
  platform: string;
  source_id: string;
  url: string;
  title: string;
  description: string;
  client: string;
  kind: GigUpsert['kind'];
  budget: string;
  rate: string | null;
  hours: string;
  verdict: Verdict | null;
  reasons: string;
  notes: string;
  flags: string;
  fit: number | null;
  breakdown: string | null;
  list: GigList | null;
  docs_state: GigDocsState;
  docs_detail: string | null;
  posted_at: string | null;
  first_seen: string;
  last_seen: string;
  status: GigStatus;
  note: string;
  applied_at: string | null;
  notified_at: string | null;
}

/** Run-owned gig columns, in the order `gigParams` binds them. */
const GIG_RUN_COLUMNS = [
  'dedupe_key', 'url', 'title', 'description', 'client', 'kind', 'budget', 'rate', 'hours', 'verdict', 'reasons', 'notes', 'flags', 'fit', 'breakdown',
  'list', 'docs_state', 'docs_detail', 'posted_at',
] as const;

const gigParams = (r: GigUpsert): unknown[] => [
  r.dedupeKey, r.url, r.title, r.description, JSON.stringify(r.client), r.kind, JSON.stringify(r.budget), json(r.rate), JSON.stringify(r.hours), r.verdict,
  JSON.stringify(r.reasons), JSON.stringify(r.notes), JSON.stringify(r.flags), r.fit, json(r.breakdown), r.list, r.docsState, r.docsDetail, r.postedAt,
];

const gigView = (r: GigRowDb): GigView => ({
  gigKey: r.gig_key,
  dedupeKey: r.dedupe_key,
  duplicateOf: r.duplicate_of,
  platform: r.platform,
  sourceId: r.source_id,
  url: r.url,
  title: r.title,
  description: r.description,
  client: JSON.parse(r.client) as unknown,
  kind: r.kind,
  budget: JSON.parse(r.budget) as unknown,
  rate: parse(r.rate),
  hours: JSON.parse(r.hours) as unknown,
  verdict: r.verdict,
  reasons: JSON.parse(r.reasons) as string[],
  notes: JSON.parse(r.notes) as string[],
  flags: JSON.parse(r.flags) as { id: string; detail: string }[],
  fit: r.fit,
  breakdown: parse(r.breakdown),
  list: r.list,
  docsState: r.docs_state,
  docsDetail: r.docs_detail,
  postedAt: r.posted_at,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
  status: r.status,
  note: r.note,
  appliedAt: r.applied_at,
  notifiedAt: r.notified_at,
});

interface RunRowDb {
  run_id: string;
  at: string;
  counts: string;
  pack_hash: string;
  policy_hash: string;
  warnings: string;
  problems: string;
}

const runOf = (r: RunRowDb): RunSummary => ({
  runId: r.run_id,
  at: r.at,
  counts: JSON.parse(r.counts) as unknown,
  packHash: r.pack_hash,
  policyHash: r.policy_hash,
  warnings: JSON.parse(r.warnings) as string[],
  problems: JSON.parse(r.problems) as unknown[],
});

/** The furthest status in a group (STATUS_PRECEDENCE); the preferred row (first) wins a tie. */
function groupStatus(rows: readonly JobRowDb[]): JobStatus {
  return rows.reduce((best, r) => (STATUS_PRECEDENCE[r.status] > STATUS_PRECEDENCE[best] ? r.status : best), (rows[0] as JobRowDb).status);
}

function bandOf(r: JobRowDb, floorInr: number | undefined): Band {
  if (r.verdict === 'rejected') return 'rejected';
  if (r.docs_state === 'below-floor') return 'below-floor';
  if (r.verdict === 'eligible') {
    if (r.comp_max_inr === null) return 'undisclosed';
    return floorInr !== undefined && r.comp_max_inr < floorInr ? 'below-floor' : 'disclosed';
  }
  return 'review';
}

/** One row as shown: its own run-owned columns, and the group's (`top` plus `dups`) user-owned ones. */
function view(r: JobRowDb, top: JobRowDb, dups: readonly JobRowDb[], floorInr?: number): JobView {
  const group = [top, ...dups];
  const notes = [...new Set(group.map((g) => g.note).filter((n) => n !== ''))];
  return {
    jobKey: r.job_key,
    dedupeKey: r.dedupe_key,
    source: r.source,
    sourceId: r.source_id,
    duplicateOf: r.duplicate_of,
    alsoListedOn: r.duplicate_of === null ? [...new Set(dups.map((d) => d.source))].sort() : [],
    company: r.company,
    title: r.title,
    url: r.url,
    ats: r.ats,
    location: r.location,
    remote: parse(r.remote),
    comp: parse(r.comp),
    compMinInr: r.comp_min_inr,
    compMaxInr: r.comp_max_inr,
    compBasis: r.comp_basis,
    score: r.score,
    breakdown: parse(r.breakdown),
    verdict: r.verdict,
    reasons: parse<string[]>(r.reasons) ?? [],
    notes: parse<string[]>(r.notes) ?? [],
    jdText: r.jd_text,
    terms: parse(r.terms),
    recommendedFormat: r.recommended_format,
    docsState: r.docs_state,
    docsDetail: r.docs_detail,
    postedAt: r.posted_at,
    unplaced: parse<string[]>(r.unplaced) ?? [],
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    status: groupStatus(group),
    note: notes.join(' | '),
    appliedAt: group.find((g) => g.applied_at !== null)?.applied_at ?? null,
    // Task 10: a job is announced once: a row whose group was announced (through any of its rows) counts as announced
    notifiedAt: group.map((g) => g.notified_at).filter((n): n is string => n !== null).sort()[0] ?? null,
    citedFacts: parse<string[]>(r.cited_facts),
    band: bandOf(r, floorInr),
  };
}
