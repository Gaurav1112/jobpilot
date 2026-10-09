import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
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
 * - nothing is ever written into an `applied-*` directory or to a path named `applied-*` (an applied snapshot is
 *   history). The test folds case and compatibility forms (NFKC, then lower case), because APFS is case-insensitive:
 *   `Applied-x`, `APPLIED-x` and fullwidth `ａｐｐｌｉｅｄ-x` all count. It runs on the requested segments and on the
 *   realpath of every existing ancestor relative to the root. Reading them is allowed.
 *
 * Writes are transactional. `write` stages bytes under `<root>/.pending/<stepKey>/files/<rel>` and records them in
 * `<root>/.pending/<stepKey>/manifest.json`; it returns the FINAL relative path and the sha256. The executor commits
 * the stage only after the step's out guardrails passed and the step is recorded done (`commitPending`: a re-check of
 * every rule above, a re-hash, then one rename per file into `<root>/<rel>`), and discards it on failure, quarantine
 * or timeout. The supervisor recovers stages left by a crash on start (`recoverPending`): a done step's stage is
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
  if (create) await mkdir(root, { recursive: true });
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
        await mkdir(dir);
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

interface Manifest {
  readonly stepKey: string;
  readonly files: { readonly path: string; readonly sha256: string }[];
}

const pendingBase = (rootReal: string, stepKey: string): string => join(rootReal, PENDING_DIR, stepKey);

/** One step's staged writes. Created by the executor per attempt; sealed when the attempt ends. */
export interface PendingFiles {
  readonly stepKey: string;
  stage(segs: readonly string[], bytes: Uint8Array): Promise<string>;
  /** After this, `stage` refuses: an attempt that timed out cannot keep writing. */
  seal(): void;
}

export function openPending(root: string, stepKey: string): PendingFiles {
  if (!STEP_KEY.test(stepKey)) throw new Error(`not a step key: ${stepKey}`);
  let sealed = false;
  const manifest: Manifest = { stepKey, files: [] };
  let chain: Promise<unknown> = Promise.resolve();
  const sealedError = () => new KernelError('timeout', 'the step is over; no new writes');
  return {
    stepKey,
    seal() {
      sealed = true;
    },
    stage(segs, bytes) {
      // Stages run one at a time so the manifest is always whole.
      const run = chain.then(async () => {
        if (sealed) throw sealedError();
        const rootReal = await rootRealOf(root, true);
        const base = pendingBase(rootReal, stepKey);
        const abs = join(base, 'files', ...segs);
        await mkdir(join(abs, '..'), { recursive: true });
        await atomicWrite(abs, bytes, (m) => new KernelError('policy_denied', m), segs.join('/'));
        if (sealed) throw sealedError();
        const path = segs.join('/');
        const sha = sha256(bytes);
        const i = manifest.files.findIndex((f) => f.path === path);
        if (i >= 0) manifest.files.splice(i, 1);
        manifest.files.push({ path, sha256: sha });
        await atomicWrite(join(base, 'manifest.json'), new TextEncoder().encode(JSON.stringify(manifest)), (m) => new KernelError('policy_denied', m), 'manifest');
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

const commitDenial = (m: string): KernelError => new KernelError('policy_denied', m);

async function commitUnlocked(root: string, stepKey: string, maxBytes: number): Promise<string[]> {
  const rootReal = await rootRealOf(root, true);
  const base = pendingBase(rootReal, stepKey);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8')) as Manifest;
  } catch (e) {
    if (code(e) === 'ENOENT') {
      // Nothing staged (or an attempt that died before its first manifest): nothing to commit.
      await rm(base, { recursive: true, force: true });
      return [];
    }
    throw e;
  }
  const committed: string[] = [];
  for (const f of manifest.files) {
    const segs = checkRelPath(f.path, commitDenial);
    if (segs.some(isAppliedSegment)) throw commitDenial(appliedDenial(f.path));
    const staged = join(base, 'files', ...segs);
    const target = await confine(rootReal, f.path, segs, 'create', commitDenial);
    let bytes: Uint8Array | undefined;
    try {
      const fh = await open(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if ((await fh.stat()).size > maxBytes) throw new KernelError('invalid_output', `staged ${f.path} exceeds ${maxBytes} bytes`);
        bytes = new Uint8Array(await fh.readFile());
      } finally {
        await fh.close();
      }
    } catch (e) {
      if (code(e) !== 'ENOENT') throw e;
    }
    if (bytes === undefined) {
      // Moved by an earlier, interrupted commit: committed if the target holds the recorded bytes.
      const done = await readFile(target).then((b) => sha256(b) === f.sha256, () => false);
      if (!done) throw new KernelError('invalid_output', `staged ${f.path} is gone and the target does not hold it`);
      committed.push(f.path);
      continue;
    }
    if (sha256(bytes) !== f.sha256) throw new KernelError('invalid_output', `staged ${f.path} does not match its recorded sha256`);
    await rename(staged, target);
    committed.push(f.path);
  }
  await rm(base, { recursive: true, force: true });
  return committed;
}

/** Commits one step's staged writes into place (idempotent). Throws on any rule the final paths break. */
export function commitPending(root: string, stepKey: string, maxBytes: number): Promise<string[]> {
  return serialised(root, () => commitUnlocked(root, stepKey, maxBytes));
}

/** Deletes one step's staged writes, if any. */
export async function discardPending(root: string, stepKey: string): Promise<void> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return;
  }
  await serialised(root, () => rm(pendingBase(rootReal, stepKey), { recursive: true, force: true }));
}

/** Whether a stage exists for this step. */
export async function hasPending(root: string, stepKey: string): Promise<boolean> {
  try {
    return (await lstat(pendingBase(await realpath(root), stepKey))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Startup recovery: every stage under `<root>/.pending` in ascending stepKey order. A done step's stage is committed
 * (the crash came between recording it and committing it); any other is deleted. A commit that fails is deleted and
 * reported.
 */
export async function recoverPending(
  root: string,
  isDone: (stepKey: string) => boolean,
  maxBytes: number,
): Promise<{ committed: string[]; discarded: string[]; failed: { stepKey: string; message: string }[] }> {
  const out = { committed: [] as string[], discarded: [] as string[], failed: [] as { stepKey: string; message: string }[] };
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return out;
  }
  let names: string[];
  try {
    names = await readdir(join(rootReal, PENDING_DIR));
  } catch (e) {
    if (code(e) === 'ENOENT') return out;
    throw e;
  }
  for (const name of [...names].sort()) {
    const dir = join(rootReal, PENDING_DIR, name);
    if (STEP_KEY.test(name) && isDone(name)) {
      try {
        await commitPending(root, name, maxBytes);
        out.committed.push(name);
      } catch (e) {
        out.failed.push({ stepKey: name, message: e instanceof Error ? e.message : String(e) });
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
    try {
      await lstat(abs);
    } catch (e) {
      if (code(e) === 'ENOENT') throw new KernelError('invalid_output', `file ${relPath} does not exist`);
      throw e;
    }
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
