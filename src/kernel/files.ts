import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { KernelError } from './errors.js';

/**
 * The files capability (`capabilities.files`): reads and transactional writes confined to one root directory. The
 * root itself is configuration (`providers.fileRoots`), so it may be a symlink; everything below it is agent input:
 * - the path is a non-empty string of `/`-separated segments, none empty, `.` or `..`, with no NUL or backslash, not
 *   absolute (`/x`, `C:/x`), and no segment that folds to the reserved `.pending`;
 * - every existing directory below the root is a real directory, never a symlink, and the parent's realpath is
 *   inside the root's realpath;
 * - the file itself is never a symlink: reads open it with O_NOFOLLOW; files are written to a temp file opened with
 *   O_EXCL | O_NOFOLLOW and renamed into place (a rename replaces a link, never follows it);
 * - a read refuses a file with more than one hard link (it could alias a file outside the root);
 * - nothing is ever written into an `applied-*` directory or to a path named `applied-*` (an applied snapshot is
 *   history). The test folds case and compatibility forms (NFKC, then lower case), because APFS is case-insensitive:
 *   `Applied-x`, `APPLIED-x` and fullwidth `ａｐｐｌｉｅｄ-x` all count. It runs on the requested segments and on the
 *   realpath of every existing ancestor relative to the root. Reading them is allowed.
 *
 * Writes are transactional. `write` stages bytes under `<root>/.pending/<stepKey>/<attempt>/files/<rel>` (one stage per
 * attempt) and records them in that attempt's `manifest.json`; it returns the FINAL relative path and the sha256. Once
 * the out guardrails pass, the executor names the attempt in `final.json`, records the step done, then commits
 * (`commitPending`: a re-check of every rule above and a re-hash of every file first, then one rename per file into
 * `<root>/<rel>` with the replaced file kept as a backup, so a failure part-way restores the previous set: all or
 * nothing per step). It discards the stage on failure, quarantine or timeout; other attempts' stages are never committed. The supervisor recovers stages left by a crash on start (`recoverPending`): a done step's stage is
 * committed, any other is deleted. A commit is idempotent: a file already moved into place with the recorded sha256
 * counts as committed, so a crash in the middle of a commit is finished by the next run.
 *
 * Ordering: commits on one root are serialised. In a live run the step that commits later wins a shared path (the
 * supervisor runs steps one at a time, in queue order). A recovery pass commits the stages it finds in ascending
 * stepKey order, so of two recovered stages writing one path the greater stepKey wins, whatever order they were
 * staged in.
 */
export interface FilesTool {
  /** Reads a committed file under the root (never a staged one). */
  read(relPath: string): Promise<{ readonly bytes: Uint8Array; readonly sha256: string }>;
}
export interface WritableFilesTool extends FilesTool {
  /** Stages `bytes` for `relPath`; the file appears at `relPath` only when the step is committed. */
  write(relPath: string, bytes: Uint8Array): Promise<{ readonly path: string; readonly sha256: string }>;
}

export const PENDING_DIR = '.pending';
const STEP_KEY = /^[0-9a-f]{16,128}$/;

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const code = (e: unknown): string | undefined => (typeof e === 'object' && e !== null ? ((e as { code?: unknown }).code as string | undefined) : undefined);

/**
 * Final minor: a raw fs error (a Node error whose `code` is an errno name such as EACCES or ENOSPC) as `invalid_output`,
 * named by its syscall, its code and its path relative to the root's parent (`out/.pending/…`, `out/<jobKey>/…`), so no
 * absolute path reaches an event, a problem, the run summary or `/runs`. A path outside the root keeps its base name
 * only. Anything else (a KernelError included) is returned unchanged.
 */
export function fsFailure(e: unknown, root: string, rootName: string): unknown {
  const c = code(e);
  if (!(e instanceof Error) || e instanceof KernelError || typeof c !== 'string' || !/^E[A-Z0-9]+$/.test(c)) return e;
  const syscall = (e as { syscall?: unknown }).syscall;
  const p = (e as { path?: unknown }).path;
  const bases = [root];
  try {
    bases.push(realpathSync(root));
  } catch {
    // the root itself may be what is missing
  }
  const rel = (abs: string): string => {
    for (const b of bases) {
      if (abs === b) return rootName;
      if (abs.startsWith(b + sep)) return `${rootName}/${relative(b, abs).split(sep).join('/')}`;
    }
    return basename(abs);
  };
  const where = typeof p === 'string' && p !== '' ? ` on ${rel(p)}` : '';
  return new KernelError('invalid_output', `${typeof syscall === 'string' ? syscall : 'fs'} failed (${c})${where}`);
}

