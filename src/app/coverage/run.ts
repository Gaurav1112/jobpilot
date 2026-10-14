import type { Clock } from '../../kernel/clock.js';
import { policyHash } from '../../kernel/policy.js';
import type { FetchLike } from '../../kernel/providers.js';
import { codeHash } from '../code-hash.js';
import { coverageWeek, otherRunOwed } from '../due.js';
import { ensureHome } from '../home.js';
import { loadRunPack } from '../kernel.js';
import { withLock } from '../lock.js';
import type { Notifier } from '../notify.js';
import { homePaths } from '../pack/paths.js';
import { fullChainCheck } from '../chain-status.js';
import { runProblems, type Problem } from '../problems.js';
import { runCounts, type AgentCounts } from '../project.js';
import { istDate, istMonth, nonceOf, pickRunId } from '../run.js';
import { AppStore } from '../store/app-store.js';
import { makeRunGate } from './gate.js';
import { COVERAGE_PIPELINE, coveragePolicy, coverageSeeds, runCoverageStages, STAGES, storedCandidates, type CoverageStagesOutcome, type StageId } from './pipeline.js';
import { coverageNotification, deferralHosts, deferralLine, projectCoverage, registryCounts, type CoverageProjection, type RegistryCounts } from './project.js';
import { registryPickItems, seedItemsFromJobs } from './seed.js';
import type { CandidateSource, CareersSite } from './types.js';

/** The umbrella run's pipeline label in the `runs` table; each stage runs as `<runId>.<stage>` (see pipeline.ts). */
const PIPELINE = COVERAGE_PIPELINE.id;
/** The event marking that a run's verdicts reached the registry (once per run, so a resume never projects twice). */
const PROJECTED = 'coverage.projected';
/** The event of an invocation that paused between steps (it yielded, or hit its slice limit). */
const PAUSED = 'coverage.paused';
/** The event closing an earlier week's unfinished run (week rollover). */
const CLOSED = 'coverage.closed';

/**
 * The incomplete coverage run of this coverage week with this policy, if any (the newest): a paused or crashed run is
 * continued by the next invocation, on any day of the week, under its own run id (so its host state carries over).
 */
function resumableInWeek(app: AppStore, week: string, pHash: string): string | undefined {
  const rows = app.kernel.db.prepare(`SELECT run_id FROM runs WHERE pipeline = ? AND status <> 'completed' AND policy_hash = ? ORDER BY started_at DESC, run_id DESC`).all(PIPELINE, pHash) as { run_id: string }[];
  return rows.map((r) => r.run_id).find((id) => {
    const date = /^coverage-(\d{4}-\d{2}-\d{2})(?:-\d+)?$/.exec(id)?.[1];
    return date !== undefined && coverageWeek(`${date}T12:00:00.000Z`) === week;
  });
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Week rollover: an incomplete coverage run of an EARLIER coverage week (paused or crashed, never finished) is closed
 * as incomplete: a `coverage.closed` event `{status: 'incomplete', finished, deferredOrFailed, total}` (the kernel's
 * run row stays `running`, its only other state being completed), and one line each, `Coverage last week did not
 * finish: N of M candidates finished (k deferred or failed)` (M: the candidates its locate stage had, or its merged
 * seed candidates if it never reached the locator; N: those whose locate step finished; k: of those, the ones whose
 * step failed or was deferred). Nothing of it was projected (a
 * run projects only when it completes), so the registry keeps last known verdicts. Closed once; never resumed.
 */
function closeEarlierWeeks(app: AppStore, week: string, now: string): string[] {
  const rows = app.kernel.db.prepare(`SELECT run_id, policy_hash FROM runs WHERE pipeline = ? AND status <> 'completed' ORDER BY run_id`).all(PIPELINE) as { run_id: string; policy_hash: string }[];
  const lines: string[] = [];
  for (const r of rows) {
    const date = /^coverage-(\d{4}-\d{2}-\d{2})(?:-\d+)?$/.exec(r.run_id)?.[1];
    if (date === undefined || coverageWeek(`${date}T12:00:00.000Z`) >= week) continue;
    if (app.kernel.events(r.run_id).some((e) => e.kind === CLOSED)) continue;
    const items = app.kernel.queueItems(`${r.run_id}.locate`);
    const finished = items.filter((q) => q.status !== 'pending').length;
    const unfinished = items.filter((q) => q.status === 'failed' || q.status === 'skipped' || q.status === 'quarantined').length;
    const total = items.length > 0 ? items.length : storedCandidates(app.kernel, r.run_id).length;
    app.kernel.appendEvent(r.run_id, now, CLOSED, { status: 'incomplete', finished, deferredOrFailed: unfinished, total }, r.policy_hash);
    lines.push(`Coverage last week did not finish: ${finished} of ${total} candidates finished (${unfinished} deferred or failed)`);
  }
  return lines;
}

/** The default yield check: `otherRunOwed` on this home, read at most every YIELD_CHECK_EVERY_MS of the clock. */
function defaultYieldCheck(home: string): (now: string) => string | null {
  let last: { at: number; reason: string | null } | undefined;
  return (now) => {
    const t = Date.parse(now);
    if (last === undefined || t - last.at >= YIELD_CHECK_EVERY_MS) last = { at: t, reason: otherRunOwed(home, now) };
    return last.reason;
  };
}

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
  /** The longest one invocation runs (wall time, the injected clock) before it pauses; default COVERAGE_SLICE_MS. Checks may lower it (`--slice-minutes`). */
  readonly sliceMs?: number;
  /** The weekly full audit needs at least this much of the slice left, else it waits for the next invocation; default AUDIT_RESERVE_MS. */
  readonly auditReserveMs?: number;
  /**
   * Asked before each step: a reason to yield (the daily or freelance run is owed now or within 5 minutes), or null.
   * Default: `otherRunOwed` on this home, asked at most every YIELD_CHECK_EVERY_MS of the clock. `--no-yield` (checks)
   * and tests pass `() => null`.
   */
  readonly yieldCheck?: (now: string) => string | null;
}

