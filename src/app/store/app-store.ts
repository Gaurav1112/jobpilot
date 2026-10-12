import { FactStatus } from '../pack/schema.js';
import type { Fact } from '../pack/schema.js';
import type { Posting } from '../types.js';
import { dirname } from 'node:path';
import { Store } from '../../kernel/store/store.js';
import { checkHome, fileWarning, homeWarning, warnOnce } from '../home.js';
import { APP_MIGRATIONS, DOCS_STATES, GIG_DOCS_STATES, GIG_KINDS, GIG_LISTS, GIG_STATUSES, JOB_STATUSES } from './schema.js';

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
/** Sources that are the employer's own ATS or career site; their listing is preferred over a feed's. */
export const ATS_SOURCES: ReadonlySet<string> = new Set(['greenhouse', 'lever', 'ashby', 'careers']);

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

/** Preferred first: an ATS source over a feed, then the earliest first_seen, then the job key. */
function preferred(a: Pick<JobRowDb, 'source' | 'first_seen' | 'job_key'>, b: Pick<JobRowDb, 'source' | 'first_seen' | 'job_key'>): number {
  const rank = (s: string) => (ATS_SOURCES.has(s) ? 0 : 1);
  return rank(a.source) - rank(b.source) || cmp(a.first_seen, b.first_seen) || cmp(a.job_key, b.job_key);
}

/**
 * The app catalogue, beside the kernel's tables in the same DB file.
 *
 * - **One posting, one job.** The row identity is `jobKey(source, sourceId)`: two postings from one source are two jobs
 *   even with the same title, and a re-emitted posting is a newer version of its row (an upsert).
 * - **Cross-source duplicates.** Rows with one `dedupe_key` from *different* sources are one job listed twice. All are
 *   kept; every row whose source differs from the group's preferred row (`preferred`: ATS over feed, then earliest
 *   first_seen, then job key) points at it through `duplicate_of`. Rows from the preferred row's own source stay
 *   separate jobs. `listJobs` hides duplicates by default and gives the preferred row `alsoListedOn`.
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
    const version = (db.prepare(`SELECT version FROM app_schema WHERE id = 1`).get() as { version: number }).version;
    if (version > APP_MIGRATIONS.length) {
      throw new Error(`app schema version ${version} is newer than this jobpilot (${APP_MIGRATIONS.length})`);
    }
    for (let v = version; v < APP_MIGRATIONS.length; v++) {
      const m = APP_MIGRATIONS[v] ?? '';
      if (typeof m === 'string') {
        db.transaction(() => {
          db.exec(m);
          db.prepare(`UPDATE app_schema SET version = ? WHERE id = 1`).run(v + 1);
        })();
        continue;
      }
      // A table rebuild: foreign keys off around the transaction (they cannot change inside one), checked before commit.
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          m.run(db);
          const broken = db.pragma('foreign_key_check') as unknown[];
          if (broken.length > 0) throw new Error(`app migration ${v + 1} would break ${broken.length} foreign keys`);
          db.prepare(`UPDATE app_schema SET version = ? WHERE id = 1`).run(v + 1);
        })();
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
  upsertJob(r: JobUpsert): { jobKey: string; inserted: boolean; stale: boolean } {
    return this.tx(() => {
      const cur = this.row(r.jobKey);
      this.assertIdentity(r, cur);
      if (cur && r.at < cur.last_seen) return { jobKey: r.jobKey, inserted: false, stale: true };
      if (cur) {
        this.db
          .prepare(`UPDATE jobs SET ${RUN_COLUMNS.map((c) => `${c} = ?`).join(', ')}, last_seen = ? WHERE job_key = ?`)
          .run(...runParams(r), r.at, r.jobKey);
        if (cur.dedupe_key !== r.dedupeKey) this.relink(cur.dedupe_key);
      } else {
        this.insert(r, undefined);
      }
      this.relink(r.dedupeKey);
      return { jobKey: r.jobKey, inserted: !cur, stale: false };
    });
  }

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
      this.relink(r.dedupeKey);
      return outcome;
    });
  }

  /** Whether any row of the job's group has a status history entry (the user, or an earlier import, decided). */
  private groupHasHistory(jobKey: string): boolean {
    const { top, dups } = this.group(jobKey);
    const keys = [top, ...dups].map((r) => r.job_key);
    return this.db.prepare(`SELECT 1 FROM status_history WHERE job_key IN (${keys.map(() => '?').join(', ')}) LIMIT 1`).get(...keys) !== undefined;
  }

  /** Recomputes `duplicate_of` for one dedupe group. */
  private relink(dedupeKey: string): void {
    const rows = (this.db.prepare(`SELECT job_key, source, first_seen, duplicate_of FROM jobs WHERE dedupe_key = ?`).all(dedupeKey) as Pick<
      JobRowDb,
      'job_key' | 'source' | 'first_seen' | 'duplicate_of'
    >[]).sort(preferred);
    const top = rows[0];
    if (!top) return;
    const set = this.db.prepare(`UPDATE jobs SET duplicate_of = ? WHERE job_key = ?`);
    for (const r of rows) {
      const dup = r !== top && r.source !== top.source ? top.job_key : null;
      if (dup !== r.duplicate_of) set.run(dup, r.job_key);
    }
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
      .sort(
        (a, b) =>
          BAND_RANK[a.band] - BAND_RANK[b.band] ||
          (a.band === 'disclosed' ? (b.compMaxInr ?? 0) - (a.compMaxInr ?? 0) : 0) ||
          (b.score ?? -Infinity) - (a.score ?? -Infinity) ||
          cmp(b.firstSeen, a.firstSeen) ||
          cmp(a.jobKey, b.jobKey),
      );
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
    notifiedAt: r.notified_at,
    citedFacts: parse<string[]>(r.cited_facts),
    band: bandOf(r, floorInr),
  };
}
