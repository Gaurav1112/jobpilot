import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The machine root and its profiles (profiles spec §3). A root without `profiles/` is today's single home (legacy
 * mode, byte for byte); with it, each `profiles/<id>/` is a complete home and `active-profile` names the default.
 * `JOBPILOT_HOME` still names one home directly (tests, temp homes); `JOBPILOT_ROOT` names the root.
 */
export const PROFILE_ID = /^[a-z][a-z0-9-]{1,31}$/;
export const RESERVED_PROFILE_IDS: ReadonlySet<string> = new Set(['daily', 'freelance', 'coverage', 'dashboard', 'profiles', 'archive', 'backups', 'logs', 'root']);
export const PROFILES_DIR = 'profiles';
export const ACTIVE_FILE = 'active-profile';

export class ProfileError extends Error {
  override readonly name = 'ProfileError';
}

export function checkProfileId(id: string): string {
  if (!PROFILE_ID.test(id)) throw new ProfileError(`profile id ${JSON.stringify(id)} must be 2-32 characters: a lowercase letter, then lowercase letters, digits or hyphens`);
  if (RESERVED_PROFILE_IDS.has(id)) throw new ProfileError(`profile id ${id} is reserved`);
  return id;
}

export function jobpilotRoot(env: NodeJS.ProcessEnv = process.env): string {
  const r = env['JOBPILOT_ROOT'];
  return r !== undefined && r !== '' ? r : join(env['HOME'] ?? homedir(), '.jobpilot');
}

export const isProfilesRoot = (root: string): boolean => existsSync(join(root, PROFILES_DIR));
export const profileHome = (root: string, id: string): string => join(root, PROFILES_DIR, checkProfileId(id));

export function readActiveProfile(root: string): string | undefined {
  try {
    const id = readFileSync(join(root, ACTIVE_FILE), 'utf8').trim();
    return PROFILE_ID.test(id) && !RESERVED_PROFILE_IDS.has(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Written whole (temp file + rename), 0600. */
export function writeActiveProfile(root: string, id: string): void {
  checkProfileId(id);
  const tmp = join(root, `${ACTIVE_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, `${id}\n`, { mode: 0o600 });
  renameSync(tmp, join(root, ACTIVE_FILE));
}

export interface HomeChoice {
  readonly home: string;
  readonly root: string;
  readonly profile: string | null;
  readonly mode: 'explicit' | 'legacy' | 'profile';
}

export function resolveHome(o: { profile?: string | undefined; env?: NodeJS.ProcessEnv } = {}): HomeChoice {
  const env = o.env ?? process.env;
  const explicit = env['JOBPILOT_HOME'];
  let root: string;
  if (explicit !== undefined && explicit !== '') {
    if (!(isProfilesRoot(explicit) && !existsSync(join(explicit, 'pack')))) {
      if (o.profile !== undefined) throw new ProfileError('--profile cannot be combined with JOBPILOT_HOME, which names one home; unset JOBPILOT_HOME (or set JOBPILOT_ROOT instead)');
      return { home: explicit, root: explicit, profile: null, mode: 'explicit' };
    }
    root = explicit;
  } else {
    root = jobpilotRoot(env);
  }
  if (!isProfilesRoot(root)) {
    if (o.profile !== undefined) throw new ProfileError(`${root} has no profiles yet; run "jobpilot profile adopt <id>" (an existing home) or "jobpilot profile create <id>" (a new one) first`);
    return { home: root, root, profile: null, mode: 'legacy' };
  }
  const id = o.profile ?? readActiveProfile(root);
  if (id === undefined) throw new ProfileError(`no active profile in ${root}: run "jobpilot profile use <id>" or pass --profile <id>`);
  const home = profileHome(root, id);
  if (!existsSync(home)) throw new ProfileError(`no profile ${id} in ${root} ("jobpilot profile list" shows them)`);
  return { home, root, profile: id, mode: 'profile' };
}
