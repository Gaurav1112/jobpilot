import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoptProfile, AdoptError } from '../../../src/app/profiles/adopt.js';
import { adoptLaunchd } from '../../../src/app/profiles/adopt-launchd.js';
import { installSchedule, type Runner } from '../../../src/app/schedule.js';

// The real adopt (2026-10-17) failed safely: launchctl bootout returned while the live dashboard was still exiting,
// so jobpilot.db-shm was listed, then vanished (ENOENT). Adopt must wait for the unloaded jobs' processes to exit, and
// never move SQLite's transient sidecars.
const repo = join(import.meta.dirname, '../../..');
const node = '/opt/homebrew/Cellar/node/24.15.0/bin/node';
const clock = { now: () => '2026-10-17T16:30:00.000Z' };
let tmp: string;
let root: string;
let agents: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jobpilot-adoptlive-'));
  root = join(tmp, 'root');
  agents = join(tmp, 'agents');
  cpSync(join(repo, 'tests/fixtures/pack'), join(root, 'pack'), { recursive: true });
  const db = new Database(join(root, 'jobpilot.db'));
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('row')");
  db.close();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** launchctl where the dashboard is running (pid 4242) while loaded. */
function launchctl() {
  const loaded = new Set<string>();
  const calls: string[] = [];
  const run: Runner = (_cmd, args) => {
    if (args[0] === '--version') return { status: 0, stdout: 'v24.15.0\n', stderr: '' };
    calls.push(args.join(' '));
    const label = (args.at(-1) ?? '').split('/').pop()?.replace(/\.plist$/, '') ?? '';
    if (args[0] === 'print') {
      if (!loaded.has(label)) return { status: 113, stdout: '', stderr: 'Could not find service' };
      return { status: 0, stdout: label === 'com.jobpilot.dashboard' ? '\tstate = running\n\tpid = 4242\n' : '\tstate = waiting\n', stderr: '' };
    }
    if (args[0] === 'bootstrap') loaded.add(label);
    if (args[0] === 'bootout') loaded.delete(label);
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, loaded, calls };
}

describe('adopt waits for the unloaded jobs to exit', () => {
  it('a dashboard still exiting after bootout is waited for, then the move goes ahead', async () => {
    const lc = launchctl();
    installSchedule({ node, repo, home: root, uid: 501, agentsDir: agents }, lc.run);
    let polls = 0;
    const alive = (pid: number): boolean => pid === 4242 && ++polls <= 3; // exits on the 4th look
    await adoptProfile({ root, id: 'owner', clock, launchd: adoptLaunchd({ root, node, repo, uid: 501, agentsDir: agents, run: lc.run, alive, sleepMs: () => {} }) });
    expect(polls).toBeGreaterThanOrEqual(4);
    expect(existsSync(join(root, 'profiles', 'owner', 'jobpilot.db'))).toBe(true);
  });
  it('a process that never exits: the jobs are loaded back and nothing moves', async () => {
    const lc = launchctl();
    installSchedule({ node, repo, home: root, uid: 501, agentsDir: agents }, lc.run);
    const err = await adoptProfile({ root, id: 'owner', clock, launchd: adoptLaunchd({ root, node, repo, uid: 501, agentsDir: agents, run: lc.run, alive: () => true, sleepMs: () => {}, exitTimeoutMs: 0 }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdoptError);
    expect(String((err as Error).message)).toMatch(/still running/);
    expect([...lc.loaded].sort()).toEqual(['com.jobpilot.coverage', 'com.jobpilot.daily', 'com.jobpilot.dashboard', 'com.jobpilot.freelance']);
    expect(existsSync(join(root, 'profiles'))).toBe(false);
  });
});

describe('SQLite sidecars are never entries to move', () => {
  it('a -shm left over is not moved (and cannot vanish mid-manifest)', async () => {
    writeFileSync(join(root, 'jobpilot.db-shm'), Buffer.alloc(32768));
    const r = await adoptProfile({ root, id: 'owner', clock });
    expect(r.moved).not.toContain('jobpilot.db-shm');
    expect(readdirSync(join(root, 'profiles', 'owner'))).not.toContain('jobpilot.db-shm');
  });
  it('another live connection holding a read snapshot: the WAL cannot be folded, so the DB is in use and nothing moves', async () => {
    const writer = new Database(join(root, 'jobpilot.db'));
    writer.pragma('journal_mode = WAL');
    const reader = new Database(join(root, 'jobpilot.db'));
    reader.prepare('BEGIN').run();
    reader.prepare('SELECT count(*) FROM t').get(); // a read snapshot pins the WAL
    writer.prepare("INSERT INTO t VALUES ('newer')").run();
    try {
      const err = await adoptProfile({ root, id: 'owner', clock }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AdoptError);
      expect(String((err as Error).message)).toMatch(/in use/);
      expect(existsSync(join(root, 'profiles'))).toBe(false);
    } finally {
      reader.prepare('COMMIT').run();
      reader.close();
      writer.close();
    }
  });
});
