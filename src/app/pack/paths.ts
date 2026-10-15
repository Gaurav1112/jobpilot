import { join } from 'node:path';

import { resolveHome } from '../profiles/root.js';

let selected: string | undefined;
/** The CLI's `--profile` (set once per process before the command runs). */
export function selectProfile(id: string | undefined): void {
  selected = id;
}
export const selectedProfile = (): string | undefined => selected;

/** The home this process works in: `--profile`, else `$JOBPILOT_HOME`, else the root's active profile, else the root itself (legacy). */
export function jobpilotHome(): string {
  return resolveHome({ profile: selected }).home;
}

export const packDir = (): string => join(jobpilotHome(), 'pack');
export const outDir = (): string => join(jobpilotHome(), 'out');
export const dbPath = (): string => join(jobpilotHome(), 'jobpilot.db');
export const logsDir = (): string => join(jobpilotHome(), 'logs');

/** The same locations under an explicit home (a run is given its home; tests use a temp one). */
export function homePaths(home: string): { readonly home: string; readonly pack: string; readonly out: string; readonly db: string; readonly logs: string } {
  return { home, pack: join(home, 'pack'), out: join(home, 'out'), db: join(home, 'jobpilot.db'), logs: join(home, 'logs') };
}
