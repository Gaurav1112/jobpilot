import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildReport, coverageProbeCommand, formatReport, parseDays, reasonLabel, type CoverageProbeReport } from '../../../src/app/coverage/probe.js';
import { LOCK_FILE, LockError } from '../../../src/app/lock.js';
import { homePaths } from '../../../src/app/pack/paths.js';
import { AppStore, type JobUpsert } from '../../../src/app/store/app-store.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { jobRow } from '../../support/app-fixtures.js';

// offline only: any request is a failure
vi.stubGlobal('fetch', () => {
  throw new Error('the coverage probe must not use the network');
});

const root = join(import.meta.dirname, '../../..');
const NOW = '2026-10-14T04:00:00.000Z'; // Wednesday, IST 09:30; the coverage week starts Sunday 2026-10-11
const D0 = '2026-10-14T02:00:00.000Z';
const D2 = '2026-10-12T02:00:00.000Z';
const D10 = '2026-10-04T02:00:00.000Z';
const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const CO = 'Example Identity Co';
const ghRow = (key: string, board: string, id: string, over: Partial<JobUpsert> = {}): JobUpsert =>
  jobRow({ jobKey: key, source: 'greenhouse', sourceId: id, slug: board, company: CO, dedupeKey: `${key}`.padEnd(16, '0'), atsJob: { platform: 'greenhouse', board, id }, ...over });
const wdRow = (key: string, id: string, over: Partial<JobUpsert> = {}): JobUpsert =>
  jobRow({
    jobKey: key, source: 'workday', sourceId: `acme.wd5.myworkdayjobs.com/acme/External|${id}`, slug: 'acme.wd5.myworkdayjobs.com/acme/External', company: 'Acme', ats: 'workday',
    dedupeKey: `${key}`.padEnd(16, '0'), atsJob: { platform: 'workday', board: 'acme', id }, title: `Engineer ${id}`, ...over,
  });

interface Home {
  readonly home: string;
  readonly app: AppStore;
}
function makeHome(): Home {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-covprobe-'));
  tmps.push(home);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  const app = AppStore.open(homePaths(home).db);
  return { home, app };
}
const insertCompany = (app: AppStore, key: string, name: string, platform: string | null, status: string, boardUrl: string | null = null, slug: string | null = null): void => {
  app.kernel.db
    .prepare(`INSERT INTO companies (company_key, name, website, platform, platform_slug, board_url, status, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'picks', 'a')`)
    .run(key, name, `https://${key}`, platform, slug, boardUrl, status);
};
const WD_URL = 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs';
const ORACLE_URL = 'https://jpmc.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=CX_1001';
const reportOf = (h: Home, days = 7, forbidden: string[] = []): CoverageProbeReport =>
  buildReport({ app: h.app, now: NOW, days, minFit: 60, watchlist: new Set(['greenhouse example-gh']), naming: { forbiddenTerms: forbidden } });

