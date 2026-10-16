import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { COVERAGE_START_FILE, coverageNotBefore, DAILY_HOUR_IST } from './due.js';
import { checkHome, fileWarning, warnOnce } from './home.js';
import { homePaths } from './pack/paths.js';
import Database from 'better-sqlite3';

export const DAILY_LABEL = 'com.jobpilot.daily';
export const FREELANCE_LABEL = 'com.jobpilot.freelance';
export const COVERAGE_LABEL = 'com.jobpilot.coverage';
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

export interface ProfileJob {
  readonly id: string;
  readonly root: string;
}
export interface PlistOpts {
  readonly node: string;
  readonly repo: string;
  readonly home: string;
  /** A profile's jobs (profiles spec §3); absent: the legacy single-home jobs, byte-identical to before. */
  readonly profile?: ProfileJob;
}
export const LEGACY_LABELS: readonly string[] = [DAILY_LABEL, FREELANCE_LABEL, COVERAGE_LABEL, DASHBOARD_LABEL];
export const profileLabels = (id: string): { daily: string; freelance: string; coverage: string } => ({
  daily: `com.jobpilot.${id}.daily`,
  freelance: `com.jobpilot.${id}.freelance`,
  coverage: `com.jobpilot.${id}.coverage`,
});

type Kind = 'daily' | 'freelance' | 'coverage';
const LEGACY: Readonly<Record<Kind, string>> = { daily: DAILY_LABEL, freelance: FREELANCE_LABEL, coverage: COVERAGE_LABEL };
const labelOf = (o: { profile?: ProfileJob | undefined }, kind: Kind): string => (o.profile === undefined ? LEGACY[kind] : profileLabels(o.profile.id)[kind]);
const argsOf = (o: { profile?: ProfileJob | undefined }, args: readonly string[]): readonly string[] => (o.profile === undefined ? args : [...args, '--profile', o.profile.id]);

const str = (v: string, pad: string): string => `${pad}<string>${escapeXml(v)}</string>`;
const entry = (k: string, body: string, pad = '  '): string => `${pad}<key>${k}</key>\n${body}`;

