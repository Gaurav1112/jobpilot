import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideGig, type GigPack } from '../../../src/app/freelance/gig-eligibility.js';
import { normalizeGig } from '../../../src/app/freelance/gig-normalizer.js';
import { rateOf } from '../../../src/app/freelance/rate.js';
import type { Gig, RawGig, ScoredGig } from '../../../src/app/freelance/types.js';
import { scoreGig, STACK_PENALTY } from '../../../src/app/freelance/gig-scorer.js';
import { rankGigs } from '../../../src/app/freelance/rank.js';
import { networksList } from '../../../src/app/freelance/networks-command.js';
import { catalogueEntry, NETWORK_CATALOGUE, orderedNetworkIds } from '../../../src/app/freelance/network-catalogue.js';
import { freelancerUrl } from '../../../src/app/freelance/sources/freelancer.js';
import { packOf } from '../../../src/app/agents/scorer-lexicon.js';
import { FREELANCE_KEYWORDS, FreelanceFile } from '../../../src/app/pack/freelance-schema.js';
import { loadPack } from '../../../src/app/pack/load.js';
import { breakdownText, rateLabel, type GigRate } from '../../../src/app/web/copy.js';

/**
 * freelance-boost (2026-10-14): the quick fixes and the one approved rule change, each against a fictional fixture
 * shaped like the live example the research found (`.superpowers/sdd/freelance-research.md` A3, A7). No real posting,
 * company or pay floor is used; the floor here is the fixture pack's.
 */

const root = join(import.meta.dirname, '../../..');
const { pack: full } = loadPack(join(root, 'tests/fixtures/pack'));
const gigPack: GigPack = { filters: full.filters, naming: full.naming, platformRules: full.platformRules, freelance: full.freelance };
const FLOOR = full.freelance.rateFloorUsdHour;

const hn = (text: string, id = '9001'): RawGig => ({ platform: 'hn-hiring', sourceId: id, raw: { id: Number(id), text, created_at_i: 1791700000 } });
const decide = (g: Gig) => decideGig({ gig: g, rate: rateOf(g, full.fx, full.freelance.maxHoursPerWeek) }, gigPack);

describe('hours ranges (research A7.1): en dash, em dash and "to" are ranges', () => {
  it.each([
    ['Expected workload is 10–39 hours per week.', 10, 39],
    ['Expected workload is 10—39 hours per week.', 10, 39],
    ['Expected workload is 10 to 39 hours per week.', 10, 39],
    ['Expected workload is 10-39 hours per week.', 10, 39],
    ['About 10–20 hrs/week, async.', 10, 20],
  ])('%s', (text, min, max) => {
    expect(normalizeGig(hn(`Example Labs | Python engineer | REMOTE | Contract\n${text}`)).hoursPerWeek).toEqual({ min, max, source: 'text' });
  });

  it('"ranges from $80–$100 USD per hour" is a stated range (a "from" before a closed range is not a lower bound)', () => {
    const g = normalizeGig(boards({ descriptionText: '- Compensation ranges from $80–$100 USD per hour.\n- Expected workload is 10–39 hours per week, depending on project needs.' }));
    expect(g.budget).toEqual({ type: 'hourly', min: 80, max: 100, currency: 'USD', usdPerUnit: null, from: 'description' });
    expect(g.hoursPerWeek).toEqual({ min: 10, max: 39, source: 'text' });
    expect(decide(g).verdict).not.toBe('rejected');
    expect(normalizeGig(boards({ descriptionText: 'Pay from $80/hr.' })).budget.type).toBe('unknown');
  });

  it('a 10–39 h/week contract is not rejected as over the cap (its minimum is 10)', () => {
    const g = normalizeGig(hn('Example Labs | Senior Python Developer | REMOTE (worldwide) | Contract\nWe pay $80-100/hr. Expected workload is 10–39 hours per week.'));
    const d = decide(g);
    expect(d.reasons).not.toContain('hours-over-cap');
    expect(d.verdict).not.toBe('rejected');
  });

  it('a stated 30 to 40 hours per week requirement still rejects', () => {
    const g = normalizeGig(hn('Example Labs | Go engineer | REMOTE (worldwide) | Contract\nWe pay $80/hr. You must commit 30 to 40 hours per week.'));
    expect(g.hoursPerWeek).toEqual({ min: 30, max: 40, source: 'text' });
    expect(decide(g)).toMatchObject({ verdict: 'rejected', reasons: ['hours-over-cap'] });
  });
});


