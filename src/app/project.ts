import type { FxRates } from './comp/floor.js';
import type { Doc, DocsState, JobUpsert } from './store/app-store.js';
import type { AppStore } from './store/app-store.js';
import { JOB_TRACKER_KIND, jobKeyOf } from './tracker.js';
import type { EligibilityVerdict, Evidence, Posting, QaReport, Rendered, ResumePlan, Scored } from './types.js';
import type { Envelope, GuardrailVerdict } from '../kernel/envelope.js';
import type { EventRow, QueueStatus, Store } from '../kernel/store/store.js';

export interface ProjectOptions {
  /** The pack's `targets.minFit`: a score under it is `below-floor`. */
  readonly minFit: number;
  /** The pack's fx table, for comp in INR. */
  readonly fx: FxRates;
  /** When the jobs were seen; default the run's `run_started` event time. */
  readonly at?: string;
}

export interface ProjectResult {
  /** Jobs written (one row each). */
  readonly jobs: number;
  /** Of those, rows that did not exist before. */
  readonly inserted: number;
  readonly docs: Record<DocsState, number>;
  /** Quarantines the projector could not tie to a job (an input-side trip with no tracker transition). */
  readonly unresolvedQuarantines: number;
}

/** Pipeline order of the types that carry a job; the furthest one reached decides a job's row. */
const RANK: Readonly<Record<string, number>> = {
  'Posting@1': 1, 'EligibilityVerdict@1': 2, 'Scored@1': 3, 'Evidence@1': 4, 'ResumePlan@1': 5, 'CoverPlan@1': 6, 'Rendered@1': 7, 'QaReport@1': 8,
};
/** A quarantine of a step whose input is at least this far along blocks the job's documents (the writing team). */
const WRITING_INPUT_RANK = RANK['Scored@1'] as number;

interface Quarantine {
  readonly agent: string;
  readonly inputRank: number;
  readonly detail: string;
}

