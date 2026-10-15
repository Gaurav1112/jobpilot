import { copyFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_REQUEUES, TRANSIENT_RETRY_AFTER_MS } from '../../../src/app/coverage/pipeline.js';
import { runCoverage, type CoverageResult } from '../../../src/app/coverage/run.js';
import { offlineProviders } from '../../../src/app/offline.js';
import { AppStore } from '../../../src/app/store/app-store.js';
import { AwakeClock } from '../../../src/kernel/awake.js';
import { manualTimers } from '../../../src/kernel/fakes.js';
import type { FetchLike } from '../../../src/kernel/providers.js';

/**
 * Sleep-safe review I3, end to end: one re-queue budget per step per run. The pick alpha.test is down for good (every
 * page ECONNRESET; robots.txt answers). Its locate step fails, coverage re-queues it after TRANSIENT_RETRY_AFTER_MS,
 * then the Mac sleeps during that retry: the supervisor's wake rule re-queues it too. Together: at most MAX_REQUEUES
 * re-queues, so the step runs at most 4 times in the run.
 */
const root = join(import.meta.dirname, '../../..');
const FIX = join(root, 'tests/fixtures/coverage/e2e');
const W1 = '2026-10-11T01:30:00.000Z';
const LOCATE = 'coverage-2026-10-11.locate';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('coverage: wake re-queues and transient re-queues share one budget', () => {
  it(`a step that keeps failing runs at most ${MAX_REQUEUES + 1} times, whichever layer re-queues it`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'jobpilot-cov-budget-'));
    homes.push(home);
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    copyFileSync(join(FIX, 'companies.yaml'), join(home, 'pack', 'companies.yaml'));
    const t = manualTimers();
    const awake = new AwakeClock(t);
    let now = Date.parse(W1);
    let armed = false;
    const offline = offlineProviders(FIX).fetch;
    const fetch: FetchLike = async (url, init) => {
      const u = new URL(url);
      if (u.hostname === 'alpha.test' && u.pathname !== '/robots.txt') {
        if (armed) {
          armed = false;
          t.suspend(10 * 60_000); // the lid closes during the retry
          t.advance(1_000);
        }
        throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }) });
      }
      return offline(url, init);
    };
    const invoke = (): Promise<CoverageResult> =>
      runCoverage({ home, clock: { now: () => new Date((now += 1000)).toISOString() }, fetch, sleep: async () => {}, codeHash: 'budget', yieldCheck: () => null, online: async () => true, awake });
    let r = await invoke();
    for (let i = 0; i < 8 && r.status !== 'completed'; i++) {
      now += TRANSIENT_RETRY_AFTER_MS + 60_000;
      armed = true;
      r = await invoke();
    }
    expect(r.status).toBe('completed');
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      const events = app.kernel.events(LOCATE);
      // every run of alpha's locate step failed (nothing else fails here): one step_failed per run
      const runs = events.filter((e) => e.kind === 'step_failed' && (JSON.parse(e.data) as { agent?: unknown }).agent === 'careers-locator');
      expect(events.filter((e) => e.kind === 'coverage.requeued').length).toBeGreaterThan(0);
      expect(events.filter((e) => e.kind === 'wake_requeued').length).toBeGreaterThan(0);
      expect(runs.length).toBe(MAX_REQUEUES + 1);
    } finally {
      app.close();
    }
  });
});