const posting = (over: Record<string, unknown> = {}) => ({
  jobKey: '0a0b0c0d0e0f1011',
  dedupeKey: '1011121314151617',
  source: 'ashby',
  sourceId: 'ex-1',
  company: 'Example Talent',
  slug: 'example-talent',
  ats: 'ashby',
  title: 'Go Engineer, AI Code Reviewer',
  url: 'https://jobs.example.com/ex-1',
  locationText: 'Remote (worldwide)',
  remote: { structured: 'remote', countries: ['worldwide'], signals: ['location:remote'] },
  employmentType: 'Contract',
  descriptionText: 'Review code written by AI agents. Pay: $150-200/hr. 10-20 hours per week, async.',
  postedAt: '2026-10-10',
  comp: null,
  yearsRequired: null,
  ...over,
});
const boards = (over: Record<string, unknown> = {}): RawGig => ({ platform: 'boards', sourceId: '0a0b0c0d0e0f1011', raw: posting(over) });

describe('boards pay (research A7.2): read from the description with the same rule as the other text sources', () => {
  it('a stated hourly rate is read and labelled as coming from the posting text', () => {
    const g = normalizeGig(boards());
    expect(g.budget).toEqual({ type: 'hourly', min: 150, max: 200, currency: 'USD', usdPerUnit: null, from: 'description' });
    expect(rateOf(g, full.fx, 20)).toMatchObject({ minUsdH: 150, maxUsdH: 200, method: 'stated' });
  });

  it('a boards contract at a stated rate above the floor, 10-20 h/week, worldwide, is eligible', () => {
    expect(decide(normalizeGig(boards()))).toEqual({ verdict: 'eligible', reasons: [], notes: [] });
  });

  it('a stated rate below the floor rejects it, with the rate', () => {
    const g = normalizeGig(boards({ descriptionText: `Pay: $${FLOOR - 5}/hr. 10 hours per week.` }));
    expect(decide(g)).toMatchObject({ verdict: 'rejected', reasons: [`rate-below-floor:${FLOOR - 5}`] });
  });

  it('an annual salary or no pay keeps the budget unknown (no pay -> review, as before)', () => {
    for (const text of ['Salary: $120,000 - $150,000 a year. Contract.', 'Contract role, details on the call.']) {
      const g = normalizeGig(boards({ descriptionText: text }));
      expect(g.budget).toEqual({ type: 'unknown', min: null, max: null, currency: null, usdPerUnit: null });
      expect(decide(g).reasons).toContain('rate-unclear');
    }
  });
});

