import { copyFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TRANSIENT_DISABLE_MS } from '../../../src/app/coverage/gate.js';
import { MAX_REQUEUES, TRANSIENT_RETRY_AFTER_MS } from '../../../src/app/coverage/pipeline.js';
import { runCoverage, type CoverageResult, type CoverageSummary } from '../../../src/app/coverage/run.js';
import { offlineProviders } from '../../../src/app/offline.js';
import { AppStore } from '../../../src/app/store/app-store.js';
import type { FetchLike } from '../../../src/kernel/providers.js';

/**
 * C1 (final review): a network outage in the middle of a coverage run. The run must not disable hosts for the run,
 * must not memoise "not located" for what the outage touched, must ask again after it, and must pause when the
 * machine is offline. The fixture run (tests/fixtures/coverage/e2e) without an outage: located listed 3,
 * homepage-link 1, none 1; verified 2, proposed 1, failed 1 (see e2e.test.ts).
 */
const root = join(import.meta.dirname, '../../..');
const FIX = join(root, 'tests/fixtures/coverage/e2e');
const W1 = '2026-10-11T01:30:00.000Z';
const SEED_HOSTS = new Set(['codeload.github.com', 'yc-oss.github.io']);
const BASELINE = { located: { listed: 3, 'homepage-link': 1, path: 0, subdomain: 0, sitemap: 0, none: 1 }, verdicts: { verified: 2, proposed: 1, failed: 1 } };

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-cov-outage-'));
  homes.push(home);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  copyFileSync(join(FIX, 'companies.yaml'), join(home, 'pack', 'companies.yaml'));
  return home;
}

const sysFail = (code: string): never => {
  throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
};

/** A world with a clock (each read 1 s on), the recorded fixtures, and an outage `down(now)` decides. */
function world(down: (t: number, url: string) => string | null) {
  let t = Date.parse(W1);
  const offline = offlineProviders(FIX).fetch;
  const failed: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const code = down(t, url);
    if (code !== null) {
      failed.push(url);
      return sysFail(code);
    }
    return offline(url, init);
  };
  return {
    clock: { now: () => new Date((t += 1000)).toISOString() },
    fetch,
    failed,
    jump: (ms: number) => void (t += ms),
    at: () => t,
  };
}
type World = ReturnType<typeof world>;

const invoke = (home: string, w: World, online: () => Promise<boolean> = async () => true): Promise<CoverageResult> =>
  runCoverage({ home, clock: w.clock, fetch: w.fetch, sleep: async () => {}, codeHash: 'outage', yieldCheck: () => null, online });

/** Invocations until the run completes (each later one `gapMs` after the last), at most `max`. */
async function untilDone(home: string, w: World, gapMs: number, max = 8, online?: () => Promise<boolean>): Promise<{ results: CoverageResult[]; summary: CoverageSummary }> {
  const results: CoverageResult[] = [];
  for (let i = 0; i < max; i++) {
    const r = await invoke(home, w, online);
    results.push(r);
    if (r.status === 'completed') return { results, summary: r };
    w.jump(gapMs);
  }
  throw new Error(`not completed after ${max} invocations: ${results.map((r) => (r.status === 'paused' ? r.reason : r.status)).join(', ')}`);
}

function db<T>(home: string, f: (app: AppStore) => T): T {
  const app = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return f(app);
  } finally {
    app.close();
  }
}
const locateEvents = (home: string, kind: string) => db(home, (a) => a.kernel.events('coverage-2026-10-11.locate').filter((e) => e.kind === kind).map((e) => JSON.parse(e.data) as Record<string, unknown>));

