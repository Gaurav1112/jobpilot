import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statfsSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { Clock } from '../../kernel/clock.js';
import { systemProbe, withLock, type ProcessProbe } from '../lock.js';
import { stampOf } from './commands.js';
import { listProfiles, META_FILE, writeMeta } from './meta.js';
import { ACTIVE_FILE, checkProfileId, isProfilesRoot, profileHome, ProfileError, PROFILES_DIR, writeActiveProfile } from './root.js';

export const JOURNAL_FILE = 'adopt.json';
export const BACKUPS_DIR = 'backups';
const MACHINE: ReadonlySet<string> = new Set([PROFILES_DIR, ACTIVE_FILE, BACKUPS_DIR, 'removed', 'pacer.db', 'pacer.db-wal', 'pacer.db-shm', JOURNAL_FILE, 'jobpilot.lock', 'jobpilot.lock.takeover']);
const TEMP = /^(?:jobpilot\.lock|active-profile|profile\.json)\..+\.tmp$/;
export const isMachineEntry = (name: string): boolean => MACHINE.has(name) || TEMP.test(name);

export const AdoptJournal = z.strictObject({ id: z.string(), at: z.string(), moved: z.array(z.string()), backup: z.string(), legacyLabelsLoaded: z.array(z.string()) });
export type AdoptJournal = z.infer<typeof AdoptJournal>;

export class AdoptError extends ProfileError {}

export interface AdoptLaunchd {
  before(): string[];
  after(id: string, loaded: readonly string[]): void;
  restore(loaded: readonly string[]): void;
}
export interface UnadoptLaunchd {
  /** Unload the profile's jobs; returns the labels that were loaded. */
  before(id: string): string[];
  after(loaded: readonly string[]): void;
  /** A failed unadopt: load the profile's jobs back. */
  restore(id: string, loaded: readonly string[]): void;
}
export const NO_LAUNCHD: AdoptLaunchd = { before: () => [], after: () => {}, restore: () => {} };
export const NO_UNADOPT_LAUNCHD: UnadoptLaunchd = { before: () => [], after: () => {}, restore: () => {} };

const DB = 'jobpilot.db';
/** Free bytes on the volume holding `dir`. */
export type FreeBytes = (dir: string) => number;
const systemFreeBytes: FreeBytes = (dir) => {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
};
/** The folder the backup is written into: `<root>/backups` (symlinks resolved, so a backups/ on another volume is measured there) when it exists, else the root it will be made in. */
function backupTarget(root: string): string {
  const b = join(root, BACKUPS_DIR);
  return existsSync(b) ? realpathSync(b) : root;
}
/**
 * Adopt and unadopt back the DB up with a full copy: refuse, before touching anything, when it would not fit where the
 * backup goes. The rule is the DB's size plus 256 MB: the other entries are copied as APFS clones (COPYFILE_FICLONE),
 * which take next to no space on the same APFS volume. A DB that is missing (a home already emptied) counts as 0.
 */
