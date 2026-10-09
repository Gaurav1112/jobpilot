import type { AnyAgent } from '../kernel/agent.js';
import type { GuardrailRegistry } from '../kernel/guardrails/index.js';
import type { Policy } from '../kernel/policy.js';
import { Registry } from '../kernel/registry.js';
import { compileWiring, type CompiledPipeline, type Edge, type Pipeline, type Team } from '../kernel/wiring.js';
import { eligibility } from './agents/eligibility.js';
import { normalizer } from './agents/normalizer.js';
import { scorerLexicon } from './agents/scorer-lexicon.js';
import { srcAshby } from './agents/sources/ashby.js';
import { CAREERS_RENDER_INTERVAL_MS, careersHosts, makeSrcCareersJob, makeSrcCareersList } from './agents/sources/careers.js';
import { SOURCE_TIMEOUT_MS } from './agents/sources/common.js';
import { srcGreenhouse } from './agents/sources/greenhouse.js';
import { HIMALAYAS_FEED, HIMALAYAS_MAX_PAGES, HIMALAYAS_TIMEOUT_MS, srcHimalayas } from './agents/sources/himalayas.js';
import { JOBICY_FEED, JOBICY_MAX_REQUESTS, JOBICY_TIMEOUT_MS, srcJobicy } from './agents/sources/jobicy.js';
import { LEVER_MAX_PAGES, LEVER_TIMEOUT_MS, srcLever } from './agents/sources/lever.js';
import { writingAgents } from './agents/writing/index.js';
import { capabilityProblems } from './allow-list.js';
import type { Feeds, WatchEntry } from './pack/schema.js';
import { DiscoveryRequest, knownAts } from './types.js';

/**
 * The daily pipeline (spec §5), `jobpilot-daily@1.0.0`, seeded with one DiscoveryRequest@1 per watchlist entry and
 * per enabled feed:
 *
 *   DiscoveryRequest@1 ─► src-ashby | src-greenhouse | src-himalayas | src-jobicy | src-lever ─► RawPosting@1
 *                      ─► src-careers-list ─► CareerLink@1 ─► src-careers-job ─► RawPosting@1   (careers entries only)
 *   RawPosting@1 ─► normalizer ─► Posting@1 ─► eligibility ─► EligibilityVerdict@1 ─► scorer-lexicon ─► Scored@1
 *   ─► evidence-matcher ─► Evidence@1 ─► resume-planner ─► ResumePlan@1 ─► cover-writer ─► CoverPlan@1
 *   ─► renderer ─► Rendered@1 ─► qa-gate ─► QaReport@1
 *
 * Every source gets every request and answers only its own (an empty list otherwise). A rejected verdict ends at
 * eligibility: the scorer returns nothing for it (its `requires` would quarantine it instead), and the projector reads
 * the verdict. A score under `minFit` ends at the scorer: the evidence-matcher returns nothing for it.
 */
export const DAILY_PIPELINE = { id: 'jobpilot-daily', version: '1.0.0' } as const;

/** Feed name (feeds.yaml `enabled`) -> the source agent that fetches it. */
export const FEED_SOURCES: Readonly<Record<string, string>> = { [HIMALAYAS_FEED]: srcHimalayas.contract.id, [JOBICY_FEED]: srcJobicy.contract.id };

const API_SOURCES: readonly AnyAgent[] = [srcAshby, srcGreenhouse, srcHimalayas, srcJobicy, srcLever];
const TEAM_ORDER = ['sourcing', 'understanding', 'evaluation', 'writing'] as const;

type WatchLike = Pick<WatchEntry, 'ats'> & { readonly listUrl?: string | undefined };

/**
 * Every agent of the daily run. The careers agents are built for the watchlist's careers hosts (their exact egress)
 * and left out when there are none: their factory refuses an empty host list.
 */
export function dailyAgents(watchlist: readonly WatchLike[]): AnyAgent[] {
  const hosts = careersHosts(watchlist);
  const careers: AnyAgent[] = hosts.length === 0 ? [] : [makeSrcCareersList(hosts), makeSrcCareersJob(hosts)];
  return [...API_SOURCES, ...careers, normalizer, eligibility, scorerLexicon, ...writingAgents];
}

/**
 * The wiring for `agents`. Teams follow each contract's `team`. A team breaker never opens before its most tolerant
 * member's own breaker would (the normalizer allows 10,000 failures, since one bad posting is data, not an outage), so
 * the agent breakers decide; no team adds an exit guarantee.
 */
export function dailyPipeline(agents: readonly AnyAgent[]): Pipeline {
  const has = (id: string) => agents.some((a) => a.contract.id === id);
  const teams: Team[] = TEAM_ORDER.map((id) => {
    const members = agents.filter((a) => a.contract.team === id);
    return {
      id,
      lead: `${id}-lead`,
      members: members.map((a) => a.contract.id),
      exitGuarantees: [],
      breaker: { consecutiveFailures: Math.max(1, ...members.map((a) => a.contract.breaker.consecutiveFailures)) },
    };
  }).filter((t) => t.members.length > 0);
  const edges: Edge[] = [
    ...API_SOURCES.map((a) => ({ type: 'DiscoveryRequest@1', to: a.contract.id })),
    ...(has('src-careers-list') ? [{ type: 'DiscoveryRequest@1', to: 'src-careers-list' }, { type: 'CareerLink@1', to: 'src-careers-job' }] : []),
    { type: 'RawPosting@1', to: 'normalizer' },
    { type: 'Posting@1', to: 'eligibility' },
    { type: 'EligibilityVerdict@1', to: 'scorer-lexicon' },
    { type: 'Scored@1', to: 'evidence-matcher' },
    { type: 'Evidence@1', to: 'resume-planner' },
    { type: 'ResumePlan@1', to: 'cover-writer' },
    { type: 'CoverPlan@1', to: 'renderer' },
    { type: 'Rendered@1', to: 'qa-gate' },
  ];
  return { id: DAILY_PIPELINE.id, version: DAILY_PIPELINE.version, seed: { type: DiscoveryRequest, guarantees: [knownAts] }, teams, edges };
}

