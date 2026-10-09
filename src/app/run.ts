import type { Clock } from '../kernel/clock.js';
import { KernelError } from '../kernel/errors.js';
import type { BrowserProvider, FetchLike } from '../kernel/providers.js';
import type { Store } from '../kernel/store/store.js';
import type { RunReport } from '../kernel/supervisor.js';
import type { CoverPlan } from './types.js';
import { diskDocCheck } from './docs-check.js';
import { appKernel, loadRunPack, resolvePdftotext, type RunPack } from './kernel.js';
import { withLock } from './lock.js';
import { notificationFor, type Notifier } from './notify.js';
import { homePaths } from './pack/paths.js';
import { DAILY_PIPELINE, dailySeeds } from './pipeline.js';
import { runProblems, type Problem } from './problems.js';
import { projectDocs, projectRun, runCounts, type AgentCounts, type DocsChange, type ProjectResult, type RunCounts } from './project.js';
import { AppStore, type DocsState } from './store/app-store.js';
import { ensureHome } from './home.js';

/** India Standard Time is UTC+05:30 all year. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

/** The calendar date in India (YYYY-MM-DD) at an ISO instant. */
export function istDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`not an ISO time: ${iso}`);
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The month in India (YYYY-MM) at an ISO instant: the run's `experience.asOf`. */
export const istMonth = (iso: string): string => istDate(iso).slice(0, 7);

/** The app setting holding the docs-rebuild counter that goes into the full pack as `render.nonce`. */
export const RENDER_NONCE_KEY = 'render.nonce';

/** The source agents (team sourcing); a run whose source steps all replayed fetched nothing. */
const SOURCE_PREFIX = 'src-';
export const REFRESH_HINT = 'All sources were already fetched today; use --refresh to fetch again';

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The run id for `prefix` (`daily-<runDate>`): the first of `prefix`, `prefix-2`, `prefix-3`, … that is not a
 * completed run, with its ordinal `n` (1 for `prefix`). A run that exists but never completed (a crash) is resumed
 * under its own id, unless it ran under another policy (the supervisor refuses to resume that): it is left as it is,
 * named in `skipped`, and the next id is used.
 */
export function pickRunId(store: Store, prefix: string, policyHash: string): { runId: string; n: number; resume: boolean; skipped: string[] } {
  const skipped: string[] = [];
  for (let n = 1; ; n++) {
    const runId = n === 1 ? prefix : `${prefix}-${n}`;
    const run = store.getRun(runId);
    if (!run) return { runId, n, resume: false, skipped };
    if (run.status === 'completed') continue;
    if (run.policy_hash === policyHash) return { runId, n, resume: true, skipped };
    skipped.push(runId);
  }
}

const skippedWarnings = (skipped: readonly string[]): string[] =>
  skipped.map((id) => `run ${id} did not complete and used another policy, so it was not resumed; it stays incomplete`);

/** m5: incomplete daily runs of earlier dates are never resumed; say so on every run until they are dealt with. */
function staleRunWarnings(store: Store, prefix: string, skipped: readonly string[]): string[] {
  return store
    .incompleteRuns()
    .filter((r) => r.run_id.startsWith('daily-') && !r.run_id.startsWith(prefix) && !skipped.includes(r.run_id))
    .map((r) => `run ${r.run_id} never completed and is from an earlier date; it will not be resumed`);
}

export interface RunOutcome {
  readonly runId: string;
  /** The IST date the run is for (the seeds' `runDate`). */
  readonly runDate: string;
  /** The pack's `experience.asOf` for this run. */
  readonly asOf: string;
  /** True when a crashed run with this id was continued. */
  readonly resumed: boolean;
  readonly report: RunReport;
  /** Per agent: done, replayed, failed, gone, input-rejected, skipped, quarantined (and pending). */
  readonly counts: RunCounts;
  /** Every item the run did not carry through, named (review I1). */
  readonly problems: readonly Problem[];
  readonly packHash: string;
  readonly fullPackHash: string;
  readonly policyHash: string;
  readonly warnings: string[];
  /** 1 when any step failed (other than gone or input_rejected) or was quarantined; else 0. */
  readonly exitCode: 0 | 1;
}

