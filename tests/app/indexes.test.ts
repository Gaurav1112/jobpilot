import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AppStore } from '../../src/app/store/app-store.js';
import { APP_MIGRATIONS } from '../../src/app/store/schema.js';
import { canonicalJson } from '../../src/kernel/canonical.js';
import { Store } from '../../src/kernel/store/store.js';
import { fillJobs } from '../support/jobs-fixture.js';

/**
 * dashboard-perf fixes 2 and 3: migrations 16-18 only add indexes (the jobs list's covering index, events by run, the
 * job page's Rendered@1 lookup). They change no row and no existing schema object, and the queries they are for use them.
 */
const NEW_INDEXES = ['jobs_list', 'events_by_run', 'envelopes_rendered_by_job', 'events_step_done'];

/** Every table's rows and every schema object's SQL (except the given new ones), hashed. */
function dumpHash(db: Database.Database, skipObjects: readonly string[] = []): string {
  const h = createHash('sha256');
  const objs = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  for (const o of objs) {
    if (skipObjects.includes(o.name)) continue;
    h.update(JSON.stringify(o));
    if (o.type === 'table' && o.name !== 'app_schema') for (const r of db.prepare(`SELECT * FROM "${o.name}" ORDER BY rowid`).all()) h.update(JSON.stringify(r));
  }
  return h.digest('hex');
}

/** A DB at app schema 15 (career-sites), with rows in the tables the new indexes cover. */
function v15(): Store {
  const kernel = Store.open(':memory:');
  const db = kernel.db;
  db.exec(`CREATE TABLE IF NOT EXISTS app_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  db.prepare(`INSERT INTO app_schema (id, version) VALUES (1, 0)`).run();
  for (const [i, m] of APP_MIGRATIONS.slice(0, 15).entries()) {
    if (typeof m === 'string') db.exec(m);
    else {
      db.pragma('foreign_keys = OFF');
      m.run(db);
      db.pragma('foreign_keys = ON');
    }
    db.prepare(`UPDATE app_schema SET version = ?`).run(i + 1);
  }
  return kernel;
}

function rendered(kernel: Store, jobKey: string, n: number): void {
  const env = { envelopeId: `env-${jobKey}-${n}`, stepKey: `step-${n}`, index: 0, type: 'Rendered@1', producer: { agentId: 'renderer', version: '1.1.0', contractHash: 'h' }, parents: [], payload: { jobKey, files: [], plan: { n } } };
  kernel.db.prepare(`INSERT INTO envelopes (envelope_id, step_key, idx, type, body) VALUES (?, ?, ?, ?, ?)`).run(env.envelopeId, env.stepKey, 0, env.type, canonicalJson(env));
}

describe('migrations 16-19: indexes only', () => {
  it('the registry has 19 migrations; 16-19 are literals that create one index each', () => {
    expect(APP_MIGRATIONS.length).toBe(19);
    for (const [i, name] of NEW_INDEXES.entries()) {
      const m = APP_MIGRATIONS[15 + i];
      expect(typeof m).toBe('string');
      expect((m as string).trim()).toMatch(new RegExp(`^CREATE INDEX IF NOT EXISTS ${name} ON `));
      expect((m as string).match(/;/g)?.length).toBe(1);
    }
  });

  it('migrating a populated v15 DB leaves every table and every existing object byte-identical', () => {
    const kernel = v15();
    const db = kernel.db;
    // legacy tables filled through raw SQL at v15: the jobs (through AppStore after migrating would add indexes first)
    for (let i = 0; i < 5; i++) kernel.appendEvent(`run-${i % 2}`, `t${i}`, 'step_done', { i }, 'p');
    for (let i = 0; i < 4; i++) rendered(kernel, `${i}`.repeat(16), i);
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('render.nonce', '3')`).run();
    db.prepare(
      `INSERT INTO jobs (job_key, source, source_id, dedupe_key, company, title, url, ats, location, first_seen, last_seen, jd_text, verdict, score) VALUES ('aaaaaaaaaaaaaaaa', 'greenhouse', '1', 'd', 'Acme Robotics', 'SRE', 'https://acme.example/1', 'greenhouse', 'Remote', 't', 't', 'long text', 'eligible', 70)`,
    ).run();
    const before = dumpHash(db);
    const s = AppStore.on(kernel);
    expect(s.schemaVersion()).toBe(19);
    expect(dumpHash(db, NEW_INDEXES)).toBe(before);
    const added = (db.prepare(`SELECT name, tbl_name FROM sqlite_master WHERE name IN (${NEW_INDEXES.map(() => '?').join(', ')}) ORDER BY name`).all(...NEW_INDEXES) as { name: string; tbl_name: string }[]);
    expect(added).toEqual([
      { name: 'envelopes_rendered_by_job', tbl_name: 'envelopes' },
      { name: 'events_by_run', tbl_name: 'events' },
      { name: 'events_step_done', tbl_name: 'events' },
      { name: 'jobs_list', tbl_name: 'jobs' },
    ]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('an index that already exists (a racing opener built it) is not an error', () => {
    const kernel = v15();
    kernel.db.exec(APP_MIGRATIONS[16] as string);
    expect(AppStore.on(kernel).schemaVersion()).toBe(19);
  });
});