interface JobGroup {
  readonly envs: Envelope[];
  readonly quarantines: Quarantine[];
  readonly failures: { agent: string; error: string; inputRank: number }[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const dataOf = (e: EventRow): Record<string, unknown> => JSON.parse(e.data) as Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function verdictText(v: unknown): string {
  if (typeof v !== 'object' || v === null) return 'quarantined';
  const g = v as Partial<GuardrailVerdict>;
  return g.detail === undefined ? String(g.id) : `${String(g.id)}: ${g.detail}`;
}

/** The posting an envelope carries, if any. */
function postingOf(env: Envelope): Posting | undefined {
  switch (env.type) {
    case 'Posting@1':
      return env.payload as Posting;
    case 'EligibilityVerdict@1':
    case 'Scored@1':
      return (env.payload as EligibilityVerdict | Scored).posting;
    case 'Evidence@1':
      return (env.payload as Evidence).scored.posting;
    default:
      return undefined;
  }
}

/** One envelope of a type from a job's group; several (two sources, one job) resolve by envelope id, a total order. */
function pick<T>(envs: readonly Envelope[], type: string): T | undefined {
  const xs = envs.filter((e) => e.type === type).sort((a, b) => cmp(a.envelopeId, b.envelopeId));
  return xs[0]?.payload as T | undefined;
}

const inr = (v: number | null, p: Posting['comp'], fx: FxRates): number | null =>
  v === null || p === null ? null : Math.round(v * fx.toINR[p.currency]);

/**
 * Writes one run's outputs into the app catalogue (spec §6). It reads the run's own steps from the kernel store's
 * events (done and replayed steps, minus any a tracker quarantined in this run), groups their envelopes by job key and
 * writes one row per job from the furthest stage reached:
 *
 * | Furthest | Row |
 * |---|---|
 * | EligibilityVerdict rejected | verdict and reasons, docs `none` |
 * | Scored under minFit | score, docs `below-floor` |
 * | QaReport | docs replaced by its files; `ready` when ok, else `blocked` with the failed checks |
 * | a quarantined writing step (input Scored or later) | docs `blocked` with the guardrail verdict |
 * | anything else | docs `none` (with a failed writing step named in `docs_detail`) |
 *
 * Every posting seen attaches its `(source, sourceId)`; a known one maps to its existing row (a newer version, or a
 * Desk row). Docs are replaced on every projected job, so they always mirror the latest run that saw it. Status and
 * note are never written. Projecting a run twice is a no-op.
 */
export function projectRun(kernel: Store, app: AppStore, runId: string, opts: ProjectOptions): ProjectResult {
  const run = kernel.getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const events = kernel.events(runId);
  const at = opts.at ?? events.find((e) => e.kind === 'run_started')?.at ?? events[0]?.at;
  if (at === undefined) throw new Error(`run ${runId} has no events`);

  const groups = new Map<string, JobGroup>();
  const group = (key: string): JobGroup => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { envs: [], quarantines: [], failures: [] }));
    return g;
  };

  // 1. the run's step outcomes, from its events (the event log is per run; the step table is not)
  const done = new Set<string>();
  const quarantined = new Map<string, { agent: string; verdict: unknown }>();
  const failed = new Map<string, { agent: string; error: string }>();
  for (const e of events) {
    const d = dataOf(e);
    const stepKey = str(d['stepKey']);
    const agent = str(d['agent']) ?? '';
    if (stepKey === undefined) continue;
    if (e.kind === 'step_done' || (e.kind === 'step_replayed' && d['status'] === 'done')) done.add(stepKey);
    else if (e.kind === 'step_quarantined') quarantined.set(stepKey, { agent, verdict: d['verdict'] });
    else if (e.kind === 'step_replayed' && d['status'] === 'quarantined') {
      const row = kernel.getStep(stepKey);
      const verdicts = JSON.parse(row?.detail ?? '[]') as unknown[];
      quarantined.set(stepKey, { agent, verdict: verdicts.at(-1) });
    } else if (e.kind === 'step_failed') failed.set(stepKey, { agent, error: str(d['error']) ?? 'unknown' });
  }
  for (const k of quarantined.keys()) done.delete(k);

  // 2. done outputs, grouped by job
  for (const stepKey of [...done].sort()) {
    for (const env of kernel.envelopesOfStep(stepKey)) {
      const key = jobKeyOf(env);
      if (key !== null) group(key).envs.push(env);
    }
  }

  // 3. quarantines and failures, tied to their job through the step's input (or, for an input-side trip that wrote
  //    no step row, through the job tracker's transition)
  let unresolvedQuarantines = 0;
  for (const [stepKey, q] of [...quarantined].sort(([a], [b]) => cmp(a, b))) {
    const input = inputOf(kernel, stepKey);
    let key = input ? jobKeyOf(input) : null;
    if (key === null && !input) {
      key = kernel.transitionsOfStep(stepKey).find((t) => t.kind === JOB_TRACKER_KIND)?.entity_id ?? null;
    }
    if (key === null) {
      if (!input) unresolvedQuarantines += 1;
      continue;
    }
    const g = group(key);
    if (input) g.envs.push(input);
    g.quarantines.push({ agent: q.agent, inputRank: input ? (RANK[input.type] ?? 0) : WRITING_INPUT_RANK, detail: `${q.agent} quarantined: ${verdictText(q.verdict)}` });
  }
  for (const [stepKey, f] of [...failed].sort(([a], [b]) => cmp(a, b))) {
    const input = inputOf(kernel, stepKey);
    const key = input ? jobKeyOf(input) : null;
    if (key === null || !input) continue;
    const g = group(key);
    g.envs.push(input);
    g.failures.push({ agent: f.agent, error: f.error, inputRank: RANK[input.type] ?? 0 });
  }

  // 4. one row per job
  const docs: Record<DocsState, number> = { ready: 0, blocked: 0, 'below-floor': 0, none: 0 };
  let jobs = 0;
  let inserted = 0;
  app.tx(() => {
    for (const key of [...groups.keys()].sort()) {
      const g = groups.get(key) as JobGroup;
      const r = rowOf(key, g, at, opts);
      if (!r) continue;
      const res = app.upsertJob(r.row);
      for (const p of r.otherPostings) app.attachSource(res.jobKey, p.source, p.sourceId);
      app.putDocs(res.jobKey, r.docs);
      jobs += 1;
      if (res.inserted) inserted += 1;
      docs[r.row.docsState] += 1;
    }
  });
  return { jobs, inserted, docs, unresolvedQuarantines };
}

function inputOf(kernel: Store, stepKey: string): Envelope | undefined {
  const row = kernel.getStep(stepKey);
  if (!row || row.input_envelope_id === '') return undefined;
  try {
    return kernel.getEnvelope(row.input_envelope_id);
  } catch {
    return undefined;
  }
}

