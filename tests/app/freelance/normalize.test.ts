import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gigNormalizer, gigNormalizerContract, normalizeGig } from '../../../src/app/freelance/gig-normalizer.js';
import { gigDedupeKey, gigKey } from '../../../src/app/freelance/keys.js';
import { rateNormalizer, rateNormalizerContract, rateOf } from '../../../src/app/freelance/rate.js';
import { Gig, RatedGig, RawGig } from '../../../src/app/freelance/types.js';
import { appEvalSpecs } from '../../../src/app/evals.js';
import { assertNoForbidden, loadPack } from '../../../src/app/pack/load.js';
import type { Fx } from '../../../src/app/pack/schema.js';
import { runEval } from '../../../src/evals/runner.js';
import type { Agent } from '../../../src/kernel/agent.js';
import { freezePack, issueContext } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';

const root = join(import.meta.dirname, '../../..');
const { pack: full } = loadPack(join(root, 'tests/fixtures/pack'));
const { contact: _c, answers: _a, ...publicPack } = full;
const pack = freezePack(publicPack);
const FX: Fx = full.fx;

const baseGig = (over: Partial<Gig> = {}): Gig => ({
  gigKey: gigKey('freelancer', '1'),
  dedupeKey: gigDedupeKey(null, 'T'),
  platform: 'freelancer',
  sourceId: '1',
  url: 'https://x.test/1',
  title: 'T',
  description: '',
  client: { name: null, country: null, paymentVerified: null, hireRate: null, spendUsd: null, reviews: null, since: null },
  kind: 'gig',
  budget: { type: 'unknown', min: null, max: null, currency: null },
  hoursPerWeek: { min: null, max: null, source: null },
  duration: { weeks: null, text: null },
  timezone: { required: null, overlapText: null },
  location: { countries: [], worldwide: false, text: null },
  skills: [],
  postedAt: null,
  bids: null,
  ...over,
});

const raw = (platform: RawGig['platform'], sourceId: string, r: unknown): RawGig => ({ platform, sourceId, raw: r });

async function runAgent<I, O>(agent: Agent<I, O>, input: I, p: unknown): Promise<readonly O[]> {
  const c = agent.contract;
  const ctx = issueContext({ contract: c, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => { throw new Error('offline'); } }, clock: fixedClock('2026-10-12T00:00:00Z'), signal: new AbortController().signal, ...(p === undefined ? {} : { pack: p }) });
  return agent.run(input, ctx);
}

describe('contracts', () => {
  it('both are deterministic, understanding-team, no llm, no effect, one skill', () => {
    for (const c of [gigNormalizerContract, rateNormalizerContract]) {
      expect(c.kind).toBe('deterministic');
      expect(c.team).toBe('understanding');
      expect(c.skills).toHaveLength(1);
      expect(c.description.length).toBeGreaterThanOrEqual(10);
      expect(c.description).not.toMatch(/\band\b/i);
      expect(c.capabilities.llm).toBeFalsy();
      expect('effect' in c && c.effect !== undefined).toBe(false);
    }
    expect(gigNormalizerContract).toMatchObject({ id: 'gig-normalizer', consumes: RawGig, produces: Gig });
    expect(rateNormalizerContract).toMatchObject({ id: 'rate-normalizer', consumes: Gig, produces: RatedGig, capabilities: { pack: true } });
    expect(gigNormalizerContract.capabilities.pack).toBeFalsy();
  });
});

