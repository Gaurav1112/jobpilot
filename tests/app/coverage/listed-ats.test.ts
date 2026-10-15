import { copyFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const WD_CXS = 'https://charlie.wd5.myworkdayjobs.com/wday/cxs/charlie/Careers/jobs';
// Sundays 07:00 IST (01:30Z) of two coverage weeks
const W1 = '2026-10-11T01:30:00.000Z';
const W2 = '2026-10-18T01:30:00.000Z';
/** companies.yaml with only Bravo: Acme Cloud left the file, its registry row seeds it (`registryPickItems`). */
const BRAVO_ONLY = "companies:\n  - {name: Bravo, website: 'https://bravo.test', careersUrl: 'https://ats.rippling.com/bravo/jobs'}\n";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function newHome(yaml = 'companies.yaml'): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-cov-listed-'));
  homes.push(home);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  copyFileSync(join(FIX, yaml), join(home, 'pack', 'companies.yaml'));
  return home;
}

/** The recorded fixtures; `dead` URLs answer 404, `bodies` URLs answer 200 with that body instead. */
function net(dead: readonly string[] = [], bodies: Readonly<Record<string, string>> = {}) {
  const offline = offlineProviders(FIX).fetch;
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    if (dead.includes(url)) return { status: 404, text: async () => 'Not Found' };
    const body = bodies[url];
    if (body !== undefined) return { status: 200, text: async () => body };
    return offline(url, init);
  };
  return { fetch, calls };
}

function done(r: CoverageResult): CoverageSummary {
  if (r.status !== 'completed') throw new Error(`expected a completed run, got ${r.status} (${r.reason})`);
  return r;
}
async function run(home: string, fetch: FetchLike, week: string = W1): Promise<CoverageSummary> {
  let t = Date.parse(week);
  return done(await runCoverage({ home, clock: { now: () => new Date((t += 1000)).toISOString() }, fetch, sleep: async () => {}, codeHash: 'listed', yieldCheck: () => null }));
}