describe('"up to $X/hr" is a stated ceiling (research A7.2): it can fail the floor, never pass it alone', () => {
  it.each([
    ['Backend Engineer - AI Coding Agent (Upto $130/hr)', 130],
    ['Backend Engineer - AI Coding Agent', 130, 'Pay is up to $130 per hour.'],
    ['Backend Engineer (upto $90/hour)', 90],
  ])('%s', (title, max, text = 'Remote, worldwide. 10-20 hours per week.') => {
    const g = normalizeGig(boards({ title, descriptionText: text }));
    expect(g.budget).toEqual({ type: 'hourly', min: null, max, currency: 'USD', usdPerUnit: null, from: 'description', bound: 'ceiling' });
    expect(rateOf(g, full.fx, 20)).toEqual({ minUsdH: null, maxUsdH: max, method: 'stated-ceiling', fxDate: null, fxSource: null, budgetUsd: null });
  });

  it('a ceiling at or above the floor is review `ceiling-only`, never eligible on its own', () => {
    const g = normalizeGig(boards({ title: 'Backend Engineer (Upto $130/hr)', descriptionText: 'Remote, worldwide. 10-20 hours per week.' }));
    const d = decide(g);
    expect(d.verdict).toBe('review');
    expect(d.reasons).toEqual(['ceiling-only']);
    expect(d.notes).toContain('pay is a stated ceiling only (up to $130/h) - verify');
  });

  it('a ceiling below the floor rejects', () => {
    const g = normalizeGig(boards({ title: `Backend Engineer (Upto $${FLOOR - 10}/hr)`, descriptionText: 'Remote, worldwide. 10 hours per week.' }));
    expect(decide(g)).toMatchObject({ verdict: 'rejected', reasons: [`rate-below-floor:${FLOOR - 10}`] });
  });

  it('another rule still decides: a ceiling above the floor with stated full-time hours rejects on hours', () => {
    const g = normalizeGig(boards({ title: 'Backend Engineer (Upto $130/hr)', descriptionText: 'Remote, worldwide. You must commit 40 hours per week.' }));
    expect(decide(g)).toMatchObject({ verdict: 'rejected', reasons: ['hours-over-cap'] });
  });

  it('"from $X/hr" and "about $X/hr" are still no rate', () => {
    for (const text of ['Pay from $90/hr.', 'Pay about $90/hr.', 'Starting at $90/hr.']) {
      expect(normalizeGig(boards({ descriptionText: text })).budget.type).toBe('unknown');
    }
  });

  it('a ceiling in the title and a stated range with the same top in the text: the range wins (it says more)', () => {
    const g = normalizeGig(boards({ title: 'Full Stack Engineer - Fully Remote | Upto $130/hr', descriptionText: 'Type: Contract\nCompensation: $80–$130/hour\nLocation: Remote' }));
    expect(g.budget).toEqual({ type: 'hourly', min: 80, max: 130, currency: 'USD', usdPerUnit: null, from: 'description' });
  });

  it('a ceiling and a different plain rate in one text are ambiguous: unknown', () => {
    expect(normalizeGig(boards({ title: 'Backend Engineer (Upto $130/hr)', descriptionText: 'We pay $60/hr.' })).budget.type).toBe('unknown');
  });
});

describe('the dashboard says where pay came from and that a ceiling is a ceiling', () => {
  const r = (o: Partial<GigRate>): GigRate => ({ minUsdH: null, maxUsdH: null, method: 'stated', fxDate: null, fxSource: null, budgetUsd: null, ...o });
  const basis = (budgetFrom?: string) => ({ description: '', weeks: null, hours: null, budgetType: 'hourly', ...(budgetFrom === undefined ? {} : { budgetFrom }) });
  it('a stated rate read from the posting text says so; a platform pay field says so; the old sources are unchanged', () => {
    expect(rateLabel(r({ minUsdH: 150, maxUsdH: 200 }), basis('description'))).toBe('$150–200/h stated in the posting text');
    expect(rateLabel(r({ minUsdH: 50, maxUsdH: 100 }), basis('platform'))).toBe('$50–100/h stated (pay field)');
    expect(rateLabel(r({ minUsdH: 50, maxUsdH: 50 }), basis())).toBe('$50/h stated');
  });
  it('a ceiling reads "up to"', () => {
    expect(rateLabel(r({ maxUsdH: 130, method: 'stated-ceiling' }), basis('description'))).toBe('up to $130/h (stated ceiling only) in the posting text');
  });
});

const fl = (o: { min: number; max: number; currency?: string; rate?: number; text?: string; id?: string }): RawGig => ({
  platform: 'freelancer',
  sourceId: o.id ?? '7001',
  raw: {
    title: 'Backend API in Go', description: o.text ?? 'Build and maintain a REST API in Go with PostgreSQL.', preview_description: null, type: 'hourly',
    budget: { minimum: o.min, maximum: o.max }, currency: { code: o.currency ?? 'USD', exchange_rate: o.rate ?? 1 }, time_submitted: 1791700000,
    seo_url: `go/backend-api-${o.id ?? '7001'}`, jobs: [{ name: 'Golang' }, { name: 'PostgreSQL' }], local: false, bid_stats: { bid_count: 4 }, owner_id: null, hourly_project_info: null,
  },
});

