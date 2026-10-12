import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gigScorer, gigScorerContract } from '../../../src/app/freelance/gig-scorer.js';
import { gigDedupeKey, gigKey } from '../../../src/app/freelance/keys.js';
import { rankGigs } from '../../../src/app/freelance/rank.js';
import { Gig, RiskedGig, ScoredGig } from '../../../src/app/freelance/types.js';
import { appEvalSpecs } from '../../../src/app/evals.js';
import { loadPack } from '../../../src/app/pack/load.js';
import { runEval } from '../../../src/evals/runner.js';
import type { Agent } from '../../../src/kernel/agent.js';
import { freezePack, issueContext } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';

const root = join(import.meta.dirname, '../../..');
const { pack: full } = loadPack(join(root, 'tests/fixtures/pack'));
const { contact: _c, answers: _a, ...publicPack } = full;
const pack = freezePack(publicPack);
const NOW = '2026-10-12T12:00:00Z';

const gigOf = (n: number, over: Partial<Gig> = {}): Gig => ({
  gigKey: gigKey('freelancer', String(n)),
  dedupeKey: gigDedupeKey(null, `T${n}`),
  platform: 'freelancer',
  sourceId: String(n),
  url: `https://x.test/${n}`,
  title: 'Developer',
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
function risked(n: number, over: Partial<Gig> = {}, o: { verdict?: 'eligible' | 'rejected' | 'review'; maxUsdH?: number | null; flags?: string[] } = {}): RiskedGig {
  return {
    verdict: {
      rated: { gig: gigOf(n, over), rate: { minUsdH: null, maxUsdH: o.maxUsdH === undefined ? 60 : o.maxUsdH, method: 'stated', fxDate: null, fxSource: null, budgetUsd: null } },
      verdict: o.verdict ?? 'eligible',
      reasons: [],
      notes: [],
    },
    flags: (o.flags ?? []).map((id) => ({ id, detail: 'x' })),
  };
}
async function score(r: RiskedGig, clock = NOW): Promise<readonly ScoredGig[]> {
  const agent: Agent<RiskedGig, ScoredGig> = gigScorer;
  const ctx = issueContext({ contract: agent.contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => { throw new Error('offline'); } }, clock: fixedClock(clock), signal: new AbortController().signal, pack });
  return agent.run(r, ctx);
}

describe('gig-scorer contract', () => {
  it('is deterministic, evaluation-team, pack-reading, no llm, no effect, one skill', () => {
    const c = gigScorerContract;
    expect(c).toMatchObject({ id: 'gig-scorer', consumes: RiskedGig, produces: ScoredGig, kind: 'deterministic', team: 'evaluation' });
    expect(c.capabilities.pack).toBe(true);
    expect(c.capabilities.llm).toBeFalsy();
    expect('effect' in c && c.effect !== undefined).toBe(false);
    expect(c.skills).toHaveLength(1);
    expect(c.description.length).toBeGreaterThanOrEqual(10);
    expect(c.description).not.toMatch(/\band\b/i);
  });
});

describe('gig-scorer', () => {
  it('fit is the lexicon formula on title, description and skills (30 + lead 10 + java title 10 + kafka 4 + docker 1.5 = 55.5, rounds to 56)', async () => {
    const [s] = await score(risked(1, { title: 'Lead Java Developer', description: 'Build services with Kafka.', skills: ['Docker'] }));
    expect(s!.fit).toBe(56);
    expect(s!.breakdown).toMatchObject({ base: 30, 'title:seniority': 10, 'title:family': 10, 'strong:kafka': 4, 'medium:docker': 1.5 });
  });

  it('a rejected gig yields no output; review and eligible yield one', async () => {
    expect(await score(risked(1, {}, { verdict: 'rejected' }))).toEqual([]);
    expect(await score(risked(1, {}, { verdict: 'review' }))).toHaveLength(1);
    expect(await score(risked(1))).toHaveLength(1);
  });

  it('list: review wins whatever the kind; contract and gig go to their lists; bounty and network-alert eligible go to review', async () => {
    const list = async (kind: Gig['kind'], verdict: 'eligible' | 'review') => (await score(risked(1, { kind }, { verdict })))[0]!.list;
    expect(await list('contract', 'eligible')).toBe('contracts');
    expect(await list('gig', 'eligible')).toBe('gigs');
    expect(await list('bounty', 'eligible')).toBe('review');
    expect(await list('network-alert', 'eligible')).toBe('review');
    for (const k of ['contract', 'gig', 'bounty', 'network-alert'] as const) expect(await list(k, 'review')).toBe('review');
  });

  it('client points are shown, never added to fit; unknown adds 0; the cap is 20', async () => {
    const known = { name: null, country: null, paymentVerified: true, hireRate: 0.5, spendUsd: 10_000, reviews: 5, since: null };
    const [a] = await score(risked(1, { client: known }));
    const [b] = await score(risked(1));
    expect(a!.breakdown['client']).toBe(20);
    expect(b!.breakdown['client']).toBe(0);
    expect(a!.fit).toBe(b!.fit);
    const [c] = await score(risked(1, { client: { ...known, hireRate: 0.49, spendUsd: 9_999 } }));
    expect(c!.breakdown['client']).toBe(10);
  });

  it('fresh is hours from postedAt to the clock, floored at 0; null stays absent; bids only when known', async () => {
    const [a] = await score(risked(1, { postedAt: '2026-10-12T06:00:00Z', bids: 7 }));
    expect(a!.breakdown['fresh']).toBe(6);
    expect(a!.breakdown['bids']).toBe(7);
    const [b] = await score(risked(1, { postedAt: '2026-10-13T00:00:00Z' }));
    expect(b!.breakdown['fresh']).toBe(0);
    const [c] = await score(risked(1));
    expect('fresh' in c!.breakdown).toBe(false);
    expect('bids' in c!.breakdown).toBe(false);
  });

  it('is deterministic for a given clock', async () => {
    const r = risked(1, { title: 'Senior Java', postedAt: '2026-10-12' });
    expect(await score(r)).toEqual(await score(r));
  });
});

describe('rankGigs', () => {
  const sc = (n: number, o: { fit?: number; maxUsdH?: number | null; flags?: string[]; postedAt?: string | null; kind?: Gig['kind']; verdict?: 'eligible' | 'review' }): ScoredGig => {
    const kind = o.kind ?? 'contract';
    const verdict = o.verdict ?? 'eligible';
    return {
      risked: risked(n, { kind, postedAt: o.postedAt ?? null }, { verdict, maxUsdH: o.maxUsdH === undefined ? 60 : o.maxUsdH, flags: o.flags ?? [] }),
      fit: o.fit ?? 70,
      breakdown: {},
      list: verdict === 'review' ? 'review' : kind === 'gig' ? 'gigs' : 'contracts',
    };
  };
  const keys = (rows: ScoredGig[]) => rows.map((r) => r.risked.verdict.rated.gig.sourceId);

  it('orders by red flag, rate, fit, postedAt, then gigKey', () => {
    const rows = [
      sc(1, { maxUsdH: 90, flags: ['off-platform'] }),
      sc(2, { maxUsdH: 50 }),
      sc(3, { maxUsdH: null }),
      sc(4, { maxUsdH: 80, fit: 61 }),
      sc(5, { maxUsdH: 80, fit: 75 }),
      sc(6, { maxUsdH: 80, fit: 75, postedAt: '2026-10-11' }),
      sc(7, { maxUsdH: 80, fit: 75, postedAt: '2026-10-12' }),
    ];
    // 7 (newest), 6, 5 (postedAt null last) then 4 (lower fit), 2, 3 (null rate), then the red-flagged 1
    expect(keys(rankGigs(rows).contracts)).toEqual(['7', '6', '5', '4', '2', '3', '1']);
  });

  it('a red flag of any of the three kinds is never first, but other flags do not demote', () => {
    for (const f of ['off-platform', 'unusual-payment', 'upfront-fee']) {
      const out = rankGigs([sc(1, { maxUsdH: 500, flags: [f] }), sc(2, { maxUsdH: 41 })]).contracts;
      expect(keys(out)).toEqual(['2', '1']);
    }
    expect(keys(rankGigs([sc(1, { maxUsdH: 500, flags: ['thin-brief'] }), sc(2, { maxUsdH: 41 })]).contracts)).toEqual(['1', '2']);
  });

  it('ties break by gigKey ascending whatever the input order', () => {
    const a = sc(1, {});
    const b = sc(2, {});
    const c = sc(3, {});
    const want = [a, b, c].sort((x, y) => (x.risked.verdict.rated.gig.gigKey < y.risked.verdict.rated.gig.gigKey ? -1 : 1)).map((r) => r.risked.verdict.rated.gig.gigKey);
    for (const input of [[a, b, c], [c, b, a], [b, c, a]]) expect(rankGigs(input).contracts.map((r) => r.risked.verdict.rated.gig.gigKey)).toEqual(want);
  });

  it('drops fit < 60 from contracts and gigs, keeps it in review; 60 stays', () => {
    const out = rankGigs([sc(1, { fit: 59 }), sc(2, { fit: 60 }), sc(3, { fit: 10, kind: 'gig' }), sc(4, { fit: 10, verdict: 'review' }), sc(5, { fit: 90, kind: 'gig' })]);
    expect(keys(out.contracts)).toEqual(['2']);
    expect(keys(out.gigs)).toEqual(['5']);
    expect(keys(out.review)).toEqual(['4']);
  });

  it('the same gigKey twice keeps the first by this order', () => {
    const worse = sc(1, { maxUsdH: 50 });
    const better = { ...sc(1, { maxUsdH: 70 }) };
    const out = rankGigs([worse, better]).contracts;
    expect(out).toHaveLength(1);
    expect(out[0]!.risked.verdict.rated.rate.maxUsdH).toBe(70);
  });

  it('does not mutate its input and is stable across runs', () => {
    const rows = [sc(3, {}), sc(1, {}), sc(2, { maxUsdH: 99 })];
    const copy = structuredClone(rows);
    const once = rankGigs(rows);
    expect(rows).toEqual(copy);
    expect(rankGigs(rows)).toEqual(once);
  });
});

describe('golden eval', () => {
  it('gig-scorer: at least 30 cases, gate 1.0', async () => {
    const spec = appEvalSpecs(join(root, 'evals/datasets'), join(root, 'tests/fixtures/pack')).find((s) => s.agent.contract.id === 'gig-scorer')!;
    expect(spec).toMatchObject({ metric: 'exactMatch', min: 1 });
    expect(spec.cases.length).toBeGreaterThanOrEqual(30);
    const r = await runEval(spec, { providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, policy: PRODUCT_POLICY_V1 });
    expect(r.failures).toEqual([]);
    expect(r).toMatchObject({ score: 1, pass: true });
  });
});
