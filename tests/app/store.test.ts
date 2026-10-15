import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { ensureHome, setWarningSink } from '../../src/app/home.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStore, type JobUpsert } from '../../src/app/store/app-store.js';
import { AT, jobRow, LATER } from '../support/app-fixtures.js';
import { APP_MIGRATIONS } from '../../src/app/store/schema.js';
import { Store } from '../../src/kernel/store/store.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('AppStore schema', () => {
  it('migrates beside the kernel without touching kernel tables or its schema version', () => {
    const k = Store.open(':memory:');
    const kernelTables = k.db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all();
    const app = AppStore.on(k);
    expect(k.db.pragma('user_version', { simple: true })).toBe(1);
    expect(app.schemaVersion()).toBe(APP_MIGRATIONS.length);
    const after = k.db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all() as { name: string; sql: string }[];
    for (const t of kernelTables) expect(after).toContainEqual(t);
    const names = after.map((t) => t.name);
    for (const t of ['jobs', 'job_sources', 'job_docs', 'status_history', 'fact_overrides', 'runs_summary']) expect(names).toContain(t);
  });

  it('is idempotent across reopen of the same file, and refuses a newer app schema', () => {
    const d = mkdtempSync(join(tmpdir(), 'jp-app-'));
    tmp.push(d);
    const path = join(d, 'jobpilot.db');
    const a = AppStore.open(path);
    a.upsertJob(jobRow());
    a.close();
    const b = AppStore.open(path);
    expect(b.getJob('0123456789abcdef')?.company).toBe('Acme Robotics');
    b.kernel.db.prepare(`UPDATE app_schema SET version = 99`).run();
    b.close();
    expect(() => AppStore.open(path)).toThrow(/newer/);
  });
});

describe('AppStore.upsertJob', () => {
  it('inserts a new job with status new, an empty note, first_seen and last_seen', () => {
    const s = AppStore.on(Store.open(':memory:'));
    expect(s.upsertJob(jobRow())).toEqual({ jobKey: '0123456789abcdef', inserted: true, stale: false });
    const j = s.getJob('0123456789abcdef');
    expect(j).toMatchObject({ status: 'new', note: '', firstSeen: AT, lastSeen: AT, score: 70, docsState: 'none' });
    expect(j?.sources).toEqual([{ source: 'greenhouse', sourceId: '1001' }]);
  });

  it('keeps the user status and note, updates run-owned columns and last_seen, keeps first_seen', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    s.setStatus('0123456789abcdef', 'applied', 'user', AT);
    s.setNote('0123456789abcdef', 'spoke to the recruiter');
    expect(s.upsertJob(jobRow({ title: 'Staff Backend Engineer', score: 81, at: LATER }))).toEqual({ jobKey: '0123456789abcdef', inserted: false, stale: false });
    expect(s.getJob('0123456789abcdef')).toMatchObject({
      status: 'applied',
      note: 'spoke to the recruiter',
      title: 'Staff Backend Engineer',
      score: 81,
      firstSeen: AT,
      lastSeen: LATER,
    });
  });

  it('a re-emitted (source, sourceId) is a newer version of the same row', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    // A retitled career page re-emits the same sourceId, so the same job key; its dedupe key changes.
    const r = s.upsertJob(jobRow({ dedupeKey: 'eeeeeeeeeeeeeeee', title: 'Principal Engineer', at: LATER }));
    expect(r).toEqual({ jobKey: '0123456789abcdef', inserted: false, stale: false });
    expect(s.listJobs({ band: ['disclosed', 'undisclosed', 'review', 'rejected', 'below-floor'] })).toHaveLength(1);
    expect(s.getJob('0123456789abcdef')).toMatchObject({ title: 'Principal Engineer', dedupeKey: 'eeeeeeeeeeeeeeee' });
  });

  it('skips an observation older than last_seen: last_seen never moves backwards (fix round 2)', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow({ at: LATER, title: 'Newer' }));
    expect(s.upsertJob(jobRow({ at: AT, title: 'Older' }))).toEqual({ jobKey: '0123456789abcdef', inserted: false, stale: true });
    expect(s.getJob('0123456789abcdef')).toMatchObject({ title: 'Newer', lastSeen: LATER });
    expect(s.upsertJob(jobRow({ at: LATER, title: 'Same time' }))).toEqual({ jobKey: '0123456789abcdef', inserted: false, stale: false });
    expect(s.getJob('0123456789abcdef')?.title).toBe('Same time');
  });

  it('refuses a known (source, sourceId) under another job key', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    expect(() => s.upsertJob(jobRow({ jobKey: 'fedcba9876543210' }))).toThrow(/already job 0123456789abcdef/);
  });
});