const fold = (s: string): string => s.normalize('NFKC').toLowerCase().normalize('NFC');
/** A segment that names an applied snapshot, whatever its case or compatibility form. */
export const isAppliedSegment = (s: string): boolean => fold(s).startsWith('applied-');
const isReserved = (s: string): boolean => fold(s) === PENDING_DIR;

/** The checked segments of `relPath`, or a denial naming the rule it breaks. */
export function checkRelPath(relPath: unknown, deny: (m: string) => KernelError): string[] {
  if (typeof relPath !== 'string') throw deny('G-FILES: path must be a string');
  if (relPath === '') throw deny('G-FILES: path is empty');
  if (relPath.includes('\0')) throw deny('G-FILES: path contains NUL');
  if (relPath.includes('\\')) throw deny('G-FILES: path contains a backslash');
  if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) throw deny('G-FILES: path is absolute');
  const segs = relPath.split('/');
  if (segs.includes('..')) throw deny('G-FILES: path has a .. segment');
  if (segs.includes('.')) throw deny('G-FILES: path has a "." segment');
  if (segs.includes('')) throw deny('G-FILES: path has an empty segment');
  if (segs.some(isReserved)) throw deny(`G-FILES: ${PENDING_DIR} is reserved for staged writes`);
  return segs;
}

const appliedDenial = (relPath: string) => `G-FILES: ${relPath} is inside an applied-* snapshot, which is never written`;

async function rootRealOf(root: string, create: boolean): Promise<string> {
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    return await realpath(root);
  } catch (e) {
    if (code(e) === 'ENOENT') throw new KernelError('invalid_output', 'the files root does not exist');
    throw e;
  }
}

/**
 * The confined absolute path of `segs` below `rootReal`, checked segment by segment. `mode`:
 * - `read`: every directory must exist;
 * - `precheck`: walks only the directories that exist (a write's early check);
 * - `create`: creates missing directories (a commit).
 * For `precheck` and `create` the realpath of every existing ancestor is checked against the applied-* rule.
 */
async function confine(rootReal: string, relPath: string, segs: readonly string[], mode: 'read' | 'precheck' | 'create', deny: (m: string) => KernelError): Promise<string> {
  const writing = mode !== 'read';
  let dir = rootReal;
  let exists = true;
  for (const s of segs.slice(0, -1)) {
    dir = join(dir, s);
    if (mode === 'create') {
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch (e) {
        if (code(e) !== 'EEXIST') throw e;
      }
    }
    let st;
    try {
      st = await lstat(dir);
    } catch (e) {
      if (code(e) !== 'ENOENT') throw e;
      if (mode === 'read') throw new KernelError('invalid_output', `file ${relPath} does not exist`);
      exists = false;
      break;
    }
    if (st.isSymbolicLink()) throw deny(`G-FILES: ${relPath} passes through a symlink`);
    if (!st.isDirectory()) throw deny(`G-FILES: ${relPath} passes through a non-directory`);
  }
  // The deepest existing directory: its realpath must stay inside the root and name no applied snapshot.
  let probe = dir;
  if (!exists) probe = join(probe, '..');
  const real = await realpath(probe);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) throw deny(`G-FILES: ${relPath} resolves outside the files root`);
  if (writing && relative(rootReal, real).split(sep).filter((s) => s !== '').some(isAppliedSegment)) throw deny(appliedDenial(relPath));
  const abs = join(exists ? real : dir, segs[segs.length - 1] as string);
  if (!exists) return abs;
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) throw deny(`G-FILES: ${relPath} is a symlink`);
    if (!st.isFile()) throw deny(`G-FILES: ${relPath} is not a regular file`);
  } catch (e) {
    if (code(e) !== 'ENOENT') throw e;
  }
  return abs;
}

/** Writes `bytes` to `abs` through a temp file and a rename; the temp file is never a link. */
async function atomicWrite(abs: string, bytes: Uint8Array, deny: (m: string) => KernelError, what: string): Promise<void> {
  const tmp = `${abs}.jobpilot-tmp`;
  try {
    await unlink(tmp);
  } catch (e) {
    if (code(e) === 'EISDIR' || code(e) === 'EPERM') throw deny(`G-FILES: ${what} has a directory in the way of its temp file`);
    if (code(e) !== 'ENOENT') throw e;
  }
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, abs);
}

