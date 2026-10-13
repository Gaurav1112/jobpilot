import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCoverage, type CoverageResult } from '../../../src/app/coverage/run.js';
import { COVERAGE_DUE, due, otherRunOwed, YIELD_STARVATION_MS } from '../../../src/app/due.js';
import { writeFileSync } from 'node:fs';
import { withLock } from '../../../src/app/lock.js';
import { offlineProviders } from '../../../src/app/offline.js';
import { runCoverageCommand } from '../../../src/app/run-command.js';
import { AppStore } from '../../../src/app/store/app-store.js';
import type { FetchLike } from '../../../src/kernel/providers.js';

const root = join(import.meta.dirname, '../../..');
const FIX = join(root, 'tests/fixtures/coverage/e2e');
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-cov-slice-'));
  homes.push(home);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  copyFileSync(join(FIX, 'companies.yaml'), join(home, 'pack', 'companies.yaml'));
  return home;
}
function net() {
  const offline = offlineProviders(FIX).fetch;
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    return offline(url, init);
  };
  return { fetch, calls };
}
/** A clock that moves `stepMs` forward on every read, from `start`. */
const ticking = (start: string, stepMs: number) => {
  let t = Date.parse(start);
  return { now: () => new Date((t += stepMs)).toISOString() };
};
const events = (home: string, runId: string): string[] => {
  const app = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return app.kernel.events(runId).map((e) => e.kind);
  } finally {
    app.close();
  }
};
const runStatus = (home: string, runId: string): string | undefined => {
  const app = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return app.kernel.getRun(runId)?.status;
  } finally {
    app.close();
  }
};
const stepsDone = (home: string, runId: string): number => {
  const app = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return ['seed', 'locate', 'detect', 'verify'].reduce((n, st) => n + app.kernel.events(`${runId}.${st}`).filter((e) => e.kind === 'step_done').length, 0);
  } finally {
    app.close();
  }
};

// IST = UTC + 5:30. Sunday 2026-10-11 06:54 IST is 01:24Z.
const SUN_0654 = '2026-10-11T01:24:00.000Z';
const SUN_2000 = '2026-10-11T14:30:00.000Z';
/** An attempts file from an earlier day: what a scheduled `--if-due` run leaves behind on this home. */
const scheduled = (home: string, file: string): void => writeFileSync(join(home, file), JSON.stringify({ date: '2026-10-10', attempts: [{ at: '2026-10-10T01:30:00.000Z', outcome: 'done' }] }));

