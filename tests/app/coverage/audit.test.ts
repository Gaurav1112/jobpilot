import { copyFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCheckpoint } from '../../../src/app/chain-status.js';
import { AUDIT_PENDING_KEY, formatCoverageSummary, runCoverage } from '../../../src/app/coverage/run.js';
import { offlineProviders } from '../../../src/app/offline.js';
import { AppStore } from '../../../src/app/store/app-store.js';

/**
 * The weekly full audit (dashboard-perf follow-up): `/runs` moves its verified point forward on its own, so a full walk
 * of the event chain must actually happen. The coverage run does one when it COMPLETES a week (never on a pause),
 * recording the full-check checkpoint as `jobpilot audit verify` does; a broken chain is a named problem, in the
 * notification and a non-zero exit. With too little of the slice left it waits for the next invocation, before any step.
 */
const root = join(import.meta.dirname, '../../..');
const FIX = join(root, 'tests/fixtures/coverage/e2e');
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-cov-audit-'));
  homes.push(home);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  copyFileSync(join(FIX, 'companies.yaml'), join(home, 'pack', 'companies.yaml'));
  return home;
}
const withApp = <T>(home: string, fn: (a: AppStore) => T): T => {
  const a = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return fn(a);
  } finally {
    a.close();
  }
};
// Sunday 2026-10-11 20:00 IST: nothing else owed, so coverage never yields
const SUN_2000 = '2026-10-11T14:30:00.000Z';
const SUN_0654 = '2026-10-11T01:24:00.000Z';
const fixed = (at: string) => ({ now: () => at });
const ticking = (start: string, stepMs: number) => {
  let t = Date.parse(start);
  return { now: () => new Date((t += stepMs)).toISOString() };
};
const base = (home: string) => ({ home, fetch: offlineProviders(FIX).fetch, sleep: async () => {}, codeHash: 'audit' });

describe('coverage: the weekly full audit of the event chain', () => {
  it('a completed week walks the whole chain and records the full-check checkpoint', async () => {
    const home = newHome();
    const r = await runCoverage({ ...base(home), clock: fixed(SUN_2000) });
    expect(r).toMatchObject({ status: 'completed', exitCode: 0, audit: { status: 'ok' } });
    const cp = withApp(home, (a) => readCheckpoint(a.kernel.db));
    expect(cp).toMatchObject({ verifiedAt: SUN_2000 });
    expect(cp?.fullSeq).toBe(cp?.seq);
    expect(formatCoverageSummary(r)).toMatch(/audit: the event chain is intact \(\d+ events, full check\)/);
  });

  it('a broken chain is a named problem, in the notification, and exits 1', async () => {
    const home = newHome();
    withApp(home, (a) => {
      for (let i = 0; i < 3; i++) a.kernel.appendEvent('daily-2026-10-10-1', SUN_2000, 'step_done', { i }, 'p');
      a.kernel.db.prepare(`UPDATE events SET data = '{"i":9}' WHERE seq = 2`).run();
    });
    const posted: string[] = [];
    const r = await runCoverage({ ...base(home), clock: fixed(SUN_2000), notifier: async (l) => void posted.push(l) });
    expect(r).toMatchObject({ status: 'completed', exitCode: 1, audit: { status: 'broken', seq: 2 } });
    if (r.status !== 'completed') throw new Error('not completed');
    expect(r.problems).toContainEqual({ kind: 'audit-broken', agent: 'audit', item: 'seq 2', reason: 'audit chain broken at seq 2: hash does not match the event contents' });
    expect(r.notification).toMatch(/^audit chain broken at seq 2/);
    expect(posted.some((l) => l.startsWith('audit chain broken at seq 2'))).toBe(true);
    expect(formatCoverageSummary(r)).toContain('AUDIT CHAIN BROKEN at seq 2');
    expect(withApp(home, (a) => readCheckpoint(a.kernel.db))).toBeUndefined();
    // the runs view lists it with the other problems
    expect(withApp(home, (a) => a.listRuns(1)[0]?.problems)).toContainEqual(expect.objectContaining({ kind: 'audit-broken' }));
  });

  it('a pause does not run it', async () => {
    const home = newHome();
    // a chain with events, so a full check (were it run) would record a checkpoint
    withApp(home, (a) => a.kernel.appendEvent('daily-2026-10-10-1', SUN_0654, 'step_done', { i: 0 }, 'p'));
    writeFileSync(join(home, 'daily-attempts.json'), JSON.stringify({ date: '2026-10-10', attempts: [{ at: '2026-10-10T01:30:00.000Z', outcome: 'done' }] }));
    const r = await runCoverage({ ...base(home), clock: ticking(SUN_0654, 2 * 60_000) });
    expect(r).toMatchObject({ status: 'paused' });
    expect(r).not.toHaveProperty('audit');
    expect(withApp(home, (a) => readCheckpoint(a.kernel.db))).toBeUndefined();
  });

  it('too little of the slice left: deferred to the start of the next invocation, before any step', async () => {
    const home = newHome();
    // the reserve is the whole slice: whenever the week completes, the slice is "nearly up"
    const r = await runCoverage({ ...base(home), clock: fixed(SUN_2000), auditReserveMs: Number.MAX_SAFE_INTEGER });
    expect(r).toMatchObject({ status: 'completed', exitCode: 0, audit: { status: 'deferred' } });
    expect(formatCoverageSummary(r)).toContain('audit: the full check of the event chain runs at the start of the next run-coverage');
    expect(withApp(home, (a) => [readCheckpoint(a.kernel.db), a.getSetting(AUDIT_PENDING_KEY)])).toEqual([undefined, r.runId]);
    // the next invocation yields to the daily run before its first step, yet the owed audit ran first
    writeFileSync(join(home, 'daily-attempts.json'), JSON.stringify({ date: '2026-10-10', attempts: [{ at: '2026-10-10T01:30:00.000Z', outcome: 'done' }] }));
    const next = await runCoverage({ ...base(home), clock: fixed('2026-10-12T01:28:00.000Z') });
    expect(next).toMatchObject({ status: 'paused', audit: { status: 'ok' } });
    expect(withApp(home, (a) => [readCheckpoint(a.kernel.db)?.verifiedAt, a.getSetting(AUDIT_PENDING_KEY)])).toEqual(['2026-10-12T01:28:00.000Z', undefined]);
  });

  it('a deferred audit that finds a broken chain fails that next invocation loudly', async () => {
    const home = newHome();
    await runCoverage({ ...base(home), clock: fixed(SUN_2000), auditReserveMs: Number.MAX_SAFE_INTEGER });
    withApp(home, (a) => a.kernel.db.prepare(`UPDATE events SET data = '{"x":1}' WHERE seq = 1`).run());
    writeFileSync(join(home, 'daily-attempts.json'), JSON.stringify({ date: '2026-10-10', attempts: [{ at: '2026-10-10T01:30:00.000Z', outcome: 'done' }] }));
    const posted: string[] = [];
    const next = await runCoverage({ ...base(home), clock: fixed('2026-10-12T01:28:00.000Z'), notifier: async (l) => void posted.push(l) });
    expect(next).toMatchObject({ status: 'paused', exitCode: 1, audit: { status: 'broken', seq: 1 } });
    expect(posted.some((l) => l.startsWith('audit chain broken at seq 1'))).toBe(true);
    expect(formatCoverageSummary(next)).toContain('AUDIT CHAIN BROKEN at seq 1');
  });
});
