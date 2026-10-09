/**
 * The app catalogue's tables (spec §6). They live in the kernel's DB file but are the app's own: the app keeps its
 * schema version in `app_schema` (never the kernel's `user_version`) and its migrations never touch a kernel table.
 * Each entry is applied once, in order, in its own transaction, by `AppStore`.
 */
export const JOB_STATUSES = ['new', 'approved', 'applied', 'interview', 'offer', 'rejected', 'skipped'] as const;
export const DOCS_STATES = ['ready', 'blocked', 'below-floor', 'none'] as const;

const list = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(', ');

export const APP_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE jobs (
    job_key TEXT PRIMARY KEY,
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
    docs_state TEXT NOT NULL DEFAULT 'none' CHECK (docs_state IN (${list(DOCS_STATES)})),
    docs_detail TEXT,
    posted_at TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (${list(JOB_STATUSES)})),
    note TEXT NOT NULL DEFAULT '',
    applied_at TEXT
  );
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
];
