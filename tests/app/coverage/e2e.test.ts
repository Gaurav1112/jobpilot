import { copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCoverage, type CoverageSummary } from '../../../src/app/coverage/run.js';
import { offlineProviders } from '../../../src/app/offline.js';
import { AppStore, type Company } from '../../../src/app/store/app-store.js';
import type { FetchLike } from '../../../src/kernel/providers.js';

const root = join(import.meta.dirname, '../../..');
const FIX = join(root, 'tests/fixtures/coverage/e2e');
const ALPHA_BOARD = 'https://boards-api.greenhouse.io/v1/boards/alpharobotics/jobs?content=true&pay_transparency=true';

// Sundays 07:00 IST (01:30Z) of four coverage weeks, and a Tuesday in the first.
const W1 = '2026-10-11T01:30:00.000Z';
const W1_TUE = '2026-10-13T04:30:00.000Z';
const W2 = '2026-10-18T01:30:00.000Z';
const W3 = '2026-10-25T01:30:00.000Z';
const W4 = '2026-11-01T01:30:00.000Z';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-cov-e2e-'));
  homes.push(home);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  copyFileSync(join(FIX, 'companies.yaml'), join(home, 'pack', 'companies.yaml'));
  return home;
}

/** The recorded fixtures; `dead` URLs answer 404 instead. Every URL asked for is in `calls`. */
function net(dead: readonly string[] = []) {
  const offline = offlineProviders(FIX).fetch;
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    if (dead.includes(url)) return { status: 404, text: async () => 'Not Found' };
    return offline(url, init);
  };
  return { fetch, calls };
}

const run = (home: string, now: string, fetch: FetchLike): Promise<CoverageSummary> =>
  runCoverage({ home, clock: { now: () => now }, fetch, sleep: async () => {}, codeHash: 'e2e' });

function registry(home: string): Record<string, Pick<Company, 'status' | 'platform' | 'platformSlug' | 'source' | 'failWeeks' | 'userOverride'> & { reasons: string }> {
  const app = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return Object.fromEntries(
      app.listCompanies().map((c) => [c.companyKey, { status: c.status, platform: c.platform, platformSlug: c.platformSlug, source: c.source, failWeeks: c.failWeeks, userOverride: c.userOverride, reasons: c.reasons.join(' | ') }]),
    );
  } finally {
    app.close();
  }
}

