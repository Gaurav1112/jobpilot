import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DASHBOARD_LABEL, installSchedule, plistDaily, plistDashboardRoot, profileLabels, runNow, scheduleStatus, uninstallSchedule, type Runner } from '../../../src/app/schedule.js';

const node = '/opt/homebrew/Cellar/node/24.15.0/bin/node';
const repo = '/Users/x/jobpilot';
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jobpilot-psched-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const fake = () => {
  const calls: string[][] = [];
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return args[0] === '--version' ? { status: 0, stdout: 'v24.15.0\n', stderr: '' } : { status: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
};

describe('per-profile plists', () => {
  const profile = { id: 'asha', root: '/Users/x/.jobpilot' };
  const home = '/Users/x/.jobpilot/profiles/asha';
  it('label, environment, arguments and log are the profile\'s', () => {
    const x = plistDaily({ node, repo, home, profile });
    expect(profileLabels('asha')).toEqual({ daily: 'com.jobpilot.asha.daily', freelance: 'com.jobpilot.asha.freelance', coverage: 'com.jobpilot.asha.coverage' });
    expect(x).toContain('<string>com.jobpilot.asha.daily</string>');
    expect(x).toContain('<key>JOBPILOT_ROOT</key>\n    <string>/Users/x/.jobpilot</string>');
    expect(x).not.toContain('JOBPILOT_HOME');
    expect(x).toContain('<string>run</string>\n    <string>--if-due</string>\n    <string>--profile</string>\n    <string>asha</string>\n  </array>');
    expect(x).toContain('<string>/Users/x/.jobpilot/profiles/asha/logs/daily.log</string>');
  });
  it('the machine dashboard serves every profile', () => {
    const x = plistDashboardRoot({ node, repo, root: '/Users/x/.jobpilot' });
    expect(x).toContain(`<string>${DASHBOARD_LABEL}</string>`);
    expect(x).toContain('<string>serve</string>\n    <string>--port</string>\n    <string>4317</string>\n  </array>');
    expect(x).not.toContain('--profile');
    expect(x).toContain('<string>/Users/x/.jobpilot/logs/dashboard.log</string>');
  });
  it.skipIf(!existsSync('/usr/bin/plutil'))('every profile plist passes plutil -lint', () => {
    for (const [n, x] of [['d', plistDaily({ node, repo, home, profile })], ['m', plistDashboardRoot({ node, repo, root: '/Users/x/.jobpilot' })]] as const) {
      const f = join(tmp, `${n}.plist`);
      writeFileSync(f, x);
      expect(spawnSync('/usr/bin/plutil', ['-lint', f]).status).toBe(0);
    }
  });
});

describe('install, uninstall, status, run-now for one profile', () => {
  it('install loads the profile\'s three jobs and the machine dashboard, logs under each', () => {
    const root = join(tmp, 'root');
    const home = join(root, 'profiles', 'asha');
    mkdirSync(home, { recursive: true });
    const f = fake();
    const r = installSchedule({ node, repo, home, profile: { id: 'asha', root }, uid: 501, agentsDir: join(tmp, 'agents'), now: new Date('2026-10-14T00:00:00Z') }, f.run);
    expect(r.plists.map((p) => p.split('/').pop())).toEqual(['com.jobpilot.asha.daily.plist', 'com.jobpilot.asha.freelance.plist', 'com.jobpilot.asha.coverage.plist', 'com.jobpilot.dashboard.plist']);
    expect(r.logs).toEqual([join(home, 'logs/daily.log'), join(home, 'logs/freelance.log'), join(home, 'logs/coverage.log'), join(root, 'logs/dashboard.log')]);
    expect(f.calls.filter((c) => c[1] === 'bootstrap').length).toBe(4);
  });
  it('freelance: false leaves the freelance job out', () => {
    const root = join(tmp, 'root');
    const home = join(root, 'profiles', 'lena');
    mkdirSync(home, { recursive: true });
    const r = installSchedule({ node, repo, home, profile: { id: 'lena', root }, uid: 501, agentsDir: join(tmp, 'agents'), freelance: false }, fake().run);
    expect(r.plists.some((p) => p.includes('freelance'))).toBe(false);
  });
  it('uninstall unloads only the profile\'s jobs unless dashboard is asked', () => {
    const f = fake();
    uninstallSchedule({ node, repo, home: '/r/profiles/asha', profile: { id: 'asha', root: '/r' }, uid: 501, agentsDir: join(tmp, 'agents') }, f.run);
    expect(f.calls.map((c) => c[2])).toEqual(['gui/501/com.jobpilot.asha.daily', 'gui/501/com.jobpilot.asha.freelance', 'gui/501/com.jobpilot.asha.coverage']);
  });
  it('status and run-now use the profile labels', () => {
    const f = fake();
    expect(scheduleStatus({ node, repo, home: '/r/profiles/asha', profile: { id: 'asha', root: '/r' }, uid: 501 }, f.run).map((s) => s.label)).toEqual(['com.jobpilot.asha.daily', 'com.jobpilot.asha.freelance', 'com.jobpilot.asha.coverage', DASHBOARD_LABEL]);
    runNow({ uid: 501, profile: 'asha', coverage: true }, f.run);
    expect(f.calls.at(-1)).toEqual(['launchctl', 'kickstart', 'gui/501/com.jobpilot.asha.coverage']);
  });
});
