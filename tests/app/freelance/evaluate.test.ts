import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideGig, gigEligibility, gigEligibilityContract } from '../../../src/app/freelance/gig-eligibility.js';
import { gigRisk, gigRiskContract, riskFlags } from '../../../src/app/freelance/gig-risk.js';
import { normalizeGig } from '../../../src/app/freelance/gig-normalizer.js';
import { gigDedupeKey, gigKey } from '../../../src/app/freelance/keys.js';
import { rateOf } from '../../../src/app/freelance/rate.js';
import { Gig, GigVerdict, RatedGig, RawGig, RiskedGig } from '../../../src/app/freelance/types.js';
import * as freelanceSchema from '../../../src/app/pack/freelance-schema.js';
import { appEvalSpecs } from '../../../src/app/evals.js';
import { assertNoForbidden, loadPack } from '../../../src/app/pack/load.js';
import { runEval } from '../../../src/evals/runner.js';
import type { Agent } from '../../../src/kernel/agent.js';
import { freezePack, issueContext } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';

const root = join(import.meta.dirname, '../../..');
const { pack: full } = loadPack(join(root, 'tests/fixtures/pack'));
const { contact: _c, answers: _a, ...publicPack } = full;
const pack = freezePack(publicPack);
const FX = full.fx;

const baseGig = (over: Partial<Gig> = {}): Gig => ({
  gigKey: gigKey('freelancer', '1'),
  dedupeKey: gigDedupeKey(null, 'T'),
  platform: 'freelancer',
  sourceId: '1',
  url: 'https://x.test/1',
  title: 'Go backend developer',
  description: '',
  client: { name: null, country: null, paymentVerified: null, hireRate: null, spendUsd: null, reviews: null, since: null },
  kind: 'contract',
  budget: { type: 'hourly', min: 50, max: 60, currency: 'USD', usdPerUnit: null },
  hoursPerWeek: { min: 10, max: 10, source: 'text' },
  duration: { weeks: null, text: null },
  timezone: { required: null, overlapText: null },
  location: { countries: [], worldwide: true, text: null },
  skills: [],
  postedAt: null,
  bids: null,
  ...over,
});
const STATED: RatedGig['rate'] = { minUsdH: 50, maxUsdH: 60, method: 'stated', fxDate: null, fxSource: null, budgetUsd: null };
const rated = (over: Partial<Gig> = {}, rate: RatedGig['rate'] = STATED): RatedGig => ({ gig: baseGig(over), rate });
const gigPack = {
  filters: full.filters,
  naming: full.naming,
  platformRules: full.platformRules,
  freelance: full.freelance,
};
const decide = (r: RatedGig, p: typeof gigPack = gigPack) => decideGig(r, p);

async function runAgent<I, O>(agent: Agent<I, O>, input: I, p: unknown): Promise<readonly O[]> {
  const c = agent.contract;
  const ctx = issueContext({ contract: c, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => { throw new Error('offline'); } }, clock: fixedClock('2026-10-12T00:00:00Z'), signal: new AbortController().signal, ...(p === undefined ? {} : { pack: p }) });
  return agent.run(input, ctx);
}

describe('contracts', () => {
  it('both are deterministic, evaluation-team, pack-reading, no llm, no effect, one skill', () => {
    for (const c of [gigEligibilityContract, gigRiskContract]) {
      expect(c.kind).toBe('deterministic');
      expect(c.team).toBe('evaluation');
      expect(c.capabilities.pack).toBe(true);
      expect(c.capabilities.llm).toBeFalsy();
      expect('effect' in c && c.effect !== undefined).toBe(false);
      expect(c.skills).toHaveLength(1);
      expect(c.description.length).toBeGreaterThanOrEqual(10);
      expect(c.description).not.toMatch(/\band\b/i);
    }
    expect(gigEligibilityContract).toMatchObject({ id: 'gig-eligibility', consumes: RatedGig, produces: GigVerdict });
    expect(gigRiskContract).toMatchObject({ id: 'gig-risk', consumes: GigVerdict, produces: RiskedGig });
  });
});

