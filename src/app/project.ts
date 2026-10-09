import type { FxRates } from './comp/floor.js';
import type { DocCheck } from './docs-check.js';
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
  /**
   * Checks a QA-passed document is on disk with its recorded sha256 (`diskDocCheck(outDir())` in production). A job
   * is `ready` only when every listed file checks `ok`; otherwise its documents are `missing`.
   */
  readonly docOnDisk: DocCheck;
}

export interface ProjectResult {
  /** Jobs written (one row each). */
  readonly jobs: number;
  /** Of those, rows that did not exist before. */
  readonly inserted: number;
  /** Jobs skipped because the row was last seen after this run (an older run projected late); not in `jobs`. */
  readonly stale: number;
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
/** Job tracker states a writing step's input leaves from: a scored job, or one further along. */
const WRITING_STATES: ReadonlySet<string> = new Set(['SCORED', 'PLANNED', 'RENDERED']);

interface Quarantine {
  readonly agent: string;
  readonly inputRank: number;
  readonly detail: string;
}

interface JobGroup {
  readonly envs: Envelope[];
  readonly quarantines: Quarantine[];
  readonly failures: { agent: string; error: string; inputRank: number; reason?: string }[];
  /** Review I3: a writing step of this job could not commit its files in this run. */
  commitFailed?: boolean;
}

/** Review I3: the docs detail of a job whose files could not be committed. */
export const COMMIT_FAILED_DETAIL = 'the documents could not be written to disk (files commit failed); they are rendered again on the next run';

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
 * The job key is the posting's identity (`jobKey(source, sourceId)`), so a re-emitted posting upserts its row (a newer
 * version) and a Desk row with that source id is the same row; cross-source listings are linked by the store through
 * the dedupe key. A job whose row was last seen after this run's time is skipped (`stale`), so projecting an older run
 * never overwrites newer data or docs. Docs are replaced on every projected job, so they always mirror the latest run that saw it. Status and
 * note are never written. Projecting a run twice is a no-op.
 */
