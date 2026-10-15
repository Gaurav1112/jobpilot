import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { runCommand, runFreelanceCommand } from '../../src/app/run-command.js';
import type { FetchLike } from '../../src/kernel/providers.js';

/**
 * Sleep-safe review I1: the live daily and freelance runs give the supervisor an online check whose probe requests wait
 * on the run's own per-host pacer (the probe hosts are the ones the run crawls). The network is down at the start: the
 * first probe finds it offline, the second (at the re-queue) waits for its slot on the pacer, then passes.
 */
const root = join(import.meta.dirname, '../..');
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
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-probe-'));
  homes.push(home);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  // no careers entry: a live run must not start a browser here
  const wl = readFileSync(join(home, 'pack/watchlist.yaml'), 'utf8').split('\n').filter((l) => !l.includes('ats: careers')).join('\n');
  writeFileSync(join(home, 'pack/watchlist.yaml'), wl);
  return home;
}

/** A timeline of the run's sleeps and fetches; every request fails ENOTFOUND until a probe has found the network down. */
function world(fixtures: string, firstProbeHost: string) {
  const off = offlineProviders(fixtures);
  const timeline: string[] = [];
  let down = true;
  let probes = 0;
  const fetch: FetchLike = async (url, init) => {
    timeline.push(`fetch ${url}`);
    if (url === `https://${firstProbeHost}/robots.txt`) {
      probes++;
      if (probes === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      down = false;
      return { status: 404, text: async () => '' };
    }
    if (url.endsWith('/robots.txt') && down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    if (down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    return off.fetch(url, init);
  };
  const sleep = async (ms: number) => void timeline.push(`sleep ${ms}`);
  return { fetch, sleep, timeline, probes: () => probes };
}
const deps = (home: string, w: ReturnType<typeof world>, now: string) => ({
  home, clock: { now: () => now }, notifier: async () => {}, out: () => {}, err: () => {}, pdftotext: pdftotext as string, sleep: w.sleep, fetch: w.fetch,
});
/** The entry just before the n-th (1-based) request to `url`. */
const before = (timeline: readonly string[], url: string, n: number): string | undefined => {
  let seen = 0;
  for (const [i, e] of timeline.entries()) if (e === `fetch ${url}` && ++seen === n) return timeline[i - 1];
  return undefined;
};

describe.skipIf(pdftotext === undefined)('the live online probe goes through the run host pacer', () => {
  it('daily: the probe of boards-api.greenhouse.io waits on the pacer; the run then completes clean', async () => {
    const home = newHome();
    const w = world(join(root, 'tests/fixtures/e2e'), 'boards-api.greenhouse.io');
    const code = await runCommand({ notify: false }, deps(home, w, '2026-10-09T01:30:00.000Z'));
    expect(w.probes()).toBe(2);
    expect(before(w.timeline, 'https://boards-api.greenhouse.io/robots.txt', 2)).toMatch(/^sleep [1-9]/);
    expect(code).toBe(0);
  }, 120_000);

  it('freelance: the probe of www.freelancer.com waits on the pacer; the run then completes clean', async () => {
    const home = newHome();
    const w = world(join(root, 'tests/fixtures/freelance-e2e'), 'www.freelancer.com');
    const code = await runFreelanceCommand({ notify: false }, deps(home, w, '2026-10-12T03:00:00.000Z'));
    expect(w.probes()).toBe(2);
    expect(before(w.timeline, 'https://www.freelancer.com/robots.txt', 2)).toMatch(/^sleep [1-9]/);
    expect(code).toBe(0);
  }, 600_000);
});
