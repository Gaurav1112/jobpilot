import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withLock } from '../../../src/app/lock.js';
import { createProfile, removeProfile, stampOf, useProfile } from '../../../src/app/profiles/commands.js';
import { listProfiles, readMeta } from '../../../src/app/profiles/meta.js';
import { readActiveProfile } from '../../../src/app/profiles/root.js';

const repo = join(import.meta.dirname, '../../..');
const clock = { now: () => '2026-10-15T08:00:00.000Z' };
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jobpilot-pcmd-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('profile commands', () => {
  it('stampOf', () => expect(stampOf('2026-10-15T08:00:00.000Z')).toBe('20261015T080000Z'));
  it('create makes a private, complete home and the first becomes active', () => {
    createProfile({ root, id: 'asha', clock, fromPack: join(repo, 'tests/fixtures/pack') });
    createProfile({ root, id: 'lena', clock });
    const home = join(root, 'profiles', 'asha');
    for (const d of ['out', 'logs', 'secrets']) expect(statSync(join(home, d)).mode & 0o777).toBe(0o700);
    expect(existsSync(join(home, 'pack', 'facts.yaml'))).toBe(true);
    expect(readMeta(home)).toEqual({ id: 'asha', createdAt: '2026-10-15T08:00:00.000Z', keychainService: 'jobpilot.asha', adopted: false });
    expect(readActiveProfile(root)).toBe('asha');
    expect(listProfiles(root)).toEqual([
      { id: 'asha', active: true, adopted: false, hasPack: true },
      { id: 'lena', active: false, adopted: false, hasPack: false },
    ]);
  });
  it('create refuses a legacy home and an existing id', () => {
    mkdirSync(join(root, 'pack'));
    expect(() => createProfile({ root, id: 'asha', clock })).toThrow(/adopt it first/);
    rmSync(join(root, 'pack'), { recursive: true });
    createProfile({ root, id: 'asha', clock });
    expect(() => createProfile({ root, id: 'asha', clock })).toThrow(/already exists/);
  });
  it('use switches the active profile; an unknown id is refused', () => {
    createProfile({ root, id: 'asha', clock });
    createProfile({ root, id: 'lena', clock });
    useProfile({ root, id: 'lena' });
    expect(readFileSync(join(root, 'active-profile'), 'utf8')).toBe('lena\n');
    expect(() => useProfile({ root, id: 'sam' })).toThrow(/no profile sam/);
  });
  it('remove unloads, then archives; it never deletes', () => {
    createProfile({ root, id: 'asha', clock });
    createProfile({ root, id: 'lena', clock });
    writeFileSync(join(root, 'profiles', 'lena', 'jobpilot.db'), 'db');
    const unloaded: string[] = [];
    removeProfile({ root, id: 'lena', clock, unload: (id) => unloaded.push(id) });
    expect(unloaded).toEqual(['lena']);
    expect(existsSync(join(root, 'profiles', 'lena'))).toBe(false);
    expect(readFileSync(join(root, 'removed', 'lena-20261015T080000Z', 'jobpilot.db'), 'utf8')).toBe('db');
  });
  it('remove refuses the active profile and a running one', async () => {
    createProfile({ root, id: 'asha', clock });
    createProfile({ root, id: 'lena', clock });
    expect(() => removeProfile({ root, id: 'asha', clock, unload: () => {} })).toThrow(/active profile/);
    await withLock(join(root, 'profiles', 'lena'), 'run', async () => {
      expect(() => removeProfile({ root, id: 'lena', clock, unload: () => {} })).toThrow(/is running \(pid \d+, run\)/);
    });
    expect(readdirSync(join(root, 'profiles')).sort()).toEqual(['asha', 'lena']);
  });
});
