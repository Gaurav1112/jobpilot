import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AppStore } from '../../src/app/store/app-store.js';
import { APP_MIGRATIONS, rebuildChecks } from '../../src/app/store/schema.js';
import { Store } from '../../src/kernel/store/store.js';

/**
 * freelance-v2 migration 23: gig_docs and gig_snapshots allow the cover letter (kind `cover`, format `html`). SQLite
 * changes a CHECK only by a table rebuild; the rebuild must change no row, no other table and no index or trigger.
 */

const TABLES = ['gig_docs', 'gig_snapshots'];
/** The objects of migration 24 (sources-x freehire leads): later than this migration, left out of its byte-identical checks. */
const LATER_OBJECTS = ['freehire_leads', 'freehire_leads_by_week'];

/** Every table's rows (in rowid order) and every schema object's SQL; `sqlOf` leaves the given tables' own SQL out. */
function dumpHash(db: Database.Database, sqlOf: readonly string[] = []): string {
  const h = createHash('sha256');
  const objs = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  for (const o of objs) {
    if (LATER_OBJECTS.includes(o.name)) continue;
    h.update(JSON.stringify(sqlOf.includes(o.name) && o.type === 'table' ? { ...o, sql: null } : o));
    if (o.type === 'table' && o.name !== 'app_schema') for (const r of db.prepare(`SELECT rowid AS __rowid, * FROM "${o.name}" ORDER BY rowid`).all()) h.update(JSON.stringify(r));
  }
  return h.digest('hex');
}

/** A DB at app schema 22 (freelance-boost), with gigs, documents, an applied snapshot and other rows. */
function v22(): Store {
  const kernel = Store.open(':memory:');
  const db = kernel.db;
  db.exec(`CREATE TABLE IF NOT EXISTS app_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  db.prepare(`INSERT INTO app_schema (id, version) VALUES (1, 0)`).run();
  for (const [i, m] of APP_MIGRATIONS.slice(0, 22).entries()) {
    if (typeof m === 'string') db.exec(m);
    else {
      db.pragma('foreign_keys = OFF');
      m.run(db);
      db.pragma('foreign_keys = ON');
    }
    db.prepare(`UPDATE app_schema SET version = ?`).run(i + 1);
  }
  const gig = db.prepare(`INSERT INTO gigs (gig_key, dedupe_key, platform, source_id, url, title, client, kind, budget, hours, first_seen, last_seen) VALUES (?, 'd', 'boards', ?, 'https://jobs.example.com/x', 'Backend Engineer', '{}', 'contract', '{}', '{}', 'a', 'a')`);
  gig.run('aaaaaaaaaaaaaaaa', '1');
  gig.run('bbbbbbbbbbbbbbbb', '2');
  const doc = db.prepare(`INSERT INTO gig_docs (gig_key, kind, format, path, sha256, pages) VALUES (?, ?, ?, ?, ?, ?)`);
  doc.run('aaaaaaaaaaaaaaaa', 'pitch', 'txt', 'gigs/aaaaaaaaaaaaaaaa/pitch.txt', '1'.repeat(64), null);
  doc.run('aaaaaaaaaaaaaaaa', 'resume', 'pdf', 'gigs/aaaaaaaaaaaaaaaa/resume.pdf', '2'.repeat(64), 1);
  doc.run('bbbbbbbbbbbbbbbb', 'resume', 'pdf', 'gigs/bbbbbbbbbbbbbbbb/resume.pdf', '6'.repeat(64), 1);
  doc.run('aaaaaaaaaaaaaaaa', 'resume', 'docx', 'gigs/aaaaaaaaaaaaaaaa/resume.docx', '3'.repeat(64), null);
  // a rowid gap, as a replaced document leaves: the rebuild must keep every rowid, not renumber
  db.prepare(`DELETE FROM gig_docs WHERE path = 'gigs/bbbbbbbbbbbbbbbb/resume.pdf'`).run();
  doc.run('bbbbbbbbbbbbbbbb', 'proposal', 'txt', 'gigs/bbbbbbbbbbbbbbbb/proposal.txt', '4'.repeat(64), null);
  db.prepare(`INSERT INTO gig_snapshots (gig_key, day, kind, format, path, sha256, at) VALUES ('aaaaaaaaaaaaaaaa', '2026-10-14', 'pitch', 'txt', 'gigs/aaaaaaaaaaaaaaaa/applied-2026-10-14/pitch.txt', ?, 't')`).run('1'.repeat(64));
  db.prepare(`INSERT INTO gig_status_history ("from", "to", gig_key, at, by) VALUES ('new', 'applied', 'aaaaaaaaaaaaaaaa', 't', 'user')`).run();
  db.prepare(`INSERT INTO network_status (network_id, status, updated_at) VALUES ('n1', 'todo', 'a')`).run();
  return kernel;
}

describe('migration 23: gig documents allow the cover letter', () => {
  it('is the 23rd of 24 migrations, a table rebuild with foreign keys off', () => {
    expect(APP_MIGRATIONS.length).toBe(24);
    const m = APP_MIGRATIONS[22];
    expect(typeof m === 'object' && m !== null && m.foreignKeysOff).toBe(true);
  });

  it('changes no row, no other table, index or trigger: only the two CHECKs (dumpHash)', () => {
    const kernel = v22();
    const db = kernel.db;
    const before = dumpHash(db, TABLES);
    const triggers = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type IN ('trigger', 'index') AND tbl_name IN ('gig_docs', 'gig_snapshots') ORDER BY name`).all();
    const s = AppStore.on(kernel);
    expect(s.schemaVersion()).toBe(24);
    expect(dumpHash(db, TABLES)).toBe(before);
    expect(db.prepare(`SELECT name, sql FROM sqlite_master WHERE type IN ('trigger', 'index') AND tbl_name IN ('gig_docs', 'gig_snapshots') ORDER BY name`).all()).toEqual(triggers);
    const sqlOf = (t: string) => (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) as { sql: string }).sql;
    for (const t of TABLES) {
      expect(sqlOf(t)).toContain("CHECK (kind IN ('proposal', 'pitch', 'resume', 'cover'))");
      expect(sqlOf(t)).toContain("CHECK (format IN ('txt', 'pdf', 'docx', 'html'))");
    }
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('re-running it on a migrated database (a racing opener) changes nothing', () => {
    const s = AppStore.on(v22());
    const db = s.kernel.db;
    const before = dumpHash(db);
    const m = APP_MIGRATIONS[22] as { run: (d: typeof db) => void };
    db.pragma('foreign_keys = OFF');
    m.run(db);
    db.pragma('foreign_keys = ON');
    expect(dumpHash(db)).toBe(before);
  });

  it('accepts the cover files, still refuses anything else, keeps the foreign key and the append-only snapshots', () => {
    const s = AppStore.on(v22());
    const db = s.kernel.db;
    const k = 'aaaaaaaaaaaaaaaa';
    const files = (['txt', 'pdf', 'docx', 'html'] as const).map((format) => ({ kind: 'cover' as const, format, path: `gigs/${k}/cover.${format}`, sha256: '5'.repeat(64), pages: format === 'pdf' ? 1 : null }));
    s.putGigDocs(k, files);
    expect(s.getGig(k)?.docs.map((d) => `${d.kind}.${d.format}`)).toEqual(['cover.docx', 'cover.html', 'cover.pdf', 'cover.txt']);
    s.putGigSnapshot(k, '2026-10-15', files, 't2');
    expect(s.gigSnapshots(k)[0]?.files.map((f) => `${f.kind}.${f.format}`)).toEqual(['cover.docx', 'cover.html', 'cover.pdf', 'cover.txt']);
    expect(() => db.prepare(`INSERT INTO gig_docs (gig_key, kind, format, path, sha256, pages) VALUES (?, 'letter', 'txt', 'p', 's', NULL)`).run(k)).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO gig_docs (gig_key, kind, format, path, sha256, pages) VALUES (?, 'cover', 'rtf', 'p', 's', NULL)`).run(k)).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO gig_docs (gig_key, kind, format, path, sha256, pages) VALUES ('ffffffffffffffff', 'cover', 'txt', 'p', 's', NULL)`).run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare(`UPDATE gig_snapshots SET sha256 = 'x'`).run()).toThrow(/append-only/);
    expect(() => db.prepare(`DELETE FROM gig_snapshots`).run()).toThrow(/append-only/);
  });

  it('a fresh store has the same two tables as a migrated one', () => {
    const fresh = AppStore.on(Store.open(':memory:')).kernel.db;
    const migrated = AppStore.on(v22()).kernel.db;
    const sql = (db: Database.Database) => db.prepare(`SELECT name, sql FROM sqlite_master WHERE tbl_name IN ('gig_docs', 'gig_snapshots') ORDER BY type, name`).all();
    expect(sql(migrated)).toEqual(sql(fresh));
  });
});

