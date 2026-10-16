import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoptProfile, AdoptError, unadoptProfile, type AdoptLaunchd, type UnadoptLaunchd } from '../../../src/app/profiles/adopt.js';

// Task 22 whole-branch review I1: a failure after the scheduled jobs were unloaded must load them back (and say how),
// and a home without the free space for its backup is refused before anything is unloaded.
const repo = join(import.meta.dirname, '../../..');
const clock = { now: () => '2026-10-15T08:00:00.000Z' };
const LABELS = ['com.jobpilot.daily', 'com.jobpilot.dashboard'];
let root: string;
let calls: string[];

function legacyHome(): void {
  cpSync(join(repo, 'tests/fixtures/pack'), join(root, 'pack'), { recursive: true });
  const db = new Database(join(root, 'jobpilot.db'));
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('row')");
  db.close();
  mkdirSync(join(root, 'out'));
  writeFileSync(join(root, 'daily-attempts.json'), '{}\n');
  mkdirSync(join(root, 'backups'));
}
const adoptFake = (o: { failAfter?: boolean } = {}): AdoptLaunchd => ({
  before: () => (calls.push('unload legacy'), [...LABELS]),
  after: (id) => {
    calls.push(`load ${id}`);
    if (o.failAfter) throw new Error('launchctl bootstrap failed');
  },
  restore: (loaded) => void calls.push(`reload legacy ${loaded.length}`),
});
const unadoptFake = (): UnadoptLaunchd => ({
  before: (id) => (calls.push(`unload ${id}`), [`com.jobpilot.${id}.daily`]),
  after: (loaded) => void calls.push(`load legacy ${loaded.length}`),
  restore: (id, loaded) => void calls.push(`reload ${id} ${loaded.length}`),
});
const plenty = (): number => 1e15;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jobpilot-adopt-fail-'));
  calls = [];
  legacyHome();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('adopt failing after the jobs were unloaded', () => {
  it('a backup that cannot be written reloads the legacy jobs, moves nothing and leaves no journal', async () => {
    rmSync(join(root, 'backups'), { recursive: true });
    writeFileSync(join(root, 'backups'), 'not a folder'); // mkdir backups/adopt-… fails
    const err = await adoptProfile({ root, id: 'owner', clock, launchd: adoptFake(), freeBytes: plenty }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdoptError);
    expect(String((err as Error).message)).toMatch(/nothing was moved/);
    expect(calls).toEqual(['unload legacy', 'reload legacy 2']);
    expect(existsSync(join(root, 'profiles'))).toBe(false);
    expect(existsSync(join(root, 'adopt.json'))).toBe(false);
    expect(existsSync(join(root, 'jobpilot.db'))).toBe(true);
  });
  it('loading the profile jobs failing after a good adopt names the command that loads them', async () => {
    const err = await adoptProfile({ root, id: 'owner', clock, launchd: adoptFake({ failAfter: true }), freeBytes: plenty }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdoptError);
    expect(String((err as Error).message)).toMatch(/schedule install --profile owner/);
    expect(existsSync(join(root, 'profiles', 'owner', 'jobpilot.db'))).toBe(true); // the adopt itself stands
  });
  it('too little free space for the backup is refused before any job is unloaded', async () => {
    const err = await adoptProfile({ root, id: 'owner', clock, launchd: adoptFake(), freeBytes: () => 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdoptError);
    expect(String((err as Error).message)).toMatch(/free/);
    expect(calls).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(['backups', 'daily-attempts.json', 'jobpilot.db', 'out', 'pack']);
  });
});

describe('unadopt failing after the jobs were unloaded', () => {
  it('a clash reloads the profile jobs and leaves the profile as it was', async () => {
    await adoptProfile({ root, id: 'owner', clock, freeBytes: plenty });
    writeFileSync(join(root, 'daily-attempts.json'), '{}\n'); // a clash at the root
    const err = await unadoptProfile({ root, clock, launchd: unadoptFake(), freeBytes: plenty }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdoptError);
    expect(calls).toEqual(['unload owner', 'reload owner 1']);
    expect(existsSync(join(root, 'profiles', 'owner', 'jobpilot.db'))).toBe(true);
    expect(existsSync(join(root, 'adopt.json'))).toBe(true);
  });
  it('too little free space is refused before any job is unloaded', async () => {
    await adoptProfile({ root, id: 'owner', clock, freeBytes: plenty });
    const err = await unadoptProfile({ root, clock, launchd: unadoptFake(), freeBytes: () => 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdoptError);
    expect(String((err as Error).message)).toMatch(/free/);
    expect(calls).toEqual([]);
  });
});
