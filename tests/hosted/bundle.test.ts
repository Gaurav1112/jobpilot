import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { checkpointDb, checkState, openInto, packFiles, sealFiles, sha256File, stateFiles, StateError } from '../../src/app/hosted/bundle.js';
import { buildHostedHome, FIXTURE_PACK, OUT_KEY } from '../support/hosted-home.js';

const NOW = '2026-10-15T01:30:00.000Z';
const d = mkdtempSync(join(tmpdir(), 'jp-bundle-'));
afterAll(() => rmSync(d, { recursive: true, force: true }));
const key = randomBytes(32);
const home = join(d, 'home');
buildHostedHome(home, NOW);
let n = 0;
const fresh = (): string => join(d, `w${n++}`);
const names = (fs: { name: string }[]): string[] => fs.map((f) => f.name).sort();
const listAll = (dir: string, rel = ''): string[] =>
  readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listAll(dir, join(rel, e.name)) : [join(rel, e.name)])).sort();

describe('hosted bundles', () => {
  it('stateFiles is an allow-list', () => {
    expect(names(stateFiles(home, NOW))).toEqual(['coverage-start.json', 'daily-attempts.json', 'jobpilot.db', 'logs/daily.log', `out/${OUT_KEY}/resume.pdf`]);
  });

  for (const codec of ['zstd', 'gzip'] as const) {
    it(`round-trips a state bundle (${codec}) byte-identically`, async () => {
      const files = stateFiles(home, NOW);
      const sealed = join(d, `state-${codec}.jpst`);
      const s = await sealFiles(files, sealed, key, { codec, chunk: 65536 });
      expect(s.bytes).toBe(statSync(sealed).size);
      expect(s.sha256).toBe((await sha256File(sealed)).sha256);
      const out = fresh();
      const got = await openInto(sealed, key, out, { sha256: s.sha256, bytes: s.bytes });
      expect(got.sort()).toEqual(names(files));
      for (const f of files) expect(readFileSync(join(out, f.name)).equals(readFileSync(f.path))).toBe(true);
      const db = new Database(join(out, 'jobpilot.db'), { readonly: true });
      expect((db.prepare(`SELECT COUNT(*) AS c FROM runs`).get() as { c: number }).c).toBe(1);
      db.close();
    });
  }

  it('refuses a wrong checksum, size or a non-empty dir before writing', async () => {
    const f1 = join(d, 'one.jpst');
    const f2 = join(d, 'two.jpst');
    const s1 = await sealFiles(stateFiles(home, NOW), f1, key);
    const s2 = await sealFiles(packFiles(FIXTURE_PACK, d), f2, key);
    const out = fresh();
    await expect(openInto(f1, key, out, { sha256: s2.sha256, bytes: s1.bytes })).rejects.toMatchObject({ name: 'StateError', code: 'sha256' });
    expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
    await expect(openInto(f1, key, out, { sha256: s1.sha256, bytes: s1.bytes + 1 })).rejects.toMatchObject({ code: 'size' });
    expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
    const full = fresh();
    mkdirSync(full);
    writeFileSync(join(full, 'x'), '1');
    await expect(openInto(f1, key, full)).rejects.toBeInstanceOf(StateError);
    await expect(openInto(f1, key, full)).rejects.toMatchObject({ code: 'not-empty' });
  });

  it('checkState passes the fixture and never writes the database', async () => {
    const db = join(home, 'jobpilot.db');
    const before = { m: statSync(db).mtimeMs, h: createHash('sha256').update(readFileSync(db)).digest('hex') };
    expect(checkState(home, NOW)).toEqual({ ok: true, events: 2 });
    expect(statSync(db).mtimeMs).toBe(before.m);
    expect(createHash('sha256').update(readFileSync(db)).digest('hex')).toBe(before.h);
  });

  it('checkState names a corrupted page and a tampered event', () => {
    const bad = fresh();
    buildHostedHome(bad, NOW);
    const fd = openSync(join(bad, 'jobpilot.db'), 'r+');
    writeSync(fd, Buffer.alloc(4096), 0, 4096, 8192);
    closeSync(fd);
    expect(checkState(bad, NOW)).toMatchObject({ ok: false, code: 'quick-check' });

    const tam = fresh();
    buildHostedHome(tam, NOW);
    const db = new Database(join(tam, 'jobpilot.db'));
    db.prepare(`UPDATE events SET data = '{"n":99}' WHERE seq = 1`).run();
    db.close();
    expect(checkState(tam, NOW)).toMatchObject({ ok: false, code: 'audit' });
  });

  it('checkpointDb leaves no WAL content', () => {
    const h = fresh();
    mkdirSync(h);
    const p = join(h, 'w.db');
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE t (x); INSERT INTO t VALUES (1), (2), (3)`);
    expect(statSync(`${p}-wal`).size).toBeGreaterThan(0);
    checkpointDb(p);
    expect(!existsSync(`${p}-wal`) || statSync(`${p}-wal`).size === 0).toBe(true);
    db.close();
  });

  it('packFiles applies overrides once and keeps the other files', () => {
    const tmp = fresh();
    mkdirSync(tmp);
    const body = 'version: 1\nkeep: {daily: 1, freelance: 1, coverage: 1, rebuild: 1}\n';
    const fs = packFiles(FIXTURE_PACK, tmp, { 'retention.yaml': body });
    expect(fs.filter((f) => f.name === 'retention.yaml')).toHaveLength(1);
    expect(readFileSync(fs.find((f) => f.name === 'retention.yaml')!.path, 'utf8')).toBe(body);
    const plain = packFiles(FIXTURE_PACK, tmp);
    for (const f of plain) {
      if (f.name === 'retention.yaml') continue;
      expect(fs.find((g) => g.name === f.name)?.path).toBe(f.path);
    }
    expect(names(fs)).toContain('networks/arc.yaml');
    expect(names(fs)).toContain('facts.yaml');
  });

  it('streams a 128 MB file without buffering it whole', async () => {
    const big = join(d, 'big.bin');
    writeFileSync(big, randomBytes(128 * 1024 * 1024));
    const before = process.memoryUsage().arrayBuffers;
    let peak = 0;
    const t = setInterval(() => (peak = Math.max(peak, process.memoryUsage().arrayBuffers)), 2);
    const s = await sealFiles([{ name: 'big.bin', path: big }], join(d, 'big.jpst'), key, { chunk: 65536, codec: 'gzip', level: 1 });
    clearInterval(t);
    expect(s.bytes).toBeGreaterThan(128 * 1024 * 1024);
    // arrayBuffers is process-wide and V8 collects external garbage lazily (~64 MB), so streaming can peak near that;
    // buffering the whole file would add at least its 128 MB. The 96 MB line separates the two without GC timing.
    expect(peak - before).toBeLessThan(96 * 1024 * 1024);
    const out = fresh();
    await openInto(join(d, 'big.jpst'), key, out, s);
    expect(listAll(out)).toEqual(['big.bin']);
    expect(readFileSync(join(out, 'big.bin')).equals(readFileSync(big))).toBe(true);
  });
});
