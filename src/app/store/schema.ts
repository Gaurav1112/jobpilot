import type Database from 'better-sqlite3';

/**
 * The app catalogue's tables (spec §6). They live in the kernel's DB file but are the app's own: the app keeps its
 * schema version in `app_schema` (never the kernel's `user_version`) and its migrations never change a kernel table
 * (its definition or its rows); migrations 17-22 only add read-path indexes on two of them (dashboard-perf).
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
 * The CHECK lists of the freelance migration (the 8th), frozen: that migration's SQL must never change, whatever the
 * current lists below become (as `V1_DOCS_STATES`).
 */
const V8_GIG_STATUSES = ['new', 'shortlisted', 'applied', 'replied', 'interviewing', 'won', 'lost', 'skipped'] as const;
const V8_GIG_KINDS = ['contract', 'gig', 'bounty', 'network-alert'] as const;
const V8_GIG_LISTS = ['contracts', 'gigs', 'review', 'below-floor'] as const;
const V8_GIG_DOCS_STATES = ['ready', 'blocked', 'missing', 'none'] as const;
const V8_NETWORK_STATUSES = ['todo', 'applied', 'screening', 'passed', 'rejected'] as const;

/**
 * Freelance (spec §8): the current lists. A change to one needs a new migration (a table rebuild for its CHECK).
 * A gig's status: new → shortlisted → applied → replied → interviewing → won | lost | skipped (the user's, never a run's).
 */
export const GIG_STATUSES = ['new', 'shortlisted', 'applied', 'replied', 'interviewing', 'won', 'lost', 'skipped'] as const;
export const GIG_KINDS = ['contract', 'gig', 'bounty', 'network-alert'] as const;
/** The ranked list a gig is in (`rankGigs`); `below-floor`: a contract or gig with fit under the fit floor. NULL: rejected or not scored. */
export const GIG_LISTS = ['contracts', 'gigs', 'review', 'below-floor'] as const;
/** As the daily ones, without `below-floor` (that is a list here) and `stale`. */
export const GIG_DOCS_STATES = ['ready', 'blocked', 'missing', 'none'] as const;
export const NETWORK_STATUSES = ['todo', 'applied', 'screening', 'passed', 'rejected'] as const;

/** Career-site coverage (spec §3): a company's registry status and the user's override of it. A change needs a new migration (a table rebuild for its CHECK). */
export const COMPANY_STATUSES = ['verified', 'proposed', 'rejected', 'failing', 'failed'] as const;
export const COMPANY_OVERRIDES = ['approved', 'rejected'] as const;

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

/**
 * Rebuilds `table` (its stored SQL `CREATE TABLE t (` or, after an earlier rebuild, `CREATE TABLE "t" (`) from its own stored SQL with each `[old, new]` CHECK replaced, keeping every column, row (rowid
 * included), index and trigger (SQLite's documented table-rebuild procedure). Refuses (throws) when the stored SQL does
 * not hold each old CHECK exactly once, so a schema that is not the expected one is never rewritten.
 */
export function rebuildChecks(db: Database.Database, table: string, checks: readonly (readonly [string, string])[]): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string } | undefined;
  if (!row) throw new Error(`migration: no ${table} table`);
  // A table made by CREATE TABLE keeps its name bare; one a rebuild renamed into place is stored quoted ("gig_docs").
  const head = [`CREATE TABLE ${table} (`, `CREATE TABLE "${table}" (`].find((h) => row.sql.startsWith(h));
  if (head === undefined) throw new Error(`migration: the ${table} table is not the expected shape`);
  let sql = row.sql;
  for (const [from, to] of checks) {
    if (sql.split(from).length !== 2) throw new Error(`migration: the ${table} table is not the expected shape`);
    sql = sql.replace(from, () => to);
  }
  const rebuilt = `${table}_rebuilt`;
  const cols = (db.prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`).all(table) as { name: string }[]).map((c) => `"${c.name}"`).join(', ');
  const extras = (db.prepare(`SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = ? AND sql IS NOT NULL ORDER BY type, name`).all(table) as { sql: string }[]).map((r) => r.sql);
  db.exec(`CREATE TABLE ${rebuilt} (${sql.slice(head.length)}`);
  db.exec(`INSERT INTO ${rebuilt} (rowid, ${cols}) SELECT rowid, ${cols} FROM ${table} ORDER BY rowid`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${rebuilt} RENAME TO ${table}`);
  for (const e of extras) db.exec(e);
}