let h: Home;
beforeAll(() => {
  h = makeHome();
  const a = h.app;
  // companies
  insertCompany(a, 'nvidia.com', 'NVIDIA', 'workday', 'verified', WD_URL);
  insertCompany(a, 'sf.com', 'Salesforce', 'workday', 'proposed');
  insertCompany(a, 'jpm.com', 'JPMorgan Chase', 'oracle', 'verified', ORACLE_URL);
  insertCompany(a, 'x.com', 'X', 'icims', 'failing');
  insertCompany(a, 'y.com', 'Y', null, 'rejected');
  insertCompany(a, 'z.com', 'Z', 'workday', 'rejected');
  // jobs: the new-jobs rule
  a.upsertJob(wdRow('1000000000000001', 'JR1', { at: D0, verdict: 'eligible', score: 80 })); // new, passes
  a.upsertJob(wdRow('1000000000000002', 'JR2', { at: D0, verdict: 'review', score: 50 })); // new, below minFit
  a.upsertJob(wdRow('1000000000000003', 'JR3', { at: D2, verdict: 'review', score: 65 })); // new, passes
  a.upsertJob(wdRow('1000000000000004', 'JR4', { at: D10, verdict: 'eligible', score: 80 })); // outside 7 days
  a.upsertJob(wdRow('1000000000000005', 'JR5', { at: D0, verdict: 'rejected', score: 90 })); // new, never passes even with a high fit
  // a registry Greenhouse board seen on a company page too: NOT new
  a.upsertJob(ghRow('2000000000000001', 'reg-board', '7001', { at: D2, verdict: 'eligible' }));
  a.upsertJob(
    jobRow({
      jobKey: '2000000000000002', source: 'careers', sourceId: 'p1', slug: 'reg-careers', company: CO, ats: 'careers', dedupeKey: '2222222222222222', title: 'Senior Backend Engineer (Identity Platform)',
      url: 'https://www.identity.example/careers/opportunity/7001?gh_jid=7001', atsJob: { platform: 'greenhouse', board: null, id: '7001' }, at: D0,
    }),
  );
  // a registry Greenhouse board seen only there: new
  a.upsertJob(ghRow('2000000000000003', 'reg-board', '7002', { at: D0, verdict: 'eligible', title: 'Staff Platform Engineer' }));
  // a watchlist Greenhouse board: an existing source, not new
  a.upsertJob(ghRow('2000000000000004', 'example-gh', '9001', { at: D0, verdict: 'eligible', title: 'Data Engineer', company: 'Example Greenhouse Co' }));
  // a Workday job whose same job (v1 dedupe key) a feed lists later: the feed row is its duplicate: NOT new
  const same = 'abababababababab';
  a.upsertJob(wdRow('3000000000000001', 'JR9', { at: D2, dedupeKey: same, title: 'Platform Engineer', verdict: 'eligible', atsJob: null }));
  a.upsertJob(jobRow({ jobKey: '3000000000000002', source: 'remotive', sourceId: 'r1', slug: 'remotive', company: 'Acme', ats: 'feed', dedupeKey: same, title: 'Platform Engineer', at: D0 }));
  // a feed lists a job first and Workday lists it later: the Workday row is the duplicate, never new
  const same2 = 'cdcdcdcdcdcdcdcd';
  a.upsertJob(jobRow({ jobKey: '3000000000000003', source: 'remotive', sourceId: 'r2', slug: 'remotive', company: 'Acme', ats: 'feed', dedupeKey: same2, title: 'Data Platform Lead', at: D2 }));
  a.upsertJob(wdRow('3000000000000004', 'JR10', { at: D0, dedupeKey: same2, title: 'Data Platform Lead', verdict: 'eligible', atsJob: null }));
  // ledgers (today's; yesterday's and the stale sub-count are not summed)
  a.setSetting('pages.fetched.2026-10-14.icims acme.icims.com', '12');
  a.setSetting('pages.fetched.2026-10-14.icims acme.icims.com stale', '5');
  a.setSetting('oracle.pages.2026-10-14.jpmc.fa.oraclecloud.com/CX_1001', '4');
  // the latest daily run's problems and named skips
  a.recordRun({
    runId: 'daily-2026-10-14', at: NOW, counts: {}, packHash: 'p', policyHash: 'q',
    warnings: ['src-workday: robots-disallow host.example (/wday): NVIDIA not read today', 'src-icims: page-budget Acme: 3 pages left over', 'unrelated warning'],
    problems: [{ kind: 'deferred', agent: 'src-workday', item: 'Salesforce', reason: 'host-disabled:429 on salesforce.wd12.myworkdayjobs.com' }, { kind: 'failed', agent: 'src-normalizer', item: 'x', reason: 'boom' }],
  });
  // a coverage run this week that deferred companies
  a.kernel.startRun('coverage-2026-10-12', 'coverage', 'pol', NOW);
  a.kernel.appendEvent('coverage-2026-10-12', NOW, 'coverage.summary', { deferred: { total: 3, byStage: { locate: 2, verify: 1 } } }, 'pol');
  a.recordRun({ runId: 'coverage-2026-10-12', at: NOW, counts: {}, packHash: 'p', policyHash: 'pol' });
});