describe('approved rule change (2026-10-14): Freelancer hourly at or above the floor with no stated hours goes to Contracts', () => {
  it('eligible, with the note "hours not stated; you set them"', () => {
    const d = decide(normalizeGig(fl({ min: FLOOR + 5, max: FLOOR + 20 })));
    expect(d).toEqual({ verdict: 'eligible', reasons: [], notes: ['hours not stated; you set them'] });
  });

  it('decided on the converted USD rate, never the raw figure: INR 4,000/h at the fixture table is about $48/h, INR 1,250/h about $15/h', () => {
    expect(decide(normalizeGig(fl({ min: 3000, max: 4000, currency: 'INR', rate: 0.012 }))).verdict).toBe('eligible');
    expect(decide(normalizeGig(fl({ min: 750, max: 1250, currency: 'INR', rate: 0.012 })))).toMatchObject({ verdict: 'rejected' });
  });

  it('below the floor the hours stay unknown: a negotiable low rate is review on pay AND hours', () => {
    const d = decide(normalizeGig(fl({ min: FLOOR - 20, max: FLOOR - 5, text: 'Build a REST API in Go. The rate is negotiable.' })));
    expect(d.verdict).toBe('review');
    expect(d.reasons).toEqual(['hours-unclear', 'rate-unclear']);
    expect(d.notes).not.toContain('hours not stated; you set them');
  });

  it('below the floor it is still rejected on pay', () => {
    expect(decide(normalizeGig(fl({ min: FLOOR - 20, max: FLOOR - 5 })))).toMatchObject({ verdict: 'rejected', reasons: [`rate-below-floor:${FLOOR - 5}`] });
  });

  it('stated full-time work still rejects; a hedged full-time mention stays in review', () => {
    expect(decide(normalizeGig(fl({ min: 60, max: 80, text: 'We need a full-time developer for this API.' })))).toMatchObject({ verdict: 'rejected', reasons: ['hours-over-cap'] });
    expect(decide(normalizeGig(fl({ min: 60, max: 80, text: 'Looking for a full-time or part-time developer for this API.' }))).verdict).toBe('review');
  });

  it('ambiguous per-week figures are stated hours, not "not stated": they stay in review', () => {
    const d = decide(normalizeGig(fl({ min: 60, max: 80, text: 'About 5-10 hours per week now, maybe 30 hours per week later.' })));
    expect(d).toMatchObject({ verdict: 'review', reasons: ['hours-unclear'] });
  });

  it('nothing else changes: a non-Freelancer contract with a stated rate and no hours stays in review', () => {
    const g = normalizeGig(boards({ descriptionText: 'Pay: $150/hr. Remote contract.' }));
    expect(decide(g)).toMatchObject({ verdict: 'review', reasons: ['hours-unclear'] });
  });
});

