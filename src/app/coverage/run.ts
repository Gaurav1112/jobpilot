import type { Clock } from '../../kernel/clock.js';
import { policyHash } from '../../kernel/policy.js';
import type { FetchLike } from '../../kernel/providers.js';
import { codeHash } from '../code-hash.js';
import { coverageWeek } from '../due.js';
import { ensureHome } from '../home.js';
import { loadRunPack } from '../kernel.js';
import { withLock } from '../lock.js';
import type { Notifier } from '../notify.js';
import { homePaths } from '../pack/paths.js';
import { runProblems, type Problem } from '../problems.js';
import { runCounts, type AgentCounts } from '../project.js';
import { istDate, istMonth, nonceOf, pickRunId } from '../run.js';
import { AppStore } from '../store/app-store.js';
import { makeRunGate } from './gate.js';
import { COVERAGE_PIPELINE, coveragePolicy, coverageSeeds, runCoverageStages, STAGES, type CoverageStagesOutcome, type StageId } from './pipeline.js';
import { coverageNotification, deferralHosts, deferralLine, projectCoverage, registryCounts, type CoverageProjection, type RegistryCounts } from './project.js';
import { seedItemsFromJobs } from './seed.js';
import type { CandidateSource, CareersSite } from './types.js';

/** The umbrella run's pipeline label in the `runs` table; each stage runs as `<runId>.<stage>` (see pipeline.ts). */
const PIPELINE = COVERAGE_PIPELINE.id;
/** The event marking that a run's verdicts reached the registry (once per run, so a resume never projects twice). */
const PROJECTED = 'coverage.projected';
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface CoverageRunOptions {
  readonly home: string;
  readonly clock: Clock;
  readonly fetch: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Posts the weekly line. Absent (`--no-notify`): nothing is posted. */
  readonly notifier?: Notifier;
  /**
   * For checks only (`run-coverage --limit N`): every pick plus the first N other candidates in companyKey order go to
   * the locator; the rest are left out of this run (named in a warning). The scheduled run never sets it.
   */
  readonly limit?: number;
  readonly codeHash?: string;
  readonly afterStep?: (count: number) => void;
  readonly onLocked?: () => void;
}

export interface CoverageSummary {
  readonly runId: string;
  readonly runDate: string;
  /** The coverage week (its Sunday); every seed carries it, so a second run in the week replays. */
  readonly week: string;
  readonly resumed: boolean;
  /** The company picks in companies.yaml (read strictly: a malformed file refuses the run). */
  readonly picks: number;
  /** Candidates per source after the merge, and how many went to the locator. */
  readonly candidates: { readonly bySource: Readonly<Record<CandidateSource, number>>; readonly merged: number; readonly selected: number; readonly dropped: number; readonly denied: number };
  /** One note per candidate the cross-source merge dropped (`mergeCandidates`: it lost its companyKey to a higher source). */
  readonly mergeNotes: readonly string[];
  /** Located careers sites by locator method (`none`: nothing found). */
  readonly located: Readonly<Record<CareersSite['method'], number>>;
  /** Detected platforms (`none`: no platform), over the located sites. */
  readonly platforms: Readonly<Record<string, number>>;
  readonly verdicts: { readonly verified: number; readonly proposed: number; readonly failed: number };
  /** Steps deferred by a disabled host, per stage; the hosts that deferred them; how many hosts the run disabled in all. */
  readonly deferred: { readonly byStage: Readonly<Record<StageId, number>>; readonly total: number; readonly hosts: readonly (readonly [string, string])[]; readonly disabledHosts: number };
  readonly projection: CoverageProjection;
  readonly registry: RegistryCounts;
  readonly problems: readonly Problem[];
  readonly notification: string;
  readonly notified: boolean;
  readonly policyHash: string;
  readonly warnings: string[];
  readonly exitCode: 0 | 1;
}

const count = <K extends string>(keys: readonly K[], values: readonly K[]): Record<K, number> => {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
};

const METHODS: readonly CareersSite['method'][] = ['listed', 'homepage-link', 'path', 'subdomain', 'sitemap', 'none'];
const SOURCES: readonly CandidateSource[] = ['pick', 'remoteintech', 'yc', 'jobs'];

/** Whether another coverage run already projected its verdicts in this coverage week (then failures are not counted again). */
function weekAlreadyProjected(app: AppStore, week: string, runId: string): boolean {
  const runs = app.kernel.db.prepare(`SELECT run_id FROM runs WHERE pipeline = ? AND run_id <> ?`).all(PIPELINE, runId) as { run_id: string }[];
  return runs.some((r) => app.kernel.events(r.run_id).some((e) => e.kind === PROJECTED && (JSON.parse(e.data) as { week?: unknown }).week === week));
}