describe('companies', () => {
  it('counts per status and platform, with totals, and the companies deferred this week', () => {
    const r = reportOf(h);
    expect(r.companies.counts['verified']).toEqual({ workday: 1, oracle: 1 });
    expect(r.companies.counts['proposed']).toEqual({ workday: 1 });
    expect(r.companies.counts['failing']).toEqual({ icims: 1 });
    expect(r.companies.counts['rejected']).toEqual({ workday: 1, none: 1 });
    expect(r.companies.totals).toEqual({ verified: 2, proposed: 1, failing: 1, rejected: 2 });
    expect(r.companies.platforms).toEqual(['workday', 'oracle', 'icims', 'none']);
    expect(r.companies.deferredThisWeek).toEqual({ week: '2026-10-11', runId: 'coverage-2026-10-12', total: 3, byStage: { locate: 2, verify: 1 } });
  });

  it('a coverage run of an earlier week is not this week\'s deferral', () => {
    const e = makeHome();
    e.app.kernel.startRun('coverage-2026-10-04', 'coverage', 'pol', NOW);
    e.app.kernel.appendEvent('coverage-2026-10-04', NOW, 'coverage.summary', { deferred: { total: 9, byStage: {} } }, 'pol');
    e.app.recordRun({ runId: 'coverage-2026-10-04', at: NOW, counts: {}, packHash: 'p', policyHash: 'pol' });
    expect(reportOf(e).companies.deferredThisWeek).toEqual({ week: '2026-10-11', runId: null, total: 0, byStage: {} });
  });
});

describe('freehire', () => {
  const freehireOf = (home: Home) => reportOf(home).freehire;
  it('counts the catalogue boards by status, the discovery boards, the entries left and the last weeks leads', () => {
    const e = makeHome();
    const ins = (key: string, status: string, source: string, slug: string): void => {
      e.app.kernel.db.prepare(`INSERT INTO companies (company_key, name, website, platform, platform_slug, status, source, updated_at) VALUES (?, ?, '', 'greenhouse', ?, ?, ?, 'a')`).run(key, key, slug, status, source);
    };
    ins('fh-0000000000000001.freehire', 'verified', 'freehire', 'a');
    ins('fh-0000000000000002.freehire', 'verified', 'freehire', 'b');
    ins('fh-0000000000000003.freehire', 'proposed', 'freehire', 'c');
    ins('fh-0000000000000004.freehire', 'proposed', 'freehire-discovery', 'd');
    ins('plain.example', 'verified', 'picks', 'e');
    e.app.recordFreehireLeads('2026-10-11', [{ leadKey: 'k1', source: 'x', url: 'https://x.example/1', title: 'T', company: null, location: null, postedAt: null, evidence: 'india', queryId: 'q1' }], 'a');
    const f = freehireOf(e);
    expect(f.catalogue.verified).toBe(2);
    expect(f.catalogue.proposed).toBe(1);
    expect(f.catalogue.left).toBeGreaterThan(0);
    expect(f.discovery).toEqual({ boards: 1, leads: 1 });
    expect(formatReport(reportOf(e))).toContain(`catalogue: 2 verified, 1 proposed, ${f.catalogue.left} left · discovery: boards 1, leads 1 (last week)`);
  });
  it('is zeros with an empty registry, and the line still prints', () => {
    const e = makeHome();
    const f = freehireOf(e);
    expect([f.catalogue.verified, f.catalogue.proposed, f.discovery.boards, f.discovery.leads]).toEqual([0, 0, 0, 0]);
    expect(formatReport(reportOf(e))).toMatch(/catalogue: 0 verified, 0 proposed, \d+ left · discovery: boards 0, leads 0 \(last week\)/);
  });
});

