import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompanyVerdict } from '../../src/app/coverage/types.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { runDaily, type DailySummary } from '../../src/app/run.js';
import { AppStore } from '../../src/app/store/app-store.js';

/**
 * Task 6 end to end: a verified Workday company in the registry is read by the daily run (offline fixtures of a
 * fictional tenant: robots.txt, the facet-discovery page and the India-scoped list by POST, two details), its postings go through the existing
 * normalizer, eligibility and scorer, and the same day's second run fetches nothing.
 */
const root = join(import.meta.dirname, '../..');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();
const BOARD = 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs';

function verified(key: string, name: string, platform: 'workday' | 'greenhouse', slug: string, boardUrl: string): CompanyVerdict {
  const candidate = { companyKey: key, name, website: `https://${key}`, careersUrl: null, source: 'pick' as const, runDate: '2026-10-11' };
  return {
    guess: { site: { candidate, careersUrl: `https://${key}/careers`, method: 'listed', evidence: null }, platform, slug, boardUrl, signature: `${platform}:a`, routedFrom: null, evidence: [] },
    status: 'verified',
    reasons: ['test'],
    boardName: null,
    jobsSeen: 3,
  };
}

describe.skipIf(pdftotext === undefined)('jobpilot run with a verified Workday company (offline fixtures)', () => {
  let home: string;
  let offline: ReturnType<typeof offlineProviders>;
  let now = '2026-10-14T01:30:00.000Z';
  const run = (): Promise<DailySummary> => runDaily({ home, clock: { now: () => now }, fetch: offline.fetch, browser: offline.browser, sleep: async () => {}, pdftotext: pdftotext as string, codeHash: 'e2e-workday' });

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-e2e-wd-'));
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    writeFileSync(join(home, 'pack/watchlist.yaml'), 'watchlist: []\n');
    writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: []\n');
    appendFileSync(join(home, 'pack/eligibility.yaml'), 'officeCities: [bengaluru]\n');
    offline = offlineProviders(join(root, 'tests/fixtures/e2e-workday'));
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      app.upsertCompanyVerdict(verified('acmefreight.test', 'Acme Freight', 'workday', 'acme/External', BOARD), '2026-10-11T01:30:00.000Z');
      // a proposed or rejected Workday company is never read
      app.upsertCompanyVerdict({ ...verified('other.test', 'Other', 'workday', 'other/External', 'https://other.wd1.myworkdayjobs.com/wday/cxs/other/External/jobs'), status: 'proposed' }, '2026-10-11T01:30:00.000Z');
    } finally {
      app.close();
    }
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('reads the board (robots.txt, the list by POST, details for the titles the pre-filter passes) into job rows', async () => {
    const r = await run();
    expect(r.report.status).toBe('completed');
    expect(r.counts.totals.failed).toBe(0);
    expect(offline.fetch.calls).toEqual([
      'https://acme.wd5.myworkdayjobs.com/robots.txt',
      // facet discovery, the India-scoped list (the fixture's facets name no remote type), the Bengaluru office list
      BOARD,
      BOARD,
      BOARD,
      'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/India-Bengaluru/Senior-Backend-Engineer_R-501',
      'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/US-CA-Santa-Clara/Senior-Software-Engineer--Payments-Platform_R-502',
    ]);
    expect(r.counts.byAgent['src-workday']).toMatchObject({ done: 1, failed: 0 });
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      const rows = Object.fromEntries(app.listJobs({ band: ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'] }).map((j) => [j.title, { verdict: j.verdict, ats: j.ats, company: j.company, location: j.location, url: j.url }]));
      expect(rows).toEqual({
        'Senior Backend Engineer': { verdict: 'eligible', ats: 'workday', company: 'Acme Freight', location: 'India, Bengaluru', url: 'https://acme.wd5.myworkdayjobs.com/External/job/India-Bengaluru/Senior-Backend-Engineer_R-501' },
        'Senior Software Engineer, Payments Platform': {
          verdict: 'eligible',
          ats: 'workday',
          company: 'Acme Freight',
          location: 'US, CA, Santa Clara; India, Bengaluru',
          url: 'https://acme.wd5.myworkdayjobs.com/External/job/US-CA-Santa-Clara/Senior-Software-Engineer--Payments-Platform_R-502',
        },
        // no detail (the title pre-filter), judged on its listed location: Pune is not an office city
        'Account Executive': { verdict: 'rejected', ats: 'workday', company: 'Acme Freight', location: 'India, Pune', url: 'https://acme.wd5.myworkdayjobs.com/External/job/India-Pune/Account-Executive_R-503' },
      });
    } finally {
      app.close();
    }
  }, 120_000);

  it('a second run the same day fetches nothing: the Workday step replays', async () => {
    const before = offline.fetch.calls.length;
    now = '2026-10-14T04:30:00.000Z';
    const r = await run();
    expect(r.runId).toBe('daily-2026-10-14-2');
    expect(offline.fetch.calls.length).toBe(before);
    expect(r.counts.byAgent['src-workday']?.replayed).toBe(1);
  }, 120_000);
});
