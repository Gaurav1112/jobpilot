import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../../kernel/clock.js';
import { withLock } from '../lock.js';
import { homePaths } from '../pack/paths.js';
import { AppStore } from './app-store.js';
import { applyCompaction, formatPlan, listSegments, loadRetentionPolicy, planCompaction, restoreSegment, RetentionRefused } from './retention.js';

/**
 * `jobpilot store compact` and `jobpilot store restore` (retention.ts). Both take the run lock WITHOUT waiting (a held
 * lock refuses, naming its holder) and are never part of a pipeline or the schedule. `compact` is a dry run unless
 * `--apply`; with `--apply` it refuses while any run is incomplete unless `--include-incomplete`.
 */
export interface StoreCommandOptions {
  readonly home: string;
  readonly clock: Clock;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const mb = (n: number): string => `${(n / 1_048_576).toFixed(1)} MB`;

export function archiveDirOf(home: string): string {
  return join(home, 'archive');
}

export async function storeCompactCommand(o: StoreCommandOptions & { readonly apply: boolean; readonly includeIncomplete: boolean; readonly vacuum: boolean }): Promise<number> {
  const paths = homePaths(o.home);
  if (!existsSync(paths.db)) throw new RetentionRefused(`no database at ${paths.db}`);
  const { policy, hash, source } = loadRetentionPolicy(paths.pack);
  return withLock(o.home, o.apply ? 'store compact' : 'store compact --dry-run', async () => {
    const app = AppStore.open(paths.db);
    try {
      const now = o.clock.now();
      const plan = planCompaction(app, { now, policy, policyHash: hash, includeIncomplete: o.includeIncomplete });
      o.out(formatPlan(plan, source === 'pack' ? 'pack/retention.yaml' : 'built-in default'));
      const blocking = plan.incomplete.filter((i) => i.pinned || !o.includeIncomplete);
      if (!o.apply) {
        o.out('dry run: nothing was written. Back up the database, then run with --apply to archive.');
        if (plan.incomplete.length > 0 && !o.includeIncomplete) o.out(`note: --apply refuses while runs are incomplete (${plan.incomplete.map((i) => i.runId).join(', ')}); --include-incomplete archives the stale ones`);
        return 0;
      }
      if (plan.incomplete.length > 0 && !o.includeIncomplete) {
        o.err(`refused: runs are incomplete or resumable (${blocking.map((i) => i.runId).join(', ')}); finish them, or pass --include-incomplete (stale runs are archived, resumable ones kept)`);
        return 1;
      }
      const r = await applyCompaction(app, plan, { dbPath: paths.db, archiveDir: archiveDirOf(o.home), now, vacuum: o.vacuum });
      if (r.segment === null) {
        o.out('nothing to archive');
        return 0;
      }
      o.out(`archived ${r.envelopes} envelopes and ${r.steps} step rows (${mb(r.bytes)}) to archive/${r.segment} (sha256 ${r.sha256})`);
      o.out(`recorded in the audit chain (store.compacted); restore with: jobpilot store restore ${r.segment}`);
      o.out(`database: ${mb(r.sizeBefore)} -> ${mb(r.sizeAfter)}; vacuum ${r.vacuum}; ${r.seconds.toFixed(1)} s`);
      if (r.vacuum === 'skipped: not enough free disk') o.err('warning: VACUUM needs about the database\'s size free on disk; the space is reused by later runs instead. Free some disk and run compact again to reclaim it.');
      return 0;
    } finally {
      app.close();
    }
  });
}

export async function storeRestoreCommand(o: StoreCommandOptions & { readonly segment?: string; readonly all: boolean }): Promise<number> {
  const paths = homePaths(o.home);
  if (!existsSync(paths.db)) throw new RetentionRefused(`no database at ${paths.db}`);
  const dir = archiveDirOf(o.home);
  const segments = o.all ? listSegments(dir) : o.segment !== undefined ? [o.segment] : [];
  if (segments.length === 0) throw new RetentionRefused(o.all ? `no segments in ${dir}` : 'name a segment, or pass --all');
  return withLock(o.home, 'store restore', async () => {
    const app = AppStore.open(paths.db);
    try {
      for (const segment of segments) {
        const r = await restoreSegment(app, { archiveDir: dir, segment, now: o.clock.now() });
        o.out(`restored ${segment}: ${r.envelopes.inserted} envelopes (${r.envelopes.present} already there${r.envelopes.differ > 0 ? `, ${r.envelopes.differ} of them made again by a later run with other bytes, kept as they are` : ''}), ${r.steps.inserted} step rows (${r.steps.present} already there); recorded (store.restored)`);
      }
      return 0;
    } finally {
      app.close();
    }
  });
}
