import type { Clock } from '../../kernel/clock.js';
import type { FetchLike } from '../../kernel/providers.js';
import { codeHash as currentCodeHash } from '../code-hash.js';
import { otherRunOwed } from '../due.js';
import { LockError, systemProbe, withLock, type ProcessProbe } from '../lock.js';
import { loadPack } from '../pack/load.js';
import { homePaths } from '../pack/paths.js';
import { istDate, istMonth } from '../run.js';
import { AppStore, type Company } from '../store/app-store.js';
import { dnsOnline } from '../net.js';
import { makeRunGate, type RunGate } from './gate.js';
import { coveragePolicy, coveragePolicyHash, runCoverageStages, STAGES } from './pipeline.js';
import { deferralHosts, projectCoverage } from './project.js';

/**
 * "Resolve now" (Task 11, spec §5): the four coverage agents for ONE registry company, from the dashboard, instead of
 * waiting for the weekly run. The rules that keep it from getting in the way of the daily run:
 *
 * - **The run lock, never waited for.** It takes the single process lock without blocking (`withLock` refuses at once
 *   when a run holds it) and releases it however it ends. A held lock is a refusal (`busy`), never a wait.
 * - **The yield rule of coverage.** Under the lock, before any request, it asks `otherRunOwed` (due.ts: the daily or
 *   freelance run is owed now or within 5 minutes on this home): then it refuses (`due`) and fetches nothing.
 * - **Fresh per request.** A new run key (`resolve-<IST date>-<key>[-n]`) and a new run gate (`makeRunGate`, host state
 *   keyed by that run) are built inside the lock for every request; nothing is kept in the dashboard process.
 * - **Coverage politeness.** The coverage policy (≥ 2 s per host), robots.txt, the gate's host disabling, the honest UA:
 *   the same `runCoverageStages` the weekly run uses, on a one-pick seed. A host disabled during it defers the company
 *   (nothing is written; it is named).
 * - **Short.** Before each step it stops when TIME_LIMIT_MS (the clock) has passed since it started, or when a daily or
 *   freelance run became owed; a step already running ends within its own deadline (the gate's 90 s).
 * - **The verdict** goes through `projectCoverage` as the weekly run's would, with `countFailures: false` (a failed
 *   resolve never adds a fail week; the weekly run counts weeks). The user's override still wins.
 * - Finished steps are memoised as in every run: resolving the same company again the same IST day replays them (no
 *   new request); the next day asks afresh.
 * - The candidate is a pick (`source: pick`), so a resolved company is re-verified by each weekly run afterwards. A
 *   company already `verified` is refused (the weekly run re-checks it), so it never becomes a pick this way.
 * - **A refusal is a deferral.** When any host was disabled in this run's gate (401/403/429, a challenge, robots) or a
 *   step was deferred, nothing is written: the result names the hosts and the weekly run asks again.
 */

/** The longest resolve-now keeps starting steps (the injected clock). */
export const RESOLVE_TIME_LIMIT_MS = 120_000;
/** The lock's command name while resolve-now holds it. */
export const RESOLVE_COMMAND = 'resolve-company';

export interface ResolveOptions {
  readonly home: string;
  readonly clock: Clock;
  readonly fetch: FetchLike;
  readonly companyKey: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly codeHash?: string;
  readonly timeLimitMs?: number;
  /** A reason to refuse or stop (the daily or freelance run is owed), or null. Default: `otherRunOwed` on this home. */
  readonly yieldCheck?: (now: string) => string | null;
  readonly probe?: ProcessProbe;
  /** Tests: sees the gate and run key built for this request. */
  readonly onGate?: (gate: RunGate, runId: string) => void;
  /** Is the machine online (the run gate's check before a name DNS does not know is `no-such-host`)? Default `dnsOnline`. */
  readonly online?: () => Promise<boolean>;
}

export type ResolveResult =
  | { readonly kind: 'refused'; readonly why: 'busy' | 'due' | 'unknown' | 'rejected' | 'verified'; readonly reason: string }
  | { readonly kind: 'resolved'; readonly runId: string; readonly company: Company }
  | { readonly kind: 'deferred'; readonly runId: string; readonly hosts: readonly (readonly [host: string, why: string])[] }
  | { readonly kind: 'stopped'; readonly runId: string; readonly reason: string };

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A run key not used before: `resolve-<IST date>-<key with non-alphanumerics as ->`, then `-2`, `-3`, … */
function freshRunId(app: AppStore, date: string, companyKey: string): string {
  const base = `resolve-${date}-${companyKey.replace(/[^a-z0-9]+/g, '-')}`;
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (STAGES.every((s) => app.kernel.getRun(`${id}.${s}`) === undefined) && app.coverageHostState(id).size === 0) return id;
  }
}