// ---- staged writes ----
//
// Layout: <root>/.pending/<stepKey>/<attempt>/files/<rel> and <root>/.pending/<stepKey>/<attempt>/manifest.json, one
// directory per attempt (a timed-out attempt's late write can never land in its retry's stage), plus
// <root>/.pending/<stepKey>/final.json naming the attempt to commit, written by the executor after the out guardrails
// passed and before the step is recorded done. Every directory on these paths must be a real directory: `.pending`,
// the step and attempt directories are lstat-checked before every stage, commit, discard and recovery, staged files
// are reached through the same per-segment no-symlink walk as final paths, and every open uses O_NOFOLLOW (ELOOP is a
// G-FILES denial). The kernel's own housekeeping therefore never reads, writes or deletes through a link.

interface Manifest {
  readonly stepKey: string;
  readonly files: { readonly path: string; readonly sha256: string }[];
}

const filesDenial = (m: string): KernelError => new KernelError('policy_denied', m);
const pendingRoot = (rootReal: string): string => join(rootReal, PENDING_DIR);
const stepBase = (rootReal: string, stepKey: string): string => join(rootReal, PENDING_DIR, stepKey);
const attemptBase = (rootReal: string, stepKey: string, attempt: number): string => join(stepBase(rootReal, stepKey), String(attempt));

