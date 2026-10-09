import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

export const homeWarning = (home: string): string => `JOBPILOT_HOME ${home} is readable by other users; run chmod 700 ${home}`;

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