function plist(label: string, o: PlistOpts, args: readonly string[], logName: string, extra: string[], logsDir: string = homePaths(o.home).logs): string {
  for (const [n, p] of [['node', o.node], ['repo', o.repo], ['home', o.home]] as const) {
    if (!isAbsolute(p)) throw new Error(`${n} must be an absolute path (got ${p})`);
  }
  if (o.profile !== undefined && !isAbsolute(o.profile.root)) throw new Error(`root must be an absolute path (got ${o.profile.root})`);
  const log = join(logsDir, logName);
  const env = [
    o.profile === undefined ? (['JOBPILOT_HOME', o.home] as const) : (['JOBPILOT_ROOT', o.profile.root] as const),
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

/** Both pipelines start at load and every :00 and :30 of the Mac's clock; `--if-due` decides whether a start does anything. */
function plistDue(label: string, o: PlistOpts, args: readonly string[], logName: string): string {
  const slot = (minute: number): string => `    <dict>\n${entry('Minute', `      <integer>${minute}</integer>`, '      ')}\n    </dict>`;
  return plist(label, o, args, logName, [
    entry('StartCalendarInterval', `  <array>\n${[0, 30].map(slot).join('\n')}\n  </array>`),
    entry('RunAtLoad', '  <true/>'),
    entry('ProcessType', str('Background', '  ')),
    entry('LowPriorityIO', '  <true/>'),
    entry('ExitTimeOut', '  <integer>120</integer>'),
  ]);
}

/**
 * The daily job: `run --if-due` at load (login) and at every :00 and :30 of the Mac's clock. Most starts find nothing
 * owed and exit at once (`app/due.ts`); the first start at or after 07:00 IST, or the first after the Mac wakes from a
 * sleep that spanned it, does the day's run. A single 07:00 calendar slot lost whole days: launchd did not make up a
 * slot missed in sleep (2026-10-11, -12).
 */
export function plistDaily(o: PlistOpts): string {
  return plistDue(labelOf(o, 'daily'), o, argsOf(o, ['run', '--if-due']), 'daily.log');
}

/**
 * The freelance job: `run-freelance --if-due` on the same schedule as the daily one. It is owed from 07:30 and 19:30 IST
 * (`FREELANCE_DUE`), so the first start at or after either, or after a sleep that spanned it, runs that window. It shares
 * the daily job's lock: a start while a daily run is going says so and exits 0.
 */
export function plistFreelance(o: PlistOpts): string {
  return plistDue(labelOf(o, 'freelance'), o, argsOf(o, ['run-freelance', '--if-due']), 'freelance.log');
}

/**
 * The weekly career-site coverage job: `run-coverage --if-due` on the same schedule as the daily one. It is owed from
 * Sunday 06:00 IST and stays owed until it runs, through Saturday (`COVERAGE_DUE`, `coverageWeek`), so a Mac asleep on
 * Sunday runs it on its first start after waking. It shares the daily job's lock.
 */
export function plistCoverage(o: PlistOpts): string {
  return plistDue(labelOf(o, 'coverage'), o, argsOf(o, ['run-coverage', '--if-due']), 'coverage.log');
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

/** The one dashboard of a profiles root: every profile under /p/<id>/ (Task 10); log in <root>/logs. */
export function plistDashboardRoot(o: { node: string; repo: string; root: string }): string {
  return plist(DASHBOARD_LABEL, { node: o.node, repo: o.repo, home: join(o.root, 'profiles', '.dashboard'), profile: { id: '', root: o.root } }, ['serve', '--port', String(DASHBOARD_PORT)], 'dashboard.log', [
    entry('RunAtLoad', '  <true/>'),
    entry('KeepAlive', '  <true/>'),
    entry('ThrottleInterval', '  <integer>30</integer>'),
    entry('ExitTimeOut', '  <integer>30</integer>'),
  ], join(o.root, 'logs'));
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
  /** A profile's freelance job is installed unless false (Task 21 sets false for a non-`IN` residence). */
  readonly freelance?: boolean;
  /** Uninstall: also unload the machine dashboard (always for the legacy jobs; default false for a profile). */
  readonly dashboard?: boolean;
}
export interface InstallOpts extends ScheduleOpts {
  readonly now?: Date;
  /** `--coverage-now`: the weekly coverage run is owed at once (COVERAGE_START_FILE is removed). */
  readonly coverageNow?: boolean;
}

const IST_MS = IST_OFFSET_MINUTES * 60_000;
const WEEK_MS = 7 * 86_400_000;

/** The first Sunday 06:00 IST strictly after `now` (ISO): today's when it is Sunday before 06:00 IST, else the coming one. */
export function firstCoverageFrom(now: Date): string {
  const ist = new Date(now.getTime() + IST_MS);
  const sundayMidnightIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - ist.getUTCDay());
  const thisWeek = sundayMidnightIst + 6 * 3_600_000 - IST_MS;
  return new Date(thisWeek > now.getTime() ? thisWeek : thisWeek + WEEK_MS).toISOString();
}

const istText = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 16).replace('T', ' ') + ' IST';

/**
 * Whether this home has ever recorded a coverage run (its DB has a `jobpilot-coverage` run row). The DB is opened
 * read-only and as it is, never migrated, so install never contends with a running run; a DB that cannot be read
 * that way (no `runs` table yet, busy) counts as "never ran".
 */
function coverageRanOn(home: string): boolean {
  const file = homePaths(home).db;
  if (!existsSync(file)) return false;
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 2_000 });
    return db.prepare(`SELECT 1 FROM runs WHERE pipeline = 'jobpilot-coverage' LIMIT 1`).get() !== undefined;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * I1 (final review): on a home that never ran coverage, the first coverage run is owed from the next Sunday 06:00 IST
 * (COVERAGE_START_FILE), so an install on a weekday never starts a 7-hour run at once; a repeat install keeps the date
 * it wrote. `coverageNow` removes the file: owed at once. Returns the first owed time, or null when owed as usual.
 */