describe('gig-normalizer', () => {
  it('sets gigKey and dedupeKey, one Gig per RawGig', async () => {
    const outs = await runAgent(gigNormalizer, raw('remotive', '9', { id: 9, url: 'https://remotive.com/j/9', title: 'Go Dev', company_name: 'Acme', job_type: 'contract', description: '<p>x</p>' }), undefined);
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ gigKey: gigKey('remotive', '9'), dedupeKey: gigDedupeKey('Acme', 'Go Dev'), platform: 'remotive', sourceId: '9', kind: 'contract' });
  });

  it('is pure: the same RawGig gives the same Gig and the input is untouched', () => {
    const r = raw('hn-freelancer', '5', { id: 5, created_at_i: 1790867101, text: 'SEEKING FREELANCER<p>$50/h' });
    const before = JSON.stringify(r);
    expect(normalizeGig(r)).toEqual(normalizeGig(r));
    expect(JSON.stringify(r)).toBe(before);
  });

  it('names the missing field, and rejects an unknown platform', () => {
    expect(() => normalizeGig(raw('freelancer', '1', { title: '', seo_url: 'a/b' }))).toThrow(/gig-normalizer: freelancer 1: missing title/);
    expect(() => normalizeGig(raw('freelancer', '1', { title: 'T', seo_url: '' }))).toThrow(/missing url/);
    expect(() => normalizeGig(raw('upwork', '1', {}))).toThrow(/unsupported platform upwork/);
  });

  it('hours need a per-week phrase; the Freelancer commitment default is never read', () => {
    const g = (text: string) => normalizeGig(raw('freelancer', '1', { title: 'T', seo_url: 'a/b', description: text, type: 'hourly', budget: { minimum: 1, maximum: 2 }, currency: { code: 'USD' }, hourly_project_info: { commitment: { hours: 40, interval: 'week' } } })).hoursPerWeek;
    expect(g('10 hours per week')).toEqual({ min: 10, max: 10, source: 'text' });
    expect(g('20-30 hrs/wk')).toEqual({ min: 20, max: 30, source: 'text' });
    expect(g('part-time')).toEqual({ min: null, max: null, source: null });
    expect(g('about 27 hours total')).toEqual({ min: null, max: null, source: null });
    expect(g('30-15 hours a week')).toEqual({ min: null, max: null, source: null });
  });

  it('turns every Freelancer and Remotive fixture item into a valid Gig, with a stable key and no invented client', async () => {
    const base = (n: string) => join(root, 'tests/fixtures/freelance', n);
    const projects = (JSON.parse(readFileSync(base('freelancer/typescript.json'), 'utf8')) as { result: { projects: { id: number }[] } }).result.projects;
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) {
      const g = normalizeGig(raw('freelancer', String(p.id), p));
      expect(Gig.schema.safeParse(g).success, String(p.id)).toBe(true);
      expect(g.client.name).toBeNull();
      expect(g.hoursPerWeek.source === null || g.hoursPerWeek.source === 'text').toBe(true);
    }
    const jobs = (JSON.parse(readFileSync(base('remotive/software-dev.json'), 'utf8')) as { jobs: { id: number; job_type: string }[] }).jobs.filter((j) => ['contract', 'freelance', 'part_time'].includes(j.job_type));
    for (const j of jobs) expect(Gig.schema.safeParse(normalizeGig(raw('remotive', String(j.id), j))).success).toBe(true);
  });
});

describe('rateOf', () => {
  it('converts with the pack table: INR 750-1250 an hour is $8.98-14.97', () => {
    const r = rateOf(baseGig({ budget: { type: 'hourly', min: 750, max: 1250, currency: 'INR' } }), FX, 20);
    expect(r).toEqual({ minUsdH: 8.98, maxUsdH: 14.97, method: 'stated', fxDate: '2026-10-01', budgetUsd: null });
  });

  it('GBP 36 an hour is 36 x 106.4 / 83.5 = $45.87', () => {
    expect(rateOf(baseGig({ budget: { type: 'hourly', min: 36, max: null, currency: 'GBP' } }), FX, 20)).toMatchObject({ minUsdH: 45.87, maxUsdH: null, method: 'stated' });
  });

  it('rounds half up to 2 decimals', () => {
    expect(rateOf(baseGig({ budget: { type: 'hourly', min: 0.125, max: 8.375, currency: 'USD' } }), FX, 20)).toMatchObject({ minUsdH: 0.13, maxUsdH: 8.38 });
  });

  it('a CAD or AUD budget is unknown: Gig@1 carries no platform rate', () => {
    for (const currency of ['CAD', 'AUD'] as const) {
      expect(rateOf(baseGig({ budget: { type: 'fixed', min: 100, max: 200, currency }, duration: { weeks: 2, text: '2 weeks' } }), FX, 20)).toEqual({ minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, budgetUsd: null });
    }
  });

  it('a derived rate takes the pack maxHoursPerWeek, not a constant', () => {
    const g = baseGig({ budget: { type: 'fixed', min: 2000, max: 2000, currency: 'USD' }, duration: { weeks: 2, text: '2 weeks' } });
    expect(rateOf(g, FX, 20)).toMatchObject({ minUsdH: 50, method: 'derived-from-duration' });
    expect(rateOf(g, FX, 10)).toMatchObject({ minUsdH: 100, method: 'derived-from-duration' });
  });

  it('an hours-per-week phrase in the description is not total hours', () => {
    const g = baseGig({ budget: { type: 'fixed', min: 1000, max: 1000, currency: 'USD' }, description: 'Needs 40 hours per week and 20 hours a week.' });
    expect(rateOf(g, FX, 20)).toMatchObject({ method: 'unknown', budgetUsd: 1000 });
  });

  it('two different total-hours figures are ambiguous, so not used', () => {
    const g = baseGig({ budget: { type: 'fixed', min: 1000, max: 1000, currency: 'USD' }, description: 'About 50 hours, maybe 80 hours.' });
    expect(rateOf(g, FX, 20).method).toBe('unknown');
  });

  it('never returns a number for garbage, and never mutates its input', () => {
    const bad = [
      { type: 'hourly', min: 60, max: 40, currency: 'USD' },
      { type: 'hourly', min: -1, max: 40, currency: 'USD' },
      { type: 'hourly', min: 0, max: 0, currency: 'USD' },
      { type: 'fixed', min: Number.NaN, max: 40, currency: 'USD' },
      { type: 'fixed', min: 1, max: Number.POSITIVE_INFINITY, currency: 'USD' },
    ] as const;
    for (const budget of bad) {
      const g = baseGig({ budget: { ...budget }, duration: { weeks: 2, text: null } });
      const copy = structuredClone(g);
      expect(rateOf(g, FX, 20)).toEqual({ minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, budgetUsd: null });
      expect(g).toEqual(copy);
    }
  });

  it('an annual salary is not a freelance rate: a boards gig is unknown', () => {
    expect(rateOf(normalizeGig(raw('boards', 'k', { jobKey: '0123456789abcdef', dedupeKey: 'fedcba9876543210', source: 'greenhouse', sourceId: 'k', company: 'C', slug: 'c', ats: 'greenhouse', title: 'Contract SRE', url: 'https://b.test/k', locationText: 'India', remote: { structured: 'remote', countries: ['india'], signals: [] }, employmentType: 'Contract', descriptionText: 'x', postedAt: null, comp: { min: 100, max: 200, currency: 'USD', period: 'year', basis: 'base' }, yearsRequired: null })), FX, 20).method).toBe('unknown');
  });
});

