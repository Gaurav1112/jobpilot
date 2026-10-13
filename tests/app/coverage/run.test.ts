import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCoverage } from '../../../src/app/coverage/run.js';
import { COVERAGE_DUE, due } from '../../../src/app/due.js';
import { runFreelance } from '../../../src/app/freelance/run.js';
import { runCoverageCommand } from '../../../src/app/run-command.js';
import { AppStore } from '../../../src/app/store/app-store.js';
import { withLock } from '../../../src/app/lock.js';

const root = join(import.meta.dirname, '../../..');
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-cov-run-'));
  homes.push(home);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  return home;
}
// 2026-10-11 is a Sunday; 01:30Z = 07:00 IST.
const SUN_0700 = '2026-10-11T01:30:00.000Z';
const MON_1000 = '2026-10-12T04:30:00.000Z';
const BAD = 'companies:\n  - {website: https://x.test}\n';

describe('runCoverage (empty pipeline)', () => {
  it('takes the lock, runs as coverage-<IST date> and completes; a second run the same day is -2', async () => {
    const home = newHome();
    const a = await runCoverage({ home, clock: { now: () => SUN_0700 } });
    expect(a).toMatchObject({ runId: 'coverage-2026-10-11', resumed: false, exitCode: 0 });
    const b = await runCoverage({ home, clock: { now: () => SUN_0700 } });
    expect(b.runId).toBe('coverage-2026-10-11-2');
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(app.kernel.getRun('coverage-2026-10-11')).toMatchObject({ pipeline: 'jobpilot-coverage', status: 'completed' });
      expect(app.kernel.events('coverage-2026-10-11').map((e) => e.kind)).toEqual(['coverage.summary']);
    } finally {
      app.close();
    }
  });

  it('holds the lock while it runs', async () => {
    const home = newHome();
    await withLock(home, 'run', async () => {
      await expect(runCoverage({ home, clock: { now: () => SUN_0700 } })).rejects.toThrow(/another jobpilot process/);
    });
  });

  it('refuses a malformed companies.yaml, and writes no run', async () => {
    const home = newHome();
    writeFileSync(join(home, 'pack', 'companies.yaml'), BAD);
    await expect(runCoverage({ home, clock: { now: () => SUN_0700 } })).rejects.toThrow(/companies\.yaml/);
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(app.kernel.getRun('coverage-2026-10-11')).toBeUndefined();
    } finally {
      app.close();
    }
  });
});

describe('run-coverage --if-due end to end', () => {
  const deps = (home: string, now: string, out: string[]) => ({ home, clock: { now: () => now }, notifier: async () => {}, out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`), online: async () => true });

  it('Sunday 05:59 does nothing; Monday catch-up runs once; a later start the same week is not due', async () => {
    const home = newHome();
    const out: string[] = [];
    expect(await runCoverageCommand({ ifDue: true, notify: false }, deps(home, '2026-10-11T00:29:00.000Z', out))).toBe(0);
    expect(out).toEqual(['not due: before Sunday 06:00 IST']);
    out.length = 0;
    expect(await runCoverageCommand({ ifDue: true, notify: false }, deps(home, MON_1000, out))).toBe(0);
    expect(out.join('\n')).toMatch(/^run coverage-2026-10-12 for 2026-10-12: completed/);
    expect(due(COVERAGE_DUE, home, '2026-10-14T04:30:00.000Z')).toMatchObject({ due: false, reason: "this coverage week's run completed" });
    const attempts = JSON.parse(readFileSync(join(home, 'coverage-attempts.json'), 'utf8')) as { date: string; attempts: { outcome: string }[] };
    expect(attempts).toMatchObject({ date: '2026-10-11', attempts: [{ outcome: 'done' }] });
    expect(due(COVERAGE_DUE, home, '2026-10-18T00:30:00.000Z')).toMatchObject({ due: true });
  });

  it('a refused pack is a failed attempt (exit 2), counted toward the weekly cap', async () => {
    const home = newHome();
    writeFileSync(join(home, 'pack', 'companies.yaml'), BAD);
    const out: string[] = [];
    expect(await runCoverageCommand({ ifDue: true, notify: false }, deps(home, SUN_0700, out))).toBe(2);
    expect(out.join('\n')).toMatch(/^ERR error: .*companies\.yaml/m);
    expect(JSON.parse(readFileSync(join(home, 'coverage-attempts.json'), 'utf8')).attempts).toMatchObject([{ outcome: 'failed' }]);
  });
});

describe('a malformed companies.yaml and the freelance run', () => {
  it('the freelance run completes with a warning; run-coverage refuses', async () => {
    const home = newHome();
    writeFileSync(join(home, 'pack', 'companies.yaml'), BAD);
    const s = await runFreelance({ home, clock: { now: () => '2026-10-12T03:00:00.000Z' }, fetch: async () => { throw new Error('no network in this test'); }, sleep: async () => {}, pdftotext: '/usr/bin/false' });
    expect(s.warnings.join('\n')).toMatch(/companies\.yaml.*the freelance run ignores this file/);
    await expect(runCoverage({ home, clock: { now: () => MON_1000 } })).rejects.toThrow(/companies\.yaml/);
  });
});
