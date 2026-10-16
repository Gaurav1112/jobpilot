import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fault injection: adopt.ts imports renameSync/writeFileSync from node:fs; a hook set by a test can fail one call.
const hook = vi.hoisted(() => ({ rename: undefined as undefined | ((from: string, to: string) => void), write: undefined as undefined | ((p: string) => void) }));
vi.mock('node:fs', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:fs')>();
  const renameSync: typeof m.renameSync = (a, b) => {
    hook.rename?.(String(a), String(b));
    m.renameSync(a, b);
  };
  const writeFileSync = ((p: Parameters<typeof m.writeFileSync>[0], ...r: unknown[]) => {
    hook.write?.(String(p));
    return (m.writeFileSync as (...a: unknown[]) => void)(p, ...r);
  }) as typeof m.writeFileSync;
  return { ...m, default: { ...m, renameSync, writeFileSync }, renameSync, writeFileSync };
});
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
const adoptFakeThrowingRestore = (): AdoptLaunchd => ({
  ...adoptFake(),
  restore: (loaded) => {
    calls.push(`reload legacy ${loaded.length}`);
    throw new Error('launchctl bootstrap refused');
  },
});
const unadoptFake = (o: { restoreThrows?: boolean; beforeThrows?: boolean } = {}): UnadoptLaunchd => ({
  before: (id) => {
    calls.push(`unload ${id}`);
    if (o.beforeThrows) throw Object.assign(new Error('launchctl bootout failed'), { loaded: [`com.jobpilot.${id}.daily`] });
    return [`com.jobpilot.${id}.daily`];
  },
  after: (loaded) => void calls.push(`load legacy ${loaded.length}`),
  restore: (id, loaded) => {
    calls.push(`reload ${id} ${loaded.length}`);
    if (o.restoreThrows) throw new Error('launchctl bootstrap refused');
  },
});
const plenty = (): number => 1e15;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jobpilot-adopt-fail-'));
  calls = [];
  legacyHome();
});
afterEach(() => {
  hook.rename = undefined;
  hook.write = undefined;
  rmSync(root, { recursive: true, force: true });
});

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

const STAMP_A = 'adopt-20261015T080000Z';
const STAMP_U = 'unadopt-20261015T080000Z';
const later = { now: () => '2026-10-15T09:00:00.000Z' };
const adopted = async (): Promise<string> => {
  await adoptProfile({ root, id: 'owner', clock: later, freeBytes: plenty });
  return join(root, 'profiles', 'owner');
};
const msg = (e: unknown): string => String((e as Error).message);

describe('unadopt undoes its fold of the machine logs (I1 re-review 1)', () => {
  it('a failed unadopt puts the root logs/ back as it was', async () => {
    const home = await adopted();
    mkdirSync(join(root, 'logs'));
    writeFileSync(join(root, 'logs', 'dashboard.log'), 'machine\n');
    mkdirSync(join(home, 'logs'));
    writeFileSync(join(home, 'logs', 'dashboard.log'), 'profile\n');
    writeFileSync(join(root, 'daily-attempts.json'), '{}\n'); // a clash
    const err = await unadoptProfile({ root, clock, launchd: unadoptFake(), freeBytes: plenty }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdoptError);
    expect(readdirSync(join(root, 'logs'))).toEqual(['dashboard.log']);
    expect(readFileSync(join(root, 'logs', 'dashboard.log'), 'utf8')).toBe('machine\n');
    expect(readdirSync(join(home, 'logs'))).toEqual(['dashboard.log']);
    expect(readFileSync(join(home, 'logs', 'dashboard.log'), 'utf8')).toBe('profile\n');
  });
  it('a failed unadopt removes a home logs/ the fold created', async () => {
    const home = await adopted();
    mkdirSync(join(root, 'logs'));
    writeFileSync(join(root, 'logs', 'dashboard.log'), 'machine\n');
    writeFileSync(join(root, 'daily-attempts.json'), '{}\n');
    await unadoptProfile({ root, clock, launchd: unadoptFake(), freeBytes: plenty }).catch(() => undefined);
    expect(existsSync(join(home, 'logs'))).toBe(false);
    expect(readdirSync(join(root, 'logs'))).toEqual(['dashboard.log']);
  });
  it('the fold never overwrites an earlier .machine file', async () => {
    const home = await adopted();
    mkdirSync(join(root, 'logs'));
    writeFileSync(join(root, 'logs', 'dashboard.log'), 'machine 2\n');
    mkdirSync(join(home, 'logs'));
    writeFileSync(join(home, 'logs', 'dashboard.log'), 'profile\n');
    writeFileSync(join(home, 'logs', 'dashboard.log.machine'), 'machine 1\n');
    await unadoptProfile({ root, clock, freeBytes: plenty });
    expect(readdirSync(join(root, 'logs')).sort()).toEqual(['dashboard.log', 'dashboard.log.machine', 'dashboard.log.machine.2']);
    expect(readFileSync(join(root, 'logs', 'dashboard.log.machine'), 'utf8')).toBe('machine 1\n');
    expect(readFileSync(join(root, 'logs', 'dashboard.log.machine.2'), 'utf8')).toBe('machine 2\n');
  });
});

