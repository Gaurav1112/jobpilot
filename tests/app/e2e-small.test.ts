import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompanyVerdict, Platform } from '../../src/app/coverage/types.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { runDaily, type DailySummary } from '../../src/app/run.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { BUILD, type Where } from '../support/small-feeds.js';

/**
 * Task 9 end to end: one verified company on each of the nine small platforms (fictional, generated offline feeds) is
 * read by the daily run through the real wiring (the registry rows, the symbolic egress, the platform teams, the strict
 * or documented host rules); their postings go through the existing normalizer, eligibility and scorer. Documented
 * APIs are read without robots.txt; Teamtailor, BambooHR, Breezy and Rippling ask it once.
 */
const root = join(import.meta.dirname, '../..');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();

interface Co { platform: Platform; name: string; slug: string; boardUrl: string; where: Where; feed: string; robots: boolean }
const COS: readonly Co[] = [
  { platform: 'workable', name: 'Acme Work', slug: 'acmework', boardUrl: 'https://apply.workable.com/api/v1/widget/accounts/acmework', where: 'blr', feed: 'https://apply.workable.com/api/v1/widget/accounts/acmework?details=true', robots: false },
  { platform: 'recruitee', name: 'Acme Rec', slug: 'acmerec', boardUrl: 'https://acmerec.recruitee.com/api/offers/', where: 'remote-in', feed: 'https://acmerec.recruitee.com/api/offers/', robots: false },
  { platform: 'teamtailor', name: 'Acme Tea', slug: 'career.acme.test', boardUrl: 'https://career.acme.test/jobs.rss', where: 'blr', feed: 'https://career.acme.test/jobs.rss', robots: true },
  { platform: 'personio', name: 'Acme Per', slug: 'acme', boardUrl: 'https://acmeper.jobs.personio.de/xml', where: 'blr', feed: 'https://acmeper.jobs.personio.de/xml', robots: false },
  { platform: 'bamboohr', name: 'Acme Bam', slug: 'acmebam', boardUrl: 'https://acmebam.bamboohr.com/careers/list', where: 'paris', feed: 'https://acmebam.bamboohr.com/careers/list', robots: true },
  { platform: 'breezy', name: 'Acme Bre', slug: 'acmebre', boardUrl: 'https://acmebre.breezy.hr/json', where: 'remote-eu', feed: 'https://acmebre.breezy.hr/json', robots: true },
  { platform: 'pinpoint', name: 'Acme Pin', slug: 'acmepin', boardUrl: 'https://acmepin.pinpointhq.com/postings.json', where: 'blr', feed: 'https://acmepin.pinpointhq.com/postings.json', robots: false },
  { platform: 'rippling', name: 'Acme Rip', slug: 'acmerip', boardUrl: 'https://api.rippling.com/platform/api/ats/v1/board/acmerip/jobs', where: 'blr', feed: 'https://api.rippling.com/platform/api/ats/v1/board/acmerip/jobs', robots: true },
  { platform: 'gem', name: 'Acme Gem', slug: 'acmegem', boardUrl: 'https://api.gem.com/job_board/v0/acmegem/job_posts/', where: 'remote-in', feed: 'https://api.gem.com/job_board/v0/acmegem/job_posts/', robots: false },
];

function verified(c: Co): CompanyVerdict {
  const candidate = { companyKey: `${c.slug.replaceAll('.', '')}.test`, name: c.name, website: 'https://x.test', careersUrl: null, source: 'pick' as const, runDate: '2026-10-11' };
  return { guess: { site: { candidate, careersUrl: 'https://x.test/careers', method: 'listed', evidence: null }, platform: c.platform, slug: c.slug, boardUrl: c.boardUrl, signature: `${c.platform}:a`, routedFrom: null, evidence: [] }, status: 'verified', reasons: ['test'], boardName: null, jobsSeen: 1 };
}