/** True when `p` is a real directory, false when absent; a link or any other kind is a G-FILES denial. */
async function realDir(p: string, what: string): Promise<boolean> {
  let st;
  try {
    st = await lstat(p);
  } catch (e) {
    if (code(e) === 'ENOENT') return false;
    throw e;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw filesDenial(`G-FILES: ${what} is not a real directory`);
  return true;
}

/** Creates `p` if absent (one level), then requires it to be a real directory. */
async function ensureRealDir(p: string, what: string): Promise<void> {
  try {
    await mkdir(p, { mode: 0o700 });
  } catch (e) {
    if (code(e) !== 'EEXIST') throw e;
  }
  await realDir(p, what);
}

/** Reads a file without following a link; undefined when absent. */
async function readNoFollow(p: string, what: string, maxBytes: number): Promise<Uint8Array | undefined> {
  let fh;
  try {
    fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if (code(e) === 'ENOENT') return undefined;
    if (code(e) === 'ELOOP') throw filesDenial(`G-FILES: ${what} is a symlink`);
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw filesDenial(`G-FILES: ${what} is not a regular file`);
    if (st.size > maxBytes) throw new KernelError('invalid_output', `${what} exceeds ${maxBytes} bytes`);
    return new Uint8Array(await fh.readFile());
  } finally {
    await fh.close();
  }
}

/** One attempt's staged writes. Created by the executor per attempt; sealed when the attempt ends. */
export interface PendingFiles {
  readonly stepKey: string;
  readonly attempt: number;
  stage(segs: readonly string[], bytes: Uint8Array): Promise<string>;
  /** After this, `stage` refuses: an attempt that timed out cannot keep writing. */
  seal(): void;
  /** Names this attempt as the one to commit (the executor calls it once the out guardrails passed). */
  markFinal(): Promise<void>;
}

export function openPending(root: string, stepKey: string, attempt = 0): PendingFiles {
  if (!STEP_KEY.test(stepKey)) throw new Error(`not a step key: ${stepKey}`);
  if (!Number.isInteger(attempt) || attempt < 0) throw new Error(`not an attempt number: ${attempt}`);
  let sealed = false;
  const manifest: Manifest = { stepKey, files: [] };
  let chain: Promise<unknown> = Promise.resolve();
  const sealedError = () => new KernelError('timeout', 'the step is over; no new writes');
  /** The real attempt directory, created level by level, each level checked. */
  const dirs = async (): Promise<{ step: string; attemptDir: string; files: string }> => {
    const rootReal = await rootRealOf(root, true);
    await ensureRealDir(pendingRoot(rootReal), PENDING_DIR);
    const step = stepBase(rootReal, stepKey);
    await ensureRealDir(step, `${PENDING_DIR}/${stepKey}`);
    const attemptDir = attemptBase(rootReal, stepKey, attempt);
    await ensureRealDir(attemptDir, `${PENDING_DIR}/${stepKey}/${attempt}`);
    const files = join(attemptDir, 'files');
    await ensureRealDir(files, `${PENDING_DIR}/${stepKey}/${attempt}/files`);
    return { step, attemptDir, files };
  };
  return {
    stepKey,
    attempt,
    seal() {
      sealed = true;
    },
    async markFinal() {
      const { step } = await dirs();
      await atomicWrite(join(step, 'final.json'), new TextEncoder().encode(JSON.stringify({ attempt })), filesDenial, 'final.json');
    },
    stage(segs, bytes) {
      // Stages run one at a time so the manifest is always whole.
      const run = chain.then(async () => {
        if (sealed) throw sealedError();
        const { attemptDir, files } = await dirs();
        const path = segs.join('/');
        const abs = await confine(files, path, segs, 'create', filesDenial);
        await atomicWrite(abs, bytes, filesDenial, path);
        if (sealed) throw sealedError();
        const sha = sha256(bytes);
        const i = manifest.files.findIndex((f) => f.path === path);
        if (i >= 0) manifest.files.splice(i, 1);
        manifest.files.push({ path, sha256: sha });
        await atomicWrite(join(attemptDir, 'manifest.json'), new TextEncoder().encode(JSON.stringify(manifest)), filesDenial, 'manifest');
        return sha;
      });
      chain = run.catch(() => undefined);
      return run as Promise<string>;
    },
  };
}

const locks = new Map<string, Promise<unknown>>();
/** Runs `f` after every earlier commit or recovery on `root`. */
function serialised<T>(root: string, f: () => Promise<T>): Promise<T> {
  const prev = locks.get(root) ?? Promise.resolve();
  const run = prev.then(f, f);
  locks.set(root, run.catch(() => undefined));
  return run;
}

/** Test hooks for a commit: `beforeMove(i)` runs before the i-th file is moved into place (throwing simulates an I/O failure). */
export interface CommitHooks {
  readonly beforeMove?: (index: number) => void;
}

async function commitUnlocked(root: string, stepKey: string, maxBytes: number, hooks: CommitHooks): Promise<string[]> {
  const rootReal = await rootRealOf(root, true);
  if (!(await realDir(pendingRoot(rootReal), PENDING_DIR))) return [];
  const step = stepBase(rootReal, stepKey);
  if (!(await realDir(step, `${PENDING_DIR}/${stepKey}`))) return [];
  const finalBytes = await readNoFollow(join(step, 'final.json'), 'final.json', 4096);
  const attempt = finalBytes === undefined ? undefined : (JSON.parse(new TextDecoder().decode(finalBytes)) as { attempt?: unknown }).attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) {
    // No attempt was named final (the step never passed its out guardrails): nothing to commit.
    await rm(step, { recursive: true, force: true });
    return [];
  }
  const attemptDir = attemptBase(rootReal, stepKey, attempt);
  const manifestBytes = (await realDir(attemptDir, `${PENDING_DIR}/${stepKey}/${attempt}`))
    ? await readNoFollow(join(attemptDir, 'manifest.json'), 'manifest.json', maxBytes)
    : undefined;
  if (manifestBytes === undefined) {
    // The final attempt staged nothing.
    await rm(step, { recursive: true, force: true });
    return [];
  }
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  const filesDir = join(attemptDir, 'files');
  const haveFiles = await realDir(filesDir, `${PENDING_DIR}/${stepKey}/${attempt}/files`);

  // Phase 1: validate every file before moving any (paths, targets, staged bytes and their sha256).
  const plan: { path: string; staged: string | undefined; target: string }[] = [];
  for (const f of manifest.files) {
    const segs = checkRelPath(f.path, filesDenial);
    if (segs.some(isAppliedSegment)) throw filesDenial(appliedDenial(f.path));
    const target = await confine(rootReal, f.path, segs, 'create', filesDenial);
    let staged: string | undefined;
    let bytes: Uint8Array | undefined;
    if (haveFiles) {
      try {
        staged = await confine(filesDir, f.path, segs, 'read', filesDenial);
        bytes = await readNoFollow(staged, `staged ${f.path}`, maxBytes);
      } catch (e) {
        if (!(e instanceof KernelError && e.code === 'invalid_output' && /does not exist/.test(e.message))) throw e;
      }
    }
    if (bytes === undefined) {
      // Moved by an earlier, interrupted commit: committed if the target holds the recorded bytes.
      const done = await readNoFollow(target, f.path, maxBytes).then((b) => b !== undefined && sha256(b) === f.sha256);
      if (!done) throw new KernelError('invalid_output', `staged ${f.path} is gone and the target does not hold it`);
      plan.push({ path: f.path, staged: undefined, target });
      continue;
    }
    if (sha256(bytes) !== f.sha256) throw new KernelError('invalid_output', `staged ${f.path} does not match its recorded sha256`);
    plan.push({ path: f.path, staged, target });
  }

  // Phase 2: move each file into place, keeping the file it replaces as a backup, so a failure rolls the whole set back.
  const backups = join(step, 'backup');
  await ensureRealDir(backups, `${PENDING_DIR}/${stepKey}/backup`);
  const done: { target: string; backup: string | undefined; moved: boolean }[] = [];
  try {
    for (const [i, p] of plan.entries()) {
      if (p.staged === undefined) continue;
      hooks.beforeMove?.(i);
      const rec: { target: string; backup: string | undefined; moved: boolean } = { target: p.target, backup: undefined, moved: false };
      done.push(rec);
      try {
        const st = await lstat(p.target);
        if (!st.isFile()) throw filesDenial(`G-FILES: ${p.path} is not a regular file`);
        const backup = join(backups, String(i));
        await rename(p.target, backup);
        rec.backup = backup;
      } catch (e) {
        if (code(e) !== 'ENOENT') throw e;
      }
      await rename(p.staged, p.target);
      rec.moved = true;
    }
  } catch (e) {
    for (const rec of [...done].reverse()) {
      if (rec.moved) await unlink(rec.target).catch(() => undefined);
      if (rec.backup !== undefined) await rename(rec.backup, rec.target).catch(() => undefined);
    }
    throw e;
  }
  await rm(step, { recursive: true, force: true });
  return plan.map((p) => p.path);
}

