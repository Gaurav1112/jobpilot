import { createHash } from 'node:crypto';
import { closeSync, constants, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  before(id: string): void;
  after(loaded: readonly string[]): void;
}
export const NO_LAUNCHD: AdoptLaunchd = { before: () => [], after: () => {}, restore: () => {} };
export const NO_UNADOPT_LAUNCHD: UnadoptLaunchd = { before: () => {}, after: () => {} };

const DB = 'jobpilot.db';
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

export async function adoptProfile(o: { root: string; id: string; clock: Clock; launchd?: AdoptLaunchd; probe?: ProcessProbe; afterMove?: (name: string) => void }): Promise<{ home: string; moved: string[]; backup: string; lines: string[] }> {
  checkProfileId(o.id);
  if (isProfilesRoot(o.root)) throw new AdoptError(`${o.root} already has profiles; adopt runs once`);
  if (!existsSync(join(o.root, 'pack'))) throw new AdoptError(`nothing to adopt: ${o.root} has no pack/`);
  const launchd = o.launchd ?? NO_LAUNCHD;
  const at = o.clock.now();
  const backupRel = `${BACKUPS_DIR}/adopt-${stampOf(at)}`;
  const home = profileHome(o.root, o.id);
  return withLock(o.root, 'profile adopt', async () => {
    let loaded: string[];
    try {
      loaded = launchd.before();
    } catch (e) {
      throw new AdoptError(`could not unload the scheduled jobs (${e instanceof Error ? e.message : String(e)}); nothing was moved; "jobpilot schedule install" reloads them`);
    }
    checkpoint(o.root);
    const names = readdirSync(o.root).filter((n) => !isMachineEntry(n)).sort();
    await backup(o.root, names, join(o.root, backupRel));
    const manifest = treeManifest(o.root, names);
    writeFileSync(join(o.root, backupRel, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const journal: AdoptJournal = { id: o.id, at, moved: names, backup: backupRel, legacyLabelsLoaded: [...loaded] };
    writeFileSync(join(o.root, JOURNAL_FILE), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
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
      for (const n of [...moved].reverse()) renameSync(join(home, n), join(o.root, n));
      rmSync(join(home, META_FILE), { force: true });
      if (existsSync(home)) rmdirSync(home);
      if (existsSync(join(o.root, PROFILES_DIR))) rmdirSync(join(o.root, PROFILES_DIR));
      rmSync(join(o.root, ACTIVE_FILE), { force: true });
      rmSync(join(o.root, JOURNAL_FILE), { force: true });
      launchd.restore(loaded);
      throw new AdoptError(`adopt failed and was rolled back (${e instanceof Error ? e.message : String(e)}); the backup is ${join(o.root, backupRel)}`);
    }
    launchd.after(o.id, loaded);
    return {
      home, moved, backup: join(o.root, backupRel),
      lines: [`adopted ${o.root} as profile ${o.id} (${moved.length} entries moved to ${home})`, `backup: ${join(o.root, backupRel)}`, `undo with: jobpilot profile unadopt`],
    };
  }, o.probe ?? systemProbe);
}

/** The machine-level `logs/` (the dashboard log of a profiles root) folds into the home's own `logs/` so the home is whole again; a name taken there keeps the home's file and gets `.machine`. */
function foldMachineLogs(root: string, home: string): void {
  const from = join(root, 'logs');
  if (!existsSync(from)) return;
  const to = join(home, 'logs');
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const n of readdirSync(from)) renameSync(join(from, n), join(to, existsSync(join(to, n)) ? `${n}.machine` : n));
  rmdirSync(from);
}

export async function unadoptProfile(o: { root: string; clock: Clock; launchd?: UnadoptLaunchd; probe?: ProcessProbe }): Promise<string[]> {
  let journal: AdoptJournal;
  try {
    journal = AdoptJournal.parse(JSON.parse(readFileSync(join(o.root, JOURNAL_FILE), 'utf8')));
  } catch {
    throw new AdoptError(`${o.root} was not adopted by jobpilot (no readable ${JOURNAL_FILE}); nothing to undo`);
  }
  const others = listProfiles(o.root).map((p) => p.id).filter((id) => id !== journal.id);
  if (others.length > 0) throw new AdoptError(`other profiles exist: ${others.join(', ')}; remove them first (jobpilot profile remove <id>)`);
  const launchd = o.launchd ?? NO_UNADOPT_LAUNCHD;
  const home = profileHome(o.root, journal.id);
  const backupRel = `${BACKUPS_DIR}/unadopt-${stampOf(o.clock.now())}`;
  await withLock(home, 'profile unadopt', async () => {
    launchd.before(journal.id);
    foldMachineLogs(o.root, home);
    checkpoint(home);
    const names = readdirSync(home).filter((n) => n !== META_FILE && !n.startsWith('jobpilot.lock') && !TEMP.test(n)).sort();
    const clash = names.filter((n) => existsSync(join(o.root, n)));
    if (clash.length > 0) throw new AdoptError(`cannot unadopt: ${clash.join(', ')} already exist in ${o.root}`);
    await backup(home, names, join(o.root, backupRel));
    const manifest = treeManifest(home, names);
    for (const n of names) renameSync(join(home, n), join(o.root, n));
    if (treeManifest(o.root, names).join('\n') !== manifest.join('\n')) throw new AdoptError(`the moved files differ from the manifest; the backup is ${join(o.root, backupRel)}`);
  }, o.probe ?? systemProbe);
  rmSync(join(home, META_FILE), { force: true });
  rmdirSync(home);
  rmdirSync(join(o.root, PROFILES_DIR));
  rmSync(join(o.root, ACTIVE_FILE), { force: true });
  renameSync(join(o.root, JOURNAL_FILE), join(o.root, backupRel, JOURNAL_FILE));
  launchd.after(journal.legacyLabelsLoaded);
  return [`${o.root} is a single jobpilot home again (profile ${journal.id} undone)`, `backup: ${join(o.root, backupRel)}`];
}
