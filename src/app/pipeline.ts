import type { AnyAgent } from '../kernel/agent.js';
import type { EgressSets } from '../kernel/broker.js';
import type { GuardrailRegistry } from '../kernel/guardrails/index.js';
import type { Policy } from '../kernel/policy.js';
import { Registry } from '../kernel/registry.js';
import { compileWiring, type CompiledPipeline, type Edge, type Pipeline, type Team } from '../kernel/wiring.js';
import { eligibility } from './agents/eligibility.js';
import { normalizer } from './agents/normalizer.js';
import { scorerLexicon } from './agents/scorer-lexicon.js';
import { srcAshby } from './agents/sources/ashby.js';
import { CAREERS_RENDER_INTERVAL_MS, careersHosts, srcCareersJob, srcCareersList } from './agents/sources/careers.js';
import { SOURCE_TIMEOUT_MS } from './agents/sources/common.js';
import { srcGreenhouse } from './agents/sources/greenhouse.js';
import { HIMALAYAS_FEED, HIMALAYAS_MAX_PAGES, HIMALAYAS_TIMEOUT_MS, srcHimalayas } from './agents/sources/himalayas.js';
import { JOBICY_FEED, JOBICY_MAX_REQUESTS, JOBICY_TIMEOUT_MS, srcJobicy } from './agents/sources/jobicy.js';
import { LEVER_MAX_PAGES, LEVER_TIMEOUT_MS, srcLever } from './agents/sources/lever.js';
import { eightfoldBoardOfUrl, eightfoldRef, EIGHTFOLD_EGRESS, EIGHTFOLD_MAX_REQUESTS, EIGHTFOLD_TIMEOUT_MS, makeSrcEightfold, parseEightfoldRef } from './agents/sources/platforms/eightfold.js';
import { makeSrcOracle, oracleBoardOfUrl, oracleRef, ORACLE_EGRESS, ORACLE_MAX_REQUESTS, ORACLE_TIMEOUT_MS, parseOracleRef } from './agents/sources/platforms/oracle.js';
import { makeSrcWorkday, parseWorkdayRef, workdayBoardOfUrl, workdayRef, WORKDAY_EGRESS, WORKDAY_MAX_REQUESTS, WORKDAY_TIMEOUT_MS } from './agents/sources/platforms/workday.js';
import { dailyEightfoldHosts, dailyOracleHosts, dailyWorkdayHosts } from './daily-hosts.js';
import { writingAgents } from './agents/writing/index.js';
import { coverWriter } from './agents/writing/cover-writer.js';
import { qaGate } from './agents/writing/qa-gate.js';
import { renderer } from './agents/writing/renderer.js';
import { capabilityProblems } from './allow-list.js';
import type { Feeds, WatchEntry } from './pack/schema.js';
import { CoverPlan, DiscoveryRequest, knownAts } from './types.js';
import { FEED_SOURCES, knownFeeds } from './feeds.js';

/**
 * The daily pipeline (spec §5), `jobpilot-daily@1.0.0`, seeded with one DiscoveryRequest@1 per watchlist entry and
 * per enabled feed:
 *
 *   DiscoveryRequest@1 ─► src-ashby | src-greenhouse | src-himalayas | src-jobicy | src-lever ─► RawPosting@1
 *                      ─► src-careers-list ─► CareerLink@1 ─► src-careers-job ─► RawPosting@1   (careers entries only)
 *                      ─► src-workday ─► RawPosting@1   (verified Workday registry companies only; team sourcing-workday)
 *                      ─► src-eightfold ─► RawPosting@1   (verified Eightfold registry companies only; team sourcing-eightfold)
 *                      ─► src-oracle ─► RawPosting@1   (verified Oracle Recruiting Cloud companies only; team sourcing-oracle)
 *   RawPosting@1 ─► normalizer ─► Posting@1 ─► eligibility ─► EligibilityVerdict@1 ─► scorer-lexicon ─► Scored@1
 *   ─► evidence-matcher ─► Evidence@1 ─► resume-planner ─► ResumePlan@1 ─► cover-writer ─► CoverPlan@1
 *   ─► renderer ─► Rendered@1 ─► qa-gate ─► QaReport@1
 *
 * Every source gets every request and answers only its own (an empty list otherwise). A rejected verdict ends at
 * eligibility: the scorer returns nothing for it (its `requires` would quarantine it instead), and the projector reads
 * the verdict. A score under `minFit` ends at the scorer: the evidence-matcher returns nothing for it.
 */
export const DAILY_PIPELINE = { id: 'jobpilot-daily', version: '1.0.0' } as const;

