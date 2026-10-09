import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { loadPack } from '../../src/app/pack/load.js';
import { runCommand } from '../../src/app/run-command.js';
import { runDaily, type RunOptions } from '../../src/app/run.js';
import { AppStore } from '../../src/app/store/app-store.js';

/**
 * Review R-I2: every ready job is announced exactly once, whenever it becomes ready, and only by a notification that
 * was actually posted. Plus the failure notification of a run that cannot run (exit 2), through the CLI's code path.
 */
const root = join(import.meta.dirname, '../..');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();
const FIXTURES = join(root, 'tests/fixtures/e2e');
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-notify-'));
  homes.push(home);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  return home;
}
const sink = () => {
  const posted: string[] = [];
  return { posted, notifier: async (t: string) => void posted.push(t) };
};
const runAt = (home: string, at: string, extra: Partial<RunOptions> = {}) => {
  const off = offlineProviders(FIXTURES);
  return runDaily({ home, clock: { now: () => at }, fetch: off.fetch, browser: off.browser, sleep: async () => {}, pdftotext: pdftotext as string, ...extra });
};
const announced = (home: string): (string | null)[] => {
  const app = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return app.listJobs({}).filter((j) => j.docsState === 'ready').map((j) => j.notifiedAt);
  } finally {
    app.close();
  }
};

describe.skipIf(pdftotext === undefined)('announcements (R-I2)', () => {
  it('a failing notifier stamps nothing; the next run with a working one announces the jobs, once', async () => {
    const home = newHome();
    const failing = await runAt(home, '2026-10-09T01:30:00.000Z', { notifier: async () => Promise.reject(new Error('osascript: not allowed')) });
    expect(failing.notified).toBe(false);
    expect(failing.warnings).toContain('the notification could not be posted: osascript: not allowed');
    expect(announced(home)).toEqual([null, null, null]);
    const ok = sink();
    const second = await runAt(home, '2026-10-09T02:30:00.000Z', { notifier: ok.notifier });
    expect(second.notification).toMatch(/^3 new matches · top: 94 Example Lever Co — Staff Platform Engineer$/);
    expect(announced(home)).toEqual(['2026-10-09T02:30:00.000Z', '2026-10-09T02:30:00.000Z', '2026-10-09T02:30:00.000Z']);
    expect((await runAt(home, '2026-10-09T03:30:00.000Z', { notifier: ok.notifier })).notification).toBe('No new matches today');
  });

  it('--no-notify (no notifier) stamps nothing and says so; the next normal run announces', async () => {
    const home = newHome();
    const quiet = await runAt(home, '2026-10-09T01:30:00.000Z');
    expect(quiet.notified).toBe(false);
    expect(quiet.warnings).toContain('not announced (--no-notify): 3');
    expect(announced(home)).toEqual([null, null, null]);
    const ok = sink();
    expect((await runAt(home, '2026-10-09T02:30:00.000Z', { notifier: ok.notifier })).notification).toMatch(/^3 new matches/);
  });

  it('a job that turns ready after facts verify is announced when it turns ready', async () => {
    const home = newHome();
    const facts = loadPack(join(home, 'pack'), {}, { asOf: '2026-10' }).pack.facts;
    const set = (status: 'rejected' | 'verified') => {
      const app = AppStore.open(join(home, 'jobpilot.db'));
      try {
        for (const f of facts) app.setFactOverride(f.id, status, '2026-10-09T00:00:00.000Z');
      } finally {
        app.close();
      }
    };
    set('rejected'); // nothing citeable: no documents can be grounded
    const ok = sink();
    const before = await runAt(home, '2026-10-09T01:30:00.000Z', { notifier: ok.notifier });
    expect(before.projection.docs.ready).toBe(0);
    expect(before.notification).toMatch(/^No new matches today/);
    set('verified'); // `jobpilot facts verify <id>` for each
    const after = await runAt(home, '2026-10-10T01:30:00.000Z', { notifier: ok.notifier });
    expect(after.projection.docs.ready).toBe(3);
    expect(after.notification).toMatch(/^3 new matches/);
  });

  it('a crash between projection and notification: the next run announces the jobs', async () => {
    const home = newHome();
    const ok = sink();
    await expect(
      runAt(home, '2026-10-09T01:30:00.000Z', { notifier: ok.notifier, afterProject: () => { throw new Error('crash before notifying'); } }),
    ).rejects.toThrow('crash before notifying');
    expect(ok.posted).toEqual([]);
    const next = await runAt(home, '2026-10-09T02:30:00.000Z', { notifier: ok.notifier });
    expect(next.runId).toBe('daily-2026-10-09-2');
    expect(next.notification).toMatch(/^3 new matches/);
  });
});

describe('the failure notification path (exit 2)', () => {
  it('posts "jobpilot run failed: <reason>" through the notifier and returns exit code 2', async () => {
    const home = newHome();
    writeFileSync(join(home, 'pack/policy.user.yaml'), 'minHostIntervalMs: 40000\n');
    const ok = sink();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCommand(
      { offlineFixtures: FIXTURES, notify: true },
      { home, clock: { now: () => '2026-10-09T01:30:00.000Z' }, notifier: ok.notifier, out: (l) => out.push(l), err: (l) => err.push(l), ...(pdftotext ? { pdftotext } : {}) },
    );
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/minHostIntervalMs 40000 ms breaks/);
    expect(ok.posted).toEqual(['jobpilot run failed: refusing to start:']);
    expect(out).toEqual([]);
  });

  it('a clean run returns 0 and posts the match notification', async () => {
    if (pdftotext === undefined) return;
    const home = newHome();
    const ok = sink();
    const out: string[] = [];
    const code = await runCommand(
      { offlineFixtures: FIXTURES, notify: true },
      { home, clock: { now: () => '2026-10-09T01:30:00.000Z' }, notifier: ok.notifier, out: (l) => out.push(l), err: () => {}, pdftotext, sleep: async () => {} },
    );
    expect(code).toBe(0);
    expect(ok.posted).toEqual(['3 new matches · top: 94 Example Lever Co — Staff Platform Engineer']);
    expect(out.join('\n')).toMatch(/^run daily-2026-10-09 for 2026-10-09/);
  });
});
