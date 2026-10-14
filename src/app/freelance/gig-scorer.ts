import { defineAgent } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { packOf, scoreText } from '../agents/scorer-lexicon.js';
import { isoMs } from './rank.js';
import { RiskedGig, ScoredGig, type Gig } from './types.js';

/**
 * Gig scorer: the v1 lexicon formula (`scoreText`, the same code the daily scorer runs) on a gig, plus three shown
 * numbers and the list the gig belongs to. A rejected gig ends at eligibility and yields no output, like v1.
 *
 * - `fit`: the formula with the gig's title for the title rows and `description + skills` for the skill groups. A gig has no years requirement.
 * - breakdown rows: the formula's own rows (`base`, `title:*`, `strong:*`, `medium:*`, `gap:*`), then
 *   - `client` (always): +5 each for payment verified, hire rate at least 0.5, spend at least 10,000 USD and at least 5 reviews; an unknown field adds 0. Shown only, never part of `fit`.
 *   - `fresh`: hours from `postedAt` to the run's clock (`ctx.clock`), floored at 0, to one decimal. Absent when `postedAt` is null (a missing value stays missing; first-seen is the projector's concept).
 *   - `bids`: the platform's bid count, absent when unknown.
 * - `list`: `review` when the verdict is review (any kind); `contracts` for an eligible contract; `gigs` for an eligible gig; any other kind (bounty, network-alert) that is eligible goes to `review`.
 */

const CLIENT_CAP = 20;

function clientPoints(c: Gig['client']): number {
  const points =
    (c.paymentVerified === true ? 5 : 0) +
    (c.hireRate !== null && c.hireRate >= 0.5 ? 5 : 0) +
    (c.spendUsd !== null && c.spendUsd >= 10_000 ? 5 : 0) +
    (c.reviews !== null && c.reviews >= 5 ? 5 : 0);
  return Math.min(CLIENT_CAP, points);
}

function listOf(verdict: 'eligible' | 'review', kind: Gig['kind']): ScoredGig['list'] {
  if (verdict === 'review') return 'review';
  return kind === 'contract' ? 'contracts' : kind === 'gig' ? 'gigs' : 'review';
}

export const gigScorerContract = defineContract({
  id: 'gig-scorer',
  version: '1.1.0',
  description: 'Scores one gig against the lexicon',
  skills: ['gig-scoring'],
  team: 'evaluation',
  kind: 'deterministic',
  consumes: RiskedGig,
  produces: ScoredGig,
  capabilities: { pack: true },
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
});

export const gigScorer = defineAgent(gigScorerContract, async (risked, ctx) => {
  const v = risked.verdict;
  if (v.verdict === 'rejected') return [];
  const pack = packOf(ctx.pack);
  const { gig } = v.rated;
  const text = gig.skills.length === 0 ? gig.description : `${gig.description}\n${gig.skills.join(', ')}`;
  const scored = scoreText(gig.title, text, null, pack);
  const breakdown: Record<string, number> = {};
  for (const row of scored.breakdown) breakdown[row.label] = row.points;
  breakdown['client'] = clientPoints(gig.client);
  const posted = isoMs(gig.postedAt);
  if (posted !== null) {
    const hours = Math.max(0, (Date.parse(ctx.clock.now()) - posted) / 3_600_000);
    breakdown['fresh'] = Math.round(hours * 10) / 10;
  }
  if (gig.bids !== null) breakdown['bids'] = gig.bids;
  return [{ risked, fit: scored.score, breakdown, list: listOf(v.verdict, gig.kind) }];
});
