import type { AnyAgent } from '../../kernel/agent.js';
import type { EgressSets } from '../../kernel/broker.js';
import type { Clock } from '../../kernel/clock.js';
import type { Envelope } from '../../kernel/envelope.js';
import type { GuardrailRegistry } from '../../kernel/guardrails/index.js';
import { hostDenied, mergePolicy, policyHash, PRODUCT_POLICY_V1, type Policy } from '../../kernel/policy.js';
import type { FetchLike } from '../../kernel/providers.js';
import type { Store } from '../../kernel/store/store.js';
import { Supervisor } from '../../kernel/supervisor.js';
import type { CompiledPipeline, Pipeline } from '../../kernel/wiring.js';
import { appGuardrails } from '../guardrails.js';
import type { Pack } from '../pack/schema.js';
import { compileDaily } from '../pipeline.js';
import { detectorEgressSets, makePlatformDetector } from './detector.js';
import { asHttps } from './gate.js';
import { makeRunGate, memoryHostStateStore, type RunGate } from './gate.js';
import { locatorEgressSets, makeCareersLocator } from './locator.js';
import { companySeed, mergeCandidates } from './seed.js';
import { CareersSite, CompanyCandidate, CompanyVerdict, CoverageRequest, PlatformGuess } from './types.js';
import { makeBoardVerifier, noPlatformVerdict, verifierEgressSets } from './verifier.js';

/**
 * The coverage pipeline `jobpilot-coverage@1.0.0` (spec §3), run weekly by `run-coverage`:
 *
 *   CoverageRequest@1 ─► company-seed ─► CompanyCandidate@1 ─(mergeCandidates)─► careers-locator ─► CareersSite@1
 *   ─► platform-detector ─► PlatformGuess@1 ─► board-verifier ─► CompanyVerdict@1 ─► the `companies` registry
 *
 * It runs as four STAGES, each its own supervisor run `<runId>.<stage>` (seed, locate, detect, verify) under the
 * umbrella run `<runId>` (`coverage-<IST date>[-n]`), because three things are only known once the stage before has
 * finished: the cross-source merge (`mergeCandidates`, which needs every source's candidates), the detector's egress
 * (the located careers URLs' hosts, `detectorEgressSets`: a Workday or Eightfold tenant cannot be listed up front, and
 * hosts are matched exactly, never by suffix) and the verifier's egress (the read hosts of the detected boards,
 * `verifierEgressSets`). Each stage gets exactly the egress its own inputs need.
 *
 * - One team per agent, so a breaker never spans unrelated work (the freelance lesson).
 * - ONE run gate (`makeRunGate`, keyed by the umbrella run id, persisted in `coverage_host_state`) is built inside the
 *   run and shared by the locator, detector and verifier: robots.txt once per host per run, and a host disabled by any
 *   of them is disabled for all.
 * - The policy is the user's, with `minHostIntervalMs` raised to at least 2000 ms. The supervisors of the stages run one
 *   after the other, each with its own host pacer, so the run waits `minHostIntervalMs` between stages: no host is
 *   asked twice within the interval across a stage boundary either.
 * - Candidates are processed in the kernel's fixed total order (stage, agent, envelope id): deterministic for a given
 *   candidate list, the same on every run and resume (not alphabetical: the queue orders by envelope id). Accepted
 *   as the order (2026-10-14); `--limit` alone selects by companyKey.
 * - Time slices (`pauseBefore`): before each step and each stage the run may stop cleanly between steps (it yields to
 *   an owed daily or freelance run, or its 90-minute slice is used up). Stage runs stay incomplete; the next invocation
 *   resumes them under the same umbrella run id, finished steps replay at $0 and the run's host state carries over.
 * - A completed stage run is read back, never run twice; an incomplete one (a crash) is resumed. Its inputs are a pure
 *   function of the earlier stages' stored outputs, so a resumed run seeds exactly what the first attempt seeded.
 * - Only located sites go to the detector, and only guesses with a platform go to the verifier; a guess with no
 *   platform becomes a Proposed verdict here (`noPlatformVerdict`), with the detector's reasons.
 */
export const COVERAGE_PIPELINE = { id: 'jobpilot-coverage', version: '1.0.0' } as const;
/** The coverage run's floor for the spacing of two requests to one host (the constraints' 2 s). */
export const COVERAGE_MIN_HOST_INTERVAL_MS = 2000;