export async function resolveCompany(o: ResolveOptions): Promise<ResolveResult> {
  try {
    return await withLock(o.home, RESOLVE_COMMAND, () => resolveLocked(o), o.probe ?? systemProbe);
  } catch (e) {
    if (e instanceof LockError) return { kind: 'refused', why: 'busy', reason: 'another jobpilot run holds the lock; try again when it has finished' };
    throw e;
  }
}

async function resolveLocked(o: ResolveOptions): Promise<ResolveResult> {
  const start = o.clock.now();
  const yieldCheck = o.yieldCheck ?? ((now: string) => otherRunOwed(o.home, now));
  const owed = yieldCheck(start);
  if (owed !== null) return { kind: 'refused', why: 'due', reason: owed };
  const paths = homePaths(o.home);
  const app = AppStore.open(paths.db);
  try {
    const company = app.getCompany(o.companyKey);
    if (company === undefined) return { kind: 'refused', why: 'unknown', reason: 'no such company' };
    if (company.status === 'rejected' || company.userOverride === 'rejected') return { kind: 'refused', why: 'rejected', reason: 'you rejected this company; approve it first' };
    // a verified company is re-checked by the weekly run; resolving it would only turn it into a pick
    if (company.status === 'verified') return { kind: 'refused', why: 'verified', reason: 'already verified; it is re-checked weekly' };
    // the pack only for the user's policy; a pack that does not load refuses here, before any request
    const { pack } = loadPack(paths.pack, {}, { asOf: istMonth(start), mode: 'daily' });
    const policy = coveragePolicy(pack);
    const runDate = istDate(start);
    const runId = freshRunId(app, runDate, company.companyKey);
    const gate = makeRunGate({ runKey: runId, store: app, online: o.online ?? (() => dnsOnline()) });
    o.onGate?.(gate, runId);
    const deadline = Date.parse(start) + (o.timeLimitMs ?? RESOLVE_TIME_LIMIT_MS);
    const item = { name: company.name, website: company.website, ...(company.careersUrl !== null ? { careersUrl: company.careersUrl } : {}) };
    const outcome = await runCoverageStages({
      store: app.kernel,
      runId,
      gate,
      policy,
      policyHash: coveragePolicyHash(pack),
      clock: o.clock,
      sleep: o.sleep ?? realSleep,
      fetch: o.fetch,
      codeHash: o.codeHash ?? currentCodeHash(),
      seeds: [{ runDate, source: 'picks', items: [item] }],
      pauseBefore: () => {
        const at = o.clock.now();
        return yieldCheck(at) ?? (Date.parse(at) >= deadline ? 'time limit' : null);
      },
    });
    const at = o.clock.now();
    if ('paused' in outcome) {
      app.logUserAction('company.resolve', { companyKey: company.companyKey, runId, result: 'stopped', reason: outcome.paused }, at);
      return { kind: 'stopped', runId, reason: outcome.paused };
    }
    // a host that refused (disabled in this run's gate: 401/403/429, a challenge, robots) or a step it deferred: like the
    // weekly run's deferrals, nothing is known this time, so no verdict is written
    // C1: a step that failed for a transient reason knows nothing either: deferred like a refusal, never "not located"
    const deferred = STAGES.flatMap((s) => [...outcome.stages[s].deferred, ...outcome.stages[s].transient]);
    const disabled = app.coverageHostState(runId);
    if (deferred.length > 0 || disabled.size > 0) {
      const named = deferralHosts(deferred.map((d) => d.detail));
      const hosts = [...named, ...[...disabled].filter(([h]) => !named.some(([n]) => n === h))].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      app.logUserAction('company.resolve', { companyKey: company.companyKey, runId, result: 'deferred', hosts }, at);
      return { kind: 'deferred', runId, hosts };
    }
    const unlocated = outcome.sites.filter((s) => s.careersUrl === null);
    app.tx(() => {
      projectCoverage(app, { verdicts: outcome.verdicts, unlocated, at: start, countFailures: false });
      const now = app.getCompany(company.companyKey);
      app.logUserAction('company.resolve', { companyKey: company.companyKey, runId, result: 'resolved', status: now?.status ?? null }, at);
    });
    return { kind: 'resolved', runId, company: app.getCompany(company.companyKey) as Company };
  } finally {
    app.close();
  }
}
