import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveHolder } from './lock.js';
import { homePaths } from './pack/paths.js';
import { istDate } from './run.js';
import { AppStore } from './store/app-store.js';

/**
 * When the daily run is owed (`jobpilot run --if-due`). launchd starts the daily job at load and every half hour, and
 * this decides whether that start does anything, so a Mac asleep at 07:00 IST runs on its first start after waking
 * instead of skipping the day (launchd's own catch-up of a missed calendar slot did not fire on 2026-10-11 or -12).
 *
 * Attempts are kept in `<home>/daily-attempts.json`, not in the DB, so a DB that cannot be opened (corrupt, or a
 * schema newer than the checked-out code) is still counted and capped instead of notifying every half hour.
 */

/** The hour (IST) from which a day's run is owed. */
export const DAILY_HOUR_IST = 7;
/** A failed or crashed attempt is retried at most until this many failed today … */
export const MAX_FAILED_ATTEMPTS = 3;
/** … and no sooner than this after the previous one. */
const RETRY_AFTER_MS = 60 * 60_000;
export const ATTEMPTS_FILE = 'daily-attempts.json';

const IST_OFFSET_MS = 330 * 60_000;

export type Outcome = 'started' | 'done' | 'failed';
export interface Attempt {
  readonly at: string;
  readonly outcome: Outcome;
}
interface AttemptsFile {
  readonly date: string;
  readonly attempts: readonly Attempt[];
  /** Whether the "gave up for today" notification was posted. */
  readonly alerted?: boolean;
}

export interface DueInput {
  readonly now: string;
  /** Whether a `daily-<today>` run (any ordinal) completed. */
  readonly completedToday: boolean;
  /** Whether one started and has not completed (a crashed run: the next run resumes it, or starts `-n`). */
  readonly startedToday?: boolean;
  /** Today's attempts that failed (exit 2) or crashed (started, never finished, no live holder), ISO times. */
  readonly failuresToday: readonly string[];
}
export interface Due {
  readonly due: boolean;
  readonly reason: string;
  /** Set when today's failures reached the cap. */
  readonly capped?: true;
}

/** One pipeline's schedule: the windows of the IST day in which a run is owed, and where its bookkeeping lives. */
export interface DueSpec {
  readonly pipeline: 'daily' | 'freelance';
  /** Ascending by `fromIst` ("HH:MM"). `id` is '' for a pipeline with one window a day, else the run-id suffix. */
  readonly windows: readonly { fromIst: string; id: string }[];
  /** File under the jobpilot home holding this pipeline's attempts, keyed by IST date plus window. */
  readonly attemptsFile: string;
  /** Run ids are `<runPrefix><IST date>[-<window id>][-<ordinal>]`. */
  readonly runPrefix: string;
}
export const DAILY_DUE: DueSpec = { pipeline: 'daily', windows: [{ fromIst: '07:00', id: '' }], attemptsFile: ATTEMPTS_FILE, runPrefix: 'daily-' };
export const FREELANCE_DUE: DueSpec = {
  pipeline: 'freelance',
  windows: [
    { fromIst: '07:30', id: 'am' },
    { fromIst: '19:30', id: 'pm' },
  ],
  attemptsFile: 'freelance-attempts.json',
  runPrefix: 'freelance-',
};

const istClock = (ms: number): string => new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);
const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

interface Wording {
  readonly from: string;
  /** "today" (daily) or "this <id> window" — the span the cap and completion are counted over. */
  readonly span: string;
  /** "today's run" or "the <id> window's run". */
  readonly run: string;
}

function decide(i: DueInput, startOfWindow: number, w: Wording): Due {
  const t = Date.parse(i.now);
  if (t < startOfWindow) return { due: false, reason: `before ${w.from} IST` };
  if (i.completedToday) return { due: false, reason: `${w.run} completed` };
  const n = i.failuresToday.length;
  if (n >= MAX_FAILED_ATTEMPTS) return { due: false, capped: true, reason: `${n} attempts failed ${w.span}; run "jobpilot run" by hand after fixing the cause` };
  const last = Math.max(...i.failuresToday.map((f) => Date.parse(f)));
  if (n > 0 && t < last + RETRY_AFTER_MS) {
    return { due: false, reason: `the last attempt failed at ${istClock(last)} IST; retrying from ${istClock(last + RETRY_AFTER_MS)} IST` };
  }
  if (n > 0) return { due: true, reason: `retry ${n + 1} of ${MAX_FAILED_ATTEMPTS}` };
  return { due: true, reason: i.startedToday === true ? `${w.run} started and did not complete; this start continues it` : `${w.run} has not run` };
}

const startOfIstDay = (now: string): number => Date.parse(`${istDate(now)}T00:00:00Z`) - IST_OFFSET_MS;

/** The daily rule, pure. */
export function isDue(i: DueInput): Due {
  const from = DAILY_DUE.windows[0]!.fromIst;
  return decide(i, startOfIstDay(i.now) + minutesOf(from) * 60_000, { from, span: 'today', run: "today's run" });
}

/** The window of `spec` in force at `now` (the latest whose start has passed), or undefined before the first. */
function currentWindow(spec: DueSpec, now: string): { fromIst: string; id: string } | undefined {
  const sinceMidnight = (Date.parse(now) - startOfIstDay(now)) / 60_000;
  return [...spec.windows].reverse().find((w) => minutesOf(w.fromIst) <= sinceMidnight);
}

/** The attempts-file key of `now`'s window: the IST date, plus `-<window id>` when the window has one. */
const keyOf = (now: string, window: string): string => (window === '' ? istDate(now) : `${istDate(now)}-${window}`);