describe('gig-eligibility: the brief cases', () => {
  it('a $300 fixed gig with no hours is budget-below-floor; $500 is not', () => {
    const g = baseGig({ kind: 'gig', budget: { type: 'fixed', min: 300, max: 300, currency: 'USD', usdPerUnit: null }, hoursPerWeek: { min: null, max: null, source: null } });
    const rate = rateOf(g, FX, 20);
    expect(rate).toMatchObject({ method: 'unknown', budgetUsd: 300 });
    expect(decide({ gig: g, rate })).toEqual({ verdict: 'rejected', reasons: ['budget-below-floor'], notes: [] });
    const g500 = { ...g, budget: { ...g.budget, min: 500, max: 500 } };
    expect(decide({ gig: g500, rate: rateOf(g500, FX, 20) }).verdict).toBe('eligible');
  });

  it('GBP 36 an hour is $45.87 (36 x 106.4 / 83.5), so it passes; GBP 30-31 is $38.23-39.50, so it is rate-below-floor:39.5', () => {
    const at = (min: number, max: number | null) => {
      const g = baseGig({ budget: { type: 'hourly', min, max, currency: 'GBP', usdPerUnit: null } });
      const rate = rateOf(g, FX, 20);
      return { rate, d: decide({ gig: g, rate }) };
    };
    expect(at(36, null).rate).toMatchObject({ minUsdH: 45.87, maxUsdH: null });
    expect(at(36, null).d.verdict).toBe('eligible');
    expect(at(30, 31).rate).toMatchObject({ minUsdH: 38.23, maxUsdH: 39.5 });
    expect(at(30, 31).d).toEqual({ verdict: 'rejected', reasons: ['rate-below-floor:39.5'], notes: [] });
  });

  it('a 25 h/week contract is hours-over-cap; 20 h/week is not', () => {
    const d = (n: number) => decide(rated({ hoursPerWeek: { min: n, max: n, source: 'text' }, description: `Need ${n} hours per week.` }));
    expect(d(25)).toEqual({ verdict: 'rejected', reasons: ['hours-over-cap'], notes: [] });
    expect(d(20).verdict).toBe('eligible');
  });

  it('"online 9-5 EST" shares 4.5 h with 18:00-24:00 IST (9am EST = 19:30 IST), so it passes; 9am-5pm PST shares 1.5 h and is rejected', () => {
    expect(decide(rated({ description: 'Must be online 9-5 EST.' })).verdict).toBe('eligible');
    expect(decide(rated({ description: 'Must be online 9am-5pm PST.' }))).toEqual({ verdict: 'rejected', reasons: ['overlap-outside-ist-window'], notes: [] });
  });

  it('"async, some overlap with EST" passes', () => {
    expect(decide(rated({ description: 'Async, some overlap with EST.' }))).toEqual({ verdict: 'eligible', reasons: [], notes: [] });
  });
});