export type StageId = 'seed' | 'locate' | 'detect' | 'verify';
export const STAGES: readonly StageId[] = ['seed', 'locate', 'detect', 'verify'];

/** The coverage policy: `policy.user.yaml` with `minHostIntervalMs` raised (never lowered) to COVERAGE_MIN_HOST_INTERVAL_MS. */
export function coveragePolicy(pack: Pick<Pack, 'policyUser'>): Policy {
  const base = mergePolicy(PRODUCT_POLICY_V1, pack.policyUser);
  return mergePolicy(PRODUCT_POLICY_V1, { ...(pack.policyUser as Record<string, unknown>), minHostIntervalMs: Math.max(base.minHostIntervalMs, COVERAGE_MIN_HOST_INTERVAL_MS) });
}

/** The policy hash of the coverage run (as the daily and freelance runs hash theirs): in every step key and the run row. */
export const coveragePolicyHash = (pack: Pick<Pack, 'policyUser'>): string => policyHash(coveragePolicy(pack));

/** The four agents of one coverage run, on its gate, in stage order. */
export function coverageAgents(gate: RunGate): { readonly seed: AnyAgent; readonly locate: AnyAgent; readonly detect: AnyAgent; readonly verify: AnyAgent } {
  return { seed: companySeed, locate: makeCareersLocator({ gate }), detect: makePlatformDetector({ gate }), verify: makeBoardVerifier({ gate }) };
}

/** The coverage agents for the contract export and the allow-list check (their contracts do not depend on a gate). */
export function coverageExportAgents(): AnyAgent[] {
  const a = coverageAgents(makeRunGate({ runKey: 'contracts', store: memoryHostStateStore() }));
  return STAGES.map((s) => a[s]);
}

/** One stage: its agent, as the only member of a team of its own (the contract's `team`), seeded with what it consumes. */
export function stagePipeline(stage: StageId, agent: AnyAgent): Pipeline {
  const c = agent.contract;
  return {
    id: `${COVERAGE_PIPELINE.id}/${stage}`,
    version: COVERAGE_PIPELINE.version,
    seed: { type: c.consumes, guarantees: [] },
    teams: [{ id: c.team, lead: `${c.team}-lead`, members: [c.id], exitGuarantees: [], breaker: { consecutiveFailures: c.breaker.consecutiveFailures } }],
    edges: [{ type: c.consumes.id, to: c.id }],
  };
}

/** Compiles every stage through the capability allow-list and the wiring proof; throws, before anything runs, on any problem. */
export function compileCoverage(gate: RunGate, guardrails: GuardrailRegistry = appGuardrails()): Record<StageId, ReturnType<typeof compileDaily> & { readonly agent: AnyAgent }> {
  const agents = coverageAgents(gate);
  const out = {} as Record<StageId, ReturnType<typeof compileDaily> & { readonly agent: AnyAgent }>;
  for (const s of STAGES) out[s] = { ...compileDaily([agents[s]], guardrails, stagePipeline(s, agents[s])), agent: agents[s] };
  return out;
}

/** The seeds of the seed stage, all dated with the coverage week (so a second run in the same week replays): picks, the two lists, the seen jobs. */
export function coverageSeeds(week: string, picks: readonly unknown[], seenJobs: readonly unknown[]): CoverageRequest[] {
  return [
    { runDate: week, source: 'picks', items: [...picks] },
    { runDate: week, source: 'remoteintech' },
    { runDate: week, source: 'yc' },
    { runDate: week, source: 'jobs', items: [...seenJobs] },
  ];
}

/**
 * The candidates the locator gets: every pick, then the first `limit` other candidates in the merged (companyKey)
 * order. `limit` is for checks only (`run-coverage --limit N`); without it every candidate goes.
 */
export function selectCandidates(merged: readonly CompanyCandidate[], limit?: number): CompanyCandidate[] {
  if (limit === undefined) return [...merged];
  let others = 0;
  return merged.filter((c) => c.source === 'pick' || others++ < limit);
}

/**
 * Candidates whose website (or listed careers URL) is on a host the policy denies outright (`deniedEgressHosts`,
 * `deniedEgressBrands`: LinkedIn, Indeed, Glassdoor, Naukri): such a "website" is a profile on a job board whose terms
 * forbid automated access, so the candidate is not sent to the locator at all (the broker would refuse every probe).
 * One note each, never a silent drop.
 */
