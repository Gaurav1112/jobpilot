import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveHolder } from './lock.js';
import { homePaths } from './pack/paths.js';
import { istDate } from './run.js';
import { AppStore, SchemaBehindError } from './store/app-store.js';

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

/** `paused`: a coverage slice that yielded (to the daily or freelance run, or at its slice limit): never a failure. */
export type Outcome = 'started' | 'done' | 'failed' | 'paused';
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
  readonly pipeline: 'daily' | 'freelance' | 'coverage';
  /** Ascending by `fromIst` ("HH:MM"). `id` is '' for a pipeline with one window a day, else the run-id suffix. */
  readonly windows: readonly { fromIst: string; id: string }[];
  /** File under the jobpilot home holding this pipeline's attempts, keyed by IST date plus window. */
  readonly attemptsFile: string;
  /** Run ids are `<runPrefix><IST date>[-<window id>][-<ordinal>]`. */
  readonly runPrefix: string;
  /** The CLI command that runs this pipeline by hand (named in the give-up reason). */
  readonly command: 'run' | 'run-freelance' | 'run-coverage';
  /**
   * Weekly pipeline: the IST weekday (0 = Sunday) from which a run is owed, at `windows[0].fromIst`. The owed span is a
   * "coverage week" (`coverageWeek`): that weekday's start time through the end of the day before the next one (for
   * Sunday: Sunday 06:00 through Saturday 23:59 IST). It stays owed on every day of the span until a run completes in
   * it; attempts and the cap of 3 failures are counted per coverage week. A weekly spec has one window with id ''.
   */
  readonly weekday?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}
export const DAILY_DUE: DueSpec = { pipeline: 'daily', windows: [{ fromIst: '07:00', id: '' }], attemptsFile: ATTEMPTS_FILE, runPrefix: 'daily-', command: 'run' };
export const FREELANCE_DUE: DueSpec = {
  pipeline: 'freelance',
  command: 'run-freelance',
  windows: [
    { fromIst: '07:30', id: 'am' },
    { fromIst: '19:30', id: 'pm' },
  ],
  attemptsFile: 'freelance-attempts.json',
  runPrefix: 'freelance-',
};

/**
 * Written by `schedule install` on a home that never ran coverage (final review I1): `{ "notBefore": <ISO> }`, the next
 * Sunday 06:00 IST. Before it the weekly coverage run is not owed, so installing on a weekday does not start a
 * 7-hour run at once. `schedule install --coverage-now` removes it; a file that cannot be read never blocks the run.
 */
export const COVERAGE_START_FILE = 'coverage-start.json';

/** The `notBefore` of the home's COVERAGE_START_FILE (ms), if the file is there and readable. */
export function coverageNotBefore(home: string): number | undefined {
  try {
    const v = (JSON.parse(readFileSync(join(home, COVERAGE_START_FILE), 'utf8')) as { notBefore?: unknown }).notBefore;
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isNaN(t) ? undefined : t;
  } catch {
    return undefined;
  }
}

/** The weekly career-site coverage: owed from Sunday 06:00 IST, with catch-up through Saturday 23:59 IST. */
export const COVERAGE_DUE: DueSpec = {
  pipeline: 'coverage',
  command: 'run-coverage',
  windows: [{ fromIst: '06:00', id: '' }],
  weekday: 0,
  attemptsFile: 'coverage-attempts.json',
  runPrefix: 'coverage-',
};

const DAY_MS = 86_400_000;
const istDow = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();
const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * The coverage week `now` is in: the IST date of the most recent Sunday (today when today is a Sunday). A week is
 * Sunday 00:00 IST through Saturday 23:59 IST, not an ISO week (which ends on Sunday); the run is owed from Sunday
 * 06:00, so a Mac asleep on Sunday catches up on Monday through Saturday. This is the key of the week's attempts file.
 */
export function coverageWeek(now: string): string {
  return weekStart(now, 0);
}
/** The IST date of the most recent `weekday` (0 = Sunday) on or before `now`'s IST date. */
function weekStart(now: string, weekday: number): string {
  const today = istDate(now);
  return addDays(today, -((istDow(today) - weekday + 7) % 7));
}

const istClock = (ms: number): string => new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);
const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

interface Wording {
  readonly from: string;
  /** "today" (daily) or "this <id> window" — the span the cap and completion are counted over. */
  readonly span: string;
  /** "today's run" or "the <id> window's run". */
  readonly run: string;
  /** The CLI command to run by hand; default `run`. */
  readonly command?: string;
}

