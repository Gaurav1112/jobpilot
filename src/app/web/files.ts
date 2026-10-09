import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { join, sep } from 'node:path';
import { checkRelPath } from '../../kernel/files.js';
import type { Doc, SnapshotFile } from '../store/app-store.js';

/**
 * The dashboard's file access under the out root (Task 13), confined like the kernel's files layer:
 * - a path is relative, `/`-separated, with no empty, `.` or `..` segment (`checkRelPath`);
 * - every directory below the root is a real directory, never a symlink, and the realpath stays inside the root's;
 * - a file is opened with O_NOFOLLOW (never through a symlink), must be a regular file with one hard link (a second
 *   link could alias a file outside the root), and must still have the sha256 the store recorded.
 *
 * `snapshotApplied` is the only writer: it copies (never links) a job's current documents into
 * `<jobKey>/applied-<day>/`, each file created exclusively and made read-only (0444), then the folder itself (0555). The kernel's files layer never
 * writes into an `applied-*` directory, so later renders cannot touch a snapshot.
 */

export class FileRefused extends Error {
  override readonly name = 'FileRefused';
}

const JOB_KEY = /^[0-9a-f]{16}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const code = (e: unknown): string | undefined => (typeof e === 'object' && e !== null ? ((e as { code?: unknown }).code as string | undefined) : undefined);

function rootOf(outDir: string): string {
  try {
    return realpathSync(outDir);
  } catch {
    throw new FileRefused('the documents folder does not exist');
  }
}

/** The absolute path of `segs`' parent directory chain under `root`, every one a real directory inside the root. */
function confinedDir(root: string, segs: readonly string[]): string {
  let dir = root;
  for (const s of segs) {
    dir = join(dir, s);
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      throw new FileRefused('not on disk');
    }
    if (st.isSymbolicLink()) throw new FileRefused('passes through a symlink');
    if (!st.isDirectory()) throw new FileRefused('passes through a non-directory');
  }
  const real = realpathSync(dir);
  if (real !== root && !real.startsWith(root + sep)) throw new FileRefused('resolves outside the documents folder');
  return real;
}

/** Reads one regular, singly linked, non-symlink file by descriptor. */
function readNoFollow(abs: string): Uint8Array {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if (code(e) === 'ELOOP' || code(e) === 'EMLINK' || code(e) === 'EFTYPE') throw new FileRefused('is a symlink');
    throw new FileRefused('not on disk');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new FileRefused('is not a regular file');
    if (st.nlink !== 1) throw new FileRefused('has more than one hard link');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export type ReadResult = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly why: 'absent' | 'changed' | 'refused'; readonly detail: string };

/** Reads `relPath` under `outDir`, confined, and checks it still has `expectedSha`. Never throws. */
export function readRecorded(outDir: string, relPath: string, expectedSha: string): ReadResult {
  try {
    const segs = checkRelPath(relPath, (m) => new FileRefused(m) as never);
    const root = rootOf(outDir);
    const dir = confinedDir(root, segs.slice(0, -1));
    const bytes = readNoFollow(join(dir, segs[segs.length - 1] as string));
    if (sha256(bytes) !== expectedSha) return { ok: false, why: 'changed', detail: 'changed on disk since it was made' };
    return { ok: true, bytes };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, why: detail === 'not on disk' ? 'absent' : 'refused', detail };
  }
}

/** Writes `bytes` to a new file `abs` (exclusive, no symlink), read-only. An identical file already there is accepted. */
function writeReadOnly(abs: string, bytes: Uint8Array): void {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
  } catch (e) {
    if (code(e) !== 'EEXIST') throw e;
    // A snapshot interrupted after this file was written: keep it only if it is exactly these bytes.
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) throw new FileRefused(`${abs} is in the way of the snapshot`);
    if (sha256(readNoFollow(abs)) !== sha256(bytes)) throw new FileRefused('a different file is already in the snapshot folder');
    return;
  }
  try {
    writeSync(fd, bytes);
    fchmodSync(fd, 0o444);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Copies the job's current documents (every recorded resume and cover file) into `<jobKey>/applied-<day>/`, read-only,
 * and returns what to record. Each source must be exactly the file the store recorded (`<jobKey>/<kind>.<format>`,
 * same sha256), read without following links; the copy is new bytes in a new file, never a hard link.
 */
export function snapshotApplied(outDir: string, jobKey: string, docs: readonly Doc[], day: string): SnapshotFile[] {
  if (!JOB_KEY.test(jobKey)) throw new FileRefused('not a job key');
  if (!DAY.test(day)) throw new FileRefused('not a date');
  const root = rootOf(outDir);
  const jobDir = confinedDir(root, [jobKey]);
  const dirName = `applied-${day}`;
  const snapDir = join(jobDir, dirName);
  try {
    mkdirSync(snapDir, { mode: 0o700 });
  } catch (e) {
    if (code(e) !== 'EEXIST') throw e;
  }
  const real = confinedDir(root, [jobKey, dirName]);
  // An interrupted snapshot left the folder read-only: open it for the missing files, then close it again.
  chmodSync(real, 0o700);
  const out: SnapshotFile[] = [];
  const name = (d: Doc): string => `${d.kind}.${d.format}`;
  for (const d of [...docs].sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0))) {
    const file = `${d.kind}.${d.format}`;
    if (d.path !== `${jobKey}/${file}`) throw new FileRefused(`unexpected document path ${d.path}`);
    const src = readRecorded(outDir, d.path, d.sha256);
    if (!src.ok) throw new FileRefused(`${file} ${src.detail}`);
    writeReadOnly(join(real, file), src.bytes);
    out.push({ kind: d.kind, format: d.format, path: `${jobKey}/${dirName}/${file}`, sha256: d.sha256 });
  }
  chmodSync(real, 0o555);
  return out;
}
