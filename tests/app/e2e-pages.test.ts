import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompanyVerdict, Platform } from '../../src/app/coverage/types.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { runDaily, type DailySummary } from '../../src/app/run.js';
import { AppStore } from '../../src/app/store/app-store.js';

/**
 * Task 8 end to end: a verified iCIMS company and a verified jsonld-sitemap company (fictional, offline fixtures) are
 * read by the daily run: robots.txt, the sitemap, the title-passing job pages; their postings go through the existing
 * normalizer, eligibility and scorer. The page state lands in the app DB (`platform_pages`). A `--refresh` run the same
 * day reads the sitemaps again but no job page, and keeps every posting; eight days later the pages are stale and are
 * read again.
 */
const root = join(import.meta.dirname, '../..');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();
const IC = 'https://careers-acme.icims.com';
const BE = 'https://www.betaco.test';
const PAGES = [`${IC}/jobs/101/senior-backend-engineer/job?in_iframe=1`, `${IC}/jobs/102/staff-software-engineer/job?in_iframe=1`, `${BE}/careers/lead-platform-engineer-4401/`];

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

describe.skipIf(pdftotext === undefined)('jobpilot run with verified iCIMS and jsonld-sitemap companies (offline fixtures)', () => {
  let home: string;
  let offline: ReturnType<typeof offlineProviders>;
  let now = '2026-10-14T01:30:00.000Z';
  const run = (refresh = false): Promise<DailySummary> =>
    runDaily({ home, clock: { now: () => now }, fetch: offline.fetch, browser: offline.browser, sleep: async () => {}, pdftotext: pdftotext as string, codeHash: 'e2e-pages', ...(refresh ? { refresh: true } : {}) });
  const pageRows = (): { board: string; url: string; fetched_on: string }[] => {
    const d = new Database(join(home, 'jobpilot.db'), { readonly: true });
    try {
      return d.prepare('SELECT board, url, fetched_on FROM platform_pages ORDER BY board, url').all() as { board: string; url: string; fetched_on: string }[];
    } finally {
      d.close();
    }
  };
  /** The app_settings ledgers (run.ts wiring: Oracle's list pages and the page adapters' job pages per IST day). */
  const ledgers = (): Record<string, string> => {
    const d = new Database(join(home, 'jobpilot.db'), { readonly: true });
    try {
      return Object.fromEntries((d.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'pages.%' OR key LIKE 'oracle.pages.%' ORDER BY key`).all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    } finally {
      d.close();
    }
  };
  const jobs = () => {
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      return Object.fromEntries(app.listJobs({ band: ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'] }).map((j) => [j.title, { verdict: j.verdict, ats: j.ats, company: j.company, location: j.location, lastSeen: j.lastSeen }]));
    } finally {
      app.close();
    }
  };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-e2e-pages-'));
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    writeFileSync(join(home, 'pack/watchlist.yaml'), 'watchlist: []\n');
    writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: []\n');
    appendFileSync(join(home, 'pack/eligibility.yaml'), 'officeCities: [bengaluru]\n');
    offline = offlineProviders(join(root, 'tests/fixtures/e2e-pages'));
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      app.upsertCompanyVerdict(verified('acmerobotics.test', 'Acme Robotics', 'icims', 'careers-acme.icims.com', `${IC}/sitemap.xml`), '2026-10-11T01:30:00.000Z');
      app.upsertCompanyVerdict(verified('betaco.test', 'Beta Co', 'jsonld-sitemap', 'www.betaco.test', `${BE}/sitemap.xml`), '2026-10-11T01:30:00.000Z');
    } finally {
      app.close();
    }
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('reads robots.txt, the sitemaps and the title-passing job pages into job rows; the page state is kept', async () => {
    const r = await run();
    expect(r.report.status).toBe('completed');
    expect(r.counts.totals.failed).toBe(0);
    expect(offline.fetch.calls).toEqual([`${IC}/robots.txt`, `${IC}/sitemap.xml`, PAGES[0], PAGES[1], `${BE}/robots.txt`, `${BE}/sitemap.xml`, PAGES[2]]);
    expect(jobs()).toEqual({
      'Senior Backend Engineer': { verdict: 'eligible', ats: 'icims', company: 'Acme Robotics', location: 'Bengaluru, Karnataka, IN', lastSeen: now },
      // Pune is not an office city: onsite elsewhere
      'Staff Software Engineer': { verdict: 'rejected', ats: 'icims', company: 'Acme Robotics', location: 'Pune, Maharashtra, IN', lastSeen: now },
      // remote, applicants in India
      'Lead Platform Engineer': { verdict: 'eligible', ats: 'jsonld-sitemap', company: 'Beta Co', location: 'Bengaluru, Karnataka, IN', lastSeen: now },
    });
    expect(pageRows()).toEqual([
      { board: 'icims careers-acme.icims.com', url: `${IC}/jobs/101/senior-backend-engineer/job`, fetched_on: '2026-10-14' },
      { board: 'icims careers-acme.icims.com', url: `${IC}/jobs/102/staff-software-engineer/job`, fetched_on: '2026-10-14' },
      { board: 'jsonld-sitemap www.betaco.test', url: `${BE}/careers/lead-platform-engineer-4401/`, fetched_on: '2026-10-14' },
    ]);
    // fix round 1, the run.ts wiring: the day's job pages per board are counted in the app DB (removing it fails here)
    expect(ledgers()).toEqual({ 'pages.fetched.2026-10-14.icims careers-acme.icims.com': '2', 'pages.fetched.2026-10-14.jsonld-sitemap www.betaco.test': '1' });
    // the account executive's page is never fetched (the title pre-filter), and named
    expect(r.warnings).toContainEqual(expect.stringMatching(/^src-icims: title-prefilter Acme Robotics: 1 of 3 listed jobs not fetched/));
  }, 120_000);

  it('a --refresh run the same day reads the sitemaps but no job page, and keeps every posting', async () => {
    const before = offline.fetch.calls.length;
    now = '2026-10-14T04:30:00.000Z';
    const r = await run(true);
    expect(r.counts.totals.failed).toBe(0);
    expect(offline.fetch.calls.slice(before)).toEqual([`${IC}/robots.txt`, `${IC}/sitemap.xml`, `${BE}/robots.txt`, `${BE}/sitemap.xml`]);
    expect(ledgers()).toEqual({ 'pages.fetched.2026-10-14.icims careers-acme.icims.com': '2', 'pages.fetched.2026-10-14.jsonld-sitemap www.betaco.test': '1' });
    const j = jobs();
    expect(Object.keys(j).sort()).toEqual(['Lead Platform Engineer', 'Senior Backend Engineer', 'Staff Software Engineer']);
    // kept alive: seen by this run too
    expect(Object.values(j).every((x) => x.lastSeen === now)).toBe(true);
    // the kept postings replay the normalizer: nothing changed
    expect(r.counts.byAgent['normalizer']?.replayed).toBe(3);
  }, 120_000);

  it('eight days later the pages are stale: read again, the state moves on', async () => {
    const before = offline.fetch.calls.length;
    now = '2026-10-22T01:30:00.000Z';
    await run();
    expect(offline.fetch.calls.slice(before)).toEqual([`${IC}/robots.txt`, `${IC}/sitemap.xml`, PAGES[0], PAGES[1], `${BE}/robots.txt`, `${BE}/sitemap.xml`, PAGES[2]]);
    expect(pageRows().map((p) => p.fetched_on)).toEqual(['2026-10-22', '2026-10-22', '2026-10-22']);
    // a new IST day: a fresh count, the other days pruned
    expect(ledgers()).toEqual({
      'pages.fetched.2026-10-22.icims careers-acme.icims.com': '2',
      // fix round 3: the day's stale refetches, against the per-day stale reserve
      'pages.fetched.2026-10-22.icims careers-acme.icims.com stale': '2',
      'pages.fetched.2026-10-22.jsonld-sitemap www.betaco.test': '1',
      'pages.fetched.2026-10-22.jsonld-sitemap www.betaco.test stale': '1',
    });
  }, 120_000);
});
