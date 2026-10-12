import { existsSync } from 'node:fs';
import { homePaths } from './pack/paths.js';
import { istDate } from './run.js';
import { AppStore } from './store/app-store.js';

/**
 * When the daily run is owed (`jobpilot run --if-due`). launchd starts the daily job at load and every half hour, and
 * this decides whether that start does anything, so a Mac asleep at 07:00 IST runs on its first start after waking
 * instead of skipping the day (launchd's own catch-up of a missed calendar slot did not fire on 2026-10-11 or -12).
 */

/** The hour (IST) from which a day's run is owed. */
export const DAILY_HOUR_IST = 7;
/** A run that could not run (exit 2) is retried at most this many times a day … */
export const MAX_FAILED_ATTEMPTS = 3;
/** … and no sooner than this after the previous failure, so a dead network does not post a failure every half hour. */
const RETRY_AFTER_MS = 60 * 60_000;
/** The app setting holding today's failed attempts: `{date, at: [iso…]}`. */
export const DAILY_FAILURES_KEY = 'daily.failures';

const IST_OFFSET_MS = 330 * 60_000;

export interface DueInput {
  readonly now: string;
  /** Whether a `daily-<today>` run (any ordinal) completed. */
  readonly completedToday: boolean;
  /** Whether one started and has not completed: running now (the lock stops a second), or crashed (it is resumed). */
  readonly startedToday?: boolean;
  /** Today's attempts that could not run (exit 2), ISO times. */
  readonly failuresToday: readonly string[];
}
export interface Due {
  readonly due: boolean;
  readonly reason: string;
}

const istClock = (iso: string): string => new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(11, 16);

export function isDue(i: DueInput): Due {
  const t = Date.parse(i.now);
  const startOfDay = Date.parse(`${istDate(i.now)}T00:00:00Z`) - IST_OFFSET_MS;
  if (t < startOfDay + DAILY_HOUR_IST * 3_600_000) return { due: false, reason: `before ${String(DAILY_HOUR_IST).padStart(2, '0')}:00 IST` };
  if (i.completedToday) return { due: false, reason: "today's run completed" };
  if (i.failuresToday.length >= MAX_FAILED_ATTEMPTS) {
    return { due: false, reason: `${i.failuresToday.length} attempts failed today; run "jobpilot run" by hand after fixing the cause` };
  }
  const last = Math.max(...i.failuresToday.map((f) => Date.parse(f)));
  if (i.failuresToday.length > 0 && t < last + RETRY_AFTER_MS) {
    return { due: false, reason: `the last attempt failed at ${istClock(new Date(last).toISOString())} IST; retrying from ${istClock(new Date(last + RETRY_AFTER_MS).toISOString())} IST` };
  }
  if (i.failuresToday.length > 0) return { due: true, reason: `retry ${i.failuresToday.length + 1} of ${MAX_FAILED_ATTEMPTS}` };
  return { due: true, reason: i.startedToday === true ? "today's run started and has not completed (running now, or resumed by the next start)" : "today's run has not run" };
}

function failuresOn(app: AppStore, date: string): string[] {
  try {
    const v = JSON.parse(app.getSetting(DAILY_FAILURES_KEY) ?? 'null') as { date?: unknown; at?: unknown } | null;
    return v?.date === date && Array.isArray(v.at) ? v.at.filter((x): x is string => typeof x === 'string' && !Number.isNaN(Date.parse(x))) : [];
  } catch {
    return [];
  }
}

/** Today's daily runs (any ordinal): whether one completed, and whether one started without completing. */
function runsOn(app: AppStore, date: string): { completedToday: boolean; startedToday: boolean } {
  const prefix = `daily-${date}`;
  const rows = app.kernel.db
    .prepare(`SELECT status FROM runs WHERE run_id = ? OR substr(run_id, 1, ?) = ?`)
    .all(prefix, prefix.length + 1, `${prefix}-`) as { status: string }[];
  return { completedToday: rows.some((r) => r.status === 'completed'), startedToday: rows.some((r) => r.status !== 'completed') };
}

/** Whether the daily run is owed at `now`, from the home's DB. A home with no DB yet is owed (and is not created). */
export function dailyDue(home: string, now: string): Due {
  const db = homePaths(home).db;
  if (!existsSync(db)) return isDue({ now, completedToday: false, failuresToday: [] });
  const app = AppStore.open(db);
  try {
    const date = istDate(now);
    return isDue({ now, ...runsOn(app, date), failuresToday: failuresOn(app, date) });
  } finally {
    app.close();
  }
}

/** Notes an attempt at `now` that could not run, so `dailyDue` spaces and caps the retries. */
export function recordFailedAttempt(home: string, now: string): void {
  const app = AppStore.open(homePaths(home).db);
  try {
    const date = istDate(now);
    app.setSetting(DAILY_FAILURES_KEY, JSON.stringify({ date, at: [...failuresOn(app, date), now] }));
  } finally {
    app.close();
  }
}