function decide(i: DueInput, startOfWindow: number, w: Wording): Due {
  const t = Date.parse(i.now);
  if (t < startOfWindow) return { due: false, reason: `before ${w.from} IST` };
  if (i.completedToday) return { due: false, reason: `${w.run} completed` };
  const n = i.failuresToday.length;
  if (n >= MAX_FAILED_ATTEMPTS) return { due: false, capped: true, reason: `${n} attempts failed ${w.span}; run "jobpilot ${w.command ?? 'run'}" by hand after fixing the cause` };
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
      (a): a is Attempt => typeof a?.at === 'string' && !Number.isNaN(Date.parse(a.at)) && ['started', 'done', 'failed', 'paused'].includes(a.outcome as string),
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
const attemptsKey = (spec: DueSpec, now: string): string => (spec.weekday !== undefined ? weekStart(now, spec.weekday) : keyOf(now, windowId(spec, now)));
const read = (spec: DueSpec, home: string, now: string): AttemptsFile => readFile(spec, home, attemptsKey(spec, now));

/** Failed attempts, plus started ones that never finished: crashed, since the caller has ruled out a live holder. */
/** Whether the attempts file records a completed run since `start` (needs no DB: the fallback when it cannot be read). */
const doneSince = (f: AttemptsFile, start: number): boolean => f.attempts.some((a) => a.outcome === 'done' && Date.parse(a.at) >= start);

const failuresOf = (f: AttemptsFile): string[] => f.attempts.filter((a) => a.outcome !== 'done' && a.outcome !== 'paused').map((a) => a.at);

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
    finish(home: string, now: string, outcome: 'done' | 'failed' | 'paused', index?: number): void {
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
export function due(spec: DueSpec, home: string, now: string, opts: { readonly ignoreHolder?: boolean } = {}): Due & { window: string } {
  if (spec.weekday !== undefined) return dueWeekly(spec, spec.weekday, home, now);
  const holder = opts.ignoreHolder === true ? undefined : liveHolder(home);
  const win = currentWindow(spec, now);
  const window = win?.id ?? '';
  if (holder !== undefined) return { due: false, window, reason: `a jobpilot ${holder.command} is running (pid ${holder.pid})` };
  const first = spec.windows[0]!;
  const w = win ?? first;
  const wording: Wording =
    w.id === ''
      ? { from: w.fromIst, span: 'today', run: "today's run", command: spec.command }
      : { from: w.fromIst, span: `in the ${w.id} window`, run: `the ${w.id} window's run`, command: spec.command };
  const start = startOfIstDay(now) + minutesOf(w.fromIst) * 60_000;
  const failuresToday = failuresOf(read(spec, home, now));
  const early = { ...decide({ now, completedToday: false, failuresToday }, start, wording), window };
  if (!early.due) return early;
  const db = homePaths(home).db;
  if (!existsSync(db)) return early;
  // read as it is: a schema behind this code must not stop the scheduled run, which migrates it under its lock; one it
  // cannot read without migrating (a kernel schema behind) counts as not yet run: the run starts and migrates it
  let app: AppStore;
  try {
    app = AppStore.open(db, { schema: 'as-is' });
  } catch (e) {
    if (e instanceof SchemaBehindError) {
      // the run's own record says whether today's run completed: never a second run the same day
      return { ...decide({ now, completedToday: doneSince(read(spec, home, now), start), failuresToday }, start, wording), window };
    }
    throw e;
  }
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

/**
 * The weekly rule (see `DueSpec.weekday`). Before the weekday's `fromIst` on that weekday nothing is owed (the previous
 * coverage week ended the evening before); on any later day of the coverage week it is owed until a run completes in it
 * (a `<runPrefix><date>[-<n>]` run of any date in the week), failed attempts spaced an hour and at most 3 per week.
 */
function dueWeekly(spec: DueSpec, weekday: number, home: string, now: string): Due & { window: string } {
  const window = '';
  const holder = liveHolder(home);
  if (holder !== undefined) return { due: false, window, reason: `a jobpilot ${holder.command} is running (pid ${holder.pid})` };
  const from = spec.windows[0]!.fromIst;
  const week = weekStart(now, weekday);
  const start = Date.parse(`${week}T00:00:00Z`) - IST_OFFSET_MS + minutesOf(from) * 60_000;
  const wording: Wording = { from: `${DAY_NAMES[weekday]} ${from}`, span: 'this coverage week', run: "this coverage week's run", command: spec.command };
  // The week is keyed by its start date, so before `start` on that day `now` is still in the previous week's keying
  // but nothing is owed: the previous week ended with its last day.
  if (Date.parse(now) < start) return { due: false, window, reason: `before ${wording.from} IST` };
  const notBefore = spec.pipeline === 'coverage' ? coverageNotBefore(home) : undefined;
  if (notBefore !== undefined && Date.parse(now) < notBefore) {
    const when = new Date(notBefore).toISOString();
    return { due: false, window, reason: `the first coverage run is owed from ${DAY_NAMES[new Date(notBefore + IST_OFFSET_MS).getUTCDay()]} ${istDate(when)} ${istClock(notBefore)} IST (schedule install; run-coverage by hand, or schedule install --coverage-now, to start sooner)` };
  }
  const failures = failuresOf(read(spec, home, now));
  const early = { ...decide({ now, completedToday: false, failuresToday: failures }, start, wording), window };
  if (!early.due) return early;
  const db = homePaths(home).db;
  if (!existsSync(db)) return early;
  // read as it is: a schema behind this code must not stop the scheduled run, which migrates it under its lock; one it
  // cannot read without migrating (a kernel schema behind) counts as not yet run: the run starts and migrates it
  let app: AppStore;
  try {
    app = AppStore.open(db, { schema: 'as-is' });
  } catch (e) {
    if (e instanceof SchemaBehindError) return { ...decide({ now, completedToday: doneSince(read(spec, home, now), start), failuresToday: failures }, start, wording), window };
    throw e;
  }
  try {
    let completed = false;
    let started = false;
    for (let i = 0; i < 7; i++) {
      const r = runsIn(app, `${spec.runPrefix}${addDays(week, i)}`);
      completed ||= r.completed;
      started ||= r.started;
    }
    return { ...decide({ now, completedToday: completed, startedToday: started, failuresToday: failures }, start, wording), window };
  } finally {
    app.close();
  }
}
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** How far ahead the coverage run looks for an owed daily or freelance run: it yields before their window opens. */
export const YIELD_LOOKAHEAD_MS = 5 * 60_000;
/**
 * Starvation bound: coverage stops yielding to a pipeline that has been owed for more than this with no attempt in its
 * current window (its job is not loaded, or it is waiting all day for a network that is down).
 */
export const YIELD_STARVATION_MS = 2 * 60 * 60_000;

/** Where the coverage run remembers, per daily/freelance window, when it first gave way to it (review I-3). */
export const YIELD_FILE = 'coverage-yield.json';

function readYields(home: string): Record<string, string> {
  try {
    const v = JSON.parse(readFileSync(join(home, YIELD_FILE), 'utf8')) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, t]) => typeof t === 'string' && !Number.isNaN(Date.parse(t)))) as Record<string, string>;
  } catch {
    return {}; // missing or corrupt: every window's first yield is "now" (fail-safe: never starved)
  }
}