describe('Freelancer search terms and ranking (research A4, C2)', () => {
  it('default Freelancer queries are the backend/AI keywords, without the generic react and python', () => {
    const q = FreelanceFile.parse({}).platforms.freelancer.queries;
    expect(q).toEqual([...FREELANCE_KEYWORDS]);
    expect(q).toEqual(expect.arrayContaining(['backend', 'api development', 'java', 'spring boot', 'kafka', 'golang', 'microservices', 'aws', 'llm', 'ai agent', 'rag']));
    expect(q).not.toContain('react');
    expect(q).not.toContain('python');
    // A pack's list still replaces the defaults whole.
    expect(FreelanceFile.parse({ platforms: { freelancer: { queries: ['elixir'] } } }).platforms.freelancer.queries).toEqual(['elixir']);
  });

  it('the Freelancer request carries no rate filter: its min_hourly_rate works in each project\'s own currency, so the floor is ours, after FX', () => {
    expect(freelancerUrl('golang')).not.toMatch(/min_hourly_rate|min_price|max_price|min_avg/);
  });

  const scoring = packOf(full);
  const gigOf = (skills: string[], description = 'Build a small app.'): Gig => ({ ...normalizeGig(fl({ min: 50, max: 60, text: description })), skills });

  it('a Freelancer gig whose skill tags are all off-stack loses STACK_PENALTY, shown in the breakdown', () => {
    const on = scoreGig(gigOf(['Java', 'Spring Boot']), scoring);
    const off = scoreGig(gigOf(['WordPress', 'Shopify', 'Graphic Design']), scoring);
    expect(on.breakdown.some((b) => b.label === 'stack:off')).toBe(false);
    expect(off.breakdown).toContainEqual({ label: 'stack:off', points: -STACK_PENALTY });
    expect(breakdownText('stack:off', (k) => k)).toBe('Every skill tag is off your stack');
    const plain = scoreGig(gigOf([]), scoring).fit;
    expect(off.fit).toBe(Math.max(0, plain - STACK_PENALTY));
  });

  it('one on-stack tag among off-stack ones is enough; no tags, or another platform, is no penalty', () => {
    expect(scoreGig(gigOf(['WordPress', 'Golang']), scoring).breakdown.some((b) => b.label === 'stack:off')).toBe(false);
    expect(scoreGig(gigOf([]), scoring).breakdown.some((b) => b.label === 'stack:off')).toBe(false);
    expect(scoreGig({ ...gigOf(['WordPress']), platform: 'remotive' }, scoring).breakdown.some((b) => b.label === 'stack:off')).toBe(false);
  });

  it('lists sort by rate × fit (red flags last, unknown rate after every known one)', () => {
    const sc = (id: string, maxUsdH: number | null, fit: number, flags: string[] = []): ScoredGig => {
      const gig = { ...normalizeGig(fl({ min: 50, max: 60, id })), sourceId: id };
      return { risked: { verdict: { rated: { gig, rate: { minUsdH: null, maxUsdH, method: 'stated', fxDate: null, fxSource: null, budgetUsd: null } }, verdict: 'eligible', reasons: [], notes: [] }, flags: flags.map((f) => ({ id: f, detail: '' })) }, fit, breakdown: {}, list: 'contracts' };
    };
    const rows = [sc('a', 100, 46), sc('b', 80, 70), sc('c', null, 90), sc('d', 200, 50, ['off-platform']), sc('e', 60, 75)];
    // b 5600, a 4600, e 4500, then c (rate unknown), then the red-flagged d
    expect(rankGigs(rows, 45).contracts.map((r) => r.risked.verdict.rated.gig.sourceId)).toEqual(['b', 'a', 'e', 'c', 'd']);
  });
});

describe('the networks catalogue (research C3, B2)', () => {
  it('adds micro1, Mercor, Alignerr, Proxify and A.Team; marks Lemon.io not open to India, citing the research', () => {
    const ids = NETWORK_CATALOGUE.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['micro1', 'mercor', 'alignerr', 'proxify', 'a-team']) expect(ids).toContain(id);
    const lemon = catalogueEntry('lemon');
    expect(lemon).toMatchObject({ india: 'not-open', order: null });
    expect(lemon?.indiaNote).toMatch(/Philippines and Indonesia.*nodesk\.co.*lemon\.io/);
    for (const n of NETWORK_CATALOGUE) {
      expect(new URL(n.applyUrl).protocol).toBe('https:');
      for (const v of [n.name, n.indiaNote, n.rates, n.hours, n.process]) expect(v.trim()).not.toBe('');
    }
  });

  it('the recommended order: micro1, Mercor, Alignerr, then Arc, Braintrust, Toptal, Proxify; own files after the ordered ones; not-open last', () => {
    const order = orderedNetworkIds([{ id: 'zeta-net', name: 'Zeta' }, { id: 'arc', name: 'Arc' }, { id: 'alpha-net', name: 'Alpha' }]);
    expect(order.slice(0, 7)).toEqual(['micro1', 'mercor', 'alignerr', 'arc', 'braintrust', 'toptal', 'proxify']);
    expect(order.slice(-3)).toEqual(['alpha-net', 'zeta-net', 'lemon']);
    expect(order.filter((x) => x === 'arc')).toHaveLength(1);
  });
});

describe('networks list (CLI) says when a network is not open to India', () => {
  it('lemon is marked, arc is not', () => {
    const lines = networksList({ pack: full });
    expect(lines.find((l) => l.startsWith('lemon '))).toMatch(/not open to India$/);
    expect(lines.find((l) => l.startsWith('arc '))).not.toMatch(/India/);
  });
});
