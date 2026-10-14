import { chmodSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDashboard } from '../../src/app/web/server.js';
import { Sessions } from '../../src/app/web/security.js';
import { BUDGET_SPEC, buildSyntheticDb } from './synthetic.js';

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
/** Heap left per request (heapUsed after minus before, after a forced GC): measured 12-33 MB; the old code ~400 MB. */
export const HEAP_PER_REQUEST_MB = 64;
const WARM_N = 20;

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const root = join(import.meta.dirname, '../..');
const NOW = '2026-09-10T06:30:00.000Z';
let home: string;

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

async function warm(app: App, route: string, p95Budget: number): Promise<void> {
  const ms: number[] = [];
  let heap = 0;
  for (let i = 0; i < WARM_N; i++) {
    const r = await timed(app, route);
    ms.push(r.ms);
    heap = Math.max(heap, r.heapMb);
  }
  ms.sort((a, b) => a - b);
  within(route, 'warm p95', ms[Math.ceil(0.95 * ms.length) - 1] as number, p95Budget);
  within(route, 'heap per request', heap, HEAP_PER_REQUEST_MB, 'MB');
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'jobpilot-perf-'));
  chmodSync(home, 0o700);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  const built = buildSyntheticDb(join(home, 'jobpilot.db'), BUDGET_SPEC);
  console.log(`perf synthetic DB: ${(built.bytes / 1e9).toFixed(2)} GB in ${(built.buildMs / 1000).toFixed(1)} s`);
}, 300_000);
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('performance budget on the large synthetic DB', () => {
  it('GET /: fresh and warm, within budget, a full page of rows', async () => {
    // the process is warm (code loaded and compiled, as a dashboard that has served any page), the connection is not
    await timed(fresh(), '/facts');
    const app = fresh();
    const first = await timed(app, '/');
    expect((first.body.match(/data-job="/g) ?? []).length).toBe(100);
    within('/', 'fresh connection', first.ms, ROOT_FRESH_MS);
    within('/', 'heap per request', first.heapMb, HEAP_PER_REQUEST_MB, 'MB');
    await warm(app, '/', ROOT_WARM_P95_MS);
  });

  it('GET /runs: the first view after a run, then a fresh dashboard, then warm', async () => {
    const afterRun = await timed(fresh(), '/runs');
    expect(afterRun.body).toMatch(/Audit log intact: <span class="num">500000<\/span> events/);
    expect(afterRun.body).toMatch(/the <span class="num">50000<\/span> newer events/);
    within('/runs', 'first view after a run', afterRun.ms, RUNS_AFTER_RUN_MS);
    const app = fresh();
    const first = await timed(app, '/runs');
    within('/runs', 'fresh connection', first.ms, RUNS_FRESH_MS);
    within('/runs', 'heap per request', first.heapMb, HEAP_PER_REQUEST_MB, 'MB');
    await warm(app, '/runs', RUNS_WARM_P95_MS);
  });
});
