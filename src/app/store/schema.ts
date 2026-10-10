import type Database from 'better-sqlite3';

/**
 * The app catalogue's tables (spec §6). They live in the kernel's DB file but are the app's own: the app keeps its
 * schema version in `app_schema` (never the kernel's `user_version`) and its migrations never touch a kernel table.
 * Each entry is applied once, in order, in its own transaction, by `AppStore`.
 *
 * A job is one posting: `job_key` is `jobKey(source, sourceId)`, and `job_sources` holds that one pair (kept for
 * spec §6 and the lookup by source id). `dedupe_key` links one job listed on several sources: a non-preferred listing
 * points at the preferred row through `duplicate_of`.
 */
export const JOB_STATUSES = ['new', 'approved', 'applied', 'interview', 'offer', 'rejected', 'skipped'] as const;
/**
 * `missing`: QA passed, but a listed file is no longer on disk with its recorded sha256 (Task 10 fix round 1).
 * `stale` (final review I2): the documents cite a fact that is no longer citeable under the current pack and the user's
 * overrides; never offered for download, rebuilt the next time the posting is seen.
 */
export const DOCS_STATES = ['ready', 'blocked', 'below-floor', 'none', 'missing', 'stale'] as const;
/** The docs states of migration 1, frozen: that migration's SQL must never change. */
const V1_DOCS_STATES = ['ready', 'blocked', 'below-floor', 'none', 'missing'] as const;

const list = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(', ');

/**
 * A migration: SQL run in one transaction, or (for a table rebuild, which SQLite needs to change a CHECK) a function run
 * in one transaction with foreign keys off, after which `PRAGMA foreign_key_check` must be empty (SQLite's documented
 * table-rebuild procedure; `AppStore` turns foreign keys back on afterwards).
 */
export type AppMigration = string | { readonly foreignKeysOff: true; readonly run: (db: Database.Database) => void };

/**
 * Rebuilds `jobs` from its own stored SQL with `docs_state` allowing every current state, keeping every column, row,
 * index and trigger; then adds `cited_facts`. Refuses (throws) when the stored SQL does not have the expected CHECK.
 */