describe('rebuildChecks accepts the quoted table name a rename leaves (a future rebuild)', () => {
  it('a migrated gig_docs (CREATE TABLE "gig_docs") rebuilds again, rows and CHECKs kept; an unexpected shape is refused', () => {
    const s = AppStore.on(v22());
    const db = s.kernel.db;
    const sqlOf = () => (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gig_docs'`).get() as { sql: string }).sql;
    expect(sqlOf()).toMatch(/^CREATE TABLE "gig_docs" \(/);
    const before = dumpHash(db, TABLES);
    db.pragma('foreign_keys = OFF');
    rebuildChecks(db, 'gig_docs', [["CHECK (kind IN ('proposal', 'pitch', 'resume', 'cover'))", "CHECK (kind IN ('proposal', 'pitch', 'resume', 'cover'))"]]);
    db.pragma('foreign_keys = ON');
    expect(dumpHash(db, TABLES)).toBe(before);
    expect(sqlOf()).toContain("CHECK (format IN ('txt', 'pdf', 'docx', 'html'))");
    // the unquoted form a fresh CREATE leaves works too
    db.exec(`CREATE TABLE plain_t (k TEXT CHECK (k IN ('a')))`);
    db.exec(`INSERT INTO plain_t VALUES ('a')`);
    rebuildChecks(db, 'plain_t', [["CHECK (k IN ('a'))", "CHECK (k IN ('a', 'b'))"]]);
    db.exec(`INSERT INTO plain_t VALUES ('b')`);
    expect(db.prepare(`SELECT k FROM plain_t ORDER BY rowid`).all()).toEqual([{ k: 'a' }, { k: 'b' }]);
    expect(() => rebuildChecks(db, 'plain_t', [["CHECK (k IN ('zzz'))", 'x']])).toThrow(/not the expected shape/);
  });
});