export { FEED_SOURCES } from './feeds.js';

const API_SOURCES: readonly AnyAgent[] = [srcAshby, srcGreenhouse, srcHimalayas, srcJobicy, srcLever];
/** Each platform adapter has its own team (spec §6): a dead tenant opens no breaker elsewhere. */
const TEAM_ORDER = ['sourcing', 'sourcing-workday', 'sourcing-eightfold', 'sourcing-oracle', 'understanding', 'evaluation', 'writing'] as const;

type WatchLike = Pick<WatchEntry, 'ats'> & { readonly listUrl?: string | undefined };

/** One verified registry company the daily run reads through a platform adapter: its display name and board ref. */
export interface RegistryBoard {
  readonly platform: RegistryPlatform;
  readonly company: string;
  /** The adapter's DiscoveryRequest slug (Workday `<host>/<tenant>/<site>`, Eightfold `<host>/<domain>`, Oracle `<host>/<siteNumber>`). */
  readonly ref: string;
}

/** The registry platforms with a daily adapter in this build: each one's stored-board-URL reader, ref parser and egress. */
const REGISTRY_PLATFORMS = {
  workday: { ref: (url: string) => mapNull(workdayBoardOfUrl(url), workdayRef), host: (ref: string) => parseWorkdayRef(ref)?.host ?? null, egress: WORKDAY_EGRESS },
  eightfold: { ref: (url: string) => mapNull(eightfoldBoardOfUrl(url), eightfoldRef), host: (ref: string) => parseEightfoldRef(ref)?.host ?? null, egress: EIGHTFOLD_EGRESS },
  oracle: { ref: (url: string) => mapNull(oracleBoardOfUrl(url), oracleRef), host: (ref: string) => parseOracleRef(ref)?.host ?? null, egress: ORACLE_EGRESS },
} as const;
export type RegistryPlatform = keyof typeof REGISTRY_PLATFORMS;
const isRegistryPlatform = (p: string | null): p is RegistryPlatform => p !== null && Object.hasOwn(REGISTRY_PLATFORMS, p);
function mapNull<A, B>(a: A | null, f: (a: A) => B): B | null {
  return a === null ? null : f(a);
}

/** The registry rows the daily run needs (`AppStore.verifiedCompanies()` gives them). */
export interface RegistryCompany {
  readonly name: string;
  readonly platform: string | null;
  readonly boardUrl: string | null;
}

/**
 * The boards of the verified registry companies (`verifiedCompanies()`: verified or failing, never rejected) whose
 * platform has a daily adapter in this build (Task 6: Workday; Task 7: Eightfold, Oracle), sorted by platform then
 * ref; one per platform and ref (the first name wins). A row whose stored board URL is not a board of its platform is
 * left out.
 */
export function registryBoards(companies: readonly RegistryCompany[]): RegistryBoard[] {
  const out = new Map<string, RegistryBoard>();
  for (const c of companies) {
    if (!isRegistryPlatform(c.platform) || c.boardUrl === null) continue;
    const ref = REGISTRY_PLATFORMS[c.platform].ref(c.boardUrl);
    if (ref === null) continue;
    const key = `${c.platform} ${ref}`;
    if (!out.has(key)) out.set(key, { platform: c.platform, company: c.name, ref });
  }
  const order = (b: RegistryBoard): string => `${Object.keys(REGISTRY_PLATFORMS).indexOf(b.platform)} ${b.ref}`;
  return [...out.values()].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}

/**
 * Every agent of the daily run. The careers agents are left out when the watchlist has no careers entries. Their
 * egress is the symbolic `pack:careers-hosts`, resolved per run from `careersEgressSets(watchlist)`, so their
 * contracts are the same whatever the watchlist holds. Likewise `src-workday` is in only when the registry has a
 * verified Workday company (`boards`), with the symbolic egress `registry:workday-hosts`; it is built here, once per
 * call, on a fresh `dailyWorkdayHosts()` (robots.txt once per host per run). With no boards the agents, the wiring
 * and so every step key are exactly as before the registry existed.
 */
export function dailyAgents(watchlist: readonly WatchLike[], boards: readonly RegistryBoard[] = []): AnyAgent[] {
  const careers: AnyAgent[] = careersHosts(watchlist).length === 0 ? [] : [srcCareersList, srcCareersJob];
  // one adapter per platform with a verified company, each on its own fresh host state (robots.txt, disabled hosts)
  const has = (p: RegistryPlatform): boolean => boards.some((b) => b.platform === p);
  const platforms: AnyAgent[] = [
    ...(has('workday') ? [makeSrcWorkday({ hosts: dailyWorkdayHosts() })] : []),
    ...(has('eightfold') ? [makeSrcEightfold({ hosts: dailyEightfoldHosts() })] : []),
    ...(has('oracle') ? [makeSrcOracle({ hosts: dailyOracleHosts() })] : []),
  ];
  return [...API_SOURCES, ...careers, ...platforms, normalizer, eligibility, scorerLexicon, ...writingAgents];
}

