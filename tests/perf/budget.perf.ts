import { chmodSync, cpSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppStore } from '../../src/app/store/app-store.js';
import { DEFAULT_RETENTION, planCompaction } from '../../src/app/store/retention.js';
import { createDashboard } from '../../src/app/web/server.js';
import { Sessions } from '../../src/app/web/security.js';
import { BUDGET_SPEC, buildSyntheticDb, REVIEW_GIG_KEY } from './synthetic.js';

/**
 * dashboard-perf governance: the performance budget gate (`node --run perf`, part of `node --run verify`).
 *
 * It builds the large synthetic DB (`synthetic.ts`: 20,000 jobs, 300,000 envelopes, 500,000 events, ~1.8 GB, ~11 s)
 * in a temp home with the fixture pack, then times `GET /` and `GET /runs` through the real app (`app.request`), from a
 * fresh dashboard (a new connection, so SQLite's cache is empty; the process has served another page, so the code is
 * loaded) and warm (the same dashboard, 20 requests, p95), and the heap each request leaves behind. A breach fails with `perf-budget: <route> <what> <ms> > <budget>`.
 *
 * How the numbers were chosen (perf-report.md, 2026-10-14, 12-core Mac): on this DB the code before dashboard-perf
 * took 600-710 ms for `/` (warm p50 308) and 1.6-1.7 s for `/runs` (warm p50 1.3 s), with ~400 MB heap per request;
 * after it, `/` 53-140 ms fresh and 25-35 ms warm, `/runs` 18-25 ms fresh, 15 ms warm, 155-214 ms for the first view
 * after a daily run (it walks that run's 50,000 events once), 12-33 MB heap. Each budget is the target the dashboard
 * must meet with a margin of 2-4x over the measurement, and far below the old numbers, so a regression to a full
 * scan or a full chain walk fails while a slower machine does not.
 */

/** `GET /`, the first request of a fresh dashboard (new connection, warm process): measured 32-60 ms here, 53-140 ms as a new process. */
export const ROOT_FRESH_MS = 150;
/** `GET /`, p95 of 20 warm requests: measured 25-35 ms. */
export const ROOT_WARM_P95_MS = 100;
/** `GET /runs`, a fresh dashboard, nothing new since the verified checkpoint: measured 18-25 ms. */
export const RUNS_FRESH_MS = 200;
/** `GET /runs`, p95 of 20 warm requests: measured 15 ms. */
export const RUNS_WARM_P95_MS = 100;
/** `GET /runs`, the first view after a daily run (it walks that run's 50,000 events once): measured 155-214 ms. */
export const RUNS_AFTER_RUN_MS = 500;
/** `GET /freelance` (the contracts list with each gig's newest Gig@1 / GigRendered@1, `gigExtras`), best of 3 fresh. */
export const FREELANCE_FRESH_MS = 150;
/** `GET /freelance`, p95 of 20 warm requests: measured 65 ms. */
export const FREELANCE_WARM_P95_MS = 150;
/** Heap left by one `/freelance` view: it lists every gig of the tab (400 here) with its extras; measured 64 MB. */
export const FREELANCE_HEAP_MB = 128;
/** `contractPostings` (the freelance run's boards seeds: the newest Posting@1 of each contract job), warm. */
export const CONTRACT_POSTINGS_MS = 500;
/** The retention planner (`store compact` dry run) on this DB (~84k Posting@1, 300k envelopes, 500k events). */
export const RETENTION_PLAN_MS = 10_000;
/** Heap left per request (heapUsed after minus before, after a forced GC): measured 12-33 MB; the old code ~400 MB. */
export const HEAP_PER_REQUEST_MB = 64;
/** Every page, fresh (best of 3 new dashboards) and warm (p95 of 20), within 150 ms (spec §3). */
export const PAGE_MS = 150;
export const PAGE_HEAP_MB = 64;
/**
 * Routes over 150 ms when the gate first covered them (UX upgrade A0), with the task that fixes each. That task deletes
 * the entry first (its failing test). A route that is over budget and not listed here fails the gate.
 */
export const KNOWN_SLOW: Readonly<Record<string, { readonly ms: number; readonly fixedIn: string }>> = {
  '/freelance?tab=review': { ms: 600, fixedIn: 'Task 19 (A3: Review paged at 50)' },
  '/companies': { ms: 1100, fixedIn: 'Task 20 (A9: skipped hosts summarised and paged)' },
};
const budgetOf = (route: string): number => KNOWN_SLOW[route]?.ms ?? PAGE_MS;
const WARM_N = 20;
/** A fresh-connection time is the best of this many fresh dashboards (one sample is at the mercy of the machine). */
const FRESH_TRIES = 3;
/** Temp homes of earlier gate runs that died before cleaning up are swept once older than this. */
const STALE_TEMP_MS = 60 * 60_000;
const TEMP_PREFIX = 'jobpilot-perf-';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const root = join(import.meta.dirname, '../..');
const NOW = '2026-09-10T06:30:00.000Z';
let home: string;
let readyJobKey: string;

