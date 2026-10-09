import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { runDaily, type DailySummary } from '../../src/app/run.js';
import { AppStore } from '../../src/app/store/app-store.js';

/**
 * Review C1: the careers contracts must not depend on the watchlist. Adding or removing a careers site may never drop
 * the jobs of the other careers sites, on the day of the edit or on any later day (CareerLink replays for up to 7 days).
 */
const root = join(import.meta.dirname, '../..');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();
const OTHER = "  - {company: Other Careers Co, ats: careers, slug: other-careers, listUrl: 'https://jobs.other.example/careers', linkPattern: '^/careers/[a-z0-9-]+$', hiresInIndia: true, allRemote: false}\n";

let home: string;
let now = '';
const clock = { now: () => now };
let offline: ReturnType<typeof offlineProviders>;
const run = (at: string): Promise<DailySummary> => {
  now = at;
  return runDaily({ home, clock, fetch: offline.fetch, browser: offline.browser, notifier: async () => {}, sleep: async () => {}, pdftotext: pdftotext as string });
};
/** The careers jobs this run projected (its rows' last_seen is the run's time). */
const careersSeen = (at: string): string[] => {
  const app = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return app
      .listJobs({ band: ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'] })
      .filter((j) => j.source === 'careers' && j.lastSeen === at)
      .map((j) => j.company)
      .sort();
  } finally {
    app.close();
  }
};
const day = (d: number) => `2026-10-${String(d).padStart(2, '0')}T01:30:00.000Z`;

describe.skipIf(pdftotext === undefined)('editing the careers watchlist never drops the other careers jobs (C1)', () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-c1-'));
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: []\n');
    offline = offlineProviders(join(root, 'tests/fixtures/e2e'));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('adding a careers host: the same day and every day to 2026-10-15, both sites are projected and nothing is quarantined', async () => {
    const first = await run('2026-10-09T01:00:00.000Z');
    expect(careersSeen('2026-10-09T01:00:00.000Z')).toEqual(['Example Careers Co']);
    appendFileSync(join(home, 'pack/watchlist.yaml'), OTHER);
    for (const at of ['2026-10-09T03:00:00.000Z', ...[10, 11, 12, 13, 14, 15].map(day)]) {
      const s = await run(at);
      expect(s.counts.totals.quarantined, at).toBe(0);
      expect(s.counts.byAgent['normalizer']?.quarantined ?? 0, at).toBe(0);
      expect(careersSeen(at), at).toEqual(['Example Careers Co', 'Other Careers Co']);
      expect(s.projection.unresolvedQuarantines, at).toBe(0);
    }
    expect(first.report.status).toBe('completed');
  });

  it('removing a careers host: the remaining site keeps its jobs every day', async () => {
    const lines = readFileSync(join(home, 'pack/watchlist.yaml'), 'utf8').split('\n').filter((l) => !l.includes('other-careers'));
    writeFileSync(join(home, 'pack/watchlist.yaml'), lines.join('\n'));
    for (const at of ['2026-10-15T05:00:00.000Z', day(16), day(17)]) {
      const s = await run(at);
      expect(s.counts.totals.quarantined, at).toBe(0);
      expect(careersSeen(at), at).toEqual(['Example Careers Co']);
    }
  });
});
