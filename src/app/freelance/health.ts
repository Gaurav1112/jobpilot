import type { Store } from '../../kernel/store/store.js';
import type { Problem } from '../problems.js';
import type { AppStore, GigUpsert, SourceHealthRow } from '../store/app-store.js';
import { GMAIL_LABEL_MISSING, UNRECOGNISED_NOTE } from './mail/google.js';
import { PLATFORM_AGENT } from './pipeline.js';
import type { GigRequest, Platform } from './types.js';

/**
 * Source health (spec §4.5, Task 9): per platform and ISO week (IST), what the runs found. Each run adds, once per
 * platform it fetched (`addSourceHealth` keeps a run from being counted twice):
 *
 * | column | per run |
 * |---|---|
 * | fetched | distinct gigs of the platform this run normalised (one per gigKey, cross-query duplicates once) |
 * | eligible | of those, verdict `eligible` |
 * | above_floor | eligible or review, with fit at or above `fitFloor` |
 * | shortlisted | in Contracts or Gigs with documents ready |
 * | runs | 1 |
 * | failed_runs | 1 when any of the platform's source steps failed (or was skipped by an open breaker) |
 * | probe_failures | the streak of runs in which every source step of the platform failed or was skipped (0 after one that did not) |
 *
 * A Gmail run whose messages were all fetched but none parsed (no parser for those senders yet, or the label is
 * missing) is marked `gmail:no-parser` in `source_health_runs` and counted nowhere: neither a probe failure nor a
 * zero-yield week, so it never makes Gmail "look dead".
 *
 * `applied`, `replied` and `won` are the user's outcomes; no run writes them. A platform is counted only in a run that
 * fetched it: one whose source steps all replayed fetched nothing (a second run in the same half), and Remotive is
 * asked only in the am half. A source is reported as a problem "source <id> looks dead" (never removed) when its
 * latest 4 consecutive weeks all have counted runs and 0 above the floor, or when its probe_failures reach 3.
 */

export const DEAD_WEEKS = 4;
export const DEAD_PROBE_FAILURES = 3;

