import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PROFILE_ID, PROFILES_DIR, readActiveProfile } from './root.js';

export const META_FILE = 'profile.json';
export const ProfileMeta = z.strictObject({
  id: z.string().regex(PROFILE_ID),
  createdAt: z.string().datetime(),
  /** `jobpilot` for the adopted profile (its Keychain items never move), else `jobpilot.<id>`. */
  keychainService: z.string().regex(/^jobpilot(?:\.[a-z][a-z0-9-]{1,31})?$/),
  adopted: z.boolean(),
});
export type ProfileMeta = z.infer<typeof ProfileMeta>;

export function readMeta(home: string): ProfileMeta | undefined {
  try {
    return ProfileMeta.parse(JSON.parse(readFileSync(join(home, META_FILE), 'utf8')));
  } catch {
    return undefined;
  }
}

export function writeMeta(home: string, m: ProfileMeta): void {
  const tmp = join(home, `${META_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(ProfileMeta.parse(m), null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, join(home, META_FILE));
}

export interface ProfileRow {
  readonly id: string;
  readonly active: boolean;
  readonly adopted: boolean;
  readonly hasPack: boolean;
}

export function listProfiles(root: string): ProfileRow[] {
  const dir = join(root, PROFILES_DIR);
  if (!existsSync(dir)) return [];
  const active = readActiveProfile(root);
  return readdirSync(dir)
    .filter((id) => PROFILE_ID.test(id))
    .sort()
    .map((id) => ({ id, active: id === active, adopted: readMeta(join(dir, id))?.adopted === true, hasPack: existsSync(join(dir, id, 'pack')) }));
}
