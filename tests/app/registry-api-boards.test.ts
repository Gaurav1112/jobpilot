import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompanyVerdict, Platform } from '../../src/app/coverage/types.js';
import { srcAshby } from '../../src/app/agents/sources/ashby.js';
import { srcGreenhouse } from '../../src/app/agents/sources/greenhouse.js';
import { srcLever } from '../../src/app/agents/sources/lever.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { dailySeeds, pacingProblems, readsDaily, registryBoardOf, registryBoards, registryEgressSets } from '../../src/app/pipeline.js';
import { runDaily } from '../../src/app/run.js';
import { AppStore } from '../../src/app/store/app-store.js';
import type { FetchLike } from '../../src/kernel/providers.js';

/**
 * Career-sites Task 11b: verified registry companies on Greenhouse, Lever and Ashby are read daily by the EXISTING
 * watchlist adapters (src-greenhouse, src-lever, src-ashby), seeded as the watchlist's own DiscoveryRequest shape. A
 * board on both lists is requested once (the watchlist's request, unchanged); a rejected registry company is never
 * read, a failing one still is; a rejected registry company that the watchlist names is read (the watchlist wins).
 */
const root = join(import.meta.dirname, '../..');
const GH = 'https://boards-api.greenhouse.io/v1/boards';
const LV = 'https://api.lever.co/v0/postings';
const AB = 'https://api.ashbyhq.com/posting-api/job-board';

const row = (platform: string | null, boardUrl: string | null, platformSlug: string | null, over: { status?: string; userOverride?: string | null; name?: string } = {}) => ({
  name: over.name ?? 'Reg Co', platform, boardUrl, platformSlug, status: over.status ?? 'verified', userOverride: over.userOverride ?? null,
});

describe('registryBoardOf / readsDaily: Greenhouse, Lever, Ashby', () => {
  it('reads the board refs coverage stores (the API board URLs) for the three platforms', () => {
    expect(registryBoardOf(row('greenhouse', `${GH}/acmeco/jobs`, 'acmeco'))).toEqual({ platform: 'greenhouse', company: 'Reg Co', ref: 'acmeco' });
    expect(registryBoardOf(row('lever', `${LV}/acmeco`, 'acmeco'))).toEqual({ platform: 'lever', company: 'Reg Co', ref: 'acmeco' });
    expect(registryBoardOf(row('ashby', `${AB}/Blackpoint%20Cyber`, 'Blackpoint Cyber'))).toEqual({ platform: 'ashby', company: 'Reg Co', ref: 'Blackpoint Cyber' });
    // a board URL that is not that platform's board API: no daily board
    expect(registryBoardOf(row('greenhouse', 'https://evil.example/v1/boards/acmeco/jobs', 'acmeco'))).toBeNull();
    expect(registryBoardOf(row('lever', `${GH}/acmeco/jobs`, 'acmeco'))).toBeNull();
    expect(registryBoardOf(row('ashby', 'http://api.ashbyhq.com/posting-api/job-board/acmeco', 'acmeco'))).toBeNull();
  });

  it('read daily: verified, approved or failing; never rejected', () => {
    const b = `${AB}/acmeco`;
    expect(readsDaily(row('ashby', b, 'acmeco'))).toBe(true);
    expect(readsDaily(row('ashby', b, 'acmeco', { status: 'failing' }))).toBe(true);
    expect(readsDaily(row('ashby', b, 'acmeco', { userOverride: 'approved' }))).toBe(true);
    expect(readsDaily(row('ashby', b, 'acmeco', { status: 'rejected', userOverride: 'rejected' }))).toBe(false);
    expect(readsDaily(row('ashby', b, 'acmeco', { status: 'proposed' }))).toBe(false);
    // a rejection wins over any status (the store sets both; the helper does not rely on that)
    expect(readsDaily(row('ashby', b, 'acmeco', { userOverride: 'rejected' }))).toBe(false);
  });
});

