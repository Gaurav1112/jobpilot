import { FactStatus } from '../pack/schema.js';
import type { Fact } from '../pack/schema.js';
import type { Posting } from '../types.js';
import { Store } from '../../kernel/store/store.js';
import { APP_MIGRATIONS, DOCS_STATES, JOB_STATUSES } from './schema.js';

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
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** The group's status (see `AppStore`): a duplicate shows its preferred row's. */
  readonly status: JobStatus;
  readonly note: string;
  readonly appliedAt: string | null;
  readonly band: Band;
}

export interface JobDetail extends JobView {
  readonly sources: { source: string; sourceId: string }[];
  readonly docs: Doc[];
  /** This row's status history; a group status change is recorded on every row of the group. */
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
  /** Also list duplicate listings (rows with `duplicateOf` set). Default false. */
  readonly duplicates?: boolean;
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
  'dedupe_key', 'company', 'title', 'url', 'ats', 'location', 'remote', 'comp', 'comp_min_inr', 'comp_max_inr', 'comp_basis', 'score',
  'breakdown', 'verdict', 'reasons', 'notes', 'jd_text', 'terms', 'recommended_format', 'docs_state', 'docs_detail', 'posted_at',
] as const;

function runParams(r: JobUpsert): unknown[] {
  return [
    r.dedupeKey, r.company, r.title, r.url, r.ats, r.location, json(r.remote), json(r.comp ?? null), r.compMinInr, r.compMaxInr, r.compBasis,
    r.score, json(r.breakdown), r.verdict, JSON.stringify(r.reasons), JSON.stringify(r.notes), r.jdText, json(r.terms), r.recommendedFormat,
    r.docsState, r.docsDetail, r.postedAt,
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
      for (const r of rows) {
        set.run(to, r.job_key);
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
  putDocs(jobKey: string, docs: readonly Doc[]): void {
    this.tx(() => {
      this.db.prepare(`DELETE FROM job_docs WHERE job_key = ?`).run(jobKey);
      const ins = this.db.prepare(`INSERT INTO job_docs (job_key, kind, format, path, sha256, pages, qa_ok) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const d of docs) ins.run(jobKey, d.kind, d.format, d.path, d.sha256, d.pages, d.qaOk ? 1 : 0);
    });
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
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    status: groupStatus(group),
    note: notes.join(' | '),
    appliedAt: group.find((g) => g.applied_at !== null)?.applied_at ?? null,
    band: bandOf(r, floorInr),
  };
}