type App = ReturnType<typeof createDashboard>;
const fresh = (): App => createDashboard({ home, clock: { now: () => NOW }, sessions: new Sessions(Buffer.alloc(32, 7)) });

async function timed(app: App, path: string): Promise<{ ms: number; heapMb: number; body: string }> {
  gc();
  const before = process.memoryUsage().heapUsed;
  const t = performance.now();
  const r = await app.request(path, { headers: { host: 'localhost', cookie: 'jp_sid=' + 'ef'.repeat(16) } });
  const body = await r.text();
  const ms = performance.now() - t;
  expect(r.status, `${path}: ${body.slice(0, 200)}`).toBe(200);
  return { ms, heapMb: (process.memoryUsage().heapUsed - before) / 1_048_576, body };
}

function within(route: string, what: string, value: number, budget: number, unit = 'ms'): void {
  const shown = `${Math.round(value)}${unit}`;
  console.log(`perf ${route} ${what}: ${shown} (budget ${budget}${unit})`);
  expect(value <= budget, `perf-budget: ${route} ${what} ${shown} > ${budget}${unit}`).toBe(true);
}

async function warm(app: App, route: string, p95Budget: number, heapBudget = HEAP_PER_REQUEST_MB): Promise<void> {
  const ms: number[] = [];
  let heap = 0;
  for (let i = 0; i < WARM_N; i++) {
    const r = await timed(app, route);
    ms.push(r.ms);
    heap = Math.max(heap, r.heapMb);
  }
  ms.sort((a, b) => a - b);
  within(route, 'warm p95', ms[Math.ceil(0.95 * ms.length) - 1] as number, p95Budget);
  within(route, 'heap per request', heap, heapBudget, 'MB');
}

/** Removes `jobpilot-perf-*` temp homes older than STALE_TEMP_MS (a killed gate leaves its 1.8 GB behind). */
function sweepStaleTemps(now = Date.now()): void {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const p = join(tmpdir(), name);
    try {
      if (now - statSync(p).mtimeMs > STALE_TEMP_MS) {
        rmSync(p, { recursive: true, force: true });
        console.log(`perf swept a stale temp home: ${p}`);
      }
    } catch {
      // gone meanwhile, or not ours to remove
    }
  }
}

