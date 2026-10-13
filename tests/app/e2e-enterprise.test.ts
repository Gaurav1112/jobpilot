import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompanyVerdict, Platform } from '../../src/app/coverage/types.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { runDaily, type DailySummary } from '../../src/app/run.js';
import { AppStore } from '../../src/app/store/app-store.js';

/**
 * Task 7 end to end: a verified Eightfold company (v2, a fictional tenant) and a verified Oracle Recruiting Cloud
 * company (a fictional site whose robots.txt answers 403, as Oracle's WAF does) in the registry are read by the daily
 * run from offline fixtures, their postings go through the existing normalizer, eligibility and scorer, and the same
 * day's second run fetches nothing.
 */
const root = join(import.meta.dirname, '../..');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();
const EF = 'https://acme.eightfold.ai';
const OR = 'https://acme.fa.us2.oraclecloud.com';
const OR_LIST = `${OR}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=CX_1,facetsList=LOCATIONS%3BWORKPLACE_TYPES,limit=100,offset=0`;

function verified(key: string, name: string, platform: Platform, slug: string, boardUrl: string): CompanyVerdict {
  const candidate = { companyKey: key, name, website: `https://${key}`, careersUrl: null, source: 'pick' as const, runDate: '2026-10-11' };
  return {
    guess: { site: { candidate, careersUrl: `https://${key}/careers`, method: 'listed', evidence: null }, platform, slug, boardUrl, signature: `${platform}:a`, routedFrom: null, evidence: [] },
    status: 'verified',
    reasons: ['test'],
    boardName: null,
    jobsSeen: 3,
  };
}

describe.skipIf(pdftotext === undefined)('jobpilot run with verified Eightfold and Oracle companies (offline fixtures)', () => {
  let home: string;
  let offline: ReturnType<typeof offlineProviders>;
  let now = '2026-10-14T01:30:00.000Z';
  const run = (): Promise<DailySummary> => runDaily({ home, clock: { now: () => now }, fetch: offline.fetch, browser: offline.browser, sleep: async () => {}, pdftotext: pdftotext as string, codeHash: 'e2e-enterprise' });

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-e2e-ent-'));
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    writeFileSync(join(home, 'pack/watchlist.yaml'), 'watchlist: []\n');
    writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: []\n');
    appendFileSync(join(home, 'pack/eligibility.yaml'), 'officeCities: [bengaluru]\n');
    offline = offlineProviders(join(root, 'tests/fixtures/e2e-enterprise'));
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      app.upsertCompanyVerdict(verified('acmefreight.test', 'Acme Freight', 'eightfold', 'acme.eightfold.ai/acmefreight.test', `${EF}/api/apply/v2/jobs?domain=acmefreight.test`), '2026-10-11T01:30:00.000Z');
      app.upsertCompanyVerdict(verified('betabank.test', 'Beta Bank', 'oracle', 'acme.fa.us2.oraclecloud.com/CX_1', `${OR}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=CX_1`), '2026-10-11T01:30:00.000Z');
      // a proposed Eightfold company is never read
      app.upsertCompanyVerdict({ ...verified('other.test', 'Other', 'eightfold', 'other.eightfold.ai/other.test', 'https://other.eightfold.ai/api/apply/v2/jobs?domain=other.test'), status: 'proposed' }, '2026-10-11T01:30:00.000Z');
    } finally {
      app.close();
    }
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('reads both boards (robots.txt, the API, discovery, the India list, rank-0 details) into job rows', async () => {
    const r = await run();
    expect(r.report.status).toBe('completed');
    expect(r.counts.totals.failed).toBe(0);
    expect(offline.fetch.calls.filter((c) => c.startsWith(EF))).toEqual([
      `${EF}/robots.txt`,
      `${EF}/careers?domain=acmefreight.test`,
      `${EF}/api/apply/v2/jobs?domain=acmefreight.test&start=0&num=10`,
      `${EF}/api/apply/v2/jobs?domain=acmefreight.test&start=0&num=10&location=India`,
      // only the title-passing India job gets a detail
      `${EF}/api/apply/v2/jobs/601?domain=acmefreight.test`,
    ]);
    expect(offline.fetch.calls.filter((c) => c.startsWith(OR))).toEqual([
      // robots.txt answers 403: unknown, read at the minimal rate
      `${OR}/robots.txt`,
      OR_LIST,
      `${OR_LIST},locationId=7001`,
      `${OR}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22701%22,siteNumber=CX_1`,
    ]);
    expect(offline.fetch.calls.some((c) => c.includes('other.eightfold.ai'))).toBe(false);
    // every source gets every seed and answers only its own: each platform step runs twice (its company, the other's)
    expect(r.counts.byAgent['src-eightfold']).toMatchObject({ done: 2, failed: 0 });
    expect(r.counts.byAgent['src-oracle']).toMatchObject({ done: 2, failed: 0 });
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      const rows = Object.fromEntries(app.listJobs({ band: ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'] }).map((j) => [j.title, { verdict: j.verdict, ats: j.ats, company: j.company, location: j.location, url: j.url }]));
      expect(rows).toEqual({
        'Senior Backend Engineer': { verdict: 'eligible', ats: 'eightfold', company: 'Acme Freight', location: 'Bengaluru, KA, India', url: `${EF}/careers/job/601` },
        // no detail (the title pre-filter), judged on its listed location: Pune is not an office city
        'Account Executive': { verdict: 'rejected', ats: 'eightfold', company: 'Acme Freight', location: 'Pune, MH, India', url: `${EF}/careers/job/602` },
        'Staff Software Engineer': { verdict: 'eligible', ats: 'oracle', company: 'Beta Bank', location: 'Bengaluru, Karnataka, India', url: `${OR}/hcmUI/CandidateExperience/en/sites/CX_1/job/701` },
        'Relationship Manager': { verdict: 'rejected', ats: 'oracle', company: 'Beta Bank', location: 'Mumbai, Maharashtra, India', url: `${OR}/hcmUI/CandidateExperience/en/sites/CX_1/job/702` },
      });
    } finally {
      app.close();
    }
  }, 120_000);

  it('a second run the same day fetches nothing: both platform steps replay', async () => {
    const before = offline.fetch.calls.length;
    now = '2026-10-14T04:30:00.000Z';
    const r = await run();
    expect(r.runId).toBe('daily-2026-10-14-2');
    expect(offline.fetch.calls.length).toBe(before);
    expect(r.counts.byAgent['src-eightfold']?.replayed).toBe(2);
    expect(r.counts.byAgent['src-oracle']?.replayed).toBe(2);
  }, 120_000);
});