/** The run's counts per agent across its stages, with host-disabled deferrals apart from input rejections (the dashboard shows both). */
function coverageCounts(app: AppStore, outcome: CoverageStagesOutcome): { byAgent: Record<string, AgentCounts & { deferred: number }>; totals: AgentCounts & { deferred: number } } {
  const byAgent: Record<string, AgentCounts & { deferred: number }> = {};
  const totals = { done: 0, failed: 0, gone: 0, inputRejected: 0, quarantined: 0, skipped: 0, pending: 0, replayed: 0, deferred: 0 };
  for (const s of STAGES) {
    const r = outcome.stages[s];
    const c = runCounts(app.kernel, r.runId);
    for (const [agent, a] of Object.entries(c.byAgent)) {
      const deferred = r.deferred.length;
      const row = { ...a, inputRejected: a.inputRejected - deferred, deferred };
      byAgent[agent] = row;
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += row[k];
    }
  }
  return { byAgent, totals };
}

/**
 * `jobpilot run-coverage`: one weekly coverage run under the run lock (spec §3):
 * 1. load the pack with companies.yaml STRICT (a malformed one refuses the run, unlike the daily and freelance runs);
 * 2. resolve the run id `coverage-<IST date>[-n]` with the coverage policy's hash (a completed one moves to `-2`, an
 *    incomplete one with the same policy is resumed);
 * 3. run the four stages (`runCoverageStages`): seeds dated with the coverage week, ONE run gate keyed by the run id;
 * 4. project the verdicts into the `companies` registry once per run (`projectCoverage`; failures counted once per week);
 * 5. post the weekly line `Coverage: N verified (+k new) · p proposed · f failing` (plus the deferral line), record the
 *    run for the dashboard's runs view and a `coverage.summary` event, and complete the run.
 * Coverage only writes the registry: nothing here touches the daily pipeline, which reads whatever registry exists.
 */
