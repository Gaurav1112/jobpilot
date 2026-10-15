import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { runFreelance } from '../../src/app/freelance/run.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { liveHolder } from '../../src/app/lock.js';
import { offlineProviders } from '../../src/app/offline.js';
import { runDaily } from '../../src/app/run.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { APP_MIGRATIONS } from '../../src/app/store/schema.js';
import { Store } from '../../src/kernel/store/store.js';
import { jobRow } from '../support/app-fixtures.js';

/**
 * Final re-review P3: the daily and the freelance run each migrate a database whose schema is behind the code, inside
 * the run lock, and complete. They are the openers allowed to migrate (`schema: 'migrate'`); the dashboard and every
 * other command refuse a behind schema, so without this the upgrade would never happen.
 */
const root = join(import.meta.dirname, '../..');
/** The index the last index migration creates: dropped (with the version set back before it) to make a schema that is behind. */
const LAST_INDEX_AT = APP_MIGRATIONS.findLastIndex((m) => typeof m === 'string' && /CREATE INDEX IF NOT EXISTS/.test(m));
const LAST_INDEX = /CREATE INDEX IF NOT EXISTS (\w+)/.exec(String(APP_MIGRATIONS[LAST_INDEX_AT]))?.[1] as string;
/** The version that leaves the last index migration and every later one (migration 23 re-runs as a no-op) pending. */
const BEHIND_VERSION = LAST_INDEX_AT;
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();
const homes: string[] = [];
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function behindHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-run-migrates-'));
  homes.push(home);
  chmodSync(home, 0o700);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  // no sources: the run has nothing to fetch, so it completes fast; the point is the open
  writeFileSync(join(home, 'pack/watchlist.yaml'), 'watchlist: []\n');
  writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: []\n');
  const s = AppStore.open(join(home, 'jobpilot.db'), { schema: 'migrate' });
  s.upsertJob(jobRow());
  s.close();
  const d = new Database(join(home, 'jobpilot.db'));
  d.exec(`DROP INDEX ${LAST_INDEX}; UPDATE app_schema SET version = ${BEHIND_VERSION}`);
  d.close();
  return home;
}
const version = (home: string): number => {
  const d = new Database(join(home, 'jobpilot.db'), { readonly: true });
  try {
    return (d.prepare(`SELECT version FROM app_schema`).get() as { version: number }).version;
  } finally {
    d.close();
  }
};

/**
 * freelance-v2 review: a real v22 database (every app migration up to 22 applied, nothing later) with gigs, their
 * documents and an applied snapshot, as freelance-boost leaves it; the run then applies migration 23 (the gig document
 * table rebuild) under its lock.
 */
