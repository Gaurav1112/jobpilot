import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root of all jobpilot state: `$JOBPILOT_HOME`, else `~/.jobpilot`. */
export function jobpilotHome(): string {
  const env = process.env['JOBPILOT_HOME'];
  return env !== undefined && env !== '' ? env : join(homedir(), '.jobpilot');
}

export const packDir = (): string => join(jobpilotHome(), 'pack');
export const outDir = (): string => join(jobpilotHome(), 'out');
export const dbPath = (): string => join(jobpilotHome(), 'jobpilot.db');
export const logsDir = (): string => join(jobpilotHome(), 'logs');

/** The same locations under an explicit home (a run is given its home; tests use a temp one). */
export function homePaths(home: string): { readonly home: string; readonly pack: string; readonly out: string; readonly db: string; readonly logs: string } {
  return { home, pack: join(home, 'pack'), out: join(home, 'out'), db: join(home, 'jobpilot.db'), logs: join(home, 'logs') };
}