describe('C1: a network outage mid-run', () => {
  it('the retry limits are named constants', () => {
    expect(TRANSIENT_RETRY_AFTER_MS).toBe(10 * 60_000);
    expect(MAX_REQUEUES).toBe(3);
  });

  it('a 10-second outage: no host disabled for the run, the affected candidates asked again after it, nothing saved as "not located"', async () => {
    const home = newHome();
    let start: number | undefined;
    const w = world((t, url) => {
      if (SEED_HOSTS.has(new URL(url).hostname)) return null;
      start ??= t;
      return t - start < 10_000 ? 'ECONNRESET' : null;
    });
    const { results, summary } = await untilDone(home, w, TRANSIENT_DISABLE_MS + 60_000);
    expect(w.failed.length).toBeGreaterThan(0);
    expect(results.length).toBeGreaterThan(1);
    expect(results.slice(0, -1).every((r) => r.status === 'paused' && r.reason === 'retry wait')).toBe(true);
    // the same answers as without an outage, nothing deferred, nothing left transient
    expect(summary.located).toEqual(BASELINE.located);
    expect(summary.verdicts).toEqual(BASELINE.verdicts);
    expect(summary.deferred).toMatchObject({ total: 0, transient: 0 });
    expect(summary.exitCode).toBe(0);
    // no run-long disable came from the outage: only a robots-transient row could have, and it expired and was lifted
    expect([...db(home, (a) => a.coverageHostState('coverage-2026-10-11'))]).toEqual([]);
    // the failed steps failed as transport failures and were re-queued, never finished as "none"
    expect(locateEvents(home, 'step_failed').map((d) => d['error'])).toContain('network');
    expect(db(home, (a) => a.kernel.events('coverage-2026-10-11.locate').filter((e) => e.kind === 'coverage.requeued').length)).toBeGreaterThan(0);
    const unlocated = summary.projection.unlocated;
    expect(unlocated).toEqual({ proposed: 0, failed: 0, counted: 1 });
  });

  it('the machine found offline (5 network errors in a row, then the DNS check): the slice pauses "offline", never a failed attempt; the next one finishes', async () => {
    const home = newHome();
    let start: number | undefined;
    let dark = false;
    const w = world((t, url) => {
      if (SEED_HOSTS.has(new URL(url).hostname)) return null;
      start ??= t;
      dark = t - start < 120_000;
      return dark ? 'ENOTFOUND' : null; // offline, every name fails to resolve
    });
    const online = async () => !dark;
    const first = await invoke(home, w, online);
    expect(first).toMatchObject({ status: 'paused', reason: 'offline', exitCode: 0 });
    // no name failed while offline became no-such-host for the run
    expect([...db(home, (a) => a.coverageHostState('coverage-2026-10-11')).values()].filter((why) => why !== 'robots-transient')).toEqual([]);
    w.jump(TRANSIENT_DISABLE_MS + 60_000);
    const { summary } = await untilDone(home, w, TRANSIENT_DISABLE_MS + 60_000, 8, online);
    expect(summary.located).toEqual(BASELINE.located);
    expect(summary.verdicts).toEqual(BASELINE.verdicts);
  });

  it('R1: a captive portal (DNS answers, every HTTPS request fails with a certificate error for 40 s): the slice pauses offline, no host is disabled for the run, the affected candidates are asked again', async () => {
    const home = newHome();
    let start: number | undefined;
    const w = world((t, url) => {
      if (SEED_HOSTS.has(new URL(url).hostname)) return null;
      start ??= t;
      return t - start < 40_000 ? 'CERT_HAS_EXPIRED' : null;
    });
    // every request to the probe host, with its clock time (re-check m5: the probe obeys the run's host spacing)
    const probeHost: number[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (new URL(url).hostname === 'boards-api.greenhouse.io') probeHost.push(w.at());
      return w.fetch(url, init);
    };
    // no `online` given: the run's own HTTPS check, through the same (portal) fetch; sleeping moves the clock
    const first = await runCoverage({ home, clock: w.clock, fetch, sleep: async (ms) => w.jump(ms), codeHash: 'outage', yieldCheck: () => null });
    expect(first).toMatchObject({ status: 'paused', reason: 'offline' });
    expect(probeHost.length).toBeGreaterThan(0);
    expect([...db(home, (a) => a.coverageHostState('coverage-2026-10-11')).values()].filter((why) => why !== 'robots-transient')).toEqual([]);
    expect(locateEvents(home, 'step_done').length).toBe(0); // nothing finished as "not located" on the portal's errors
    w.jump(TRANSIENT_DISABLE_MS + 60_000);
    const results: CoverageResult[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await runCoverage({ home, clock: w.clock, fetch, sleep: async (ms) => w.jump(ms), codeHash: 'outage', yieldCheck: () => null });
      results.push(r);
      if (r.status === 'completed') break;
      w.jump(TRANSIENT_DISABLE_MS + 60_000);
    }
    // the probes and the verify stage's board reads on that host: never within the 2 s host interval
    expect(probeHost.length).toBeGreaterThan(2);
    for (let i = 1; i < probeHost.length; i++) expect((probeHost[i] as number) - (probeHost[i - 1] as number)).toBeGreaterThanOrEqual(2000);
    const summary = results.at(-1) as CoverageSummary;
    expect(summary.status).toBe('completed');
    expect(summary.located).toEqual(BASELINE.located);
    expect(summary.verdicts).toEqual(BASELINE.verdicts);
    expect(summary.deferred).toMatchObject({ total: 0, transient: 0 });
  });

  it('re-check m5: every stage and the online probe share the run\'s one host pacer', async () => {
    const home = newHome();
    const w = world(() => null);
    const paced: string[] = [];
    const hostPacer = { wait: async (host: string) => void paced.push(host) };
    const r = await runCoverage({ home, clock: w.clock, fetch: w.fetch, sleep: async () => {}, codeHash: 'outage', yieldCheck: () => null, hostPacer });
    expect(r.status).toBe('completed');
    // the verify stage's board reads and the locate stage's pages went through it
    expect(paced).toContain('boards-api.greenhouse.io');
    expect(paced).toContain('alpha.test');
  });

  it('a sustained outage while DNS still answers: the locator breaker trips, nothing is memoised, the candidates are asked again after it', async () => {
    const home = newHome();
    let over = false;
    const w = world((_t, url) => (SEED_HOSTS.has(new URL(url).hostname) || over ? null : 'ECONNRESET'));
    const first = await invoke(home, w);
    expect(first).toMatchObject({ status: 'paused', reason: 'retry wait' });
    expect(locateEvents(home, 'breaker_open')).toEqual([{ key: 'agent:careers-locator' }, { key: 'team:coverage-locator' }]);
    expect(locateEvents(home, 'step_done')).toEqual([]);
    over = true;
    w.jump(TRANSIENT_DISABLE_MS + 60_000);
    const { summary } = await untilDone(home, w, TRANSIENT_DISABLE_MS + 60_000);
    expect(summary.located).toEqual(BASELINE.located);
    expect(summary.verdicts).toEqual(BASELINE.verdicts);
  });

  it(`a host that never recovers: re-queued at most ${3} times, then counted as a transient deferral (no "not located", no failed week, exit 0)`, async () => {
    const home = newHome();
    // gamma.test (a yc company located by its homepage link) never answers
    const w = world((_t, url) => (new URL(url).hostname.endsWith('gamma.test') ? 'ECONNRESET' : null));
    const { summary } = await untilDone(home, w, TRANSIENT_DISABLE_MS + 60_000, 10);
    expect(locateEvents(home, 'coverage.requeued')).toHaveLength(MAX_REQUEUES); // gamma.test's step only
    expect(summary.deferred.transient).toBe(1);
    expect(summary.exitCode).toBe(0);
    expect(summary.located).toEqual({ ...BASELINE.located, 'homepage-link': 0 });
    expect(summary.projection.unlocated).toEqual({ proposed: 0, failed: 0, counted: 1 });
    expect(db(home, (a) => a.getCompany('gamma.test'))).toBeUndefined();
  });

  it('#31: a step deferred behind a 429 is asked again once the 429 has expired within the run', async () => {
    const home = newHome();
    const ALPHA = 'https://boards-api.greenhouse.io/v1/boards/alpharobotics/jobs?content=true&pay_transparency=true';
    let limited = true;
    let jumped = false;
    const w = world(() => null);
    const fetch: FetchLike = async (url, init) => {
      if (url === ALPHA && limited) {
        limited = false;
        return { status: 429, headers: { get: () => null }, text: async () => 'slow down' };
      }
      return w.fetch(url, init);
    };
    // the step after the 429 runs a day later (the run paused and resumed, say): the 429 has expired by the stage's end
    const afterStep = (): void => {
      if (!limited && !jumped) {
        jumped = true;
        w.jump(25 * 60 * 60_000);
      }
    };
    const r = await runCoverage({ home, clock: w.clock, fetch, sleep: async () => {}, codeHash: 'outage', yieldCheck: () => null, online: async () => true, afterStep, sliceMs: 7 * 24 * 60 * 60_000 });
    expect(r.status).toBe('completed');
    const summary = r as CoverageSummary;
    expect(summary.verdicts).toEqual(BASELINE.verdicts);
    expect(summary.deferred.total).toBe(0);
    expect(db(home, (a) => a.kernel.events('coverage-2026-10-11.verify').filter((e) => e.kind === 'coverage.requeued').map((e) => JSON.parse(e.data).why))).toContain('host re-enabled');
  });
});
