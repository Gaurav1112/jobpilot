import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideGig } from '../../../src/app/freelance/gig-eligibility.js';
import { fjHours, fjPay, normalizeGig } from '../../../src/app/freelance/gig-normalizer.js';
import { FETCHING_PLATFORMS, PLATFORM_AGENT, freelanceAgents, freelancePipeline, freelanceSeeds } from '../../../src/app/freelance/pipeline.js';
import { rateOf } from '../../../src/app/freelance/rate.js';
import {
  FJ_FUNCTIONS,
  FJ_HOME_URL,
  FJ_MAX_BYTES,
  FJ_MAX_CARDS,
  FJ_MIN_INTERVAL_MS,
  FJ_ROBOTS_URL,
  fractionalJobsHosts,
  makeSrcFractionalJobs,
  parseFractionalCards,
  srcFractionalJobsContract,
} from '../../../src/app/freelance/sources/fractional-jobs.js';
import type { GigRequest, RawGig } from '../../../src/app/freelance/types.js';
import { FreelanceFile } from '../../../src/app/pack/freelance-schema.js';
import { loadPack } from '../../../src/app/pack/load.js';
import { issueContext, type HostPacer } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import type { FetchLike } from '../../../src/kernel/providers.js';

const root = join(import.meta.dirname, '../../..');
const FIX = join(root, 'tests/fixtures/sx/fractional-jobs');
const home = readFileSync(join(FIX, 'home.html'), 'utf8');
const robotsTxt = readFileSync(join(FIX, 'robots.txt'), 'utf8');
const { pack } = loadPack(join(root, 'tests/fixtures/pack'));
const gigPack = { filters: pack.filters, naming: pack.naming, platformRules: pack.platformRules, freelance: pack.freelance };
const req: GigRequest = { platform: 'fractional-jobs', query: '', runDate: '2026-10-15', half: 'am' };

/** A fake www.fractionaljobs.io: robots.txt and the homepage as given, every call logged, every wait recorded. */
function site(o: { robots?: { status: number; body: string }; page?: { status: number; body: string } } = {}) {
  const calls: string[] = [];
  const waits: number[] = [];
  const fetch: FetchLike = async (url: string) => {
    calls.push(url);
    const r = url === FJ_ROBOTS_URL ? (o.robots ?? { status: 200, body: robotsTxt }) : (o.page ?? { status: 200, body: home });
    return { status: r.status, text: async () => r.body };
  };
  const hostPacer: HostPacer = { wait: async (_h, ms) => void waits.push(ms ?? 0) };
  const ctx = issueContext({ contract: srcFractionalJobsContract(), policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock: fixedClock('2026-10-15T09:00:00Z'), signal: new AbortController().signal, hostPacer });
  return { ctx, calls, waits, get skipped(): readonly string[] { return ctx.skips(); } };
}

const cardsOf = (n: number): string => home.split('job-item w-dyn-item').slice(1, 2).map((c) => `<div role="listitem" class="job-item w-dyn-item${c}`).join('').repeat(n);

describe('src-fractional-jobs: the contract', () => {
  it('io, its own team, one host, no LLM, never retries a 429', () => {
    const c = srcFractionalJobsContract();
    expect(c).toMatchObject({ id: 'src-fractional-jobs', version: '1.0.0', kind: 'io', team: 'sourcing-fractional-jobs', skills: ['gig-sourcing'], egress: ['www.fractionaljobs.io'], capabilities: { http: true }, description: 'Reads fractional roles from the Fractional Jobs public homepage, one page a run, robots-checked' });
    expect(c.capabilities.llm).toBeFalsy();
    expect(c.retry.on).not.toContain('rate_limit');
  });
});