describe('new jobs', () => {
  it('counts Workday-only jobs and registry-only Greenhouse jobs, per platform and in total', () => {
    const r = reportOf(h);
    // workday: JR1 (passes), JR2 (review 50), JR3 (review 65, passes), JR5 (rejected); JR4 is outside the window; JR9 has a feed copy
    expect(r.newJobs.platforms).toEqual([
      { platform: 'workday', found: 4, passing: 2 },
      { platform: 'greenhouse', found: 1, passing: 1 },
    ]);
    expect(r.newJobs.total).toEqual({ found: 5, passing: 3 });
    expect(r.newJobs.minFit).toBe(60);
  });

  it('a job seen through both a company page and Greenhouse is NOT new; one on a watchlist board is NOT new', () => {
    const titles = reportOf(h).newJobs.jobs.map((j) => j.title);
    expect(titles).not.toContain('Senior Backend Engineer'); // the registry board row that the company page also lists
    expect(titles).not.toContain('Data Engineer'); // the watchlist board
    expect(titles).toContain('Staff Platform Engineer');
  });

  it('a Workday job that a feed also lists is NOT new, whichever row is primary', () => {
    expect(reportOf(h).newJobs.jobs.map((j) => j.title)).not.toContain('Platform Engineer');
  });

  it('review with a fit below minFit does not pass; review at or above it, and eligible, do', () => {
    const by = Object.fromEntries(reportOf(h).newJobs.jobs.map((j) => [j.title, j.passes]));
    expect(by['Engineer JR1']).toBe(true);
    expect(by['Engineer JR2']).toBe(false);
    expect(by['Engineer JR3']).toBe(true);
    expect(by['Engineer JR5']).toBe(false);
  });

  it('the window is the last N IST days by first seen, and is stated', () => {
    const wide = reportOf(h, 30);
    expect(wide.newJobs.total.found).toBe(6);
    expect(wide.window).toEqual({ days: 30, from: '2026-09-15', to: '2026-10-14' });
    const one = reportOf(h, 1);
    expect(one.newJobs.jobs.map((j) => j.title).sort()).toEqual(['Engineer JR1', 'Engineer JR2', 'Engineer JR5', 'Staff Platform Engineer']);
    expect(formatReport(reportOf(h))).toContain('Window: first seen 2026-10-08 to 2026-10-14 IST (last 7 days)');
    // an IST-day edge: 2026-10-07T20:00Z is 2026-10-08 01:30 IST, inside the 7-day window
    const e = makeHome();
    e.app.upsertJob(wdRow('4000000000000001', 'E1', { at: '2026-10-07T20:00:00.000Z' }));
    e.app.upsertJob(wdRow('4000000000000002', 'E2', { at: '2026-10-07T17:00:00.000Z' }));
    expect(reportOf(e).newJobs.jobs.map((j) => j.title)).toEqual(['Engineer E1']);
  });

  it('a Greenhouse row whose board is unknown counts as an existing source, never as new', () => {
    const e = makeHome();
    e.app.upsertJob(ghRow('5000000000000001', 'mystery', '1', { at: D0, atsJob: null }));
    expect(reportOf(e).newJobs.total.found).toBe(0);
  });
});

describe('boundary and duplicate guards', () => {
  it('a review row with fit exactly minFit passes', () => {
    const e = makeHome();
    e.app.upsertJob(wdRow('8000000000000001', 'B1', { at: D0, verdict: 'review', score: 60 }));
    e.app.upsertJob(wdRow('8000000000000002', 'B2', { at: D0, verdict: 'review', score: 59.9 }));
    const by = Object.fromEntries(reportOf(e).newJobs.jobs.map((j) => [j.title, j.passes]));
    expect(by).toEqual({ 'Engineer B1': true, 'Engineer B2': false });
  });

  it('a watchlist board matches whatever the case of the stored board or the slug', () => {
    const e = makeHome();
    e.app.upsertJob(ghRow('8100000000000001', 'Example-GH', '1', { at: D0, title: 'Mixed Case Board' }));
    expect(reportOf(e).newJobs.total.found).toBe(0);
    // the command lower-cases the pack's slug too
    const f = makeHome();
    writeFileSync(join(f.home, 'pack', 'watchlist.yaml'), 'watchlist:\n  - {company: Example Greenhouse Co, ats: greenhouse, slug: Example-GH, hiresInIndia: true, allRemote: false}\n');
    f.app.upsertJob(ghRow('8100000000000002', 'example-gh', '2', { at: D0 }));
    f.app.close();
    const out: string[] = [];
    return coverageProbeCommand({ home: f.home, json: true, clock: fixedClock(NOW), out: (l) => out.push(l) }).then(() => {
      expect((JSON.parse(out.join('\n')) as CoverageProbeReport).newJobs.total.found).toBe(0);
    });
  });

  it('an iCIMS copy of a Workday job does not make it existing: the Workday row is still new', () => {
    const e = makeHome();
    const same = 'efefefefefefefef';
    e.app.upsertJob(wdRow('8200000000000001', 'W1', { at: D2, dedupeKey: same, title: 'Shared Role', atsJob: null }));
    e.app.upsertJob(jobRow({ jobKey: '8200000000000002', source: 'icims', sourceId: 'acme.icims.com|9', slug: 'acme.icims.com', company: 'Acme', ats: 'icims', dedupeKey: same, title: 'Shared Role', at: D0 }));
    const r = reportOf(e);
    expect(r.newJobs.jobs.map((j) => [j.platform, j.title])).toEqual([['workday', 'Shared Role']]);
  });
});