function writeYields(home: string, y: Record<string, string>): void {
  try {
    const path = join(home, YIELD_FILE);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(y), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // unwritable: the next check starts the clock again (fail-safe)
  }
}

/**
 * Review I-2/I-3, the fail-safe yield rule: the daily or freelance run is owed for THIS home at `now`, or within
 * YIELD_LOOKAHEAD_MS (their own due rules; the lock holder, the coverage run itself, is ignored), AND that pipeline's
 * attempts file exists in this home (only scheduled `--if-due` runs write it, so a fresh check home never yields).
 * Starvation bound: once coverage has given way to one window (pipeline + window key) for more than
 * YIELD_STARVATION_MS, counted from its FIRST yield to that window (kept in `coverage-yield.json`, pruned to the current
 * windows), with no attempt of that pipeline since, it stops yielding to that window (the job is not loaded, or its
 * network is down all day). A missing or corrupt yield file reads as "first yield now", never as starved. The reason
 * to yield (`yielded to daily` / `yielded to freelance`), or null. A due check that cannot be read never makes coverage yield.
 */
export function otherRunOwed(home: string, now: string): string | null {
  const ahead = new Date(Date.parse(now) + YIELD_LOOKAHEAD_MS).toISOString();
  const yields = readYields(home);
  const current = new Set<string>();
  let reason: string | null = null;
  for (const [spec, name] of [[DAILY_DUE, 'daily'], [FREELANCE_DUE, 'freelance']] as const) {
    for (const at of [now, ahead]) current.add(`${name}:${attemptsKey(spec, at)}`);
    if (reason !== null || !existsSync(join(home, spec.attemptsFile))) continue;
    for (const at of [now, ahead]) {
      try {
        if (!due(spec, home, at, { ignoreHolder: true }).due) continue;
        const key = `${name}:${attemptsKey(spec, at)}`;
        const first = yields[key] ?? now;
        const alive = read(spec, home, at).attempts.some((x) => Date.parse(x.at) >= Date.parse(first));
        if (Date.parse(now) - Date.parse(first) > YIELD_STARVATION_MS && !alive) continue;
        yields[key] = first;
        reason = `yielded to ${name}`;
        break;
      } catch {
        // unreadable: not a reason to yield
      }
    }
  }
  const kept = Object.fromEntries(Object.entries(yields).filter(([k]) => current.has(k)));
  if (JSON.stringify(kept) !== JSON.stringify(readYields(home)) || reason !== null) writeYields(home, kept);
  return reason;
}
