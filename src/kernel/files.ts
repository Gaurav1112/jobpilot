import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { KernelError } from './errors.js';

/**
 * The files capability (`capabilities.files`): reads and writes confined to one root directory. The root itself is
 * configuration (`providers.fileRoots`), so it may be a symlink; everything below it is agent input and is checked:
 * - the path is a non-empty string of `/`-separated segments, none empty, `.` or `..`, with no NUL or backslash,
 *   and not absolute (`/x`, `C:/x`);
 * - every existing directory below the root is a real directory, never a symlink, and the parent's realpath is
 *   inside the root's realpath (re-checked after creating missing directories);
 * - the file itself is never a symlink: reads open it with O_NOFOLLOW, writes go to a temp file opened with
 *   O_EXCL | O_NOFOLLOW and are renamed over the target (a rename replaces a link, never follows it);
 * - nothing is ever written into an `applied-*` directory (an applied snapshot is history), nor to a path named
 *   `applied-*`. Reading them is allowed.
 */
export interface FilesTool {
  read(relPath: string): Promise<{ readonly bytes: Uint8Array; readonly sha256: string }>;
}
export interface WritableFilesTool extends FilesTool {
  write(relPath: string, bytes: Uint8Array): Promise<{ readonly path: string; readonly sha256: string }>;
}

export interface FilesArgs {
  /** Absolute root directory, or undefined when the provider configures none (every call is then denied). */
  readonly root: string | undefined;
  readonly rootName: string;
  readonly maxBytes: number;
  /** Records a policy denial and returns the error to throw (the broker's `deny`). */
  readonly deny: (message: string) => KernelError;
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const code = (e: unknown): string | undefined => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code as string | undefined : undefined);

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
  return segs;
}

/**
 * The tool an agent sees, plus `locate`: the confined absolute path of an existing regular file, for the broker's
 * own use (pdfText hands it to the provider). Agents never see `locate`.
 */
export function createFiles(a: FilesArgs, access: 'read' | 'read-write'): { tool: FilesTool | WritableFilesTool; locate(relPath: string): Promise<string> } {
  const rootReal = async (create: boolean): Promise<string> => {
    if (a.root === undefined) throw a.deny(`G-FILES: no ${a.rootName} root is configured`);
    if (create) await mkdir(a.root, { recursive: true });
    try {
      return await realpath(a.root);
    } catch (e) {
      if (code(e) === 'ENOENT') throw new KernelError('invalid_output', `the ${a.rootName} root does not exist`);
      throw e;
    }
  };

  /** The confined absolute path of `segs` (directories created when `create`), checked segment by segment. */
  const resolve = async (relPath: string, segs: readonly string[], create: boolean): Promise<string> => {
    const root = await rootReal(create);
    let dir = root;
    for (const s of segs.slice(0, -1)) {
      dir = join(dir, s);
      if (create) {
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
        if (code(e) === 'ENOENT') throw new KernelError('invalid_output', `file ${relPath} does not exist`);
        throw e;
      }
      if (st.isSymbolicLink()) throw a.deny(`G-FILES: ${relPath} passes through a symlink`);
      if (!st.isDirectory()) throw a.deny(`G-FILES: ${relPath} passes through a non-directory`);
    }
    const parent = await realpath(dir);
    if (parent !== root && !parent.startsWith(root + sep)) throw a.deny(`G-FILES: ${relPath} resolves outside the ${a.rootName} root`);
    const abs = join(parent, segs[segs.length - 1] as string);
    try {
      const st = await lstat(abs);
      if (st.isSymbolicLink()) throw a.deny(`G-FILES: ${relPath} is a symlink`);
      if (!st.isFile()) throw a.deny(`G-FILES: ${relPath} is not a regular file`);
    } catch (e) {
      if (code(e) !== 'ENOENT') throw e;
    }
    return abs;
  };

  const read = async (relPath: string): Promise<{ bytes: Uint8Array; sha256: string }> => {
    const segs = checkRelPath(relPath, a.deny);
    const abs = await resolve(relPath, segs, false);
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

  const locate = async (relPath: string): Promise<string> => {
    const abs = await resolve(relPath, checkRelPath(relPath, a.deny), false);
    try {
      await lstat(abs);
    } catch (e) {
      if (code(e) === 'ENOENT') throw new KernelError('invalid_output', `file ${relPath} does not exist`);
      throw e;
    }
    return abs;
  };

  if (access === 'read') return { tool: { read }, locate };

  const write = async (relPath: string, bytes: Uint8Array): Promise<{ path: string; sha256: string }> => {
    const segs = checkRelPath(relPath, a.deny);
    if (segs.some((s) => s.startsWith('applied-'))) throw a.deny(`G-FILES: ${relPath} is inside an applied-* snapshot, which is never written`);
    if (!(bytes instanceof Uint8Array)) throw a.deny('G-FILES: bytes must be a Uint8Array');
    if (bytes.byteLength > a.maxBytes) throw new KernelError('invalid_output', `file ${relPath} exceeds ${a.maxBytes} bytes`);
    const abs = await resolve(relPath, segs, true);
    const tmp = `${abs}.jobpilot-tmp`;
    // A temp file left by a crash is removed (unlinking a symlink removes the link, never its target).
    await unlink(tmp).catch((e: unknown) => {
      if (code(e) !== 'ENOENT') throw e;
    });
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, abs);
    return { path: segs.join('/'), sha256: sha256(bytes) };
  };
  return { tool: { read, write }, locate };
}
