import { copyFileSync, cpSync, existsSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStore, SchemaBehindError } from '../../src/app/store/app-store.js';
import { runCoverage } from '../../src/app/coverage/run.js';
import { liveHolder, withLock } from '../../src/app/lock.js';
import { offlineProviders } from '../../src/app/offline.js';
import { upgradeUnderLock } from '../../src/app/upgrade.js';
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

describe('the dashboard never migrates (review I2): only runs and the CLI do, under the lock', () => {
  const FIX = join(root, 'tests/fixtures/coverage/e2e');
  const version = (): number => {
    const v = new Database(db, { readonly: true });
    try {
      return (v.prepare(`SELECT version FROM app_schema`).get() as { version: number }).version;
    } finally {
      v.close();
    }
  };
  const behind = (): void => {
    const o = other();
    o.prepare(`UPDATE app_schema SET version = ?`).run(APP_MIGRATIONS.length - 1);
    o.close();
  };

  it('a schema behind this code: 503 "being upgraded" on every request, the database untouched', async () => {
    behind();
    for (const path of ['/', '/runs', '/facts']) {
      const r = await get(path);
      expect(r.status, path).toBe(503);
      expect(r.body).toContain('jobpilot is being upgraded');
      expect(r.body).toContain('the next run (or <code>jobpilot facts list</code>) applies it');
    }
    const hx = await app.request('/', { headers: { host: 'localhost', cookie: SID, 'hx-request': 'true' } });
    expect(hx.status).toBe(503);
    expect(hx.headers.get('retry-after')).toBe('30');
    expect(version()).toBe(APP_MIGRATIONS.length - 1);
    expect(opens).toBe(0);
  });

  it('the dashboard that was serving sees a behind schema as upgrading, never migrates it itself', async () => {
    expect((await get('/')).status).toBe(200);
    behind();
    expect((await get('/')).status).toBe(503);
    expect(version()).toBe(APP_MIGRATIONS.length - 1);
  });

  it('a run migrates it under the lock, then the dashboard serves', async () => {
    behind();
    expect((await get('/')).status).toBe(503);
    copyFileSync(join(FIX, 'companies.yaml'), join(home, 'pack', 'companies.yaml'));
    let checked = false;
    const r = await runCoverage({
      home, clock: { now: () => '2026-10-11T14:30:00.000Z' }, fetch: offlineProviders(FIX).fetch, sleep: async () => {}, codeHash: 'conn',
      onLocked: () => {
        // the lock is held and the schema is still behind: the migration happens inside the run's lock
        expect(liveHolder(home)).toMatchObject({ pid: process.pid, command: 'run-coverage' });
        expect(version()).toBe(APP_MIGRATIONS.length - 1);
        checked = true;
      },
    });
    expect(checked).toBe(true);
    expect(r.status).toBe('completed');
    expect(version()).toBe(APP_MIGRATIONS.length);
    const page = await get('/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('First Job');
  });

  it('jobpilot facts list (the CLI the page names) upgrades under the lock, and refuses while a run holds it', async () => {
    behind();
    await expect(withLock(home, 'run', async () => upgradeUnderLock(home, 'facts list'))).rejects.toThrow(/another jobpilot process|lock/i);
    expect(version()).toBe(APP_MIGRATIONS.length - 1);
    await expect(upgradeUnderLock(home, 'facts list')).resolves.toBe(true);
    expect(version()).toBe(APP_MIGRATIONS.length);
    await expect(upgradeUnderLock(home, 'facts list')).resolves.toBe(false); // current: nothing to do, no lock taken
  });

  it('starting the dashboard (its CSRF secret) applies no migration', () => {
    behind();
    createTestDashboard({ home, clock: { now: () => NOW } }, {});
    const v = new Database(db, { readonly: true });
    try {
      expect((v.prepare(`SELECT version FROM app_schema`).get() as { version: number }).version).toBe(APP_MIGRATIONS.length - 1);
      expect(v.prepare(`SELECT value FROM app_settings WHERE key = 'dashboard.csrf_secret'`).get()).toMatchObject({ value: expect.stringMatching(/^[0-9a-f]{64}$/) });
    } finally {
      v.close();
    }
  });

  it('P11: a SchemaBehindError from any route (e.g. Resolve now opening the DB) is the 503 upgrade page, not a 500', async () => {
    const d = createTestDashboard({ home, clock: { now: () => NOW }, sessions: new Sessions(Buffer.alloc(32, 7)) }, { beforeRoute: () => { throw new SchemaBehindError(); } });
    const r = await d.request('/companies', { headers: { host: 'localhost', cookie: SID } });
    expect(r.status).toBe(503);
    expect(await r.text()).toContain('jobpilot is being upgraded');
  });

  it('a home without a database: the dashboard starts, creates nothing, and answers 503 until a run creates it', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'jobpilot-conn-fresh-'));
    try {
      cpSync(join(root, 'tests/fixtures/pack'), join(fresh, 'pack'), { recursive: true });
      const d = createTestDashboard({ home: fresh, clock: { now: () => NOW } }, {});
      const r = await d.request('/', { headers: { host: 'localhost', cookie: SID } });
      expect(r.status).toBe(503);
      const body = await r.text();
      expect(body).toContain('no database yet; the first run creates it');
      expect(body).not.toContain('being upgraded');
      expect(existsSync(join(fresh, 'jobpilot.db'))).toBe(false);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('the WAL file stays bounded beside the long-lived connection (review)', () => {
  it('a run\'s large writes leave no large -wal behind once the dashboard has been idle', () => {
    const shared = new SharedStore(db, 1000);
    shared.use((s) => s.getSetting('x'));
    const walBytes = (): number => (existsSync(`${db}-wal`) ? statSync(`${db}-wal`).size : 0);
    const sizes: number[] = [];
    for (let run = 0; run < 3; run++) {
      // a simulated run: a big transaction from another connection, which then closes (the dashboard's stays open)
      const w = new Database(db);
      w.exec('CREATE TABLE IF NOT EXISTS t_run (x BLOB)');
      const ins = w.prepare('INSERT INTO t_run VALUES (randomblob(4000))');
      w.transaction(() => {
        for (let i = 0; i < 5_000; i++) ins.run();
      })();
      w.close();
      expect(walBytes()).toBeGreaterThan(10_000_000); // the dashboard's open connection kept it
      shared.maintain();
      sizes.push(walBytes());
    }
    for (const s of sizes) expect(s).toBeLessThanOrEqual(SharedStore.JOURNAL_LIMIT_BYTES);
    expect(sizes).toEqual([0, 0, 0]);
    shared.close();
  });

  it('PASSIVE first; TRUNCATE only when PASSIVE copied every frame (a reader pinning frames: no TRUNCATE)', () => {
    const shared = new SharedStore(db, 1000);
    shared.use((s) => s.getSetting('x'));
    const seen: string[] = [];
    const spy = (s: AppStore): void => {
      const d = s.kernel.db;
      const pragma = d.pragma.bind(d);
      d.pragma = ((src: string, o?: unknown) => {
        if (src.startsWith('wal_checkpoint')) seen.push(src);
        return pragma(src, o as never);
      }) as typeof d.pragma;
    };
    shared.use(spy);
    const w = new Database(db);
    w.exec('CREATE TABLE IF NOT EXISTS t_run (x BLOB)');
    w.prepare('INSERT INTO t_run VALUES (randomblob(4000))').run();
    // a reader holds a snapshot from before the next write: PASSIVE cannot copy the frames after it
    const reader = new Database(db);
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM t_run').get();
    w.transaction(() => {
      for (let i = 0; i < 200; i++) w.prepare('INSERT INTO t_run VALUES (randomblob(4000))').run();
    })();
    shared.maintain();
    expect(seen).toEqual(['wal_checkpoint(PASSIVE)']);
    reader.exec('COMMIT');
    reader.close();
    seen.length = 0;
    shared.maintain();
    expect(seen).toEqual(['wal_checkpoint(PASSIVE)', 'wal_checkpoint(TRUNCATE)']);
    w.close();
    shared.close();
  });

  it('skipped entirely while a run holds the jobpilot lock', () => {
    let running = true;
    const shared = new SharedStore(db, 1000, () => {}, () => {}, () => running);
    shared.use((s) => s.getSetting('x'));
    const w = new Database(db);
    w.exec('CREATE TABLE IF NOT EXISTS t_run (x BLOB)');
    w.transaction(() => {
      for (let i = 0; i < 2_000; i++) w.prepare('INSERT INTO t_run VALUES (randomblob(4000))').run();
    })();
    w.close();
    const walBytes = (): number => (existsSync(`${db}-wal`) ? statSync(`${db}-wal`).size : 0);
    const size = walBytes();
    expect(size).toBeGreaterThan(1_000_000);
    shared.maintain();
    expect(walBytes()).toBe(size);
    running = false;
    shared.maintain();
    expect(walBytes()).toBe(0);
    shared.close();
  });

  it('maintenance never waits for a writer: a run holding the write lock makes it a no-op', () => {
    const shared = new SharedStore(db, 5_000);
    shared.use((s) => s.getSetting('x'));
    const w = new Database(db);
    w.exec('BEGIN IMMEDIATE');
    const t = performance.now();
    shared.maintain();
    expect(performance.now() - t).toBeLessThan(500);
    w.exec('ROLLBACK');
    w.close();
    shared.close();
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