beforeAll(() => {
  sweepStaleTemps();
  home = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  chmodSync(home, 0o700);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  const built = buildSyntheticDb(join(home, 'jobpilot.db'), BUDGET_SPEC);
  console.log(`perf synthetic DB: ${(built.bytes / 1e9).toFixed(2)} GB in ${(built.buildMs / 1000).toFixed(1)} s`);
  const store = AppStore.open(join(home, 'jobpilot.db'));
  try {
    readyJobKey = (store.kernel.db.prepare("SELECT job_key FROM jobs WHERE docs_state = 'ready' AND duplicate_of IS NULL ORDER BY job_key LIMIT 1").get() as { job_key: string }).job_key;
  } finally {
    store.close();
  }
}, 300_000);
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('performance budget on the large synthetic DB', () => {
  it('GET /freelance: fresh and warm (gigExtras: the newest envelope per gig through events_step_done)', async () => {
    await timed(fresh(), '/facts');
    const firsts = [];
    for (let i = 0; i < FRESH_TRIES; i++) firsts.push(await timed(fresh(), '/freelance'));
    expect(firsts[0]?.body).toMatch(/backend contract/);
    within('/freelance', 'fresh connection (best of 3)', Math.min(...firsts.map((f) => f.ms)), FREELANCE_FRESH_MS);
    within('/freelance', 'heap per request', Math.max(...firsts.map((f) => f.heapMb)), FREELANCE_HEAP_MB, 'MB');
    await warm(fresh(), '/freelance', FREELANCE_WARM_P95_MS, FREELANCE_HEAP_MB);
  });

  it('contractPostings and the retention planner (store compact dry run)', () => {
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      app.contractPostings('2026-08-01T00:00:00.000Z'); // warm
      let t = performance.now();
      const cp = app.contractPostings('2026-08-01T00:00:00.000Z');
      const cpMs = performance.now() - t;
      expect(cp.postings.length).toBeGreaterThan(500);
      within('contractPostings', `${cp.postings.length} jobs`, cpMs, CONTRACT_POSTINGS_MS);
      t = performance.now();
      const plan = planCompaction(app, { now: '2026-09-10T12:00:00.000Z', policy: DEFAULT_RETENTION, policyHash: 'perf', includeIncomplete: false });
      const planMs = performance.now() - t;
      expect(plan.pinnedBy['R5 newest postings']).toBeGreaterThan(0);
      within('store compact', 'dry-run plan', planMs, RETENTION_PLAN_MS);
    } finally {
      app.close();
    }
  });

  it('GET /: fresh and warm, within budget, a full page of rows', async () => {
    // the process is warm (code loaded and compiled, as a dashboard that has served any page), the connection is not
    await timed(fresh(), '/facts');
    // best of 3 fresh dashboards (review: one sample flaked on a busy machine); the structural gate is indexes.test.ts
    const firsts = [];
    for (let i = 0; i < FRESH_TRIES; i++) firsts.push(await timed(fresh(), '/'));
    const first = firsts.reduce((a, b) => (b.ms < a.ms ? b : a));
    expect((first.body.match(/data-job="/g) ?? []).length).toBe(100);
    within('/', 'fresh connection (best of 3)', first.ms, ROOT_FRESH_MS);
    within('/', 'heap per request', Math.max(...firsts.map((f) => f.heapMb)), HEAP_PER_REQUEST_MB, 'MB');
    await warm(fresh(), '/', ROOT_WARM_P95_MS);
  });

  it('GET /runs: the first view after a run, then a fresh dashboard, then warm', async () => {
    const afterRun = await timed(fresh(), '/runs');
    expect(afterRun.body).toMatch(/Audit log intact: <span class="num">500000<\/span> events/);
    expect(afterRun.body).toMatch(/the <span class="num">50000<\/span> newer events/);
    within('/runs', 'first view after a run', afterRun.ms, RUNS_AFTER_RUN_MS);
    const firsts = [];
    for (let i = 0; i < FRESH_TRIES; i++) firsts.push(await timed(fresh(), '/runs'));
    within('/runs', 'fresh connection (best of 3)', Math.min(...firsts.map((f) => f.ms)), RUNS_FRESH_MS);
    within('/runs', 'heap per request', Math.max(...firsts.map((f) => f.heapMb)), HEAP_PER_REQUEST_MB, 'MB');
    await warm(fresh(), '/runs', RUNS_WARM_P95_MS);
  });
});

async function gate(route: string, check: (body: string) => void): Promise<void> {
  await timed(fresh(), '/facts'); // a warm process, as a dashboard that has served any page
  const firsts = [];
  for (let i = 0; i < FRESH_TRIES; i++) firsts.push(await timed(fresh(), route));
  check(firsts[0]?.body ?? '');
  within(route, 'fresh connection (best of 3)', Math.min(...firsts.map((f) => f.ms)), budgetOf(route));
  within(route, 'heap per request', Math.max(...firsts.map((f) => f.heapMb)), PAGE_HEAP_MB, 'MB');
  await warm(fresh(), route, budgetOf(route), PAGE_HEAP_MB);
}

describe('every page within budget (UX upgrade A0)', () => {
  it('GET /freelance?tab=review (354 review gigs)', async () => {
    await gate('/freelance?tab=review', (b) => expect((b.match(/data-gig="e/g) ?? []).length).toBeGreaterThanOrEqual(50));
  });
  it('GET /companies (1,500 companies, 781 skipped hosts)', async () => {
    await gate('/companies', (b) => expect(b).toMatch(/data-company="/));
  });
  it('GET /facts', async () => {
    await gate('/facts', (b) => expect(b).toMatch(/<ol class="facts"/));
  });
  it('GET /jobs/:key (a ready job)', async () => {
    await gate(`/jobs/${readyJobKey}`, (b) => expect(b).toMatch(/<h1>/));
  });
  it('GET /freelance/:key (a review gig)', async () => {
    await gate(`/freelance/${REVIEW_GIG_KEY}`, (b) => expect(b).toMatch(/Before you bid/));
  });
  it('KNOWN_SLOW names only routes this gate times', () => {
    const timedRoutes = ['/freelance?tab=review', '/companies', '/facts', '/', '/runs', '/freelance'];
    expect(Object.keys(KNOWN_SLOW).filter((r) => !timedRoutes.includes(r))).toEqual([]);
  });
});