/** One invocation's time slice: then it pauses between steps and the next `run-coverage` continues the same run. */
export const COVERAGE_SLICE_MS = 90 * 60_000;
/** How often (clock time) the default yield check reads the due state. */
export const YIELD_CHECK_EVERY_MS = 30_000;

/**
 * The weekly full audit (dashboard-perf): the dashboard's `/runs` checks only the events after its verified point, so
 * the whole event chain is walked once a week here, when a coverage week completes, outside every pipeline step (no
 * step key, envelope or golden changes), through the same code as `jobpilot audit verify` (`fullChainCheck`, which
 * records the full-check checkpoint when it passes). A walk of ~500k events takes a few seconds (5 s cold measured):
 * with less than AUDIT_RESERVE_MS of the slice left it is owed instead (`AUDIT_PENDING_KEY`) and runs at the start of
 * the next invocation, before any step. A broken chain is never hidden: an `audit-broken` problem, the first line of
 * the notification, and exit 1.
 */
export const AUDIT_RESERVE_MS = 5 * 60_000;
/** app_settings: the coverage run whose full audit is owed (deferred for want of slice time). */
export const AUDIT_PENDING_KEY = 'audit.full_check_pending';

export type CoverageAudit =
  | { readonly status: 'ok'; readonly events: number }
  | { readonly status: 'broken'; readonly seq: number; readonly reason: string }
  | { readonly status: 'deferred' };

function fullAudit(app: AppStore, at: string): CoverageAudit {
  const r = fullChainCheck(app.kernel, at);
  if (r.ok) return { status: 'ok', events: r.events };
  return 'headMismatch' in r ? { status: 'broken', seq: 0, reason: r.reason } : { status: 'broken', seq: r.brokenAt, reason: r.reason };
}

const brokenLine = (a: Extract<CoverageAudit, { status: 'broken' }>): string => `audit chain broken at seq ${a.seq}: ${a.reason}`;

const auditProblem = (a: Extract<CoverageAudit, { status: 'broken' }>): Problem => ({ kind: 'audit-broken', agent: 'audit', item: `seq ${a.seq}`, reason: brokenLine(a) });