describe('per platform', () => {
  it('uses the day ledgers where they exist and the boards the run read otherwise', () => {
    const p = Object.fromEntries(reportOf(h).platforms.map((x) => [x.platform, x.requests]));
    expect(p['icims']).toMatchObject({ kind: 'ledger', unit: 'pages', used: 12, budget: 0, boards: 0 });
    expect(p['oracle']).toMatchObject({ kind: 'ledger', unit: 'pages', used: 4, budget: 10, boards: 1 });
    expect(p['workday']).toMatchObject({ kind: 'boards', unit: 'boards', used: 0, budget: 1, boards: 1 });
    expect(p['workday']?.perBoardRequestCap).toBeGreaterThan(0);
  });

  it('yesterday\'s ledger is not today\'s', () => {
    const e = makeHome();
    e.app.setSetting('pages.fetched.2026-10-13.icims acme.icims.com', '40');
    expect(reportOf(e).platforms.find((x) => x.platform === 'icims')).toBeUndefined();
  });

  it('names the latest run\'s problems and skips per platform with their reasons', () => {
    const r = reportOf(h);
    const wd = r.platforms.find((x) => x.platform === 'workday');
    expect(wd?.problems.map((x) => [x.reason, x.count])).toEqual([['host-disabled', 1], ['robots-disallow', 1]]);
    expect(r.platforms.find((x) => x.platform === 'icims')?.problems.map((x) => x.reason)).toEqual(['page-budget']);
    expect(JSON.stringify(r.platforms)).not.toContain('boom'); // another agent's problem
    expect(reasonLabel('scope-not-applied X: whatever', 'x')).toBe('scope-not-applied');
    expect(reasonLabel('listing-cap Okta: too many', 'x')).toBe('listing-cap');
    expect(reasonLabel('something else', 'failed')).toBe('failed');
  });

  it('is empty, not an error, with no registry and no runs', () => {
    const e = makeHome();
    const r = reportOf(e);
    expect(r.platforms).toEqual([]);
    expect(r.companies.platforms).toEqual([]);
    expect(r.latestDailyRun).toBeNull();
    expect(formatReport(r)).toContain('none in the registry');
  });
});

describe('output', () => {
  it('--json has the documented stable shape and order', () => {
    const r = JSON.parse(JSON.stringify(reportOf(h))) as CoverageProbeReport;
    expect(Object.keys(r)).toEqual(['version', 'today', 'window', 'companies', 'newJobs', 'freehire', 'platforms', 'latestDailyRun']);
    expect(r.version).toBe(1);
    expect(Object.keys(r.companies)).toEqual(['statuses', 'platforms', 'counts', 'totals', 'deferredThisWeek']);
    expect(r.companies.statuses).toEqual(['verified', 'proposed', 'failing', 'rejected', 'failed']);
    expect(Object.keys(r.newJobs)).toEqual(['minFit', 'platforms', 'total', 'jobs']);
    expect(Object.keys(r.newJobs.jobs[0] as object)).toEqual(['platform', 'company', 'title', 'verdict', 'fit', 'passes']);
    expect(Object.keys(r.platforms[0] as object)).toEqual(['platform', 'requests', 'problems']);
    expect(Object.keys(r.platforms[0]?.requests as object)).toEqual(['kind', 'unit', 'used', 'budget', 'boards', 'perBoardRequestCap']);
    expect(r.latestDailyRun).toEqual({ runId: 'daily-2026-10-14', at: NOW });
    // the same DB gives the same bytes
    expect(JSON.stringify(reportOf(h))).toBe(JSON.stringify(reportOf(h)));
    // jobs: platform order, passing first, then fit desc
    expect(r.newJobs.jobs.map((j) => j.title)).toEqual(['Engineer JR1', 'Engineer JR3', 'Engineer JR5', 'Engineer JR2', 'Staff Platform Engineer']);
    expect(r.newJobs.jobs[0]?.platform).toBe('workday');
  });

  it('the table shows every section', () => {
    const t = formatReport(reportOf(h));
    expect(t).toContain('Companies by status and platform');
    expect(t).toMatch(/workday\s+1\s+1\s+0\s+1/u);
    expect(t).toContain('deferred this week (coverage week of 2026-10-11): 3 (locate 2, verify 1)');
    expect(t).toContain('passing = eligible or review with fit >= 60');
    expect(t).toMatch(/total\s+5\s+3/u);
    expect(t).toContain('icims: 12/0 pages');
    expect(t).toContain('1 x robots-disallow:');
  });

  it('redacts a forbidden term in a company, a title and a problem line', () => {
    const e = makeHome();
    e.app.upsertJob(wdRow('6000000000000001', 'S1', { at: D0, company: 'Initech Holdings', title: 'Initech Platform Engineer' }));
    e.app.recordRun({ runId: 'daily-2026-10-14', at: NOW, counts: {}, packHash: 'p', policyHash: 'q', warnings: ['src-workday: robots-disallow Initech.example: Initech not read today'], problems: [] });
    const r = reportOf(e, 7, ['Initech']);
    const text = JSON.stringify(r) + formatReport(r);
    expect(text).not.toMatch(/initech/iu);
    expect(r.newJobs.jobs[0]?.company).toBe('[hidden: contains a forbidden term]');
    expect(r.platforms.find((x) => x.platform === 'workday')?.problems[0]?.example).toBe('[hidden: contains a forbidden term]');
  });
});