/** The hosts behind the careers agents' symbolic egress, for the supervisor. */
export function careersEgressSets(watchlist: readonly WatchLike[]): EgressSets {
  return { 'pack:careers-hosts': careersHosts(watchlist) };
}

/** The hosts behind the registry adapters' symbolic egress (exact hosts); empty, and so absent, with no boards. */
export function registryEgressSets(boards: readonly RegistryBoard[]): EgressSets {
  const sets: Record<string, string[]> = {};
  for (const [platform, p] of Object.entries(REGISTRY_PLATFORMS)) {
    const hosts = [...new Set(boards.filter((b) => b.platform === platform).flatMap((b) => p.host(b.ref) ?? []))].sort();
    if (hosts.length > 0) sets[p.egress] = hosts;
  }
  return sets;
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
    ...(has('src-workday') ? [{ type: 'DiscoveryRequest@1', to: 'src-workday' }] : []),
    ...(has('src-eightfold') ? [{ type: 'DiscoveryRequest@1', to: 'src-eightfold' }] : []),
    ...(has('src-oracle') ? [{ type: 'DiscoveryRequest@1', to: 'src-oracle' }] : []),
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

/** `jobpilot docs rebuild`: the renderer and the qa-gate only, seeded with stored cover plans. */
export const REBUILD_PIPELINE = { id: 'jobpilot-rebuild', version: '1.0.0' } as const;
export const rebuildAgents = (): AnyAgent[] => [renderer, qaGate];

/**
 * The rebuild wiring: `CoverPlan@1 ─► renderer ─► Rendered@1 ─► qa-gate`. Its seed carries exactly the handoff a
 * cover-writer output carries (the cover-writer's guarantees, P0, no obligations), so a seeded cover plan gives the
 * renderer the same input, and so the same step key, as in the daily run: with an unchanged full pack it would replay,
 * and with the raised `render.nonce` it renders again. The next daily run then replays the rebuilt step.
 */
export function rebuildPipeline(): Pipeline {
  const members = rebuildAgents();
  return {
    id: REBUILD_PIPELINE.id,
    version: REBUILD_PIPELINE.version,
    seed: { type: CoverPlan, guarantees: [...coverWriter.contract.guarantees], dataClass: 'P0' },
    teams: [{ id: 'writing', lead: 'writing-lead', members: members.map((a) => a.contract.id), exitGuarantees: [], breaker: { consecutiveFailures: Math.max(...members.map((a) => a.contract.breaker.consecutiveFailures)) } }],
    edges: [
      { type: 'CoverPlan@1', to: 'renderer' },
      { type: 'Rendered@1', to: 'qa-gate' },
    ],
  };
}

/**
 * Registers `agents` and proves the wiring. The app's capability allow-list is checked first: an agent holding the
 * 'full' pack, writable files or pdftotext without being the one agent each is for refuses the whole compile.
 */
export function compileDaily(agents: readonly AnyAgent[], guardrails: GuardrailRegistry, pipeline: Pipeline = dailyPipeline(agents)): { registry: Registry; compiled: CompiledPipeline } {
  const problems = capabilityProblems(agents.map((a) => a.contract));
  if (problems.length > 0) throw new Error(`capability allow-list refuses the pipeline:\n- ${problems.join('\n- ')}`);
  const registry = new Registry();
  for (const a of agents) registry.register(a);
  return { registry, compiled: compileWiring(registry, pipeline, guardrails) };
}

/**
 * The per-request time each paged source's step timeout was sized for. The host pacer spaces requests to one host by
 * `minHostIntervalMs`; above this budget the cap arithmetic no longer holds and a big board would time out instead of
 * failing on its own cap.
 */
const HTTP_BUDGETS: readonly {
  readonly agent: string;
  readonly perRequestMs: number;
  readonly applies: (w: readonly WatchLike[], f: readonly string[], boards: readonly RegistryBoard[]) => boolean;
}[] = [
  // the cap pages plus the confirming request and its one re-request
  { agent: srcLever.contract.id, perRequestMs: LEVER_TIMEOUT_MS / (LEVER_MAX_PAGES + 2), applies: (w) => w.some((e) => e.ats === 'lever') },
  { agent: srcJobicy.contract.id, perRequestMs: JOBICY_TIMEOUT_MS / JOBICY_MAX_REQUESTS, applies: (_w, f) => f.includes(JOBICY_FEED) },
  { agent: srcHimalayas.contract.id, perRequestMs: HIMALAYAS_TIMEOUT_MS / HIMALAYAS_MAX_PAGES, applies: (_w, f) => f.includes(HIMALAYAS_FEED) },
  // one request per board, but boards on one host queue behind each other's interval
  { agent: srcGreenhouse.contract.id, perRequestMs: SOURCE_TIMEOUT_MS, applies: (w) => w.some((e) => e.ats === 'greenhouse') },
  { agent: srcAshby.contract.id, perRequestMs: SOURCE_TIMEOUT_MS, applies: (w) => w.some((e) => e.ats === 'ashby') },
  // robots.txt, the list pages (with a scoped re-read) and the detail budget, each at least 2 s apart
  { agent: 'src-workday', perRequestMs: Math.floor(WORKDAY_TIMEOUT_MS / WORKDAY_MAX_REQUESTS), applies: (_w, _f, b) => b.some((x) => x.platform === 'workday') },
  // robots.txt, the careers page, discovery, the list pages and the details, each at least 5 s apart
  { agent: 'src-eightfold', perRequestMs: Math.floor(EIGHTFOLD_TIMEOUT_MS / EIGHTFOLD_MAX_REQUESTS), applies: (_w, _f, b) => b.some((x) => x.platform === 'eightfold') },
  // robots.txt, at most 10 list pages and the details, each at least 5 s apart
  { agent: 'src-oracle', perRequestMs: Math.floor(ORACLE_TIMEOUT_MS / ORACLE_MAX_REQUESTS), applies: (_w, _f, b) => b.some((x) => x.platform === 'oracle') },
];

/**
 * M5: the pacing intervals of the effective policy against the timeout arithmetic of the sources this run seeds. A
 * careers render waits for the browser pacer, then the host pacer, so its wait is the larger of the two; the careers
 * timeouts (75 s a job page, 275 s a listing page) were sized for CAREERS_RENDER_INTERVAL_MS. Each problem names
 * the setting. Empty when the run may start.
 */
export function pacingProblems(
  policy: Pick<Policy, 'minHostIntervalMs' | 'minBrowserIntervalMs'>,
  pack: { readonly watchlist: readonly WatchLike[]; readonly feeds: Pick<Feeds, 'enabled'> },
  boards: readonly RegistryBoard[] = [],
): string[] {
  const problems: string[] = [];
  const host = policy.minHostIntervalMs;
  for (const b of HTTP_BUDGETS) {
    if (b.applies(pack.watchlist, pack.feeds.enabled, boards) && host > b.perRequestMs) {
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
 * The run's seeds: one request per watchlist entry, then one per enabled feed, then one per registry board (`boards`,
 * `registryBoards`: `{ats: <platform>, slug: <ref>, company}`, Workday, Eightfold, then Oracle), each dated `runDate` (the IST date).
 * Identical entries are sent once. `attempt` (the run's ordinal on its date, from `run --refresh`) is set only when it
 * is 2 or more, so a normal run's seeds, and so its step keys, are unchanged. An unknown feed cannot get here
 * (`loadPack` refuses it) and throws.
 */
export function dailySeeds(
  pack: { readonly watchlist: readonly Pick<WatchEntry, 'ats' | 'slug' | 'company'>[]; readonly feeds: Pick<Feeds, 'enabled'> },
  runDate: string,
  attempt?: number,
  boards: readonly RegistryBoard[] = [],
): DiscoveryRequest[] {
  const seeds: DiscoveryRequest[] = [];
  const seen = new Set<string>();
  const extra = attempt !== undefined && attempt >= 2 ? { attempt } : {};
  const add = (s: DiscoveryRequest) => {
    const k = `${s.ats}\u0000${s.slug}\u0000${s.company}`;
    if (!seen.has(k)) {
      seen.add(k);
      seeds.push({ ...s, ...extra });
    }
  };
  for (const w of pack.watchlist) add({ ats: w.ats, slug: w.slug, company: w.company, runDate });
  for (const feed of pack.feeds.enabled) {
    if (!Object.hasOwn(FEED_SOURCES, feed)) throw new Error(`feeds.yaml: unknown feed ${feed} (known: ${knownFeeds().join(', ')})`);
    add({ ats: 'feed', slug: feed, company: feed, runDate });
  }
  for (const b of boards) add({ ats: b.platform, slug: b.ref, company: b.company, runDate });
  return seeds;
}