describe('coverage e2e: a pick plus the seed lists fill the registry', () => {
  it('yields 1 verified, 1 proposed for a name mismatch, 1 failed for a 404, a workday board proposed, an unlocated seed only counted', async () => {
    const home = newHome();
    const n = net();
    const s = await run(home, W1, n.fetch);
    expect(s).toMatchObject({ runId: 'coverage-2026-10-11', week: '2026-10-11', resumed: false, exitCode: 0, picks: 1 });
    expect(s.candidates).toEqual({ bySource: { pick: 1, remoteintech: 2, yc: 2, jobs: 0 }, merged: 5, selected: 5, dropped: 0 });
    expect(s.located).toEqual({ listed: 3, 'homepage-link': 1, path: 0, subdomain: 0, sitemap: 0, none: 1 });
    expect(s.platforms).toEqual({ ashby: 1, greenhouse: 2, workday: 1 });
    expect(s.verdicts).toEqual({ verified: 1, proposed: 2, failed: 1 });
    expect(s.notification).toBe('Coverage: 1 verified (+1 new) · 2 proposed · 0 failing');
    expect(s.deferred.total).toBe(0);
    expect(s.projection.unlocated).toEqual({ proposed: 0, failed: 0, counted: 1 });

    const r = registry(home);
    expect(Object.keys(r)).toEqual(['alpha.test', 'beta.test', 'epsilon.test', 'gamma.test']);
    expect(r['alpha.test']).toMatchObject({ status: 'verified', platform: 'greenhouse', platformSlug: 'alpharobotics', source: 'pick' });
    expect(r['beta.test']).toMatchObject({ status: 'proposed', platform: 'greenhouse', platformSlug: 'betacorp', source: 'remoteintech' });
    expect(r['beta.test']?.reasons).toContain("board name 'Betacorp Holdings' ≈ 'Beta Labs', please confirm");
    expect(r['epsilon.test']).toMatchObject({ status: 'proposed', platform: 'workday', platformSlug: 'epsilon/External' });
    expect(r['epsilon.test']?.reasons).toContain('adapter not built yet: workday');
    expect(r['gamma.test']).toMatchObject({ status: 'failed', platform: 'ashby', platformSlug: 'gamma', source: 'yc' });
    expect(r['gamma.test']?.reasons).toMatch(/board not found \(404\)/);

    // politeness: robots.txt once per host, every board read once
    const robots = n.calls.filter((u) => u.endsWith('/robots.txt'));
    expect(new Set(robots).size).toBe(robots.length);
    expect(n.calls.filter((u) => u === ALPHA_BOARD)).toHaveLength(1);
    // the run is on the dashboard's runs view, and its umbrella row is completed
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(app.kernel.getRun('coverage-2026-10-11')).toMatchObject({ pipeline: 'jobpilot-coverage', status: 'completed' });
      for (const st of ['seed', 'locate', 'detect', 'verify']) expect(app.kernel.getRun(`coverage-2026-10-11.${st}`)).toMatchObject({ status: 'completed' });
      expect(app.listRuns(5).map((x) => x.runId)).toEqual(['coverage-2026-10-11']);
      expect(app.kernel.getRun('coverage-2026-10-11')?.policy_hash).not.toBe('coverage-empty-pipeline');
    } finally {
      app.close();
    }
  });

  it('a second run in the same coverage week replays every step at $0: no request at all', async () => {
    const home = newHome();
    await run(home, W1, net().fetch);
    const before = registry(home);
    const again = net();
    const s = await run(home, W1_TUE, again.fetch);
    expect(s.runId).toBe('coverage-2026-10-13');
    expect(again.calls).toEqual([]);
    expect(s.notification).toBe('Coverage: 1 verified (+0 new) · 2 proposed · 0 failing');
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      for (const st of ['seed', 'locate', 'detect', 'verify']) {
        const id = `coverage-2026-10-13.${st}`;
        expect(app.kernel.events(id).filter((e) => e.kind === 'step_done')).toEqual([]);
        expect(app.kernel.runCost(id)).toBe(0);
      }
      expect(app.kernel.events('coverage-2026-10-13').filter((e) => e.kind === 'coverage.projected').map((e) => JSON.parse(e.data).countFailures)).toEqual([false]);
    } finally {
      app.close();
    }
    const after = registry(home);
    for (const k of Object.keys(before)) expect({ ...after[k], reasons: '' }).toEqual({ ...before[k], reasons: '' });
  });

  it('a user-rejected company stays rejected through later verified runs', async () => {
    const home = newHome();
    await run(home, W1, net().fetch);
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(app.setCompanyOverride('alpha.test', 'rejected', W1_TUE)).toBe(true);
    } finally {
      app.close();
    }
    const s = await run(home, W2, net().fetch);
    expect(s.verdicts.verified).toBe(1);
    expect(registry(home)['alpha.test']).toMatchObject({ status: 'rejected', userOverride: 'rejected' });
    expect(s.notification).toBe('Coverage: 0 verified (+0 new) · 2 proposed · 0 failing');
  });

  it('a verified board that fails 3 weeks running becomes failing, and recovers when it answers again', async () => {
    const home = newHome();
    await run(home, W1, net().fetch);
    const s2 = await run(home, W2, net([ALPHA_BOARD]).fetch);
    expect(registry(home)['alpha.test']).toMatchObject({ status: 'verified', failWeeks: 1 });
    expect(s2.notification).toBe('Coverage: 1 verified (+0 new) · 2 proposed · 0 failing');
    // a second run in week 2 does not count week 2's failure again
    await run(home, '2026-10-19T04:30:00.000Z', net([ALPHA_BOARD]).fetch);
    expect(registry(home)['alpha.test']).toMatchObject({ status: 'verified', failWeeks: 1 });
    await run(home, W3, net([ALPHA_BOARD]).fetch);
    expect(registry(home)['alpha.test']).toMatchObject({ status: 'verified', failWeeks: 2 });
    const s4 = await run(home, W4, net([ALPHA_BOARD]).fetch);
    expect(registry(home)['alpha.test']).toMatchObject({ status: 'failing', failWeeks: 3 });
    expect(s4.notification).toBe('Coverage: 0 verified (+0 new) · 2 proposed · 1 failing');
    await run(home, '2026-11-08T01:30:00.000Z', net().fetch);
    expect(registry(home)['alpha.test']).toMatchObject({ status: 'verified', failWeeks: 0 });
  });

  it('a host that rate-limits is disabled for the run: the steps behind it are deferred, named once, never "input rejected"', async () => {
    const home = newHome();
    // the Greenhouse API answers 429: Alpha's read disables the host, Beta's read is deferred without a request
    const offline = offlineProviders(FIX).fetch;
    const calls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push(url);
      if (url.startsWith('https://boards-api.greenhouse.io/v1/')) return { status: 429, text: async () => 'slow down' };
      return offline(url, init);
    };
    const s = await run(home, W1, fetch);
    expect(s.exitCode).toBe(0);
    expect(s.deferred).toEqual({ byStage: { seed: 0, locate: 0, detect: 0, verify: 2 }, total: 2, hosts: [['boards-api.greenhouse.io', 'http-429']] });
    expect(calls.filter((u) => u.startsWith('https://boards-api.greenhouse.io/v1/'))).toHaveLength(1);
    expect(s.notification).toBe('Coverage: 0 verified (+0 new) · 1 proposed · 0 failing · not located this week: 2, host-disabled boards-api.greenhouse.io (http-429)');
    expect(s.problems.map((p) => p.kind)).toEqual(['deferred', 'deferred']);
    // nothing is known about the deferred companies this week: not in the registry
    expect(Object.keys(registry(home))).toEqual(['epsilon.test', 'gamma.test']);
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      const counts = app.listRuns(1)[0]?.counts as { totals: Record<string, number> };
      expect(counts.totals).toMatchObject({ deferred: 2, inputRejected: 0 });
    } finally {
      app.close();
    }
    // the next week asks again
    const later = net();
    await run(home, W2, later.fetch);
    expect(later.calls).toContain(ALPHA_BOARD);
    expect(registry(home)['alpha.test']).toMatchObject({ status: 'verified' });
  });

  it('a crash mid-run is resumed: finished steps replay, nothing is fetched twice, the projection happens once', async () => {
    const home = newHome();
    let steps = 0;
    const first = net();
    await expect(
      runCoverage({ home, clock: { now: () => W1 }, fetch: first.fetch, sleep: async () => {}, codeHash: 'e2e', afterStep: () => { if (++steps === 6) throw new Error('crash'); } }),
    ).rejects.toThrow('crash');
    const resumed = net();
    const s = await run(home, W1, resumed.fetch);
    expect(s).toMatchObject({ runId: 'coverage-2026-10-11', resumed: true, verdicts: { verified: 1, proposed: 2, failed: 1 } });
    // the seed stage finished before the crash: its lists are not fetched again
    expect(resumed.calls.filter((u) => u.includes('codeload.github.com') || u.includes('yc-oss.github.io'))).toEqual([]);
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      const kinds = (id: string) => app.kernel.events(id).map((e) => e.kind);
      // every candidate's locator step executed exactly once over both attempts; the one cut short is replayed
      expect(kinds('coverage-2026-10-11.locate').filter((k) => k === 'step_done')).toHaveLength(5);
      expect(kinds('coverage-2026-10-11.locate').filter((k) => k === 'step_replayed')).toHaveLength(1);
      expect(kinds('coverage-2026-10-11.seed').filter((k) => k === 'step_done')).toHaveLength(4);
      expect(kinds('coverage-2026-10-11').filter((k) => k === 'coverage.projected')).toHaveLength(1);
    } finally {
      app.close();
    }
    expect(registry(home)['alpha.test']).toMatchObject({ status: 'verified' });
  });
});

describe('coverage e2e fixtures', () => {
  it('privacy: no e-mail address, mailto:/tel: link, JSON-LD Person, social or people profile URL, cookie or session token', () => {
    const PRIVATE: readonly [string, RegExp][] = [
      ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
      ['mailto-tel', /\b(?:mailto|tel):/gi],
      ['jsonld-person', /"@type"\s*:\s*(?:\[[^\]]*)?"Person"/g],
      ['social-profile', /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com|facebook\.com|instagram\.com|github\.com|threads\.net|bsky\.app)\/[A-Za-z0-9_.-]+|linkedin\.com\/in\//gi],
      ['people-page', /\/(?:team|people|authors?|community\/profiles)\/[A-Za-z0-9_-]+/gi],
      ['cookie-session', /set-cookie|__cf_chl_tk|cf_clearance|jsessionid=|phpsessid/gi],
    ];
    const hits: string[] = [];
    for (const file of readdirSync(FIX)) {
      const text = readFileSync(join(FIX, file), 'utf8');
      for (const [kind, re] of PRIVATE) for (const m of text.matchAll(re)) hits.push(`${kind} in ${file} at offset ${m.index}`);
    }
    expect(hits).toEqual([]);
  });
});