function registry(home: string): Record<string, Pick<Company, 'status' | 'platform' | 'platformSlug' | 'failWeeks' | 'careersUrl'> & { reasons: string }> {
  const app = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return Object.fromEntries(app.listCompanies().map((c) => [c.companyKey, { status: c.status, platform: c.platform, platformSlug: c.platformSlug, failWeeks: c.failWeeks, careersUrl: c.careersUrl, reasons: c.reasons.join(' | ') }]));
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
    expect(r['acme.test']?.reasons).toContain('listed careersUrl names a greenhouse board (acmecloud); the redirect to https://www.acme.test/careers was not followed for detection');
    expect(r['bravo.test']).toMatchObject({ status: 'verified', platform: 'rippling', platformSlug: 'bravo' });
    expect(r['bravo.test']?.reasons).toContain('listed careersUrl names a rippling board (bravo); the redirect to https://www.bravo.test/careers was not followed for detection');

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
    expect(r['acme.test']?.reasons).toMatch(/^board not found \(404\): greenhouse acmecloud, please confirm \| listed careersUrl/);
    expect(r['acme.test']?.reasons).toContain('listed careersUrl names a greenhouse board (acmecloud); the redirect to https://www.acme.test/careers was not followed for detection');
    expect(r['bravo.test']).toMatchObject({ status: 'proposed', platform: 'rippling', platformSlug: 'bravo' });
    expect(r['bravo.test']?.reasons).toMatch(/board not found \(404\): rippling bravo/);
  });

  it('a listed board whose API answers in the wrong shape stays Proposed with the reason', async () => {
    const home = newHome();
    const s = await run(home, net([RIPPLING_API], { [GH_API]: '{"not":"a board"}' }).fetch);
    expect(s.verdicts).toEqual({ verified: 0, proposed: 2, failed: 0 });
    const r = registry(home);
    expect(r['acme.test']).toMatchObject({ status: 'proposed', platform: 'greenhouse', platformSlug: 'acmecloud' });
    // the same ending as the 404's reason
    expect(r['acme.test']?.reasons).toMatch(/^greenhouse board acmecloud: [^|]*, please confirm \| listed careersUrl/);
    expect(r['acme.test']?.reasons).toContain('listed careersUrl names a greenhouse board (acmecloud)');
  });

  it('a listed board whose name is another company stays Proposed', async () => {
    const home = newHome();
    const other = JSON.stringify({ jobs: [{ id: 5001, title: 'Platform Engineer', company_name: 'Zenith Mining', absolute_url: 'https://job-boards.greenhouse.io/acmecloud/jobs/5001', location: { name: 'Remote' }, updated_at: '2026-10-01T00:00:00-04:00', content: 'A fictional role.' }], meta: { total: 1 } });
    const s = await run(home, net([], { [GH_API]: other }).fetch);
    expect(s.verdicts).toEqual({ verified: 1, proposed: 1, failed: 0 });
    const r = registry(home);
    expect(r['acme.test']).toMatchObject({ status: 'proposed', platform: 'greenhouse', platformSlug: 'acmecloud' });
    expect(r['acme.test']?.reasons).toMatch(/^board name 'Zenith Mining' ≈ 'Acme Cloud', please confirm \| listed careersUrl names a greenhouse board/);
  });

  it('a listed board with 0 open jobs follows the 0-jobs rule: Proposed', async () => {
    const home = newHome();
    const s = await run(home, net([], { [GH_API]: '{"jobs":[],"meta":{"total":0}}' }).fetch);
    expect(s.verdicts).toEqual({ verified: 1, proposed: 1, failed: 0 });
    const r = registry(home);
    expect(r['acme.test']).toMatchObject({ status: 'proposed', platform: 'greenhouse', platformSlug: 'acmecloud' });
    expect(r['acme.test']?.reasons).toMatch(/board has 0 open jobs/);
  });

  it('a listed Workday URL with tenant and site, redirected to the marketing page: verified through the CXS API', async () => {
    const home = newHome('companies-workday.yaml');
    const n = net();
    const s = await run(home, n.fetch);
    expect(s.problems).toEqual([]);
    expect(s.platforms).toEqual({ workday: 1 });
    expect(s.verdicts).toEqual({ verified: 1, proposed: 0, failed: 0 });
    const r = registry(home);
    expect(r['charlie.test']).toMatchObject({ status: 'verified', platform: 'workday', platformSlug: 'charlie/Careers' });
    expect(r['charlie.test']?.reasons).toContain('listed careersUrl names a workday board (charlie/Careers)');
    expect(n.calls.filter((u) => u === WD_CXS)).toHaveLength(1);
  });

  it('a pick that left companies.yaml is re-seeded from the URL as written: still verified next week, no failed week', async () => {
    const home = newHome();
    const w1 = net();
    await run(home, w1.fetch, W1);
    expect(registry(home)['acme.test']).toMatchObject({ status: 'verified', failWeeks: 0, careersUrl: 'https://job-boards.greenhouse.io/acmecloud' });
    expect(w1.calls.filter((u) => u === GH_API)).toHaveLength(1);

    writeFileSync(join(home, 'pack', 'companies.yaml'), BRAVO_ONLY);
    const w2 = net();
    const s = await run(home, w2.fetch, W2);
    expect(s.verdicts).toEqual({ verified: 2, proposed: 0, failed: 0 });
    const r = registry(home);
    expect(r['acme.test']).toMatchObject({ status: 'verified', platform: 'greenhouse', platformSlug: 'acmecloud', failWeeks: 0, careersUrl: 'https://job-boards.greenhouse.io/acmecloud' });
    expect(w2.calls.filter((u) => u === GH_API)).toHaveLength(1);
  });

  it('a live company whose listed board 404s the next week gets a failed week, not a demotion', async () => {
    const home = newHome();
    await run(home, net().fetch, W1);
    expect(registry(home)['acme.test']).toMatchObject({ status: 'verified', failWeeks: 0 });
    const s = await run(home, net([GH_API]).fetch, W2);
    expect(s.verdicts).toMatchObject({ verified: 1 });
    const r = registry(home);
    expect(r['acme.test']).toMatchObject({ status: 'verified', platform: 'greenhouse', platformSlug: 'acmecloud', failWeeks: 1 });
    expect(r['acme.test']?.reasons).toMatch(/^platform signal changed, please confirm \| board not found \(404\): greenhouse acmecloud, please confirm/);
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
    expect(g.evidence).toEqual(['detected: greenhouse acmecloud', 'listed careersUrl names a greenhouse board (acmecloud); the redirect to https://www.acme.test/careers was not followed for detection']);
    expect(net.calls).toEqual([]);
    // the note's article reads right for every platform
    const e = await detect(site('https://acme.eightfold.ai/careers?domain=acme.test', 'https://www.acme.test/careers'), serve({}).fetch);
    expect(e).toMatchObject({ platform: 'eightfold', signature: 'eightfold:listed' });
    expect(e.evidence[1]).toMatch(/^listed careersUrl names an eightfold board \(acme\.eightfold\.ai\/acme\.test\); /);
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

  it('no shortcut without a real redirect off an ATS host: an Eightfold API path on the company\'s own host is fetched', async () => {
    const api = 'https://careers.acme.test/api/apply/v2/jobs?domain=acme.test';
    // it answered 200 itself (no redirect): the page fetch decides
    const direct = serve({ [api]: '{"positions":[]}' });
    expect((await detect(site(api, api), direct.fetch)).signature).not.toBe('eightfold:listed');
    expect(direct.calls).toContain(api);
    // it redirected, but the URL as written is on the company's own host, not an ATS host
    const moved = serve({ 'https://www.acme.test/careers': '<html><body>none</body></html>' });
    expect(await detect(site(api, 'https://www.acme.test/careers'), moved.fetch)).toMatchObject({ platform: null });
    expect(moved.calls).toContain('https://www.acme.test/careers');
  });
});
