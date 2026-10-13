import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setWarningSink } from '../../src/app/home.js';
import { FREELANCE_DUE } from '../../src/app/due.js';
import { withLock } from '../../src/app/lock.js';
import { runWithDue } from '../../src/app/run-command.js';
import {
  COVERAGE_LABEL, DAILY_LABEL, DASHBOARD_LABEL, FREELANCE_LABEL, escapeXml, plistCoverage, plistFreelance, installSchedule, nextRunIst, plistDaily, plistDashboard,
  runNow, scheduleStatus, uninstallSchedule, type Runner,
} from '../../src/app/schedule.js';

const base = { node: '/opt/homebrew/Cellar/node/24.15.0/bin/node', repo: '/Users/x/jobpilot', home: '/Users/x/.jobpilot' };

/** sha256 of each pre-coverage plist for `base`, taken from the commit before the coverage job existed. */
const PLIST_SHA = { daily: '6813955e33db59be47622c10778b4ece3a8818a683fd022c438f8a501ea874e2', freelance: 'e3a01cddfa244e8724a07d5a9a3a2a4cb3e73f405f31f7498e94d22bd125b013', dashboard: '46b4a5c90176dce5164c4db14de097f814b3d3288f6444541a6e9b0d12773535' };

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jobpilot-sched-'));
});
afterEach(() => {
  setWarningSink(undefined);
  rmSync(tmp, { recursive: true, force: true });
});