describe('coverage time slices: yield to the daily run, a slice cap, resume the same run', () => {
  it('the daily run due at 07:00 (looked ahead 5 minutes) pauses coverage before its next step; the daily run then gets the lock', async () => {
    const home = newHome();
    scheduled(home, 'daily-attempts.json');
    const clock = ticking(SUN_0654, 2 * 60_000);
    const r = await runCoverage({ home, clock, fetch: net().fetch, sleep: async () => {}, codeHash: 'slice' });
    expect(r).toMatchObject({ status: 'paused', runId: 'coverage-2026-10-11', reason: 'yielded to daily', exitCode: 0 });
    expect(runStatus(home, 'coverage-2026-10-11')).not.toBe('completed');
    expect(events(home, 'coverage-2026-10-11')).toContain('coverage.paused');
    expect(events(home, 'coverage-2026-10-11')).not.toContain('coverage.projected');
    // the lock is free: the daily run takes it
    await expect(withLock(home, 'run', async () => 'daily ran')).resolves.toBe('daily ran');
  });

  it('the yield rule (review I-2): owed for THIS home and its attempts file exists', () => {
    // 2026-10-11 07:30 IST = 02:00Z: daily owed since 07:00, freelance since 07:30
    const at = '2026-10-11T02:00:00.000Z';
    const home = newHome();
    expect(otherRunOwed(home, at)).toBeNull(); // a fresh check home: no attempts file, never yields
    scheduled(home, 'freelance-attempts.json');
    expect(otherRunOwed(home, at)).toBe('yielded to freelance');
    scheduled(home, 'daily-attempts.json');
    expect(otherRunOwed(home, at)).toBe('yielded to daily');
    // a trailing slash or any other spelling of the home is the same directory
    expect(otherRunOwed(`${home}/`, at)).toBe('yielded to daily');
  });

  it('review I-3: the 2 h bound runs from coverage\'s FIRST yield to that window, not from the window start', () => {
    expect(YIELD_STARVATION_MS).toBe(2 * 60 * 60_000);
    const home = newHome();
    scheduled(home, 'daily-attempts.json'); // yesterday's attempts only
    // the Mac wakes at 10:00 IST (04:30Z): daily owed for 3 h, but coverage has not given way yet: it yields
    expect(otherRunOwed(home, '2026-10-11T04:30:00.000Z')).toBe('yielded to daily');
    expect(JSON.parse(readFileSync(join(home, 'coverage-yield.json'), 'utf8'))).toEqual({ 'daily:2026-10-11': '2026-10-11T04:30:00.000Z' });
    expect(otherRunOwed(home, '2026-10-11T06:00:00.000Z')).toBe('yielded to daily'); // 11:30 IST
    expect(otherRunOwed(home, '2026-10-11T06:31:00.000Z')).toBeNull(); // 12:01 IST: given way for 2 h 1 min, no attempt
    // a new window (the next day) resets the clock, and the file keeps only current windows
    expect(otherRunOwed(home, '2026-10-12T04:30:00.000Z')).toBe('yielded to daily');
    expect(Object.keys(JSON.parse(readFileSync(join(home, 'coverage-yield.json'), 'utf8')) as object)).toEqual(['daily:2026-10-12']);
  });

  it('review I-3: an attempt after the first yield keeps the yield (the job is alive); a missing or corrupt file is "first yield now"', () => {
    const home = newHome();
    scheduled(home, 'daily-attempts.json');
    expect(otherRunOwed(home, '2026-10-11T04:30:00.000Z')).toBe('yielded to daily');
    // daily ran at 10:30 IST and failed; its retry is due from 11:30 IST
    writeFileSync(join(home, 'daily-attempts.json'), JSON.stringify({ date: '2026-10-11', attempts: [{ at: '2026-10-11T05:00:00.000Z', outcome: 'failed' }] }));
    expect(otherRunOwed(home, '2026-10-11T07:00:00.000Z')).toBe('yielded to daily'); // 12:30 IST: 2.5 h of yielding, but alive
    const fresh = newHome();
    scheduled(fresh, 'daily-attempts.json');
    writeFileSync(join(fresh, 'coverage-yield.json'), '{not json');
    expect(otherRunOwed(fresh, '2026-10-11T08:00:00.000Z')).toBe('yielded to daily'); // 13:30 IST, corrupt file: first yield now
    expect(JSON.parse(readFileSync(join(fresh, 'coverage-yield.json'), 'utf8'))).toEqual({ 'daily:2026-10-11': '2026-10-11T08:00:00.000Z' });
  });

  it('the slice cap pauses; the next invocation resumes the SAME run id and finishes; the summary line is posted once, on completion', async () => {
    const home = newHome();
    const posted: string[] = [];
    const notifier = async (t: string) => void posted.push(t);
    const slices: CoverageResult[] = [];
    // each clock read is 1 s (a step reads it a few times, well inside its 90 s deadline); a 1-minute slice pauses after a few steps
    for (let i = 0; i < 60; i++) {
      const r = await runCoverage({ home, clock: ticking(SUN_2000, 1000), fetch: net().fetch, sleep: async () => {}, codeHash: 'slice', notifier, sliceMs: 4_000, yieldCheck: () => null });
      slices.push(r);
      if (r.status === 'completed') break;
    }
    expect(slices.length).toBeGreaterThan(2);
    expect(slices.slice(0, -1).every((s) => s.status === 'paused' && s.reason === 'slice limit')).toBe(true);
    expect(new Set(slices.map((s) => s.runId))).toEqual(new Set(['coverage-2026-10-11']));
    expect(slices.at(-1)).toMatchObject({ status: 'completed', verdicts: { verified: 2, proposed: 1, failed: 1 }, exitCode: 0 });
    expect(posted).toEqual(['Coverage: 2 verified (+2 new) · 1 proposed · 0 failing']);
    // every step executed exactly once over all the slices (a cut-short step is replayed, never re-run)
    // seed 4, locate 5, detect 4 located sites, verify 4 detected platforms (workday included, read through its client)
    expect(stepsDone(home, 'coverage-2026-10-11')).toBe(4 + 5 + 4 + 4);
    expect(events(home, 'coverage-2026-10-11').filter((k) => k === 'coverage.projected')).toHaveLength(1);
    // a further run that week replays every step at $0, without a request
    const again = net();
    const r = await runCoverage({ home, clock: ticking('2026-10-12T04:30:00.000Z', 1000), fetch: again.fetch, sleep: async () => {}, codeHash: 'slice', yieldCheck: () => null });
    expect(r).toMatchObject({ status: 'completed', runId: 'coverage-2026-10-12' });
    expect(again.calls).toEqual([]);
  });

  it('a run paused on Sunday is continued on Monday under its Sunday run id (catch-up through the week)', async () => {
    const home = newHome();
    const first = await runCoverage({ home, clock: ticking(SUN_2000, 1000), fetch: net().fetch, sleep: async () => {}, codeHash: 'slice', sliceMs: 3_000, yieldCheck: () => null });
    expect(first).toMatchObject({ status: 'paused', runId: 'coverage-2026-10-11' });
    const monday = await runCoverage({ home, clock: ticking('2026-10-12T14:30:00.000Z', 1000), fetch: net().fetch, sleep: async () => {}, codeHash: 'slice', yieldCheck: () => null });
    expect(monday).toMatchObject({ status: 'completed', runId: 'coverage-2026-10-11', resumed: true });
    expect(due(COVERAGE_DUE, home, '2026-10-13T04:30:00.000Z')).toMatchObject({ due: false, reason: "this coverage week's run completed" });
  });
});