/**
 * Commits one step's final attempt into place, all or nothing: every file is validated first, then moved with the
 * file it replaces kept as a backup, and any failure restores the backups. Idempotent after a crash (a file already
 * moved with its recorded sha256 counts as committed). Throws on any rule the final paths break.
 */
export function commitPending(root: string, stepKey: string, maxBytes: number, hooks: CommitHooks = {}): Promise<string[]> {
  return serialised(root, () => commitUnlocked(root, stepKey, maxBytes, hooks));
}

/** Deletes one step's staged writes, if any; never through a link. */
export async function discardPending(root: string, stepKey: string): Promise<void> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return;
  }
  await serialised(root, async () => {
    if (!(await realDir(pendingRoot(rootReal), PENDING_DIR))) return;
    if (!(await realDir(stepBase(rootReal, stepKey), `${PENDING_DIR}/${stepKey}`))) return;
    await rm(stepBase(rootReal, stepKey), { recursive: true, force: true });
  });
}

/** Whether a stage exists for this step (a real directory; a link is a G-FILES denial). */
export async function hasPending(root: string, stepKey: string): Promise<boolean> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return false;
  }
  if (!(await realDir(pendingRoot(rootReal), PENDING_DIR))) return false;
  return realDir(stepBase(rootReal, stepKey), `${PENDING_DIR}/${stepKey}`);
}

/**
 * Startup recovery: every stage under `<root>/.pending` in ascending stepKey order. A done step's stage is committed
 * (the crash came between recording it and committing it); any other is deleted. An entry that is not a real
 * directory (a link, a file) is reported and left alone, and a `.pending` that is itself a link is reported and
 * nothing under it is touched. A commit that fails is deleted and reported (an fs error by code and a path relative to
 * the root's parent, `rootName` naming the root).
 */
