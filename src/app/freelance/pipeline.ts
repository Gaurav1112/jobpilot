import type { AnyAgent } from '../../kernel/agent.js';
import type { Policy } from '../../kernel/policy.js';
import type { Pipeline, Team } from '../../kernel/wiring.js';
import { SOURCE_TIMEOUT_MS } from '../agents/sources/common.js';
import type { FreelanceRules } from '../pack/freelance-schema.js';
import { gigEligibility } from './gig-eligibility.js';
import { gigNormalizer } from './gig-normalizer.js';
import { gigRisk } from './gig-risk.js';
import { gigScorer } from './gig-scorer.js';
import { GMAIL_LABEL, GMAIL_MAX_INTERVAL_MS, GMAIL_MAX_REQUESTS } from './mail/gmail.js';
import { rateNormalizer } from './rate.js';
import { gigSources } from './sources/index.js';
import { GigRequest, type Platform } from './types.js';
import { gigQa } from './writing/gig-qa.js';
import { gigRenderer } from './writing/gig-renderer.js';
import { proposalPlanner } from './writing/proposal-planner.js';

/**
 * The freelance pipeline (spec §3), `jobpilot-freelance@1.0.0`, run as `freelance-<IST date>-<am|pm>`:
 *
 *   GigRequest@1 ─► src-freelancer | src-remotive | src-hn | src-gig-mail | src-board-contracts ─► RawGig@1 ─► gig-normalizer ─► Gig@1
 *   ─► rate-normalizer ─► RatedGig@1 ─► gig-eligibility ─► GigVerdict@1 ─► gig-risk ─► RiskedGig@1 ─► gig-scorer
 *   ─► ScoredGig@1 ─► proposal-planner ─► GigDocsPlan@1 ─► gig-renderer ─► GigRendered@1 ─► gig-qa ─► GigQaReport@1
 *
 * Every source gets every request and answers only its own platform (an empty list otherwise). A rejected verdict ends
 * at the scorer (it returns nothing for it). Writing runs only for a scored gig with fit at or above
 * `freelance.fitFloor` in any list (contracts, gigs and review): proposal-planner returns nothing below it, as the
 * daily evidence-matcher does below `minFit`. Cross-query duplicates (one Freelancer project found by two queries)
 * travel as separate items with one gigKey; the projector keeps one row per gigKey.
 */
export const FREELANCE_PIPELINE = { id: 'jobpilot-freelance', version: '1.0.0' } as const;

const TEAM_ORDER = ['sourcing', 'understanding', 'evaluation', 'writing'] as const;

/** Every agent of the freelance run, in a stable order. */
export const freelanceAgents = (): AnyAgent[] => [...gigSources, gigNormalizer, rateNormalizer, gigEligibility, gigRisk, gigScorer, proposalPlanner, gigRenderer, gigQa];

/**
 * The wiring for `agents`. Teams follow each contract's `team`; a team breaker follows its most tolerant member (the
 * daily rule), except **sourcing**: its threshold is the sum of its members' thresholds. Each source answers one
 * platform, so a team breaker at the largest member's threshold would let one dead platform (5 failed Freelancer
 * queries) skip every other platform's fetch for the run. With the sum, only a member's own breaker stops it, and the
 * team breaker opens only when every source could have opened its own. (One team per source is not possible: the
 * wiring proof requires a member's team to be its contract's `team`, and the source contracts all say `sourcing`.)
 */
export function freelancePipeline(agents: readonly AnyAgent[]): Pipeline {
  const teams: Team[] = TEAM_ORDER.map((id) => {
    const members = agents.filter((a) => a.contract.team === id);
    const limits = members.map((a) => a.contract.breaker.consecutiveFailures);
    return {
      id,
      lead: `${id}-lead`,
      members: members.map((a) => a.contract.id),
      exitGuarantees: [],
      breaker: { consecutiveFailures: id === 'sourcing' ? Math.max(1, limits.reduce((a, b) => a + b, 0)) : Math.max(1, ...limits) },
    };
  }).filter((t) => t.members.length > 0);
  return {
    id: FREELANCE_PIPELINE.id,
    version: FREELANCE_PIPELINE.version,
    seed: { type: GigRequest, guarantees: [] },
    teams,
    edges: [
      ...gigSources.map((a) => ({ type: 'GigRequest@1', to: a.contract.id })),
      { type: 'RawGig@1', to: 'gig-normalizer' },
      { type: 'Gig@1', to: 'rate-normalizer' },
      { type: 'RatedGig@1', to: 'gig-eligibility' },
      { type: 'GigVerdict@1', to: 'gig-risk' },
      { type: 'RiskedGig@1', to: 'gig-scorer' },
      { type: 'ScoredGig@1', to: 'proposal-planner' },
      { type: 'GigDocsPlan@1', to: 'gig-renderer' },
      { type: 'GigRendered@1', to: 'gig-qa' },
    ],
  };
}

