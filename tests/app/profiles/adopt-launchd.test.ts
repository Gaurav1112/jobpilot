import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoptProfile, unadoptProfile } from '../../../src/app/profiles/adopt.js';
import { adoptLaunchd, unadoptLaunchd } from '../../../src/app/profiles/adopt-launchd.js';
import { installSchedule, type Runner } from '../../../src/app/schedule.js';

const repo = join(import.meta.dirname, '../../..');
const node = '/opt/homebrew/Cellar/node/24.15.0/bin/node';
let tmp: string;
let root: string;
let agents: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jobpilot-adoptld-'));
  root = join(tmp, 'root');
  agents = join(tmp, 'agents');
  cpSync(join(repo, 'tests/fixtures/pack'), join(root, 'pack'), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** launchctl that knows which labels are loaded. */
function launchctl() {
  const loaded = new Set<string>();
  const calls: string[] = [];
  const run: Runner = (cmd, args) => {
    if (args[0] === '--version') return { status: 0, stdout: 'v24.15.0\n', stderr: '' };
    calls.push(args.join(' '));
    const label = (args.at(-1) ?? '').split('/').pop()?.replace(/\.plist$/, '') ?? '';
    if (args[0] === 'print') return loaded.has(label) ? { status: 0, stdout: 'state = waiting\n', stderr: '' } : { status: 113, stdout: '', stderr: 'Could not find service' };
    if (args[0] === 'bootstrap') loaded.add(label);
    if (args[0] === 'bootout') loaded.delete(label);
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, loaded, calls };
}

describe('adopt hands the launchd jobs over', () => {
  it('unloads the legacy labels before moving, then installs the profile\'s', async () => {
    const lc = launchctl();
    const target = { root, node, repo, uid: 501, agentsDir: agents, run: lc.run };
    installSchedule({ node, repo, home: root, uid: 501, agentsDir: agents }, lc.run);
    expect([...lc.loaded].sort()).toEqual(['com.jobpilot.coverage', 'com.jobpilot.daily', 'com.jobpilot.dashboard', 'com.jobpilot.freelance']);
    let loadedAtFirstMove: string[] = [];
    await adoptProfile({ root, id: 'owner', clock: { now: () => '2026-10-15T08:00:00.000Z' }, launchd: adoptLaunchd(target), afterMove: () => { if (loadedAtFirstMove.length === 0) loadedAtFirstMove = ['checked', ...lc.loaded]; } });
    expect(loadedAtFirstMove).toEqual(['checked']);
    expect([...lc.loaded].sort()).toEqual(['com.jobpilot.dashboard', 'com.jobpilot.owner.coverage', 'com.jobpilot.owner.daily', 'com.jobpilot.owner.freelance']);
    expect(readdirSync(agents).sort()).toEqual(['com.jobpilot.dashboard.plist', 'com.jobpilot.owner.coverage.plist', 'com.jobpilot.owner.daily.plist', 'com.jobpilot.owner.freelance.plist']);
    expect(readFileSync(join(agents, 'com.jobpilot.dashboard.plist'), 'utf8')).toContain('JOBPILOT_ROOT');
    expect(JSON.parse(readFileSync(join(root, 'adopt.json'), 'utf8')).legacyLabelsLoaded).toEqual(['com.jobpilot.daily', 'com.jobpilot.freelance', 'com.jobpilot.coverage', 'com.jobpilot.dashboard']);
  });
  it('a rollback reloads the legacy jobs', async () => {
    const lc = launchctl();
    installSchedule({ node, repo, home: root, uid: 501, agentsDir: agents }, lc.run);
    await expect(adoptProfile({ root, id: 'owner', clock: { now: () => '2026-10-15T08:00:00.000Z' }, launchd: adoptLaunchd({ root, node, repo, uid: 501, agentsDir: agents, run: lc.run }), afterMove: () => { throw new Error('boom'); } })).rejects.toThrow(/rolled back/);
    expect([...lc.loaded].sort()).toEqual(['com.jobpilot.coverage', 'com.jobpilot.daily', 'com.jobpilot.dashboard', 'com.jobpilot.freelance']);
    expect(existsSync(join(agents, 'com.jobpilot.daily.plist'))).toBe(true);
  });
  it('a home whose schedule was never installed gets none', async () => {
    const lc = launchctl();
    await adoptProfile({ root, id: 'owner', clock: { now: () => '2026-10-15T08:00:00.000Z' }, launchd: adoptLaunchd({ root, node, repo, uid: 501, agentsDir: agents, run: lc.run }) });
    expect(lc.loaded.size).toBe(0);
    expect(lc.calls.filter((c) => c.startsWith('bootstrap'))).toEqual([]);
  });
  it('unadopt unloads the profile and the dashboard, then reloads the legacy jobs', async () => {
    const lc = launchctl();
    const target = { root, node, repo, uid: 501, agentsDir: agents, run: lc.run };
    installSchedule({ node, repo, home: root, uid: 501, agentsDir: agents }, lc.run);
    await adoptProfile({ root, id: 'owner', clock: { now: () => '2026-10-15T08:00:00.000Z' }, launchd: adoptLaunchd(target) });
    await unadoptProfile({ root, clock: { now: () => '2026-10-15T09:00:00.000Z' }, launchd: unadoptLaunchd(target) });
    expect([...lc.loaded].sort()).toEqual(['com.jobpilot.coverage', 'com.jobpilot.daily', 'com.jobpilot.dashboard', 'com.jobpilot.freelance']);
    expect(readdirSync(agents).sort()).toEqual(['com.jobpilot.coverage.plist', 'com.jobpilot.daily.plist', 'com.jobpilot.dashboard.plist', 'com.jobpilot.freelance.plist']);
    expect(readFileSync(join(agents, 'com.jobpilot.daily.plist'), 'utf8')).toContain('<key>JOBPILOT_HOME</key>');
  });
  it('refuses to touch launchd for a root the installed schedule does not run', async () => {
    const lc = launchctl();
    installSchedule({ node, repo, home: join(tmp, 'elsewhere'), uid: 501, agentsDir: agents }, lc.run);
    await expect(adoptProfile({ root, id: 'owner', clock: { now: () => '2026-10-15T08:00:00.000Z' }, launchd: adoptLaunchd({ root, node, repo, uid: 501, agentsDir: agents, run: lc.run }) })).rejects.toThrow(/installed schedule runs .*elsewhere.*use --no-launchd/);
    expect(existsSync(join(root, 'profiles'))).toBe(false);
  });
});

// I1 re-review 6: the Task 21 rule. A profile living outside India gets no freelance job from the hand-over either,
// exactly as "schedule install --profile" decides it from the home's pack.
describe('a profile living outside India', () => {
  const abroad = (dir: string) => writeFileSync(join(dir, 'pack', 'eligibility.yaml'), readFileSync(join(dir, 'pack', 'eligibility.yaml'), 'utf8').replace('residence: IN', 'residence: DE'));
  it('adopt loads its jobs without the freelance one', async () => {
    abroad(root);
    const lc = launchctl();
    installSchedule({ node, repo, home: root, uid: 501, agentsDir: agents }, lc.run);
    await adoptProfile({ root, id: 'owner', clock: { now: () => '2026-10-15T08:00:00.000Z' }, launchd: adoptLaunchd({ root, node, repo, uid: 501, agentsDir: agents, run: lc.run }) });
    expect([...lc.loaded].sort()).toEqual(['com.jobpilot.dashboard', 'com.jobpilot.owner.coverage', 'com.jobpilot.owner.daily']);
  });
  it('a failed unadopt loads its jobs back without the freelance one', async () => {
    abroad(root);
    const lc = launchctl();
    const target = { root, node, repo, uid: 501, agentsDir: agents, run: lc.run };
    installSchedule({ node, repo, home: root, uid: 501, agentsDir: agents }, lc.run);
    await adoptProfile({ root, id: 'owner', clock: { now: () => '2026-10-15T08:00:00.000Z' }, launchd: adoptLaunchd(target) });
    writeFileSync(join(root, 'pack'), 'a clash'); // pack/ moved into the home; a root file of that name blocks the unadopt
    await expect(unadoptProfile({ root, clock: { now: () => '2026-10-15T09:00:00.000Z' }, launchd: unadoptLaunchd(target) })).rejects.toThrow(/cannot unadopt: pack/);
    expect([...lc.loaded].sort()).toEqual(['com.jobpilot.dashboard', 'com.jobpilot.owner.coverage', 'com.jobpilot.owner.daily']);
  });
});