function scheduleFirstCoverage(home: string, now: Date, coverageNow: boolean, ranBefore: () => boolean): string | null {
  const file = join(home, COVERAGE_START_FILE);
  if (coverageNow) {
    rmSync(file, { force: true });
    return null;
  }
  const kept = coverageNotBefore(home);
  if (kept !== undefined) return istText(kept);
  if (ranBefore()) return null;
  const from = firstCoverageFrom(now);
  writeFileSync(file, `${JSON.stringify({ notBefore: from })}\n`, { mode: 0o600 });
  return istText(Date.parse(from));
}

const agentsDirOf = (o: { agentsDir?: string | undefined }): string => o.agentsDir ?? join(homedir(), 'Library', 'LaunchAgents');
const plistPathOf = (o: { agentsDir?: string | undefined }, label: string): string => join(agentsDirOf(o), `${label}.plist`);

const ownedByMe = (uid: number): boolean => process.getuid === undefined || uid === process.getuid();

/**
 * The home is the user's choice: created 0700 only when new, never chmod-ed (an existing one gets the shared warning).
 * `logs/` is jobpilot's own: a real, owned directory is tightened to 0700; a symlink or someone else's gets a warning.
 */
function prepareLogsDir(home: string, logs: string): void {
  if (existsSync(home)) checkHome(home);
  else mkdirSync(home, { recursive: true, mode: 0o700 });
  let st;
  try {
    st = lstatSync(logs);
  } catch {
    mkdirSync(logs, { mode: 0o700 });
    return;
  }
  if (st.isDirectory() && ownedByMe(st.uid)) chmodSync(logs, 0o700);
  else warnOnce(fileWarning(logs));
}

/** Creates the log file 0600; an existing owned regular file is tightened, a symlink or foreign file only warned about. */
function prepareLogFile(file: string): void {
  let st;
  try {
    st = lstatSync(file);
  } catch {
    closeSync(openSync(file, 'a', 0o600));
    return;
  }
  if (st.isFile() && ownedByMe(st.uid)) chmodSync(file, 0o600);
  else warnOnce(fileWarning(file));
}

export interface InstallResult {
  readonly plists: readonly string[];
  readonly logs: readonly string[];
  readonly nextRun: string;
  /** The first time the weekly coverage run is owed (`YYYY-MM-DD 06:00 IST`), or null when it is owed as usual (I1). */
  readonly coverageFrom: string | null;
}

