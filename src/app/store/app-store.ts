import { FactStatus } from '../pack/schema.js';
import type { Fact } from '../pack/schema.js';
import type { Posting } from '../types.js';
import { Store } from '../../kernel/store/store.js';
import { APP_MIGRATIONS, DOCS_STATES, JOB_STATUSES } from './schema.js';

export type JobStatus = (typeof JOB_STATUSES)[number];
/** How far the user got with a job; a migration merge keeps the furthest. `rejected` (by the employer) follows applying. */
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
  readonly jobKey: string;
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
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly status: JobStatus;
  readonly note: string;
  readonly appliedAt: string | null;
  readonly band: Band;
}

export interface JobDetail extends JobView {
  readonly sources: { source: string; sourceId: string }[];
  readonly docs: Doc[];
  readonly history: { from: JobStatus | null; to: JobStatus; at: string; by: 'user' | 'migration' }[];
}

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
}

export interface RunSummary {
  readonly runId: string;
  readonly at: string;
  readonly counts: unknown;
  readonly packHash: string;
  readonly policyHash: string;
}

interface JobRowDb {
  job_key: string;
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
  first_seen: string;
  last_seen: string;
  status: JobStatus;
  note: string;
  applied_at: string | null;
}

const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));
const parse = <T>(s: string | null): T | null => (s === null ? null : (JSON.parse(s) as T));
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Run-owned columns, in the order `runParams` binds them. */
const RUN_COLUMNS = [
  'company', 'title', 'url', 'ats', 'location', 'remote', 'comp', 'comp_min_inr', 'comp_max_inr', 'comp_basis', 'score', 'breakdown',
  'verdict', 'reasons', 'notes', 'jd_text', 'terms', 'recommended_format', 'docs_state', 'docs_detail', 'posted_at',
] as const;

function runParams(r: JobUpsert): unknown[] {
  return [
    r.company, r.title, r.url, r.ats, r.location, json(r.remote), json(r.comp ?? null), r.compMinInr, r.compMaxInr, r.compBasis, r.score,
    json(r.breakdown), r.verdict, JSON.stringify(r.reasons), JSON.stringify(r.notes), r.jdText, json(r.terms), r.recommendedFormat,
    r.docsState, r.docsDetail, r.postedAt,
  ];
}

function assertStatus(s: string): asserts s is JobStatus {
  if (!(JOB_STATUSES as readonly string[]).includes(s)) throw new Error(`invalid job status ${s}; expected one of ${JOB_STATUSES.join(', ')}`);
}

/**
 * The app catalogue, beside the kernel's tables in the same DB file. Runs write only run-owned columns
 * (`upsertJob`); status and note belong to the user and change only through `setStatus` and `setNote`.
 */
export class AppStore {
  private constructor(
    readonly kernel: Store,
    private readonly owned: boolean,
  ) {}

  /** Opens the DB file: the kernel's migrations first (through `Store.open`), then the app's. `close` closes both. */
  static open(path: string): AppStore {
    const kernel = Store.open(path);
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
    db.exec(`CREATE TABLE IF NOT EXISTS app_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
    db.prepare(`INSERT OR IGNORE INTO app_schema (id, version) VALUES (1, 0)`).run();
    const version = (db.prepare(`SELECT version FROM app_schema WHERE id = 1`).get() as { version: number }).version;
    if (version > APP_MIGRATIONS.length) {
      throw new Error(`app schema version ${version} is newer than this jobpilot (${APP_MIGRATIONS.length})`);
    }
    for (let v = version; v < APP_MIGRATIONS.length; v++) {
      db.transaction(() => {
        db.exec(APP_MIGRATIONS[v] ?? '');
        db.prepare(`UPDATE app_schema SET version = ? WHERE id = 1`).run(v + 1);
      })();
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

  /**
   * The job a posting belongs to: the job its `(source, sourceId)` is already attached to (a newer version of a known
   * posting, or a Desk row), else its own job key.
   */
  resolveKey(jobKey: string, source: string, sourceId: string): string {
    const hit = this.db.prepare(`SELECT job_key FROM job_sources WHERE source = ? AND source_id = ?`).get(source, sourceId) as
      | { job_key: string }
      | undefined;
    return hit?.job_key ?? jobKey;
  }

  /**
   * Inserts the job, or updates its run-owned columns and `last_seen` (never `status`, `note`, `applied_at` or
   * `first_seen`), and attaches its source. A re-emitted `(source, sourceId)` maps to the job it is attached to, so
   * a newer version of a posting never makes a duplicate row.
   */
  upsertJob(r: JobUpsert): { jobKey: string; inserted: boolean } {
    return this.tx(() => {
      const key = this.resolveKey(r.jobKey, r.source, r.sourceId);
      const exists = this.db.prepare(`SELECT 1 FROM jobs WHERE job_key = ?`).get(key) !== undefined;
      if (exists) {
        this.db
          .prepare(`UPDATE jobs SET ${RUN_COLUMNS.map((c) => `${c} = ?`).join(', ')}, last_seen = ? WHERE job_key = ?`)
          .run(...runParams(r), r.at, key);
      } else {
        this.db
          .prepare(`INSERT INTO jobs (job_key, ${RUN_COLUMNS.join(', ')}, first_seen, last_seen) VALUES (?, ${RUN_COLUMNS.map(() => '?').join(', ')}, ?, ?)`)
          .run(key, ...runParams(r), r.at, r.at);
      }
      this.attachSource(key, r.source, r.sourceId);
      return { jobKey: key, inserted: !exists };
    });
  }

  /** Attaches a source to a job; a `(source, sourceId)` already attached anywhere is left where it is. */
  attachSource(jobKey: string, source: string, sourceId: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO job_sources (job_key, source, source_id) VALUES (?, ?, ?)`).run(jobKey, source, sourceId);
  }