export function deniedWebsites(candidates: readonly CompanyCandidate[], policy: Pick<Policy, 'deniedEgressHosts' | 'deniedEgressBrands'>): { readonly kept: CompanyCandidate[]; readonly notes: string[] } {
  const kept: CompanyCandidate[] = [];
  const notes: string[] = [];
  for (const c of candidates) {
    const denied = [c.website, c.careersUrl].map((u) => (u === null ? null : asHttps(u))).find((u) => u !== null && u !== undefined && hostDenied(policy, u.hostname));
    if (denied === undefined) kept.push(c);
    else notes.push(`${c.name} (${c.companyKey}): ${denied?.hostname ?? '?'} is a host the policy denies; not located`);
  }
  return { kept, notes };
}

/** A step of a stage that did not finish because a host was disabled in the run: asked again next run. */
export interface Deferred {
  readonly stage: StageId;
  readonly input: unknown;
  readonly detail: string;
}

export interface StageResult {
  readonly stage: StageId;
  readonly runId: string;
  readonly outputs: readonly unknown[];
  readonly deferred: readonly Deferred[];
  /** Failed steps other than gone, input-rejected and deferred, plus quarantined ones: they make the run exit 1. */
  readonly broken: number;
  readonly executed: number;
  readonly replayed: number;
}

export interface CoverageStagesOptions {
  readonly store: Store;
  readonly runId: string;
  readonly gate: RunGate;
  readonly policy: Policy;
  readonly policyHash: string;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  readonly fetch: FetchLike;
  readonly codeHash: string;
  readonly seeds: readonly CoverageRequest[];
  readonly limit?: number;
  readonly afterStep?: (count: number) => void;
  /** Asked before each step and each stage: a reason stops the run there, between steps (`CoveragePaused`). */
  readonly pauseBefore?: () => string | null;
}

/** The run stopped between steps (it yielded, or hit its slice limit); its stage runs stay incomplete for the next invocation. */
export interface CoveragePaused {
  readonly paused: string;
  readonly stage: StageId;
}

export interface CoverageStagesOutcome {
  readonly stages: Record<StageId, StageResult>;
  /** Every candidate of the seed stage, before the merge. */
  readonly seeded: readonly CompanyCandidate[];
  readonly merged: readonly CompanyCandidate[];
  readonly selected: readonly CompanyCandidate[];
  /** One note per candidate that lost its companyKey to another source in the merge. */
  readonly dropped: readonly string[];
  /** One note per candidate left out because its website is on a policy-denied host (`deniedWebsites`). */
  readonly denied: readonly string[];
  readonly sites: readonly CareersSite[];
  readonly guesses: readonly PlatformGuess[];
  /** The verifier's verdicts plus a Proposed verdict per guess with no platform. */
  readonly verdicts: readonly CompanyVerdict[];
}

const HOST_DISABLED_DETAIL = 'host-disabled:';

/** Done outputs (in queue order) and deferred inputs of one stage run, read from the store. */
function stageResult(store: Store, stage: StageId, runId: string): StageResult {
  const stepOf = new Map<string, string>();
  const failure = new Map<string, { error: string; detail: string }>();
  let executed = 0;
  let replayed = 0;
  for (const e of store.events(runId)) {
    const d = JSON.parse(e.data) as Record<string, unknown>;
    const key = `${String(d['agent'])}\u0000${String(d['envelopeId'])}`;
    if (e.kind === 'step_done' || (e.kind === 'step_replayed' && d['status'] === 'done')) {
      if (typeof d['stepKey'] === 'string') stepOf.set(key, d['stepKey']);
      if (e.kind === 'step_done') executed++;
      else replayed++;
    }
    if (e.kind === 'step_failed') failure.set(key, { error: String(d['error']), detail: String(d['detail']) });
  }
  const outputs: unknown[] = [];
  const deferred: Deferred[] = [];
  let broken = 0;
  for (const q of store.queueItems(runId)) {
    const key = `${q.agent_id}\u0000${q.envelope_id}`;
    if (q.status === 'done') {
      const stepKey = stepOf.get(key);
      if (stepKey !== undefined) for (const env of store.envelopesOfStep(stepKey)) outputs.push(env.payload);
    } else if (q.status === 'failed') {
      const f = failure.get(key);
      if (f?.error === 'input_rejected' && f.detail.includes(HOST_DISABLED_DETAIL)) deferred.push({ stage, input: (store.getEnvelope(q.envelope_id) as Envelope).payload, detail: f.detail });
      else if (f?.error !== 'gone' && f?.error !== 'input_rejected') broken++;
    } else if (q.status === 'quarantined') broken++;
  }
  return { stage, runId, outputs, deferred, broken, executed, replayed };
}