export function installSchedule(o: InstallOpts, run: Runner = realRunner): InstallResult {
  // The binary that goes into the plist is the one that is checked.
  const v = run(o.node, ['--version']);
  const nodeVersion = /^v?(\d+\.\d+\.\d+)/.exec(v.stdout.trim())?.[1];
  if (v.status !== 0 || nodeVersion === undefined) throw new Error(`could not run "${o.node} --version": ${(v.stderr || v.stdout).trim() || `exit ${v.status}`}`);
  if (Number(nodeVersion.split('.')[0]) < 24) throw new Error(`jobpilot needs Node 24 or newer; ${o.node} is ${nodeVersion}. Install it with a Node 24 binary (not the Volta shim) and run again`);
  const now = o.now ?? new Date();
  const jobs: (readonly [string, string, string])[] =
    o.profile === undefined
      ? [[DAILY_LABEL, plistDaily(o), 'daily.log'], [FREELANCE_LABEL, plistFreelance(o), 'freelance.log'], [COVERAGE_LABEL, plistCoverage(o), 'coverage.log'], [DASHBOARD_LABEL, plistDashboard(o), 'dashboard.log']]
      : [
          [labelOf(o, 'daily'), plistDaily(o), 'daily.log'],
          ...(o.freelance === false ? [] : [[labelOf(o, 'freelance'), plistFreelance(o), 'freelance.log'] as const]),
          [labelOf(o, 'coverage'), plistCoverage(o), 'coverage.log'],
          [DASHBOARD_LABEL, plistDashboardRoot({ node: o.node, repo: o.repo, root: o.profile.root }), 'dashboard.log'],
        ];

  const logsDir = homePaths(o.home).logs;
  prepareLogsDir(o.home, logsDir);
  const machineLogs = o.profile === undefined ? undefined : join(o.profile.root, 'logs');
  if (o.profile !== undefined && machineLogs !== undefined) prepareLogsDir(o.profile.root, machineLogs);
  const logs = jobs.map(([label, , n]) => join(machineLogs !== undefined && label === DASHBOARD_LABEL ? machineLogs : logsDir, n));
  for (const l of logs) prepareLogFile(l);
  // before any job is loaded: the coverage job starts at load (RunAtLoad) and must already see the date
  const coverageFrom = scheduleFirstCoverage(o.home, now, o.coverageNow === true, () => coverageRanOn(o.home));
  mkdirSync(agentsDirOf(o), { recursive: true });

  const plists: string[] = [];
  for (const [label, xml] of jobs) {
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
  return { plists, logs, nextRun: nextRunIst(now, DAILY_HOUR_IST, 0), coverageFrom };
}

/** True when a failed bootout only means the job was not loaded. */
const notLoaded = (r: { status: number; stdout: string; stderr: string }): boolean =>
  r.status === 3 || r.status === 113 || /not loaded|no such process|could not find service|not found/i.test(`${r.stderr}\n${r.stdout}`);

export function uninstallSchedule(o: ScheduleOpts, run: Runner = realRunner): string[] {
  const removed: string[] = [];
  const labels = [labelOf(o, 'daily'), labelOf(o, 'freelance'), labelOf(o, 'coverage'), ...(o.profile === undefined || o.dashboard === true ? [DASHBOARD_LABEL] : [])];
  for (const label of labels) {
    const p = plistPathOf(o, label);
    // By label, so a job still loaded after its plist file went missing is unloaded too.
    const r = run('launchctl', ['bootout', `gui/${o.uid}/${label}`]);
    if (r.status !== 0 && !notLoaded(r)) throw new Error(`launchctl bootout ${label} failed (${r.status}): ${(r.stderr || r.stdout).trim()}; the plist was left in place`);
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
  const jobs: (readonly [string, string])[] = [[labelOf(o, 'daily'), 'daily.log'], [labelOf(o, 'freelance'), 'freelance.log'], [labelOf(o, 'coverage'), 'coverage.log'], [DASHBOARD_LABEL, 'dashboard.log']];
  return jobs.map(([label, log]) => {
    const r = run('launchctl', ['print', `gui/${o.uid}/${label}`]);
    const loaded = r.status === 0;
    const state = loaded ? (/^\s*state = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? null) : null;
    const code = loaded ? /^\s*last exit code = (-?\d+)/m.exec(r.stdout)?.[1] : undefined;
    return {
      label: label,
      loaded,
      state,
      lastExitCode: code === undefined ? null : Number(code),
      plistPath: plistPathOf(o, label),
      logPath: join(o.profile !== undefined && label === DASHBOARD_LABEL ? join(o.profile.root, 'logs') : homePaths(o.home).logs, log),
    };
  });
}

/** Start the daily job now, or with `freelance` / `coverage` that job (a manual test of the real scheduled command). */
export function runNow(o: { uid: number; freelance?: boolean; coverage?: boolean; profile?: string | undefined }, run: Runner = realRunner): void {
  if (o.freelance === true && o.coverage === true) throw new Error('run-now starts one job: pass --freelance or --coverage, not both');
  const kind: Kind = o.coverage === true ? 'coverage' : o.freelance === true ? 'freelance' : 'daily';
  const label = o.profile === undefined ? LEGACY[kind] : profileLabels(o.profile)[kind];
  const r = run('launchctl', ['kickstart', `gui/${o.uid}/${label}`]);
  if (r.status !== 0) throw new Error(`launchctl kickstart failed (${r.status}): ${(r.stderr || r.stdout).trim()}. Is the schedule installed? Run "jobpilot schedule install"`);
}

