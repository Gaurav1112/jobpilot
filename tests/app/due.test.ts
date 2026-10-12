import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATTEMPTS_FILE, dailyDue, finishAttempt, isDue, MAX_FAILED_ATTEMPTS, startAttempt } from '../../src/app/due.js';
import { withLock } from '../../src/app/lock.js';
import { AppStore } from '../../src/app/store/app-store.js';

// 2026-10-12 in IST; 01:30Z = 07:00 IST.
const at = (istHhMm: string, day = '2026-10-12'): string => {
  const [h, m] = istHhMm.split(':').map(Number) as [number, number];
  return new Date(Date.parse(`${day}T00:00:00Z`) + ((h * 60 + m) - 330) * 60_000).toISOString();
};

describe('isDue (pure)', () => {
  it('is not due before 07:00 IST', () => {
    expect(isDue({ now: at('06:59'), completedToday: false, failuresToday: [] })).toEqual({ due: false, reason: 'before 07:00 IST' });
  });

  it('is due at and after 07:00 IST when nothing completed today', () => {
    expect(isDue({ now: at('07:00'), completedToday: false, failuresToday: [] }).due).toBe(true);
    // the Mac slept through 07:00 and woke at 09:29
    expect(isDue({ now: at('09:29'), completedToday: false, failuresToday: [] }).due).toBe(true);
    expect(isDue({ now: at('23:59'), completedToday: false, failuresToday: [] }).due).toBe(true);
  });

  it('is not due once a run completed today', () => {
    expect(isDue({ now: at('09:30'), completedToday: true, failuresToday: [] })).toEqual({ due: false, reason: "today's run completed" });
  });

  it('retries a run that could not run, at most an hour apart and three times a day', () => {
    const first = at('07:00');
    expect(isDue({ now: at('07:59'), completedToday: false, failuresToday: [first] })).toEqual({ due: false, reason: 'the last attempt failed at 07:00 IST; retrying from 08:00 IST' });
    expect(isDue({ now: at('08:00'), completedToday: false, failuresToday: [first] }).due).toBe(true);
    const three = [at('07:00'), at('08:00'), at('09:00')];
    expect(MAX_FAILED_ATTEMPTS).toBe(3);
    expect(isDue({ now: at('22:00'), completedToday: false, failuresToday: three })).toEqual({ due: false, capped: true, reason: '3 attempts failed today; run "jobpilot run" by hand after fixing the cause' });
  });

  it('uses the latest failure for spacing whatever the order', () => {
    expect(isDue({ now: at('08:30'), completedToday: false, failuresToday: [at('08:00'), at('07:00')] }).due).toBe(false);
  });
});

describe('dailyDue / recordFailedAttempt (store)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-due-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const db = () => join(home, 'jobpilot.db');

  it('a home with no database is due after 07:00 and creates nothing', () => {
    expect(dailyDue(home, at('09:00')).due).toBe(true);
    expect(dailyDue(home, at('06:00')).due).toBe(false);
  });

  it('reads completed daily runs of today only (any ordinal), not running ones or other days', () => {
    const app = AppStore.open(db());
    const ins = app.kernel.db.prepare(`INSERT INTO runs (run_id, pipeline, policy_hash, started_at, finished_at, status) VALUES (?, 'p', 'h', ?, ?, ?)`);
    ins.run('daily-2026-10-11', at('07:00', '2026-10-11'), at('07:12', '2026-10-11'), 'completed');
    ins.run('daily-2026-10-12', at('09:29'), null, 'running');
    ins.run('rebuild-2026-10-12', at('09:00'), at('09:01'), 'completed');
    app.close();
    expect(dailyDue(home, at('10:00'))).toEqual({ due: true, reason: "today's run started and did not complete; this start continues it" });

    const again = AppStore.open(db());
    again.kernel.db.prepare(`INSERT INTO runs (run_id, pipeline, policy_hash, started_at, finished_at, status) VALUES ('daily-2026-10-12-2', 'p', 'h', ?, ?, 'completed')`).run(at('10:00'), at('10:12'));
    again.close();
    expect(dailyDue(home, at('10:30'))).toEqual({ due: false, reason: "today's run completed" });
  });

  it('records failed attempts per IST day in the attempts file; a new day starts over', () => {
    finishAttempt(home, at('07:00'), 'failed');
    finishAttempt(home, at('08:00'), 'failed');
    expect(dailyDue(home, at('08:30')).due).toBe(false);
    expect(dailyDue(home, at('09:00')).due).toBe(true);
    finishAttempt(home, at('09:00'), 'failed');
    expect(dailyDue(home, at('15:00'))).toMatchObject({ due: false, capped: true, reason: expect.stringMatching(/^3 attempts failed today/) });
    expect(dailyDue(home, at('07:00', '2026-10-13')).due).toBe(true);
    finishAttempt(home, at('07:00', '2026-10-13'), 'failed');
    expect(JSON.parse(readFileSync(join(home, ATTEMPTS_FILE), 'utf8'))).toEqual({ date: '2026-10-13', attempts: [{ at: at('07:00', '2026-10-13'), outcome: 'failed' }] });
  });

  it('an attempt that started and never finished (killed) counts as failed; a finished one does not', () => {
    startAttempt(home, at('07:00'));
    expect(dailyDue(home, at('07:30')).reason).toBe('the last attempt failed at 07:00 IST; retrying from 08:00 IST');
    const i = startAttempt(home, at('08:00'));
    finishAttempt(home, at('08:00'), 'done', i);
    expect(dailyDue(home, at('08:30')).reason).toBe('retry 2 of 3');
    startAttempt(home, at('09:00'));
    startAttempt(home, at('10:00'));
    expect(dailyDue(home, at('23:00')).capped).toBe(true);
  });

  it('a live jobpilot holding the lock is not owed, whatever the attempts file says', async () => {
    startAttempt(home, at('07:00'));
    await withLock(home, 'run', async () => {
      expect(dailyDue(home, at('07:30'))).toEqual({ due: false, reason: expect.stringMatching(/^a jobpilot run is running \(pid \d+\)$/) });
    });
  });

  it('past the cap the DB is never opened, so a corrupt DB stops being read', () => {
    writeFileSync(db(), 'not a database');
    expect(() => dailyDue(home, at('09:00'))).toThrow();
    for (const h of ['07:00', '08:00', '09:00']) finishAttempt(home, at(h), 'failed');
    expect(dailyDue(home, at('10:00')).capped).toBe(true);
  });

  it('a corrupt attempts file counts as none', () => {
    writeFileSync(join(home, ATTEMPTS_FILE), '{nope');
    expect(dailyDue(home, at('09:00')).due).toBe(true);
  });
});