function v22Home(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-run-v22-'));
  homes.push(home);
  chmodSync(home, 0o700);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  const kernel = Store.open(join(home, 'jobpilot.db'));
  const db = kernel.db;
  db.exec(`CREATE TABLE IF NOT EXISTS app_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  db.prepare(`INSERT INTO app_schema (id, version) VALUES (1, 0)`).run();
  for (const [i, m] of APP_MIGRATIONS.slice(0, 22).entries()) {
    db.transaction(() => {
      if (typeof m === 'string') db.exec(m);
      else m.run(db);
      db.prepare(`UPDATE app_schema SET version = ?`).run(i + 1);
    })();
  }
  db.prepare(`INSERT INTO gigs (gig_key, dedupe_key, platform, source_id, url, title, client, kind, budget, hours, first_seen, last_seen) VALUES ('aaaaaaaaaaaaaaaa', 'd', 'boards', 'x1', 'https://jobs.example.com/x', 'Backend Engineer', '{}', 'contract', '{}', '{}', 'a', 'a')`).run();
  const doc = db.prepare(`INSERT INTO gig_docs (gig_key, kind, format, path, sha256, pages) VALUES ('aaaaaaaaaaaaaaaa', ?, ?, ?, ?, ?)`);
  doc.run('pitch', 'txt', 'gigs/aaaaaaaaaaaaaaaa/pitch.txt', '1'.repeat(64), null);
  doc.run('resume', 'pdf', 'gigs/aaaaaaaaaaaaaaaa/resume.pdf', '2'.repeat(64), 1);
  db.prepare(`INSERT INTO gig_snapshots (gig_key, day, kind, format, path, sha256, at) VALUES ('aaaaaaaaaaaaaaaa', '2026-10-13', 'pitch', 'txt', 'gigs/aaaaaaaaaaaaaaaa/applied-2026-10-13/pitch.txt', ?, 't')`).run('1'.repeat(64));
  kernel.close();
  return home;
}
const seededRows = (home: string): unknown => {
  const d = new Database(join(home, 'jobpilot.db'), { readonly: true });
  try {
    return {
      docs: d.prepare(`SELECT rowid, * FROM gig_docs WHERE gig_key = 'aaaaaaaaaaaaaaaa' ORDER BY rowid`).all(),
      snaps: d.prepare(`SELECT rowid, * FROM gig_snapshots WHERE gig_key = 'aaaaaaaaaaaaaaaa' ORDER BY rowid`).all(),
    };
  } finally {
    d.close();
  }
};

describe.skipIf(pdftotext === undefined)('runs migrate a behind schema under the run lock', () => {
  it('the freelance run upgrades a real v22 database to 23 under its lock, keeping the gig documents and snapshots', async () => {
    const home = v22Home();
    expect(version(home)).toBe(22);
    const rows = seededRows(home);
    let locked = false;
    const r = await runFreelance({
      home, clock: { now: () => '2026-10-14T02:00:00.000Z' }, fetch: offlineProviders(join(root, 'tests/fixtures/freelance-e2e')).fetch, sleep: async () => {},
      pdftotext: pdftotext as string, codeHash: 'run-migrates-v22',
      onLocked: () => {
        expect(liveHolder(home)).toMatchObject({ pid: process.pid });
        expect(version(home)).toBe(22);
        locked = true;
      },
    });
    expect(locked).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(version(home)).toBe(23);
    expect(seededRows(home)).toEqual(rows);
    const d = new Database(join(home, 'jobpilot.db'), { readonly: true });
    try {
      const sql = (d.prepare(`SELECT sql FROM sqlite_master WHERE name = 'gig_docs'`).get() as { sql: string }).sql;
      expect(sql).toContain("CHECK (kind IN ('proposal', 'pitch', 'resume', 'cover'))");
      expect(d.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(d.pragma('foreign_key_check')).toEqual([]);
    } finally {
      d.close();
    }
  }, 120_000);

  it('the daily run', async () => {
    const home = behindHome();
    let locked = false;
    const r = await runDaily({
      home, clock: { now: () => '2026-10-14T01:30:00.000Z' }, fetch: offlineProviders(join(root, 'tests/fixtures/e2e')).fetch, sleep: async () => {},
      pdftotext: pdftotext as string, codeHash: 'run-migrates',
      onLocked: () => {
        expect(liveHolder(home)).toMatchObject({ pid: process.pid, command: 'run' });
        expect(version(home)).toBe(BEHIND_VERSION);
        locked = true;
      },
    });
    expect(locked).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(version(home)).toBe(APP_MIGRATIONS.length);
  }, 120_000);

  it('the freelance run', async () => {
    const home = behindHome();
    let locked = false;
    const r = await runFreelance({
      home, clock: { now: () => '2026-10-14T02:00:00.000Z' }, fetch: offlineProviders(join(root, 'tests/fixtures/freelance-e2e')).fetch, sleep: async () => {},
      pdftotext: pdftotext as string, codeHash: 'run-migrates',
      onLocked: () => {
        expect(liveHolder(home)).toMatchObject({ pid: process.pid });
        expect(version(home)).toBe(BEHIND_VERSION);
        locked = true;
      },
    });
    expect(locked).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(version(home)).toBe(APP_MIGRATIONS.length);
  }, 120_000);
});
