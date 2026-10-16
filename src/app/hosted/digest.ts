import { z } from 'zod';
import { canonicalJson } from '../../kernel/canonical.js';
import type { Envelope } from '../../kernel/envelope.js';
import { ERROR_CODES } from '../../kernel/errors.js';
import { Store } from '../../kernel/store/store.js';
import { gigIn, postingIn, runProblems } from '../problems.js';

/** One source's postings (job keys) and problem codes in a run (P12). */
export interface SourceDigest {
  readonly postings: readonly string[];
  readonly problems: readonly string[];
}
/**
 * What one run saw, as sorted keys and codes only (no posting text, no name): the unit the shadow comparator reads
 * (spec H1/H2). Built read-only from a database (`Store.openReadOnly`): never migrates, never writes.
 */
export interface Digest {
  readonly v: 1;
  /** The run's IST date. */
  readonly date: string;
  readonly env: 'hosted' | 'local';
  readonly pipeline: 'daily' | 'freelance';
  readonly runId: string;
  readonly startedAt: string;
  readonly codeSha: string | null;
  /** runs_summary / gig_runs_summary pack_hash ('' when the run wrote no summary). */
  readonly packHash: string;
  readonly sources: Readonly<Record<string, SourceDigest>>;
  /** Job keys with an `eligible` EligibilityVerdict in this run. */
  readonly eligible: readonly string[];
  readonly toDecide: readonly string[];
  /** Platform to gig keys (freelance). */
  readonly gigs: Readonly<Record<string, readonly string[]>>;
  readonly billedMinutes?: number;
}

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Keys = z.array(z.string());
export const DigestSchema = z.strictObject({
  v: z.literal(1),
  date: Day,
  env: z.enum(['hosted', 'local']),
  pipeline: z.enum(['daily', 'freelance']),
  runId: z.string().min(1),
  startedAt: z.string().min(1),
  codeSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  packHash: z.string(),
  sources: z.record(z.string(), z.strictObject({ postings: Keys, problems: Keys })),
  eligible: Keys,
  toDecide: Keys,
  gigs: z.record(z.string(), Keys),
  billedMinutes: z.number().min(0).optional(),
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(byCode);

const DAILY_ID = /^daily-(\d{4}-\d{2}-\d{2})(?:-\d+)?$/;
const FREELANCE_ID = /^freelance-(\d{4}-\d{2}-\d{2})-am(?:-\d+)?$/;
const IST_MS = 19_800_000;
const DAY_MS = 86_400_000;

/** The pipeline and IST date a run id names, or null for an id this digest does not cover. */
function parseRunId(runId: string): { pipeline: 'daily' | 'freelance'; date: string } | null {
  const d = DAILY_ID.exec(runId)?.[1];
  if (d !== undefined) return { pipeline: 'daily', date: d };
  const f = FREELANCE_ID.exec(runId)?.[1];
  return f !== undefined ? { pipeline: 'freelance', date: f } : null;
}

/** The instant (ISO UTC) of 00:00 IST on `date`, `back` days earlier. */
function istMidnight(date: string, back: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - IST_MS - back * DAY_MS).toISOString();
}

/** P12: the source id of a queue item's input. */
function sourceOfInput(input: Envelope | undefined, agent: string): string {
  if (input === undefined) return agent;
  const p = isObj(input.payload) ? input.payload : {};
  if (input.type === 'DiscoveryRequest@1') {
    const ats = str(p['ats']);
    return (ats === 'feed' ? str(p['slug']) : ats) ?? agent;
  }
  if (input.type === 'GigRequest@1' || input.type === 'RawGig@1') return str(p['platform']) ?? agent;
  if (input.type === 'RawPosting@1') return str(p['source']) ?? agent;
  const gig = gigIn(input);
  if (gig !== undefined) return str(gig['platform']) ?? agent;
  const posting = postingIn(input);
  if (posting !== undefined) return str(posting['source']) ?? agent;
  return agent;
}

const hasTable = (db: Store['db'], name: string): boolean => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

/** The run's done and replayed steps minus the quarantined ones, as `projectRun` reads them. */
function doneSteps(kernel: Store, runId: string): string[] {
  const done = new Set<string>();
  const quarantined = new Set<string>();
  for (const e of kernel.events(runId)) {
    const d = JSON.parse(e.data) as Record<string, unknown>;
    const stepKey = str(d['stepKey']);
    if (stepKey === undefined) continue;
    if (e.kind === 'step_done' || (e.kind === 'step_replayed' && d['status'] === 'done')) done.add(stepKey);
    else if (e.kind === 'step_quarantined' || (e.kind === 'step_replayed' && d['status'] === 'quarantined')) quarantined.add(stepKey);
  }
  for (const k of quarantined) done.delete(k);
  return [...done].sort(byCode);
}

/** Problem codes per source: a failed step's error code when it is one of `ERROR_CODES`, else the problem kind. */
function problemCodes(kernel: Store, runId: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const errors = new Map<string, string>();
  for (const e of kernel.events(runId)) {
    if (e.kind !== 'step_failed') continue;
    const d = JSON.parse(e.data) as Record<string, unknown>;
    const agent = str(d['agent']);
    const envelopeId = str(d['envelopeId']) ?? kernel.getStep(str(d['stepKey']) ?? '')?.input_envelope_id;
    const error = str(d['error']);
    if (agent !== undefined && envelopeId !== undefined && error !== undefined) errors.set(`${agent}\u0000${envelopeId}`, error);
  }
  // runProblems returns one problem per non-done, non-pending queue item in queue order, then the qa blocks
  const items = kernel.queueItems(runId).filter((q) => q.status !== 'done' && q.status !== 'pending');
  const problems = runProblems(kernel, runId, { forbiddenTerms: [] });
  const add = (source: string, code: string): void => void out.set(source, (out.get(source) ?? new Set()).add(code));
  problems.forEach((p, i) => {
    const q = items[i];
    if (q === undefined) return add(p.agent, p.kind);
    let input: Envelope | undefined;
    try {
      input = kernel.getEnvelope(q.envelope_id);
    } catch {
      input = undefined;
    }
    const error = errors.get(`${q.agent_id}\u0000${q.envelope_id}`);
    add(sourceOfInput(input, q.agent_id), p.kind === 'failed' && error !== undefined && (ERROR_CODES as readonly string[]).includes(error) ? error : p.kind);
  });
  return out;
}

/** Opens the DB with Store.openReadOnly (never migrates, never writes) and digests one run. */
export function digestRun(
  db: string,
  runId: string,
  o: { readonly env: 'hosted' | 'local'; readonly codeSha: string | null; readonly billedMinutes?: number },
): Digest {
  const id = parseRunId(runId);
  if (id === null) throw new Error(`digest: ${runId} is not a daily run or a freelance am run`);
  const kernel = Store.openReadOnly(db, { forensic: true });
  try {
    const row = kernel.db.prepare(`SELECT started_at, finished_at FROM runs WHERE run_id = ?`).get(runId) as { started_at: string; finished_at: string | null } | undefined;
    if (row === undefined) throw new Error(`digest: unknown run ${runId}`);
    const end = row.finished_at ?? kernel.events(runId).at(-1)?.at ?? row.started_at;

    const postings = new Map<string, Set<string>>();
    const eligible = new Set<string>();
    const gigs = new Map<string, Set<string>>();
    const push = (m: Map<string, Set<string>>, k: string, v: string): void => void m.set(k, (m.get(k) ?? new Set()).add(v));
    for (const stepKey of doneSteps(kernel, runId)) {
      for (const env of kernel.envelopesOfStep(stepKey)) {
        const p = isObj(env.payload) ? env.payload : {};
        if (env.type === 'Posting@1') {
          const source = str(p['source']);
          const key = str(p['jobKey']);
          if (source !== undefined && key !== undefined) push(postings, source, key);
        } else if (env.type === 'EligibilityVerdict@1' && p['verdict'] === 'eligible') {
          const key = isObj(p['posting']) ? str(p['posting']['jobKey']) : undefined;
          if (key !== undefined) eligible.add(key);
        } else if (env.type === 'Gig@1') {
          const platform = str(p['platform']);
          const key = str(p['gigKey']);
          if (platform !== undefined && key !== undefined) push(gigs, platform, key);
        }
      }
    }
    const problems = problemCodes(kernel, runId);

    const summaryTable = id.pipeline === 'daily' ? 'runs_summary' : 'gig_runs_summary';
    const packHash = hasTable(kernel.db, summaryTable)
      ? ((kernel.db.prepare(`SELECT pack_hash FROM ${summaryTable} WHERE run_id = ?`).get(runId) as { pack_hash: string } | undefined)?.pack_hash ?? '')
      : '';

    let toDecide: string[] = [];
    if (id.pipeline === 'daily' && hasTable(kernel.db, 'jobs') && hasTable(kernel.db, 'status_history')) {
      const mine = new Set([...postings.values()].flatMap((s) => [...s]));
      const rows = kernel.db
        .prepare(
          `SELECT j.job_key FROM jobs j
           WHERE j.duplicate_of IS NULL AND (j.verdict IS NULL OR j.verdict <> 'rejected') AND j.docs_state <> 'below-floor'
             AND j.first_seen >= @from AND j.first_seen <= @end
             AND COALESCE((SELECT h."to" FROM status_history h WHERE h.job_key = j.job_key AND h.at <= @end ORDER BY h.seq DESC LIMIT 1), 'new') = 'new'`,
        )
        .all({ from: istMidnight(id.date, 6), end }) as { job_key: string }[];
      toDecide = sortedUnique(rows.map((r) => r.job_key).filter((k) => mine.has(k)));
    }

    const sourceIds = sortedUnique([...postings.keys(), ...problems.keys()]);
    return {
      v: 1,
      date: id.date,
      env: o.env,
      pipeline: id.pipeline,
      runId,
      startedAt: row.started_at,
      codeSha: o.codeSha,
      packHash,
      sources: Object.fromEntries(sourceIds.map((s) => [s, { postings: sortedUnique(postings.get(s) ?? []), problems: sortedUnique(problems.get(s) ?? []) }])),
      eligible: sortedUnique(eligible),
      toDecide,
      gigs: Object.fromEntries([...gigs].sort(([a], [b]) => byCode(a, b)).map(([p, ks]) => [p, sortedUnique(ks)])),
      ...(o.billedMinutes !== undefined ? { billedMinutes: o.billedMinutes } : {}),
    };
  } finally {
    kernel.close();
  }
}

/** The run of `pipeline` on `date` to digest: the earliest started of `daily-<date>[-n]` or `freelance-<date>-am[-n]`, or null. */
export function runOn(db: string, pipeline: 'daily' | 'freelance', date: string): string | null {
  const kernel = Store.openReadOnly(db, { forensic: true });
  try {
    const rows = kernel.db
      .prepare(`SELECT run_id FROM runs WHERE run_id LIKE ? ORDER BY started_at, run_id`)
      .all(pipeline === 'daily' ? `daily-${date}%` : `freelance-${date}-am%`) as { run_id: string }[];
    const re = pipeline === 'daily' ? DAILY_ID : FREELANCE_ID;
    return rows.find((r) => re.test(r.run_id))?.run_id ?? null;
  } finally {
    kernel.close();
  }
}

export const digestJson = (d: Digest): string => `${canonicalJson(d)}\n`;
export const digestFileName = (d: Pick<Digest, 'date' | 'pipeline'>): string => `${d.date}-${d.pipeline}.json`;