/**
 * freelance-v2 (migration 23): the gig documents and their applied snapshots allow the cover letter of a contract role
 * on an employer job board, kind `cover` in format `txt`, `pdf`, `docx` or `html`. Both CHECKs are literals on purpose:
 * this migration's SQL must never change. Rows, indexes and triggers are kept as they were.
 */
function gigCoverMigration(db: Database.Database): void {
  const checks = [
    ["CHECK (kind IN ('proposal', 'pitch', 'resume'))", "CHECK (kind IN ('proposal', 'pitch', 'resume', 'cover'))"],
    ["CHECK (format IN ('txt', 'pdf', 'docx'))", "CHECK (format IN ('txt', 'pdf', 'docx', 'html'))"],
  ] as const;
  for (const table of ['gig_docs', 'gig_snapshots']) {
    // A table that already has both new CHECKs (an opener that lost a race, or a re-run) is left as it is.
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string } | undefined;
    if (row !== undefined && checks.every(([from, to]) => row.sql.includes(to) && !row.sql.includes(from))) continue;
    rebuildChecks(db, table, checks);
  }
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
  // Freelance Task 9: the freelance pipeline's own tables (spec §8). The full-time tables are not touched.
  `
  CREATE TABLE gigs (
    gig_key TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL,
    duplicate_of TEXT REFERENCES gigs (gig_key),
    platform TEXT NOT NULL,
    source_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    client TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (${list(V8_GIG_KINDS)})),
    budget TEXT NOT NULL,
    rate TEXT,
    hours TEXT NOT NULL,
    verdict TEXT CHECK (verdict IS NULL OR verdict IN ('eligible', 'rejected', 'review')),
    reasons TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '[]',
    flags TEXT NOT NULL DEFAULT '[]',
    fit REAL,
    breakdown TEXT,
    list TEXT CHECK (list IS NULL OR list IN (${list(V8_GIG_LISTS)})),
    docs_state TEXT NOT NULL DEFAULT 'none' CHECK (docs_state IN (${list(V8_GIG_DOCS_STATES)})),
    docs_detail TEXT,
    posted_at TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (${list(V8_GIG_STATUSES)})),
    note TEXT NOT NULL DEFAULT '',
    applied_at TEXT,
    notified_at TEXT,
    UNIQUE (platform, source_id)
  );
  CREATE INDEX gigs_by_dedupe_key ON gigs (dedupe_key);
  CREATE TABLE gig_docs (
    gig_key TEXT NOT NULL REFERENCES gigs (gig_key),
    kind TEXT NOT NULL CHECK (kind IN ('proposal', 'pitch', 'resume')),
    format TEXT NOT NULL CHECK (format IN ('txt', 'pdf', 'docx')),
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    pages INTEGER,
    PRIMARY KEY (gig_key, kind, format)
  );
  CREATE TABLE gig_status_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    gig_key TEXT NOT NULL REFERENCES gigs (gig_key),
    "from" TEXT,
    "to" TEXT NOT NULL CHECK ("to" IN (${list(V8_GIG_STATUSES)})),
    at TEXT NOT NULL,
    by TEXT NOT NULL CHECK (by IN ('user', 'migration'))
  );
  CREATE INDEX gig_status_history_by_gig ON gig_status_history (gig_key, seq);
  CREATE TRIGGER gig_status_history_append_only_u BEFORE UPDATE ON gig_status_history BEGIN SELECT RAISE(ABORT, 'gig_status_history is append-only'); END;
  CREATE TRIGGER gig_status_history_append_only_d BEFORE DELETE ON gig_status_history BEGIN SELECT RAISE(ABORT, 'gig_status_history is append-only'); END;
  CREATE TRIGGER gig_status_history_append_only_r BEFORE INSERT ON gig_status_history
    WHEN NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM gig_status_history WHERE seq = NEW.seq)
    BEGIN SELECT RAISE(ABORT, 'gig_status_history is append-only'); END;
  CREATE TABLE gig_runs_summary (
    run_id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    counts TEXT NOT NULL,
    pack_hash TEXT NOT NULL,
    policy_hash TEXT NOT NULL,
    warnings TEXT NOT NULL DEFAULT '[]',
    problems TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE source_health (
    platform TEXT NOT NULL,
    week TEXT NOT NULL CHECK (week GLOB '[0-9][0-9][0-9][0-9]-W[0-5][0-9]'),
    fetched INTEGER NOT NULL DEFAULT 0,
    eligible INTEGER NOT NULL DEFAULT 0,
    above_floor INTEGER NOT NULL DEFAULT 0,
    shortlisted INTEGER NOT NULL DEFAULT 0,
    applied INTEGER NOT NULL DEFAULT 0,
    replied INTEGER NOT NULL DEFAULT 0,
    won INTEGER NOT NULL DEFAULT 0,
    runs INTEGER NOT NULL DEFAULT 0,
    failed_runs INTEGER NOT NULL DEFAULT 0,
    probe_failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (platform, week)
  );
  -- The runs already counted into source_health, so projecting a run twice never counts it twice.
  CREATE TABLE source_health_runs (
    run_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    PRIMARY KEY (run_id, platform)
  );
  CREATE TABLE gig_snapshots (
    gig_key TEXT NOT NULL REFERENCES gigs (gig_key),
    day TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('proposal', 'pitch', 'resume')),
    format TEXT NOT NULL CHECK (format IN ('txt', 'pdf', 'docx')),
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (gig_key, day, kind, format)
  );
  CREATE TRIGGER gig_snapshots_append_only_u BEFORE UPDATE ON gig_snapshots BEGIN SELECT RAISE(ABORT, 'gig_snapshots is append-only'); END;
  CREATE TRIGGER gig_snapshots_append_only_d BEFORE DELETE ON gig_snapshots BEGIN SELECT RAISE(ABORT, 'gig_snapshots is append-only'); END;
  CREATE TABLE network_status (
    network_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN (${list(V8_NETWORK_STATUSES)})),
    updated_at TEXT NOT NULL
  );
  `,
  // Career-site coverage Task 0: the company registry the weekly coverage pipeline fills and the daily adapters read.
  // A literal on purpose (no interpolated lists): it must never change, whatever the current lists become.
  `
  CREATE TABLE companies (
    company_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    website TEXT NOT NULL,
    careers_url TEXT,
    platform TEXT,
    platform_slug TEXT,
    board_url TEXT,
    status TEXT NOT NULL CHECK (status IN ('verified', 'proposed', 'rejected', 'failing', 'failed')),
    reasons TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL,
    jobs_seen INTEGER,
    last_verified TEXT,
    failing_since TEXT,
    fail_weeks INTEGER NOT NULL DEFAULT 0,
    user_override TEXT CHECK (user_override IS NULL OR user_override IN ('approved', 'rejected')),
    updated_at TEXT NOT NULL
  );
  CREATE INDEX companies_by_status ON companies (status, company_key);
  `,
  // Coverage Task 3 fix round 2: the hosts a coverage run has disabled (challenge, 401, 403, 429, robots refusals), keyed
  // by the run, so a resumed run starts knowing them. A literal on purpose.
  `
  CREATE TABLE coverage_host_state (
    run_key TEXT NOT NULL,
    host TEXT NOT NULL,
    reason TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (run_key, host)
  );
  `,
  // Career-sites Task 8: the page adapters' state across daily runs (board = '<platform> <ref>', a job URL, the IST day
  // of its last fetch, a content hash, the raw posting JSON or NULL). Additive; empty unless a page adapter ran.
  `
  CREATE TABLE platform_pages (
    board TEXT NOT NULL,
    url TEXT NOT NULL,
    fetched_on TEXT NOT NULL,
    hash TEXT NOT NULL,
    raw TEXT,
    PRIMARY KEY (board, url)
  );
  `,
  // Career-sites Task 8 fix round 3: consecutive non-404 4xx refetches that kept a page's posting (a good fetch resets it).
  `ALTER TABLE platform_pages ADD COLUMN errors INTEGER NOT NULL DEFAULT 0;`,
  // Career-sites Task 10: a job's ATS job id (text/ats-id.ts), beside the jobs table so its rows stay as they were; a
  // NULL board is a company page's bare gh_jid. Additive; a row only for a job whose posting states an id. A literal.
  `
  CREATE TABLE job_ats (
    job_key TEXT PRIMARY KEY REFERENCES jobs (job_key),
    platform TEXT NOT NULL,
    board TEXT,
    ats_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    company_norm TEXT NOT NULL
  );
  CREATE INDEX job_ats_by_company ON job_ats (company_norm);
  `,
  // Career-sites Task 10 fix round 5: a tenant-scoped posting's board ref and platform id (its source id, split), so one
  // job seen under a retired board ref and its new one is linked (store/links.ts). Additive; a literal.
  `
  CREATE TABLE job_board_ids (
    job_key TEXT PRIMARY KEY REFERENCES jobs (job_key),
    source TEXT NOT NULL,
    board TEXT NOT NULL,
    platform_id TEXT NOT NULL,
    company_norm TEXT NOT NULL
  );
  CREATE INDEX job_board_ids_by_company ON job_board_ids (company_norm);
  `,
  // Career-sites Task 11 fix round 1: the status the coverage verdicts alone give a company (no user override), so undoing
  // an approve restores what coverage last decided. NULL: no coverage verdict yet (a company added on the dashboard).
  // Backfilled from rows no override has touched. Additive; a literal.
  `
  ALTER TABLE companies ADD COLUMN coverage_status TEXT;
  UPDATE companies SET coverage_status = status WHERE user_override IS NULL AND status <> 'rejected'
    AND NOT (source = 'pick' AND last_verified IS NULL AND reasons = '["added by you, resolves on the next coverage run"]');
  `,
  // dashboard-perf fix 2: the jobs list's covering index. Every column the list filters, bands, sorts and counts on, led
  // by duplicate_of (the default view's `duplicate_of IS NULL`, and a group's rows for its status), so the list never
  // reads the table (whose rows carry the description in overflow pages). Index only; IF NOT EXISTS, so an opener that
  // lost a race is not refused. A literal.
  `CREATE INDEX IF NOT EXISTS jobs_list ON jobs (duplicate_of, verdict, docs_state, comp_max_inr, score, first_seen, status, job_key, company, title);`,
  // dashboard-perf fix 3: a run's events (`Store.events(runId)`: the run projector, freelance health) without scanning
  // every event. An index on a kernel table: it changes neither the table nor a row. A literal.
  `CREATE INDEX IF NOT EXISTS events_by_run ON events (run_id, seq);`,
  // dashboard-perf fix 3: the job page's `renderedPlanOf` (the Rendered@1 envelopes of one job) without scanning every
  // envelope body. Partial (Rendered@1 rows only), so it is small and costs other envelope writes nothing; building it
  // reads the envelopes table once (see perf-report.md for its time on a large DB). A literal.
  `CREATE INDEX IF NOT EXISTS envelopes_rendered_by_job ON envelopes (json_extract(body, '$.payload.jobKey')) WHERE type = 'Rendered@1';`,
  // retention review: "newest envelope" by the seq of its step's step_done event, never by rowid (NEWEST_FIRST in
  // app-store.ts). Partial (step_done events only); an index on a kernel table, no row changed. A literal.
  `CREATE INDEX IF NOT EXISTS events_step_done ON events (json_extract(data, '$.stepKey'), seq) WHERE kind = 'step_done';`,
  // retention re-review: the "newest envelope" readers find their envelopes by type and key, never by scanning every
  // envelope (`contractPostings`: Posting@1 by job; `gigExtras`, the freelance tab: Gig@1 and GigRendered@1 by gig).
  // Partial, one type each, so other envelope writes pay nothing; index only. Literals.
  `CREATE INDEX IF NOT EXISTS envelopes_posting_by_job ON envelopes (json_extract(body, '$.payload.jobKey')) WHERE type = 'Posting@1';`,
  `CREATE INDEX IF NOT EXISTS envelopes_gig_by_key ON envelopes (json_extract(body, '$.payload.gigKey')) WHERE type = 'Gig@1';`,
  `CREATE INDEX IF NOT EXISTS envelopes_gig_rendered_by_key ON envelopes (json_extract(body, '$.payload.gigKey')) WHERE type = 'GigRendered@1';`,
  // freelance-v2: gig_docs and gig_snapshots allow the cover letter (kind cover, format html): a CHECK change, so a
  // table rebuild that keeps every row, index and trigger (`gigCoverMigration`).
  { foreignKeysOff: true, run: gigCoverMigration },
];
