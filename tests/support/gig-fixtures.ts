import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideGig } from '../../src/app/freelance/gig-eligibility.js';
import { normalizeGig } from '../../src/app/freelance/gig-normalizer.js';
import { riskFlags } from '../../src/app/freelance/gig-risk.js';
import { gigScorer } from '../../src/app/freelance/gig-scorer.js';
import { gigDedupeKey, gigKey } from '../../src/app/freelance/keys.js';
import { rateOf } from '../../src/app/freelance/rate.js';
import { freelancerUrl, srcFreelancer } from '../../src/app/freelance/sources/freelancer.js';
import type { Gig, RawGig, ScoredGig } from '../../src/app/freelance/types.js';
import { loadPack } from '../../src/app/pack/load.js';
import type { Pack } from '../../src/app/pack/schema.js';
import { freezePack, issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';

/** Freelance writing fixtures (Task 8): the recorded Freelancer projects through the real freelance chain, on the fictional pack. */

export const root = join(import.meta.dirname, '../..');
export const packDir = join(root, 'tests/fixtures/pack');
const NOW = '2026-10-12T00:00:00Z';

export function fixturePack(dir = packDir): { full: Pack; pub: Omit<Pack, 'contact' | 'answers'> } {
  const { pack: full } = loadPack(dir);
  const { contact: _c, answers: _a, ...pub } = full;
  return { full, pub };
}

async function rawsOf(query: string): Promise<readonly RawGig[]> {
  const file = join(root, 'tests/fixtures/freelance/freelancer', `${query}.json`);
  const ctx = issueContext({
    contract: srcFreelancer.contract,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: { fetch: async (url: string) => (url === freelancerUrl(query) ? { status: 200, text: async () => readFileSync(file, 'utf8') } : { status: 404, text: async () => '' }) },
    clock: fixedClock(NOW),
    signal: AbortSignal.timeout(10_000),
  });
  return srcFreelancer.run({ platform: 'freelancer', query, runDate: '2026-10-12', half: 'am' }, ctx);
}

/** Every scored (not rejected) gig of the recorded Freelancer fixtures, in fixture order, deduplicated by gigKey. */
export async function fixtureScoredGigs(pack: Omit<Pack, 'contact' | 'answers'> = fixturePack().pub): Promise<ScoredGig[]> {
  const frozen = freezePack(pack);
  const out: ScoredGig[] = [];
  const seen = new Set<string>();
  for (const q of ['java', 'golang', 'typescript']) {
    for (const raw of await rawsOf(q)) {
      const gig = normalizeGig(raw);
      if (seen.has(gig.gigKey)) continue;
      seen.add(gig.gigKey);
      out.push(...(await score(gig, frozen, pack)));
    }
  }
  return out;
}

async function score(gig: Gig, frozen: unknown, pack: Omit<Pack, 'contact' | 'answers'>): Promise<readonly ScoredGig[]> {
  const rate = rateOf(gig, pack.fx, pack.freelance.maxHoursPerWeek);
  const d = decideGig({ gig, rate }, pack as unknown as Parameters<typeof decideGig>[1]);
  const verdict = { rated: { gig, rate }, ...d };
  const risked = { verdict, flags: riskFlags(verdict) };
  const ctx = issueContext({
    contract: gigScorer.contract,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: { fetch: async () => ({ status: 404, text: async () => '' }) },
    clock: fixedClock(NOW),
    signal: AbortSignal.timeout(10_000),
    pack: frozen,
  });
  return gigScorer.run(risked, ctx);
}

/** A hand-made scored gig (eligible, rate unknown), for the edge cases the fixtures lack. */
export function scoredGig(over: Partial<Gig> = {}): ScoredGig {
  const n = over.sourceId ?? '1';
  const gig: Gig = {
    gigKey: gigKey('freelancer', n),
    dedupeKey: gigDedupeKey(null, `T${n}`),
    platform: 'freelancer',
    sourceId: n,
    url: `https://www.freelancer.com/projects/x-${n}`,
    title: 'Backend developer for a payments API',
    description:
      'We are a small fintech team. We need a backend developer to build event-driven payment services in Java with Kafka. ' +
      'The services run on AWS and store data in PostgreSQL. Experience with Scala is a plus. Please share similar work.',
    client: { name: null, country: null, paymentVerified: true, hireRate: null, spendUsd: null, reviews: null, since: null },
    kind: 'gig',
    budget: { type: 'fixed', min: 750, max: 1500, currency: 'USD', usdPerUnit: 1 },
    hoursPerWeek: { min: null, max: null, source: null },
    duration: { weeks: null, text: null },
    timezone: { required: null, overlapText: null },
    location: { countries: [], worldwide: true, text: null },
    skills: ['Java', 'Kafka'],
    postedAt: '2026-10-08T10:00:00Z',
    bids: 4,
    ...over,
  };
  return {
    risked: { verdict: { rated: { gig, rate: { minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, fxSource: null, budgetUsd: 1500 } }, verdict: 'eligible', reasons: [], notes: [] }, flags: [] },
    fit: 60,
    breakdown: {},
    list: gig.kind === 'contract' ? 'contracts' : 'gigs',
  };
}
