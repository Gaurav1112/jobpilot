import { copyFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makePlatformDetector, platformDetectorContract, detectorEgressSets } from '../../../src/app/coverage/detector.js';
import { memoryHostStateStore } from '../../../src/app/coverage/gate.js';
import { runCoverage, type CoverageResult, type CoverageSummary } from '../../../src/app/coverage/run.js';
import { CareersSite, CompanyCandidate, PlatformGuess } from '../../../src/app/coverage/types.js';
import { offlineProviders } from '../../../src/app/offline.js';
import { AppStore, type Company } from '../../../src/app/store/app-store.js';
import { issueContext } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import type { FetchLike } from '../../../src/kernel/providers.js';

/**
 * A pick whose careersUrl is a direct ATS board URL (Greenhouse, Rippling) that answers 302/307 to the company's own
 * careers page: the platform and slug come from the listed URL as written, and the verifier decides through the API.
 */

const root = join(import.meta.dirname, '../../..');
const FIX = join(root, 'tests/fixtures/coverage/listed-ats');
const GH_API = 'https://boards-api.greenhouse.io/v1/boards/acmecloud/jobs?content=true&pay_transparency=true';
const RIPPLING_API = 'https://api.rippling.com/platform/api/ats/v1/board/bravo/jobs';
const W1 = '2026-10-11T01:30:00.000Z';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-cov-listed-'));
  homes.push(home);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  copyFileSync(join(FIX, 'companies.yaml'), join(home, 'pack', 'companies.yaml'));
  return home;
}

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

function done(r: CoverageResult): CoverageSummary {
  if (r.status !== 'completed') throw new Error(`expected a completed run, got ${r.status} (${r.reason})`);
  return r;
}
async function run(home: string, fetch: FetchLike): Promise<CoverageSummary> {
  let t = Date.parse(W1);
  return done(await runCoverage({ home, clock: { now: () => new Date((t += 1000)).toISOString() }, fetch, sleep: async () => {}, codeHash: 'listed', yieldCheck: () => null }));
}

function registry(home: string): Record<string, Pick<Company, 'status' | 'platform' | 'platformSlug'> & { reasons: string }> {
  const app = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return Object.fromEntries(app.listCompanies().map((c) => [c.companyKey, { status: c.status, platform: c.platform, platformSlug: c.platformSlug, reasons: c.reasons.join(' | ') }]));
  } finally {
    app.close();
  }
}

describe('coverage: a listed careersUrl that is an ATS board redirecting to a marketing page', () => {
  it('verifies the Greenhouse and Rippling boards named by the listed URLs through their APIs', async () => {
    const home = newHome();
    const n = net();
    const s = await run(home, n.fetch);
    expect(s.problems).toEqual([]);
    expect(s.exitCode).toBe(0);
    expect(s.located).toMatchObject({ listed: 2 });
    expect(s.platforms).toEqual({ greenhouse: 1, rippling: 1 });
    expect(s.verdicts).toEqual({ verified: 2, proposed: 0, failed: 0 });

    const r = registry(home);
    expect(r['acme.test']).toMatchObject({ status: 'verified', platform: 'greenhouse', platformSlug: 'acmecloud' });
    expect(r['acme.test']?.reasons).toContain('listed careersUrl is a greenhouse board (acmecloud); the redirect to https://www.acme.test/careers was not followed for detection');
    expect(r['bravo.test']).toMatchObject({ status: 'verified', platform: 'rippling', platformSlug: 'bravo' });
    expect(r['bravo.test']?.reasons).toContain('listed careersUrl is a rippling board (bravo); the redirect to https://www.bravo.test/careers was not followed for detection');

    // politeness: each board API read once, robots.txt once per host, and the detector asks no page again
    expect(n.calls.filter((u) => u === GH_API)).toHaveLength(1);
    expect(n.calls.filter((u) => u === RIPPLING_API)).toHaveLength(1);
    const robots = n.calls.filter((u) => u.endsWith('/robots.txt'));
    expect(new Set(robots).size).toBe(robots.length);
    for (const page of ['https://job-boards.greenhouse.io/acmecloud', 'https://www.acme.test/careers', 'https://ats.rippling.com/bravo/jobs', 'https://www.bravo.test/careers']) {
      expect(n.calls.filter((u) => u === page)).toHaveLength(1);
    }
  });

  it('a listed board whose API answers 404 stays Proposed with the reason, never verified', async () => {
    const home = newHome();
    const s = await run(home, net([GH_API, RIPPLING_API]).fetch);
    expect(s.verdicts).toEqual({ verified: 0, proposed: 2, failed: 0 });
    const r = registry(home);
    expect(r['acme.test']).toMatchObject({ status: 'proposed', platform: 'greenhouse', platformSlug: 'acmecloud' });
    expect(r['acme.test']?.reasons).toMatch(/board not found \(404\): greenhouse acmecloud/);
    expect(r['acme.test']?.reasons).toContain('listed careersUrl is a greenhouse board (acmecloud); the redirect to https://www.acme.test/careers was not followed for detection');
    expect(r['bravo.test']).toMatchObject({ status: 'proposed', platform: 'rippling', platformSlug: 'bravo' });
    expect(r['bravo.test']?.reasons).toMatch(/board not found \(404\): rippling bravo/);
  });
});