function auditText(a: CoverageAudit): string {
  if (a.status === 'ok') return `audit: the event chain is intact (${a.events} events, full check)`;
  if (a.status === 'deferred') return 'audit: the full check of the event chain runs at the start of the next run-coverage (too little of this slice was left)';
  return `AUDIT CHAIN BROKEN at seq ${a.seq}: ${a.reason}. Keep a copy of the database and run "jobpilot audit verify".`;
}

/** An invocation that stopped between steps: the run stays incomplete; the next `run-coverage` (or `--if-due` start) resumes it. */
export interface CoverageSlice {
  readonly status: 'paused';
  readonly runId: string;
  readonly runDate: string;
  readonly week: string;
  readonly resumed: boolean;
  /** `yielded to daily`, `yielded to freelance` or `slice limit`. */
  readonly reason: string;
  /** The stage it stopped in. */
  readonly stage: StageId;
  readonly warnings: string[];
  /** The owed full audit, when this invocation ran it before its first step. */
  readonly audit?: CoverageAudit;
  /** 1 only when that audit found the chain broken. */
  readonly exitCode: 0 | 1;
}

export type CoverageResult = CoverageSummary | CoverageSlice;

export interface CoverageSummary {
  readonly status: 'completed';
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
  /** The weekly full audit of the event chain: run now, deferred to the next invocation, or broken. */
  readonly audit: CoverageAudit;
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
export function runCoverage(o: CoverageRunOptions): Promise<CoverageResult> {
  return withLock(o.home, 'run-coverage', async () => {
    o.onLocked?.();
    const paths = homePaths(o.home);
    ensureHome(paths.home);
    const app = AppStore.open(paths.db, { schema: 'migrate' }); // inside the run lock
    try {
      const now = o.clock.now();
      const runDate = istDate(now);
      const week = coverageWeek(now);
      const loaded = loadRunPack(paths.pack, app.factOverrides(), istMonth(now), nonceOf(app), 'strict');
      const policy = coveragePolicy(loaded.pack);
      const pHash = policyHash(policy);
      const rolled = closeEarlierWeeks(app, week, now);
      const ongoing = resumableInWeek(app, week, pHash);
      const { runId, resume, skipped } = ongoing !== undefined ? { runId: ongoing, resume: true, skipped: [] as string[] } : pickRunId(app.kernel, `coverage-${runDate}`, pHash);
      const warnings = [...loaded.warnings, ...skipped.map((id) => `run ${id} did not complete and used another policy, so it was not resumed; it stays incomplete`), ...rolled];
      for (const line of rolled) {
        try {
          await o.notifier?.(line);
        } catch (e) {
          warnings.push(`the notification could not be posted: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // an owed full audit (a completed week that had too little slice left) runs first, before any step
      let owedAudit: CoverageAudit | undefined;
      if (app.getSetting(AUDIT_PENDING_KEY) !== undefined) {
        owedAudit = fullAudit(app, now);
        app.deleteSetting(AUDIT_PENDING_KEY);
        if (owedAudit.status === 'broken') {
          const line = brokenLine(owedAudit);
          try {
            await o.notifier?.(line);
          } catch (e) {
            warnings.push(`the notification could not be posted: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      if (!resume) app.kernel.startRun(runId, PIPELINE, pHash, now);
      const gate = makeRunGate({ runKey: runId, store: app });
      const sliceEnd = Date.parse(now) + (o.sliceMs ?? COVERAGE_SLICE_MS);
      const yieldCheck = o.yieldCheck ?? defaultYieldCheck(o.home);
      // the slice limit applies once this invocation has done a step, so every slice makes progress
      let stepsThisSlice = 0;
      const afterStep = (n: number): void => {
        stepsThisSlice++;
        o.afterStep?.(n);
      };
      const pauseBefore = (): string | null => {
        const at = o.clock.now();
        return yieldCheck(at) ?? (stepsThisSlice > 0 && Date.parse(at) >= sliceEnd ? 'slice limit' : null);
      };
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
        seeds: coverageSeeds(week, [...loaded.companies, ...registryPickItems(app, loaded.companies)], seedItemsFromJobs(app)),
        ...(o.limit !== undefined ? { limit: o.limit } : {}),
        afterStep,
        pauseBefore,
      });
      if ('paused' in outcome) {
        // between steps: nothing is projected or announced; the next invocation resumes this run id
        app.kernel.appendEvent(runId, o.clock.now(), PAUSED, { reason: outcome.paused, stage: outcome.stage }, pHash);
        return {
          status: 'paused', runId, runDate, week, resumed: resume, reason: outcome.paused, stage: outcome.stage, warnings,
          ...(owedAudit !== undefined ? { audit: owedAudit } : {}),
          exitCode: owedAudit?.status === 'broken' ? 1 : 0,
        };
      }
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
      const details = (stages: readonly StageId[]) => stages.flatMap((st) => outcome.stages[st].deferred.map((d) => d.detail));
      const notLocated = details(['seed', 'locate', 'detect']);
      const notVerified = details(['verify']);
      const deferrals = [deferralLine(notLocated.length, deferralHosts(notLocated)), deferralLine(notVerified.length, deferralHosts(notVerified), 'verified')];
      const deferral = deferrals.filter((d): d is string => d !== null);
      // the week is complete: the weekly full audit, now if the slice allows (an owed one already ran at the start)
      const auditAt = o.clock.now();
      const audit: CoverageAudit =
        owedAudit !== undefined
          ? owedAudit
          : sliceEnd - Date.parse(auditAt) < (o.auditReserveMs ?? AUDIT_RESERVE_MS)
            ? { status: 'deferred' }
            : fullAudit(app, auditAt);
      if (audit.status === 'deferred') app.setSetting(AUDIT_PENDING_KEY, runId);
      const notification = [...(audit.status === 'broken' ? [brokenLine(audit)] : []), coverageNotification({ ...registry, newVerified: projection.newVerified }, deferral)].join(' · ');
      const problems = [...(audit.status === 'broken' ? [auditProblem(audit)] : []), ...STAGES.flatMap((s) => runProblems(app.kernel, outcome.stages[s].runId, loaded.pack.naming))];
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
        status: 'completed',
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
        audit,
        policyHash: pHash,
        warnings,
      };
      const exitCode: 0 | 1 = STAGES.some((s) => outcome.stages[s].broken > 0) || audit.status === 'broken' ? 1 : 0;
      app.recordRun({ runId, at: now, counts: coverageCounts(app, outcome), packHash: loaded.companiesHash, policyHash: pHash, warnings: [...warnings, ...deferral], problems });
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

/** The coverage run summary as the CLI prints it (a paused slice: one line, and how it goes on). */
export function formatCoverageSummary(s: CoverageResult): string {
  if (s.status === 'paused') {
    return [
      `run ${s.runId} for ${s.runDate} (coverage week ${s.week})${s.resumed ? ', resumed' : ''}: paused in ${s.stage} (${s.reason}); the next run-coverage continues it`,
      ...(s.audit !== undefined ? [auditText(s.audit)] : []),
      ...s.warnings.map((w) => `warning: ${w}`),
    ].join('\n');
  }
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
    `not located: ${s.projection.unlocated.counted} (seed lists, counted only); picks not located (proposed): ${s.projection.unlocated.proposed}; live companies not located (a failed week): ${s.projection.unlocated.failed}`,
    `deferred by a disabled host: ${s.deferred.total} (${kv(s.deferred.byStage)}), behind ${s.deferred.hosts.length} host(s); hosts disabled in the run: ${s.deferred.disabledHosts}`,
    `registry: verified ${s.registry.verified}, proposed ${s.registry.proposed}, failing ${s.registry.failing}, failed ${s.registry.failed}, rejected ${s.registry.rejected}`,
  ];
  if (s.problems.length > 0) {
    lines.push(`problems: ${s.problems.length}`);
    for (const q of s.problems.slice(0, 50)) lines.push(`  ${q.kind.padEnd(14)} ${q.agent}  ${q.item}: ${q.reason}`);
    if (s.problems.length > 50) lines.push(`  … and ${s.problems.length - 50} more (the dashboard's runs view lists them all)`);
  }
  lines.push(auditText(s.audit));
  lines.push(`notification: ${s.notification}`);
  lines.push(`policy ${s.policyHash.slice(0, 12)}`);
  for (const w of s.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}