/** The ISO 8601 week (YYYY-Www) of a calendar date (YYYY-MM-DD; the run passes the IST date). */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${date}`);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0
  d.setUTCDate(d.getUTCDate() - day + 3); // the Thursday of this week decides its year
  const year = d.getUTCFullYear();
  const week = 1 + Math.floor((d.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The ISO week before `week`. */
export function previousWeek(week: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new Error(`not an ISO week: ${week}`);
  // Monday of the week, minus 7 days.
  const year = Number(m[1]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000 + (Number(m[2]) - 1) * 7 * 86_400_000);
  return isoWeek(new Date(monday.getTime() - 7 * 86_400_000).toISOString().slice(0, 10));
}

/** Whether a platform is fetched in a half (Remotive asks for few calls: only the am half). */
const fetchesIn = (platform: Platform, half: 'am' | 'pm'): boolean => !(platform === 'remotive' && half === 'pm');

/** One run's source steps, per platform: whether any executed (not replayed), any failed, all failed, and what they returned. */
function sourceSteps(kernel: Store, runId: string): Map<Platform, { executed: boolean; failed: number; total: number; gigKeys: Set<string>; notes: string[] }> {
  const events = new Map<string, { kind: string; status?: unknown; notes: string[] }>();
  // A skipped step has no step event; its queue status says so.
  for (const e of kernel.events(runId)) {
    const d = JSON.parse(e.data) as Record<string, unknown>;
    if (typeof d['agent'] !== 'string' || typeof d['envelopeId'] !== 'string' || !d['agent'].startsWith('src-')) continue;
    const notes = e.kind === 'step_done' && Array.isArray(d['skippedNotes']) ? d['skippedNotes'].filter((n): n is string => typeof n === 'string') : [];
    if (['step_done', 'step_replayed', 'step_failed'].includes(e.kind)) events.set(`${d['agent']}\u0000${d['envelopeId']}`, { kind: e.kind, status: d['status'], notes });
  }
  const out = new Map<Platform, { executed: boolean; failed: number; total: number; gigKeys: Set<string>; notes: string[] }>();
  for (const q of kernel.queueItems(runId)) {
    if (!q.agent_id.startsWith('src-')) continue;
    let req: GigRequest;
    try {
      req = kernel.getEnvelope(q.envelope_id).payload as GigRequest;
    } catch {
      continue;
    }
    if (PLATFORM_AGENT[req.platform] !== q.agent_id) continue; // a source answering another platform's request: not its fetch
    const s = out.get(req.platform) ?? { executed: false, failed: 0, total: 0, gigKeys: new Set<string>(), notes: [] };
    const e = events.get(`${q.agent_id}\u0000${q.envelope_id}`);
    if (e?.kind === 'step_done') s.notes.push(...e.notes);
    s.total += 1;
    // A request of its own platform that a breaker skipped was not fetched: for the probe streak it failed.
    if (q.status === 'failed' || q.status === 'skipped') s.failed += 1;
    if (e?.kind === 'step_done' || e?.kind === 'step_failed' || q.status === 'skipped') s.executed = true;
    out.set(req.platform, s);
  }
  return out;
}

/**
 * Counts one run into `source_health` and returns the dead-source problems of the platforms it counted. `rows` are the
 * projected rows of the run; `half` decides whether Remotive was asked.
 */
export function recordSourceHealth(
  kernel: Store,
  app: AppStore,
  runId: string,
  o: { readonly runDate: string; readonly half: 'am' | 'pm'; readonly fitFloor: number; readonly rows: readonly GigUpsert[] },
): Problem[] {
  const week = isoWeek(o.runDate);
  const steps = sourceSteps(kernel, runId);
  const problems: Problem[] = [];
  for (const [platform, s] of [...steps].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!s.executed || !fetchesIn(platform, o.half)) continue;
    const mine = o.rows.filter((r) => r.platform === platform);
    // Gmail read fine but no parser read any alert (or the label is missing): no evidence about the source either way.
    if (platform === 'gmail' && s.failed === 0 && mine.length === 0 && s.notes.some((n) => UNRECOGNISED_NOTE.test(n) || n === GMAIL_LABEL_MISSING)) {
      app.markSourceRun(runId, platform, 'no-parser');
      continue;
    }
    const previous = app.sourceHealth(platform).at(-1)?.probeFailures ?? 0;
    const allFailed = s.total > 0 && s.failed === s.total;
    app.addSourceHealth(runId, platform, week, {
      fetched: mine.length,
      eligible: mine.filter((r) => r.verdict === 'eligible').length,
      aboveFloor: mine.filter((r) => r.verdict !== 'rejected' && r.fit !== null && r.fit >= o.fitFloor).length,
      shortlisted: mine.filter((r) => (r.list === 'contracts' || r.list === 'gigs') && r.docsState === 'ready').length,
      failed: s.failed > 0,
      probeFailures: allFailed ? previous + 1 : 0,
    });
    const why = deadReason(app.sourceHealth(platform), week);
    if (why !== undefined) problems.push({ kind: 'source-dead', agent: 'source-health', item: `source ${platform}`, reason: `source ${platform} looks dead: ${why}` });
  }
  return problems;
}

/**
 * Why a source looks dead in `week`, or undefined: its probe failure streak reached DEAD_PROBE_FAILURES, or it has a
 * counted row for each of the DEAD_WEEKS consecutive weeks ending at `week` and none of them found a gig above the
 * floor. A week without a counted run is no evidence either way.
 */
export function deadReason(rows: readonly SourceHealthRow[], week: string): string | undefined {
  const byWeek = new Map(rows.map((r) => [r.week, r]));
  const latest = rows.at(-1);
  if (latest !== undefined && latest.probeFailures >= DEAD_PROBE_FAILURES) return `${latest.probeFailures} runs in a row failed every fetch`;
  let w = week;
  for (let i = 0; i < DEAD_WEEKS; i++) {
    const r = byWeek.get(w);
    if (r === undefined || r.runs === 0 || r.aboveFloor > 0) return undefined;
    w = previousWeek(w);
  }
  return `0 gigs above the fit floor for ${DEAD_WEEKS} weeks running`;
}

/**
 * A source step on another platform's request (every source gets every request and answers only its own): when a
 * breaker skips it, nothing was lost, so it is not a problem.
 */
export function foreignSourceStep(agentId: string, input: { readonly type: string; readonly payload: unknown }): boolean {
  if (!agentId.startsWith('src-') || input.type !== 'GigRequest@1') return false;
  const platform = (input.payload as Partial<GigRequest>).platform;
  return platform === undefined || PLATFORM_AGENT[platform] !== agentId;
}