/**
 * Registers `agents` and proves the wiring. The app's capability allow-list is checked first: an agent holding the
 * 'full' pack, writable files or pdftotext without being the one agent each is for refuses the whole compile.
 */
export function compileDaily(agents: readonly AnyAgent[], guardrails: GuardrailRegistry): { registry: Registry; compiled: CompiledPipeline } {
  const problems = capabilityProblems(agents.map((a) => a.contract));
  if (problems.length > 0) throw new Error(`capability allow-list refuses the pipeline:\n- ${problems.join('\n- ')}`);
  const registry = new Registry();
  for (const a of agents) registry.register(a);
  return { registry, compiled: compileWiring(registry, dailyPipeline(agents), guardrails) };
}

/**
 * The per-request time each paged source's step timeout was sized for. The host pacer spaces requests to one host by
 * `minHostIntervalMs`; above this budget the cap arithmetic no longer holds and a big board would time out instead of
 * failing on its own cap.
 */
const HTTP_BUDGETS: readonly { readonly agent: string; readonly perRequestMs: number; readonly applies: (w: readonly WatchLike[], f: readonly string[]) => boolean }[] = [
  // the cap pages plus the confirming request and its one re-request
  { agent: srcLever.contract.id, perRequestMs: LEVER_TIMEOUT_MS / (LEVER_MAX_PAGES + 2), applies: (w) => w.some((e) => e.ats === 'lever') },
  { agent: srcJobicy.contract.id, perRequestMs: JOBICY_TIMEOUT_MS / JOBICY_MAX_REQUESTS, applies: (_w, f) => f.includes(JOBICY_FEED) },
  { agent: srcHimalayas.contract.id, perRequestMs: HIMALAYAS_TIMEOUT_MS / HIMALAYAS_MAX_PAGES, applies: (_w, f) => f.includes(HIMALAYAS_FEED) },
  // one request per board, but boards on one host queue behind each other's interval
  { agent: srcGreenhouse.contract.id, perRequestMs: SOURCE_TIMEOUT_MS, applies: (w) => w.some((e) => e.ats === 'greenhouse') },
  { agent: srcAshby.contract.id, perRequestMs: SOURCE_TIMEOUT_MS, applies: (w) => w.some((e) => e.ats === 'ashby') },
];

/**
 * M5: the pacing intervals of the effective policy against the timeout arithmetic of the sources this run seeds. A
 * careers render waits for the browser pacer, then the host pacer, so its wait is the larger of the two; the careers
 * timeouts (75 s a job page, 275 s a listing page) were sized for CAREERS_RENDER_INTERVAL_MS. Each problem names
 * the setting. Empty when the run may start.
 */
export function pacingProblems(policy: Pick<Policy, 'minHostIntervalMs' | 'minBrowserIntervalMs'>, pack: { readonly watchlist: readonly WatchLike[]; readonly feeds: Pick<Feeds, 'enabled'> }): string[] {
  const problems: string[] = [];
  const host = policy.minHostIntervalMs;
  for (const b of HTTP_BUDGETS) {
    if (b.applies(pack.watchlist, pack.feeds.enabled) && host > b.perRequestMs) {
      problems.push(`minHostIntervalMs ${host} ms breaks the ${b.agent} timeout arithmetic (at most ${b.perRequestMs} ms per request); lower it in policy.user.yaml`);
    }
  }
  if (careersHosts(pack.watchlist).length > 0) {
    for (const [name, ms] of [['minBrowserIntervalMs', policy.minBrowserIntervalMs], ['minHostIntervalMs', host]] as const) {
      if (ms > CAREERS_RENDER_INTERVAL_MS) {
        problems.push(`${name} ${ms} ms breaks the careers timeout arithmetic (sized for ${CAREERS_RENDER_INTERVAL_MS} ms between renders of one host); lower it in policy.user.yaml`);
      }
    }
  }
  return problems;
}

/**
 * The run's seeds: one request per watchlist entry, then one per enabled feed that has a source agent, each dated
 * `runDate` (the IST date). Identical entries are sent once. A feed with no source agent is not fetched and is named
 * in `warnings`, never dropped silently.
 */
export function dailySeeds(
  pack: { readonly watchlist: readonly Pick<WatchEntry, 'ats' | 'slug' | 'company'>[]; readonly feeds: Pick<Feeds, 'enabled'> },
  runDate: string,
): { seeds: DiscoveryRequest[]; warnings: string[] } {
  const seeds: DiscoveryRequest[] = [];
  const seen = new Set<string>();
  const add = (s: DiscoveryRequest) => {
    const k = `${s.ats}\u0000${s.slug}\u0000${s.company}`;
    if (!seen.has(k)) {
      seen.add(k);
      seeds.push(s);
    }
  };
  for (const w of pack.watchlist) add({ ats: w.ats, slug: w.slug, company: w.company, runDate });
  const warnings: string[] = [];
  for (const feed of pack.feeds.enabled) {
    if (Object.hasOwn(FEED_SOURCES, feed)) add({ ats: 'feed', slug: feed, company: feed, runDate });
    else warnings.push(`feed ${feed} has no source agent; it was not fetched (known feeds: ${Object.keys(FEED_SOURCES).sort().join(', ')})`);
  }
  return { seeds, warnings };
}
