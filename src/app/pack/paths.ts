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
