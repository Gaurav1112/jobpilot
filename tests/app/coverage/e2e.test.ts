import { copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freehireCompanyKey } from '../../../src/app/coverage/freehire-boards.js';
import { runCoverage, type CoverageResult, type CoverageSummary } from '../../../src/app/coverage/run.js';
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

/** A completed run (these tests never yield: the check homes have no scheduled daily or freelance job). */
function done(r: CoverageResult): CoverageSummary {
  if (r.status !== 'completed') throw new Error(`expected a completed run, got ${r.status} (${r.reason})`);
  return r;
}
const run = async (home: string, now: string, fetch: FetchLike): Promise<CoverageSummary> =>
  done(await runCoverage({ home, clock: { now: () => now }, fetch, sleep: async () => {}, codeHash: 'e2e', yieldCheck: () => null }));

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
  it('yields 2 verified (a Greenhouse and a Workday board), 1 proposed for a name mismatch, 1 failed for a 404, an unlocated seed only counted', async () => {
    const home = newHome();
    const n = net();
    let t = Date.parse(W1);
    const s = done(await runCoverage({ home, clock: { now: () => new Date((t += 1000)).toISOString() }, fetch: n.fetch, sleep: async () => {}, codeHash: 'e2e', yieldCheck: () => null }));
    expect(s).toMatchObject({ runId: 'coverage-2026-10-11', week: '2026-10-11', resumed: false, exitCode: 0, picks: 1 });
    expect(s.candidates).toEqual({ bySource: { pick: 1, remoteintech: 2, yc: 2, jobs: 0 }, merged: 5, selected: 5, dropped: 1, denied: 0 });
    expect(s.located).toEqual({ listed: 3, 'homepage-link': 1, path: 0, subdomain: 0, sitemap: 0, none: 1 });
    expect(s.platforms).toEqual({ ashby: 1, greenhouse: 2, workday: 1 });
    expect(s.verdicts).toEqual({ verified: 2, proposed: 1, failed: 1 });
    expect(s.notification).toBe('Coverage: 2 verified (+2 new) · 1 proposed · 0 failing');
    expect(s.deferred.total).toBe(0);
    // the cross-source merge (carry 1): the yc entry on the pick's domain loses to the pick, and says so
    expect(s.mergeNotes).toEqual(['merge: "Alpha Robotics Inc" (yc) dropped, alpha.test is held by "Alpha Robotics" (pick)']);
    expect(s.projection.unlocated).toEqual({ proposed: 0, failed: 0, counted: 1 });

    const r = registry(home);
    expect(Object.keys(r)).toEqual(['alpha.test', 'beta.test', 'epsilon.test', 'gamma.test']);
    expect(r['alpha.test']).toMatchObject({ status: 'verified', platform: 'greenhouse', platformSlug: 'alpharobotics', source: 'pick' });
    expect(r['beta.test']).toMatchObject({ status: 'proposed', platform: 'greenhouse', platformSlug: 'betacorp', source: 'remoteintech' });
    expect(r['beta.test']?.reasons).toContain("board name 'Betacorp Holdings' ≈ 'Beta Labs', please confirm");
    // Task 6: the Workday board verifies through the Workday client (robots.txt via the gate, page 1 by POST), its tenant matching the domain label
    expect(r['epsilon.test']).toMatchObject({ status: 'verified', platform: 'workday', platformSlug: 'epsilon/External' });
    expect(r['epsilon.test']?.reasons).toBe("workday board epsilon/External: 2 open jobs; workday tenant 'epsilon' matches 'Epsilon Freight'");
    expect(r['gamma.test']).toMatchObject({ status: 'failed', platform: 'ashby', platformSlug: 'gamma', source: 'yc' });
    expect(r['gamma.test']?.reasons).toMatch(/board not found \(404\)/);

    // politeness: robots.txt once per host, every board read once
    const robots = n.calls.filter((u) => u.endsWith('/robots.txt'));
    expect(new Set(robots).size).toBe(robots.length);
    expect(n.calls.filter((u) => u === ALPHA_BOARD)).toHaveLength(1);
    // the run is on the dashboard's runs view, and its umbrella row is completed
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      const umbrella = app.kernel.getRun('coverage-2026-10-11');
      expect(umbrella).toMatchObject({ pipeline: 'jobpilot-coverage', status: 'completed' });
      const times = app.kernel.db.prepare(`SELECT started_at, finished_at FROM runs WHERE run_id = ?`).get('coverage-2026-10-11') as { started_at: string; finished_at: string };
      expect(Date.parse(times.finished_at)).toBeGreaterThan(Date.parse(times.started_at));
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
    expect(s.notification).toBe('Coverage: 2 verified (+0 new) · 1 proposed · 0 failing');
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
    expect(s.verdicts.verified).toBe(2);
    expect(registry(home)['alpha.test']).toMatchObject({ status: 'rejected', userOverride: 'rejected' });
    expect(s.notification).toBe('Coverage: 1 verified (+0 new) · 1 proposed · 0 failing');
  });

  it('a verified board that fails 3 weeks running becomes failing, and recovers when it answers again', async () => {
    const home = newHome();
    await run(home, W1, net().fetch);
    const s2 = await run(home, W2, net([ALPHA_BOARD]).fetch);
    expect(registry(home)['alpha.test']).toMatchObject({ status: 'verified', failWeeks: 1 });
    expect(s2.notification).toBe('Coverage: 2 verified (+0 new) · 1 proposed · 0 failing');
    // a second run in week 2 does not count week 2's failure again
    await run(home, '2026-10-19T04:30:00.000Z', net([ALPHA_BOARD]).fetch);
    expect(registry(home)['alpha.test']).toMatchObject({ status: 'verified', failWeeks: 1 });
    await run(home, W3, net([ALPHA_BOARD]).fetch);
    expect(registry(home)['alpha.test']).toMatchObject({ status: 'verified', failWeeks: 2 });
    const s4 = await run(home, W4, net([ALPHA_BOARD]).fetch);
    expect(registry(home)['alpha.test']).toMatchObject({ status: 'failing', failWeeks: 3 });
    expect(s4.notification).toBe('Coverage: 1 verified (+0 new) · 1 proposed · 1 failing');
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
    expect(s.deferred).toEqual({ byStage: { seed: 0, discover: 0, locate: 0, detect: 0, verify: 2 }, total: 2, hosts: [['boards-api.greenhouse.io', 'http-429']], disabledHosts: 1, transient: 0 });
    expect(calls.filter((u) => u.startsWith('https://boards-api.greenhouse.io/v1/'))).toHaveLength(1);
    expect(s.notification).toBe('Coverage: 1 verified (+1 new) · 0 proposed · 0 failing · not verified this week: 2, host-disabled boards-api.greenhouse.io (http-429)');
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
    expect(s).toMatchObject({ runId: 'coverage-2026-10-11', resumed: true, verdicts: { verified: 2, proposed: 1, failed: 1 } });
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

const SEED = join(FIX, 'catalogue-seed.jsonl');
const DELTA_BOARD = 'https://boards-api.greenhouse.io/v1/boards/deltaworks/jobs?content=true&pay_transparency=true';
const keyOf = (platform: 'greenhouse' | 'lever' | 'ashby', ref: string): string => freehireCompanyKey(platform, ref);

describe('coverage e2e: the freehire catalogue seed goes straight to the verifier (Task 7)', () => {
  const withSeed = (home: string, now: string, fetch: FetchLike, freehire: { catalogue: string | null; perWeek?: number; discovery: boolean }, extra: { afterStep?: (n: number) => void } = {}) =>
    runCoverage({ home, clock: { now: () => now }, fetch, sleep: async () => {}, codeHash: 'e2e', yieldCheck: () => null, freehire, ...extra });

  it('verifies a matching board, proposes a slug mismatch and a 404 board, all sourced freehire', async () => {
    const home = newHome();
    const n = net();
    const s = done(await withSeed(home, W1, n.fetch, { catalogue: SEED, discovery: false }));
    expect(s.exitCode).toBe(0);
    const r = registry(home);
    expect(r[keyOf('greenhouse', 'deltaworks')]).toMatchObject({ status: 'verified', platform: 'greenhouse', platformSlug: 'deltaworks', source: 'freehire' });
    expect(r[keyOf('lever', 'zq-board')]).toMatchObject({ status: 'proposed', platform: 'lever', source: 'freehire' });
    expect(r[keyOf('lever', 'zq-board')]?.reasons).toContain("is neither 'Zeta Quick'");
    expect(r[keyOf('ashby', 'ghostboard')]).toMatchObject({ status: 'proposed', platform: 'ashby', platformSlug: 'ghostboard', source: 'freehire' });
    expect(r[keyOf('ashby', 'ghostboard')]?.reasons).toMatch(/^not verified: board not found \(404\)/);
    expect(s.notification).toBe('Coverage: 3 verified (+3 new) · 3 proposed · 0 failing · Catalogue: 3 checked (1 verified, 2 proposed) · 0 left for later weeks');
    expect(s.catalogue).toEqual({ checked: 3, verified: 1, proposed: 2, left: 0 });
    // the dashboard's Companies tab labels the source from the registry row
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(app.listCompanies({ source: 'freehire' })).toHaveLength(3);
      expect(app.kernel.events('coverage-2026-10-11').filter((e) => e.kind === 'coverage.catalogue')).toHaveLength(1);
    } finally {
      app.close();
    }
    expect(n.calls.filter((u) => u === DELTA_BOARD)).toHaveLength(1);
  });

  it('a second run the same week replays at $0 and selects nothing new; the next week skips all three (registry)', async () => {
    const home = newHome();
    await withSeed(home, W1, net().fetch, { catalogue: SEED, discovery: false });
    const again = net();
    const s2 = done(await withSeed(home, W1_TUE, again.fetch, { catalogue: SEED, discovery: false }));
    expect(again.calls).toEqual([]);
    expect(s2.catalogue).toEqual({ checked: 0, verified: 0, proposed: 0, left: 0 });
    const later = net();
    const s3 = done(await withSeed(home, W2, later.fetch, { catalogue: SEED, discovery: false }));
    expect(later.calls.filter((u) => u === DELTA_BOARD || u.includes('zq-board') || u.includes('ghostboard'))).toEqual([]);
    expect(s3.catalogue).toEqual({ checked: 0, verified: 0, proposed: 0, left: 0 });
    expect(Object.keys(registry(home)).filter((k) => k.endsWith('.freehire'))).toHaveLength(3);
  });

  it('a rejected catalogue board (any status) is skipped in later weeks', async () => {
    const home = newHome();
    await withSeed(home, W1, net().fetch, { catalogue: SEED, discovery: false });
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(app.setCompanyOverride(keyOf('lever', 'zq-board'), 'rejected', W1_TUE)).toBe(true);
    } finally {
      app.close();
    }
    const later = net();
    await withSeed(home, W2, later.fetch, { catalogue: SEED, discovery: false });
    expect(later.calls.filter((u) => u.includes('zq-board'))).toEqual([]);
    expect(registry(home)[keyOf('lever', 'zq-board')]).toMatchObject({ status: 'rejected' });
  });

  it('the per-week limit takes the strongest evidence first and says how many are left', async () => {
    const home = newHome();
    const n = net();
    const s = done(await withSeed(home, W1, n.fetch, { catalogue: SEED, perWeek: 2, discovery: false }));
    expect(s.catalogue).toEqual({ checked: 2, verified: 1, proposed: 1, left: 1 });
    expect(s.notification).toContain('Catalogue: 2 checked (1 verified, 1 proposed) · 1 left for later weeks');
    expect(Object.keys(registry(home))).not.toContain(keyOf('ashby', 'ghostboard'));
    // a second run the same week: the week's limit is used up, the third is not selected (nothing is sent)
    const same = net();
    const sTue = done(await withSeed(home, W1_TUE, same.fetch, { catalogue: SEED, perWeek: 2, discovery: false }));
    expect(same.calls.filter((u) => u.includes('ghostboard'))).toEqual([]);
    expect(sTue.catalogue).toEqual({ checked: 0, verified: 0, proposed: 0, left: 1 });
    expect(Object.keys(registry(home))).not.toContain(keyOf('ashby', 'ghostboard'));
    // next week the third is picked up
    const s2 = done(await withSeed(home, W2, net().fetch, { catalogue: SEED, perWeek: 2, discovery: false }));
    expect(s2.catalogue).toEqual({ checked: 1, verified: 0, proposed: 1, left: 0 });
  });

  it('a detector guess and a catalogue entry for the same board: one verify step, the detector\'s candidate wins', async () => {
    const home = newHome();
    const seed = join(home, 'seed.jsonl');
    writeFileSync(
      seed,
      JSON.stringify({ platform: 'greenhouse', ref: 'AlphaRobotics', boardUrl: ALPHA_BOARD, company: 'Alpha Catalogue Name', board: 'alpharobotics', evidence: 9, example: { title: 'Engineer', location: 'India', url: 'https://example.test/j' } }) + '\n',
    );
    const n = net();
    const s = done(await withSeed(home, W1, n.fetch, { catalogue: seed, discovery: false }));
    expect(n.calls.filter((u) => u === ALPHA_BOARD)).toHaveLength(1);
    expect(registry(home)['alpha.test']).toMatchObject({ status: 'verified', source: 'pick' });
    expect(Object.keys(registry(home)).filter((k) => k.endsWith('.freehire'))).toEqual([]);
    expect(s.catalogue).toEqual({ checked: 0, verified: 0, proposed: 0, left: 0 });
  });

  it('a crash in the verify stage is resumed with the recorded selection: one record, every board read once', async () => {
    const home = newHome();
    let steps = 0;
    const first = net();
    await expect(withSeed(home, W1, first.fetch, { catalogue: SEED, discovery: false }, { afterStep: () => { if (++steps === 15) throw new Error('crash'); } })).rejects.toThrow('crash');
    const resumed = net();
    const s = done(await withSeed(home, W1, resumed.fetch, { catalogue: SEED, discovery: false }));
    expect(s.resumed).toBe(true);
    expect(s.catalogue).toEqual({ checked: 3, verified: 1, proposed: 2, left: 0 });
    expect(first.calls.filter((u) => u === DELTA_BOARD).length + resumed.calls.filter((u) => u === DELTA_BOARD).length).toBe(1);
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(app.kernel.events('coverage-2026-10-11').filter((e) => e.kind === 'coverage.catalogue')).toHaveLength(1);
    } finally {
      app.close();
    }
  });

  it('without the freehire option nothing about the catalogue appears', async () => {
    const home = newHome();
    const s = await run(home, W1, net().fetch);
    expect(s.catalogue).toBeUndefined();
    expect(s.notification).toBe('Coverage: 2 verified (+2 new) · 1 proposed · 0 failing');
  });
});