export async function recoverPending(
  root: string,
  isDone: (stepKey: string) => boolean,
  maxBytes: number,
  rootName = basename(root),
): Promise<{ committed: string[]; discarded: string[]; failed: { stepKey: string; message: string }[] }> {
  const out = { committed: [] as string[], discarded: [] as string[], failed: [] as { stepKey: string; message: string }[] };
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return out;
  }
  const message = (e: unknown): string => {
    const m = fsFailure(e, root, rootName);
    return m instanceof Error ? m.message : String(m);
  };
  try {
    if (!(await realDir(pendingRoot(rootReal), PENDING_DIR))) return out;
  } catch (e) {
    out.failed.push({ stepKey: PENDING_DIR, message: message(e) });
    return out;
  }
  const names = await readdir(pendingRoot(rootReal));
  for (const name of [...names].sort()) {
    const dir = join(pendingRoot(rootReal), name);
    try {
      await realDir(dir, `${PENDING_DIR}/${name}`);
    } catch (e) {
      out.failed.push({ stepKey: name, message: message(e) });
      continue;
    }
    if (STEP_KEY.test(name) && isDone(name)) {
      try {
        await commitPending(root, name, maxBytes);
        out.committed.push(name);
      } catch (e) {
        out.failed.push({ stepKey: name, message: message(e) });
        await rm(dir, { recursive: true, force: true });
      }
    } else {
      await rm(dir, { recursive: true, force: true });
      out.discarded.push(name);
    }
  }
  return out;
}

// ---- the agent-facing tool ----

export interface FilesArgs {
  /** Absolute root directory, or undefined when the provider configures none (every call is then denied). */
  readonly root: string | undefined;
  readonly rootName: string;
  readonly maxBytes: number;
  /** Records a policy denial and returns the error to throw (the broker's `deny`). */
  readonly deny: (message: string) => KernelError;
  /** This attempt's stage; without one, `write` is denied (the executor opens one per step). */
  readonly pending?: PendingFiles;
}

/**
 * The tool an agent sees, plus `locate`: the confined absolute path of an existing regular file, for the broker's
 * own use (pdfText hands it to the provider). Agents never see `locate`.
 */
export function createFiles(a: FilesArgs, access: 'read' | 'read-write'): { tool: FilesTool | WritableFilesTool; locate(relPath: string): Promise<string> } {
  const rootReal = async (create: boolean): Promise<string> => {
    if (a.root === undefined) throw a.deny(`G-FILES: no ${a.rootName} root is configured`);
    return rootRealOf(a.root, create);
  };

  const locate = async (relPath: string): Promise<string> => {
    const segs = checkRelPath(relPath, a.deny);
    const abs = await confine(await rootReal(false), relPath, segs, 'read', a.deny);
    let st;
    try {
      st = await lstat(abs);
    } catch (e) {
      if (code(e) === 'ENOENT') throw new KernelError('invalid_output', `file ${relPath} does not exist`);
      throw e;
    }
    // Every file the kernel writes is a single-link rename; a hard link could alias a file outside the root.
    if (st.nlink > 1) throw a.deny(`G-FILES: ${relPath} is a hard link`);
    return abs;
  };

  const read = async (relPath: string): Promise<{ bytes: Uint8Array; sha256: string }> => {
    const abs = await locate(relPath);
    let fh;
    try {
      fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      if (code(e) === 'ENOENT') throw new KernelError('invalid_output', `file ${relPath} does not exist`);
      if (code(e) === 'ELOOP') throw a.deny(`G-FILES: ${relPath} is a symlink`);
      throw e;
    }
    try {
      const st = await fh.stat();
      if (st.nlink > 1) throw a.deny(`G-FILES: ${relPath} is a hard link`);
      if (st.size > a.maxBytes) throw new KernelError('invalid_output', `file ${relPath} exceeds ${a.maxBytes} bytes`);
      const bytes = new Uint8Array(await fh.readFile());
      return { bytes, sha256: sha256(bytes) };
    } finally {
      await fh.close();
    }
  };

  if (access === 'read') return { tool: { read }, locate };

  const write = async (relPath: string, bytes: Uint8Array): Promise<{ path: string; sha256: string }> => {
    const segs = checkRelPath(relPath, a.deny);
    if (segs.some(isAppliedSegment)) throw a.deny(appliedDenial(relPath));
    if (!(bytes instanceof Uint8Array)) throw a.deny('G-FILES: bytes must be a Uint8Array');
    if (bytes.byteLength > a.maxBytes) throw new KernelError('invalid_output', `file ${relPath} exceeds ${a.maxBytes} bytes`);
    // The final path is checked now (so the agent's step fails at once) and again at commit.
    await confine(await rootReal(true), relPath, segs, 'precheck', a.deny);
    if (a.pending === undefined) throw a.deny('G-FILES: writes need a step transaction (the executor opens one per step)');
    const sha = await a.pending.stage(segs, bytes);
    return { path: segs.join('/'), sha256: sha };
  };
  return { tool: { read, write }, locate };
}
