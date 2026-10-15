import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import { canonicalJson } from '../kernel/canonical.js';
import { ERROR_CODES } from '../kernel/errors.js';
import type { Store } from '../kernel/store/store.js';
import type { Problem } from './problems.js';

/** The machine-readable end of a hosted pipeline run (`--summary-json`): counts and codes only, never a name. */
export interface RunSummaryJson {
  readonly v: 1;
  readonly pipeline: 'daily' | 'freelance';
  readonly runId: string;
  readonly status: 'completed' | 'paused';
  readonly exitCode: 0 | 1;
  /** Jobs (daily) or gigs (freelance) projected. */
  readonly items: number;
  /** Problem code to count (codes: PROBLEM_CODES). */
  readonly problems: Readonly<Record<string, number>>;
  readonly skippedSources: number;
  /** Freelance only. */
  readonly gmail?: 'connected' | 'off' | 'failed';
}

/**
 * Problem code to count. A `failed` problem counts under its step's error code (`ERROR_CODES`) when the run's
 * `step_failed` events name one (the reason starts with it); every other kind counts under its own name.
 */
export function problemTally(problems: readonly Problem[], kernel: Store, runId: string): Record<string, number> {
  const named = new Set<string>();
  for (const ev of kernel.events(runId)) {
    if (ev.kind !== 'step_failed') continue;
    const error = (JSON.parse(ev.data) as { error?: unknown }).error;
    if (typeof error === 'string' && (ERROR_CODES as readonly string[]).includes(error)) named.add(error);
  }
  const tally: Record<string, number> = {};
  for (const p of problems) {
    let code: string = p.kind;
    if (p.kind === 'failed') {
      const lead = /^([a-z_]+):/.exec(p.reason)?.[1];
      if (lead !== undefined && named.has(lead)) code = lead;
    }
    tally[code] = (tally[code] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(tally).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Canonical JSON, mode 0600, written to a sibling and renamed into place. */
export function writeRunSummaryJson(file: string, s: RunSummaryJson): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${canonicalJson(s)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