describe('the unadopt tail (I1 re-review 2)', () => {
  it('Finder junk in profiles/ does not stop it', async () => {
    const home = await adopted();
    writeFileSync(join(root, 'profiles', '.DS_Store'), 'x');
    writeFileSync(join(home, '._profile.json'), 'x');
    await unadoptProfile({ root, clock, launchd: unadoptFake(), freeBytes: plenty });
    expect(existsSync(join(root, 'profiles'))).toBe(false);
    expect(calls).toEqual(['unload owner', 'load legacy 0']);
  });
  it('a tail that cannot finish still loads the jobs, names what is left, and a retry finishes it', async () => {
    await adopted();
    writeFileSync(join(root, 'profiles', 'notes.txt'), 'mine');
    const err = await unadoptProfile({ root, clock, launchd: unadoptFake(), freeBytes: plenty }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdoptError);
    expect(msg(err)).toMatch(/single jobpilot home again/);
    expect(msg(err)).toContain(join(root, 'profiles'));
    expect(msg(err)).toContain(join(root, 'adopt.json'));
    expect(calls).toEqual(['unload owner', 'load legacy 0']);
    expect(existsSync(join(root, 'jobpilot.db'))).toBe(true);
    rmSync(join(root, 'profiles', 'notes.txt'));
    calls = [];
    const dirs: string[] = [];
    const lines = await unadoptProfile({ root, clock: { now: () => '2026-10-15T08:01:00.000Z' }, launchd: unadoptFake(), freeBytes: (d) => (dirs.push(d), 1e15) });
    expect(lines[0]).toMatch(/single jobpilot home again/);
    for (const d of dirs) expect(existsSync(d)).toBe(true);
    expect(readdirSync(root).filter((n) => ['profiles', 'active-profile', 'adopt.json'].includes(n))).toEqual([]);
    expect(existsSync(join(root, 'backups', STAMP_U, 'adopt.json'))).toBe(true);
    expect(calls).toContain('load legacy 0');
  });
});