describe('the command', () => {
  const run = async (home: string, over: { json?: boolean; days?: number } = {}) => {
    const out: string[] = [];
    const code = await coverageProbeCommand({ home, json: over.json === true, ...(over.days !== undefined ? { days: over.days } : {}), clock: fixedClock(NOW), out: (l) => out.push(l) });
    return { code, text: out.join('\n') };
  };

  it('prints the table and the JSON, makes no request and writes nothing to the registry or jobs', async () => {
    const e = makeHome();
    e.app.upsertJob(wdRow('7000000000000001', 'C1', { at: D0 }));
    e.app.close();
    const before = (): string => {
      const a = AppStore.open(homePaths(e.home).db);
      try {
        return JSON.stringify([a.listJobs({ duplicates: true }), a.listCompanies(), a.listRuns(10)]);
      } finally {
        a.close();
      }
    };
    const was = before();
    const t = await run(e.home);
    expect(t.code).toBe(0);
    expect(t.text).toContain('Coverage probe, 2026-10-14');
    const j = await run(e.home, { json: true, days: 3 });
    expect((JSON.parse(j.text) as CoverageProbeReport).window.days).toBe(3);
    expect(before()).toBe(was);
  });

  it('refuses while another jobpilot process holds the lock, naming it, and prints nothing', async () => {
    const e = makeHome();
    e.app.close();
    writeFileSync(join(e.home, LOCK_FILE), JSON.stringify({ pid: process.pid, command: 'run', at: NOW, token: 't' }));
    const out: string[] = [];
    await expect(coverageProbeCommand({ home: e.home, json: false, clock: fixedClock(NOW), out: (l) => out.push(l) })).rejects.toThrow(LockError);
    await expect(coverageProbeCommand({ home: e.home, json: false, clock: fixedClock(NOW), out: (l) => out.push(l) })).rejects.toThrow(/holds .*jobpilot\.lock/u);
    expect(out).toEqual([]);
  });

  it('releases the lock when done', async () => {
    const e = makeHome();
    e.app.close();
    await run(e.home);
    await run(e.home);
  });

  it('--days must be 1 to 90', async () => {
    expect(parseDays('1')).toBe(1);
    expect(parseDays('90')).toBe(90);
    for (const bad of ['0', '91', '-1', '1.5', 'x', '']) expect(() => parseDays(bad), bad).toThrow(/--days/u);
    const e = makeHome();
    e.app.close();
    await expect(run(e.home, { days: 0 })).rejects.toThrow(/--days/u);
  });

  it('a missing database is an error, not a created one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jobpilot-covprobe-'));
    tmps.push(home);
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    await expect(run(home)).rejects.toThrow(/no database/u);
  });
});
