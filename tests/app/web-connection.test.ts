import { cpSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStore } from '../../src/app/store/app-store.js';
import { APP_MIGRATIONS } from '../../src/app/store/schema.js';
import { SharedStore } from '../../src/app/web/connection.js';
import { createTestDashboard } from '../../src/app/web/server-testing.js';
import { Sessions } from '../../src/app/web/security.js';
import { jobRow } from '../support/app-fixtures.js';

/**
 * dashboard-perf fix 5: the dashboard keeps ONE long-lived connection per process (so SQLite's page cache survives
 * between requests) and never lets it get in a run's way: no transaction is ever left open on it (a run can take the
 * write lock and checkpoint the WAL at any time), it is reopened when the schema version or the DB file changes (so a
 * migration by a run, or a newer jobpilot, is seen exactly as a fresh per-request open would see it).
 */
const root = join(import.meta.dirname, '../..');
const NOW = '2026-10-09T06:30:00.000Z';
const SID = 'jp_sid=' + 'cd'.repeat(16);
let home: string;
let db: string;
let opens: number;
let app: ReturnType<typeof createTestDashboard>;

const get = async (path: string): Promise<{ status: number; body: string }> => {
  const r = await app.request(path, { headers: { host: 'localhost', cookie: SID } });
  return { status: r.status, body: await r.text() };
};
const other = (): Database.Database => new Database(db, { timeout: 0 });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jobpilot-conn-'));
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  db = join(home, 'jobpilot.db');
  const s = AppStore.open(db);
  s.upsertJob(jobRow({ jobKey: '1111111111111111', title: 'First Job' }));
  s.close();
  opens = 0;
  app = createTestDashboard({ home, clock: { now: () => NOW }, sessions: new Sessions(Buffer.alloc(32, 7)) }, { onOpen: () => opens++ });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('the dashboard keeps one read connection', () => {
  it('reuses it across requests and sees what another connection (a run) committed meanwhile', async () => {
    expect((await get('/')).body).toContain('First Job');
    const s = AppStore.open(db);
    s.upsertJob(jobRow({ jobKey: '2222222222222222', sourceId: '2', dedupeKey: 'eeeeeeeeeeeeeeee', title: 'Second Job' }));
    s.close();
    const page = (await get('/')).body;
    expect(page).toContain('Second Job');
    await get('/runs');
    await get('/facts');
    expect(opens).toBe(1);
  });

  it('never leaves a transaction open: a run can take the write lock and truncate the WAL right after any request', async () => {
    for (const path of ['/', '/runs', '/facts', '/jobs/1111111111111111', '/companies', '/freelance']) {
      await get(path);
      const o = other();
      try {
        o.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS t_probe (x); DROP TABLE t_probe; COMMIT');
        expect(o.pragma('wal_checkpoint(TRUNCATE)'), path).toEqual([{ busy: 0, log: 0, checkpointed: 0 }]);
      } finally {
        o.close();
      }
    }
  });

  it('a schema version newer than this jobpilot (a run of newer code migrated) is refused as a fresh open would, then recovers', async () => {
    await get('/');
    const o = other();
    o.prepare(`UPDATE app_schema SET version = ?`).run(APP_MIGRATIONS.length + 1);
    const refused = await get('/');
    expect(refused.status).toBe(500);
    expect(refused.body).toMatch(/newer than this jobpilot/);
    o.prepare(`UPDATE app_schema SET version = ?`).run(APP_MIGRATIONS.length);
    o.close();
    expect((await get('/')).body).toContain('First Job');
    expect(opens).toBeGreaterThanOrEqual(2);
  });

  it('a migration by another process (an index added) is picked up by reopening', async () => {
    await get('/');
    const o = other();
    o.prepare(`UPDATE app_schema SET version = ?`).run(APP_MIGRATIONS.length - 1);
    o.close();
    // the dashboard reopens, migrates the last step again (IF NOT EXISTS), and serves
    expect((await get('/')).body).toContain('First Job');
    expect(opens).toBe(2);
    const v = new Database(db, { readonly: true });
    expect((v.prepare(`SELECT version FROM app_schema`).get() as { version: number }).version).toBe(APP_MIGRATIONS.length);
    v.close();
  });

  it('a database file replaced on disk (a restore) is read from the new file', async () => {
    await get('/');
    const alt = join(home, 'alt.db');
    const s = AppStore.open(alt);
    s.upsertJob(jobRow({ jobKey: '3333333333333333', sourceId: '3', dedupeKey: 'cccccccccccccccc', title: 'Restored Job' }));
    s.close();
    renameSync(alt, db);
    rmSync(`${db}-wal`, { force: true });
    rmSync(`${db}-shm`, { force: true });
    const page = (await get('/')).body;
    expect(page).toContain('Restored Job');
    expect(page).not.toContain('First Job');
  });

  it('writes from the dashboard commit at once', async () => {
    const r = await app.request('/jobs/1111111111111111/note', {
      method: 'POST',
      headers: { host: 'localhost', cookie: SID, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded', 'hx-request': 'true' },
      body: new URLSearchParams({ note: 'hello', _csrf: new Sessions(Buffer.alloc(32, 7)).token('cd'.repeat(16)) }).toString(),
    });
    expect(r.status).toBe(200);
    const o = other();
    try {
      expect((o.prepare(`SELECT note FROM jobs WHERE job_key = '1111111111111111'`).get() as { note: string }).note).toBe('hello');
      o.exec('BEGIN IMMEDIATE; COMMIT');
    } finally {
      o.close();
    }
  });
});

describe('SharedStore guards', () => {
  it('a use that leaves a transaction open (a bug) is rolled back and the connection replaced', () => {
    let n = 0;
    const shared = new SharedStore(db, 1000, () => n++);
    shared.use((s) => {
      s.kernel.db.exec('BEGIN IMMEDIATE');
      s.setSetting('probe', 'left open');
    });
    const o = other();
    try {
      o.exec('BEGIN IMMEDIATE; COMMIT');
      expect(o.prepare(`SELECT value FROM app_settings WHERE key = 'probe'`).get()).toBeUndefined();
    } finally {
      o.close();
    }
    shared.use((s) => s.getSetting('x'));
    expect(n).toBe(2);
    shared.close();
  });

  it('reports a schema newer than this code (serve exits so launchd restarts it on the new code)', () => {
    let newer = 0;
    const shared = new SharedStore(db, 1000, () => {}, () => newer++);
    shared.use(() => 1);
    const o = other();
    o.prepare(`UPDATE app_schema SET version = ?`).run(APP_MIGRATIONS.length + 1);
    o.close();
    expect(() => shared.use(() => 1)).toThrow(/newer than this jobpilot/);
    expect(newer).toBe(1);
  });

  it('a busy error keeps the connection; any other error replaces it', () => {
    let n = 0;
    const shared = new SharedStore(db, 1000, () => n++);
    expect(() => shared.use(() => { throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }); })).toThrow('busy');
    shared.use(() => 1);
    expect(n).toBe(1);
    expect(() => shared.use(() => { throw new Error('boom'); })).toThrow('boom');
    shared.use(() => 1);
    expect(n).toBe(2);
    shared.close();
  });
});

