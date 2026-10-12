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

const istClock = (ms: number): string => new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);

export function isDue(i: DueInput): Due {
  const t = Date.parse(i.now);
  const startOfDay = Date.parse(`${istDate(i.now)}T00:00:00Z`) - IST_OFFSET_MS;
  if (t < startOfDay + DAILY_HOUR_IST * 3_600_000) return { due: false, reason: `before ${String(DAILY_HOUR_IST).padStart(2, '0')}:00 IST` };
  if (i.completedToday) return { due: false, reason: "today's run completed" };
  const n = i.failuresToday.length;
  if (n >= MAX_FAILED_ATTEMPTS) return { due: false, capped: true, reason: `${n} attempts failed today; run "jobpilot run" by hand after fixing the cause` };
  const last = Math.max(...i.failuresToday.map((f) => Date.parse(f)));
  if (n > 0 && t < last + RETRY_AFTER_MS) {
    return { due: false, reason: `the last attempt failed at ${istClock(last)} IST; retrying from ${istClock(last + RETRY_AFTER_MS)} IST` };
  }
  if (n > 0) return { due: true, reason: `retry ${n + 1} of ${MAX_FAILED_ATTEMPTS}` };
  return { due: true, reason: i.startedToday === true ? "today's run started and did not complete; this start continues it" : "today's run has not run" };
}

const attemptsPath = (home: string): string => join(home, ATTEMPTS_FILE);

/** Today's attempts file; another day's, a missing or a corrupt one reads as empty. */
function readFile(home: string, date: string): AttemptsFile {
  try {
    const v = JSON.parse(readFileSync(attemptsPath(home), 'utf8')) as Partial<AttemptsFile>;
    if (v.date !== date || !Array.isArray(v.attempts)) return { date, attempts: [] };
    const attempts = v.attempts.filter(
      (a): a is Attempt => typeof a?.at === 'string' && !Number.isNaN(Date.parse(a.at)) && ['started', 'done', 'failed'].includes(a.outcome as string),
    );
    return { date, attempts, ...(v.alerted === true ? { alerted: true } : {}) };
  } catch {
    return { date, attempts: [] };
  }
}

function writeFile(home: string, f: AttemptsFile): void {
  const tmp = `${attemptsPath(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
  renameSync(tmp, attemptsPath(home));
}

/** Failed attempts, plus started ones that never finished: crashed, since the caller has ruled out a live holder. */
const failuresOf = (f: AttemptsFile): string[] => f.attempts.filter((a) => a.outcome !== 'done').map((a) => a.at);

/** Records the start of an attempt (under the lock); returns its index for `finishAttempt`. */
export function startAttempt(home: string, now: string): number {
  const f = readFile(home, istDate(now));
  writeFile(home, { ...f, attempts: [...f.attempts, { at: now, outcome: 'started' }] });
  return f.attempts.length;
}

/** Sets the outcome of attempt `index` of `now`'s day; with no index (it failed before starting), appends one. */
export function finishAttempt(home: string, now: string, outcome: 'done' | 'failed', index?: number): void {
  const f = readFile(home, istDate(now));
  const attempts = [...f.attempts];
  if (index !== undefined && attempts[index] !== undefined) attempts[index] = { at: attempts[index].at, outcome };
  else attempts.push({ at: now, outcome });
  writeFile(home, { ...f, attempts });
}

/** Whether today's give-up notification was posted; `markAlerted` records that it was. */
export const alerted = (home: string, now: string): boolean => readFile(home, istDate(now)).alerted === true;
export function markAlerted(home: string, now: string): void {
  writeFile(home, { ...readFile(home, istDate(now)), alerted: true });
}

/** Today's daily runs (any ordinal): whether one completed, and whether one started without completing. */
function runsOn(app: AppStore, date: string): { completedToday: boolean; startedToday: boolean } {
  const prefix = `daily-${date}`;
  const rows = app.kernel.db
    .prepare(`SELECT status FROM runs WHERE run_id = ? OR substr(run_id, 1, ?) = ?`)
    .all(prefix, prefix.length + 1, `${prefix}-`) as { status: string }[];
  return { completedToday: rows.some((r) => r.status === 'completed'), startedToday: rows.some((r) => r.status !== 'completed') };
}

/**
 * Whether the daily run is owed at `now`. A live jobpilot holding the lock makes it not owed. The clock and the
 * attempts file are read first, so before 07:00 or past the cap the DB is never opened; then the DB says whether
 * today's run completed (a home with no DB yet is owed, and is not created). Throws only when the DB cannot be read,
 * which the caller counts as a failed attempt.
 */
export function dailyDue(home: string, now: string): Due {
  const holder = liveHolder(home);
  if (holder !== undefined) return { due: false, reason: `a jobpilot ${holder.command} is running (pid ${holder.pid})` };
  const date = istDate(now);
  const failuresToday = failuresOf(readFile(home, date));
  const early = isDue({ now, completedToday: false, failuresToday });
  if (!early.due) return early;
  const db = homePaths(home).db;
  if (!existsSync(db)) return early;
  const app = AppStore.open(db);
  try {
    return isDue({ now, ...runsOn(app, date), failuresToday });
  } finally {
    app.close();
  }
}