export interface DailySummary extends RunOutcome {
  readonly projection: ProjectResult;
  readonly notification: string;
  readonly notified: boolean;
  readonly refresh: boolean;
}

export interface RunOptions {
  /** JOBPILOT_HOME: `pack/`, `out/`, `jobpilot.db` and the lock live here. */
  readonly home: string;
  readonly clock: Clock;
  readonly fetch: FetchLike;
  /** Needed when the watchlist has careers entries. The caller owns it (and closes it). */
  readonly browser?: BrowserProvider;
  /** Posts the notification. Absent (`--no-notify`): nothing is posted and no job is marked announced. */
  readonly notifier?: Notifier;
  /**
   * Fetch again on the same day: the seeds carry `attempt` = this run's ordinal (`daily-<date>-<n>`, n >= 2), so every
   * source step runs again. Career listings are re-read; an unchanged career job page still replays (CareerLink is dateless).
   */
  readonly refresh?: boolean;
  /** Default: real time. Tests pass a no-op; production must not. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Absolute path of pdftotext; default `resolvePdftotext()`. */
  readonly pdftotext?: string;
  /** Test hook: runs after each step; throwing simulates a crash. */
  readonly afterStep?: (count: number) => void;
  /** Test hook: runs after the projection, before the notification; throwing simulates a crash there. */
  readonly afterProject?: () => void;
}

/**
 * What the notification announces (R-I2): every job whose documents are ready and that no posted notification has
 * announced yet, whenever it became ready (first seen today, made ready by a fact override or a rebuild, or left over
 * by a run whose notification failed or crashed). The backlog that existed before announcements (rows present when
 * the column was added, Desk imports) is stamped and never announced. Duplicate listings excluded.
 */
