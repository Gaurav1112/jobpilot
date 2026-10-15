import { cpSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../../kernel/clock.js';
import { liveHolder, systemProbe, type ProcessProbe } from '../lock.js';
import { writeMeta } from './meta.js';
import { checkProfileId, isProfilesRoot, profileHome, ProfileError, PROFILES_DIR, readActiveProfile, writeActiveProfile } from './root.js';

export const REMOVED_DIR = 'removed';
export const stampOf = (iso: string): string => iso.replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');

export function createProfile(o: { root: string; id: string; clock: Clock; fromPack?: string }): string[] {
  checkProfileId(o.id);
  if (!isProfilesRoot(o.root) && existsSync(join(o.root, 'pack'))) throw new ProfileError(`${o.root} is a single jobpilot home with a pack; adopt it first: jobpilot profile adopt <id>`);
  const home = profileHome(o.root, o.id);
  if (existsSync(home)) throw new ProfileError(`profile ${o.id} already exists`);
  mkdirSync(join(o.root, PROFILES_DIR), { recursive: true, mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  for (const d of ['out', 'logs', 'secrets']) mkdirSync(join(home, d), { mode: 0o700 });
  if (o.fromPack !== undefined) cpSync(o.fromPack, join(home, 'pack'), { recursive: true });
  writeMeta(home, { id: o.id, createdAt: o.clock.now(), keychainService: `jobpilot.${o.id}`, adopted: false });
  const lines = [`created profile ${o.id} at ${home}`];
  if (readActiveProfile(o.root) === undefined) {
    writeActiveProfile(o.root, o.id);
    lines.push(`${o.id} is now the active profile`);
  }
  if (o.fromPack === undefined) lines.push(`next: put a pack in ${join(home, 'pack')} (jobpilot pack import --profile ${o.id}), then jobpilot pack check --profile ${o.id}`);
  return lines;
}

export function useProfile(o: { root: string; id: string }): string[] {
  if (!existsSync(profileHome(o.root, o.id))) throw new ProfileError(`no profile ${o.id} in ${o.root} ("jobpilot profile list" shows them)`);
  writeActiveProfile(o.root, o.id);
  return [`${o.id} is now the active profile`];
}

export function removeProfile(o: { root: string; id: string; clock: Clock; unload: (id: string) => void; probe?: ProcessProbe }): string[] {
  const home = profileHome(o.root, o.id);
  if (!existsSync(home)) throw new ProfileError(`no profile ${o.id} in ${o.root}`);
  if (readActiveProfile(o.root) === o.id) throw new ProfileError(`${o.id} is the active profile; "jobpilot profile use <other>" first`);
  const holder = liveHolder(home, o.probe ?? systemProbe);
  if (holder !== undefined) throw new ProfileError(`${o.id} is running (pid ${holder.pid}, ${holder.command}); try again when it has finished`);
  o.unload(o.id);
  const to = join(o.root, REMOVED_DIR, `${o.id}-${stampOf(o.clock.now())}`);
  mkdirSync(join(o.root, REMOVED_DIR), { recursive: true, mode: 0o700 });
  renameSync(home, to);
  return [`unloaded the launchd jobs of ${o.id}`, `archived ${home} to ${to} (nothing was deleted)`];
}