describe.skipIf(pdftotext === undefined)('jobpilot run with a verified company on each small platform (offline, generated feeds)', () => {
  let home: string;
  let fixtures: string;
  let offline: ReturnType<typeof offlineProviders>;
  const run = (refresh = false): Promise<DailySummary> =>
    runDaily({ home, clock: { now: () => '2026-10-14T01:30:00.000Z' }, fetch: offline.fetch, browser: offline.browser, sleep: async () => {}, pdftotext: pdftotext as string, codeHash: 'e2e-small', ...(refresh ? { refresh: true } : {}) });
  const jobs = () => {
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      return Object.fromEntries(app.listJobs({ band: ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'] }).map((j) => [j.company, { verdict: j.verdict, ats: j.ats }]));
    } finally {
      app.close();
    }
  };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-e2e-small-'));
    fixtures = mkdtempSync(join(tmpdir(), 'jobpilot-e2e-small-fx-'));
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    writeFileSync(join(home, 'pack/watchlist.yaml'), 'watchlist: []\n');
    writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: []\n');
    appendFileSync(join(home, 'pack/eligibility.yaml'), 'officeCities: [bengaluru]\n');
    const index: Record<string, unknown> = {};
    mkdirSync(fixtures, { recursive: true });
    for (const c of COS) {
      const body = BUILD[c.platform]!(c.where);
      writeFileSync(join(fixtures, `${c.platform}.feed`), body);
      index[c.feed] = `${c.platform}.feed`;
      if (c.robots) index[`https://${new URL(c.feed).hostname}/robots.txt`] = { status: 404 };
    }
    writeFileSync(join(fixtures, 'index.json'), JSON.stringify(index));
    offline = offlineProviders(fixtures);
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      for (const c of COS) app.upsertCompanyVerdict(verified(c), '2026-10-11T01:30:00.000Z');
    } finally {
      app.close();
    }
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixtures, { recursive: true, force: true });
  });

  it('reads each feed once (robots.txt first only where it governs), and the postings reach the job table with the unchanged eligibility verdicts', async () => {
    const r = await run();
    expect(r.report.status).toBe('completed');
    expect(r.counts.totals.failed).toBe(0);
    // one request per feed; robots.txt (once) before the feed of Teamtailor, BambooHR, Breezy and Rippling only
    const calls = offline.fetch.calls;
    expect(calls).toHaveLength(COS.length + COS.filter((c) => c.robots).length);
    for (const c of COS) {
      const at = calls.indexOf(c.feed);
      expect(at, c.platform).toBeGreaterThanOrEqual(0);
      expect(calls.filter((u) => u === c.feed), c.platform).toHaveLength(1);
      expect(calls.includes(`https://${new URL(c.feed).hostname}/robots.txt`), c.platform).toBe(c.robots);
    }
    expect(jobs()).toEqual({
      'Acme Work': { verdict: 'eligible', ats: 'workable' },
      'Acme Rec': { verdict: 'eligible', ats: 'recruitee' },
      'Acme Tea': { verdict: 'eligible', ats: 'teamtailor' },
      'Acme Per': { verdict: 'eligible', ats: 'personio' },
      // an office in Paris: outside India
      'Acme Bam': { verdict: 'rejected', ats: 'bamboohr' },
      // remote, hiring in France: unclear, never rejected
      'Acme Bre': { verdict: 'review', ats: 'breezy' },
      'Acme Pin': { verdict: 'eligible', ats: 'pinpoint' },
      'Acme Rip': { verdict: 'eligible', ats: 'rippling' },
      'Acme Gem': { verdict: 'eligible', ats: 'gem' },
    });
  }, 180_000);

  it('a --refresh run the same day reads the nine feeds again and changes nothing', async () => {
    const before = offline.fetch.calls.length;
    const r = await run(true);
    expect(r.counts.totals.failed).toBe(0);
    expect(offline.fetch.calls.slice(before)).toHaveLength(COS.length + COS.filter((c) => c.robots).length);
    expect(Object.keys(jobs())).toHaveLength(9);
  }, 180_000);
});
