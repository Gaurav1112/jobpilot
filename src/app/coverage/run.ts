import type { Clock } from '../../kernel/clock.js';
import { ensureHome } from '../home.js';
import { loadRunPack } from '../kernel.js';
import { withLock } from '../lock.js';
import { homePaths } from '../pack/paths.js';
import { istDate, istMonth, nonceOf, pickRunId } from '../run.js';
import { AppStore } from '../store/app-store.js';

/** The empty pipeline's policy: no agent, no spend. Later tasks replace it with the compiled coverage policy. */
const EMPTY_POLICY_HASH = 'coverage-empty-pipeline';
const PIPELINE = 'jobpilot-coverage';

export interface CoverageRunOptions {
  readonly home: string;
  readonly clock: Clock;
  readonly onLocked?: () => void;
}

export interface CoverageSummary {
  readonly runId: string;
  readonly runDate: string;
  readonly resumed: boolean;
  /** The company picks in companies.yaml (read strictly: a malformed file refuses the run). */
  readonly picks: number;
  readonly warnings: string[];
  readonly exitCode: 0 | 1;
}

/**
 * `jobpilot run-coverage`: one weekly career-site coverage run under the run lock. For now the pipeline is empty (no
 * agent yet): it loads the pack with companies.yaml STRICT (a malformed one refuses the run, unlike the daily and
 * freelance runs), resolves the run id `coverage-<IST date>[-<n>]` (a completed one moves to `-2`, an incomplete one
 * with the same policy is resumed) and records a summary event, so the due window and the schedule can be exercised end
 * to end. Later tasks add the agents.
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
      const loaded = loadRunPack(paths.pack, app.factOverrides(), istMonth(now), nonceOf(app), 'strict');
      const { runId, resume, skipped } = pickRunId(app.kernel, `coverage-${runDate}`, EMPTY_POLICY_HASH);
      const warnings = [...loaded.warnings, ...skipped.map((id) => `run ${id} did not complete and used another policy, so it was not resumed; it stays incomplete`)];
      if (!resume) app.kernel.startRun(runId, PIPELINE, EMPTY_POLICY_HASH, now);
      app.kernel.appendEvent(runId, now, 'coverage.summary', { picks: loaded.companies.length, companiesHash: loaded.companiesHash, agents: 0 }, EMPTY_POLICY_HASH);
      app.kernel.finishRun(runId, now);
      return { runId, runDate, resumed: resume, picks: loaded.companies.length, warnings, exitCode: 0 };
    } finally {
      app.close();
    }
  });
}

/** The coverage run summary as the CLI prints it. */
export function formatCoverageSummary(s: CoverageSummary): string {
  const lines = [`run ${s.runId} for ${s.runDate}${s.resumed ? ', resumed' : ''}: completed (empty pipeline: no agents yet)`, `company picks: ${s.picks}`];
  for (const w of s.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}