/** The platforms whose source fetches over the network (boards reads the store). */
export const FETCHING_PLATFORMS: readonly Platform[] = ['freelancer', 'remotive', 'hn-freelancer', 'hn-hiring', 'gmail'];

/** The platforms this build has a source agent for, and the agent that answers each. */
export const PLATFORM_AGENT: Readonly<Partial<Record<Platform, string>>> = {
  freelancer: 'src-freelancer',
  remotive: 'src-remotive',
  'hn-freelancer': 'src-hn',
  'hn-hiring': 'src-hn',
  gmail: 'src-gig-mail',
  boards: 'src-board-contracts',
};

/**
 * The run's seeds, all dated `runDate` and `half`, in this order: Freelancer one request per pack query (each query
 * once), Remotive one, HN two (hn-freelancer, hn-hiring), Gmail one (the label `jobpilot/gigs`, only when
 * `gmailConnected`: without a refresh token in the Keychain the source is disabled, not failed), then one `boards`
 * request per stored daily contract posting. Only enabled platforms with a source agent in this build are seeded
 * (upwork and reddit have none yet).
 */
export function freelanceSeeds(
  rules: Pick<FreelanceRules, 'platforms'>,
  runDate: string,
  half: 'am' | 'pm',
  boardPostings: readonly unknown[],
  o: { readonly gmailConnected?: boolean } = {},
): GigRequest[] {
  const on = (p: Platform) => rules.platforms[p].enabled;
  const seeds: GigRequest[] = [];
  const at = { runDate, half };
  if (on('freelancer')) for (const query of [...new Set(rules.platforms.freelancer.queries)]) seeds.push({ platform: 'freelancer', query, ...at });
  if (on('remotive')) seeds.push({ platform: 'remotive', query: '', ...at });
  if (on('hn-freelancer')) seeds.push({ platform: 'hn-freelancer', query: '', ...at });
  if (on('hn-hiring')) seeds.push({ platform: 'hn-hiring', query: '', ...at });
  if (on('gmail') && o.gmailConnected === true) seeds.push({ platform: 'gmail', query: GMAIL_LABEL, ...at });
  if (on('boards')) for (const item of boardPostings) seeds.push({ platform: 'boards', query: '', ...at, item });
  return seeds;
}

/**
 * M5 for the freelance sources: every fetching source but Gmail makes at most two requests to its one host per step
 * (HN: the thread search, then the thread), each sized for SOURCE_TIMEOUT_MS / 2 or more, so a host interval above
 * that would time a step out instead of pacing it. When Gmail is enabled, its step makes up to GMAIL_MAX_REQUESTS
 * paced requests within its timeout, so the interval may be at most GMAIL_MAX_INTERVAL_MS. Empty when the run may start.
 */
export function freelancePacingProblems(policy: Pick<Policy, 'minHostIntervalMs'>, o: { readonly gmail?: boolean } = {}): string[] {
  const perRequest = SOURCE_TIMEOUT_MS / 2;
  const problems =
    policy.minHostIntervalMs > perRequest
      ? [`minHostIntervalMs ${policy.minHostIntervalMs} ms breaks the src-hn timeout arithmetic (at most ${perRequest} ms per request); lower it in policy.user.yaml`]
      : [];
  if (o.gmail === true && policy.minHostIntervalMs > GMAIL_MAX_INTERVAL_MS) {
    problems.push(`minHostIntervalMs ${policy.minHostIntervalMs} ms breaks the src-gig-mail timeout arithmetic (${GMAIL_MAX_REQUESTS} requests at most ${GMAIL_MAX_INTERVAL_MS} ms apart); lower it in policy.user.yaml or turn gmail off in freelance.yaml`);
  }
  return problems;
}