  /**
   * Migration only. A new job is inserted with the Desk's status, note and applied_at and a `migration` history entry.
   * A `(source, sourceId)` already imported is `present` (a re-run). An existing job gets the source attached and, unless
   * the user has set a status on it (a `user` history entry), takes the Desk row's user-owned columns as a merge:
   * - the furthest status wins (`STATUS_PRECEDENCE`), recorded as a `migration` history entry when it changes;
   * - a non-empty note not already in the job's note is appended after ` | `;
   * - applied_at keeps the existing value, else takes the Desk's.
   * The outcome is `attached` for a job a run found first (no history) and `merged` for one an earlier Desk row created
   * (several Desk rows, one job key); `conflict` says the Desk status differed from the job's.
   */
  importJob(r: JobImport): { outcome: 'inserted' | 'attached' | 'merged' | 'present'; conflict: boolean } {
    assertStatus(r.status);
    return this.tx(() => {
      const known = this.db.prepare(`SELECT job_key FROM job_sources WHERE source = ? AND source_id = ?`).get(r.source, r.sourceId);
      if (known !== undefined) return { outcome: 'present', conflict: false };
      const cur = this.db.prepare(`SELECT status, note, applied_at FROM jobs WHERE job_key = ?`).get(r.jobKey) as
        | { status: JobStatus; note: string; applied_at: string | null }
        | undefined;
      if (!cur) {
        this.db
          .prepare(
            `INSERT INTO jobs (job_key, ${RUN_COLUMNS.join(', ')}, first_seen, last_seen, status, note, applied_at)
             VALUES (?, ${RUN_COLUMNS.map(() => '?').join(', ')}, ?, ?, ?, ?, ?)`,
          )
          .run(r.jobKey, ...runParams(r), r.at, r.at, r.status, r.note, r.appliedAt);
        this.history(r.jobKey, null, r.status, r.statusAt, 'migration');
        this.attachSource(r.jobKey, r.source, r.sourceId);
        return { outcome: 'inserted', conflict: false };
      }
      const bys = (this.db.prepare(`SELECT DISTINCT by FROM status_history WHERE job_key = ?`).all(r.jobKey) as { by: string }[]).map((b) => b.by);
      const conflict = cur.status !== r.status;
      if (!bys.includes('user')) {
        const to = STATUS_PRECEDENCE[r.status] > STATUS_PRECEDENCE[cur.status] ? r.status : cur.status;
        const note = r.note === '' || cur.note.includes(r.note) ? cur.note : cur.note === '' ? r.note : `${cur.note} | ${r.note}`;
        this.db.prepare(`UPDATE jobs SET status = ?, note = ?, applied_at = ? WHERE job_key = ?`).run(to, note, cur.applied_at ?? r.appliedAt, r.jobKey);
        // A run-found job gets its first history entry even when the Desk status is `new`.
        if (to !== cur.status || bys.length === 0) this.history(r.jobKey, cur.status, to, r.statusAt, 'migration');
      }
      this.attachSource(r.jobKey, r.source, r.sourceId);
      return { outcome: bys.length === 0 ? 'attached' : 'merged', conflict };
    });
  }