function checkSpace(dbDir: string, root: string, free: FreeBytes, what: string): void {
  const db = join(dbDir, DB);
  const need = (existsSync(db) ? statSync(db).size : 0) + 256 * 2 ** 20;
  const have = free(backupTarget(root));
  if (have < need) throw new AdoptError(`${what} needs about ${Math.ceil(need / 2 ** 20)} MB free for its backup of the database; ${Math.floor(have / 2 ** 20)} MB is free. Nothing was changed.`);
}
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Runs `fn`; the error's message when it throws, else undefined. For the clean-up steps of a failure path, which must all be tried. */
function attempt(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return why(e);
  }
}
/** The tail of a failure message about the jobs that were unloaded: loaded back, or why not and the command that does it. */
const jobsBack = (failed: string | undefined, cmd: string): string => (failed === undefined ? ' and the scheduled jobs were loaded back' : `; the scheduled jobs could not be loaded back (${failed}): run "${cmd}"`);
/** Finder litter (`.DS_Store`, AppleDouble `._*`) that would make an otherwise empty folder refuse rmdir. */
const isFinderJunk = (n: string): boolean => n === '.DS_Store' || n.startsWith('._');
/** rmdir `dir`, when it exists, after removing any Finder litter in it. */
function rmdirTidy(dir: string): void {
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) if (isFinderJunk(n)) rmSync(join(dir, n), { force: true });
  rmdirSync(dir);
}
/** Renames each `[from, to]` back (`to` -> `from`), last first, trying every one; the ones that stayed, with why. */
function moveBack(moves: readonly (readonly [string, string])[]): string[] {
  const stuck: string[] = [];
  for (const [from, to] of [...moves].reverse()) {
    const f = attempt(() => renameSync(to, from));
    if (f !== undefined) stuck.push(`${to} (${f})`);
  }
  return stuck;
}
/** A failed attempt's backup folder, removed when nothing was moved: worthless then, and it may hold the very space that failed the attempt (review I1, 5). Never one that was there before the attempt. */
function dropBackup(root: string, dir: string, existed: { backups: boolean; attempt: boolean }): string | undefined {
  if (existed.attempt) return undefined;
  const f = attempt(() => rmSync(dir, { recursive: true, force: true }));
  if (f !== undefined) return `; its partial backup ${dir} could not be removed (${f})`;
  if (!existed.backups) attempt(() => rmdirSync(join(root, BACKUPS_DIR)));
  return undefined;
}
/** sha256 of a file, read in 1 MiB chunks: a real home's DB is several GB, past readFileSync's 2 GiB limit. */
function sha(p: string): string {
  const h = createHash('sha256');
  const buf = Buffer.allocUnsafe(1 << 20);
  const fd = openSync(p, 'r');
  try {
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

/** `"<posix relPath> <size> <sha256>"` for every file under `names` (relative to `base`), sorted. */
export function treeManifest(base: string, names: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    const st = statSync(p);
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
    else out.push(`${relative(base, p).split(sep).join('/')} ${st.size} ${sha(p)}`);
  };
  for (const n of names) walk(join(base, n));
  return out.sort();
}

function checkpoint(dir: string): void {
  if (!existsSync(join(dir, DB))) return;
  const db = new Database(join(dir, DB));
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

async function backup(from: string, names: readonly string[], to: string): Promise<void> {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const n of names) {
    if (n === `${DB}-wal` || n === `${DB}-shm`) continue;
    if (n === DB) {
      const db = new Database(join(from, DB));
      try {
        await db.backup(join(to, DB));
        chmodSync(join(to, DB), 0o600);
      } finally {
        db.close();
      }
    } else cpSync(join(from, n), join(to, n), { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
  }
}

// Opened read-write on purpose: the last read-write connection to close removes the -wal/-shm files, a read-only one leaves them behind.
const integrityOk = (dir: string): boolean => {
  if (!existsSync(join(dir, DB))) return true;
  const db = new Database(join(dir, DB));
  try {
    return db.pragma('integrity_check', { simple: true }) === 'ok';
  } finally {
    db.close();
  }
};

export async function adoptProfile(o: { root: string; id: string; clock: Clock; launchd?: AdoptLaunchd; probe?: ProcessProbe; afterMove?: (name: string) => void; freeBytes?: FreeBytes }): Promise<{ home: string; moved: string[]; backup: string; lines: string[] }> {
  checkProfileId(o.id);
  if (isProfilesRoot(o.root)) throw new AdoptError(`${o.root} already has profiles; adopt runs once`);
  if (!existsSync(join(o.root, 'pack'))) throw new AdoptError(`nothing to adopt: ${o.root} has no pack/`);
  const launchd = o.launchd ?? NO_LAUNCHD;
  const at = o.clock.now();
  const backupRel = `${BACKUPS_DIR}/adopt-${stampOf(at)}`;
  const home = profileHome(o.root, o.id);
  checkSpace(o.root, o.root, o.freeBytes ?? systemFreeBytes, 'profile adopt');
  return withLock(o.root, 'profile adopt', async () => {
    let loaded: string[];
    try {
      loaded = launchd.before();
    } catch (e) {
      throw new AdoptError(`could not unload the scheduled jobs (${why(e)}); nothing was moved; "jobpilot schedule install" reloads them`);
    }
    const reload = (): string | undefined => attempt(() => launchd.restore(loaded));
    const backupDir = join(o.root, backupRel);
    const existed = { backups: existsSync(join(o.root, BACKUPS_DIR)), attempt: existsSync(backupDir) };
    // Everything before the moves: a failure here moved nothing, so the unloaded jobs are loaded back (review I1).
    let names: string[];
    let manifest: string[];
    try {
      checkpoint(o.root);
      names = readdirSync(o.root).filter((n) => !isMachineEntry(n)).sort();
      await backup(o.root, names, backupDir);
      manifest = treeManifest(o.root, names);
      writeFileSync(join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const journal: AdoptJournal = { id: o.id, at, moved: names, backup: backupRel, legacyLabelsLoaded: [...loaded] };
      writeFileSync(join(o.root, JOURNAL_FILE), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    } catch (e) {
      const journalLeft = attempt(() => rmSync(join(o.root, JOURNAL_FILE), { force: true }));
      const backupLeft = dropBackup(o.root, backupDir, existed) ?? '';
      const failed = reload();
      throw new AdoptError(
        `adopt failed before any move (${why(e)}); nothing was moved${jobsBack(failed, 'jobpilot schedule install')}${backupLeft}${journalLeft === undefined ? '' : `; delete ${join(o.root, JOURNAL_FILE)} by hand (${journalLeft})`}`,
      );
    }
    const moved: string[] = [];
    try {
      mkdirSync(join(o.root, PROFILES_DIR), { mode: 0o700 });
      mkdirSync(home, { mode: 0o700 });
      for (const n of names) {
        renameSync(join(o.root, n), join(home, n));
        moved.push(n);
        o.afterMove?.(n);
      }
      writeMeta(home, { id: o.id, createdAt: at, keychainService: 'jobpilot', adopted: true });
      writeActiveProfile(o.root, o.id);
      if (treeManifest(home, names).join('\n') !== manifest.join('\n')) throw new Error('the moved files differ from the manifest');
      if (!integrityOk(home)) throw new Error('the moved database fails PRAGMA integrity_check');
    } catch (e) {
      // Every step is tried, whatever fails before it, and the jobs are always loaded back (review I1, 3).
      const stuck = moveBack(moved.map((n) => [join(o.root, n), join(home, n)] as const));
      if (stuck.length === 0) {
        attempt(() => rmSync(join(home, META_FILE), { force: true }));
        attempt(() => rmdirTidy(home));
        attempt(() => rmdirTidy(join(o.root, PROFILES_DIR)));
        attempt(() => rmSync(join(o.root, ACTIVE_FILE), { force: true }));
        attempt(() => rmSync(join(o.root, JOURNAL_FILE), { force: true }));
      }
      const failed = reload();
      const left = [join(o.root, PROFILES_DIR), join(o.root, ACTIVE_FILE), join(o.root, JOURNAL_FILE)].filter((p) => existsSync(p));
      const how =
        stuck.length === 0
          ? `adopt failed and was rolled back (${why(e)})${left.length > 0 ? `; still to delete by hand: ${left.join(', ')}` : ''}`
          : `adopt failed (${why(e)}) and was only partly rolled back: these could not be moved back to ${o.root}: ${stuck.join(', ')}; move them there by hand, then delete ${left.join(', ')}`;
      throw new AdoptError(`${how}; the backup is ${backupDir}${failed === undefined ? '' : jobsBack(failed, 'jobpilot schedule install')}`);
    }
    try {
      launchd.after(o.id, loaded);
    } catch (e) {
      throw new AdoptError(`adopted ${o.root} as profile ${o.id}, but its scheduled jobs could not be loaded (${why(e)}); run "jobpilot schedule install --profile ${o.id}" (or undo with "jobpilot profile unadopt")`);
    }
    return {
      home, moved, backup: backupDir,
      lines: [`adopted ${o.root} as profile ${o.id} (${moved.length} entries moved to ${home})`, `backup: ${backupDir}`, `undo with: jobpilot profile unadopt`],
    };
  }, o.probe ?? systemProbe);
}

/** What `foldMachineLogs` did, so a failed unadopt can undo it exactly (review I1, 1). */
interface Fold {
  /** The root `logs/` it removed: its mode and times, to make it again as it was. */
  root?: { mode: number; atime: Date; mtime: Date };
  /** The home `logs/` times when it was there before, else undefined (the fold made it). */
  home?: { atime: Date; mtime: Date };
  madeHome: boolean;
  /** `[from, to]` for each entry moved. */
  readonly moves: [string, string][];
}
/** A name in `dir` for `n` that takes nothing over: `n`, else `n.machine`, else `n.machine.2`, `.3`, … */
function freeName(dir: string, n: string): string {
  if (!existsSync(join(dir, n))) return n;
  if (!existsSync(join(dir, `${n}.machine`))) return `${n}.machine`;
  let i = 2;
  while (existsSync(join(dir, `${n}.machine.${i}`))) i += 1;
  return `${n}.machine.${i}`;
}

/** The machine-level `logs/` (the dashboard log of a profiles root) folds into the home's own `logs/` so the home is whole again; a name taken there keeps the home's file and gets `.machine` (or `.machine.2`, … : nothing is overwritten). */
function foldMachineLogs(root: string, home: string, f: Fold): void {
  const from = join(root, 'logs');
  if (!existsSync(from)) return;
  const to = join(home, 'logs');
  if (existsSync(to)) {
    const h = statSync(to);
    f.home = { atime: h.atime, mtime: h.mtime };
  } else f.madeHome = true;
  mkdirSync(to, { recursive: true, mode: 0o700 });
  const r = statSync(from);
  for (const n of readdirSync(from)) {
    const dest = join(to, freeName(to, n));
    renameSync(join(from, n), dest);
    f.moves.push([join(from, n), dest]);
  }
  rmdirSync(from);
  f.root = { mode: r.mode & 0o7777, atime: r.atime, mtime: r.mtime };
}
/** Undoes a fold: the root `logs/` made again as it was, each entry moved back. The entries that stayed, with why. */
function unfoldMachineLogs(root: string, home: string, f: Fold): string[] {
  const from = join(root, 'logs');
  const to = join(home, 'logs');
  if (f.root !== undefined) {
    const mode = f.root.mode;
    const made = attempt(() => {
      mkdirSync(from, { mode });
      chmodSync(from, mode);
    });
    if (made !== undefined) return f.moves.map(([, t]) => `${t} (${made})`);
  }
  const stuck = moveBack(f.moves);
  if (f.root !== undefined) {
    const { atime, mtime } = f.root;
    attempt(() => utimesSync(from, atime, mtime));
  }
  if (f.madeHome) attempt(() => rmdirSync(to));
  else if (f.home !== undefined) {
    const { atime, mtime } = f.home;
    attempt(() => utimesSync(to, atime, mtime));
  }
  return stuck;
}

/** Whether every entry already left the profile home: what a failed unadopt tail leaves (only the meta file, or no home at all). */
const homeEmptied = (home: string): boolean => !existsSync(home) || readdirSync(home).every((n) => n === META_FILE || isFinderJunk(n) || n.startsWith('jobpilot.lock') || TEMP.test(n));

export async function unadoptProfile(o: { root: string; clock: Clock; launchd?: UnadoptLaunchd; probe?: ProcessProbe; freeBytes?: FreeBytes }): Promise<string[]> {
  let journal: AdoptJournal;
  try {
    journal = AdoptJournal.parse(JSON.parse(readFileSync(join(o.root, JOURNAL_FILE), 'utf8')));
  } catch {
    throw new AdoptError(`${o.root} was not adopted by jobpilot (no readable ${JOURNAL_FILE}); nothing to undo`);
  }
  const others = listProfiles(o.root).map((p) => p.id).filter((id) => id !== journal.id);
  if (others.length > 0) throw new AdoptError(`other profiles exist: ${others.join(', ')}; remove them first (jobpilot profile remove <id>)`);
  const launchd = o.launchd ?? NO_UNADOPT_LAUNCHD;
  const id = journal.id;
  const home = profileHome(o.root, id);
  const backupRel = `${BACKUPS_DIR}/unadopt-${stampOf(o.clock.now())}`;
  const backupDir = join(o.root, backupRel);
  // A retry after a tail that could not finish (review I1, 2): the files are all back at the root; only the tidy-up is left.
  if (homeEmptied(home) && existsSync(join(o.root, 'pack'))) {
    return withLock(o.root, 'profile unadopt', async () => {
      const earlier = existsSync(join(o.root, BACKUPS_DIR)) ? readdirSync(join(o.root, BACKUPS_DIR)).filter((n) => n.startsWith('unadopt-')).sort().at(-1) : undefined;
      const into = earlier === undefined ? backupDir : join(o.root, BACKUPS_DIR, earlier);
      mkdirSync(into, { recursive: true, mode: 0o700 });
      return finishUnadopt(o.root, home, journal, launchd, into);
    }, o.probe ?? systemProbe);
  }
  checkSpace(home, o.root, o.freeBytes ?? systemFreeBytes, 'profile unadopt');
  await withLock(home, 'profile unadopt', async () => {
    let loaded: string[];
    try {
      loaded = launchd.before(id);
    } catch (e) {
      // Some of the profile's jobs may be unloaded already (review I1, 7): load back the ones the launchd side says it had.
      const partly = (e as { loaded?: unknown }).loaded;
      const back = attempt(() => launchd.restore(id, Array.isArray(partly) ? (partly as string[]) : []));
      throw new AdoptError(
        `could not unload profile ${id}'s scheduled jobs (${why(e)}); nothing was moved; run "jobpilot schedule install --profile ${id}" if the jobs are missing${back === undefined ? '' : ` (loading them back failed too: ${back})`}`,
      );
    }
    // A failure from here on moves back whatever moved, undoes the logs fold and loads the profile's jobs again (review I1).
    const moved: string[] = [];
    const fold: Fold = { madeHome: false, moves: [] };
    const existed = { backups: existsSync(join(o.root, BACKUPS_DIR)), attempt: existsSync(backupDir) };
    try {
      foldMachineLogs(o.root, home, fold);
      checkpoint(home);
      const names = readdirSync(home).filter((n) => n !== META_FILE && !n.startsWith('jobpilot.lock') && !TEMP.test(n)).sort();
      const clash = names.filter((n) => existsSync(join(o.root, n)));
      if (clash.length > 0) throw new AdoptError(`cannot unadopt: ${clash.join(', ')} already exist in ${o.root}`);
      await backup(home, names, backupDir);
      const manifest = treeManifest(home, names);
      for (const n of names) {
        renameSync(join(home, n), join(o.root, n));
        moved.push(n);
      }
      if (treeManifest(o.root, names).join('\n') !== manifest.join('\n')) throw new AdoptError(`the moved files differ from the manifest; the backup is ${backupDir}`);
    } catch (e) {
      // Every step is tried, whatever fails before it, and the jobs are always loaded back (review I1, 3).
      const stuck = [...moveBack(moved.map((n) => [join(home, n), join(o.root, n)] as const)), ...unfoldMachineLogs(o.root, home, fold)];
      const backupLeft = moved.length === 0 ? (dropBackup(o.root, backupDir, existed) ?? '') : '';
      const failed = attempt(() => launchd.restore(id, loaded));
      const head = e instanceof AdoptError ? e.message : `unadopt failed (${why(e)})`;
      const state =
        stuck.length === 0
          ? `; profile ${id} is unchanged${failed === undefined ? ' and its scheduled jobs were loaded back' : ''}`
          : `; profile ${id} is only partly restored: these could not be moved back: ${stuck.join(', ')}; move them back into ${home} (or ${join(home, 'logs')}) by hand`;
      const kept = moved.length > 0 && !head.includes(backupDir) ? `; the backup is ${backupDir}` : '';
      throw new AdoptError(`${head}${state}${kept}${backupLeft}${failed === undefined ? (stuck.length === 0 ? '' : '; its scheduled jobs were loaded back') : jobsBack(failed, `jobpilot schedule install --profile ${id}`)}`);
    }
  }, o.probe ?? systemProbe);
  return finishUnadopt(o.root, home, journal, launchd, backupDir);
}

/**
 * The tail of an unadopt, once every file is back at the root: the profile folders, the active-profile pointer and the
 * journal go. At this point the home IS unadopted, so a step that fails still loads the legacy jobs, then says exactly
 * what is left to delete; running unadopt again finishes it (review I1, 2).
 */
function finishUnadopt(root: string, home: string, journal: AdoptJournal, launchd: UnadoptLaunchd, backupDir: string): string[] {
  const done = `${root} is a single jobpilot home again (profile ${journal.id} undone)`;
  try {
    rmSync(join(home, META_FILE), { force: true });
    rmdirTidy(home);
    rmdirTidy(join(root, PROFILES_DIR));
    rmSync(join(root, ACTIVE_FILE), { force: true });
    renameSync(join(root, JOURNAL_FILE), join(backupDir, JOURNAL_FILE));
  } catch (e) {
    const jobs = attempt(() => launchd.after(journal.legacyLabelsLoaded));
    const profiles = join(root, PROFILES_DIR);
    const holding = (dir: string): string => {
      const inside = existsSync(dir) ? readdirSync(dir).filter((n) => !isFinderJunk(n)) : [];
      return inside.length > 0 ? `${dir} (holding ${inside.join(', ')})` : dir;
    };
    const left = [...(existsSync(profiles) ? [holding(profiles)] : []), ...[join(root, ACTIVE_FILE), join(root, JOURNAL_FILE)].filter((p) => existsSync(p))];
    throw new AdoptError(
      `${done}, but unadopt could not finish tidying up (${why(e)}); still to delete by hand: ${left.join(', ')} (or run "jobpilot profile unadopt" again)${jobs === undefined ? '' : `; the scheduled jobs could not be loaded (${jobs}): run "jobpilot schedule install"`}`,
    );
  }
  try {
    launchd.after(journal.legacyLabelsLoaded);
  } catch (e) {
    throw new AdoptError(`${done}, but its scheduled jobs could not be loaded (${why(e)}); run "jobpilot schedule install"; the backup is ${backupDir}`);
  }
  return [done, `backup: ${backupDir}`];
}
