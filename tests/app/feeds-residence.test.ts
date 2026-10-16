import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RESIDENCE, residenceScope } from '../../src/app/geo/residence.js';
import { dailySeeds } from '../../src/app/pipeline.js';
import { indiaEligible, residenceEligible } from '../../src/app/agents/sources/himalayas.js';
import { JOBICY_GEOS, jobicyGeos, srcJobicy } from '../../src/app/agents/sources/jobicy.js';
import { srcHimalayas } from '../../src/app/agents/sources/himalayas.js';
import { REGIONS } from '../../src/app/geo/data.generated.js';
import { DiscoveryRequest, type RawPosting } from '../../src/app/types.js';
import type { Agent } from '../../src/kernel/agent.js';
import { issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import type { FetchLike } from '../../src/kernel/providers.js';

const repo = join(import.meta.dirname, '../..');

describe('seeds carry the residence only when it is not IN', () => {
  const base = { watchlist: [{ ats: 'greenhouse' as const, slug: 'acme', company: 'Acme' }], feeds: { enabled: ['himalayas'] } };
  it('IN: byte-identical seeds', () => {
    expect(dailySeeds({ ...base, eligibility: { residence: 'IN' } }, '2026-10-15')).toEqual(dailySeeds(base, '2026-10-15'));
    expect(JSON.stringify(dailySeeds({ ...base, eligibility: { residence: 'IN' } }, '2026-10-15'))).not.toContain('residence');
  });
  it('DE: every seed names it', () => {
    expect(dailySeeds({ ...base, eligibility: { residence: 'DE' } }, '2026-10-15').map((s) => s.residence)).toEqual(['DE', 'DE']);
  });
});

describe('Himalayas', () => {
  it('IN is the old rule', () => {
    for (const r of [[], ['India'], ['APAC'], ['Asia-Pacific'], ['Worldwide'], [{ alpha2: 'in' }]]) expect(residenceEligible(r, DEFAULT_RESIDENCE)).toBe(indiaEligible(r));
    expect(indiaEligible(['Germany'])).toBe(false);
  });
  it('DE takes Germany, Europe, EMEA, worldwide', () => {
    const de = residenceScope('DE');
    expect(residenceEligible(['Germany'], de)).toBe(true);
    expect(residenceEligible([{ alpha2: 'DE' }], de)).toBe(true);
    expect(residenceEligible(['Europe'], de)).toBe(true);
    expect(residenceEligible(['India'], de)).toBe(false);
    expect(residenceEligible(['APAC'], de)).toBe(false);
  });
});

describe('Jobicy geos', () => {
  it('IN keeps apac then anywhere', () => {
    expect(jobicyGeos(DEFAULT_RESIDENCE)).toEqual([...JOBICY_GEOS]);
  });
  it('every mapped slug is one Jobicy offers', () => {
    const offered = JSON.stringify(JSON.parse(readFileSync(join(repo, 'tests/fixtures/sources/jobicy-locations.json'), 'utf8'))).toLowerCase();
    for (const code of ['IN', 'DE', 'CA', 'US', 'GB']) for (const g of jobicyGeos(residenceScope(code))) expect(offered).toContain(`"${g}"`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Beyond the plan's cases: the whole slug table, the seed contract and the agents end to end on a fake fetch (offline).
// ---------------------------------------------------------------------------------------------------------------------

const offered = new Set((JSON.parse(readFileSync(join(repo, 'tests/fixtures/sources/jobicy-locations.json'), 'utf8')) as { locations: { geoSlug: string }[] }).locations.map((l) => l.geoSlug));

describe('Jobicy geos, every residence', () => {
  it('every code regions.yaml knows asks only slugs Jobicy lists, anywhere last, none twice', () => {
    for (const code of Object.keys(REGIONS)) {
      const geos = jobicyGeos(residenceScope(code));
      for (const g of geos) expect(offered.has(g), `${code}: ${g}`).toBe(true);
      expect(geos.at(-1), code).toBe('anywhere');
      expect(new Set(geos).size, code).toBe(geos.length);
    }
  });
  it('a country with its own slug asks it first; UK is GB; a country without one asks its regions', () => {
    expect(jobicyGeos(residenceScope('DE'))).toEqual(['germany', 'europe', 'emea', 'anywhere']);
    expect(jobicyGeos(residenceScope('US'))).toEqual(['usa', 'anywhere']);
    expect(jobicyGeos(residenceScope('CA'))).toEqual(['canada', 'anywhere']);
    expect(jobicyGeos(residenceScope('UK'))).toEqual(['uk', 'europe', 'emea', 'anywhere']);
    expect(jobicyGeos(residenceScope('PK'))).toEqual(['apac', 'anywhere']);
    expect(jobicyGeos(residenceScope('ZA'))).toEqual(['emea', 'anywhere']);
  });
});

describe('the seed contract', () => {
  const seed = { ats: 'feed', slug: 'himalayas', company: 'himalayas', runDate: '2026-10-15' };
  it('takes an ISO code, absent by default', () => {
    expect(DiscoveryRequest.schema.safeParse(seed).success).toBe(true);
    expect(DiscoveryRequest.schema.safeParse({ ...seed, residence: 'DE' }).success).toBe(true);
    for (const bad of ['de', 'DEU', '', 'D1']) expect(DiscoveryRequest.schema.safeParse({ ...seed, residence: bad }).success, bad).toBe(false);
  });
  it('a refresh run carries both', () => {
    const [s] = dailySeeds({ watchlist: [], feeds: { enabled: ['himalayas'] }, eligibility: { residence: 'US' } }, '2026-10-15', 2);
    expect(s).toEqual({ ...seed, attempt: 2, residence: 'US' });
  });
});

function serve(routes: Record<string, string>): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const body = routes[url];
    return body === undefined ? { status: 404, text: async () => 'Not Found' } : { status: 200, text: async () => body };
  };
  return { fetch, urls };
}

async function run(agent: Agent<DiscoveryRequest, RawPosting>, r: DiscoveryRequest, fetch: FetchLike): Promise<readonly RawPosting[]> {
  const ctx = issueContext({ contract: agent.contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock: fixedClock('2026-10-15T00:00:00Z'), signal: new AbortController().signal });
  return agent.run(r, ctx);
}

const feed = (slug: string, residence?: string): DiscoveryRequest => ({ ats: 'feed', slug, company: slug, runDate: '2026-10-15', ...(residence === undefined ? {} : { residence }) });

describe('src-himalayas follows the seed', () => {
  const job = (guid: string, locationRestrictions: unknown[]) => ({ guid: `https://himalayas.app/companies/x/jobs/${guid}`, title: 'Backend Engineer', companyName: 'X', locationRestrictions });
  const body = JSON.stringify({
    jobs: [job('a', []), job('b', ['India']), job('c', ['Germany']), job('d', ['Europe']), job('e', [{ alpha2: 'DE', name: 'Germany' }]), job('f', ['APAC']), job('g', ['United States']), job('h', ['Worldwide'])],
    totalCount: 8,
  });
  const url = (code: string) => `https://himalayas.app/jobs/api/search?q=backend&country=${code}&sort=recent`;
  const ids = (ps: readonly RawPosting[]) => ps.map((p) => p.sourceId.split('/').at(-1));

  it('IN (absent) asks country=IN and keeps today\'s set', async () => {
    const s = serve({ [url('IN')]: body });
    expect(ids(await run(srcHimalayas, feed('himalayas'), s.fetch))).toEqual(['a', 'b', 'f', 'h']);
    expect(s.urls).toEqual([url('IN')]);
  });
  it('DE asks country=DE and keeps Germany, Europe and worldwide', async () => {
    const s = serve({ [url('DE')]: body });
    expect(ids(await run(srcHimalayas, feed('himalayas', 'DE'), s.fetch))).toEqual(['a', 'c', 'd', 'e', 'h']);
    expect(s.urls).toEqual([url('DE')]);
  });
  it('US asks country=US and keeps the United States and worldwide', async () => {
    const s = serve({ [url('US')]: body });
    expect(ids(await run(srcHimalayas, feed('himalayas', 'US'), s.fetch))).toEqual(['a', 'g', 'h']);
  });
  it('an unknown code is invalid_output, nothing fetched', async () => {
    const s = serve({});
    await expect(run(srcHimalayas, feed('himalayas', 'ZZ'), s.fetch)).rejects.toMatchObject({ code: 'invalid_output', message: 'src-himalayas: eligibility.residence: unknown country code ZZ' });
    expect(s.urls).toEqual([]);
  });
});

describe('src-jobicy follows the seed', () => {
  const page = (ids: number[]) => JSON.stringify({ jobs: ids.map((id) => ({ id, jobTitle: 'Backend', companyName: 'X' })), hasMore: false, jobCount: ids.length });
  const url = (geo: string) => `https://jobicy.com/api/v2/remote-jobs?count=50&geo=${geo}&tag=backend`;
  it('IN (absent) asks apac then anywhere', async () => {
    const s = serve({ [url('apac')]: page([1]), [url('anywhere')]: page([1, 2]) });
    expect((await run(srcJobicy, feed('jobicy'), s.fetch)).map((p) => p.sourceId)).toEqual(['1', '2']);
    expect(s.urls).toEqual([url('apac'), url('anywhere')]);
  });
  it('DE asks germany, europe, emea, anywhere, a job kept once', async () => {
    const s = serve({ [url('germany')]: page([1]), [url('europe')]: page([1, 2]), [url('emea')]: page([3]), [url('anywhere')]: page([2, 4]) });
    expect((await run(srcJobicy, feed('jobicy', 'DE'), s.fetch)).map((p) => p.sourceId)).toEqual(['1', '2', '3', '4']);
    expect(s.urls).toEqual(['germany', 'europe', 'emea', 'anywhere'].map(url));
  });
});

describe('the seed residence is the canonical code (Task 15 review)', () => {
  const base = { watchlist: [{ ats: 'greenhouse' as const, slug: 'acme', company: 'Acme' }], feeds: { enabled: ['himalayas'] } };
  it('UK rides as GB, so both spellings share step keys', () => {
    const uk = dailySeeds({ ...(base as object), eligibility: { residence: 'UK' } } as never, '2026-10-15');
    const gb = dailySeeds({ ...(base as object), eligibility: { residence: 'GB' } } as never, '2026-10-15');
    expect(uk).toEqual(gb);
    expect(uk.length).toBeGreaterThan(0);
    expect(uk.every((s) => s.residence === 'GB')).toBe(true);
  });
  it('a lower-case in is India: no residence on the seeds, India\'s step keys unchanged', () => {
    expect(JSON.stringify(dailySeeds({ ...(base as object), eligibility: { residence: 'in' } } as never, '2026-10-15'))).not.toContain('residence');
  });
});
