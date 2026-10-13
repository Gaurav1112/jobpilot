import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runFreelance, type FreelanceSummary } from '../../../src/app/freelance/run.js';
import { loadRunPack, prepareFreelance, preparePipeline, resolvePdftotext } from '../../../src/app/kernel.js';
import { offlineProviders } from '../../../src/app/offline.js';
import { AppStore, type JobUpsert } from '../../../src/app/store/app-store.js';
import { mergePolicy, policyHash, PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import type { FetchLike } from '../../../src/kernel/providers.js';
import { Store } from '../../../src/kernel/store/store.js';

/** Task 9 fix round 1: one dead platform never silences the others; freelance pacing; board seeds. */
const root = join(import.meta.dirname, '../../..');
const FIXTURES = join(root, 'tests/fixtures/freelance-e2e');
const PACK = join(root, 'tests/fixtures/pack');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();
const homes: string[] = [];
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-freelance-run-'));
  homes.push(home);
  cpSync(PACK, join(home, 'pack'), { recursive: true });
  return home;
}
const isFreelancer = (url: string) => new URL(url).hostname === 'www.freelancer.com';

describe.skipIf(pdftotext === undefined)('one dead platform never silences the others', () => {
  it('Freelancer down in am: HN and Remotive are fetched and projected; the streak reaches 4 and "looks dead" appears at 3', async () => {
    const home = newHome();
    const off = offlineProviders(FIXTURES);
    const fetch: FetchLike = async (url, init) => {
      if (isFreelancer(url)) throw new Error('ECONNRESET');
      return off.fetch(url, init);
    };
    const runs: FreelanceSummary[] = [];
    for (const at of ['2026-10-12T03:00:00.000Z', '2026-10-12T03:30:00.000Z', '2026-10-12T14:30:00.000Z', '2026-10-13T03:00:00.000Z']) {
      runs.push(await runFreelance({ home, clock: { now: () => at }, fetch, sleep: async () => {}, pdftotext: pdftotext as string }));
    }
    const [am] = runs as [FreelanceSummary];
    for (const agent of ['src-hn', 'src-remotive']) expect(am.counts.byAgent[agent], agent).toMatchObject({ failed: 0, skipped: 0 });
    expect(am.counts.byAgent['src-freelancer']?.failed).toBeGreaterThan(0);
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      const platforms = new Set(app.listGigs({ duplicates: true }).map((g) => g.platform));
      expect(platforms).toEqual(new Set(['remotive', 'hn-freelancer', 'hn-hiring']));
      expect(app.sourceHealth('freelancer').map((r) => [r.week, r.probeFailures, r.runs])).toEqual([['2026-W42', 4, 4]]);
      expect(app.sourceHealth('remotive')[0]).toMatchObject({ probeFailures: 0, failedRuns: 0 });
    } finally {
      app.close();
    }
    // The HN contract is announced; the problems are Freelancer's own (its failed and skipped queries), never the
    // no-op skips of src-freelancer on other platforms' requests.
    expect(am.notification).toMatch(/^1 new gig ≥\$40\/h · top: \$70\/h SEEKING FREELANCER \| Remote, worldwide… \(HN\) · \d+ problems$/);
    expect(am.problems.every((p) => p.agent === 'src-freelancer' && /^freelancer /.test(p.item))).toBe(true);
    expect(am.problems.length).toBe(10);
    const dead = runs.map((r) => r.problems.filter((p) => p.kind === 'source-dead').map((p) => p.reason));
    expect(dead).toEqual([[], [], ['source freelancer looks dead: 3 runs in a row failed every fetch'], ['source freelancer looks dead: 4 runs in a row failed every fetch']]);
  }, 600_000);
});