/** Named reasons a failed writing step's detail may carry; only these (never the free text, which may quote data) are shown. */
const NAMED_REASON = /\b(?:unrenderable-glyph:U\+[0-9A-F]{4,6}|unsafe-posting-text|G-NAMING: forbidden term #\d+)\b/;

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
  const failed = new Map<string, { agent: string; error: string; reason?: string }>();
  const commitFailed = new Set<string>();
  for (const e of events) {
    const d = dataOf(e);
    const stepKey = str(d['stepKey']);
    const agent = str(d['agent']) ?? '';
    if (stepKey === undefined) continue;
    if (e.kind === 'step_done' || (e.kind === 'step_replayed' && d['status'] === 'done')) done.add(stepKey);
    else if (e.kind === 'files_commit_failed') commitFailed.add(stepKey);
    else if (e.kind === 'step_quarantined') quarantined.set(stepKey, { agent, verdict: d['verdict'] });
    else if (e.kind === 'step_replayed' && d['status'] === 'quarantined') {
      const row = kernel.getStep(stepKey);
      const verdicts = JSON.parse(row?.detail ?? '[]') as unknown[];
      quarantined.set(stepKey, { agent, verdict: verdicts.at(-1) });
    } else if (e.kind === 'step_failed') {
      const reason = NAMED_REASON.exec(str(d['detail']) ?? '')?.[0];
      failed.set(stepKey, { agent, error: str(d['error']) ?? 'unknown', ...(reason !== undefined ? { reason } : {}) });
    }
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
    let inputRank = input ? (RANK[input.type] ?? 0) : 0;
    if (key === null && !input) {
      // An input-side trip: the tracker's transition names the job, and the state it left says how far the job got,
      // so a trip at eligibility or the scorer is not mistaken for a writing step.
      const t = kernel.transitionsOfStep(stepKey).find((x) => x.kind === JOB_TRACKER_KIND);
      key = t?.entity_id ?? null;
      inputRank = t !== undefined && WRITING_STATES.has(t.from_state) ? WRITING_INPUT_RANK : 0;
    }
    if (key === null) {
      if (!input) unresolvedQuarantines += 1;
      continue;
    }
    const g = group(key);
    if (input) g.envs.push(input);
    g.quarantines.push({ agent: q.agent, inputRank, detail: `${q.agent} quarantined: ${verdictText(q.verdict)}` });
  }
  for (const stepKey of [...commitFailed].sort()) {
    const input = inputOf(kernel, stepKey);
    const key = input ? jobKeyOf(input) : null;
    if (key !== null) group(key).commitFailed = true;
  }
  for (const [stepKey, f] of [...failed].sort(([a], [b]) => cmp(a, b))) {
    const input = inputOf(kernel, stepKey);
    const key = input ? jobKeyOf(input) : null;
    if (key === null || !input) continue;
    const g = group(key);
    g.envs.push(input);
    g.failures.push({ agent: f.agent, error: f.error, inputRank: RANK[input.type] ?? 0, ...(f.reason !== undefined ? { reason: f.reason } : {}) });
  }

  // 4. one row per job
  const docs: Record<DocsState, number> = { ready: 0, blocked: 0, 'below-floor': 0, none: 0, missing: 0 };
  let jobs = 0;
  let inserted = 0;
  let stale = 0;
  app.tx(() => {
    for (const key of [...groups.keys()].sort()) {
      const g = groups.get(key) as JobGroup;
      const r = rowOf(key, g, at, opts);
      if (!r) continue;
      const res = app.upsertJob(r.row);
      if (res.stale) {
        // An older run than the row's last sighting: it must not overwrite newer data or docs.
        stale += 1;
        continue;
      }
      app.putDocs(res.jobKey, r.docs);
      jobs += 1;
      if (res.inserted) inserted += 1;
      docs[r.row.docsState] += 1;
    }
  });
  return { jobs, inserted, stale, docs, unresolvedQuarantines };
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

/** A QaReport's documents and their state: `ready` only when QA passed and every file is on disk with its sha256. */
export function docsOfQa(qa: QaReport, docOnDisk: DocCheck): { docsState: DocsState; docsDetail: string | null; docs: Doc[] } {
  let docsState: DocsState = qa.ok ? 'ready' : 'blocked';
  let docsDetail = qa.ok ? null : `qa failed: ${qa.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join('; ')}`;
  const docs = qa.files.map((f) => ({ kind: f.kind, format: f.format, path: f.path, sha256: f.sha256, pages: f.pages, qaOk: qa.ok }));
  if (qa.ok) {
    const gone = qa.files.flatMap((f) => {
      const s = docOnDisk(f.path, f.sha256);
      return s === 'ok' ? [] : [`${f.path} ${s === 'absent' ? 'is not on disk' : 'changed on disk'}`];
    });
    if (gone.length > 0) {
      docsState = 'missing';
      docsDetail = `documents missing: ${gone.join('; ')}`;
    }
  }
  return { docsState, docsDetail, docs };
}

export interface DocsChange {
  readonly jobKey: string;
  readonly from: DocsState | undefined;
  readonly to: DocsState;
}

/**
 * Projects a `docs rebuild` run (renderer and qa-gate only): each job's documents and docs state come from its new
 * QaReport (`docsOfQa`); a quarantined renderer or qa-gate step blocks the job's documents with its verdict, and a
 * failure with a named reason (an unrenderable glyph) blocks them with that reason. No other column is written.
 * Returns every job written, with its docs state before and after.
 */
export function projectDocs(kernel: Store, app: AppStore, runId: string, opts: Pick<ProjectOptions, 'docOnDisk'>): DocsChange[] {
  const events = kernel.events(runId);
  const out = new Map<string, { docsState: DocsState; docsDetail: string | null; docs: Doc[] }>();
  for (const e of events) {
    const d = dataOf(e);
    const stepKey = str(d['stepKey']);
    if (stepKey === undefined) continue;
    const done = e.kind === 'step_done' || (e.kind === 'step_replayed' && d['status'] === 'done');
    if (done && d['agent'] === 'qa-gate') {
      for (const env of kernel.envelopesOfStep(stepKey)) {
        const key = jobKeyOf(env);
        if (key !== null && env.type === 'QaReport@1') out.set(key, docsOfQa(env.payload as QaReport, opts.docOnDisk));
      }
      continue;
    }
    const input = inputOf(kernel, stepKey) ?? (str(d['envelopeId']) !== undefined ? safeEnvelope(kernel, str(d['envelopeId']) as string) : undefined);
    const key = input ? jobKeyOf(input) : null;
    if (key === null) continue;
    if (e.kind === 'step_quarantined') out.set(key, { docsState: 'blocked', docsDetail: `${str(d['agent']) ?? '?'} quarantined: ${verdictText(d['verdict'])}`, docs: [] });
    if (e.kind === 'files_commit_failed') out.set(key, { docsState: 'blocked', docsDetail: COMMIT_FAILED_DETAIL, docs: [] });
    if (e.kind === 'step_failed') {
      const reason = NAMED_REASON.exec(str(d['detail']) ?? '')?.[0];
      if (reason !== undefined) out.set(key, { docsState: 'blocked', docsDetail: `${str(d['agent']) ?? '?'} failed: ${str(d['error']) ?? 'unknown'} (${reason})`, docs: [] });
    }
  }
  const changes: DocsChange[] = [];
  app.tx(() => {
    for (const key of [...out.keys()].sort()) {
      const r = out.get(key) as { docsState: DocsState; docsDetail: string | null; docs: Doc[] };
      const from = app.getJob(key)?.docsState;
      if (app.setDocs(key, r.docsState, r.docsDetail, r.docs)) changes.push({ jobKey: key, from, to: r.docsState });
    }
  });
  return changes;
}

function safeEnvelope(kernel: Store, id: string): Envelope | undefined {
  try {
    return kernel.getEnvelope(id);
  } catch {
    return undefined;
  }
}

function rowOf(key: string, g: JobGroup, at: string, opts: ProjectOptions): { row: JobUpsert; docs: Doc[] } | undefined {
  // Unique envelopes, furthest stage first, then envelope id.
  const envs = [...new Map(g.envs.map((e) => [e.envelopeId, e])).values()].sort(
    (a, b) => (RANK[b.type] ?? 0) - (RANK[a.type] ?? 0) || cmp(a.envelopeId, b.envelopeId),
  );
  const carriers = envs.filter((e) => postingOf(e) !== undefined);
  const primary = carriers[0];
  if (!primary) return undefined;
  const posting = postingOf(primary) as Posting;
  const elig = pick<EligibilityVerdict>(envs, 'EligibilityVerdict@1');
  const sc = pick<Scored>(envs, 'Scored@1');
  const ev = pick<Evidence>(envs, 'Evidence@1');
  const plan = pick<ResumePlan>(envs, 'ResumePlan@1');
  const rendered = pick<Rendered>(envs, 'Rendered@1');
  const qa = pick<QaReport>(envs, 'QaReport@1');

  let docsState: DocsState = 'none';
  let docsDetail: string | null = null;
  let docs: Doc[] = [];
  const writingQuarantine = g.quarantines.find((q) => q.inputRank >= WRITING_INPUT_RANK);
  const writingFailure = g.failures.find((f) => f.inputRank >= WRITING_INPUT_RANK);
  if (g.commitFailed) {
    docsState = 'blocked';
    docsDetail = COMMIT_FAILED_DETAIL;
  } else if (qa) {
    ({ docsState, docsDetail, docs } = docsOfQa(qa, opts.docOnDisk));
  } else if (writingQuarantine) {
    docsState = 'blocked';
    docsDetail = writingQuarantine.detail;
  } else if (sc && sc.score < opts.minFit) {
    docsState = 'below-floor';
  } else {
    const q = g.quarantines[0];
    if (q) docsDetail = q.detail;
    else if (writingFailure) {
      // A named, deterministic reason (an unrenderable glyph, unsafe posting text) blocks the documents; it is shown.
      docsDetail = `${writingFailure.agent} failed: ${writingFailure.error}${writingFailure.reason ? ` (${writingFailure.reason})` : ''}`;
      if (writingFailure.reason) docsState = 'blocked';
    }
  }

  const comp = posting.comp;
  const row: JobUpsert = {
    jobKey: key,
    dedupeKey: posting.dedupeKey,
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
    unplaced: plan?.unplaced ?? [],
    at,
  };
  return { row, docs };
}

export interface AgentCounts {
  done: number;
  failed: number;
  /** Failed steps whose item is gone at its source; included in `failed`. */
  gone: number;
  /** Failed steps refused for their input alone (`input_rejected`); included in `failed`. */
  inputRejected: number;
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

const zero = (): AgentCounts => ({ done: 0, failed: 0, gone: 0, inputRejected: 0, quarantined: 0, skipped: 0, pending: 0, replayed: 0 });

/** Per-agent outcome counts of one run, from its queue (outcomes) and events (gone, replayed), for `runs_summary`. */
export function runCounts(kernel: Store, runId: string): RunCounts {
  const by = new Map<string, AgentCounts>();
  const of = (agent: string): AgentCounts => {
    let c = by.get(agent);
    if (!c) by.set(agent, (c = zero()));
    return c;
  };
  for (const q of kernel.queueItems(runId)) of(q.agent_id)[q.status as QueueStatus] += 1;
  // One per (agent, input envelope): a step re-tried after a crash in a resumed run is counted once (review m1).
  const seen = new Set<string>();
  for (const e of kernel.events(runId)) {
    const d = dataOf(e);
    const agent = str(d['agent']);
    if (agent === undefined) continue;
    const once = (kind: string): boolean => {
      const k = `${kind}\u0000${agent}\u0000${str(d['envelopeId']) ?? `seq:${e.seq}`}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    };
    if (e.kind === 'step_failed' && d['error'] === 'gone' && once('gone')) of(agent).gone += 1;
    if (e.kind === 'step_failed' && d['error'] === 'input_rejected' && once('input_rejected')) of(agent).inputRejected += 1;
    if (e.kind === 'step_replayed' && once('replayed')) of(agent).replayed += 1;
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
