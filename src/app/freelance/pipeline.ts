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
import { makeSrcDraftdev } from './sources/draftdev.js';
import { makeGithubHosts } from './sources/github.js';
import { makeSrcFractionalJobs } from './sources/fractional-jobs.js';
import { makeSrcPrimeIntellect } from './sources/prime-intellect.js';
import { makeSrcHimalayasGigs } from './sources/himalayas-gigs.js';
import { gigSources } from './sources/index.js';
import { REMOTIVE_OFF } from './sources/remotive.js';
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

const TEAM_ORDER = ['sourcing', 'sourcing-himalayas', 'sourcing-draftdev', 'sourcing-prime-intellect', 'sourcing-fractional-jobs', 'understanding', 'evaluation', 'writing'] as const;

/** Every agent of the freelance run, in a stable order. */
export function freelanceAgents(): AnyAgent[] {
  // One GitHub host state for every GitHub source of the run (one host, one request budget); a fresh one per wiring.
  const github = makeGithubHosts();
  return [
    // The Himalayas source holds the run's host state (robots.txt once, a disabled host): a fresh one per wiring.
    ...gigSources.map((a) => (a.contract.id === 'src-himalayas-gigs' ? makeSrcHimalayasGigs() : a.contract.id === 'src-draftdev' ? makeSrcDraftdev(github) : a.contract.id === 'src-prime-intellect' ? makeSrcPrimeIntellect(github) : a.contract.id === 'src-fractional-jobs' ? makeSrcFractionalJobs() : a)),
    gigNormalizer, rateNormalizer, gigEligibility, gigRisk, gigScorer, proposalPlanner, gigRenderer, gigQa,
  ];
}

/**
 * The wiring for `agents`. Teams follow each contract's `team`; a team breaker follows its most tolerant member (the
 * daily rule), except **sourcing**: its threshold is the sum of its members' thresholds. Each source answers one
 * platform, so a team breaker at the largest member's threshold would let one dead platform (5 failed Freelancer
 * queries) skip every other platform's fetch for the run. With the sum, only a member's own breaker stops it, and the
 * team breaker opens only when every source could have opened its own. (The older source contracts all say
 * `sourcing`; `src-himalayas-gigs` (freelance-boost) declares its own team, `sourcing-himalayas`, so its breaker is its
 * own.)
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
export const FETCHING_PLATFORMS: readonly Platform[] = ['freelancer', 'hn-freelancer', 'hn-hiring', 'gmail', 'himalayas', 'draftdev', 'prime-intellect', 'fractional-jobs'];

/**
 * Platforms switched off because their robots.txt forbids what the source would read (the user's rule "no scraping
 * against robots.txt"), with the named reason the Sources page shows. Never seeded, whatever freelance.yaml says.
 */
export const ROBOTS_OFF: Readonly<Partial<Record<Platform, string>>> = REMOTIVE_OFF === null ? {} : { remotive: REMOTIVE_OFF };

/** The platforms this build has a source agent for, and the agent that answers each. */
export const PLATFORM_AGENT: Readonly<Partial<Record<Platform, string>>> = {
  freelancer: 'src-freelancer',
  remotive: 'src-remotive',
  'hn-freelancer': 'src-hn',
  'hn-hiring': 'src-hn',
  gmail: 'src-gig-mail',
  boards: 'src-board-contracts',
  himalayas: 'src-himalayas-gigs',
  draftdev: 'src-draftdev',
  'prime-intellect': 'src-prime-intellect',
  'fractional-jobs': 'src-fractional-jobs',
};

/**
 * The run's seeds, all dated `runDate` and `half`, in this order: Freelancer one request per pack query (each query
 * once), Remotive one, HN two (hn-freelancer, hn-hiring), Gmail one (the label `jobpilot/gigs`, only when
 * `gmailConnected`: without a refresh token in the Keychain the source is disabled, not failed), Himalayas one request
 * per pack query (freelance-boost, `src-himalayas-gigs`), then one request each for Draft.dev, Prime Intellect and
 * Fractional Jobs (sources-expansion; query ''), then one `boards`
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
  const on = (p: Platform) => rules.platforms[p].enabled && ROBOTS_OFF[p] === undefined;
  const seeds: GigRequest[] = [];
  const at = { runDate, half };
  if (on('freelancer')) for (const query of [...new Set(rules.platforms.freelancer.queries)]) seeds.push({ platform: 'freelancer', query, ...at });
  if (on('remotive')) seeds.push({ platform: 'remotive', query: '', ...at });
  if (on('hn-freelancer')) seeds.push({ platform: 'hn-freelancer', query: '', ...at });
  if (on('hn-hiring')) seeds.push({ platform: 'hn-hiring', query: '', ...at });
  if (on('gmail') && o.gmailConnected === true) seeds.push({ platform: 'gmail', query: GMAIL_LABEL, ...at });
  if (on('himalayas')) for (const query of [...new Set(rules.platforms.himalayas.queries)]) seeds.push({ platform: 'himalayas', query, ...at });
  if (on('draftdev')) seeds.push({ platform: 'draftdev', query: '', ...at });
  if (on('prime-intellect')) seeds.push({ platform: 'prime-intellect', query: '', ...at });
  if (on('fractional-jobs')) seeds.push({ platform: 'fractional-jobs', query: '', ...at });
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
