import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { homePaths } from './pack/paths.js';

export const DAILY_LABEL = 'com.jobpilot.daily';
export const DASHBOARD_LABEL = 'com.jobpilot.dashboard';
const DASHBOARD_PORT = 4317;
const IST_OFFSET_MINUTES = 330;
const LAUNCHD_PATH = '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/** Everything goes through a runner so tests never reach the real launchctl. */
export type Runner = (cmd: string, args: readonly string[]) => { status: number; stdout: string; stderr: string };

export const realRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, [...args], { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : (r.stderr ?? '') };
};

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface PlistOpts {
  readonly node: string;
  readonly repo: string;
  readonly home: string;
}
export interface DailyPlistOpts extends PlistOpts {
  readonly hour: number;
  readonly minute: number;
}

const str = (v: string, pad: string): string => `${pad}<string>${escapeXml(v)}</string>`;
const entry = (k: string, body: string, pad = '  '): string => `${pad}<key>${k}</key>\n${body}`;

function plist(label: string, o: PlistOpts, args: readonly string[], logName: string, extra: string[]): string {
  for (const [n, p] of [['node', o.node], ['repo', o.repo], ['home', o.home]] as const) {
    if (!isAbsolute(p)) throw new Error(`${n} must be an absolute path (got ${p})`);
  }
  const log = join(homePaths(o.home).logs, logName);
  const env = [
    ['JOBPILOT_HOME', o.home],
    ['PATH', LAUNCHD_PATH],
    ['TZ', 'Asia/Kolkata'],
    ['LANG', 'en_US.UTF-8'],
  ] as const;
  const parts = [
    entry('Label', str(label, '  ')),
    entry('ProgramArguments', `  <array>\n${[o.node, '--import', 'tsx', join(o.repo, 'src/bin.ts'), ...args].map((a) => str(a, '    ')).join('\n')}\n  </array>`),
    entry('WorkingDirectory', str(o.repo, '  ')),
    entry('EnvironmentVariables', `  <dict>\n${env.map(([k, v]) => `${entry(k, str(v, '    '), '    ')}`).join('\n')}\n  </dict>`),
    ...extra,
    entry('StandardOutPath', str(log, '  ')),
    entry('StandardErrorPath', str(log, '  ')),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${parts.join('\n')}\n</dict>\n</plist>\n`;
}

/** The daily run. `hour`/`minute` are the Mac's LOCAL clock (launchd has no time zone of its own). */
export function plistDaily(o: DailyPlistOpts): string {
  if (!Number.isInteger(o.hour) || o.hour < 0 || o.hour > 23) throw new Error(`hour must be 0-23 (got ${o.hour})`);
  if (!Number.isInteger(o.minute) || o.minute < 0 || o.minute > 59) throw new Error(`minute must be 0-59 (got ${o.minute})`);
  return plist(DAILY_LABEL, o, ['run'], 'daily.log', [
    entry('StartCalendarInterval', `  <dict>\n${entry('Hour', `    <integer>${o.hour}</integer>`, '    ')}\n${entry('Minute', `    <integer>${o.minute}</integer>`, '    ')}\n  </dict>`),
    entry('RunAtLoad', '  <false/>'),
    entry('ProcessType', str('Background', '  ')),
    entry('LowPriorityIO', '  <true/>'),
    entry('ExitTimeOut', '  <integer>120</integer>'),
  ]);
}

/** The always-on local dashboard (the server itself binds 127.0.0.1). */
export function plistDashboard(o: PlistOpts): string {
  return plist(DASHBOARD_LABEL, o, ['serve', '--port', String(DASHBOARD_PORT)], 'dashboard.log', [
    entry('RunAtLoad', '  <true/>'),
    entry('KeepAlive', '  <true/>'),
    entry('ThrottleInterval', '  <integer>30</integer>'),
    entry('ExitTimeOut', '  <integer>30</integer>'),
  ]);
}

/** The Mac-local clock time that equals `hour:minute` IST, given the Mac's UTC offset in minutes. */
export function istToLocal(hour: number, minute: number, localOffsetMinutes: number): { hour: number; minute: number } {
  const t = (((hour * 60 + minute - IST_OFFSET_MINUTES + localOffsetMinutes) % 1440) + 1440) % 1440;
  return { hour: Math.floor(t / 60), minute: t % 60 };
}

/** The next occurrence of `hour:minute` IST after `now`, as "YYYY-MM-DD HH:MM IST". */
export function nextRunIst(now: Date, hour: number, minute: number): string {
  const shifted = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000); // read with getUTC*: IST wall clock
  let day = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), hour, minute);
  if (day <= shifted.getTime()) day += 86_400_000;
  const d = new Date(day);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} IST`;
}

export interface ScheduleOpts extends PlistOpts {
  readonly uid: number;
  /** Default `~/Library/LaunchAgents`; tests pass a temp dir. */
  readonly agentsDir?: string;
}
export interface InstallOpts extends ScheduleOpts {
  readonly nodeVersion?: string;
  readonly localOffsetMinutes?: number;
  readonly now?: Date;
}

const agentsDirOf = (o: { agentsDir?: string | undefined }): string => o.agentsDir ?? join(homedir(), 'Library', 'LaunchAgents');
const plistPathOf = (o: { agentsDir?: string | undefined }, label: string): string => join(agentsDirOf(o), `${label}.plist`);

function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export interface InstallResult {
  readonly plists: readonly string[];
  readonly logs: readonly string[];
  readonly localTime: { hour: number; minute: number };
  readonly nextRun: string;
}

export function installSchedule(o: InstallOpts, run: Runner = realRunner): InstallResult {
  const nodeVersion = o.nodeVersion ?? process.versions.node;
  if (Number(nodeVersion.split('.')[0]) < 24) throw new Error(`jobpilot needs Node 24 or newer; ${o.node} is ${nodeVersion}. Install it with a Node 24 binary (not the Volta shim) and run again`);
  const now = o.now ?? new Date();
  const offset = o.localOffsetMinutes ?? -now.getTimezoneOffset();
  const localTime = istToLocal(7, 0, offset);
  const daily = plistDaily({ ...o, ...localTime });
  const dash = plistDashboard(o);

  const logsDir = homePaths(o.home).logs;
  mkdirPrivate(o.home);
  mkdirPrivate(logsDir);
  const logs = ['daily.log', 'dashboard.log'].map((n) => join(logsDir, n));
  for (const l of logs) {
    closeSync(openSync(l, 'a', 0o600));
    chmodSync(l, 0o600);
  }
  mkdirSync(agentsDirOf(o), { recursive: true });

  const plists: string[] = [];
  for (const [label, xml] of [[DAILY_LABEL, daily], [DASHBOARD_LABEL, dash]] as const) {
    const p = plistPathOf(o, label);
    writeFileSync(p, xml, { mode: 0o644 });
    chmodSync(p, 0o644); // launchd refuses group- or world-writable plists; the umask must not decide
    plists.push(p);
    const domain = `gui/${o.uid}`;
    run('launchctl', ['bootout', domain, p]); // "not loaded" is the normal first-install answer
    const b = run('launchctl', ['bootstrap', domain, p]);
    if (b.status !== 0) throw new Error(`launchctl bootstrap ${label} failed (${b.status}): ${(b.stderr || b.stdout).trim()}`);
    const e = run('launchctl', ['enable', `${domain}/${label}`]);
    if (e.status !== 0) throw new Error(`launchctl enable ${label} failed (${e.status}): ${(e.stderr || e.stdout).trim()}`);
  }
  return { plists, logs, localTime, nextRun: nextRunIst(now, 7, 0) };
}

export function uninstallSchedule(o: ScheduleOpts, run: Runner = realRunner): string[] {
  const removed: string[] = [];
  for (const label of [DAILY_LABEL, DASHBOARD_LABEL]) {
    const p = plistPathOf(o, label);
    run('launchctl', ['bootout', `gui/${o.uid}`, p]);
    rmSync(p, { force: true });
    removed.push(p);
  }
  return removed;
}

export interface JobStatus {
  readonly label: string;
  readonly loaded: boolean;
  readonly state: string | null;
  readonly lastExitCode: number | null;
  readonly plistPath: string;
  readonly logPath: string;
}

export function scheduleStatus(o: ScheduleOpts, run: Runner = realRunner): JobStatus[] {
  return [[DAILY_LABEL, 'daily.log'], [DASHBOARD_LABEL, 'dashboard.log']].map(([label, log]) => {
    const r = run('launchctl', ['print', `gui/${o.uid}/${label}`]);
    const loaded = r.status === 0;
    const state = loaded ? (/^\s*state = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? null) : null;
    const code = loaded ? /^\s*last exit code = (-?\d+)/m.exec(r.stdout)?.[1] : undefined;
    return {
      label: label as string,
      loaded,
      state,
      lastExitCode: code === undefined ? null : Number(code),
      plistPath: plistPathOf(o, label as string),
      logPath: join(homePaths(o.home).logs, log as string),
    };
  });
}

/** Start the daily job now (a manual test of the real scheduled command). */
export function runNow(o: { uid: number }, run: Runner = realRunner): void {
  const r = run('launchctl', ['kickstart', `gui/${o.uid}/${DAILY_LABEL}`]);
  if (r.status !== 0) throw new Error(`launchctl kickstart failed (${r.status}): ${(r.stderr || r.stdout).trim()}. Is the schedule installed? Run "jobpilot schedule install"`);
}