describe('a move-back that fails (I1 re-review 3)', () => {
  it('unadopt still moves the rest back, reloads the jobs and names what stayed', async () => {
    const home = await adopted();
    let forward = 0;
    let back = 0;
    hook.rename = (a, b) => {
      if (a.startsWith(`${home}/`) && !b.startsWith(`${home}/`) && ++forward === 3) throw new Error('EXDEV: injected');
      if (b.startsWith(`${home}/`) && a.endsWith('/jobpilot.db') && ++back === 1) throw new Error('EIO: injected back');
    };
    const err = await unadoptProfile({ root, clock, launchd: unadoptFake(), freeBytes: plenty }).catch((e: unknown) => e);
    hook.rename = undefined;
    expect(err).toBeInstanceOf(AdoptError);
    expect(calls).toEqual(['unload owner', 'reload owner 1']);
    expect(msg(err)).toMatch(/EXDEV: injected/);
    expect(msg(err)).toMatch(/could not be moved back.*jobpilot\.db/);
    expect(msg(err)).toContain(join(root, 'backups', STAMP_U));
    expect(existsSync(join(home, 'daily-attempts.json'))).toBe(true); // the other moved entry went back
    expect(existsSync(join(root, 'jobpilot.db'))).toBe(true);
  });
  it('adopt rollback moves the rest back, reloads the jobs and names what stayed', async () => {
    mkdirSync(join(root, 'archive'));
    let back = 0;
    hook.rename = (a, b) => {
      if (a.includes('/profiles/owner/') && b.endsWith('/archive') && ++back === 1) throw new Error('EIO: injected back');
    };
    let n = 0;
    const err = await adoptProfile({ root, id: 'owner', clock, launchd: adoptFake(), freeBytes: plenty, afterMove: () => { if (++n === 3) throw new Error('boom'); } }).catch((e: unknown) => e);
    hook.rename = undefined;
    expect(err).toBeInstanceOf(AdoptError);
    expect(calls).toEqual(['unload legacy', 'reload legacy 2']);
    expect(msg(err)).toMatch(/boom/);
    expect(msg(err)).toMatch(/could not be moved back.*archive/);
    expect(msg(err)).toContain(join(root, 'backups', STAMP_A));
    expect(existsSync(join(root, 'daily-attempts.json'))).toBe(true);
    expect(existsSync(join(root, 'profiles', 'owner', 'archive'))).toBe(true);
  });
});