/** Attempts of `spec`'s window in force at `now`; another window's or day's, a missing or a corrupt file reads as empty. */
function readFile(spec: DueSpec, home: string, key: string): AttemptsFile {
  try {
    const v = JSON.parse(readFileSync(join(home, spec.attemptsFile), 'utf8')) as Partial<AttemptsFile>;
    if (v.date !== key || !Array.isArray(v.attempts)) return { date: key, attempts: [] };
    const attempts = v.attempts.filter(
      (a): a is Attempt => typeof a?.at === 'string' && !Number.isNaN(Date.parse(a.at)) && ['started', 'done', 'failed'].includes(a.outcome as string),
    );
    return { date: key, attempts, ...(v.alerted === true ? { alerted: true } : {}) };
  } catch {
    return { date: key, attempts: [] };
  }
}

function writeFile(spec: DueSpec, home: string, f: AttemptsFile): void {
  const path = join(home, spec.attemptsFile);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Key of the window `spec` has at `now`; before the first window, the id of the first (nothing is owed then anyway). */
const windowId = (spec: DueSpec, now: string): string => (currentWindow(spec, now) ?? spec.windows[0]!).id;
const read = (spec: DueSpec, home: string, now: string): AttemptsFile => readFile(spec, home, keyOf(now, windowId(spec, now)));

/** Failed attempts, plus started ones that never finished: crashed, since the caller has ruled out a live holder. */
const failuresOf = (f: AttemptsFile): string[] => f.attempts.filter((a) => a.outcome !== 'done').map((a) => a.at);

/**
 * Attempt bookkeeping of one pipeline, over the window in force at `now`. `attemptsFor(DAILY_DUE)` is what the
 * module-level `startAttempt` / `finishAttempt` / `alerted` / `markAlerted` use.
 */
export function attemptsFor(spec: DueSpec) {
  return {
    /** Records the start of an attempt (under the lock); returns its index for `finish`. */
    start(home: string, now: string): number {
      const f = read(spec, home, now);
      writeFile(spec, home, { ...f, attempts: [...f.attempts, { at: now, outcome: 'started' }] });
      return f.attempts.length;
    },
    /** Sets the outcome of attempt `index` of `now`'s window; with no index (it failed before starting), appends one. */
    finish(home: string, now: string, outcome: 'done' | 'failed', index?: number): void {
      const f = read(spec, home, now);
      const attempts = [...f.attempts];
      if (index !== undefined && attempts[index] !== undefined) attempts[index] = { at: attempts[index].at, outcome };
      else attempts.push({ at: now, outcome });
      writeFile(spec, home, { ...f, attempts });
    },
    /** Whether this window's give-up notification was posted. */
    alerted: (home: string, now: string): boolean => read(spec, home, now).alerted === true,
    markAlerted(home: string, now: string): void {
      writeFile(spec, home, { ...read(spec, home, now), alerted: true });
    },
  };
}

const daily = attemptsFor(DAILY_DUE);
export const startAttempt = daily.start;
export const finishAttempt = daily.finish;
export const alerted = daily.alerted;
export const markAlerted = daily.markAlerted;

/** Runs of `spec` in the window `prefix` (`<runPrefix><date>[-<window>]`), any ordinal (`prefix` or `prefix-<digits>`). */
function runsIn(app: AppStore, prefix: string): { completed: boolean; started: boolean } {
  const rows = (
    app.kernel.db.prepare(`SELECT run_id, status FROM runs WHERE run_id = ? OR substr(run_id, 1, ?) = ?`).all(prefix, prefix.length + 1, `${prefix}-`) as {
      run_id: string;
      status: string;
    }[]
  ).filter((r) => r.run_id === prefix || /^\d+$/.test(r.run_id.slice(prefix.length + 1)));
  return { completed: rows.some((r) => r.status === 'completed'), started: rows.some((r) => r.status !== 'completed') };
}

/**
 * Whether `spec`'s pipeline is owed at `now`. A live jobpilot holding the lock makes it not owed. The clock and the
 * attempts file are read first, so before the first window or past the cap the DB is never opened; then the DB says
 * whether the current window's run completed (a home with no DB yet is owed, and is not created). Throws only when
 * the DB cannot be read, which the caller counts as a failed attempt. `window` is the id of the window in force
 * ('' for daily, and before the first window).
 */
export function due(spec: DueSpec, home: string, now: string): Due & { window: string } {
  const holder = liveHolder(home);
  const win = currentWindow(spec, now);
  const window = win?.id ?? '';
  if (holder !== undefined) return { due: false, window, reason: `a jobpilot ${holder.command} is running (pid ${holder.pid})` };
  const first = spec.windows[0]!;
  const w = win ?? first;
  const wording: Wording =
    w.id === '' ? { from: w.fromIst, span: 'today', run: "today's run" } : { from: w.fromIst, span: `in the ${w.id} window`, run: `the ${w.id} window's run` };
  const start = startOfIstDay(now) + minutesOf(w.fromIst) * 60_000;
  const failuresToday = failuresOf(read(spec, home, now));
  const early = { ...decide({ now, completedToday: false, failuresToday }, start, wording), window };
  if (!early.due) return early;
  const db = homePaths(home).db;
  if (!existsSync(db)) return early;
  const app = AppStore.open(db);
  try {
    const r = runsIn(app, `${spec.runPrefix}${keyOf(now, w.id)}`);
    return { ...decide({ now, completedToday: r.completed, startedToday: r.started, failuresToday }, start, wording), window };
  } finally {
    app.close();
  }
}

/** The daily run: `due(DAILY_DUE, home, now)` without the window. */
export function dailyDue(home: string, now: string): Due {
  const { window: _w, ...rest } = due(DAILY_DUE, home, now);
  return rest;
}