/**
 * Runs (or resumes, or reads back) the four stages of one coverage run. Throws only on what stops the whole run (the
 * wiring proof, a store error); a failing company is a verdict or a deferral, never an exception.
 */
export async function runCoverageStages(o: CoverageStagesOptions): Promise<CoverageStagesOutcome | CoveragePaused> {
  const compiled = compileCoverage(o.gate);
  const guardrails = appGuardrails();
  let first = true;
  let reason: string | null = null;
  const pauseBefore = (): string | null => (reason = o.pauseBefore?.() ?? null);
  class Paused extends Error {
    constructor(readonly stage: StageId) {
      super('paused');
    }
  }
  const run = async (stage: StageId, seeds: readonly unknown[], egressSets: EgressSets): Promise<StageResult> => {
    const { registry, compiled: c } = compiled[stage] as { registry: ReturnType<typeof compileDaily>['registry']; compiled: CompiledPipeline };
    const id = `${o.runId}.${stage}`;
    const existing = o.store.getRun(id);
    if (existing?.status !== 'completed') {
      if (pauseBefore() !== null) throw new Paused(stage);
      // a fresh pacer per stage: the gap keeps any host's last request of the stage before at least one interval away
      if (!first) await o.sleep(o.policy.minHostIntervalMs);
      first = false;
      const supervisor = new Supervisor({
        store: o.store,
        registry,
        compiled: c,
        guardrails,
        policy: o.policy,
        policyHash: o.policyHash,
        providers: { fetch: o.fetch },
        clock: o.clock,
        sleep: o.sleep,
        egressSets,
        codeHash: o.codeHash,
        ...(o.afterStep ? { afterStep: o.afterStep } : {}),
        pauseBefore,
      });
      const report = existing === undefined ? await supervisor.start(id, seeds) : await supervisor.resume(id);
      if (report.status === 'paused') throw new Paused(stage);
    }
    return stageResult(o.store, stage, id);
  };
  try {
    return await stagesOf(o, run);
  } catch (e) {
    if (e instanceof Paused) return { paused: reason ?? 'paused', stage: e.stage };
    throw e;
  }
}

async function stagesOf(o: CoverageStagesOptions, run: (stage: StageId, seeds: readonly unknown[], egressSets: EgressSets) => Promise<StageResult>): Promise<CoverageStagesOutcome> {

  const seed = await run('seed', o.seeds, {});
  const seeded = seed.outputs.map((x) => CompanyCandidate.schema.parse(x));
  const dropped: string[] = [];
  const merged = mergeCandidates(seeded, (n) => dropped.push(n));
  const { kept, notes: denied } = deniedWebsites(merged, o.policy);
  const selected = selectCandidates(kept, o.limit);

  const locate = await run('locate', selected, locatorEgressSets(selected));
  const sites = locate.outputs.map((x) => CareersSite.schema.parse(x));
  const located = sites.filter((s) => s.careersUrl !== null);

  const detect = await run('detect', located, detectorEgressSets(located));
  const guesses = detect.outputs.map((x) => PlatformGuess.schema.parse(x));
  const withPlatform = guesses.filter((g) => g.platform !== null);

  const verify = await run('verify', withPlatform, verifierEgressSets(withPlatform));
  const verdicts = [...verify.outputs.map((x) => CompanyVerdict.schema.parse(x)), ...guesses.filter((g) => g.platform === null).map(noPlatformVerdict)];
  verdicts.sort((a, b) => (a.guess.site.candidate.companyKey < b.guess.site.candidate.companyKey ? -1 : a.guess.site.candidate.companyKey > b.guess.site.candidate.companyKey ? 1 : 0));

  return { stages: { seed, locate, detect, verify }, seeded, merged, selected, dropped, denied, sites, guesses, verdicts };
}