describe('a restore that throws (I1 re-review 4)', () => {
  it('adopt keeps the original cause and names the command', async () => {
    rmSync(join(root, 'backups'), { recursive: true });
    writeFileSync(join(root, 'backups'), 'not a folder');
    const err = await adoptProfile({ root, id: 'owner', clock, launchd: adoptFakeThrowingRestore(), freeBytes: plenty }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdoptError);
    expect(msg(err)).toMatch(/adopt failed before any move \(.*EEXIST|ENOTDIR/);
    expect(msg(err)).toContain('; the scheduled jobs could not be loaded back (launchctl bootstrap refused): run "jobpilot schedule install"');
    expect(msg(err)).not.toMatch(/were loaded back/);
  });
  it('adopt rollback keeps the original cause too', async () => {
    const err = await adoptProfile({ root, id: 'owner', clock, launchd: adoptFakeThrowingRestore(), freeBytes: plenty, afterMove: () => { throw new Error('boom'); } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdoptError);
    expect(msg(err)).toMatch(/rolled back \(boom\)/);
    expect(msg(err)).toContain('run "jobpilot schedule install"');
    expect(existsSync(join(root, 'jobpilot.db'))).toBe(true);
  });
  it('unadopt keeps the original cause and names the profile command', async () => {
    await adopted();
    writeFileSync(join(root, 'daily-attempts.json'), '{}\n');
    const err = await unadoptProfile({ root, clock, launchd: unadoptFake({ restoreThrows: true }), freeBytes: plenty }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdoptError);
    expect(msg(err)).toMatch(/cannot unadopt: daily-attempts.json/);
    expect(msg(err)).toContain('; the scheduled jobs could not be loaded back (launchctl bootstrap refused): run "jobpilot schedule install --profile owner"');
  });
});

describe('the backup of a failed attempt (I1 re-review 5)', () => {
  it('adopt removes it when nothing moved', async () => {
    hook.write = (p) => { if (p.endsWith('/adopt.json')) throw new Error('ENOSPC: injected'); };
    const err = await adoptProfile({ root, id: 'owner', clock, launchd: adoptFake(), freeBytes: plenty }).catch((e: unknown) => e);
    hook.write = undefined;
    expect(err).toBeInstanceOf(AdoptError);
    expect(readdirSync(join(root, 'backups'))).toEqual([]);
  });
  it('adopt removes a backups/ it created when nothing moved', async () => {
    rmSync(join(root, 'backups'), { recursive: true });
    hook.write = (p) => { if (p.endsWith('/manifest.json')) throw new Error('ENOSPC: injected'); };
    await adoptProfile({ root, id: 'owner', clock, launchd: adoptFake(), freeBytes: plenty }).catch(() => undefined);
    hook.write = undefined;
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });
  it('unadopt removes it when nothing moved', async () => {
    const home = await adopted();
    hook.rename = (a, b) => { if (a.startsWith(`${home}/`) && !b.startsWith(`${home}/`) && !a.includes('/logs')) throw new Error('EXDEV: injected'); };
    const err = await unadoptProfile({ root, clock, launchd: unadoptFake(), freeBytes: plenty }).catch((e: unknown) => e);
    hook.rename = undefined;
    expect(err).toBeInstanceOf(AdoptError);
    expect(readdirSync(join(root, 'backups'))).toEqual(['adopt-20261015T090000Z']);
    expect(existsSync(join(home, 'jobpilot.db'))).toBe(true);
  });
  it('unadopt keeps it and names it when something moved', async () => {
    const home = await adopted();
    let n = 0;
    hook.rename = (a, b) => { if (a.startsWith(`${home}/`) && !b.startsWith(`${home}/`) && ++n === 2) throw new Error('EXDEV: injected'); };
    const err = await unadoptProfile({ root, clock, launchd: unadoptFake(), freeBytes: plenty }).catch((e: unknown) => e);
    hook.rename = undefined;
    expect(existsSync(join(root, 'backups', STAMP_U, 'jobpilot.db'))).toBe(true);
    expect(msg(err)).toContain(join(root, 'backups', STAMP_U));
  });
});

describe('unadopt failing to unload the jobs (I1 re-review 7)', () => {
  it('loads back what it unloaded, moves nothing and says so', async () => {
    const home = await adopted();
    const err = await unadoptProfile({ root, clock, launchd: unadoptFake({ beforeThrows: true }), freeBytes: plenty }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdoptError);
    expect(msg(err)).toMatch(/could not unload .*launchctl bootout failed.*nothing was moved.*schedule install --profile owner/);
    expect(calls).toEqual(['unload owner', 'reload owner 1']);
    expect(existsSync(join(home, 'jobpilot.db'))).toBe(true);
    expect(existsSync(join(root, 'adopt.json'))).toBe(true);
  });
});

describe('free space is measured where the backup goes (I1 re-review 8)', () => {
  it('adopt measures a symlinked backups/ at its target', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'jobpilot-adopt-bk-'));
    try {
      rmSync(join(root, 'backups'), { recursive: true });
      symlinkSync(elsewhere, join(root, 'backups'));
      const dirs: string[] = [];
      await adoptProfile({ root, id: 'owner', clock, freeBytes: (d) => (dirs.push(d), 1e15) });
      expect(dirs).toEqual([realpathSync(elsewhere)]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
  it('adopt without backups/ measures the root', async () => {
    rmSync(join(root, 'backups'), { recursive: true });
    const dirs: string[] = [];
    await adoptProfile({ root, id: 'owner', clock, freeBytes: (d) => (dirs.push(d), 1e15) });
    expect(dirs).toEqual([root]);
  });
  it('unadopt measures the root backups/', async () => {
    await adopted();
    const dirs: string[] = [];
    await unadoptProfile({ root, clock, freeBytes: (d) => (dirs.push(d), 1e15) });
    expect(dirs).toEqual([realpathSync(join(root, 'backups'))]);
  });
});