describe('week rollover: a run still paused when the next coverage week starts', () => {
  it('is closed as incomplete with one line "Coverage last week did not finish: N of M candidates done"; the new week starts its own run', async () => {
    const home = newHome();
    // slice until it is paused inside its locate stage
    let first: CoverageResult | undefined;
    for (let i = 0; i < 20 && !(first?.status === 'paused' && first.stage === 'locate'); i++) {
      first = await runCoverage({ home, clock: ticking(SUN_2000, 1000), fetch: net().fetch, sleep: async () => {}, codeHash: 'slice', sliceMs: 2_000, yieldCheck: () => null });
    }
    expect(first).toMatchObject({ status: 'paused', runId: 'coverage-2026-10-11', stage: 'locate' });
    const posted: string[] = [];
    const next = await runCoverage({ home, clock: ticking('2026-10-18T14:30:00.000Z', 1000), fetch: net().fetch, sleep: async () => {}, codeHash: 'slice', yieldCheck: () => null, notifier: async (t) => void posted.push(t) });
    expect(next).toMatchObject({ status: 'completed', runId: 'coverage-2026-10-18' });
    expect(posted).toHaveLength(2);
    expect(posted[0]).toMatch(/^Coverage last week did not finish: \d of 5 candidates finished \(0 deferred or failed\)$/);
    expect(next.warnings).toContain(posted[0]);
    const kinds = events(home, 'coverage-2026-10-11');
    expect(kinds.filter((k) => k === 'coverage.closed')).toHaveLength(1);
    // closed once: a later run does not post it again
    const later: string[] = [];
    await runCoverage({ home, clock: ticking('2026-10-19T14:30:00.000Z', 1000), fetch: net().fetch, sleep: async () => {}, codeHash: 'slice', yieldCheck: () => null, notifier: async (t) => void later.push(t) });
    expect(later.some((l) => l.startsWith('Coverage last week'))).toBe(false);
  });
});

describe('week rollover counts deferred or failed locate steps apart (review minor)', () => {
  it('"N of M candidates finished (k deferred or failed)"', async () => {
    const home = newHome();
    // slice until it is paused inside its locate stage with at least one locate step finished
    const locateDone = (): number => {
      const app = AppStore.open(join(home, 'jobpilot.db'));
      try {
        return app.kernel.queueItems('coverage-2026-10-11.locate').filter((q) => q.status === 'done').length;
      } finally {
        app.close();
      }
    };
    let first: CoverageResult | undefined;
    for (let i = 0; i < 30 && !(first?.status === 'paused' && first.stage === 'locate' && locateDone() > 0); i++) {
      first = await runCoverage({ home, clock: ticking(SUN_2000, 1000), fetch: net().fetch, sleep: async () => {}, codeHash: 'slice', sliceMs: 2_000, yieldCheck: () => null });
    }
    expect(first).toMatchObject({ status: 'paused', stage: 'locate' });
    // one of its finished locate steps failed (say a host-disabled deferral)
    const app = AppStore.open(join(home, 'jobpilot.db'));
    let finished: number;
    try {
      const items = app.kernel.queueItems('coverage-2026-10-11.locate');
      const done = items.filter((q) => q.status === 'done');
      expect(done.length).toBeGreaterThan(0);
      app.kernel.markQueue('coverage-2026-10-11.locate', done[0]!.agent_id, done[0]!.envelope_id, 'failed');
      finished = items.filter((q) => q.status !== 'pending').length;
    } finally {
      app.close();
    }
    const posted: string[] = [];
    await runCoverage({ home, clock: ticking('2026-10-18T14:30:00.000Z', 1000), fetch: net().fetch, sleep: async () => {}, codeHash: 'slice', yieldCheck: () => null, notifier: async (t) => void posted.push(t) });
    expect(posted[0]).toBe(`Coverage last week did not finish: ${finished} of 5 candidates finished (1 deferred or failed)`);
  });
});