describe('freelance pacing', () => {
  it('the freelance run paces hosts at the largest platform minIntervalMs (2000 ms); the daily policy and its hash are unchanged', () => {
    const loaded = loadRunPack(PACK, {}, '2026-10', undefined, 'strict');
    const fl = prepareFreelance(loaded.pack);
    expect(fl.policy.minHostIntervalMs).toBe(2000);
    const daily = preparePipeline(loaded.pack);
    expect(daily.policy.minHostIntervalMs).toBe(1000);
    expect(daily.policyHash).toBe(policyHash(mergePolicy(PRODUCT_POLICY_V1, loaded.pack.policyUser)));
    expect(fl.policyHash).not.toBe(daily.policyHash);
  });

  it.skipIf(pdftotext === undefined)('two Freelancer requests are at least 2000 ms apart', async () => {
    const home = newHome();
    let t = Date.parse('2026-10-12T03:00:00.000Z');
    const off = offlineProviders(FIXTURES);
    const at: number[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (isFreelancer(url)) at.push(t);
      return off.fetch(url, init);
    };
    const sleeps: number[] = [];
    await runFreelance({
      home, clock: { now: () => new Date(t).toISOString() }, fetch, pdftotext: pdftotext as string,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    expect(at).toHaveLength(10);
    for (let i = 1; i < at.length; i++) expect((at[i] as number) - (at[i - 1] as number)).toBeGreaterThanOrEqual(2000);
    expect(sleeps).toContain(2000);
  }, 600_000);
});

describe('board seeds', () => {
  const job = (k: string, at: string, reasons: string[] = ['employment:contract']): JobUpsert => ({
    jobKey: k.padEnd(16, '0'), dedupeKey: `d${k}`.padEnd(16, '0'), source: 'lever', sourceId: k, company: 'Example Lever Co', title: `Contract ${k}`, url: `https://x.test/${k}`,
    ats: 'lever', location: 'Remote', remote: null, compMinInr: null, compMaxInr: null, compBasis: null, score: null, breakdown: null, verdict: 'rejected', reasons, notes: [],
    jdText: '', terms: null, recommendedFormat: null, docsState: 'none', docsDetail: null, postedAt: null, at,
  });
  const posting = (s: Store, jobKey: string, n: number) =>
    s.db.prepare(`INSERT INTO envelopes (envelope_id, step_key, idx, type, body) VALUES (?, ?, 0, 'Posting@1', ?)`).run(`e-${jobKey}-${n}`, `s-${jobKey}-${n}`, JSON.stringify({ type: 'Posting@1', payload: { jobKey, version: n } }));

  it('seeds only contract jobs seen in the last 14 days and not skipped or rejected, each with its newest posting, in one envelope query', () => {
    const kernel = Store.open(':memory:');
    const app = AppStore.on(kernel);
    const now = '2026-10-12T03:00:00.000Z';
    app.upsertJob(job('a', '2026-10-11T00:00:00.000Z'));
    app.upsertJob(job('b', '2026-09-27T02:59:59.000Z')); // more than 14 days before now
    app.upsertJob(job('c', '2026-10-10T00:00:00.000Z'));
    app.setStatus('c'.padEnd(16, '0'), 'skipped', 'user', now);
    app.upsertJob(job('d', '2026-10-10T00:00:00.000Z'));
    app.setStatus('d'.padEnd(16, '0'), 'rejected', 'user', now);
    app.upsertJob(job('e', '2026-10-10T00:00:00.000Z', ['employment:full-time-only']));
    app.upsertJob(job('f', '2026-10-12T00:00:00.000Z', ['employment:part-time']));
    app.upsertJob(job('g', '2026-10-12T00:00:00.000Z', ['employment:freelance']));
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) posting(kernel, k.padEnd(16, '0'), 1);
    posting(kernel, 'a'.padEnd(16, '0'), 2);
    const sql: string[] = [];
    const prepare = kernel.db.prepare.bind(kernel.db);
    kernel.db.prepare = ((src: string) => {
      sql.push(src);
      return prepare(src);
    }) as typeof kernel.db.prepare;
    const since = new Date(Date.parse(now) - 14 * 86_400_000).toISOString();
    const r = app.contractPostings(since);
    expect(r.postings.map((p) => [p.jobKey[0], (p.posting as { version: number }).version])).toEqual([['a', 2], ['f', 1]]);
    expect(r.missing.map((k) => k[0])).toEqual(['g']);
    expect(sql.filter((s) => /FROM envelopes/.test(s))).toHaveLength(1);
  });
});