describe('platform detector: the listed careersUrl as written', () => {
  const RUN = '2026-10-13';
  const cand = (careersUrl: string): CompanyCandidate => ({ companyKey: 'acme.test', name: 'Acme Cloud', website: 'https://www.acme.test', careersUrl, source: 'pick', runDate: RUN });
  const site = (listed: string, located: string, method: CareersSite['method'] = 'listed'): CareersSite => ({ candidate: cand(listed), careersUrl: located, method, evidence: 'listed careersUrl answered 200' });
  function serve(routes: Record<string, string>) {
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      const body = routes[url];
      return { status: body === undefined ? 404 : 200, headers: { get: () => null }, text: async () => body ?? 'Not Found' };
    };
    return { fetch, calls };
  }
  async function detect(s: CareersSite, fetch: FetchLike): Promise<PlatformGuess> {
    const ctx = issueContext({
      contract: platformDetectorContract,
      policy: PRODUCT_POLICY_V1,
      inputClass: 'P0',
      providers: { fetch },
      clock: fixedClock('2026-10-13T00:00:00Z'),
      signal: new AbortController().signal,
      egressSets: detectorEgressSets([s]),
    });
    const out = await makePlatformDetector({ runKey: 'test', store: memoryHostStateStore() }).run(s, ctx);
    expect(ctx.denials()).toEqual([]);
    return PlatformGuess.schema.parse(out[0]);
  }

  it('a listed board redirected to a page off every platform: platform and slug from the listed URL, nothing fetched', async () => {
    const net = serve({});
    const g = await detect(site('https://job-boards.greenhouse.io/AcmeCloud?gh_src=x', 'https://www.acme.test/careers'), net.fetch);
    expect(g).toMatchObject({ platform: 'greenhouse', slug: 'acmecloud', boardUrl: 'https://boards-api.greenhouse.io/v1/boards/acmecloud/jobs', signature: 'greenhouse:listed', routedFrom: null });
    expect(g.evidence).toEqual(['detected: greenhouse acmecloud', 'listed careersUrl is a greenhouse board (acmecloud); the redirect to https://www.acme.test/careers was not followed for detection']);
    expect(net.calls).toEqual([]);
  });

  it('unchanged: a listed board that stayed on its platform, a redirect to another platform, a slugless listed URL, a site not found by `listed`', async () => {
    const html = '<html><head><title>Jobs</title></head><body>none</body></html>';
    // the board answered itself: detected from the page fetch, as before
    const same = serve({ 'https://job-boards.greenhouse.io/acmecloud': html });
    expect(await detect(site('https://boards.greenhouse.io/acmecloud', 'https://job-boards.greenhouse.io/acmecloud'), same.fetch)).toMatchObject({ platform: 'greenhouse', slug: 'acmecloud', signature: 'greenhouse:url' });
    expect(same.calls).toContain('https://job-boards.greenhouse.io/acmecloud');
    // the board moved to another ATS: the target decides, as before
    const moved = serve({ 'https://jobs.lever.co/acmecloud': html });
    expect(await detect(site('https://boards.greenhouse.io/acmecloud', 'https://jobs.lever.co/acmecloud'), moved.fetch)).toMatchObject({ platform: 'lever', slug: 'acmecloud' });
    // a listed URL on a platform host that names no board is no board
    const bare = serve({ 'https://www.acme.test/careers': html });
    expect(await detect(site('https://job-boards.greenhouse.io/', 'https://www.acme.test/careers'), bare.fetch)).toMatchObject({ platform: null });
    expect(bare.calls).toContain('https://www.acme.test/careers');
    // a careers URL found by another probe: the listed URL was not what was located
    const path = serve({ 'https://www.acme.test/careers': html });
    expect(await detect(site('https://job-boards.greenhouse.io/acmecloud', 'https://www.acme.test/careers', 'path'), path.fetch)).toMatchObject({ platform: null });
  });
});
