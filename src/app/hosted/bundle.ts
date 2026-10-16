import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants, createGunzip, createGzip, createZstdCompress, createZstdDecompress } from 'node:zlib';
import Database from 'better-sqlite3';
import { Store } from '../../kernel/store/store.js';
import { verifyChain, verifyChainSince } from '../../kernel/store/audit.js';
import { readCheckpoint } from '../chain-status.js';
import { keyIdOf, openTransform, readHeaderOf, sealTransform, type JpstCodec, type SealOptions } from './jpst.js';
import { tarStream, untarInto, type TarFile } from './ustar.js';

/**
 * The two hosted bundles (spec §3.3): the state (database, out/, recent logs, attempt files) and the pack. Sealing
 * streams `tar -> zstd|gzip -> JPST1 -> file`; opening hashes the file first, so a wrong download never reaches the
 * extractor.
 */
export interface Sealed {
  readonly sha256: string;
  readonly bytes: number;
  readonly keyId: string;
}
export const STATE_LOG_DAYS = 14;

export class StateError extends Error {
  override readonly name = 'StateError';
  constructor(
    readonly code: 'sha256' | 'size' | 'quick-check' | 'audit' | 'not-empty' | 'layout',
    message: string,
  ) {
    super(message);
  }
}

const DAY_MS = 86_400_000;

/** Every regular file under `root` as `[relative posix name, absolute path]`; symlinks and other kinds are skipped. */
function walk(root: string, rel = ''): { name: string; path: string; mtimeMs: number }[] {
  const dir = rel === '' ? root : join(root, rel);
  if (!existsSync(dir)) return [];
  const out: { name: string; path: string; mtimeMs: number }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const name = rel === '' ? e.name : `${rel}/${e.name}`;
    const path = join(root, name);
    if (e.isDirectory()) out.push(...walk(root, name));
    else if (e.isFile()) out.push({ name, path, mtimeMs: lstatSync(path).mtimeMs });
  }
  return out;
}

/** jobpilot.db, out/**, logs/** (mtime within STATE_LOG_DAYS of now), *-attempts.json, coverage-start.json. */
export function stateFiles(home: string, now: string): TarFile[] {
  const cutoff = Date.parse(now) - STATE_LOG_DAYS * DAY_MS;
  const files: TarFile[] = [];
  for (const top of readdirSync(home, { withFileTypes: true })) {
    if (!top.isFile()) continue;
    if (top.name === 'jobpilot.db' || top.name === 'coverage-start.json' || /^[A-Za-z0-9._-]*-attempts\.json$/.test(top.name)) {
      files.push({ name: top.name, path: join(home, top.name) });
    }
  }
  for (const f of walk(join(home, 'out'))) files.push({ name: `out/${f.name}`, path: f.path });
  for (const f of walk(join(home, 'logs'))) if (f.mtimeMs >= cutoff) files.push({ name: `logs/${f.name}`, path: f.path });
  return files.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Every regular file under the pack dir; `overrides` replace or add a file by name (bytes written to a temp file). */
export function packFiles(packDir: string, tmpDir: string, overrides: Readonly<Record<string, string>> = {}): TarFile[] {
  const files = new Map<string, TarFile>();
  for (const f of walk(packDir)) files.set(f.name, { name: f.name, path: f.path });
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  let i = 0;
  for (const [name, body] of Object.entries(overrides)) {
    const path = join(tmpDir, `override-${i++}.bin`);
    writeFileSync(path, body, { mode: 0o600 });
    files.set(name, { name, path });
  }
  return [...files.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

const compressor = (codec: JpstCodec, level: number): Transform =>
  codec === 'zstd' ? createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: level } }) : createGzip({ level });

export async function sealFiles(files: readonly TarFile[], outFile: string, key: Buffer, o: SealOptions = {}): Promise<Sealed> {
  const h = createHash('sha256');
  let bytes = 0;
  const tap = new Transform({
    transform(c: Buffer, _e, cb) {
      h.update(c);
      bytes += c.length;
      cb(null, c);
    },
  });
  await pipeline(Readable.from(tarStream(files)), compressor(o.codec ?? 'zstd', o.level ?? 3), sealTransform(key, o), tap, createWriteStream(outFile, { flags: 'wx', mode: 0o600 }));
  return { sha256: h.digest('hex'), bytes, keyId: keyIdOf(key) };
}

export async function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const c of createReadStream(file)) {
    h.update(c as Buffer);
    bytes += (c as Buffer).length;
  }
  return { sha256: h.digest('hex'), bytes };
}

/** Checks size and sha256 first (when given), then opens into `dir` (which must be empty or missing). Returns the names. */
export async function openInto(file: string, key: Buffer, dir: string, expect?: { readonly sha256: string; readonly bytes: number }): Promise<string[]> {
  if (expect !== undefined) {
    const got = await sha256File(file);
    if (got.bytes !== expect.bytes) throw new StateError('size', `the bundle is ${got.bytes} bytes, expected ${expect.bytes}`);
    if (got.sha256 !== expect.sha256) throw new StateError('sha256', 'the bundle checksum does not match');
  }
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new StateError('not-empty', 'the target folder is not empty');
  const header = readHeaderOf(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const names: string[] = [];
  await pipeline(createReadStream(file), openTransform(key), header.codec === 'zstd' ? createZstdDecompress() : createGunzip(), untarInto(dir, (n) => names.push(n)));
  return names;
}

/** PRAGMA wal_checkpoint(TRUNCATE): folds the write-ahead log into the main file before it is bundled. */
export function checkpointDb(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

/** quick_check plus the audit chain (from the stored checkpoint, else the full walk), read-only, as `/runs` checks. */
export function checkState(home: string, _now: string): { ok: true; events: number } | { ok: false; code: 'quick-check' | 'audit'; detail: string } {
  const dbPath = join(home, 'jobpilot.db');
  let store: Store;
  try {
    store = Store.openReadOnly(dbPath, { forensic: true });
  } catch (e) {
    return { ok: false, code: 'quick-check', detail: e instanceof Error ? e.message : String(e) };
  }
  try {
    let rows: unknown[];
    try {
      rows = store.db.pragma('quick_check') as unknown[];
    } catch (e) {
      return { ok: false, code: 'quick-check', detail: e instanceof Error ? e.message : String(e) };
    }
    const only = rows.length === 1 ? (rows[0] as Record<string, unknown>) : undefined;
    if (only === undefined || only['quick_check'] !== 'ok') {
      return { ok: false, code: 'quick-check', detail: rows.slice(0, 3).map((r) => JSON.stringify(r)).join('; ') };
    }
    const cp = readCheckpoint(store.db);
    if (cp !== undefined) {
      const r = verifyChainSince(store, cp);
      if (r.ok) return { ok: true, events: r.events };
      if ('brokenAt' in r) return { ok: false, code: 'audit', detail: `at event ${r.brokenAt}: ${r.reason}` };
      // a checkpoint that is not on this chain: only the full walk can say more
    }
    const full = verifyChain(store);
    if (full.ok) return { ok: true, events: full.events };
    return { ok: false, code: 'audit', detail: 'brokenAt' in full ? `at event ${full.brokenAt}: ${full.reason}` : full.reason };
  } finally {
    store.close();
  }
}