export function runCoverage(o: CoverageRunOptions): Promise<CoverageSummary> {
  return withLock(o.home, 'run-coverage', async () => {
    o.onLocked?.();
    const paths = homePaths(o.home);
    ensureHome(paths.home);
    const app = AppStore.open(paths.db);
    try {
      const now = o.clock.now();
      const runDate = istDate(now);
      const week = coverageWeek(now);
      const loaded = loadRunPack(paths.pack, app.factOverrides(), istMonth(now), nonceOf(app), 'strict');
      const policy = coveragePolicy(loaded.pack);
      const pHash = policyHash(policy);
      const { runId, resume, skipped } = pickRunId(app.kernel, `coverage-${runDate}`, pHash);
      const warnings = [...loaded.warnings, ...skipped.map((id) => `run ${id} did not complete and used another policy, so it was not resumed; it stays incomplete`)];
      if (!resume) app.kernel.startRun(runId, PIPELINE, pHash, now);
      const gate = makeRunGate({ runKey: runId, store: app });
      const outcome = await runCoverageStages({
        store: app.kernel,
        runId,
        gate,
        policy,
        policyHash: pHash,
        clock: o.clock,
        sleep: o.sleep ?? realSleep,
        fetch: o.fetch,
        codeHash: o.codeHash ?? codeHash(),
        seeds: coverageSeeds(week, loaded.companies, seedItemsFromJobs(app)),
        ...(o.limit !== undefined ? { limit: o.limit } : {}),
        ...(o.afterStep ? { afterStep: o.afterStep } : {}),
      });
      for (const n of outcome.denied) warnings.push(n);
      if (o.limit !== undefined && outcome.selected.length < outcome.merged.length - outcome.denied.length) {
        warnings.push(`--limit ${o.limit}: ${outcome.selected.length} of ${outcome.merged.length} candidates were located this run (every pick plus the first ${o.limit} others); the rest were left out`);
      }

      const deferredSites = new Set(outcome.stages.locate.deferred.map((d) => (d.input as { companyKey: string }).companyKey));
      const unlocated = outcome.sites.filter((s) => s.careersUrl === null && !deferredSites.has(s.candidate.companyKey));
      const prior = app.kernel.events(runId).find((e) => e.kind === PROJECTED);
      let projection: CoverageProjection;
      if (prior === undefined) {
        const countFailures = !weekAlreadyProjected(app, week, runId);
        projection = app.tx(() => {
          const p = projectCoverage(app, { verdicts: outcome.verdicts, unlocated, at: now, countFailures });
          app.kernel.appendEvent(runId, now, PROJECTED, { week, countFailures, newVerified: p.newVerified, unlocated: p.unlocated }, pHash);
          return p;
        });
      } else {
        const d = JSON.parse(prior.data) as { newVerified: number; unlocated: CoverageProjection['unlocated'] };
        projection = { newVerified: d.newVerified, unlocated: d.unlocated, registry: registryCounts(app) };
      }
      const registry = registryCounts(app);

      const byStage = Object.fromEntries(STAGES.map((s) => [s, outcome.stages[s].deferred.length])) as Record<StageId, number>;
      const totalDeferred = STAGES.reduce((n, s) => n + byStage[s], 0);
      const hosts = deferralHosts(STAGES.flatMap((st) => outcome.stages[st].deferred.map((d) => d.detail)));
      const disabledHosts = app.coverageHostState(runId).size;
      const deferral = deferralLine(totalDeferred, hosts);
      const notification = coverageNotification({ ...registry, newVerified: projection.newVerified }, deferral);
      const problems = STAGES.flatMap((s) => runProblems(app.kernel, outcome.stages[s].runId, loaded.pack.naming));
      let notified = false;
      if (o.notifier !== undefined) {
        try {
          await o.notifier(notification);
          notified = true;
        } catch (e) {
          warnings.push(`the notification could not be posted: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const located = count(METHODS, outcome.sites.map((s) => s.method));
      const platforms: Record<string, number> = {};
      for (const g of outcome.guesses) platforms[g.platform ?? 'none'] = (platforms[g.platform ?? 'none'] ?? 0) + 1;
      const verdicts = { verified: 0, proposed: 0, failed: 0 };
      for (const v of outcome.verdicts) verdicts[v.status]++;
      const summary: Omit<CoverageSummary, 'exitCode'> = {
        runId,
        runDate,
        week,
        resumed: resume,
        picks: loaded.companies.length,
        candidates: { bySource: count(SOURCES, outcome.merged.map((c) => c.source)), merged: outcome.merged.length, selected: outcome.selected.length, dropped: outcome.dropped.length, denied: outcome.denied.length },
        mergeNotes: outcome.dropped,
        located,
        platforms: Object.fromEntries(Object.entries(platforms).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        verdicts,
        deferred: { byStage, total: totalDeferred, hosts, disabledHosts },
        projection,
        registry,
        problems,
        notification,
        notified,
        policyHash: pHash,
        warnings,
      };
      const exitCode: 0 | 1 = STAGES.some((s) => outcome.stages[s].broken > 0) ? 1 : 0;
      app.recordRun({ runId, at: now, counts: coverageCounts(app, outcome), packHash: loaded.companiesHash, policyHash: pHash, warnings: [...warnings, ...(deferral === null ? [] : [deferral])], problems });
      app.kernel.appendEvent(runId, now, 'coverage.summary', { picks: summary.picks, companiesHash: loaded.companiesHash, candidates: summary.candidates, mergeNotes: outcome.dropped, located, platforms: summary.platforms, verdicts, deferred: summary.deferred, registry, notification }, pHash);
      app.kernel.finishRun(runId, o.clock.now());
      return { ...summary, exitCode };
    } finally {
      app.close();
    }
  });
}

const kv = (r: Readonly<Record<string, number>>): string =>
  Object.entries(r)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ') || 'none';

/** The coverage run summary as the CLI prints it. */
export function formatCoverageSummary(s: CoverageSummary): string {
  const c = s.candidates;
  const lines = [
    `run ${s.runId} for ${s.runDate} (coverage week ${s.week})${s.resumed ? ', resumed' : ''}: completed`,
    `company picks: ${s.picks}`,
    `candidates: ${c.merged} after the merge (${kv(c.bySource)}); ${c.dropped} dropped as duplicates; ${c.denied} on a policy-denied host; ${c.selected} sent to the locator`,
    ...s.mergeNotes.slice(0, 20).map((n) => `  ${n}`),
    ...(s.mergeNotes.length > 20 ? [`  … and ${s.mergeNotes.length - 20} more merge notes (in the coverage.summary event)`] : []),
    `located: ${kv(s.located)}`,
    `platforms: ${kv(s.platforms)}`,
    `verdicts: verified ${s.verdicts.verified}, proposed ${s.verdicts.proposed}, failed ${s.verdicts.failed}`,
    `not located (counted only): ${s.projection.unlocated.counted}; picks proposed unlocated: ${s.projection.unlocated.proposed}; live companies not located: ${s.projection.unlocated.failed}`,
    `deferred by a disabled host: ${s.deferred.total} (${kv(s.deferred.byStage)}), behind ${s.deferred.hosts.length} host(s); hosts disabled in the run: ${s.deferred.disabledHosts}`,
    `registry: verified ${s.registry.verified}, proposed ${s.registry.proposed}, failing ${s.registry.failing}, failed ${s.registry.failed}, rejected ${s.registry.rejected}`,
  ];
  if (s.problems.length > 0) {
    lines.push(`problems: ${s.problems.length}`);
    for (const q of s.problems.slice(0, 50)) lines.push(`  ${q.kind.padEnd(14)} ${q.agent}  ${q.item}: ${q.reason}`);
    if (s.problems.length > 50) lines.push(`  … and ${s.problems.length - 50} more (the dashboard's runs view lists them all)`);
  }
  lines.push(`notification: ${s.notification}`);
  lines.push(`policy ${s.policyHash.slice(0, 12)}`);
  for (const w of s.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}