function staleMigration(db: Database.Database): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`).get() as { sql: string } | undefined;
  if (!row) throw new Error('migration: no jobs table');
  const oldCheck = `CHECK (docs_state IN (${list(V1_DOCS_STATES)}))`;
  if (row.sql.split(oldCheck).length !== 2 || !row.sql.startsWith('CREATE TABLE jobs (')) throw new Error('migration: the jobs table is not the expected shape');
  const sql = row.sql.replace(oldCheck, `CHECK (docs_state IN (${list(DOCS_STATES)}))`).replace(/^CREATE TABLE jobs \(/, 'CREATE TABLE jobs_rebuilt (');
  const extras = (db.prepare(`SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = 'jobs' AND sql IS NOT NULL ORDER BY type, name`).all() as { sql: string }[]).map((r) => r.sql);
  db.exec(sql);
  db.exec(`INSERT INTO jobs_rebuilt SELECT * FROM jobs`);
  db.exec(`DROP TABLE jobs`);
  db.exec(`ALTER TABLE jobs_rebuilt RENAME TO jobs`);
  for (const e of extras) db.exec(e);
  db.exec(`ALTER TABLE jobs ADD COLUMN cited_facts TEXT`);
}

export const APP_MIGRATIONS: readonly AppMigration[] = [
  `
  CREATE TABLE jobs (
    job_key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    duplicate_of TEXT REFERENCES jobs (job_key),
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    ats TEXT NOT NULL,
    location TEXT NOT NULL,
    remote TEXT,
    comp TEXT,
    comp_min_inr INTEGER,
    comp_max_inr INTEGER,
    comp_basis TEXT CHECK (comp_basis IS NULL OR comp_basis IN ('base', 'unknown')),
    score REAL,
    breakdown TEXT,
    verdict TEXT CHECK (verdict IS NULL OR verdict IN ('eligible', 'rejected', 'review')),
    reasons TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '[]',
    jd_text TEXT NOT NULL DEFAULT '',
    terms TEXT,
    recommended_format TEXT CHECK (recommended_format IS NULL OR recommended_format IN ('pdf', 'docx')),
    docs_state TEXT NOT NULL DEFAULT 'none' CHECK (docs_state IN (${list(V1_DOCS_STATES)})),
    docs_detail TEXT,
    posted_at TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (${list(JOB_STATUSES)})),
    note TEXT NOT NULL DEFAULT '',
    applied_at TEXT,
    UNIQUE (source, source_id)
  );
  CREATE INDEX jobs_by_dedupe_key ON jobs (dedupe_key);
  CREATE TABLE job_sources (
    job_key TEXT NOT NULL REFERENCES jobs (job_key),
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    PRIMARY KEY (source, source_id)
  );
  CREATE INDEX job_sources_by_job ON job_sources (job_key);
  CREATE TABLE job_docs (
    job_key TEXT NOT NULL REFERENCES jobs (job_key),
    kind TEXT NOT NULL CHECK (kind IN ('resume', 'cover')),
    format TEXT NOT NULL CHECK (format IN ('pdf', 'docx', 'html')),
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    pages INTEGER,
    qa_ok INTEGER NOT NULL CHECK (qa_ok IN (0, 1)),
    PRIMARY KEY (job_key, kind, format)
  );
  CREATE TABLE status_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    job_key TEXT NOT NULL REFERENCES jobs (job_key),
    "from" TEXT,
    "to" TEXT NOT NULL CHECK ("to" IN (${list(JOB_STATUSES)})),
    at TEXT NOT NULL,
    by TEXT NOT NULL CHECK (by IN ('user', 'migration'))
  );
  CREATE INDEX status_history_by_job ON status_history (job_key, seq);
  CREATE TRIGGER status_history_append_only_u BEFORE UPDATE ON status_history BEGIN SELECT RAISE(ABORT, 'status_history is append-only'); END;
  CREATE TRIGGER status_history_append_only_d BEFORE DELETE ON status_history BEGIN SELECT RAISE(ABORT, 'status_history is append-only'); END;
  -- INSERT OR REPLACE / REPLACE INTO on an existing seq would delete the old row without firing the delete trigger.
  CREATE TRIGGER status_history_append_only_r BEFORE INSERT ON status_history
    WHEN NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM status_history WHERE seq = NEW.seq)
    BEGIN SELECT RAISE(ABORT, 'status_history is append-only'); END;
  CREATE TABLE fact_overrides (
    fact_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE TABLE runs_summary (
    run_id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    counts TEXT NOT NULL,
    pack_hash TEXT NOT NULL,
    policy_hash TEXT NOT NULL
  );
  `,
  // Task 11: small app settings, e.g. `render.nonce` (the docs-rebuild counter that goes into the full pack).
  `
  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // Task 11 fix round 1 (review I1): a run's warnings and problems are kept with its summary.
  `
  ALTER TABLE runs_summary ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE runs_summary ADD COLUMN problems TEXT NOT NULL DEFAULT '[]';
  `,
  // m8: when a notification announced the job; a job is announced once. Rows that exist when the column is added are
  // the backlog the user has already seen, so they are stamped and never announced (R-I2).
  `
  ALTER TABLE jobs ADD COLUMN notified_at TEXT;
  UPDATE jobs SET notified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE notified_at IS NULL;
  `,
  // Task 13 (dashboard): the resume plan's unplaced fact ids (facts dated inside no role), and the applied snapshots:
  // the exact files the user sent, copied read-only into <jobKey>/applied-<day>/ when the status became applied.
  `
  ALTER TABLE jobs ADD COLUMN unplaced TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE job_snapshots (
    job_key TEXT NOT NULL REFERENCES jobs (job_key),
    day TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('resume', 'cover')),
    format TEXT NOT NULL CHECK (format IN ('pdf', 'docx', 'html')),
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (job_key, day, kind, format)
  );
  CREATE TRIGGER job_snapshots_append_only_u BEFORE UPDATE ON job_snapshots BEGIN SELECT RAISE(ABORT, 'job_snapshots is append-only'); END;
  CREATE TRIGGER job_snapshots_append_only_d BEFORE DELETE ON job_snapshots BEGIN SELECT RAISE(ABORT, 'job_snapshots is append-only'); END;
  `,
  // Task 13 fix round 2: every document download from the dashboard, so a snapshot can say when the kept copy differs
  // from what the user downloaded.
  `
  CREATE TABLE job_downloads (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    job_key TEXT NOT NULL REFERENCES jobs (job_key),
    file TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX job_downloads_by_job ON job_downloads (job_key, seq);
  `,
  // Final review I2: docs_state `stale`, and the fact ids a job's documents cite (JSON array; NULL until known).
  { foreignKeysOff: true, run: staleMigration },
];