describe('AppStore cross-source duplicates (fix round 1)', () => {
  const GH = '1111111111111111';
  const GH2 = '2222222222222222';
  const HM = '3333333333333333';
  const JB = '4444444444444444';
  const all = { band: ['disclosed', 'undisclosed', 'review', 'rejected', 'below-floor'] as const, duplicates: true };

  it('keeps two postings of one title from the same source as two jobs, never linked', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow({ jobKey: GH, sourceId: '1' }));
    s.upsertJob(jobRow({ jobKey: GH2, sourceId: '2' }));
    expect(s.listJobs().map((j) => [j.jobKey, j.duplicateOf])).toEqual([[GH, null], [GH2, null]]);
  });

  it('links a feed listing of an ATS job to the ATS row, whichever arrived first, and hides it by default', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow({ jobKey: HM, source: 'himalayas', sourceId: 'h1', at: AT }));
    s.upsertJob(jobRow({ jobKey: GH, source: 'greenhouse', sourceId: '1', at: LATER }));
    expect(s.getJob(HM)?.duplicateOf).toBe(GH);
    expect(s.getJob(GH)).toMatchObject({ duplicateOf: null, alsoListedOn: ['himalayas'] });
    expect(s.listJobs().map((j) => j.jobKey)).toEqual([GH]);
    expect(s.listJobs(all).map((j) => j.jobKey)).toEqual([GH, HM]);
  });

  it('between feeds, the earliest first_seen wins, then the job key', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow({ jobKey: JB, source: 'jobicy', sourceId: 'j1', at: LATER }));
    s.upsertJob(jobRow({ jobKey: HM, source: 'himalayas', sourceId: 'h1', at: AT }));
    expect(s.getJob(JB)?.duplicateOf).toBe(HM);
    const t = AppStore.on(Store.open(':memory:'));
    t.upsertJob(jobRow({ jobKey: JB, source: 'jobicy', sourceId: 'j1' }));
    t.upsertJob(jobRow({ jobKey: HM, source: 'himalayas', sourceId: 'h1' }));
    expect(t.getJob(JB)?.duplicateOf).toBe(HM);
    expect(t.getJob(HM)?.alsoListedOn).toEqual(['jobicy']);
  });

  it('with several same-source postings in a group, a feed listing links to the preferred one only', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow({ jobKey: GH2, sourceId: '2', at: LATER }));
    s.upsertJob(jobRow({ jobKey: GH, sourceId: '1', at: AT }));
    s.upsertJob(jobRow({ jobKey: HM, source: 'himalayas', sourceId: 'h1' }));
    expect([GH, GH2, HM].map((k) => s.getJob(k)?.duplicateOf)).toEqual([null, null, GH]);
  });

  it('unlinks a row whose dedupe key changes', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow({ jobKey: GH, sourceId: '1' }));
    s.upsertJob(jobRow({ jobKey: HM, source: 'himalayas', sourceId: 'h1' }));
    s.upsertJob(jobRow({ jobKey: HM, source: 'himalayas', sourceId: 'h1', dedupeKey: 'eeeeeeeeeeeeeeee', at: LATER }));
    expect(s.getJob(HM)?.duplicateOf).toBeNull();
    expect(s.getJob(GH)?.alsoListedOn).toEqual([]);
  });

  it('status and note live on the preferred row; a duplicate shows them, and a write to it lands on the group', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow({ jobKey: GH, sourceId: '1' }));
    s.upsertJob(jobRow({ jobKey: HM, source: 'himalayas', sourceId: 'h1' }));
    s.setStatus(HM, 'applied', 'user', AT);
    s.setNote(HM, 'via the feed');
    expect(s.getJob(GH)).toMatchObject({ status: 'applied', note: 'via the feed' });
    expect(s.getJob(HM)).toMatchObject({ status: 'applied', note: 'via the feed' });
    expect(s.getJob(GH)?.history).toEqual([{ from: 'new', to: 'applied', at: AT, by: 'user' }]);
    // Fix round 2: every row whose shown status changed records it, so each row's status has its own history.
    expect(s.getJob(HM)?.history).toEqual([{ from: 'new', to: 'applied', at: AT, by: 'user' }]);
  });

  it('a row that leaves its group keeps a history for the status it shows (fix round 2)', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow({ jobKey: GH, sourceId: '1' }));
    s.upsertJob(jobRow({ jobKey: HM, source: 'himalayas', sourceId: 'h1' }));
    s.setStatus(GH, 'approved', 'user', AT);
    s.upsertJob(jobRow({ jobKey: HM, source: 'himalayas', sourceId: 'h1', dedupeKey: 'eeeeeeeeeeeeeeee', at: LATER }));
    expect(s.getJob(HM)).toMatchObject({ duplicateOf: null, status: 'approved' });
    expect(s.getJob(HM)?.history.at(-1)).toMatchObject({ to: 'approved' });
  });
});