function rowOf(key: string, g: JobGroup, at: string, opts: ProjectOptions): { row: JobUpsert; docs: Doc[]; otherPostings: Posting[] } | undefined {
  // Unique envelopes, furthest stage first, then envelope id.
  const envs = [...new Map(g.envs.map((e) => [e.envelopeId, e])).values()].sort(
    (a, b) => (RANK[b.type] ?? 0) - (RANK[a.type] ?? 0) || cmp(a.envelopeId, b.envelopeId),
  );
  const carriers = envs.filter((e) => postingOf(e) !== undefined);
  const primary = carriers[0];
  if (!primary) return undefined;
  const posting = postingOf(primary) as Posting;
  const ident = (p: Posting) => `${p.source}\u0000${p.sourceId}`;
  const otherPostings = [...new Map(carriers.map((e) => postingOf(e) as Posting).filter((p) => ident(p) !== ident(posting)).map((p) => [ident(p), p])).values()];

  const sameSource = envs.filter((e) => {
    const p = postingOf(e);
    return p === undefined || ident(p) === ident(posting);
  });
  const elig = pick<EligibilityVerdict>(sameSource, 'EligibilityVerdict@1');
  const sc = pick<Scored>(sameSource, 'Scored@1');
  const ev = pick<Evidence>(sameSource, 'Evidence@1');
  const plan = pick<ResumePlan>(envs, 'ResumePlan@1');
  const rendered = pick<Rendered>(envs, 'Rendered@1');
  const qa = pick<QaReport>(envs, 'QaReport@1');

  let docsState: DocsState = 'none';
  let docsDetail: string | null = null;
  let docs: Doc[] = [];
  const writingQuarantine = g.quarantines.find((q) => q.inputRank >= WRITING_INPUT_RANK);
  const writingFailure = g.failures.find((f) => f.inputRank >= WRITING_INPUT_RANK);
  if (qa) {
    docsState = qa.ok ? 'ready' : 'blocked';
    docsDetail = qa.ok ? null : `qa failed: ${qa.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join('; ')}`;
    docs = qa.files.map((f) => ({ kind: f.kind, format: f.format, path: f.path, sha256: f.sha256, pages: f.pages, qaOk: qa.ok }));
  } else if (writingQuarantine) {
    docsState = 'blocked';
    docsDetail = writingQuarantine.detail;
  } else if (sc && sc.score < opts.minFit) {
    docsState = 'below-floor';
  } else {
    const q = g.quarantines[0];
    if (q) docsDetail = q.detail;
    else if (writingFailure) docsDetail = `${writingFailure.agent} failed: ${writingFailure.error}`;
  }

  const comp = posting.comp;
  const row: JobUpsert = {
    jobKey: key,
    source: posting.source,
    sourceId: posting.sourceId,
    company: posting.company,
    title: posting.title,
    url: posting.url,
    ats: posting.ats,
    location: posting.locationText,
    remote: posting.remote,
    comp,
    compMinInr: inr(comp?.min ?? null, comp, opts.fx),
    compMaxInr: inr(comp?.max ?? null, comp, opts.fx),
    compBasis: comp?.basis ?? null,
    score: sc?.score ?? null,
    breakdown: sc?.breakdown ?? null,
    verdict: sc?.verdict ?? elig?.verdict ?? null,
    reasons: elig?.reasons ?? [],
    notes: sc?.notes ?? elig?.notes ?? [],
    jdText: posting.descriptionText,
    terms: plan ? { covered: plan.covered, missing: plan.missing } : ev ? { covered: ev.covered, missing: ev.missing } : null,
    recommendedFormat: rendered?.recommended ?? null,
    docsState,
    docsDetail,
    postedAt: posting.postedAt,
    at,
  };
  return { row, docs, otherPostings };
}

export interface AgentCounts {
  done: number;
  failed: number;
  /** Failed steps whose item is gone at its source; included in `failed`. */
  gone: number;
  quarantined: number;
  skipped: number;
  pending: number;
  /** Done or quarantined steps answered from the store, not executed; included in their outcome. */
  replayed: number;
}

export interface RunCounts {
  readonly byAgent: Record<string, AgentCounts>;
  readonly totals: AgentCounts;
}

const zero = (): AgentCounts => ({ done: 0, failed: 0, gone: 0, quarantined: 0, skipped: 0, pending: 0, replayed: 0 });

/** Per-agent outcome counts of one run, from its queue (outcomes) and events (gone, replayed), for `runs_summary`. */
export function runCounts(kernel: Store, runId: string): RunCounts {
  const by = new Map<string, AgentCounts>();
  const of = (agent: string): AgentCounts => {
    let c = by.get(agent);
    if (!c) by.set(agent, (c = zero()));
    return c;
  };
  for (const q of kernel.queueItems(runId)) of(q.agent_id)[q.status as QueueStatus] += 1;
  for (const e of kernel.events(runId)) {
    const d = dataOf(e);
    const agent = str(d['agent']);
    if (agent === undefined) continue;
    if (e.kind === 'step_failed' && d['error'] === 'gone') of(agent).gone += 1;
    if (e.kind === 'step_replayed') of(agent).replayed += 1;
  }
  const byAgent: Record<string, AgentCounts> = {};
  const totals = zero();
  for (const agent of [...by.keys()].sort()) {
    const c = by.get(agent) as AgentCounts;
    byAgent[agent] = c;
    for (const k of Object.keys(totals) as (keyof AgentCounts)[]) totals[k] += c[k];
  }
  return { byAgent, totals };
}