describe('rate-normalizer agent', () => {
  it('reads fx and maxHoursPerWeek from the pack and emits a RatedGig', async () => {
    const g = baseGig({ budget: { type: 'fixed', min: 3000, max: 3000, currency: 'USD' }, duration: { weeks: 2, text: '2 weeks' } });
    const [out] = await runAgent(rateNormalizer, g, pack);
    expect(out).toEqual({ gig: g, rate: { minUsdH: 75, maxUsdH: 75, method: 'derived-from-duration', fxDate: null, budgetUsd: 3000 } });
    const tweaked = freezePack({ ...publicPack, freelance: { ...publicPack.freelance, maxHoursPerWeek: 10 } });
    const [out10] = await runAgent(rateNormalizer, g, tweaked);
    expect(out10?.rate.minUsdH).toBe(150);
  });

  it('fails loudly without a usable pack', async () => {
    await expect(runAgent(rateNormalizer, baseGig(), { nothing: true })).rejects.toThrow(/rate-normalizer: the pack lacks/);
  });
});

describe('golden evals', () => {
  const specs = appEvalSpecs(join(root, 'evals/datasets'), join(root, 'tests/fixtures/pack'));
  const providers = { fetch: async () => ({ status: 404, text: async () => '' }) };

  it('gig-normalizer: at least 30 cases, gate 1.0, every platform and error path present', async () => {
    const spec = specs.find((s) => s.agent.contract.id === 'gig-normalizer')!;
    expect(spec).toMatchObject({ metric: 'exactMatch', min: 1 });
    expect(spec.cases.length).toBeGreaterThanOrEqual(30);
    const platforms = new Set(spec.cases.map((c) => (c.input as RawGig).platform));
    for (const p of ['freelancer', 'remotive', 'hn-freelancer', 'hn-hiring', 'boards']) expect(platforms.has(p as RawGig['platform']), p).toBe(true);
    expect(spec.cases.filter((c) => 'error' in (c.expected as object)).length).toBeGreaterThanOrEqual(5);
    const r = await runEval(spec, { providers, policy: PRODUCT_POLICY_V1 });
    expect(r.failures).toEqual([]);
    expect(r).toMatchObject({ score: 1, pass: true });
  });

  it('gig-rate: at least 30 cases, every method and currency, gate 1.0', async () => {
    const spec = specs.find((s) => s.name === 'gig-rate')!;
    expect(spec.agent.contract.id).toBe('rate-normalizer');
    expect(spec).toMatchObject({ metric: 'exactMatch', min: 1 });
    expect(spec.cases.length).toBeGreaterThanOrEqual(30);
    const methods = new Set(spec.cases.map((c) => (c.expected as { method: string }).method));
    for (const m of ['stated', 'fixed÷stated-hours', 'derived-from-duration', 'monthly÷hours', 'unknown']) expect(methods.has(m), m).toBe(true);
    const currencies = new Set(spec.cases.map((c) => (c.input as Gig).budget.currency));
    for (const c of ['USD', 'INR', 'EUR', 'GBP', 'CAD', 'AUD']) expect(currencies.has(c as never), c).toBe(true);
    const inr = spec.cases.find((c) => c.id === 'stated-inr-750-1250')!;
    expect(inr.expected).toMatchObject({ minUsdH: 8.98, maxUsdH: 14.97 });
    const gbp = spec.cases.find((c) => c.id === 'stated-gbp-36-min-only')!;
    expect(gbp.expected).toMatchObject({ minUsdH: 45.87 });
    const r = await runEval(spec, { providers, policy: PRODUCT_POLICY_V1 });
    expect(r.failures).toEqual([]);
    expect(r).toMatchObject({ score: 1, pass: true });
  });

  it('datasets carry no forbidden fixture term', () => {
    for (const f of ['gig-normalizer.jsonl', 'gig-rate.jsonl']) assertNoForbidden(readFileSync(join(root, 'evals/datasets', f), 'utf8'), full.naming);
  });
});