describe('gig-eligibility: role filter and preset brackets', () => {
  it('a roleDeny match on a gig title is a review with the pattern in the note, and companyDeny/naming still reject', () => {
    expect(decide(rated({ title: 'Android app for parcels' }))).toEqual({ verdict: 'review', reasons: ['role-filter'], notes: ['title matches your role filter: android'] });
    expect(decide(rated({ title: 'Full-Stack Mobile-First E-commerce Website' }))).toEqual({ verdict: 'review', reasons: ['role-filter'], notes: ['title matches your role filter: mobile'] }); // a recorded false reject
    const co = { ...baseGig().client, name: 'Infosys BPM' };
    expect(decide(rated({ title: 'Android app', client: co }))).toEqual({ verdict: 'rejected', reasons: ['company:Infosys'], notes: ['title matches your role filter: android'] });
  });

  it('matches preset brackets on the raw currency, min and max, so the fx table does not matter', () => {
    const fixed = (currency: 'INR' | 'USD' | 'EUR', min: number, max: number, budgetUsd: number) =>
      decide(rated({ kind: 'gig', hoursPerWeek: { min: null, max: null, source: null }, budget: { type: 'fixed', min, max, currency, usdPerUnit: null } }, { minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, fxSource: null, budgetUsd }));
    expect(fixed('INR', 12500, 37500, 449.1)).toEqual({ verdict: 'review', reasons: ['budget-preset'], notes: ['preset bracket - bids may exceed it'] });
    expect(fixed('INR', 12500, 37500, 4491)).toEqual({ verdict: 'eligible', reasons: [], notes: [] }); // whatever the fx said, the top is above the floor
    expect(fixed('INR', 12500, 30000, 359.28).reasons).toEqual(['budget-below-floor']);
    expect(fixed('USD', 300, 300, 300).reasons).toEqual(['budget-below-floor']);
    // a pack without presets rejects the same INR bracket
    const none = { ...gigPack, platformRules: {} } as unknown as typeof gigPack;
    const g = rated({ kind: 'gig', hoursPerWeek: { min: null, max: null, source: null }, budget: { type: 'fixed', min: 12500, max: 37500, currency: 'INR', usdPerUnit: null } }, { minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, fxSource: null, budgetUsd: 449.1 });
    expect(decide(g, none).reasons).toEqual(['budget-below-floor']);
  });

  it('a tier holds in every currency of its group, and fixed and hourly tiers are typed apart', () => {
    const fixed = (currency: 'USD' | 'AUD' | 'HKD' | 'INR', min: number, max: number, budgetUsd: number) =>
      decide(rated({ kind: 'gig', hoursPerWeek: { min: null, max: null, source: null }, budget: { type: 'fixed', min, max, currency: currency as never, usdPerUnit: null } }, { minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, fxSource: null, budgetUsd }));
    // AUD 30-250 x 0.69767 = 174.42 (the platform rate, hand-computed): no AUD row in the fx table is needed
    expect(fixed('AUD', 30, 250, 174.42).reasons).toEqual(['budget-preset']);
    expect(fixed('HKD', 240, 2000, 254.85).reasons).toEqual(['budget-preset']);
    expect(fixed('INR', 30, 250, 3).reasons).toEqual(['budget-below-floor']); // the dollar tier is not an INR tier
    expect(fixed('USD', 15, 25, 25).reasons).toEqual(['budget-below-floor']); // 15-25 is an hourly tier
  });

  it('a rate worked out of a preset bracket is review, never rate-below-floor', () => {
    const g = rated({ kind: 'gig', hoursPerWeek: { min: null, max: null, source: null }, budget: { type: 'fixed', min: 250, max: 750, currency: 'USD', usdPerUnit: null } }, { minUsdH: 9.26, maxUsdH: 27.78, method: 'fixed÷stated-hours', fxDate: null, fxSource: null, budgetUsd: 750 });
    expect(decide(g)).toEqual({ verdict: 'review', reasons: ['budget-preset'], notes: ['preset bracket - bids may exceed it'] });
    const custom = rated({ kind: 'gig', hoursPerWeek: { min: null, max: null, source: null }, budget: { type: 'fixed', min: 600, max: 700, currency: 'USD', usdPerUnit: null } }, { minUsdH: 9.26, maxUsdH: 27.78, method: 'fixed÷stated-hours', fxDate: null, fxSource: null, budgetUsd: 700 });
    expect(decide(custom).reasons).toEqual(['rate-below-floor:27.78']);
  });

  it('a hedged rate or budget is review with the note, a plain one still rejects', () => {
    const d = (description: string) => decide(rated({ description }, { ...STATED, minUsdH: 25, maxUsdH: 35 }));
    for (const t of ['The hourly rate is indicative only.', 'If you have a different rate, put it in your reply.', 'Please quote your hourly rate.', 'Budget is flexible.', 'Pay is negotiable.']) {
      expect(d(t), t).toEqual({ verdict: 'review', reasons: ['rate-unclear'], notes: ['rate negotiable - verify'] });
    }
    expect(d('Flexible working hours.').reasons).toEqual(['rate-below-floor:35']); // flexible about something other than money
    expect(d('Hours are 10 per week.').reasons).toEqual(['rate-below-floor:35']);
  });

  it('the default freelancer presets are the derived list', () => {
    const rules = freelanceSchema.PlatformRulesFile.parse({});
    const tiers = rules.freelancer.presetBrackets;
    expect(tiers).toHaveLength(20);
    expect(tiers).toContainEqual({ type: 'fixed', min: 12500, max: 37500, currencies: ['INR'] });
    expect(tiers).toContainEqual({ type: 'fixed', min: 250, max: 750, currencies: ['USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'SGD'] });
    expect(tiers.filter((t) => t.type === 'hourly')).toHaveLength(7);
    expect(rules.upwork.presetBrackets).toEqual([]);
  });

  it('a user-written freelancer entry merges over the defaults: it never silently loses the presets', () => {
    const rules = freelanceSchema.PlatformRulesFile.parse({ freelancer: { maxChars: 1000 } });
    expect(rules.freelancer.maxChars).toBe(1000);
    expect(rules.freelancer.hookChars).toBe(150);
    expect(rules.freelancer.presetBrackets).toHaveLength(20);
    expect(freelanceSchema.PlatformRulesFile.parse({ freelancer: { presetBrackets: [] } }).freelancer.presetBrackets).toEqual([]); // an explicit empty list is the user's choice
  });
});

describe('gig-eligibility: rules', () => {
  it('names a forbidden term only as the reason `naming`, whether in the client name, title, description or glued', () => {
    const p = { ...gigPack, naming: { ...full.naming, forbiddenTerms: ['Zorblax'] } };
    for (const over of [
      { client: { ...baseGig().client, name: 'Zorblax Labs' } },
      { title: 'Work for Zorblax' },
      { description: 'We are Zorblax.' },
      { description: 'We are ZorblaxPay.' },
    ] as Partial<Gig>[]) {
      const d = decide(rated(over), p);
      expect(d).toEqual({ verdict: 'rejected', reasons: ['naming'], notes: [] });
      expect(JSON.stringify(d)).not.toMatch(/zorblax/i);
    }
    expect(decide(rated({ description: 'We are fine.' }), p).verdict).toBe('eligible');
  });

  it('the pack knobs are read: hour cap, rate floor, budget floor, IST window', () => {
    const with_ = (freelance: Partial<typeof full.freelance>) => ({ ...gigPack, freelance: { ...full.freelance, ...freelance } });
    const h25 = rated({ hoursPerWeek: { min: 25, max: 25, source: 'text' }, description: 'Need 25 hours per week.' });
    expect(decide(h25, with_({ maxHoursPerWeek: 30 })).verdict).toBe('eligible');
    expect(decide(rated({}, { ...STATED, minUsdH: 45, maxUsdH: 50 }), with_({ rateFloorUsdHour: 60 })).reasons).toEqual(['rate-below-floor:50']);
    const fixed = rated({ kind: 'gig', hoursPerWeek: { min: null, max: null, source: null } }, { minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, fxSource: null, budgetUsd: 700 });
    expect(decide(fixed, with_({ fixedBudgetFloorUsd: 800 })).reasons).toEqual(['budget-below-floor']);
    expect(decide(fixed).verdict).toBe('eligible');
    // 9am-5pm PST is 22:30-06:30 IST: rejected on 18:00-00:00, fine on 22:00-06:00
    const pst = rated({ description: 'Must be online 9am-5pm PST.' });
    expect(decide(pst, with_({ istWindow: '22:00-06:00' })).verdict).toBe('eligible');
  });

  it('derivedRateCountsForFloor false: a derived rate below the floor passes with a note; a stated one still rejects', () => {
    const off = { ...gigPack, freelance: { ...full.freelance, derivedRateCountsForFloor: false } };
    const derived = rated({ kind: 'gig', hoursPerWeek: { min: null, max: null, source: null } }, { minUsdH: 12.5, maxUsdH: 12.5, method: 'derived-from-duration', fxDate: null, fxSource: null, budgetUsd: 500 });
    expect(decide(derived).reasons).toEqual(['rate-below-floor:12.5']);
    expect(decide(derived, off)).toEqual({ verdict: 'eligible', reasons: [], notes: ['derived rate below floor - not counted'] });
    expect(decide(rated({}, { ...STATED, minUsdH: 20, maxUsdH: 30 }), off).reasons).toEqual(['rate-below-floor:30']);
  });

  it('a fixed-price gig that clears the budget floor is eligible with an unknown rate; a contract with an unknown rate is review', () => {
    const unknown: RatedGig['rate'] = { minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, fxSource: null, budgetUsd: 900 };
    expect(decide(rated({ kind: 'gig' }, unknown))).toEqual({ verdict: 'eligible', reasons: [], notes: [] });
    expect(decide(rated({ kind: 'contract' }, unknown))).toEqual({ verdict: 'review', reasons: ['rate-unclear'], notes: ['rate unknown - verify'] });
  });

  it('a wrong reject is the dangerous direction: ambiguous text is review, never rejected', () => {
    const noHours = { min: null, max: null, source: null } as const;
    const text = (description: string, over: Partial<Gig> = {}) => decide(rated({ hoursPerWeek: noHours, description, ...over }));
    for (const d of [
      'We are a full-time remote team of engineers.',
      'Full time or part time role.',
      'Part-time contract, path to full-time.',
      'Full-time preferred. Contract possible.',
      'This is not a full-time position.',
      'Dedicated resource for our team.',
      "We don't offer full-time contract roles.",
      'We are hiring full-time employees in the US, and a contractor for this project.',
    ]) expect(text(d).verdict, d).toBe('review');
    expect(decide(rated({ hoursPerWeek: { min: 40, max: 40, source: 'text' }, description: 'Our projects are typically 40 hours per week.' })).verdict).toBe('review');
    expect(decide(rated({ hoursPerWeek: { min: 30, max: 30, source: 'text' }, description: 'No more than 30 hours per week.' })).verdict).toBe('review');
    for (const d of ['We work 40 hours per week.', 'Our team is available 40 hours per week for calls.', 'If you can do 40 hours per week, even better.', 'Ideally 40 hours per week.']) {
      expect(decide(rated({ hoursPerWeek: { min: 40, max: 40, source: 'text' }, description: d })).verdict, d).toBe('review');
    }
    expect(decide(rated({ hoursPerWeek: noHours, description: 'As a contractor you will work alongside our full-time engineers.' })).verdict).toBe('review');
    expect(decide(rated({ description: 'We are available 9am-5pm PST for questions.' })).verdict).toBe('eligible');
    expect(decide(rated({ location: { countries: ['europe'], worldwide: false, text: null } })).verdict).toBe('review');
    expect(decide(rated({ location: { countries: ['united states'], worldwide: false, text: 'USA preferred' } })).verdict).toBe('review');
    expect(decide(rated({ description: 'Online 9am-5pm PST, flexible.' })).verdict).toBe('eligible');
    expect(decide(rated({ description: 'Ideally online 9am-5pm PST.' })).verdict).toBe('eligible');
    expect(decide(rated({ description: 'Grant us non-exclusive rights.' })).verdict).toBe('eligible');
  });

  it('IST overlap: window arithmetic, ambiguity and unparseable zones', () => {
    const d = (description: string) => decide(rated({ description }));
    expect(d('Available 10am-6pm EST.').verdict).toBe('eligible'); // 20:30-04:30 IST, shares 3.5 h
    expect(d('Working hours 8:00 - 16:00 CET').verdict).toBe('eligible'); // 12:30-20:30 IST, shares 2.5 h
    expect(d('Must be available 7am-3pm CET.').reasons).toEqual(['overlap-outside-ist-window']); // 11:30-19:30 IST, shares 1.5 h
    expect(d('Be available 14:00 to 22:00 UTC').verdict).toBe('eligible'); // 19:30-03:30 IST
    expect(d('Available 9-5 UTC').verdict).toBe('eligible'); // 9am-5pm UTC = 14:30-22:30 IST shares 4.5 h; a bare 9-5 is read as 9am-5pm
    expect(d('Must be available 9-5 IST.').reasons).toEqual(['overlap-outside-ist-window']); // no suffix reads as business hours (9am-5pm): 09:00-17:00 IST shares nothing
  });

  it('is pure: the same input gives the same verdict and the input is untouched', () => {
    const r = rated({ description: 'Need 25 hours per week. Online 9am-5pm PST.', hoursPerWeek: { min: 25, max: 25, source: 'text' } });
    const before = JSON.stringify(r);
    expect(decide(r)).toEqual(decide(r));
    expect(JSON.stringify(r)).toBe(before);
  });
});

describe('gig-eligibility agent', () => {
  it('emits one GigVerdict that carries the RatedGig unchanged', async () => {
    const r = rated({ hoursPerWeek: { min: 25, max: 25, source: 'text' }, description: 'Need 25 hours per week.' });
    const outs = await runAgent(gigEligibility, r, pack);
    expect(outs).toEqual([{ rated: r, verdict: 'rejected', reasons: ['hours-over-cap'], notes: [] }]);
    expect(GigVerdict.schema.safeParse(outs[0]).success).toBe(true);
  });

  it('fails loudly without a usable pack', async () => {
    await expect(runAgent(gigEligibility, rated(), { nothing: true })).rejects.toThrow(/gig-eligibility: the pack lacks/);
  });
});

describe('gig-risk agent', () => {
  const verdictOf = (over: Partial<Gig>, verdict: GigVerdict['verdict'] = 'eligible'): GigVerdict => ({ rated: rated(over), verdict, reasons: [], notes: [] });
  const HISTORY = { name: null, country: null, paymentVerified: null, hireRate: 0.5, spendUsd: 4000, reviews: 12, since: '2020-01-01' };
  const LONG = 'x'.repeat(320);

  it('flags never change the verdict, reasons or notes: the verdict is carried unchanged', async () => {
    const v: GigVerdict = { ...verdictOf({ description: 'Contact me on WhatsApp. Payment in USDT.' }, 'rejected'), reasons: ['rate-below-floor:30'], notes: ['n'] };
    const [out] = await runAgent(gigRisk, v, pack);
    expect(out?.verdict).toEqual(v);
    expect(out?.flags.map((f) => f.id)).toEqual(['off-platform', 'thin-brief', 'unusual-payment']);
    expect(RiskedGig.schema.safeParse(out).success).toBe(true);
  });

  it('flag details are fixed text: nothing of the description is echoed, so a forbidden term cannot leak', () => {
    const flags = riskFlags(verdictOf({ client: { ...HISTORY, paymentVerified: false }, description: `${LONG} Contact me on WhatsApp about Zorblax. Payment in USDT. A registration fee. Free test task.` }));
    expect(flags.map((f) => f.id)).toEqual(['off-platform', 'payment-unverified', 'unpaid-test', 'unusual-payment', 'upfront-fee']);
    for (const f of flags) expect(f.detail).not.toMatch(/zorblax|whatsapp|usdt/i);
  });

  it('never computes duplicate-text (the projector sets it)', () => {
    for (const d of ['', LONG, 'same same same']) expect(riskFlags(verdictOf({ description: d })).map((f) => f.id)).not.toContain('duplicate-text');
  });

  it('thin-brief needs both no client history and a description under 300 characters', () => {
    expect(riskFlags(verdictOf({ description: 'short' })).map((f) => f.id)).toEqual(['thin-brief']);
    expect(riskFlags(verdictOf({ description: 'short', client: HISTORY })).map((f) => f.id)).toEqual([]);
    expect(riskFlags(verdictOf({ description: 'x'.repeat(300) })).map((f) => f.id)).toEqual([]);
    expect(riskFlags(verdictOf({ description: 'x'.repeat(299) })).map((f) => f.id)).toEqual(['thin-brief']);
  });

  it('a negated fee is not a fee, a product is not a contact, a paid test is not unpaid', () => {
    const ids = (d: string) => riskFlags(verdictOf({ client: HISTORY, description: `${LONG} ${d}` })).map((f) => f.id);
    expect(ids('No registration fee, no security fee.')).toEqual([]);
    expect(ids('Build a Telegram bot for signal alerts.')).toEqual([]);
    expect(ids('Paid test task of 4 hours.')).toEqual([]);
    expect(ids('Paid test task of 4 hours. Free test as well.')).toEqual(['unpaid-test']);
  });
});

describe('real recordings, hand-labelled', () => {
  const fx = (p: string) => JSON.parse(readFileSync(join(root, 'tests/fixtures/freelance', p), 'utf8')) as Record<string, unknown>;
  const raw = (platform: RawGig['platform'], sourceId: string, r: unknown): RawGig => ({ platform, sourceId, raw: r });
  const verdictFor = (g: Gig) => decide({ gig: g, rate: rateOf(g, FX, 20) });

  it('a Freelancer posting that asks for "Commitment: Full-time, 40 hours per week" is hours-over-cap', () => {
    const projects = (fx('freelancer/typescript.json') as { result: { projects: { id: number }[] } }).result.projects;
    const p = projects.find((x) => x.id === 40759801)!;
    expect(verdictFor(normalizeGig(raw('freelancer', '40759801', p)))).toMatchObject({ verdict: 'rejected', reasons: ['hours-over-cap'] });
  });

  it('a studio that says its projects are "rarely less than 8 full time weeks at 40 hours per week" is review, not rejected', () => {
    const jobs = (fx('remotive/software-dev.json') as { jobs: { id: number }[] }).jobs;
    const j = jobs.find((x) => x.id === 2091140)!;
    expect(verdictFor(normalizeGig(raw('remotive', '2091140', j)))).toMatchObject({ verdict: 'review', reasons: ['hours-unclear', 'rate-unclear'], notes: ['hours stated without a clear requirement - verify', 'rate unknown - verify'] });
  });

  it('"Full-time contractor | $23-$34 USD/hour" is rejected on hours first (rate $34 would also be below the floor)', () => {
    const c = (fx('hn/hiring-thread.json') as { children: { id: number }[] }).children.find((x) => x.id === 49931746)!;
    expect(verdictFor(normalizeGig(raw('hn-hiring', '49931746', c)))).toMatchObject({ verdict: 'rejected', reasons: ['hours-over-cap'] });
  });

  it('a hiring post that lists "Full time or part time or contract" is review', () => {
    const c = (fx('hn/hiring-thread.json') as { children: { id: number }[] }).children.find((x) => x.id === 49926050)!;
    const d = verdictFor(normalizeGig(raw('hn-hiring', '49926050', c)));
    expect(d.verdict).toBe('review');
    expect(d.reasons).toContain('hours-unclear');
  });
});

describe('golden evals', () => {
  const specs = appEvalSpecs(join(root, 'evals/datasets'), join(root, 'tests/fixtures/pack'));
  const providers = { fetch: async () => ({ status: 404, text: async () => '' }) };

  it('gig-eligibility: at least 40 cases, every rule and every verdict present, gate 1.0', async () => {
    const spec = specs.find((s) => s.name === 'gig-eligibility')!;
    expect(spec.agent.contract.id).toBe('gig-eligibility');
    expect(spec).toMatchObject({ metric: 'exactMatch', min: 1 });
    expect(spec.cases.length).toBeGreaterThanOrEqual(240);
    const reasons = new Set(spec.cases.flatMap((c) => (c.expected as { reasons: string[] }).reasons.map((r) => r.replace(/:.*$/, ''))));
    for (const r of ['closed', 'role-filter', 'budget-preset', 'company', 'location-outside-india', 'hours-over-cap', 'overlap-outside-ist-window', 'exclusive', 'budget-below-floor', 'rate-below-floor', 'location-unclear', 'hours-unclear', 'rate-unclear', 'exclusivity-unclear']) expect(reasons.has(r), r).toBe(true);
    expect(new Set(spec.cases.map((c) => (c.expected as { verdict: string }).verdict))).toEqual(new Set(['eligible', 'rejected', 'review']));
    const gbp = spec.cases.find((c) => c.id === 'rate-gbp-30-31')!;
    expect(gbp.expected).toMatchObject({ reasons: ['rate-below-floor:39.5'] });
    const r = await runEval(spec, { providers, policy: PRODUCT_POLICY_V1 });
    expect(r.failures).toEqual([]);
    expect(r).toMatchObject({ score: 1, pass: true });
  });

  it('gig-risk: at least 30 cases, every flag present, gate 1.0', async () => {
    const spec = specs.find((s) => s.name === 'gig-risk')!;
    expect(spec.agent.contract.id).toBe('gig-risk');
    expect(spec).toMatchObject({ metric: 'exactMatch', min: 1 });
    expect(spec.cases.length).toBeGreaterThanOrEqual(30);
    const flags = new Set(spec.cases.flatMap((c) => (c.expected as { flags: string[] }).flags));
    for (const f of ['payment-unverified', 'off-platform', 'unusual-payment', 'upfront-fee', 'unpaid-test', 'thin-brief']) expect(flags.has(f), f).toBe(true);
    expect(flags.has('duplicate-text')).toBe(false);
    expect(spec.cases.filter((c) => (c.expected as { flags: string[] }).flags.length === 0).length).toBeGreaterThanOrEqual(8);
    const r = await runEval(spec, { providers, policy: PRODUCT_POLICY_V1 });
    expect(r.failures).toEqual([]);
    expect(r).toMatchObject({ score: 1, pass: true });
  });

  it('datasets carry no forbidden fixture term', () => {
    for (const f of ['gig-eligibility.jsonl', 'gig-eligibility-reviewed.jsonl', 'gig-risk.jsonl']) assertNoForbidden(readFileSync(join(root, 'evals/datasets', f), 'utf8'), full.naming);
  });
});
