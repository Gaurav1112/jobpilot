import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The jobpilot home's permissions (Task 13 fix round 4, I5). jobpilot makes its home and `out/` owner-only (0700)
 * only when it creates them itself. It never changes the mode of a directory that already exists: the home is the
 * user's choice (`JOBPILOT_HOME`), and may be a symlink, a shared folder, `.` or their own home directory. An existing
 * home that other accounts can read gets one warning per process instead.
 */

type Sink = (message: string) => void;
const defaultSink: Sink = (m) => console.error(`warning: ${m}`);
let sink: Sink = defaultSink;
const warned = new Set<string>();

/** Tests: capture warnings (and forget which were already given); undefined restores stderr. */
export function setWarningSink(s: Sink | undefined): void {
  sink = s ?? defaultSink;
  warned.clear();
}

/** Prints `message` once per process. */
export function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  sink(message);
}

/** The absolute, resolved path (a symlink's target; `.` as the working directory). */
function absolute(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

const owned = (p: string): boolean => {
  try {
    return process.getuid === undefined || statSync(p).uid === process.getuid();
  } catch {
    return true;
  }
};

/** The home warning: chmod when the user owns the folder, else move the home somewhere private. */
export function homeWarning(home: string): string {
  const abs = absolute(home);
  const fix = owned(abs) ? `run chmod 700 ${abs}` : 'move JOBPILOT_HOME to a private folder, e.g. ~/.jobpilot';
  return `JOBPILOT_HOME ${abs} is readable by other users; ${fix}`;
}

/** A DB file jobpilot will not chmod (a symlink's open target). */
export function fileWarning(file: string): string {
  const abs = absolute(file);
  const fix = owned(abs) ? `run chmod 600 ${abs}` : 'move JOBPILOT_HOME to a private folder, e.g. ~/.jobpilot';
  return `${abs} is readable by other users; ${fix}`;
}

/** Warns (once) when the existing home, or the folder a symlinked home points at, is group- or world-accessible. */
export function checkHome(home: string): void {
  try {
    if ((statSync(home).mode & 0o077) !== 0) warnOnce(homeWarning(home));
  } catch {
    // no home yet: nothing to check
  }
}

/** Creates the home and `out/` (0700, only the directories it creates), then checks an existing home. */
export function ensureHome(home: string): void {
  mkdirSync(join(home, 'out'), { recursive: true, mode: 0o700 });
  checkHome(home);
}