describe('parseFractionalCards', () => {
  it('reads the six fixture cards: company, title, site, hours, pay, location, function, date, job id', () => {
    const { cards, malformed } = parseFractionalCards(home);
    expect(malformed).toEqual([]);
    expect(cards).toHaveLength(6);
    expect(cards[0]).toEqual({ jobId: 'fractional-staff-engineer-at-northwind-example', company: 'Northwind Example', title: 'Fractional Staff Engineer', companySite: 'https://www.example.com/northwind', hours: '15 - 20 hrs', pay: '$8K - $9.5K / mo', location: 'Remote', function: 'Engineering', date: 'October 12, 2026' });
    // The hidden "Unknown" pay is no pay; an entity in a title is decoded.
    expect(cards[1]?.pay).toBeNull();
    expect(cards[2]?.title).toBe('Fractional Platform Engineer & SRE');
    expect(cards[4]?.function).toBe('Finance');
  });

  it('a card without a job id or title is a named malformed entry; the others are still read', () => {
    const broken = home.replace('<div class="job-id">fractional-cto-at-contoso-sample</div>', '').replace('Fractional Data Engineer</h3>', '</h3>');
    const { cards, malformed } = parseFractionalCards(broken);
    expect(cards).toHaveLength(4);
    expect(malformed).toHaveLength(2);
    expect(malformed[0]).toMatch(/^card 2: missing job id or title/);
  });

  it('refuses a job id that is not a plain slug', () => {
    const { cards, malformed } = parseFractionalCards(home.replace('<div class="job-id">fractional-cto-at-contoso-sample</div>', '<div class="job-id">../../admin</div>'));
    expect(cards).toHaveLength(5);
    expect(malformed).toHaveLength(1);
  });

  it('is linear on 100 000 markers', () => {
    const t0 = performance.now();
    parseFractionalCards('job-item w-dyn-item'.repeat(100_000));
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('src-fractional-jobs: the run', () => {
  it('robots.txt once, then one page, paced at 2 s; five roles in Engineering, the Finance card counted out', async () => {
    const s = site();
    const out = await makeSrcFractionalJobs(fractionalJobsHosts()).run(req, s.ctx);
    expect(s.calls).toEqual([FJ_ROBOTS_URL, FJ_HOME_URL]);
    expect(s.waits.every((w) => w >= FJ_MIN_INTERVAL_MS)).toBe(true);
    expect(out.map((g) => g.sourceId)).toEqual([
      'fractional-cto-at-contoso-sample',
      'fractional-data-engineer-at-tailspin-demo',
      'fractional-engineering-lead-at-adatum-fake',
      'fractional-platform-engineer-at-fabrikam-test',
      'fractional-staff-engineer-at-northwind-example',
    ]);
    expect(out.every((g) => g.platform === 'fractional-jobs')).toBe(true);
    expect(s.skipped).toEqual(['fractional-jobs: 1 of 6 roles in other functions']);
    expect(FJ_FUNCTIONS).toEqual(['Engineering', 'Data', 'Product']);
  });

  it('answers only fractional-jobs requests', async () => {
    const s = site();
    expect(await makeSrcFractionalJobs(fractionalJobsHosts()).run({ ...req, platform: 'draftdev' }, s.ctx)).toEqual([]);
    expect(s.calls).toEqual([]);
  });

  it('a robots disallow of / is the named skip and no page request', async () => {
    const s = site({ robots: { status: 200, body: 'User-agent: *\nDisallow: /\n' } });
    expect(await makeSrcFractionalJobs(fractionalJobsHosts()).run(req, s.ctx)).toEqual([]);
    expect(s.calls).toEqual([FJ_ROBOTS_URL]);
    expect(s.skipped.join('\n')).toContain('robots-disallow www.fractionaljobs.io');
  });

  it('a 403 is challenged and disables the host for the run; a later request is sent nowhere', async () => {
    const hosts = fractionalJobsHosts();
    const s = site({ page: { status: 403, body: 'no' } });
    await expect(makeSrcFractionalJobs(hosts).run(req, s.ctx)).rejects.toMatchObject({ code: 'challenged' });
    expect(hosts.disabledWhy()).toBe('http-403');
    const again = site();
    await expect(makeSrcFractionalJobs(hosts).run(req, again.ctx)).rejects.toMatchObject({ code: 'input_rejected' });
    expect(again.calls).toEqual([]);
  });

  it('a 429 is rate_limit and disables the host; a 5xx is overloaded and does not', async () => {
    const hosts = fractionalJobsHosts();
    await expect(makeSrcFractionalJobs(hosts).run(req, site({ page: { status: 429, body: '' } }).ctx)).rejects.toMatchObject({ code: 'rate_limit' });
    expect(hosts.disabledWhy()).toBe('http-429');
    const h2 = fractionalJobsHosts();
    await expect(makeSrcFractionalJobs(h2).run(req, site({ page: { status: 503, body: '' } }).ctx)).rejects.toMatchObject({ code: 'overloaded' });
    expect(h2.disabledWhy()).toBeUndefined();
  });

  it('a challenge page behind a 200 (no cards) disables the host', async () => {
    const hosts = fractionalJobsHosts();
    await expect(makeSrcFractionalJobs(hosts).run(req, site({ page: { status: 200, body: '<title>Just a moment...</title> cf-chl' } }).ctx)).rejects.toMatchObject({ code: 'challenged' });
    expect(hosts.disabledWhy()).toBe('challenge');
  });

  it('201 cards is input_rejected, nothing read', async () => {
    const body = `<html>${cardsOf(FJ_MAX_CARDS + 1)}</html>`;
    expect(parseFractionalCards(body).cards).toHaveLength(FJ_MAX_CARDS + 1);
    await expect(makeSrcFractionalJobs(fractionalJobsHosts()).run(req, site({ page: { status: 200, body } }).ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringContaining('fractional-jobs') });
  });

  it('a 3 MB body is input_rejected', async () => {
    const body = `${home}<!--${'x'.repeat(3 * 1024 * 1024)}-->`;
    expect(FJ_MAX_BYTES).toBe(2 * 1024 * 1024);
    await expect(makeSrcFractionalJobs(fractionalJobsHosts()).run(req, site({ page: { status: 200, body } }).ctx)).rejects.toMatchObject({ code: 'input_rejected' });
  });

  it('a page where every card is malformed is schema drift; a page without cards is invalid_output too', async () => {
    const drift = home.replaceAll('class="job-id"', 'class="job-ident"');
    await expect(makeSrcFractionalJobs(fractionalJobsHosts()).run(req, site({ page: { status: 200, body: drift } }).ctx)).rejects.toMatchObject({ code: 'invalid_output' });
    await expect(makeSrcFractionalJobs(fractionalJobsHosts()).run(req, site({ page: { status: 200, body: '<html>nothing</html>' } }).ctx)).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('a partial malformed page keeps the good cards and names the bad one', async () => {
    const s = site({ page: { status: 200, body: home.replace('<div class="job-id">fractional-cto-at-contoso-sample</div>', '') } });
    const out = await makeSrcFractionalJobs(fractionalJobsHosts()).run(req, s.ctx);
    expect(out).toHaveLength(4);
    expect(s.skipped.some((n) => n.startsWith('fractional-jobs card 2'))).toBe(true);
  });
});

describe('fractional-jobs normalizer mapping', () => {
  const gigs = async () => {
    const out = await makeSrcFractionalJobs(fractionalJobsHosts()).run(req, site().ctx);
    return new Map(out.map((g) => [g.sourceId, g] as [string, RawGig]));
  };
  const verdictOf = (raw: RawGig) => {
    const gig = normalizeGig(raw);
    return { gig, verdict: decideGig({ gig, rate: rateOf(gig, pack.fx, 20) }, gigPack) };
  };

  it('remote with monthly pay: hours 15-20, monthly 8000-9500 USD, bare Remote is review "location not stated - verify"', async () => {
    const raw = (await gigs()).get('fractional-staff-engineer-at-northwind-example') as RawGig;
    const { gig, verdict } = verdictOf(raw);
    expect(gig).toMatchObject({
      platform: 'fractional-jobs',
      url: 'https://www.fractionaljobs.io/jobs/fractional-staff-engineer-at-northwind-example',
      title: 'Fractional Staff Engineer',
      client: { name: 'Northwind Example' },
      kind: 'contract',
      budget: { type: 'monthly', min: 8000, max: 9500, currency: 'USD', from: 'platform' },
      hoursPerWeek: { min: 15, max: 20, source: 'text' },
      location: { countries: [], worldwide: false, text: 'Remote' },
      postedAt: '2026-10-12',
    });
    expect(rateOf(gig, pack.fx, 20).method).toBe('monthly÷hours');
    expect(verdict.verdict).toBe('review');
    expect(verdict.reasons.concat(verdict.notes).join('\n')).toContain('location not stated - verify');
  });

  it('hourly range, worldwide remote', async () => {
    const { gig } = verdictOf((await gigs()).get('fractional-platform-engineer-at-fabrikam-test') as RawGig);
    expect(gig).toMatchObject({ budget: { type: 'hourly', min: 150, max: 200, currency: 'USD', from: 'platform' }, location: { countries: [], worldwide: true, text: 'Remote (Worldwide)' }, hoursPerWeek: { min: 10, max: 15 } });
  });

  it('unknown pay is review, never rejected', async () => {
    const { gig, verdict } = verdictOf((await gigs()).get('fractional-data-engineer-at-tailspin-demo') as RawGig);
    expect(gig.budget).toEqual({ type: 'unknown', min: null, max: null, currency: null, usdPerUnit: null });
    expect(gig.location.worldwide).toBe(true);
    expect(verdict.verdict).toBe('review');
  });

  it('Remote (USA only) is rejected by the existing "only" rule; Hybrid (London only) names no country it knows, so it stays review', async () => {
    const g = await gigs();
    const usa = verdictOf(g.get('fractional-cto-at-contoso-sample') as RawGig);
    expect(usa.gig.location).toEqual({ countries: ['united states'], worldwide: false, text: 'Remote (USA only)' });
    expect(usa.verdict.verdict).toBe('rejected');
    const london = verdictOf(g.get('fractional-engineering-lead-at-adatum-fake') as RawGig);
    expect(london.gig.location).toEqual({ countries: [], worldwide: false, text: 'Hybrid (London only)' });
    expect(london.gig.hoursPerWeek).toEqual({ min: 16, max: 16, source: 'text' });
    expect(london.verdict.verdict).toBe('review');
  });

  it('a card with a missing or malformed field never throws: it maps to unknowns', () => {
    const gig = normalizeGig({ platform: 'fractional-jobs', sourceId: 'x', raw: { jobId: 'x', company: null, title: 'T', companySite: null, hours: '10+ hrs', pay: '$90 - $110 CAD / hr', location: null, function: 'Engineering', date: 'not a date' } });
    expect(gig).toMatchObject({ client: { name: null }, budget: { type: 'unknown' }, hoursPerWeek: { min: null, max: null, source: null }, location: { countries: [], worldwide: false, text: null }, postedAt: null });
  });
});

describe('fjPay and fjHours', () => {
  it('parses the pay field', () => {
    expect(fjPay('$8K - $9.5K / mo')).toEqual({ type: 'monthly', min: 8000, max: 9500, currency: 'USD', usdPerUnit: null, from: 'platform' });
    expect(fjPay('$150 - $200 / hr')).toMatchObject({ type: 'hourly', min: 150, max: 200 });
    expect(fjPay('$100 / hr')).toMatchObject({ type: 'hourly', min: 100, max: 100 });
    expect(fjPay('€8K - €10K / mo')).toMatchObject({ type: 'monthly', min: 8000, max: 10000, currency: 'EUR' });
    expect(fjPay('£90/hr')).toMatchObject({ currency: 'GBP', min: 90 });
    expect(fjPay('$7.5K - $12.5K / mo')).toMatchObject({ min: 7500, max: 12500 });
  });
  it('everything else is unknown', () => {
    for (const s of ['Unknown', '$100 / yr', '$133 - $160 CAD / hr', '$200 - $100 / hr', '$100 - €120 / hr', '', null, '€ / hr', '$K / hr']) expect(fjPay(s)).toEqual({ type: 'unknown', min: null, max: null, currency: null, usdPerUnit: null });
  });
  it('hours are weekly; anything else is unknown', () => {
    expect(fjHours('15 - 20 hrs')).toEqual({ min: 15, max: 20, source: 'text' });
    expect(fjHours('15-20 hrs')).toEqual({ min: 15, max: 20, source: 'text' });
    expect(fjHours('16 hrs')).toEqual({ min: 16, max: 16, source: 'text' });
    for (const s of ['10+ hrs', '20 - 10 hrs', 'full time', null, '']) expect(fjHours(s)).toEqual({ min: null, max: null, source: null });
  });
});

describe('Fractional Jobs in the wiring', () => {
  it('on by default, one seed after Prime Intellect; off when disabled', () => {
    const rules = FreelanceFile.parse({});
    const seeds = freelanceSeeds(rules, '2026-10-15', 'am', []).map((s) => s.platform);
    expect(seeds.filter((p) => p === 'fractional-jobs')).toHaveLength(1);
    expect(seeds.indexOf('fractional-jobs')).toBeGreaterThan(seeds.indexOf('prime-intellect'));
    expect(freelanceSeeds(rules, '2026-10-15', 'am', []).find((s) => s.platform === 'fractional-jobs')).toEqual({ platform: 'fractional-jobs', query: '', runDate: '2026-10-15', half: 'am' });
    expect(freelanceSeeds(FreelanceFile.parse({ platforms: { 'fractional-jobs': { enabled: false } } }), '2026-10-15', 'am', []).some((s) => s.platform === 'fractional-jobs')).toBe(false);
  });

  it('a team of its own, an edge, and fresh host state per wiring', () => {
    const a = freelanceAgents();
    const p = freelancePipeline(a);
    expect(p.teams.find((t) => t.id === 'sourcing-fractional-jobs')?.members).toEqual(['src-fractional-jobs']);
    expect(p.edges).toContainEqual({ type: 'GigRequest@1', to: 'src-fractional-jobs' });
    expect(PLATFORM_AGENT['fractional-jobs']).toBe('src-fractional-jobs');
    expect(FETCHING_PLATFORMS).toContain('fractional-jobs');
    expect(a.find((x) => x.contract.id === 'src-fractional-jobs')).not.toBe(freelanceAgents().find((x) => x.contract.id === 'src-fractional-jobs'));
  });
});