describe('the yield switch and the lock message', () => {
  it('--no-yield (yieldCheck: () => null) runs to completion while daily is owed on a scheduled home', async () => {
    const home = newHome();
    scheduled(home, 'daily-attempts.json');
    const r = await runCoverage({ home, clock: ticking('2026-10-11T01:40:00.000Z', 1000), fetch: net().fetch, sleep: async () => {}, codeHash: 'slice', yieldCheck: () => null });
    expect(r.status).toBe('completed');
    // and without it the same home yields at once
    const home2 = newHome();
    scheduled(home2, 'daily-attempts.json');
    // 07:10 IST: daily owed for 10 minutes (at 20:00 IST it would be starved: owed 13 h with no attempt, no yield)
    const r2 = await runCoverage({ home: home2, clock: ticking('2026-10-11T01:40:00.000Z', 1000), fetch: net().fetch, sleep: async () => {}, codeHash: 'slice' });
    expect(r2).toMatchObject({ status: 'paused', reason: 'yielded to daily' });
    const r3 = await runCoverage({ home: home2, clock: ticking(SUN_2000, 1000), fetch: net().fetch, sleep: async () => {}, codeHash: 'slice' });
    expect(r3.status).toBe('completed');
  });

  it('a hand run while a coverage slice holds the lock gets the lock error with one more line', async () => {
    const home = newHome();
    await withLock(home, 'run-coverage', async () => {
      await expect(withLock(home, 'run', async () => 0)).rejects.toThrow(/another jobpilot process .*run-coverage[\s\S]*\na coverage slice is running; it yields within one step: try again in a minute$/);
    });
    await withLock(home, 'run-freelance', async () => {
      await expect(withLock(home, 'run', async () => 0)).rejects.toThrow(/wait for it to finish$/);
    });
  });
});

describe('run-coverage --if-due with slices: pauses are not failed attempts', () => {
  const deps = (home: string, now: () => string, out: string[], yieldCheck: (now: string) => string | null, posted: string[] = []) => ({
    home,
    clock: { now },
    notifier: async (t: string) => void posted.push(t),
    out: (l: string) => out.push(l),
    err: (l: string) => out.push(`ERR ${l}`),
    online: async () => true,
    sleep: async () => {},
    yieldCheck,
  });
  const attempts = (home: string) => (JSON.parse(readFileSync(join(home, 'coverage-attempts.json'), 'utf8')) as { attempts: { outcome: string }[] }).attempts.map((a) => a.outcome);

  it('slice pauses leave the week owed and are never failed attempts; the completing start ends it; the line is posted once', async () => {
    const home = newHome();
    const posted: string[] = [];
    const out: string[] = [];
    let t = Date.parse(SUN_2000);
    const now = () => new Date((t += 1000)).toISOString();
    let starts = 0;
    while (due(COVERAGE_DUE, home, new Date(t).toISOString()).due && starts < 60) {
      starts++;
      expect(await runCoverageCommand({ ifDue: true, notify: true, offlineFixtures: FIX, sliceMs: 3_000 }, deps(home, now, out, () => null, posted))).toBe(0);
    }
    const a = attempts(home);
    expect(a.length).toBeGreaterThan(3);
    expect(a.slice(0, -1).every((x) => x === 'paused')).toBe(true);
    expect(a.at(-1)).toBe('done');
    // more pauses than the cap of 3 failures, and the week was never capped
    expect(a.filter((x) => x === 'paused').length).toBeGreaterThan(3);
    expect(due(COVERAGE_DUE, home, new Date(t).toISOString())).toMatchObject({ due: false, reason: "this coverage week's run completed" });
    expect(posted).toEqual(['Coverage: 2 verified (+2 new) · 1 proposed · 0 failing']);
    expect(out.filter((l) => l.includes('paused in'))).toHaveLength(a.length - 1);
  });

  it('a scheduled start while the daily run is owed does not take the lock and records no attempt', async () => {
    const home = newHome();
    const out: string[] = [];
    const code = await runCoverageCommand({ ifDue: true, notify: false, offlineFixtures: FIX }, deps(home, () => SUN_2000, out, () => 'yielded to daily'));
    expect(code).toBe(0);
    expect(out).toEqual(['not due: yielded to daily (owed now or within 5 minutes); the next start continues the coverage run']);
    expect(() => readFileSync(join(home, 'coverage-attempts.json'), 'utf8')).toThrow();
  });
});
