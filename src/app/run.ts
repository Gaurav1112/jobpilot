import { mkdirSync } from 'node:fs';
import type { Clock } from '../kernel/clock.js';
import { KernelError } from '../kernel/errors.js';
import type { BrowserProvider, FetchLike } from '../kernel/providers.js';
import type { Store } from '../kernel/store/store.js';
import type { RunReport } from '../kernel/supervisor.js';
import { SUPERVISOR_ID } from '../kernel/wiring.js';
import { diskDocCheck } from './docs-check.js';
import { appKernel, loadRunPack, resolvePdftotext, type RunPack } from './kernel.js';
import { withLock } from './lock.js';
import { notificationFor, type Notifier } from './notify.js';
import { homePaths } from './pack/paths.js';
import { dailySeeds } from './pipeline.js';
import { projectRun, runCounts, type AgentCounts, type ProjectResult, type RunCounts } from './project.js';
import { AppStore, type DocsState } from './store/app-store.js';
import type { DiscoveryRequest } from './types.js';

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

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The run id for `prefix` (`daily-<runDate>`): the first of `prefix`, `prefix-2`, `prefix-3`, … that is not a
 * completed run. A run that exists but never completed (a crash) is resumed under its own id, unless it ran under
 * another policy (the supervisor refuses to resume that): it is left as it is, named in `skipped`, and the next id
 * is used.
 */
export function pickRunId(store: Store, prefix: string, policyHash: string): { runId: string; resume: boolean; skipped: string[] } {
  const skipped: string[] = [];
  for (let n = 1; ; n++) {
    const runId = n === 1 ? prefix : `${prefix}-${n}`;
    const run = store.getRun(runId);
    if (!run) return { runId, resume: false, skipped };
    if (run.status === 'completed') continue;
    if (run.policy_hash === policyHash) return { runId, resume: true, skipped };
    skipped.push(runId);
  }
}

const skippedWarnings = (skipped: readonly string[]): string[] =>
  skipped.map((id) => `run ${id} did not complete and used another policy, so it was not resumed; it stays incomplete`);

export interface RunOutcome {
  readonly runId: string;
  /** The IST date the run is for (the seeds' `runDate`). */
  readonly runDate: string;
  /** The pack's `experience.asOf` for this run. */
  readonly asOf: string;
  /** True when a crashed run with this id was continued. */
  readonly resumed: boolean;
  readonly report: RunReport;
  /** Per agent: done, replayed, failed, gone, skipped, quarantined (and pending). */
  readonly counts: RunCounts;
  readonly projection: ProjectResult;
  readonly packHash: string;
  readonly fullPackHash: string;
  readonly policyHash: string;
  readonly warnings: string[];
}

export interface DailySummary extends RunOutcome {
  readonly notification: string;
  readonly notified: boolean;
}

export interface RunOptions {
  /** JOBPILOT_HOME: `pack/`, `out/`, `jobpilot.db` and the lock live here. */
  readonly home: string;
  readonly clock: Clock;
  readonly fetch: FetchLike;
  /** Needed when the watchlist has careers entries. The caller owns it (and closes it). */
  readonly browser?: BrowserProvider;
  readonly notifier: Notifier;
  /** Default: real time. Tests pass a no-op; production must not. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Absolute path of pdftotext; default `resolvePdftotext()`. */
  readonly pdftotext?: string;
  /** Test hook: runs after each step; throwing simulates a crash. */
  readonly afterStep?: (count: number) => void;
}