describe('the slow queries use the new indexes (EXPLAIN QUERY PLAN)', () => {
  const plan = (db: Database.Database, sql: string, ...args: unknown[]): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail).join('\n');

  it('the jobs list reads the covering index, never the table', () => {
    const app = fillJobs(AppStore.on(Store.open(':memory:')), 60);
    const db = app.kernel.db;
    const seen: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      seen.push(sql);
      return prepare(sql);
    }) as typeof db.prepare;
    try {
      app.listJobsPage({ floorInr: 4_000_000 }, { page: 1, size: 100, newAfterMs: 0 });
      app.listJobsPage({ floorInr: 4_000_000, status: ['new', 'applied'], text: 'eng', minScore: 10 }, { page: 1, size: 100, newAfterMs: 0 });
    } finally {
      db.prepare = prepare;
    }
    const scans = seen.filter((s) => /GROUP BY band|ORDER BY band/.test(s));
    expect(scans.length).toBe(4);
    for (const sql of scans) {
      const p = plan(db, sql, { floor: 4_000_000, newAfter: 0, limit: 100, offset: 0, minScore: 10, text: 'eng' });
      expect(p, sql).toMatch(/USING COVERING INDEX jobs_list/);
      expect(p, sql).not.toMatch(/SCAN j\b(?! USING COVERING)/);
    }
  });

  it('events of one run, and the job page envelope lookup, are index searches', () => {
    const app = AppStore.on(Store.open(':memory:'));
    const db = app.kernel.db;
    expect(plan(db, `SELECT * FROM events WHERE run_id = ? ORDER BY seq`, 'r')).toMatch(/SEARCH events USING INDEX events_by_run \(run_id=\?\)/);
    expect(plan(db, `SELECT body FROM envelopes WHERE type = 'Rendered@1' AND json_extract(body, '$.payload.jobKey') = ? ORDER BY envelope_id`, 'k')).toMatch(
      /SEARCH envelopes USING INDEX envelopes_rendered_by_job/,
    );
    // the "newest envelope" readers (NEWEST_FIRST): the step_done lookup is an index search, not an events scan
    expect(plan(db, `SELECT MAX(v.seq) FROM events v WHERE v.kind = 'step_done' AND json_extract(v.data, '$.stepKey') = ?`, 'k')).toMatch(/SEARCH v USING (COVERING )?INDEX events_step_done/);
  });

  it('renderedPlanOf still finds the plan behind the documents', () => {
    const app = AppStore.on(Store.open(':memory:'));
    fillJobs(app, 3);
    const key = (app.kernel.db.prepare(`SELECT job_key FROM jobs ORDER BY job_key LIMIT 1`).get() as { job_key: string }).job_key;
    app.putDocs(key, [{ kind: 'resume', format: 'pdf', path: `${key}/resume.pdf`, sha256: 'a'.repeat(64), pages: 1, qaOk: true }]);
    const env = { envelopeId: 'env-r', stepKey: 's', index: 0, type: 'Rendered@1', producer: { agentId: 'renderer', version: '1.1.0', contractHash: 'h' }, parents: [], payload: { jobKey: key, files: [{ path: `${key}/resume.pdf`, sha256: 'a'.repeat(64) }], plan: { p: 1 } } };
    app.kernel.db.prepare(`INSERT INTO envelopes (envelope_id, step_key, idx, type, body) VALUES (?, ?, ?, ?, ?)`).run(env.envelopeId, 's', 0, 'Rendered@1', canonicalJson(env));
    expect(app.renderedPlanOf(key)).toEqual({ p: 1 });
  });
});