const DISCOVERY_PAGE = readFileSync(join(root, 'tests/fixtures/sx/freehire/discovery/e2e.json'), 'utf8');
const EMPTY_PAGE = JSON.stringify({ data: [], meta: { limit: 100, offset: 0, total: 0 } });
const QUILL_BOARD = 'https://boards-api.greenhouse.io/v1/boards/quillworks/jobs?content=true&pay_transparency=true';
const FH_SEARCH = 'https://freehire.me/api/v1/jobs/search?';

describe('coverage e2e: the weekly freehire discovery stage (sources-x Task 8)', () => {
  /** The recorded network plus freehire: the `"senior backend india"` query (q3) answers the e2e page, every other one an empty page. */
  function netWithFreehire(over?: { status: number; body: string }) {
    const n = net();
    const fh: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (!url.startsWith(FH_SEARCH)) return n.fetch(url, init);
      n.calls.push(url);
      fh.push(url);
      if (over !== undefined) return { status: over.status, text: async () => over.body };
      const body = decodeURIComponent(url).includes('"senior backend india"') ? DISCOVERY_PAGE : EMPTY_PAGE;
      return { status: 200, text: async () => body };
    };
    return { fetch, calls: n.calls, freehire: fh };
  }
  const withDiscovery = (home: string, now: string, fetch: FetchLike, freehire: { catalogue: string | null; perWeek?: number; discovery: boolean } = { catalogue: null, discovery: true }, extra: { afterStep?: (n: number) => void } = {}) =>
    runCoverage({ home, clock: { now: () => now }, fetch, sleep: async () => {}, codeHash: 'e2e', yieldCheck: () => null, freehire, ...extra });
  const leadsOf = (home: string, since = '2026-10-11') => {
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      return app.freehireLeads(since);
    } finally {
      app.close();
    }
  };
  const eventCount = (home: string, runId: string, kind: string): number => {
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      return app.kernel.events(runId).filter((e) => e.kind === kind).length;
    } finally {
      app.close();
    }
  };

  it('a discovered board is verified into the registry (source freehire-discovery), a lead is stored, the weekly line says both', async () => {
    const home = newHome();
    const n = netWithFreehire();
    const s = done(await withDiscovery(home, W1, n.fetch));
    expect(s.exitCode).toBe(0);
    expect(n.freehire).toHaveLength(7);
    expect(registry(home)[keyOf('greenhouse', 'quillworks')]).toMatchObject({ status: 'verified', platform: 'greenhouse', platformSlug: 'quillworks', source: 'freehire-discovery' });
    expect(n.calls.filter((u) => u === QUILL_BOARD)).toHaveLength(1);
    expect(s.discovery).toEqual({ boards: 1, verified: 1, leads: 1 });
    expect(s.notification).toBe('Coverage: 3 verified (+3 new) · 1 proposed · 0 failing · Discovery: 1 boards (1 verified) · 1 leads for review');
    expect(leadsOf(home)).toEqual([
      { leadKey: 'remotedotcom::senior-backend-engineer-zz1', source: 'remotedotcom', url: 'https://remote.example/jobs/senior-backend-engineer-zz1', title: 'Senior Backend Engineer', company: 'Example Labs', location: 'India', postedAt: '2026-10-13', evidence: 'india', firstWeek: '2026-10-11', lastWeek: '2026-10-11', queryId: 'q3' },
    ]);
    // the lead is data for the review lane only: no registry row, no board read for it
    expect(Object.keys(registry(home)).filter((k) => k.endsWith('.freehire'))).toEqual([keyOf('greenhouse', 'quillworks')]);
    expect(n.calls.filter((u) => u.includes('remote.example'))).toEqual([]);
  });

  it('the discover stage is its own run, between seed and locate; its pace is 2 s or more', async () => {
    const home = newHome();
    const n = netWithFreehire();
    const times: number[] = [];
    let t = Date.parse(W1);
    const clock = { now: () => new Date(t).toISOString() };
    const sleeps: number[] = [];
    done(await runCoverage({ home, clock, fetch: async (u, i) => { if (u.startsWith(FH_SEARCH)) times.push(t); return n.fetch(u, i); }, sleep: async (ms) => { sleeps.push(ms); t += ms; }, codeHash: 'e2e', yieldCheck: () => null, freehire: { catalogue: null, discovery: true } }));
    expect(times).toHaveLength(7);
    for (let i = 1; i < times.length; i++) expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(2000);
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(app.kernel.getRun('coverage-2026-10-11.discover')?.status).toBe('completed');
    } finally {
      app.close();
    }
  });

  it('a resume does not store the lead twice, asks no query again and sends the board once', async () => {
    const home = newHome();
    let steps = 0;
    const first = netWithFreehire();
    await expect(withDiscovery(home, W1, first.fetch, undefined, { afterStep: () => { if (++steps === 14) throw new Error('crash'); } })).rejects.toThrow('crash');
    const resumed = netWithFreehire();
    const s = done(await withDiscovery(home, W1, resumed.fetch));
    expect(s.resumed).toBe(true);
    expect(s.discovery).toEqual({ boards: 1, verified: 1, leads: 1 });
    expect(first.freehire.length + resumed.freehire.length).toBe(7);
    expect(first.calls.filter((u) => u === QUILL_BOARD).length + resumed.calls.filter((u) => u === QUILL_BOARD).length).toBe(1);
    expect(leadsOf(home)).toHaveLength(1);
    expect(eventCount(home, 'coverage-2026-10-11', 'coverage.leads')).toBe(1);
    // a second run of the same week (completed run -> new run id) finds the lead again and keeps one row
    const again = done(await withDiscovery(home, W1_TUE, netWithFreehire().fetch));
    expect(again.discovery?.boards).toBe(0);
    expect(leadsOf(home)).toHaveLength(1);
  });

  it('next week: the board the registry holds is not sent again, the lead keeps its first week and takes the new last week', async () => {
    const home = newHome();
    await withDiscovery(home, W1, netWithFreehire().fetch);
    const later = netWithFreehire();
    const s = done(await withDiscovery(home, W2, later.fetch));
    expect(s.discovery).toEqual({ boards: 0, verified: 0, leads: 1 });
    expect(later.calls.filter((u) => u === QUILL_BOARD)).toEqual([]);
    expect(leadsOf(home, '2026-10-11').map((l) => [l.firstWeek, l.lastWeek])).toEqual([['2026-10-11', '2026-10-18']]);
    expect(leadsOf(home, '2026-10-18')).toHaveLength(1);
    expect(leadsOf(home, '2026-10-25')).toHaveLength(0);
  });

  it('discovery boards go before the catalogue and the catalogue skips them: one verify step, source freehire-discovery', async () => {
    const home = newHome();
    const seed = join(home, 'seed.jsonl');
    const quill = { platform: 'greenhouse', ref: 'quillworks', boardUrl: QUILL_BOARD, company: 'Quill Catalogue Name', board: 'quillworks', evidence: 9, example: { title: 'Engineer', location: 'India', url: 'https://example.test/j' } };
    writeFileSync(seed, readFileSync(SEED, 'utf8') + JSON.stringify(quill) + '\n');
    const n = netWithFreehire();
    const s = done(await withDiscovery(home, W1, n.fetch, { catalogue: seed, discovery: true }));
    expect(n.calls.filter((u) => u === QUILL_BOARD)).toHaveLength(1);
    expect(registry(home)[keyOf('greenhouse', 'quillworks')]).toMatchObject({ source: 'freehire-discovery', status: 'verified' });
    expect(Object.keys(registry(home)).filter((k) => k.endsWith('.freehire'))).toHaveLength(4);
    // the catalogue keeps its own three entries; the fourth was taken by the discovery
    expect(s.catalogue).toEqual({ checked: 3, verified: 1, proposed: 2, left: 0 });
    expect(s.discovery).toEqual({ boards: 1, verified: 1, leads: 1 });
    expect(s.notification).toContain('Catalogue: 3 checked (1 verified, 2 proposed) · 0 left for later weeks · Discovery: 1 boards (1 verified) · 1 leads for review');
  });

  it('freehire down (429): no findings, no registry row, no lead, the other stages run; the outage is a named note', async () => {
    const home = newHome();
    const n = netWithFreehire({ status: 429, body: 'slow down' });
    const s = done(await withDiscovery(home, W1, n.fetch));
    expect(n.freehire).toHaveLength(1);
    expect(s.discovery).toEqual({ boards: 0, verified: 0, leads: 0 });
    expect(s.verdicts).toEqual({ verified: 2, proposed: 1, failed: 1 });
    expect(leadsOf(home)).toEqual([]);
    expect(s.exitCode).toBe(0);
    expect(s.notification).toContain('Discovery: 0 boards (0 verified) · 0 leads for review');
  });

  it('without discovery nothing about it appears, and no freehire request is made', async () => {
    const home = newHome();
    const n = netWithFreehire();
    const s = done(await withDiscovery(home, W1, n.fetch, { catalogue: SEED, discovery: false }));
    expect(n.freehire).toEqual([]);
    expect(s.discovery).toBeUndefined();
    expect(s.notification).not.toContain('Discovery');
    expect(leadsOf(home)).toEqual([]);
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