describe('dailySeeds with registry API boards', () => {
  const pack = {
    watchlist: [
      { company: 'Example Greenhouse Co', ats: 'greenhouse' as const, slug: 'example-gh' },
      { company: 'Example Ashby Co', ats: 'ashby' as const, slug: 'example-ab' },
    ],
    feeds: { enabled: [] as string[] },
  };

  it('an empty registry: exactly the watchlist seeds', () => {
    expect(dailySeeds(pack, '2026-10-14', undefined, [])).toEqual([
      { ats: 'greenhouse', slug: 'example-gh', company: 'Example Greenhouse Co', runDate: '2026-10-14' },
      { ats: 'ashby', slug: 'example-ab', company: 'Example Ashby Co', runDate: '2026-10-14' },
    ]);
  });

  it('a registry board is seeded in the watchlist shape after the watchlist; a duplicate of a watchlist board (any case) is not', () => {
    const boards = registryBoards([
      row('greenhouse', `${GH}/example-gh/jobs`, 'example-gh', { name: 'Example Greenhouse Inc' }),
      row('ashby', `${AB}/Example-AB`, 'Example-AB', { name: 'Other Name' }),
      row('lever', `${LV}/regco`, 'regco', { name: 'Reg Lever Co' }),
    ]);
    expect(dailySeeds(pack, '2026-10-14', undefined, boards)).toEqual([
      { ats: 'greenhouse', slug: 'example-gh', company: 'Example Greenhouse Co', runDate: '2026-10-14' },
      { ats: 'ashby', slug: 'example-ab', company: 'Example Ashby Co', runDate: '2026-10-14' },
      { ats: 'lever', slug: 'regco', company: 'Reg Lever Co', runDate: '2026-10-14' },
    ]);
  });

  it('two registry rows on one board (slug case aside) are one request', () => {
    const boards = registryBoards([row('greenhouse', `${GH}/regco/jobs`, 'regco', { name: 'A' }), row('greenhouse', `${GH}/RegCo/jobs`, 'RegCo', { name: 'B' })]);
    expect(dailySeeds({ watchlist: [], feeds: { enabled: [] } }, '2026-10-14', undefined, boards).map((s) => s.slug)).toEqual(['regco']);
    // an Ashby board name keeps its case, and is still one board
    expect(registryBoards([row('ashby', `${AB}/Acme%20Co`, 'Acme Co', { name: 'A' }), row('ashby', `${AB}/acme%20co`, 'acme co', { name: 'B' })])).toEqual([{ platform: 'ashby', company: 'A', ref: 'Acme Co' }]);
  });
});