describe('AppStore status, note, docs, overrides and runs', () => {
  it('records every status change with from, to, at and by; an unchanged status records nothing', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    expect(s.setStatus('0123456789abcdef', 'approved', 'user', AT)).toBe(true);
    expect(s.setStatus('0123456789abcdef', 'approved', 'user', AT)).toBe(false);
    s.setStatus('0123456789abcdef', 'new', 'user', LATER);
    expect(s.getJob('0123456789abcdef')?.history).toEqual([
      { from: 'new', to: 'approved', at: AT, by: 'user' },
      { from: 'approved', to: 'new', at: LATER, by: 'user' },
    ]);
  });

  it('status_history is append-only: UPDATE, DELETE, INSERT OR REPLACE and REPLACE INTO are refused (fix round 2)', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    s.setStatus('0123456789abcdef', 'approved', 'user', AT);
    const db = s.kernel.db;
    const before = JSON.stringify(db.prepare(`SELECT * FROM status_history`).all());
    expect(() => db.prepare(`UPDATE status_history SET "to" = 'offer'`).run()).toThrow(/append-only/);
    expect(() => db.prepare(`DELETE FROM status_history`).run()).toThrow(/append-only/);
    expect(() => db.prepare(`INSERT OR REPLACE INTO status_history (seq, job_key, "from", "to", at, by) VALUES (1, '0123456789abcdef', 'new', 'offer', ?, 'user')`).run(AT)).toThrow(/append-only/);
    expect(() => db.prepare(`REPLACE INTO status_history (seq, job_key, "from", "to", at, by) VALUES (1, '0123456789abcdef', 'new', 'offer', ?, 'user')`).run(AT)).toThrow(/append-only/);
    expect(JSON.stringify(db.prepare(`SELECT * FROM status_history`).all())).toBe(before);
    s.setStatus('0123456789abcdef', 'applied', 'user', LATER);
    expect(s.getJob('0123456789abcdef')?.history).toHaveLength(2);
  });

  it('refuses an unknown status and an unknown job', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    expect(() => s.setStatus('0123456789abcdef', 'hired' as never, 'user', AT)).toThrow(/status/);
    expect(() => s.setStatus('ffffffffffffffff', 'applied', 'user', AT)).toThrow(/unknown job/);
    expect(() => s.setNote('ffffffffffffffff', 'x')).toThrow(/unknown job/);
  });

  it('putDocs replaces the documents of a job', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    const doc = { kind: 'resume' as const, format: 'pdf' as const, path: '0123456789abcdef/resume.pdf', sha256: 'a'.repeat(64), pages: 2, qaOk: true };
    s.putDocs('0123456789abcdef', [doc, { ...doc, format: 'docx', path: '0123456789abcdef/resume.docx', pages: null }]);
    s.putDocs('0123456789abcdef', [doc]);
    expect(s.getJob('0123456789abcdef')?.docs).toEqual([doc]);
  });

  it('stores fact overrides, validated, latest wins', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.setFactOverride('f-1', 'rejected', AT);
    s.setFactOverride('f-1', 'verified', LATER);
    s.setFactOverride('f-0', 'user-cannot-confirm', AT);
    expect(s.factOverrides()).toEqual({ 'f-0': 'user-cannot-confirm', 'f-1': 'verified' });
    expect(() => s.setFactOverride('f-2', 'maybe' as never, AT)).toThrow(/status/);
  });

  it('records runs and lists the latest n, newest first', () => {
    const s = AppStore.on(Store.open(':memory:'));
    for (const d of ['07', '09', '08']) {
      s.recordRun({ runId: `daily-2026-10-${d}`, at: `2026-10-${d}T01:30:00.000Z`, counts: { jobs: Number(d) }, packHash: 'p', policyHash: 'q' });
    }
    s.recordRun({ runId: 'daily-2026-10-09', at: '2026-10-09T01:30:00.000Z', counts: { jobs: 10 }, packHash: 'p', policyHash: 'q' });
    expect(s.listRuns(2)).toEqual([
      { runId: 'daily-2026-10-09', at: '2026-10-09T01:30:00.000Z', counts: { jobs: 10 }, packHash: 'p', policyHash: 'q', warnings: [], problems: [] },
      { runId: 'daily-2026-10-08', at: '2026-10-08T01:30:00.000Z', counts: { jobs: 8 }, packHash: 'p', policyHash: 'q', warnings: [], problems: [] },
    ]);
  });

  it('R-I2: the notified_at migration stamps the rows that exist when it is added, so the backlog is not announced', () => {
    const kernel = Store.open(':memory:');
    const db = kernel.db;
    db.exec(`CREATE TABLE IF NOT EXISTS app_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
    db.prepare(`INSERT INTO app_schema (id, version) VALUES (1, 0)`).run();
    for (const [i, m] of APP_MIGRATIONS.slice(0, 3).entries()) {
      db.exec(m as string);
      db.prepare(`UPDATE app_schema SET version = ?`).run(i + 1);
    }
    db.prepare(
      `INSERT INTO jobs (job_key, source, source_id, dedupe_key, company, title, url, ats, location, docs_state, first_seen, last_seen) VALUES ('0123456789abcdef', 'greenhouse', '1', 'dddddddddddddddd', 'Acme', 'Eng', 'https://x.example/1', 'greenhouse', 'Remote', 'ready', 'a', 'a')`,
    ).run();
    const s = AppStore.on(kernel);
    expect(s.getJob('0123456789abcdef')?.notifiedAt).not.toBeNull();
    // a row inserted afterwards by a run is not stamped
    s.upsertJob(jobRow({ jobKey: '00000000000000ff', sourceId: '2', docsState: 'ready' }));
    expect(s.getJob('00000000000000ff')?.notifiedAt).toBeNull();
  });

  it('I2: the stale migration keeps every row and foreign key of a version-6 DB, and allows docs_state stale', () => {
    const kernel = Store.open(':memory:');
    const db = kernel.db;
    db.exec(`CREATE TABLE IF NOT EXISTS app_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
    db.prepare(`INSERT INTO app_schema (id, version) VALUES (1, 0)`).run();
    for (const [i, m] of APP_MIGRATIONS.slice(0, 6).entries()) {
      db.exec(m as string);
      db.prepare(`UPDATE app_schema SET version = ?`).run(i + 1);
    }
    expect(() => db.prepare(`INSERT INTO jobs (job_key, source, source_id, dedupe_key, company, title, url, ats, location, docs_state, first_seen, last_seen) VALUES ('00000000000000aa', 'lever', '9', 'd', 'A', 'E', 'u', 'lever', 'R', 'stale', 'a', 'a')`).run()).toThrow(/CHECK/);
    const ins = db.prepare(
      `INSERT INTO jobs (job_key, source, source_id, dedupe_key, duplicate_of, company, title, url, ats, location, docs_state, first_seen, last_seen, notified_at, unplaced) VALUES (?, 'greenhouse', ?, 'dddddddddddddddd', ?, 'Acme', 'Eng', 'https://x.example/1', 'greenhouse', 'Remote', 'ready', 'a', 'a', 'n', '["f-1"]')`,
    );
    ins.run('0123456789abcdef', '1', null);
    ins.run('00000000000000ff', '2', '0123456789abcdef');
    db.prepare(`INSERT INTO job_sources (job_key, source, source_id) VALUES ('0123456789abcdef', 'greenhouse', '1')`).run();
    db.prepare(`INSERT INTO job_docs (job_key, kind, format, path, sha256, pages, qa_ok) VALUES ('0123456789abcdef', 'resume', 'pdf', '0123456789abcdef/resume.pdf', 'aa', 1, 1)`).run();
    db.prepare(`INSERT INTO status_history (job_key, "from", "to", at, by) VALUES ('0123456789abcdef', NULL, 'new', 'a', 'user')`).run();
    const before = db.prepare(`SELECT * FROM jobs ORDER BY job_key`).all();
    const s = AppStore.on(kernel);
    expect(s.schemaVersion()).toBe(APP_MIGRATIONS.length);
    expect(db.prepare(`SELECT * FROM jobs ORDER BY job_key`).all()).toEqual(before.map((r) => ({ ...(r as object), cited_facts: null })));
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs' AND sql IS NOT NULL`).all()).toEqual([{ name: 'jobs_by_dedupe_key' }, { name: 'jobs_list' }]);
    // stale is accepted now; foreign keys still hold
    expect(s.setDocs('0123456789abcdef', 'stale', 'cites a fact you rejected (f-1)', [])).toBe(true);
    expect(s.getJob('0123456789abcdef')?.docsState).toBe('stale');
    expect(() => db.prepare(`INSERT INTO job_docs (job_key, kind, format, path, sha256, pages, qa_ok) VALUES ('ffffffffffffffff', 'resume', 'pdf', 'x', 'aa', 1, 1)`).run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare(`UPDATE jobs SET docs_state = 'bogus'`).run()).toThrow(/CHECK/);
  });

  it('final I2: four processes opening a version-7 DB at once all succeed; the migrations run once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobpilot-race-'));
    tmp.push(dir);
    chmodSync(dir, 0o700);
    const path = join(dir, 'jobpilot.db');
    const kernel = Store.open(path);
    const db = kernel.db;
    db.exec(`CREATE TABLE IF NOT EXISTS app_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
    db.prepare(`INSERT INTO app_schema (id, version) VALUES (1, 0)`).run();
    for (const [i, m] of APP_MIGRATIONS.slice(0, 7).entries()) {
      if (typeof m === 'string') db.exec(m);
      else m.run(db);
      db.prepare(`UPDATE app_schema SET version = ?`).run(i + 1);
    }
    kernel.close();
    const at = Date.now() + 2500;
    const script = `import { AppStore } from ${JSON.stringify(join(import.meta.dirname, '../../src/app/store/app-store.ts'))};
while (Date.now() < ${at}) {}
try { const s = AppStore.open(${JSON.stringify(path)}, { schema: 'migrate' }); console.log('OK ' + s.schemaVersion()); s.close(); } catch (e) { console.log('ERR ' + e.message); }`;
    const child = () =>
      new Promise<string>((resolve) => {
        const c = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: join(import.meta.dirname, '../..') });
        let out = '';
        c.stdout.on('data', (d: Buffer) => (out += d.toString()));
        c.on('close', () => resolve(out.trim()));
      });
    const results = await Promise.all([child(), child(), child(), child()]);
    expect(results).toEqual(Array(4).fill(`OK ${APP_MIGRATIONS.length}`));
  }, 30_000);

  it('keeps warnings and problems with a run, and finds the latest run by prefix', () => {
    const s = AppStore.on(Store.open(':memory:'));
    const problem = { kind: 'failed', agent: 'src-greenhouse', item: 'Acme (greenhouse:acme)', reason: 'invalid_output: x' };
    s.recordRun({ runId: 'daily-2026-10-09', at: '2026-10-09T01:30:00.000Z', counts: {}, packHash: 'p', policyHash: 'q', warnings: ['w1'], problems: [problem] });
    s.recordRun({ runId: 'rebuild-2026-10-10', at: '2026-10-10T01:30:00.000Z', counts: {}, packHash: 'p', policyHash: 'q' });
    expect(s.latestRun('daily-')).toMatchObject({ runId: 'daily-2026-10-09', warnings: ['w1'], problems: [problem] });
    expect(s.latestRun('rebuild-')?.runId).toBe('rebuild-2026-10-10');
    expect(s.latestRun('nope-')).toBeUndefined();
  });
});

describe('AppStore.listJobs fit-first sort within the eligibility tier (A1)', () => {
  const k = (n: number) => n.toString(16).padStart(16, '0');
  function seed(): AppStore {
    const s = AppStore.on(Store.open(':memory:'));
    const rows: Partial<JobUpsert>[] = [
      { jobKey: k(1), sourceId: '1', compMinInr: 5_000_000, compMaxInr: 7_000_000, compBasis: 'base', score: 50 },
      { jobKey: k(2), sourceId: '2', compMinInr: null, compMaxInr: 9_000_000, compBasis: 'base', score: 40 },
      { jobKey: k(3), sourceId: '3', compMaxInr: 7_000_000, compBasis: 'base', score: 90 },
      { jobKey: k(4), sourceId: '4', score: 95 },
      { jobKey: k(5), sourceId: '5', score: 95, at: LATER },
      { jobKey: k(6), sourceId: '6', score: 80 },
      { jobKey: k(7), sourceId: '7', verdict: 'review', compMaxInr: 20_000_000, score: 99 },
      { jobKey: k(8), sourceId: '8', verdict: 'review', score: 60 },
      { jobKey: k(9), sourceId: '9', verdict: 'rejected', reasons: ['onsite'], score: null },
      { jobKey: k(10), sourceId: '10', score: 30, docsState: 'below-floor' },
      { jobKey: k(11), sourceId: '11', compMaxInr: 1_000_000, compBasis: 'base', score: 99 },
      { jobKey: k(12), sourceId: '12', score: 95 },
    ];
    for (const r of rows) s.upsertJob(jobRow(r));
    return s;
  }

  it('orders eligible (disclosed and undisclosed together), then review, each by score desc, max INR desc, first_seen desc, job key', () => {
    const s = seed();
    // k(11) is disclosed but under the 12 L floor: below-floor, hidden by default.
    expect(s.listJobs({ floorInr: 1_200_000 }).map((j) => j.jobKey)).toEqual([k(5), k(4), k(12), k(3), k(6), k(1), k(2), k(7), k(8)]);
    expect(s.listJobs({ floorInr: 1_200_000 }).map((j) => j.band)).toEqual([
      'undisclosed', 'undisclosed', 'undisclosed', 'disclosed', 'undisclosed', 'disclosed', 'disclosed', 'review', 'review',
    ]);
  });

  it('without a floor every disclosed comp counts as disclosed', () => {
    expect(seed().listJobs({}).map((j) => j.jobKey).slice(0, 4)).toEqual([k(11), k(5), k(4), k(12)]);
  });

  it('lists rejected and below-floor jobs only when filtered for', () => {
    const s = seed();
    expect(s.listJobs({ floorInr: 1_200_000, band: ['rejected'] }).map((j) => j.jobKey)).toEqual([k(9)]);
    expect(s.listJobs({ floorInr: 1_200_000, band: ['below-floor'] }).map((j) => j.jobKey)).toEqual([k(11), k(10)]);
  });

  it('filters by status, minimum score and text', () => {
    const s = seed();
    s.setStatus(k(6), 'applied', 'user', AT);
    s.upsertJob(jobRow({ jobKey: k(13), sourceId: '13', company: 'Globex Systems', title: 'Platform Engineer', score: 70 }));
    expect(s.listJobs({ status: ['applied'] }).map((j) => j.jobKey)).toEqual([k(6)]);
    expect(s.listJobs({ minScore: 95, floorInr: 1_200_000 }).map((j) => j.jobKey)).toEqual([k(5), k(4), k(12), k(7)]);
    expect(s.listJobs({ text: 'globex' }).map((j) => j.jobKey)).toEqual([k(13)]);
    expect(s.listJobs({ text: '100%_' })).toEqual([]);
  });
});

describe('jobpilot home and DB permissions (Task 13 fix rounds 3-4, M10/I5)', () => {
  let warnings: string[] = [];
  beforeEach(() => {
    warnings = [];
    setWarningSink((m) => warnings.push(m));
  });
  afterEach(() => setWarningSink(undefined));

  it('a fresh home (and out/) is created 0700; its DB and WAL files 0600', () => {
    const d = mkdtempSync(join(tmpdir(), 'jp-perm-'));
    tmp.push(d);
    const home = join(d, 'a', 'home');
    ensureHome(home);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'out')).mode & 0o777).toBe(0o700);
    const path = join(home, 'jobpilot.db');
    const a = AppStore.open(path);
    a.upsertJob(jobRow());
    for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) expect(statSync(f).mode & 0o777, f).toBe(0o600);
    a.close();
    expect(warnings).toEqual([]);
  });

  it('never chmods an existing home: an open one gets one warning per process, not per open', () => {
    const d = mkdtempSync(join(tmpdir(), 'jp-perm-'));
    tmp.push(d);
    chmodSync(d, 0o755);
    for (let i = 0; i < 3; i++) {
      ensureHome(d);
      AppStore.open(join(d, 'jobpilot.db')).close();
    }
    expect(statSync(d).mode & 0o777).toBe(0o755);
    const abs = realpathSync(d);
    expect(warnings).toEqual([`JOBPILOT_HOME ${abs} is readable by other users; run chmod 700 ${abs}`]);
  });

  it('a symlinked home pointing at a 2775 folder is left unchanged', () => {
    const d = mkdtempSync(join(tmpdir(), 'jp-perm-'));
    tmp.push(d);
    const target = join(d, 'shared');
    mkdirSync(target);
    chmodSync(target, 0o2775);
    const before = statSync(target).mode & 0o7777;
    const home = join(d, 'home-link');
    symlinkSync(target, home);
    ensureHome(home);
    AppStore.open(join(home, 'jobpilot.db')).close();
    expect(statSync(target).mode & 0o7777).toBe(before);
    expect(lstatSync(home).isSymbolicLink()).toBe(true);
    expect(warnings).toEqual([`JOBPILOT_HOME ${realpathSync(target)} is readable by other users; run chmod 700 ${realpathSync(target)}`]);
  });

  it('"." as the home leaves the working directory unchanged', () => {
    const d = mkdtempSync(join(tmpdir(), 'jp-perm-'));
    tmp.push(d);
    chmodSync(d, 0o755);
    const cwd = process.cwd();
    process.chdir(d);
    try {
      ensureHome('.');
      AppStore.open('jobpilot.db').close();
    } finally {
      process.chdir(cwd);
    }
    expect(statSync(d).mode & 0o777).toBe(0o755);
    // the absolute, resolved path, never "."
    const abs = realpathSync(d);
    expect(warnings).toEqual([`JOBPILOT_HOME ${abs} is readable by other users; run chmod 700 ${abs}`]);
  });

  it.skipIf(!existsSync('/private/tmp') || statSync('/private/tmp').uid === process.getuid?.())('a home the user does not own: a warning, never a throw', () => {
    const path = join('/private/tmp', `jp-nonowned-${process.pid}-${Date.now()}.db`);
    const before = statSync('/private/tmp').mode;
    try {
      const a = AppStore.open(path);
      a.upsertJob(jobRow());
      a.close();
      expect(statSync('/private/tmp').mode).toBe(before);
      expect(warnings).toEqual(['JOBPILOT_HOME /private/tmp is readable by other users; move JOBPILOT_HOME to a private folder, e.g. ~/.jobpilot']);
    } finally {
      for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    }
  });

  it('tightens an existing DB file the user owns, and never follows a symlinked DB for chmod', () => {
    const d = mkdtempSync(join(tmpdir(), 'jp-perm-'));
    tmp.push(d);
    const path = join(d, 'jobpilot.db');
    AppStore.open(path).close();
    chmodSync(path, 0o644);
    AppStore.open(path).close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const real = join(d, 'elsewhere.db');
    AppStore.open(real).close();
    chmodSync(real, 0o644);
    const link = join(d, 'link.db');
    symlinkSync(real, link);
    warnings = [];
    setWarningSink((m) => warnings.push(m));
    AppStore.open(link).close();
    expect(statSync(real).mode & 0o777).toBe(0o644);
    expect(warnings).toEqual([`${realpathSync(real)} is readable by other users; run chmod 600 ${realpathSync(real)}`]);
  });

  it('a dangling DB symlink: SQLite creates the target through it; the target is warned about, never chmodded (M14)', () => {
    const d = mkdtempSync(join(tmpdir(), 'jp-perm-'));
    tmp.push(d);
    const target = join(d, 'target.db');
    const link = join(d, 'jobpilot.db');
    symlinkSync(target, link);
    AppStore.open(link).close();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const mode = statSync(target).mode & 0o777;
    if ((mode & 0o077) !== 0) expect(warnings).toEqual([`${realpathSync(target)} is readable by other users; run chmod 600 ${realpathSync(target)}`]);
    else expect(warnings).toEqual([]);
  });
});

describe('AppStore: Task 13 additions (dashboard)', () => {
  it('keeps the plan\'s unplaced fact ids as a run-owned column (default empty)', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    expect(s.getJob('0123456789abcdef')?.unplaced).toEqual([]);
    s.upsertJob(jobRow({ unplaced: ['f-old-01', 'f-old-02'], at: LATER }));
    expect(s.getJob('0123456789abcdef')?.unplaced).toEqual(['f-old-01', 'f-old-02']);
    expect(s.listJobs()[0]?.unplaced).toEqual(['f-old-01', 'f-old-02']);
  });

  it('setStatus to applied stamps applied_at once on the whole group', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    s.setStatus('0123456789abcdef', 'applied', 'user', AT);
    expect(s.getJob('0123456789abcdef')?.appliedAt).toBe(AT);
    s.setStatus('0123456789abcdef', 'interview', 'user', LATER);
    s.setStatus('0123456789abcdef', 'applied', 'user', LATER);
    expect(s.getJob('0123456789abcdef')?.appliedAt).toBe(AT);
  });

  it('records applied snapshots, one set per job and day, append-only', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    const files = [
      { kind: 'resume' as const, format: 'pdf' as const, path: '0123456789abcdef/applied-2026-10-09/resume.pdf', sha256: 'a'.repeat(64) },
      { kind: 'cover' as const, format: 'pdf' as const, path: '0123456789abcdef/applied-2026-10-09/cover.pdf', sha256: 'b'.repeat(64) },
    ];
    expect(s.hasSnapshot('0123456789abcdef', '2026-10-09')).toBe(false);
    s.putSnapshot('0123456789abcdef', '2026-10-09', files, AT);
    expect(s.hasSnapshot('0123456789abcdef', '2026-10-09')).toBe(true);
    expect(s.snapshots('0123456789abcdef')).toEqual([{ day: '2026-10-09', at: AT, files: [files[1], files[0]] }]);
    expect(() => s.putSnapshot('0123456789abcdef', '2026-10-09', files, LATER)).toThrow();
    expect(() => s.kernel.db.prepare(`DELETE FROM job_snapshots`).run()).toThrow(/append-only/);
    expect(() => s.kernel.db.prepare(`UPDATE job_snapshots SET sha256 = 'x'`).run()).toThrow(/append-only/);
  });

  it('lists the status history of many jobs at once, for the jobs list', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    s.setStatus('0123456789abcdef', 'applied', 'user', AT);
    expect(s.histories(['0123456789abcdef', 'ffffffffffffffff'])).toEqual({ '0123456789abcdef': [{ from: 'new', to: 'applied', at: AT, by: 'user' }] });
  });
});