  private history(jobKey: string, from: JobStatus | null, to: JobStatus, at: string, by: 'user' | 'migration'): void {
    this.db.prepare(`INSERT INTO status_history (job_key, "from", "to", at, by) VALUES (?, ?, ?, ?, ?)`).run(jobKey, from, to, at, by);
  }

  /** Sets a user status and appends it to the history. Returns false (and records nothing) when it is unchanged. */
  setStatus(jobKey: string, to: JobStatus, by: 'user' | 'migration', at: string): boolean {
    assertStatus(to);
    return this.tx(() => {
      const cur = this.db.prepare(`SELECT status FROM jobs WHERE job_key = ?`).get(jobKey) as { status: JobStatus } | undefined;
      if (!cur) throw new Error(`unknown job ${jobKey}`);
      if (cur.status === to) return false;
      this.db.prepare(`UPDATE jobs SET status = ? WHERE job_key = ?`).run(to, jobKey);
      this.history(jobKey, cur.status, to, at, by);
      return true;
    });
  }

  setNote(jobKey: string, note: string): void {
    const res = this.db.prepare(`UPDATE jobs SET note = ? WHERE job_key = ?`).run(note, jobKey);
    if (res.changes !== 1) throw new Error(`unknown job ${jobKey}`);
  }

  /** Replaces the job's documents with `docs` (an empty list clears them). */
  putDocs(jobKey: string, docs: readonly Doc[]): void {
    this.tx(() => {
      this.db.prepare(`DELETE FROM job_docs WHERE job_key = ?`).run(jobKey);
      const ins = this.db.prepare(`INSERT INTO job_docs (job_key, kind, format, path, sha256, pages, qa_ok) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const d of docs) ins.run(jobKey, d.kind, d.format, d.path, d.sha256, d.pages, d.qaOk ? 1 : 0);
    });
  }

  getJob(jobKey: string): JobDetail | undefined {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE job_key = ?`).get(jobKey) as JobRowDb | undefined;
    if (!row) return undefined;
    const sources = (
      this.db.prepare(`SELECT source, source_id FROM job_sources WHERE job_key = ? ORDER BY source, source_id`).all(jobKey) as { source: string; source_id: string }[]
    ).map((s) => ({ source: s.source, sourceId: s.source_id }));
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
    const history = this.db
      .prepare(`SELECT "from", "to", at, by FROM status_history WHERE job_key = ? ORDER BY seq`)
      .all(jobKey) as JobDetail['history'];
    return { ...view(row), sources, docs, history };
  }

  /**
   * Comp-first (spec §7): disclosed comp at or above the floor by max INR desc, then undisclosed, then review; within
   * each band by score desc (no score last), then first_seen desc, then job key, a total order. Rejected and
   * below-floor jobs follow in that band order only when `filter.band` names them.
   */
  listJobs(filter: JobFilter = {}): JobView[] {
    const bands = new Set(filter.band ?? DEFAULT_BANDS);
    const statuses = filter.status === undefined ? undefined : new Set<string>(filter.status);
    const text = filter.text?.toLowerCase();
    const rows = (this.db.prepare(`SELECT * FROM jobs`).all() as JobRowDb[]).map((r) => view(r, filter.floorInr));
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

  /** Records (or re-records, for a re-projected run) one run's summary. */
  recordRun(s: RunSummary): void {
    this.db
      .prepare(
        `INSERT INTO runs_summary (run_id, at, counts, pack_hash, policy_hash) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET at = excluded.at, counts = excluded.counts, pack_hash = excluded.pack_hash, policy_hash = excluded.policy_hash`,
      )
      .run(s.runId, s.at, JSON.stringify(s.counts), s.packHash, s.policyHash);
  }

  /** The latest `n` runs, newest first. */
  listRuns(n: number): RunSummary[] {
    const rows = this.db.prepare(`SELECT * FROM runs_summary ORDER BY at DESC, run_id DESC LIMIT ?`).all(n) as {
      run_id: string;
      at: string;
      counts: string;
      pack_hash: string;
      policy_hash: string;
    }[];
    return rows.map((r) => ({ runId: r.run_id, at: r.at, counts: JSON.parse(r.counts) as unknown, packHash: r.pack_hash, policyHash: r.policy_hash }));
  }
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

function view(r: JobRowDb, floorInr?: number): JobView {
  return {
    jobKey: r.job_key,
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
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    status: r.status,
    note: r.note,
    appliedAt: r.applied_at,
    band: bandOf(r, floorInr),
  };
}
