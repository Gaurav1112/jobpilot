import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCoverage, type CoverageResult } from '../../../src/app/coverage/run.js';
import { COVERAGE_DUE, due, otherRunOwed } from '../../../src/app/due.js';
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

describe('coverage time slices: yield to the daily run, a slice cap, resume the same run', () => {
  it('the daily run due at 07:00 (looked ahead 5 minutes) pauses coverage before its next step; the daily run then gets the lock', async () => {
    const home = newHome();
    const clock = ticking(SUN_0654, 2 * 60_000);
    const r = await runCoverage({ home, clock, fetch: net().fetch, sleep: async () => {}, codeHash: 'slice', yieldCheck: (now) => otherRunOwed(home, now, () => true) });
    expect(r).toMatchObject({ status: 'paused', runId: 'coverage-2026-10-11', reason: 'yielded to daily', exitCode: 0 });
    expect(runStatus(home, 'coverage-2026-10-11')).not.toBe('completed');
    expect(events(home, 'coverage-2026-10-11')).toContain('coverage.paused');
    expect(events(home, 'coverage-2026-10-11')).not.toContain('coverage.projected');
    // the lock is free: the daily run takes it
    await expect(withLock(home, 'run', async () => 'daily ran')).resolves.toBe('daily ran');
  });

  it('the yield ignores pipelines not scheduled on this home', () => {
    const home = newHome();
    expect(otherRunOwed(home, '2026-10-11T02:00:00.000Z', () => false)).toBeNull();
    expect(otherRunOwed(home, '2026-10-11T02:00:00.000Z', (p) => p === 'freelance')).toBe('yielded to freelance');
    expect(otherRunOwed(home, '2026-10-11T02:00:00.000Z', () => true)).toBe('yielded to daily');
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
    expect(slices.at(-1)).toMatchObject({ status: 'completed', verdicts: { verified: 1, proposed: 2, failed: 1 }, exitCode: 0 });
    expect(posted).toEqual(['Coverage: 1 verified (+1 new) · 2 proposed · 0 failing']);
    // every step executed exactly once over all the slices (a cut-short step is replayed, never re-run)
    // seed 4, locate 5, detect 4 located sites, verify 4 detected platforms (workday included: "adapter not built yet")
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
    expect(posted).toEqual(['Coverage: 1 verified (+1 new) · 2 proposed · 0 failing']);
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