describe('egress and pacing', () => {
  it('the existing adapters already allow their one documented API host; no symbolic egress set is added', () => {
    expect(srcGreenhouse.contract.egress).toEqual(['boards-api.greenhouse.io']);
    expect(srcLever.contract.egress).toEqual(['api.lever.co']);
    expect(srcAshby.contract.egress).toEqual(['api.ashbyhq.com']);
    const boards = registryBoards([row('greenhouse', `${GH}/regco/jobs`, 'regco'), row('lever', `${LV}/regco`, 'regco'), row('ashby', `${AB}/regco`, 'regco')]);
    expect(boards).toHaveLength(3);
    expect(registryEgressSets(boards)).toEqual({});
  });

  it("the pacing check covers a registry-only Lever, Greenhouse or Ashby board as it covers the watchlist's", () => {
    for (const p of ['lever', 'greenhouse', 'ashby'] as const) {
      const url = p === 'greenhouse' ? `${GH}/regco/jobs` : p === 'lever' ? `${LV}/regco` : `${AB}/regco`;
      const problems = pacingProblems({ minHostIntervalMs: 120_000, minBrowserIntervalMs: 1 }, { watchlist: [], feeds: { enabled: [] } }, registryBoards([row(p, url, 'regco')]));
      expect(problems.join('\n'), p).toMatch(new RegExp(`src-${p}`));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// end to end, offline
// ---------------------------------------------------------------------------------------------------------------

const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();

function verdict(key: string, name: string, platform: Platform, slug: string, boardUrl: string): CompanyVerdict {
  const candidate = { companyKey: key, name, website: `https://${key}`, careersUrl: null, source: 'yc' as const, runDate: '2026-10-11' };
  return { guess: { site: { candidate, careersUrl: `https://${key}/careers`, method: 'listed', evidence: null }, platform, slug, boardUrl, signature: `${platform}:a`, routedFrom: null, evidence: [] }, status: 'verified', reasons: ['test'], boardName: null, jobsSeen: 1 };
}

/** A recorded board body with every id suffixed, so two boards built from one recording are different jobs. */
function reId(file: string, suffix: string): string {
  const j = JSON.parse(readFileSync(join(root, 'tests/fixtures/sources', file), 'utf8')) as { jobs?: { id: string }[] } | { id: string }[];
  const list = Array.isArray(j) ? j : (j.jobs ?? []);
  for (const x of list) x.id = `${x.id}-${suffix}`;
  return JSON.stringify(j);
}

describe.skipIf(pdftotext === undefined)('jobpilot run reads registry Greenhouse, Lever and Ashby boards (offline)', () => {
  const homes: string[] = [];
  let fixtures: string;
  afterAll(() => {
    for (const h of [...homes, fixtures]) rmSync(h, { recursive: true, force: true });
  });

  beforeAll(() => {
    fixtures = mkdtempSync(join(tmpdir(), 'jobpilot-regapi-fx-'));
    mkdirSync(fixtures, { recursive: true });
    cpSync(join(root, 'tests/fixtures/e2e/greenhouse-example-gh.json'), join(fixtures, 'gh.json'));
    writeFileSync(join(fixtures, 'ab-reg.json'), reId('ashby-confluent.json', 'reg'));
    writeFileSync(join(fixtures, 'lv-fail.json'), reId('lever-veeva.json', 'fail'));
    writeFileSync(join(fixtures, 'lv-rej.json'), reId('lever-veeva.json', 'rej'));
    writeFileSync(join(fixtures, 'empty.json'), '[]');
    writeFileSync(join(fixtures, 'index.json'), JSON.stringify({
      [`${GH}/example-gh/jobs?content=true&pay_transparency=true`]: 'gh.json',
      [`${AB}/regco-ab?includeCompensation=true`]: 'ab-reg.json',
      [`${LV}/fail-lv?mode=json&skip=0&limit=100`]: 'lv-fail.json',
      [`${LV}/fail-lv?mode=json&skip=100&limit=100`]: 'empty.json',
      [`${LV}/rej-lv?mode=json&skip=0&limit=100`]: 'lv-rej.json',
      [`${LV}/rej-lv?mode=json&skip=100&limit=100`]: 'empty.json',
    }));
  });

  function newHome(watchlist: string): string {
    const home = mkdtempSync(join(tmpdir(), 'jobpilot-regapi-'));
    homes.push(home);
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    writeFileSync(join(home, 'pack/watchlist.yaml'), watchlist);
    writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: []\n');
    return home;
  }
  const WATCH = 'watchlist:\n  - {company: Example Greenhouse Co, ats: greenhouse, slug: example-gh, hiresInIndia: true, allRemote: false}\n';

  async function run(home: string): Promise<string[]> {
    const offline = offlineProviders(fixtures).fetch;
    const calls: string[] = [];
    const fetch: FetchLike = async (url, init) => (calls.push(url), offline(url, init));
    const s = await runDaily({ home, clock: { now: () => '2026-10-14T01:30:00.000Z' }, fetch, sleep: async () => {}, pdftotext: pdftotext as string, codeHash: 'regapi' });
    expect(s.exitCode).toBe(0);
    return calls;
  }
  const db = <T>(home: string, fn: (s: AppStore) => T): T => {
    const s = AppStore.open(join(home, 'jobpilot.db'));
    try {
      return fn(s);
    } finally {
      s.close();
    }
  };
  /** The src-greenhouse step keys of the run, and its rows, as stored. */
  const ghSteps = (home: string) =>
    db(home, (s) => s.kernel.events().filter((e) => e.kind === 'step_done' && (JSON.parse(e.data) as { agent: string }).agent === 'src-greenhouse').map((e) => (JSON.parse(e.data) as { stepKey: string }).stepKey).sort());
  const rows = (home: string, source: string) =>
    db(home, (s) => s.listJobs({ band: ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'], duplicates: true }).filter((j) => j.source === source).map((j) => ({ key: j.jobKey, company: j.company, dup: j.duplicateOf })).sort((a, b) => (a.key < b.key ? -1 : 1)));

  it('reads a registry Ashby board and a failing Lever board; never a rejected one; a watchlist duplicate is one request with unchanged step keys and rows', async () => {
    const plain = newHome(WATCH);
    await run(plain);

    const home = newHome(WATCH);
    db(home, (s) => {
      s.upsertCompanyVerdict(verdict('regco-ab.com', 'RegAshby Co', 'ashby', 'regco-ab', `${AB}/regco-ab`), '2026-10-11T01:30:00.000Z');
      // the watchlist's own board, under another name in the registry
      s.upsertCompanyVerdict(verdict('example-gh.com', 'Example Greenhouse Incorporated', 'greenhouse', 'Example-GH', `${GH}/Example-GH/jobs`), '2026-10-11T01:30:00.000Z');
      s.upsertCompanyVerdict(verdict('fail-lv.com', 'FailLever Co', 'lever', 'fail-lv', `${LV}/fail-lv`), '2026-09-20T01:30:00.000Z');
      for (const w of ['2026-09-27', '2026-10-04', '2026-10-11']) s.upsertCompanyVerdict({ ...verdict('fail-lv.com', 'FailLever Co', 'lever', 'fail-lv', `${LV}/fail-lv`), status: 'failed', reasons: ['down'] }, `${w}T01:30:00.000Z`);
      s.upsertCompanyVerdict(verdict('rej-lv.com', 'RejLever Co', 'lever', 'rej-lv', `${LV}/rej-lv`), '2026-10-11T01:30:00.000Z');
      s.setCompanyOverride('rej-lv.com', 'rejected', '2026-10-12T01:30:00.000Z');
      expect(s.getCompany('fail-lv.com')?.status).toBe('failing');
    });
    const calls = await run(home);

    expect(calls.filter((u) => u.startsWith(`${GH}/`))).toEqual([`${GH}/example-gh/jobs?content=true&pay_transparency=true`]);
    expect(calls).toContain(`${AB}/regco-ab?includeCompensation=true`);
    expect(calls).toContain(`${LV}/fail-lv?mode=json&skip=0&limit=100`);
    expect(calls.some((u) => u.includes('rej-lv'))).toBe(false);

    // the watchlist board: the same step keys and the same rows as with no registry
    // (every API source sees every request and answers [] for another platform's: the two registry requests add two
    // empty src-greenhouse steps; the watchlist's own step is the same)
    expect(ghSteps(plain)).toHaveLength(1);
    expect(ghSteps(home)).toEqual(expect.arrayContaining(ghSteps(plain)));
    expect(ghSteps(home)).toHaveLength(3);
    expect(rows(home, 'greenhouse')).toEqual(rows(plain, 'greenhouse'));
    expect(new Set(rows(home, 'greenhouse').map((r) => r.company))).toEqual(new Set(['Example Greenhouse Co']));

    // the registry-only boards: their jobs, once each, under the registry name
    const ab = rows(home, 'ashby');
    expect(ab).toHaveLength(5);
    expect(new Set(ab.map((r) => r.company))).toEqual(new Set(['RegAshby Co']));
    expect(new Set(ab.map((r) => r.key)).size).toBe(5);
    expect(ab.every((r) => r.dup === null)).toBe(true);
    expect(rows(home, 'lever').map((r) => r.company)).toEqual(Array(5).fill('FailLever Co'));
  });

  it('a company rejected in the registry but named in the watchlist is read: the watchlist wins', async () => {
    const home = newHome('watchlist:\n  - {company: RejLever Co, ats: lever, slug: rej-lv, hiresInIndia: true, allRemote: false}\n');
    db(home, (s) => {
      s.upsertCompanyVerdict(verdict('rej-lv.com', 'RejLever Co', 'lever', 'rej-lv', `${LV}/rej-lv`), '2026-10-11T01:30:00.000Z');
      s.setCompanyOverride('rej-lv.com', 'rejected', '2026-10-12T01:30:00.000Z');
    });
    const calls = await run(home);
    expect(calls).toContain(`${LV}/rej-lv?mode=json&skip=0&limit=100`);
    expect(rows(home, 'lever')).toHaveLength(5);
  });
});
