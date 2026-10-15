import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withLock } from '../../../src/app/lock.js';
import { adoptProfile, isMachineEntry, treeManifest, unadoptProfile } from '../../../src/app/profiles/adopt.js';
import { readMeta } from '../../../src/app/profiles/meta.js';
import { readActiveProfile } from '../../../src/app/profiles/root.js';

const repo = join(import.meta.dirname, '../../..');
const clock = { now: () => '2026-10-15T08:00:00.000Z' };
let root: string;

/** A legacy home: pack, a WAL-mode DB with a row, out/ with a document, logs, secrets, the attempts files. */
function legacyHome(): void {
  cpSync(join(repo, 'tests/fixtures/pack'), join(root, 'pack'), { recursive: true });
  const db = new Database(join(root, 'jobpilot.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'row\')');
  db.close();
  for (const d of ['out/job1', 'logs', 'secrets', 'archive']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'out/job1/resume.pdf'), 'pdf');
  writeFileSync(join(root, 'logs/daily.log'), 'log');
  for (const f of ['daily-attempts.json', 'freelance-attempts.json', 'coverage-start.json', 'coverage-yield.json']) writeFileSync(join(root, f), '{}\n');
  mkdirSync(join(root, 'backups'));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jobpilot-adopt-'));
  legacyHome();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('adopt', () => {
  it('moves the home into profiles/<id>, keeps machine entries, backs up, journals', async () => {
    const before = treeManifest(root, readdirSync(root).filter((n) => !isMachineEntry(n)).sort());
    const r = await adoptProfile({ root, id: 'owner', clock });
    const home = join(root, 'profiles', 'owner');
    expect(r.home).toBe(home);
    expect(readdirSync(root).sort()).toEqual(['active-profile', 'adopt.json', 'backups', 'profiles']);
    expect(readdirSync(home).sort()).toEqual(['archive', 'coverage-start.json', 'coverage-yield.json', 'daily-attempts.json', 'freelance-attempts.json', 'jobpilot.db', 'logs', 'out', 'pack', 'profile.json', 'secrets']);
    expect(treeManifest(home, r.moved)).toEqual(before.filter((l) => !/^jobpilot\.db-(wal|shm) /.test(l)));
    expect(readMeta(home)).toEqual({ id: 'owner', createdAt: '2026-10-15T08:00:00.000Z', keychainService: 'jobpilot', adopted: true });
    expect(readActiveProfile(root)).toBe('owner');
    const backup = join(root, 'backups', 'adopt-20261015T080000Z');
    expect(readFileSync(join(backup, 'pack', 'facts.yaml'), 'utf8')).toBe(readFileSync(join(home, 'pack', 'facts.yaml'), 'utf8'));
    expect((new Database(join(backup, 'jobpilot.db'), { readonly: true }).prepare('SELECT v FROM t').get() as { v: string }).v).toBe('row');
    expect(JSON.parse(readFileSync(join(root, 'adopt.json'), 'utf8'))).toMatchObject({ id: 'owner', backup: 'backups/adopt-20261015T080000Z', legacyLabelsLoaded: [] });
  });
  it('refuses a second adopt, an empty root and a running home', async () => {
    rmSync(join(root, 'pack'), { recursive: true });
    await expect(adoptProfile({ root, id: 'owner', clock })).rejects.toThrow(/nothing to adopt/);
    cpSync(join(repo, 'tests/fixtures/pack'), join(root, 'pack'), { recursive: true });
    await withLock(root, 'run', async () => {
      await expect(adoptProfile({ root, id: 'owner', clock })).rejects.toThrow(/another jobpilot process/);
    });
    await adoptProfile({ root, id: 'owner', clock });
    await expect(adoptProfile({ root, id: 'other', clock })).rejects.toThrow(/already has profiles/);
  });
  it('a failure mid-move rolls everything back; the home is as before', async () => {
    const before = treeManifest(root, readdirSync(root).filter((n) => !isMachineEntry(n)).sort());
    let n = 0;
    await expect(adoptProfile({ root, id: 'owner', clock, afterMove: () => { if (++n === 3) throw new Error('disk full'); } })).rejects.toThrow(/rolled back.*backups\/adopt-20261015T080000Z/s);
    expect(existsSync(join(root, 'profiles'))).toBe(false);
    expect(existsSync(join(root, 'active-profile'))).toBe(false);
    expect(existsSync(join(root, 'adopt.json'))).toBe(false);
    expect(treeManifest(root, readdirSync(root).filter((x) => !isMachineEntry(x)).sort())).toEqual(before);
  });
  it('unadopt restores the single home exactly', async () => {
    const before = treeManifest(root, readdirSync(root).filter((n) => !isMachineEntry(n) && !/^jobpilot\.db-(wal|shm)$/.test(n)).sort());
    await adoptProfile({ root, id: 'owner', clock });
    await unadoptProfile({ root, clock: { now: () => '2026-10-15T09:00:00.000Z' } });
    expect(existsSync(join(root, 'profiles'))).toBe(false);
    expect(existsSync(join(root, 'adopt.json'))).toBe(false);
    expect(existsSync(join(root, 'backups', 'unadopt-20261015T090000Z', 'adopt.json'))).toBe(true);
    expect(treeManifest(root, readdirSync(root).filter((n) => !isMachineEntry(n) && !/^jobpilot\.db-(wal|shm)$/.test(n)).sort())).toEqual(before);
  });
  it('unadopt refuses while another profile exists', async () => {
    await adoptProfile({ root, id: 'owner', clock });
    mkdirSync(join(root, 'profiles', 'lena'));
    await expect(unadoptProfile({ root, clock })).rejects.toThrow(/other profiles exist: lena/);
  });
});