/** The jobs first seen today (IST) whose documents are ready: what the notification counts. Duplicate listings excluded. */
function newMatches(app: AppStore, runDate: string): { score: number | null; company: string; title: string }[] {
  return app
    .listJobs({ band: ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'] })
    .filter((j) => j.docsState === 'ready' && istDate(j.firstSeen) === runDate);
}

function nonceOf(app: AppStore): number | undefined {
  const v = app.getSetting(RENDER_NONCE_KEY);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`app setting ${RENDER_NONCE_KEY} is not a positive integer: ${v}`);
  return n;
}

function finish(app: AppStore, runId: string, loaded: RunPack, policyHash: string, outDir: string, at: string, projectAt?: string) {
  const projection = projectRun(app.kernel, app, runId, {
    minFit: loaded.pack.targets.minFit,
    fx: loaded.pack.fx,
    docOnDisk: diskDocCheck(outDir),
    ...(projectAt !== undefined ? { at: projectAt } : {}),
  });
  const counts = runCounts(app.kernel, runId);
  app.recordRun({ runId, at, counts, packHash: loaded.packHash, policyHash });
  return { projection, counts };
}

/**
 * `jobpilot run`: one daily run under the lock (spec §1, §8).
 * 1. Load the pack with the user's fact overrides, `experience.asOf` = the IST month of `clock` and the kept
 *    `render.nonce`; hash it.
 * 2. Wire the pipeline (allow-list, wiring proof, pacing check) and seed one request per watchlist entry and feed,
 *    dated with today's IST date.
 * 3. Run as `daily-<runDate>` (or `daily-<runDate>-<n>` when that one completed; a crashed one is resumed), project
 *    the outputs into the app tables, record the run summary.
 * 4. Notify: `<N> new matches · top: …` for jobs first seen today with ready documents, or `No new matches today`.
 */
export function runDaily(o: RunOptions): Promise<DailySummary> {
  return withLock(o.home, 'run', async () => {
    const paths = homePaths(o.home);
    mkdirSync(paths.out, { recursive: true });
    const pdftotext = o.pdftotext ?? resolvePdftotext();
    const app = AppStore.open(paths.db);
    try {
      const now = o.clock.now();
      const runDate = istDate(now);
      const loaded = loadRunPack(paths.pack, app.factOverrides(), istMonth(now), nonceOf(app));
      const k = appKernel({ store: app.kernel, loaded, outDir: paths.out, clock: o.clock, sleep: o.sleep ?? realSleep, fetch: o.fetch, ...(o.browser ? { browser: o.browser } : {}), pdftotext, ...(o.afterStep ? { afterStep: o.afterStep } : {}) });
      const { seeds, warnings } = dailySeeds(loaded.pack, runDate);
      if (seeds.length === 0) warnings.push('the watchlist and feeds are empty: nothing was fetched');
      const { runId, resume, skipped } = pickRunId(app.kernel, `daily-${runDate}`, k.policyHash);
      warnings.push(...skippedWarnings(skipped));
      const report = resume ? await k.supervisor.resume(runId) : await k.supervisor.start(runId, seeds);
      const { projection, counts } = finish(app, runId, loaded, k.policyHash, paths.out, now);
      const notification = notificationFor(newMatches(app, runDate), loaded.pack.naming);
      let notified = true;
      try {
        await o.notifier(notification);
      } catch (e) {
        notified = false;
        warnings.push(`the notification could not be posted: ${e instanceof Error ? e.message : String(e)}`);
      }
      return {
        runId, runDate, asOf: loaded.asOf, resumed: resume, report, counts, projection,
        packHash: loaded.packHash, fullPackHash: loaded.fullPackHash, policyHash: k.policyHash, warnings, notification, notified,
      };
    } finally {
      app.close();
    }
  });
}

export interface RebuildOptions {
  readonly home: string;
  readonly clock: Clock;
  /** One job's documents, or `all`. */
  readonly jobKey?: string;
  readonly all?: boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pdftotext?: string;
}

export interface RebuildSummary extends RunOutcome {
  /** The daily run whose seeds and pack the rebuild replays. */
  readonly from: string;
  readonly nonce: number;
  readonly job?: { readonly jobKey: string; readonly docsState: DocsState; readonly docsDetail: string | null };
}

/** The seed payloads of a run, in queue order, each once. */
function seedsOf(store: Store, runId: string): DiscoveryRequest[] {
  const seen = new Set<string>();
  const seeds: DiscoveryRequest[] = [];
  for (const q of store.queueItems(runId)) {
    if (seen.has(q.envelope_id)) continue;
    seen.add(q.envelope_id);
    const env = store.getEnvelope(q.envelope_id);
    if (env.producer.agentId === SUPERVISOR_ID) seeds.push(env.payload as DiscoveryRequest);
  }
  return seeds;
}

const offline = (what: string) => new KernelError('policy_denied', `docs rebuild runs offline: ${what} is not fetched`);

/**
 * `jobpilot docs rebuild <jobKey|--all>`: re-renders the documents of the latest daily run, for example after files
 * under `out/` were deleted or edited (`missing`). It raises `render.nonce` in the FULL pack only (nothing else in
 * the pack changes, and it refuses if the pack did change since that run), then replays that run's seeds under a new
 * run id `rebuild-<today>`: every source, normalizer, evaluation and planning step replays from the store, only the
 * renderer runs again (through the executor, so G-FILL, G-NAMING and the transactional commit apply), and the qa-gate
 * replays when the bytes come out identical. Nothing is fetched: a step that has to run again is refused offline.
 * The nonce is kept, so later daily runs replay the rebuilt renderer steps. The run is projected at the original
 * run's time. The nonce is pack-wide, so every job of that run is re-rendered; `jobKey` names the job to report on
 * (and must have documents).
 */
export function rebuildDocs(o: RebuildOptions): Promise<RebuildSummary> {
  if ((o.jobKey === undefined) === (o.all !== true)) return Promise.reject(new Error('docs rebuild needs exactly one of a job key or --all'));
  return withLock(o.home, 'docs rebuild', async () => {
    const paths = homePaths(o.home);
    const pdftotext = o.pdftotext ?? resolvePdftotext();
    const app = AppStore.open(paths.db);
    try {
      const now = o.clock.now();
      const latest = app.listRuns(100_000).find((r) => r.runId.startsWith('daily-'));
      if (!latest) throw new Error('there is no daily run to rebuild documents from; run `jobpilot run` first');
      if (o.jobKey !== undefined) {
        const job = app.getJob(o.jobKey);
        if (!job) throw new Error(`unknown job ${o.jobKey}`);
        if (job.docs.length === 0) throw new Error(`job ${o.jobKey} has no documents to rebuild (docs ${job.docsState})`);
      }
      const seeds = seedsOf(app.kernel, latest.runId);
      const runDate = seeds[0]?.runDate;
      if (runDate === undefined) throw new Error(`run ${latest.runId} has no seeds`);
      // The month that run measured experience to (its asOf came from the same clock reading as its run date).
      const asOf = runDate.slice(0, 7);
      const nonce = (nonceOf(app) ?? 0) + 1;
      const loaded = loadRunPack(paths.pack, app.factOverrides(), asOf, nonce);
      if (loaded.packHash !== latest.packHash) {
        throw new Error(`the pack changed since ${latest.runId} (a pack file or a fact status); run \`jobpilot run\` to rebuild with the new pack`);
      }
      const k = appKernel({
        store: app.kernel, loaded, outDir: paths.out, clock: o.clock, sleep: o.sleep ?? realSleep, pdftotext,
        fetch: async (url) => Promise.reject(offline(new URL(url).hostname)),
        browser: { render: async (req) => Promise.reject(offline(new URL(req.url).hostname)) },
      });
      if (k.policyHash !== latest.policyHash) throw new Error(`the policy changed since ${latest.runId}; run \`jobpilot run\` instead`);
      const { runId, resume, skipped } = pickRunId(app.kernel, `rebuild-${istDate(now)}`, k.policyHash);
      const report = resume ? await k.supervisor.resume(runId) : await k.supervisor.start(runId, seeds);
      app.setSetting(RENDER_NONCE_KEY, String(nonce));
      const seenAt = app.kernel.events(latest.runId).find((e) => e.kind === 'run_started')?.at;
      const { projection, counts } = finish(app, runId, loaded, k.policyHash, paths.out, now, seenAt);
      const job = o.jobKey === undefined ? undefined : app.getJob(o.jobKey);
      return {
        runId, runDate, asOf, resumed: resume, report, counts, projection, from: latest.runId, nonce,
        packHash: loaded.packHash, fullPackHash: loaded.fullPackHash, policyHash: k.policyHash, warnings: skippedWarnings(skipped),
        ...(job ? { job: { jobKey: job.jobKey, docsState: job.docsState, docsDetail: job.docsDetail } } : {}),
      };
    } finally {
      app.close();
    }
  });
}

const COLUMNS = ['done', 'replayed', 'failed', 'gone', 'skipped', 'quarantined'] as const satisfies readonly (keyof AgentCounts)[];

/** The run summary as the CLI prints it: per-agent counts, the projection, then the notification and warnings. */
export function formatSummary(s: RunOutcome & { notification?: string; from?: string; job?: RebuildSummary['job'] }): string {
  const lines = [`run ${s.runId} for ${s.runDate} (experience as of ${s.asOf})${s.resumed ? ', resumed' : ''}${s.from ? `, rebuilt from ${s.from}` : ''}: ${s.report.status}`];
  const agents = Object.keys(s.counts.byAgent);
  const w = Math.max(5, ...agents.map((a) => a.length));
  lines.push(`${'agent'.padEnd(w)}  ${COLUMNS.map((c) => c.padStart(c.length)).join('  ')}`);
  const row = (name: string, c: AgentCounts) => `${name.padEnd(w)}  ${COLUMNS.map((k) => String(c[k]).padStart(k.length)).join('  ')}`;
  for (const a of agents) lines.push(row(a, s.counts.byAgent[a] as AgentCounts));
  lines.push(row('total', s.counts.totals));
  const d = s.projection.docs;
  lines.push(`jobs: ${s.projection.jobs} written (${s.projection.inserted} new, ${s.projection.stale} stale skipped); docs ready ${d.ready}, blocked ${d.blocked}, missing ${d.missing}, below-floor ${d['below-floor']}, none ${d.none}`);
  if (s.projection.unresolvedQuarantines > 0) lines.push(`unresolved quarantines: ${s.projection.unresolvedQuarantines}`);
  if (s.job) lines.push(`job ${s.job.jobKey}: docs ${s.job.docsState}${s.job.docsDetail ? ` (${s.job.docsDetail})` : ''}`);
  if (s.notification !== undefined) lines.push(`notification: ${s.notification}`);
  lines.push(`pack ${s.packHash.slice(0, 12)}, full pack ${s.fullPackHash.slice(0, 12)}, policy ${s.policyHash.slice(0, 12)}`);
  for (const warning of s.warnings) lines.push(`warning: ${warning}`);
  return lines.join('\n');
}
