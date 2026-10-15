import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkProfileId, ProfileError, readActiveProfile, resolveHome, writeActiveProfile } from '../../../src/app/profiles/root.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jobpilot-root-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const env = (over: Record<string, string>): NodeJS.ProcessEnv => ({ HOME: homedir(), ...over });

describe('profile ids', () => {
  it('accepts lowercase ids of 2-32 characters', () => {
    for (const id of ['owner', 'asha', 'lena-2', 'sam']) expect(checkProfileId(id)).toBe(id);
  });
  it('refuses bad and reserved ids by name', () => {
    for (const id of ['', 'a', 'Owner', '1abc', 'a_b', 'x'.repeat(33), '../x']) expect(() => checkProfileId(id)).toThrow(ProfileError);
    for (const id of ['daily', 'dashboard', 'profiles', 'archive', 'backups', 'logs']) expect(() => checkProfileId(id)).toThrow(/reserved/);
  });
});

describe('resolveHome', () => {
  it('legacy: a root without profiles/ is the home itself', () => {
    expect(resolveHome({ env: env({ JOBPILOT_ROOT: root }) })).toEqual({ home: root, root, profile: null, mode: 'legacy' });
  });
  it('explicit: JOBPILOT_HOME names one home, as before', () => {
    const h = join(root, 'h');
    expect(resolveHome({ env: env({ JOBPILOT_HOME: h }) })).toEqual({ home: h, root: h, profile: null, mode: 'explicit' });
    expect(() => resolveHome({ profile: 'asha', env: env({ JOBPILOT_HOME: h }) })).toThrow(/--profile cannot be combined with JOBPILOT_HOME/);
  });
  it('the default root is ~/.jobpilot', () => {
    const r = resolveHome({ env: { HOME: '/Users/x' } });
    expect(r.root.endsWith('.jobpilot')).toBe(true);
  });
  it('profiles: --profile, else the active profile', () => {
    mkdirSync(join(root, 'profiles', 'asha'), { recursive: true });
    mkdirSync(join(root, 'profiles', 'lena'), { recursive: true });
    expect(() => resolveHome({ env: env({ JOBPILOT_ROOT: root }) })).toThrow(/no active profile/);
    writeActiveProfile(root, 'asha');
    expect(readFileSync(join(root, 'active-profile'), 'utf8')).toBe('asha\n');
    expect(resolveHome({ env: env({ JOBPILOT_ROOT: root }) })).toEqual({ home: join(root, 'profiles', 'asha'), root, profile: 'asha', mode: 'profile' });
    expect(resolveHome({ profile: 'lena', env: env({ JOBPILOT_ROOT: root }) }).home).toBe(join(root, 'profiles', 'lena'));
    expect(() => resolveHome({ profile: 'sam', env: env({ JOBPILOT_ROOT: root }) })).toThrow(/no profile sam/);
  });
  it('--profile on a legacy root names the way forward', () => {
    expect(() => resolveHome({ profile: 'asha', env: env({ JOBPILOT_ROOT: root }) })).toThrow(/profile adopt <id>/);
  });
  it('a JOBPILOT_HOME holding profiles/ and no pack/ is a root (a stale plist runs the active profile)', () => {
    mkdirSync(join(root, 'profiles', 'owner'), { recursive: true });
    writeActiveProfile(root, 'owner');
    expect(resolveHome({ env: env({ JOBPILOT_HOME: root }) })).toMatchObject({ home: join(root, 'profiles', 'owner'), mode: 'profile' });
  });
  it('an unreadable or invalid active-profile reads as none', () => {
    mkdirSync(join(root, 'profiles'), { recursive: true });
    writeFileSync(join(root, 'active-profile'), '../etc\n');
    expect(readActiveProfile(root)).toBeUndefined();
  });
});