function fake(replies: Record<string, { status: number; stdout?: string; stderr?: string }> = {}) {
  const calls: string[][] = [];
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = args[0] ?? '';
    const r = replies[key] ?? (key === '--version' ? { status: 0, stdout: 'v24.15.0\n' } : { status: 0 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { calls, run };
}

describe('plist text', () => {
  it('daily plist has the exact keys', () => {
    const x = plistDaily(base);
    expect(x).toContain(`<key>Label</key>\n  <string>${DAILY_LABEL}</string>`);
    expect(x).toMatch(/<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/homebrew\/Cellar\/node\/24\.15\.0\/bin\/node<\/string>\s*<string>--import<\/string>\s*<string>tsx<\/string>\s*<string>\/Users\/x\/jobpilot\/src\/bin\.ts<\/string>\s*<string>run<\/string>\s*<string>--if-due<\/string>\s*<\/array>/);
    expect(x).toContain('<key>WorkingDirectory</key>\n  <string>/Users/x/jobpilot</string>');
    for (const [k, v] of [['JOBPILOT_HOME', '/Users/x/.jobpilot'], ['PATH', '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'], ['TZ', 'Asia/Kolkata'], ['LANG', 'en_US.UTF-8']]) {
      expect(x).toContain(`<key>${k}</key>\n    <string>${v}</string>`);
    }
    // every :00 and :30 and at load: the due check (app/due.ts) decides, so a slot missed in sleep loses no day
    expect(x).toMatch(/<key>StartCalendarInterval<\/key>\s*<array>\s*<dict>\s*<key>Minute<\/key>\s*<integer>0<\/integer>\s*<\/dict>\s*<dict>\s*<key>Minute<\/key>\s*<integer>30<\/integer>\s*<\/dict>\s*<\/array>/);
    expect(x).not.toContain('<key>Hour</key>');
    expect(x).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(x).toMatch(/<key>ProcessType<\/key>\s*<string>Background<\/string>/);
    expect(x).toMatch(/<key>LowPriorityIO<\/key>\s*<true\/>/);
    expect(x).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>\d+<\/integer>/);
    expect(x).toContain('<string>/Users/x/.jobpilot/logs/daily.log</string>');
    expect(x.match(/\/Users\/x\/\.jobpilot\/logs\/daily\.log/g)).toHaveLength(2);
    expect(x).not.toContain('KeepAlive');
  });

  it('freelance plist runs run-freelance --if-due at load and every :00 and :30, logging to freelance.log', () => {
    const x = plistFreelance(base);
    expect(FREELANCE_LABEL).toBe('com.jobpilot.freelance');
    expect(x).toContain(`<key>Label</key>\n  <string>${FREELANCE_LABEL}</string>`);
    expect(x).toMatch(/<string>\/Users\/x\/jobpilot\/src\/bin\.ts<\/string>\s*<string>run-freelance<\/string>\s*<string>--if-due<\/string>\s*<\/array>/);
    expect(x).toMatch(/<key>StartCalendarInterval<\/key>\s*<array>\s*<dict>\s*<key>Minute<\/key>\s*<integer>0<\/integer>\s*<\/dict>\s*<dict>\s*<key>Minute<\/key>\s*<integer>30<\/integer>\s*<\/dict>\s*<\/array>/);
    expect(x).not.toContain('<key>Hour</key>');
    expect(x).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(x).toMatch(/<key>ProcessType<\/key>\s*<string>Background<\/string>/);
    expect(x).toMatch(/<key>LowPriorityIO<\/key>\s*<true\/>/);
    expect(x).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>\d+<\/integer>/);
    expect(x).toContain('<key>TZ</key>\n    <string>Asia/Kolkata</string>');
    expect(x.match(/\/Users\/x\/\.jobpilot\/logs\/freelance\.log/g)).toHaveLength(2);
    expect(x).not.toContain('daily.log');
    expect(x).not.toContain('KeepAlive');
  });

  it('coverage plist runs run-coverage --if-due at load and every :00 and :30, logging to coverage.log', () => {
    const x = plistCoverage(base);
    expect(COVERAGE_LABEL).toBe('com.jobpilot.coverage');
    expect(x).toContain(`<key>Label</key>\n  <string>${COVERAGE_LABEL}</string>`);
    expect(x).toMatch(/<string>\/Users\/x\/jobpilot\/src\/bin\.ts<\/string>\s*<string>run-coverage<\/string>\s*<string>--if-due<\/string>\s*<\/array>/);
    expect(x).toMatch(/<key>StartCalendarInterval<\/key>\s*<array>\s*<dict>\s*<key>Minute<\/key>\s*<integer>0<\/integer>\s*<\/dict>\s*<dict>\s*<key>Minute<\/key>\s*<integer>30<\/integer>\s*<\/dict>\s*<\/array>/);
    expect(x).not.toContain('<key>Hour</key>');
    expect(x).not.toContain('<key>Weekday</key>');
    expect(x).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(x.match(/\/Users\/x\/\.jobpilot\/logs\/coverage\.log/g)).toHaveLength(2);
    expect(x).not.toContain('KeepAlive');
    // the other jobs differ from the coverage one only in label, command and log
    expect(x.replace('com.jobpilot.coverage', 'com.jobpilot.freelance').replace('run-coverage', 'run-freelance').replaceAll('coverage.log', 'freelance.log')).toBe(plistFreelance(base));
  });

  it('daily, freelance and dashboard plists are byte-identical to their pre-coverage output', () => {
    const sha = (x: string): string => createHash('sha256').update(x).digest('hex');
    expect(sha(plistDaily(base))).toBe(PLIST_SHA.daily);
    expect(sha(plistFreelance(base))).toBe(PLIST_SHA.freelance);
    expect(sha(plistDashboard(base))).toBe(PLIST_SHA.dashboard);
  });

  it('dashboard plist serves, runs at load and keeps alive', () => {
    const x = plistDashboard(base);
    expect(x).toContain(`<string>${DASHBOARD_LABEL}</string>`);
    expect(x).toMatch(/<string>serve<\/string>\s*<string>--port<\/string>\s*<string>4317<\/string>/);
    expect(x).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(x).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(x).not.toContain('StartCalendarInterval');
    expect(x).toContain('/logs/dashboard.log');
  });

  it('escapes XML in every value', () => {
    expect(escapeXml(`a&b<c>"d'`)).toBe('a&amp;b&lt;c&gt;&quot;d&apos;');
    const x = plistDaily({ ...base, repo: '/Users/a&b/<repo>' });
    expect(x).toContain('/Users/a&amp;b/&lt;repo&gt;/src/bin.ts');
    expect(x).not.toContain('a&b');
  });

  const hasPlutil = spawnSync('/bin/sh', ['-c', 'command -v plutil']).status === 0;
  it.skipIf(!hasPlutil)('is valid per plutil', () => {
    for (const x of [plistDaily(base), plistFreelance(base), plistCoverage(base), plistDashboard(base)]) {
      const r = spawnSync('plutil', ['-lint', '-'], { input: x, encoding: 'utf8' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }
  });

  it('rejects relative paths', () => {
    expect(() => plistDaily({ ...base, repo: 'rel' })).toThrow(/absolute/);
  });
});

describe('time zone', () => {
  it('next run is the next 07:00 IST instant', () => {
    expect(nextRunIst(new Date('2026-10-09T01:29:00Z'), 7, 0)).toBe('2026-10-09 07:00 IST');
    expect(nextRunIst(new Date('2026-10-09T01:31:00Z'), 7, 0)).toBe('2026-10-10 07:00 IST');
  });
});

describe('install / uninstall / status', () => {
  const opts = () => ({ ...base, home: join(tmp, 'home'), agentsDir: join(tmp, 'LaunchAgents'), uid: 501, now: new Date('2026-10-09T00:00:00Z') });

  it('refuses node below 24 and writes nothing', () => {
    const f = fake({ '--version': { status: 0, stdout: 'v20.19.0\n' } });
    expect(() => installSchedule(opts(), f.run)).toThrow(/24/);
    expect(f.calls).toEqual([[base.node, '--version']]);
    expect(existsSync(join(tmp, 'LaunchAgents'))).toBe(false);
  });

  it('writes 0644 plists, 0600 logs in a 0700 dir, then bootout, bootstrap, enable per job', () => {
    const f = fake({ bootout: { status: 3, stderr: 'Boot-out failed: 3: No such process' } });
    const o = opts();
    const r = installSchedule(o, f.run);
    const d = join(o.agentsDir, `${DAILY_LABEL}.plist`);
    const s = join(o.agentsDir, `${DASHBOARD_LABEL}.plist`);
    const fl = join(o.agentsDir, `${FREELANCE_LABEL}.plist`);
    const cv = join(o.agentsDir, `${COVERAGE_LABEL}.plist`);
    for (const p of [d, fl, cv, s]) expect(statSync(p).mode & 0o777).toBe(0o644);
    expect(statSync(join(o.home, 'logs')).mode & 0o777).toBe(0o700);
    for (const n of ['daily.log', 'freelance.log', 'coverage.log', 'dashboard.log']) expect(statSync(join(o.home, 'logs', n)).mode & 0o777).toBe(0o600);
    expect(f.calls).toEqual([
      [base.node, '--version'],
      ['launchctl', 'bootout', 'gui/501', d], ['launchctl', 'bootstrap', 'gui/501', d], ['launchctl', 'enable', `gui/501/${DAILY_LABEL}`],
      ['launchctl', 'bootout', 'gui/501', fl], ['launchctl', 'bootstrap', 'gui/501', fl], ['launchctl', 'enable', `gui/501/${FREELANCE_LABEL}`],
      ['launchctl', 'bootout', 'gui/501', cv], ['launchctl', 'bootstrap', 'gui/501', cv], ['launchctl', 'enable', `gui/501/${COVERAGE_LABEL}`],
      ['launchctl', 'bootout', 'gui/501', s], ['launchctl', 'bootstrap', 'gui/501', s], ['launchctl', 'enable', `gui/501/${DASHBOARD_LABEL}`],
    ]);
    expect(readFileSync(cv, 'utf8')).toContain('<string>run-coverage</string>');
    expect(r.nextRun).toBe('2026-10-09 07:00 IST');
    expect(readFileSync(d, 'utf8')).toContain('<string>--if-due</string>');
  });

  it('never chmods an existing home (one warning), tightens an existing logs dir and log files', () => {
    const warnings: string[] = [];
    setWarningSink((m) => warnings.push(m));
    const o = opts();
    mkdirSync(join(o.home, 'logs'), { recursive: true });
    chmodSync(o.home, 0o755);
    chmodSync(join(o.home, 'logs'), 0o755);
    writeFileSync(join(o.home, 'logs', 'daily.log'), 'old\n', { mode: 0o644 });
    chmodSync(join(o.home, 'logs', 'daily.log'), 0o644);
    installSchedule(o, fake().run);
    installSchedule(o, fake().run);
    expect(statSync(o.home).mode & 0o777).toBe(0o755);
    expect(warnings.filter((w) => w.includes('JOBPILOT_HOME'))).toHaveLength(1);
    expect(statSync(join(o.home, 'logs')).mode & 0o777).toBe(0o700);
    expect(statSync(join(o.home, 'logs', 'daily.log')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(o.home, 'logs', 'daily.log'), 'utf8')).toBe('old\n');
  });

  it('warns about a symlinked logs dir and leaves it untouched', () => {
    const warnings: string[] = [];
    setWarningSink((m) => warnings.push(m));
    const o = opts();
    const target = join(tmp, 'elsewhere');
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    mkdirSync(o.home, { mode: 0o700 });
    symlinkSync(target, join(o.home, 'logs'));
    installSchedule(o, fake().run);
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(warnings.some((w) => w.includes('elsewhere'))).toBe(true);
  });

  it('fails loudly when bootstrap fails', () => {
    const f = fake({ bootstrap: { status: 5, stderr: 'Bootstrap failed: 5: Input/output error' } });
    expect(() => installSchedule(opts(), f.run)).toThrow(/bootstrap.*Input\/output/s);
  });

  it('uninstall boots out then deletes', () => {
    const o = opts();
    installSchedule(o, fake().run);
    const f = fake();
    uninstallSchedule(o, f.run);
    expect(f.calls).toEqual([['launchctl', 'bootout', `gui/501/${DAILY_LABEL}`], ['launchctl', 'bootout', `gui/501/${FREELANCE_LABEL}`], ['launchctl', 'bootout', `gui/501/${COVERAGE_LABEL}`], ['launchctl', 'bootout', `gui/501/${DASHBOARD_LABEL}`]]);
    expect(existsSync(join(o.agentsDir, `${COVERAGE_LABEL}.plist`))).toBe(false);
    expect(existsSync(join(o.agentsDir, `${FREELANCE_LABEL}.plist`))).toBe(false);
    expect(existsSync(join(o.agentsDir, `${DAILY_LABEL}.plist`))).toBe(false);
    expect(existsSync(join(o.agentsDir, `${DASHBOARD_LABEL}.plist`))).toBe(false);
    expect(() => uninstallSchedule(o, fake({ bootout: { status: 3 } }).run)).not.toThrow();
    installSchedule(o, fake().run);
    expect(() => uninstallSchedule(o, fake({ bootout: { status: 5, stderr: 'Input/output error' } }).run)).toThrow(/bootout/);
    expect(existsSync(join(o.agentsDir, `${DAILY_LABEL}.plist`))).toBe(true);
  });

  it('status parses state and last exit code, and reports not loaded', () => {
    const o = opts();
    const print = `${DAILY_LABEL} = {\n\tactive count = 0\n\tstate = not running\n\n\tenvironment = {\n\t\tTZ => Asia/Kolkata\n\t}\n\truns = 3\n\tlast exit code = 0\n}\n`;
    const f = fake({ print: { status: 0, stdout: print } });
    const st = scheduleStatus(o, f.run);
    expect(st[0]).toMatchObject({ label: DAILY_LABEL, loaded: true, state: 'not running', lastExitCode: 0 });
    expect(st[0]?.logPath).toBe(join(o.home, 'logs', 'daily.log'));
    expect(st[0]?.plistPath).toBe(join(o.agentsDir, `${DAILY_LABEL}.plist`));
    expect(f.calls[0]).toEqual(['launchctl', 'print', `gui/501/${DAILY_LABEL}`]);
    const never = scheduleStatus(o, fake({ print: { status: 0, stdout: '\tstate = running\n\tlast exit code = (never exited)\n' } }).run);
    expect(never[0]).toMatchObject({ state: 'running', lastExitCode: null });
    const none = scheduleStatus(o, fake({ print: { status: 113, stderr: 'Could not find service' } }).run);
    expect(none.every((s) => !s.loaded && s.state === null)).toBe(true);
    expect(none.map((s) => s.label)).toEqual([DAILY_LABEL, FREELANCE_LABEL, COVERAGE_LABEL, DASHBOARD_LABEL]);
    expect(none).toHaveLength(4);
    expect(none[2]?.logPath).toBe(join(o.home, 'logs', 'coverage.log'));
    expect(none[2]?.plistPath).toBe(join(o.agentsDir, `${COVERAGE_LABEL}.plist`));
    expect(none[1]?.logPath).toBe(join(o.home, 'logs', 'freelance.log'));
    expect(none[1]?.plistPath).toBe(join(o.agentsDir, `${FREELANCE_LABEL}.plist`));
  });

  it('run-now kickstarts the daily job only', () => {
    const f = fake();
    runNow({ uid: 501 }, f.run);
    expect(f.calls).toEqual([['launchctl', 'kickstart', `gui/501/${DAILY_LABEL}`]]);
    const g = fake();
    runNow({ uid: 501, freelance: true }, g.run);
    expect(g.calls).toEqual([['launchctl', 'kickstart', `gui/501/${FREELANCE_LABEL}`]]);
    const c = fake();
    runNow({ uid: 501, coverage: true }, c.run);
    expect(c.calls).toEqual([['launchctl', 'kickstart', `gui/501/${COVERAGE_LABEL}`]]);
    expect(() => runNow({ uid: 501, coverage: true, freelance: true }, fake().run)).toThrow(/not both/);
    expect(() => runNow({ uid: 501, freelance: true }, fake({ kickstart: { status: 113, stderr: 'no service' } }).run)).toThrow(/install/);
    expect(() => runNow({ uid: 501 }, fake({ kickstart: { status: 113, stderr: 'no service' } }).run)).toThrow(/install/);
  });
});

describe('shared lock', () => {
  it('a freelance start while the daily run holds the lock says so and exits 0', async () => {
    const home = join(tmp, 'home');
    mkdirSync(home, { recursive: true });
    const out: string[] = [];
    const deps = { home, clock: { now: () => '2026-10-12T14:30:00.000Z' }, notifier: async () => {}, out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) };
    const code = await withLock(home, 'run', () => runWithDue(FREELANCE_DUE, { ifDue: true, notify: false }, deps, async () => { throw new Error('must not run'); }));
    expect(code).toBe(0);
    expect(out).toEqual([`not due: a jobpilot run is running (pid ${process.pid})`]);
  });
});

describe('scheduledFor: is a pipeline installed on this home (the coverage run yields only to those)', () => {
  it('reads the installed plist\'s JOBPILOT_HOME; another home, a missing plist or an unreadable one is not', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { plistDaily, scheduledFor, DAILY_LABEL, FREELANCE_LABEL } = await import('../../src/app/schedule.js');
    const dir = mkdtempSync(join(tmpdir(), 'jp-agents-'));
    try {
      writeFileSync(join(dir, `${DAILY_LABEL}.plist`), plistDaily({ node: '/usr/bin/node', repo: '/opt/jobpilot', home: '/Users/x/.jobpilot' }));
      expect(scheduledFor(DAILY_LABEL, '/Users/x/.jobpilot', { agentsDir: dir })).toBe(true);
      expect(scheduledFor(DAILY_LABEL, '/tmp/check-home', { agentsDir: dir })).toBe(false);
      expect(scheduledFor(FREELANCE_LABEL, '/Users/x/.jobpilot', { agentsDir: dir })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
