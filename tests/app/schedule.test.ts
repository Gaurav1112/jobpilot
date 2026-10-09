import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DAILY_LABEL, DASHBOARD_LABEL, escapeXml, installSchedule, istToLocal, nextRunIst, plistDaily, plistDashboard,
  runNow, scheduleStatus, uninstallSchedule, type Runner,
} from '../../src/app/schedule.js';

const base = { node: '/opt/homebrew/Cellar/node/24.15.0/bin/node', repo: '/Users/x/jobpilot', home: '/Users/x/.jobpilot' };

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jobpilot-sched-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function fake(replies: Record<string, { status: number; stdout?: string; stderr?: string }> = {}) {
  const calls: string[][] = [];
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = args[0] ?? '';
    const r = replies[key] ?? { status: 0 };
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { calls, run };
}

describe('plist text', () => {
  it('daily plist has the exact keys', () => {
    const x = plistDaily({ ...base, hour: 7, minute: 0 });
    expect(x).toContain(`<key>Label</key>\n  <string>${DAILY_LABEL}</string>`);
    expect(x).toMatch(/<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/homebrew\/Cellar\/node\/24\.15\.0\/bin\/node<\/string>\s*<string>--import<\/string>\s*<string>tsx<\/string>\s*<string>\/Users\/x\/jobpilot\/src\/bin\.ts<\/string>\s*<string>run<\/string>\s*<\/array>/);
    expect(x).toContain('<key>WorkingDirectory</key>\n  <string>/Users/x/jobpilot</string>');
    for (const [k, v] of [['JOBPILOT_HOME', '/Users/x/.jobpilot'], ['PATH', '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'], ['TZ', 'Asia/Kolkata'], ['LANG', 'en_US.UTF-8']]) {
      expect(x).toContain(`<key>${k}</key>\n    <string>${v}</string>`);
    }
    expect(x).toMatch(/<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>7<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>/);
    expect(x).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(x).toMatch(/<key>ProcessType<\/key>\s*<string>Background<\/string>/);
    expect(x).toMatch(/<key>LowPriorityIO<\/key>\s*<true\/>/);
    expect(x).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>\d+<\/integer>/);
    expect(x).toContain('<string>/Users/x/.jobpilot/logs/daily.log</string>');
    expect(x.match(/\/Users\/x\/\.jobpilot\/logs\/daily\.log/g)).toHaveLength(2);
    expect(x).not.toContain('KeepAlive');
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
    const x = plistDaily({ ...base, repo: '/Users/a&b/<repo>', hour: 7, minute: 0 });
    expect(x).toContain('/Users/a&amp;b/&lt;repo&gt;/src/bin.ts');
    expect(x).not.toContain('a&b');
  });

  it('is valid per plutil when available', () => {
    const f = join(tmp, 'p.plist');
    const w = spawnSync('/bin/sh', ['-c', 'command -v plutil']);
    if (w.status !== 0) return;
    for (const x of [plistDaily({ ...base, hour: 7, minute: 0 }), plistDashboard(base)]) {
      const r = spawnSync('plutil', ['-lint', '-'], { input: x, encoding: 'utf8' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }
    void f;
  });

  it('rejects relative paths and bad times', () => {
    expect(() => plistDaily({ ...base, repo: 'rel', hour: 7, minute: 0 })).toThrow(/absolute/);
    expect(() => plistDaily({ ...base, hour: 24, minute: 0 })).toThrow(/hour/);
    expect(() => plistDaily({ ...base, hour: 7, minute: 60 })).toThrow(/minute/);
  });
});

describe('time zone', () => {
  it('maps 07:00 IST to the local clock', () => {
    expect(istToLocal(7, 0, 330)).toEqual({ hour: 7, minute: 0 });
    expect(istToLocal(7, 0, 0)).toEqual({ hour: 1, minute: 30 });
    expect(istToLocal(7, 0, -300)).toEqual({ hour: 20, minute: 30 });
    expect(istToLocal(7, 0, 540)).toEqual({ hour: 10, minute: 30 });
  });
  it('next run is the next 07:00 IST instant', () => {
    expect(nextRunIst(new Date('2026-10-09T01:29:00Z'), 7, 0)).toBe('2026-10-09 07:00 IST');
    expect(nextRunIst(new Date('2026-10-09T01:31:00Z'), 7, 0)).toBe('2026-10-10 07:00 IST');
  });
});

describe('install / uninstall / status', () => {
  const opts = () => ({ ...base, home: join(tmp, 'home'), agentsDir: join(tmp, 'LaunchAgents'), uid: 501, nodeVersion: '24.15.0', localOffsetMinutes: 330, now: new Date('2026-10-09T00:00:00Z') });

  it('refuses node below 24 and writes nothing', () => {
    const f = fake();
    expect(() => installSchedule({ ...opts(), nodeVersion: '20.19.0' }, f.run)).toThrow(/24/);
    expect(f.calls).toEqual([]);
    expect(existsSync(join(tmp, 'LaunchAgents'))).toBe(false);
  });

  it('writes 0644 plists, 0600 logs in a 0700 dir, then bootout, bootstrap, enable per job', () => {
    const f = fake({ bootout: { status: 3, stderr: 'Boot-out failed: 3: No such process' } });
    const o = opts();
    const r = installSchedule(o, f.run);
    const d = join(o.agentsDir, `${DAILY_LABEL}.plist`);
    const s = join(o.agentsDir, `${DASHBOARD_LABEL}.plist`);
    for (const p of [d, s]) expect(statSync(p).mode & 0o777).toBe(0o644);
    expect(statSync(join(o.home, 'logs')).mode & 0o777).toBe(0o700);
    for (const n of ['daily.log', 'dashboard.log']) expect(statSync(join(o.home, 'logs', n)).mode & 0o777).toBe(0o600);
    expect(f.calls).toEqual([
      ['launchctl', 'bootout', 'gui/501', d], ['launchctl', 'bootstrap', 'gui/501', d], ['launchctl', 'enable', `gui/501/${DAILY_LABEL}`],
      ['launchctl', 'bootout', 'gui/501', s], ['launchctl', 'bootstrap', 'gui/501', s], ['launchctl', 'enable', `gui/501/${DASHBOARD_LABEL}`],
    ]);
    expect(r.nextRun).toBe('2026-10-09 07:00 IST');
    expect(readFileSync(d, 'utf8')).toContain('<integer>7</integer>');
  });

  it('uses the local hour that equals 07:00 IST on a non-IST Mac', () => {
    const f = fake();
    const o = { ...opts(), localOffsetMinutes: 0 };
    const r = installSchedule(o, f.run);
    const x = readFileSync(join(o.agentsDir, `${DAILY_LABEL}.plist`), 'utf8');
    expect(x).toMatch(/<key>Hour<\/key>\s*<integer>1<\/integer>\s*<key>Minute<\/key>\s*<integer>30<\/integer>/);
    expect(r.localTime).toEqual({ hour: 1, minute: 30 });
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
    expect(f.calls.map((c) => c[1])).toEqual(['bootout', 'bootout']);
    expect(existsSync(join(o.agentsDir, `${DAILY_LABEL}.plist`))).toBe(false);
    expect(existsSync(join(o.agentsDir, `${DASHBOARD_LABEL}.plist`))).toBe(false);
    expect(() => uninstallSchedule(o, fake({ bootout: { status: 3 } }).run)).not.toThrow();
  });

  it('status parses state and last exit code, and reports not loaded', () => {
    const o = opts();
    const print = '\tstate = not running\n\tlast exit code = 0\n\truns = 3\n';
    const f = fake({ print: { status: 0, stdout: print } });
    const st = scheduleStatus(o, f.run);
    expect(st[0]).toMatchObject({ label: DAILY_LABEL, loaded: true, state: 'not running', lastExitCode: 0 });
    expect(st[0]?.logPath).toBe(join(o.home, 'logs', 'daily.log'));
    expect(st[0]?.plistPath).toBe(join(o.agentsDir, `${DAILY_LABEL}.plist`));
    expect(f.calls[0]).toEqual(['launchctl', 'print', `gui/501/${DAILY_LABEL}`]);
    const none = scheduleStatus(o, fake({ print: { status: 113, stderr: 'Could not find service' } }).run);
    expect(none.every((s) => !s.loaded && s.state === null)).toBe(true);
  });

  it('run-now kickstarts the daily job only', () => {
    const f = fake();
    runNow({ uid: 501 }, f.run);
    expect(f.calls).toEqual([['launchctl', 'kickstart', `gui/501/${DAILY_LABEL}`]]);
    expect(() => runNow({ uid: 501 }, fake({ kickstart: { status: 113, stderr: 'no service' } }).run)).toThrow(/install/);
  });
});