function newMatches(app: AppStore): { jobKey: string; score: number | null; company: string; title: string }[] {
  return app
    .listJobs({ band: ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'] })
    .filter((j) => j.docsState === 'ready' && j.notifiedAt === null);
}

/** The kept docs-rebuild counter, validated (review m6). */
export function nonceOf(app: AppStore): number | undefined {
  const v = app.getSetting(RENDER_NONCE_KEY);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`app setting ${RENDER_NONCE_KEY} is not a positive integer: ${v}`);
  return n;
}

/** Ruling 4: gone and input-rejected items are problems (listed and counted) but not failures of the run. */
const exitCodeOf = (report: RunReport): 0 | 1 => (report.queue.failed - report.gone - report.inputRejected > 0 || report.queue.quarantined > 0 ? 1 : 0);

/** Whether this run had source steps and every one of them was answered from the store. */
function sourcesAllReplayed(counts: RunCounts): boolean {
  const sources = Object.entries(counts.byAgent).filter(([a]) => a.startsWith(SOURCE_PREFIX));
  const steps = sources.reduce((n, [, c]) => n + c.done + c.failed + c.quarantined, 0);
  return steps > 0 && sources.every(([, c]) => c.replayed === c.done + c.quarantined && c.failed === 0);
}

/**
 * `jobpilot run`: one daily run under the lock (spec §1, §8).
 * 1. Load the pack with the user's fact overrides, `experience.asOf` = the IST month of `clock` and the kept
 *    `render.nonce`; hash it.
 * 2. Wire the pipeline (allow-list, wiring proof, pacing check) and seed one request per watchlist entry and feed,
 *    dated with today's IST date (and, with `refresh`, this run's ordinal as `attempt`).
 * 3. Run as `daily-<runDate>` (or `daily-<runDate>-<n>` when that one completed; a crashed one is resumed), project
 *    the outputs into the app tables.
 * 4. Name every problem; notify: `<N> new matches · top: … · <k> problems`, or `No new matches today`. Every ready
 *    job is announced once, by the first notification actually posted after it became ready (`notified_at`).
 * 5. Record the run summary, with its warnings and problems.
 * Same-day replay is the default: the seeds carry the date, so a second run that day fetches nothing (a hint says so).
 */
export function runDaily(o: RunOptions): Promise<DailySummary> {
  return withLock(o.home, 'run', async () => {
    const paths = homePaths(o.home);
    ensureHome(paths.home);
    const pdftotext = o.pdftotext ?? resolvePdftotext();
    const app = AppStore.open(paths.db);
    try {
      const now = o.clock.now();
      const runDate = istDate(now);
      const loaded = loadRunPack(paths.pack, app.factOverrides(), istMonth(now), nonceOf(app));
      const k = appKernel({ store: app.kernel, loaded, outDir: paths.out, clock: o.clock, sleep: o.sleep ?? realSleep, fetch: o.fetch, ...(o.browser ? { browser: o.browser } : {}), pdftotext, ...(o.afterStep ? { afterStep: o.afterStep } : {}) });
      const prefix = `daily-${runDate}`;
      const { runId, n, resume, skipped } = pickRunId(app.kernel, prefix, k.policyHash);
      const warnings = [...skippedWarnings(skipped), ...staleRunWarnings(app.kernel, prefix, skipped)];
      const seeds = dailySeeds(loaded.pack, runDate, o.refresh === true ? n : undefined);
      if (seeds.length === 0) warnings.push('the watchlist and feeds are empty: nothing was fetched');
      const report = resume ? await k.supervisor.resume(runId) : await k.supervisor.start(runId, seeds);
      const projection = projectRun(app.kernel, app, runId, { minFit: loaded.pack.targets.minFit, fx: loaded.pack.fx, docOnDisk: diskDocCheck(paths.out) });
      const counts = runCounts(app.kernel, runId);
      if (o.refresh !== true && sourcesAllReplayed(counts)) warnings.push(REFRESH_HINT);
      const problems = runProblems(app.kernel, runId, loaded.pack.naming);
      o.afterProject?.();
      const fresh = newMatches(app);
      const notification = notificationFor(fresh, loaded.pack.naming, problems.length);
      let notified = false;
      if (o.notifier === undefined) {
        if (fresh.length > 0) warnings.push(`not announced (--no-notify): ${fresh.length}`);
      } else {
        try {
          await o.notifier(notification);
          notified = true;
        } catch (e) {
          warnings.push(`the notification could not be posted: ${e instanceof Error ? e.message : String(e)}`);
        }
        // Only a posted notification announces: a failed one leaves the jobs for the next run.
        if (notified) app.markNotified(fresh.map((j) => j.jobKey), now);
      }
      app.recordRun({ runId, at: now, counts, packHash: loaded.packHash, policyHash: k.policyHash, warnings, problems });
      return {
        runId, runDate, asOf: loaded.asOf, resumed: resume, report, counts, projection, problems,
        packHash: loaded.packHash, fullPackHash: loaded.fullPackHash, policyHash: k.policyHash, warnings, notification, notified,
        refresh: o.refresh === true, exitCode: exitCodeOf(report),
      };
    } finally {
      app.close();
    }
  });
}

/**
 * The text of the notification a run that could not finish posts (`jobpilot run failed: <reason>`): the first line
 * of the error, unless it holds a forbidden term (checked when the pack's naming rules can be read) or they cannot be
 * read at all, in which case the reason is left out.
 */
export function failureNotification(err: unknown, forbiddenTerms: readonly string[] | undefined): string {
  const first = (err instanceof Error ? err.message : String(err)).split('\n')[0]?.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim() ?? '';
  const reason = first.length > 180 ? `${first.slice(0, 179)}…` : first;
  if (forbiddenTerms === undefined || reason === '') return 'jobpilot run failed; see the log';
  const folded = reason.toLowerCase();
  return forbiddenTerms.some((t) => folded.includes(t.toLowerCase())) ? 'jobpilot run failed; see the log' : `jobpilot run failed: ${reason}`;
}

export interface RebuildOptions {
  readonly home: string;
  readonly clock: Clock;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pdftotext?: string;
}

export interface RebuildSummary extends RunOutcome {
  /** The daily run whose cover plans were re-rendered. */
  readonly from: string;
  readonly nonce: number;
  /** Every job the rebuild wrote, with its docs state before and after. */
  readonly changes: readonly (DocsChange & { readonly company: string; readonly title: string })[];
  /** Jobs whose documents are missing or blocked but that the latest daily run did not render: not rebuilt. */
  readonly notRebuilt: readonly { readonly jobKey: string; readonly docsState: DocsState; readonly lastSeen: string }[];
}

const offline = (what: string) => new KernelError('policy_denied', `docs rebuild runs offline: ${what} is not fetched`);

/**
 * `jobpilot docs rebuild`: re-renders the documents of every job the latest daily run rendered, from the cover plans
 * it stored, for example after files under `out/` were deleted or edited (`missing`). Review I3:
 * - It runs only the renderer and the qa-gate (`jobpilot-rebuild@1.0.0`), seeded with the cover plans that run's
 *   renderer finished. Nothing is fetched, evaluated or planned again, and no step that failed in that run is
 *   re-attempted.
 * - It raises `render.nonce` in the FULL pack only, so the renderer's step key changes and nothing else. It refuses
 *   if the public pack or the policy changed since that run.
 * - When the bytes come out identical, the qa-gate replays. The nonce is kept, so later daily runs replay the rebuilt
 *   renderer steps.
 * - The documents and docs state of each job come from its new QaReport. The summary lists every job with its state
 *   before and after, plus every job with missing or blocked documents that was not in that run (not rebuilt).
 */
export function rebuildDocs(o: RebuildOptions): Promise<RebuildSummary> {
  return withLock(o.home, 'docs rebuild', async () => {
    const paths = homePaths(o.home);
    const pdftotext = o.pdftotext ?? resolvePdftotext();
    const app = AppStore.open(paths.db);
    try {
      const now = o.clock.now();
      const latest = app.latestRun('daily-');
      if (!latest) throw new Error('there is no daily run to rebuild documents from; run `jobpilot run` first');
      const seenRun = app.kernel.getRun(latest.runId);
      if (seenRun?.pipeline !== `${DAILY_PIPELINE.id}@${DAILY_PIPELINE.version}`) throw new Error(`run ${latest.runId} is not a ${DAILY_PIPELINE.id} run`);
      // The cover plans whose renderer step finished in that run; nothing that failed there is tried again.
      const plans = new Map<string, CoverPlan>();
      let runDate: string | undefined;
      for (const q of app.kernel.queueItems(latest.runId)) {
        if (runDate === undefined && q.agent_id.startsWith(SOURCE_PREFIX)) runDate = (app.kernel.getEnvelope(q.envelope_id).payload as { runDate?: string }).runDate;
        if (q.agent_id === 'renderer' && q.status === 'done') plans.set(q.envelope_id, app.kernel.getEnvelope(q.envelope_id).payload as CoverPlan);
      }
      if (runDate === undefined) throw new Error(`run ${latest.runId} has no seeds`);
      // The month that run measured experience to (its asOf came from the same clock reading as its run date).
      const asOf = runDate.slice(0, 7);
      const nonce = (nonceOf(app) ?? 0) + 1;
      const loaded = loadRunPack(paths.pack, app.factOverrides(), asOf, nonce);
      if (loaded.packHash !== latest.packHash) {
        throw new Error(`the pack changed since ${latest.runId} (a pack file or a fact status); run \`jobpilot run\` to rebuild with the new pack`);
      }
      const k = appKernel({
        store: app.kernel, loaded, outDir: paths.out, clock: o.clock, sleep: o.sleep ?? realSleep, pdftotext, mode: 'rebuild',
        fetch: async (url) => Promise.reject(offline(new URL(url).hostname)),
      });
      if (k.policyHash !== latest.policyHash) throw new Error(`the policy changed since ${latest.runId}; run \`jobpilot run\` instead`);
      const { runId, resume, skipped } = pickRunId(app.kernel, `rebuild-${istDate(now)}`, k.policyHash);
      const report = resume ? await k.supervisor.resume(runId) : await k.supervisor.start(runId, [...plans.values()]);
      app.setSetting(RENDER_NONCE_KEY, String(nonce));
      const docChanges = projectDocs(app.kernel, app, runId, { docOnDisk: diskDocCheck(paths.out) });
      const counts = runCounts(app.kernel, runId);
      const problems = runProblems(app.kernel, runId, loaded.pack.naming);
      const warnings = skippedWarnings(skipped);
      app.recordRun({ runId, at: now, counts, packHash: loaded.packHash, policyHash: k.policyHash, warnings, problems });
      const written = new Set(docChanges.map((c) => c.jobKey));
      const changes = docChanges.map((c) => {
        const j = app.getJob(c.jobKey);
        return { ...c, company: j?.company ?? '?', title: j?.title ?? '?' };
      });
      const notRebuilt = app
        .listJobs({ band: ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'], duplicates: true })
        .filter((j) => (j.docsState === 'missing' || j.docsState === 'blocked') && !written.has(j.jobKey))
        .map((j) => ({ jobKey: j.jobKey, docsState: j.docsState, lastSeen: j.lastSeen }));
      return {
        runId, runDate, asOf, resumed: resume, report, counts, problems, from: latest.runId, nonce, changes, notRebuilt,
        packHash: loaded.packHash, fullPackHash: loaded.fullPackHash, policyHash: k.policyHash, warnings, exitCode: exitCodeOf(report),
      };
    } finally {
      app.close();
    }
  });
}

const COLUMNS = ['done', 'replayed', 'failed', 'gone', 'inputRejected', 'skipped', 'quarantined'] as const satisfies readonly (keyof AgentCounts)[];
const HEAD: Readonly<Record<(typeof COLUMNS)[number], string>> = {
  done: 'done', replayed: 'replayed', failed: 'failed', gone: 'gone', inputRejected: 'rejected', skipped: 'skipped', quarantined: 'quarantined',
};

/** The run summary as the CLI prints it: per-agent counts, the projection, problems, the notification and warnings. */
export function formatSummary(s: RunOutcome & Partial<Pick<DailySummary, 'notification' | 'projection'>> & Partial<Pick<RebuildSummary, 'from' | 'changes' | 'notRebuilt'>>): string {
  const lines = [`run ${s.runId} for ${s.runDate} (experience as of ${s.asOf})${s.resumed ? ', resumed' : ''}${s.from ? `, rebuilt from ${s.from}` : ''}: ${s.report.status}`];
  const agents = Object.keys(s.counts.byAgent);
  const w = Math.max(5, ...agents.map((a) => a.length));
  lines.push(`${'agent'.padEnd(w)}  ${COLUMNS.map((c) => HEAD[c]).join('  ')}`);
  const row = (name: string, c: AgentCounts) => `${name.padEnd(w)}  ${COLUMNS.map((k) => String(c[k]).padStart(HEAD[k].length)).join('  ')}`;
  for (const a of agents) lines.push(row(a, s.counts.byAgent[a] as AgentCounts));
  lines.push(row('total', s.counts.totals));
  if (s.projection) {
    const d = s.projection.docs;
    lines.push(`jobs: ${s.projection.jobs} written (${s.projection.inserted} new, ${s.projection.stale} stale skipped); docs ready ${d.ready}, blocked ${d.blocked}, missing ${d.missing}, below-floor ${d['below-floor']}, none ${d.none}`);
    if (s.projection.unresolvedQuarantines > 0) lines.push(`unresolved quarantines: ${s.projection.unresolvedQuarantines}`);
  }
  if (s.changes) {
    lines.push(`documents rebuilt: ${s.changes.length} jobs`);
    for (const c of s.changes) lines.push(`  ${c.jobKey}  ${c.from ?? 'none'} -> ${c.to}  ${c.company} — ${c.title}`);
  }
  for (const j of s.notRebuilt ?? []) lines.push(`  not rebuilt: ${j.jobKey} (docs ${j.docsState}), last seen ${j.lastSeen}`);
  if (s.problems.length > 0) {
    lines.push(`problems: ${s.problems.length}`);
    for (const p of s.problems) lines.push(`  ${p.kind.padEnd(14)} ${p.agent}  ${p.item}: ${p.reason}`);
  }
  if (s.notification !== undefined) lines.push(`notification: ${s.notification}`);
  lines.push(`pack ${s.packHash.slice(0, 12)}, full pack ${s.fullPackHash.slice(0, 12)}, policy ${s.policyHash.slice(0, 12)}`);
  for (const warning of s.warnings) lines.push(`warning: ${warning}`);
  return lines.join('\n');
}
