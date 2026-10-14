import { createHash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { canonicalJson } from '../../kernel/canonical.js';
import type { Store } from '../../kernel/store/store.js';
import { BOARD_SEED_DAYS, NEWEST_FIRST, type AppStore } from './app-store.js';
import { verifyChain } from '../../kernel/store/audit.js';

/**
 * Declarative envelope retention (`jobpilot store compact` / `store restore`; perf-research.md (c), (e) and Fix 3).
 *
 * Envelopes are the bulk of a home (~450 MB per daily run, kept forever). Compaction moves the envelopes no reader needs
 * any more, with the step rows that produced them, to append-only gzip segment files under `$JOBPILOT_HOME/archive/`,
 * and restores them byte for byte on demand. It never runs inside a pipeline: only by hand, under the run lock.
 *
 * WHAT IS KEPT (the keep set; everything else with an envelope is archived). Each rule names the code that reads it:
 * - R1 runs: every queue input of the kept runs (the policy's last N completed daily, freelance, coverage and rebuild
 *   runs, each with its `<run>.<stage>` sub-runs; any run of a pipeline the policy does not name), and every output of
 *   the steps that processed them. Readers: the projectors (`project.ts`, `freelance/project.ts`, coverage
 *   `pipeline.ts` stageResult), `runProblems` (`problems.ts`), freelance source health (`freelance/health.ts`) and memo
 *   replay of those steps (`executor.ts`).
 * - R2 latest daily: the queue inputs of `latestRun('daily-')`, read by `docs rebuild` (`run.ts` rebuildDocs: seeds and
 *   renderer CoverPlans) and `coverage probe` (`coverage/probe.ts` boardsRead).
 * - R3 incomplete runs: their queue inputs and step outputs (supervisor resume `getEnvelope`, memo replay, coverage's
 *   week roll-over `storedCandidates`). Compaction refuses while any run is incomplete unless `--include-incomplete`;
 *   with it, only a stale run (dated before the last 7 days, never resumed: `pickRunId` resumes today's prefix and
 *   coverage resumes this week) of a closed or non-coverage pipeline loses this pin.
 * - R4 current documents: the `Rendered@1` that `renderedPlanOf` returns for each job with `job_docs` (the first, by
 *   envelope id, whose files are exactly the job's documents: the job page and its cover note), and the `GigRendered@1`
 *   that `gigExtras` returns for each gig with `gig_docs` (the newest such, by rowid: the freelance tab).
 * - R5 newest postings: the newest `Posting@1` (max rowid) of each job last seen in the last BOARD_SEED_DAYS days
 *   (`contractPostings`, the freelance boards seeds), and the newest `Gig@1` of each gig (`gigExtras`).
 * - R6 lineage: for every kept step, its input envelope, and so on up to the seed (the plan behind a kept Rendered).
 * The unit of archiving is the STEP: a step with any kept envelope keeps all of them; an archived step loses its
 * `steps` row in the same transaction as its envelopes (memo safety: a later run executes it again, never replays an
 * empty output). Queue rows, events, cost and entity rows are never touched.
 */

export const RetentionPolicy = z
  .object({
    version: z.literal(1),
    keep: z
      .object({
        /** Completed daily runs kept whole (at least 1: `docs rebuild` reads the latest). */
        daily: z.number().int().min(1).max(365),
        freelance: z.number().int().min(1).max(365),
        coverage: z.number().int().min(1).max(52),
        rebuild: z.number().int().min(1).max(365),
      })
      .strict(),
  })
  .strict();
export type RetentionPolicy = z.infer<typeof RetentionPolicy>;

/** The built-in policy when the pack has no `retention.yaml` (user-approved 2026-10-14). */
export const DEFAULT_RETENTION: RetentionPolicy = { version: 1, keep: { daily: 3, freelance: 1, coverage: 1, rebuild: 1 } };
export const RETENTION_FILE = 'retention.yaml';

/** The pack's `retention.yaml` (optional; validated like the other pack files), or the default. */
export function loadRetentionPolicy(packDir: string): { policy: RetentionPolicy; hash: string; source: 'pack' | 'default' } {
  const path = join(packDir, RETENTION_FILE);
  if (!existsSync(path)) return { policy: DEFAULT_RETENTION, hash: sha256(canonicalJson(DEFAULT_RETENTION)), source: 'default' };
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${RETENTION_FILE}: not valid YAML (${e instanceof Error ? e.message : String(e)})`);
  }
  const r = RetentionPolicy.safeParse(raw ?? {});
  if (!r.success) throw new Error(`${RETENTION_FILE}: ${r.error.issues.map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`).join('; ')}`);
  return { policy: r.data, hash: sha256(canonicalJson(r.data)), source: 'pack' };
}

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** Pipelines the policy names (the `runs.pipeline` id before `@`) and their keep counts. */
const PIPELINE_KIND: Readonly<Record<string, keyof RetentionPolicy['keep']>> = {
  'jobpilot-daily': 'daily',
  'jobpilot-freelance': 'freelance',
  'jobpilot-coverage': 'coverage',
  'jobpilot-rebuild': 'rebuild',
};
/** An incomplete run older than this (by the date in its id) is stale: no code path resumes it. */
const STALE_INCOMPLETE_DAYS = 7;

export type PinRule = 'R1 runs' | 'R2 latest daily' | 'R3 incomplete runs' | 'R4 current documents' | 'R5 newest postings' | 'R6 lineage';

export interface CompactionPlan {
  readonly policy: RetentionPolicy;
  readonly policyHash: string;
  readonly keptRuns: readonly string[];
  /** Incomplete runs (refused without `--include-incomplete`), and which of them stay pinned. */
  readonly incomplete: readonly { readonly runId: string; readonly pinned: boolean }[];
  /** Envelopes kept, by the first rule that kept them. */
  readonly pinnedBy: Readonly<Record<PinRule, number>>;
  readonly keep: { readonly envelopes: number; readonly bytes: number };
  readonly archive: {
    readonly envelopes: number;
    readonly steps: number;
    readonly bytes: number;
    readonly byAgent: Readonly<Record<string, { envelopes: number; bytes: number }>>;
    readonly byType: Readonly<Record<string, { envelopes: number; bytes: number }>>;
  };
  /** The archived envelope ids, sorted, and the archived step keys, sorted. */
  readonly envelopeIds: readonly string[];
  readonly stepKeys: readonly string[];
}

interface EnvMeta {
  readonly id: string;
  readonly step: string;
  readonly type: string;
  readonly bytes: number;
  readonly rowid: number;
}

const dateOfRun = (runId: string): string | undefined => /^[a-z]+-(\d{4}-\d{2}-\d{2})/.exec(runId)?.[1];
const daysBefore = (now: string, n: number): string => new Date(Date.parse(now) - n * 86_400_000).toISOString().slice(0, 10);

/** What a compaction would do now, read-only. `now`: ISO time (the R3 staleness and the R5 window). */
export function planCompaction(app: AppStore, opts: { readonly now: string; readonly policy: RetentionPolicy; readonly policyHash: string; readonly includeIncomplete: boolean }): CompactionPlan {
  const db = app.kernel.db;
  return db.transaction((): CompactionPlan => {
    const runs = db.prepare(`SELECT run_id, pipeline, status, started_at FROM runs ORDER BY started_at DESC, run_id DESC`).all() as { run_id: string; pipeline: string; status: string; started_at: string }[];
    const kindOf = (pipeline: string): keyof RetentionPolicy['keep'] | undefined => PIPELINE_KIND[pipeline.split('@')[0] ?? ''];
    // the top-level runs: a `<run>.<stage>` sub-run goes with its umbrella
    const top = runs.filter((r) => !r.run_id.includes('.'));
    const kept = new Set<string>();
    const taken: Record<string, number> = {};
    for (const r of top) {
      const kind = kindOf(r.pipeline);
      if (kind === undefined) {
        kept.add(r.run_id); // a pipeline the policy does not name: never archived
        continue;
      }
      if (r.status !== 'completed') continue;
      if ((taken[kind] ?? 0) < opts.policy.keep[kind]) {
        kept.add(r.run_id);
        taken[kind] = (taken[kind] ?? 0) + 1;
      }
    }
    const staleBefore = daysBefore(opts.now, STALE_INCOMPLETE_DAYS);
    const closed = new Set((db.prepare(`SELECT DISTINCT run_id FROM events WHERE kind = 'coverage.closed'`).all() as { run_id: string }[]).map((r) => r.run_id));
    const incomplete = top
      .filter((r) => r.status !== 'completed')
      .map((r) => {
        const d = dateOfRun(r.run_id);
        const stale = d !== undefined && d < staleBefore && (kindOf(r.pipeline) !== 'coverage' || closed.has(r.run_id));
        return { runId: r.run_id, pinned: !opts.includeIncomplete || !stale };
      })
      .sort((a, b) => (a.runId < b.runId ? -1 : 1));
    const incompletePinned = new Set(incomplete.filter((i) => i.pinned).map((i) => i.runId));
    const belongs = (queueRun: string, set: ReadonlySet<string>): boolean => set.has(queueRun) || set.has(queueRun.split('.')[0] ?? queueRun);

    const envs = new Map<string, EnvMeta>();
    for (const e of db.prepare(`SELECT envelope_id, step_key, type, octet_length(body) AS bytes, rowid FROM envelopes`).iterate() as IterableIterator<{ envelope_id: string; step_key: string; type: string; bytes: number; rowid: number }>) {
      envs.set(e.envelope_id, { id: e.envelope_id, step: e.step_key, type: e.type, bytes: e.bytes, rowid: e.rowid });
    }
    const envsOfStep = new Map<string, string[]>();
    for (const e of envs.values()) (envsOfStep.get(e.step) ?? envsOfStep.set(e.step, []).get(e.step) as string[]).push(e.id);
    const steps = db.prepare(`SELECT step_key, agent_id, input_envelope_id FROM steps`).all() as { step_key: string; agent_id: string; input_envelope_id: string }[];
    const stepRow = new Map(steps.map((s) => [s.step_key, s]));
    const stepsByInput = new Map<string, string[]>();
    for (const s of steps) {
      const k = `${s.agent_id}\u0000${s.input_envelope_id}`;
      (stepsByInput.get(k) ?? stepsByInput.set(k, []).get(k) as string[]).push(s.step_key);
    }

    const keepEnv = new Map<string, PinRule>();
    const keepStep = new Set<string>();
    const pinEnv = (id: string, rule: PinRule): void => {
      if (envs.has(id) && !keepEnv.has(id)) keepEnv.set(id, rule);
    };
    const pinStep = (key: string, rule: PinRule): void => {
      if (keepStep.has(key)) return;
      keepStep.add(key);
      for (const id of envsOfStep.get(key) ?? []) pinEnv(id, rule);
    };
    // R1 / R3: queue inputs of kept and pinned-incomplete runs, and the steps that processed them
    const latestDaily = app.latestRun('daily-')?.runId;
    for (const q of db.prepare(`SELECT run_id, agent_id, envelope_id FROM queue`).iterate() as IterableIterator<{ run_id: string; agent_id: string; envelope_id: string }>) {
      const rule: PinRule | undefined = belongs(q.run_id, kept) ? 'R1 runs' : belongs(q.run_id, incompletePinned) ? 'R3 incomplete runs' : q.run_id === latestDaily ? 'R2 latest daily' : undefined;
      if (rule === undefined) continue;
      pinEnv(q.envelope_id, rule);
      if (rule === 'R2 latest daily') continue; // rebuild and the probe read the inputs only
      for (const key of stepsByInput.get(`${q.agent_id}\u0000${q.envelope_id}`) ?? []) pinStep(key, rule);
    }
    // R4: the Rendered@1 / GigRendered@1 behind each job's and gig's current documents
    const docsWanted = (sql: string): Map<string, string> => {
      const want = new Map<string, string>();
      for (const d of db.prepare(sql).all() as { k: string; path: string; sha256: string }[]) want.set(d.k, `${want.has(d.k) ? `${want.get(d.k) as string}\n` : ''}${d.path}\u0000${d.sha256}`);
      return want;
    };
    // exactly the envelope each reader returns: renderedPlanOf takes the first match by envelope_id, gigExtras the first
    // by NEWEST_FIRST; keeping only that one leaves both readers' answers unchanged
    const matchRendered = (type: string, keyPath: string, want: Map<string, string>, order: string): void => {
      if (want.size === 0) return;
      const found = new Set<string>();
      for (const r of db.prepare(`SELECT e.envelope_id, json_extract(e.body, '${keyPath}') AS k, json_extract(e.body, '$.payload.files') AS files FROM envelopes e WHERE e.type = ? ORDER BY ${order}`).iterate(type) as IterableIterator<{ envelope_id: string; k: string | null; files: string | null }>) {
        if (r.k === null || found.has(r.k) || !want.has(r.k)) continue;
        const files = (r.files === null ? [] : (JSON.parse(r.files) as { path: string; sha256: string }[])).map((f) => `${f.path}\u0000${f.sha256}`).sort().join('\n');
        if (files !== want.get(r.k)) continue;
        found.add(r.k);
        pinEnv(r.envelope_id, 'R4 current documents');
      }
    };
    matchRendered('Rendered@1', '$.payload.jobKey', docsWanted(`SELECT job_key AS k, path, sha256 FROM job_docs ORDER BY job_key, path`), 'e.envelope_id');
    matchRendered('GigRendered@1', '$.payload.gigKey', docsWanted(`SELECT gig_key AS k, path, sha256 FROM gig_docs ORDER BY gig_key, path`), NEWEST_FIRST('e'));
    // R5: the newest Posting@1 of each job seen in the boards window, the newest Gig@1 of each gig
    const since = new Date(Date.parse(opts.now) - BOARD_SEED_DAYS * 86_400_000).toISOString();
    const recent = new Set((db.prepare(`SELECT job_key FROM jobs WHERE last_seen >= ?`).all(since) as { job_key: string }[]).map((r) => r.job_key));
    // the same "newest" as the readers (NEWEST_FIRST: by the step_done event's seq, never rowid)
    const newest = (type: string, keyPath: string, wanted: (k: string) => boolean): void => {
      for (const r of db
        .prepare(`SELECT id, k FROM (SELECT e.envelope_id AS id, json_extract(e.body, '${keyPath}') AS k, ROW_NUMBER() OVER (PARTITION BY json_extract(e.body, '${keyPath}') ORDER BY ${NEWEST_FIRST('e')}) AS n FROM envelopes e WHERE e.type = ?) WHERE n = 1`)
        .iterate(type) as IterableIterator<{ id: string; k: string | null }>) {
        if (r.k !== null && wanted(r.k)) pinEnv(r.id, 'R5 newest postings');
      }
    };
    newest('Posting@1', '$.payload.jobKey', (k) => recent.has(k));
    newest('Gig@1', '$.payload.gigKey', () => true);
    // every pinned envelope keeps its whole step (Map iteration also visits the entries this adds)
    for (const [id, rule] of keepEnv) {
      const step = envs.get(id)?.step;
      if (step !== undefined && !keepStep.has(step)) pinStep(step, rule);
    }
    // R6: every kept step keeps its input envelope and that envelope's step, up to the seed
    const stack = [...keepStep];
    while (stack.length > 0) {
      const input = stepRow.get(stack.pop() as string)?.input_envelope_id;
      const parent = input === undefined ? undefined : envs.get(input);
      if (parent === undefined) continue;
      pinEnv(parent.id, 'R6 lineage');
      if (!keepStep.has(parent.step)) {
        pinStep(parent.step, 'R6 lineage');
        stack.push(parent.step);
      }
    }

    const pinnedBy = { 'R1 runs': 0, 'R2 latest daily': 0, 'R3 incomplete runs': 0, 'R4 current documents': 0, 'R5 newest postings': 0, 'R6 lineage': 0 } as Record<PinRule, number>;
    let keepBytes = 0;
    for (const [id, rule] of keepEnv) {
      pinnedBy[rule]++;
      keepBytes += envs.get(id)?.bytes ?? 0;
    }
    const byAgent: Record<string, { envelopes: number; bytes: number }> = {};
    const byType: Record<string, { envelopes: number; bytes: number }> = {};
    const envelopeIds: string[] = [];
    const stepKeys = new Set<string>();
    let bytes = 0;
    for (const e of envs.values()) {
      if (keepEnv.has(e.id)) continue;
      envelopeIds.push(e.id);
      if (stepRow.has(e.step)) stepKeys.add(e.step);
      bytes += e.bytes;
      const agent = stepRow.get(e.step)?.agent_id ?? '(no step row)';
      (byAgent[agent] ??= { envelopes: 0, bytes: 0 }).envelopes++;
      (byAgent[agent] as { bytes: number }).bytes += e.bytes;
      (byType[e.type] ??= { envelopes: 0, bytes: 0 }).envelopes++;
      (byType[e.type] as { bytes: number }).bytes += e.bytes;
    }
    envelopeIds.sort();
    return {
      policy: opts.policy,
      policyHash: opts.policyHash,
      keptRuns: [...kept].sort(),
      incomplete,
      pinnedBy,
      keep: { envelopes: keepEnv.size, bytes: keepBytes },
      archive: { envelopes: envelopeIds.length, steps: stepKeys.size, bytes, byAgent, byType },
      envelopeIds,
      stepKeys: [...stepKeys].sort(),
    };
  })();
}

const mb = (n: number): string => `${(n / 1_048_576).toFixed(1)} MB`;

/** The dry-run report: what WOULD be archived, by agent and type, and what is kept and why. */
export function formatPlan(p: CompactionPlan, source: string): string {
  const lines = [
    `retention policy (${source}, version ${p.policy.version}): keep the last ${p.policy.keep.daily} daily, ${p.policy.keep.freelance} freelance, ${p.policy.keep.coverage} coverage and ${p.policy.keep.rebuild} rebuild runs, plus pins`,
    `kept runs: ${p.keptRuns.length === 0 ? 'none' : p.keptRuns.join(', ')}`,
    ...(p.incomplete.length > 0 ? [`incomplete runs: ${p.incomplete.map((i) => `${i.runId}${i.pinned ? ' (kept)' : ' (stale, archived)'}`).join(', ')}`] : []),
    `keep: ${p.keep.envelopes} envelopes, ${mb(p.keep.bytes)}`,
    ...Object.entries(p.pinnedBy).map(([rule, n]) => `  ${rule.padEnd(22)} ${n}`),
    `archive: ${p.archive.envelopes} envelopes from ${p.archive.steps} steps, ${mb(p.archive.bytes)}`,
    '  by agent:',
    ...Object.entries(p.archive.byAgent).sort(([, a], [, b]) => b.bytes - a.bytes).map(([k, v]) => `    ${k.padEnd(28)} ${String(v.envelopes).padStart(8)}  ${mb(v.bytes)}`),
    '  by type:',
    ...Object.entries(p.archive.byType).sort(([, a], [, b]) => b.bytes - a.bytes).map(([k, v]) => `    ${k.padEnd(28)} ${String(v.envelopes).padStart(8)}  ${mb(v.bytes)}`),
  ];
  return lines.join('\n');
}

export interface SegmentManifest {
  readonly format: 1;
  readonly segment: string;
  readonly sha256: string;
  readonly createdAt: string;
  readonly policyVersion: number;
  readonly policyHash: string;
  readonly counts: { readonly envelopes: number; readonly steps: number; readonly bytes: number };
  readonly envelopeIds: readonly string[];
  readonly stepKeys: readonly string[];
}

/** A segment line: one envelope row or one step row, canonical JSON (as stored: restore is byte-identical). */
type SegmentLine = { readonly t: 'envelope'; readonly row: Record<string, unknown> } | { readonly t: 'step'; readonly row: Record<string, unknown> };

export const COMPACTED_EVENT = 'store.compacted';
export const RESTORED_EVENT = 'store.restored';

export class RetentionRefused extends Error {
  override readonly name = 'RetentionRefused';
}

/** Free bytes on the filesystem holding `dir`. */
export function freeBytes(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Streams the archived rows into a gzip segment, fsyncs it and returns its sha256. */
async function writeSegment(app: AppStore, plan: CompactionPlan, tmp: string): Promise<{ sha256: string; envelopes: number; steps: number }> {
  const db = app.kernel.db;
  const fd = openSync(tmp, 'wx', 0o600);
  const hash = createHash('sha256');
  const gzip = createGzip({ level: 6 });
  const out = createWriteStream('', { fd, autoClose: false });
  gzip.on('data', (c: Buffer) => hash.update(c));
  gzip.pipe(out);
  const write = async (line: SegmentLine): Promise<void> => {
    if (!gzip.write(`${canonicalJson(line)}\n`)) await new Promise<void>((r) => gzip.once('drain', () => r()));
  };
  let envelopes = 0;
  let steps = 0;
  // the rowid too: a restore puts each envelope back where it was (readers never depend on it: NEWEST_FIRST)
  const env = db.prepare(`SELECT rowid AS rowid, envelope_id, step_key, idx, type, body FROM envelopes WHERE envelope_id = ?`);
  for (const id of plan.envelopeIds) {
    const row = env.get(id) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error(`envelope ${id} disappeared while compacting`);
    await write({ t: 'envelope', row });
    envelopes++;
  }
  const step = db.prepare(`SELECT * FROM steps WHERE step_key = ?`);
  for (const key of plan.stepKeys) {
    const row = step.get(key) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error(`step ${key} disappeared while compacting`);
    await write({ t: 'step', row });
    steps++;
  }
  await new Promise<void>((resolve, reject) => {
    out.once('finish', () => resolve());
    out.once('error', reject);
    gzip.end();
  });
  fsyncSync(fd);
  closeSync(fd);
  return { sha256: hash.digest('hex'), envelopes, steps };
}

/** Re-reads a segment: its sha256, and every line (canonical JSON, parsed). */
export async function readSegment(path: string): Promise<{ sha256: string; lines: SegmentLine[] }> {
  const hash = createHash('sha256');
  const raw = createReadStream(path);
  raw.on('data', (c) => hash.update(c as Buffer));
  const lines: SegmentLine[] = [];
  const rl = createInterface({ input: raw.pipe(createGunzip()), crlfDelay: Infinity });
  for await (const l of rl) if (l !== '') lines.push(JSON.parse(l) as SegmentLine);
  return { sha256: hash.digest('hex'), lines };
}

export interface CompactResult {
  readonly segment: string | null;
  readonly sha256: string | null;
  readonly envelopes: number;
  readonly steps: number;
  readonly bytes: number;
  readonly sizeBefore: number;
  readonly sizeAfter: number;
  readonly vacuum: 'done' | 'skipped: not enough free disk' | 'skipped: --no-vacuum' | 'skipped: nothing archived';
  readonly seconds: number;
  /** Files an interrupted compaction left in `archive/` (temp files, segments no chain event records), removed first. */
  readonly removedOrphans: readonly string[];
}

const dbBytes = (path: string): number => [path, `${path}-wal`].reduce((n, f) => n + (existsSync(f) ? statSync(f).size : 0), 0);

/**
 * Applies a plan (the caller holds the run lock and has checked the refusals). In order:
 * 1. the segment is written to a temp file, fsynced, renamed into `archive/` (directory fsynced) and re-read: its
 *    sha256 and every envelope id and step key must match; then its manifest is written the same way;
 * 2. ONE transaction: the `store.compacted` event (segment, sha256, counts, policy) is appended to the hash chain,
 *    THEN the archived envelopes and their step rows are deleted (memo safety: no done step without its outputs);
 * 3. VACUUM, if the disk has the DB's size free (it rewrites the file), else skipped with a message.
 */
export async function applyCompaction(
  app: AppStore,
  plan: CompactionPlan,
  o: { readonly dbPath: string; readonly archiveDir: string; readonly now: string; readonly vacuum: boolean; /** Tests: the free-disk reading. */ readonly freeBytes?: (dir: string) => number; /** Tests: runs between the write and the read-back. */ readonly beforeVerify?: (segmentPath: string) => void },
): Promise<CompactResult> {
  const t0 = performance.now();
  const sizeBefore = dbBytes(o.dbPath);
  if (plan.envelopeIds.length === 0) {
    return { segment: null, sha256: null, envelopes: 0, steps: 0, bytes: 0, sizeBefore, sizeAfter: sizeBefore, vacuum: 'skipped: nothing archived', seconds: (performance.now() - t0) / 1000, removedOrphans: [] };
  }
  mkdirSync(o.archiveDir, { recursive: true, mode: 0o700 });
  // leftovers of an interrupted compaction: temp files, and segments no `store.compacted` event records (their rows were
  // never removed, so they hold nothing the database lacks)
  const removedOrphans = removeOrphans(app.kernel, o.archiveDir);
  const stamp = o.now.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  // the seq its event will get (we hold the run lock: nothing else appends meanwhile), so two compactions in one second
  // never share a name
  let name = `envelopes-${stamp}-s${(app.kernel.chainHead()?.seq ?? 0) + 1}.jsonl.gz`;
  for (let n = 2; existsSync(join(o.archiveDir, name)); n++) name = `envelopes-${stamp}-s${(app.kernel.chainHead()?.seq ?? 0) + 1}-${n}.jsonl.gz`;
  const final = join(o.archiveDir, name);
  const tmp = `${final}.tmp`;
  const written = await writeSegment(app, plan, tmp);
  renameSync(tmp, final);
  fsyncDir(o.archiveDir);
  o.beforeVerify?.(final);
  const back = await readSegment(final);
  const ids = back.lines.filter((l) => l.t === 'envelope').map((l) => String(l.row['envelope_id']));
  const keys = back.lines.filter((l) => l.t === 'step').map((l) => String(l.row['step_key']));
  if (back.sha256 !== written.sha256 || ids.join('\n') !== plan.envelopeIds.join('\n') || keys.join('\n') !== plan.stepKeys.join('\n')) {
    throw new Error(`segment ${name} did not read back as written; nothing was removed (the file is left for inspection)`);
  }
  const manifest: SegmentManifest = {
    format: 1, segment: name, sha256: written.sha256, createdAt: o.now, policyVersion: plan.policy.version, policyHash: plan.policyHash,
    counts: { envelopes: written.envelopes, steps: written.steps, bytes: plan.archive.bytes }, envelopeIds: plan.envelopeIds, stepKeys: plan.stepKeys,
  };
  const mpath = join(o.archiveDir, `${name}.manifest.json`);
  writeFileSync(`${mpath}.tmp`, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
  const mfd = openSync(`${mpath}.tmp`, 'r+');
  fsyncSync(mfd);
  closeSync(mfd);
  renameSync(`${mpath}.tmp`, mpath);
  fsyncDir(o.archiveDir);

  const db = app.kernel.db;
  db.transaction(() => {
    app.kernel.appendEvent(`store-compact-${stamp}`, o.now, COMPACTED_EVENT, {
      segment: name, sha256: written.sha256, envelopes: written.envelopes, steps: written.steps, bytes: plan.archive.bytes,
      policyVersion: plan.policy.version, policyHash: plan.policyHash, keptRuns: plan.keptRuns,
    }, plan.policyHash);
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS compact_env (envelope_id TEXT PRIMARY KEY); CREATE TEMP TABLE IF NOT EXISTS compact_step (step_key TEXT PRIMARY KEY); DELETE FROM compact_env; DELETE FROM compact_step;`);
    const ie = db.prepare(`INSERT INTO compact_env (envelope_id) VALUES (?)`);
    for (const id of plan.envelopeIds) ie.run(id);
    const is = db.prepare(`INSERT INTO compact_step (step_key) VALUES (?)`);
    for (const k of plan.stepKeys) is.run(k);
    const de = db.prepare(`DELETE FROM envelopes WHERE envelope_id IN (SELECT envelope_id FROM compact_env)`).run().changes;
    const ds = db.prepare(`DELETE FROM steps WHERE step_key IN (SELECT step_key FROM compact_step)`).run().changes;
    if (de !== plan.envelopeIds.length || ds !== plan.stepKeys.length) throw new Error(`compaction removed ${de}/${plan.envelopeIds.length} envelopes and ${ds}/${plan.stepKeys.length} steps; rolled back`);
    // memo safety: no archived step may still own an envelope, and no remaining done step may have lost one
    const left = db.prepare(`SELECT COUNT(*) AS n FROM envelopes WHERE step_key IN (SELECT step_key FROM compact_step)`).get() as { n: number };
    if (left.n !== 0) throw new Error('an archived step still owns envelopes; rolled back');
    db.exec(`DROP TABLE compact_env; DROP TABLE compact_step;`);
  })();

  let vacuum: CompactResult['vacuum'] = 'skipped: --no-vacuum';
  if (o.vacuum) {
    if ((o.freeBytes ?? freeBytes)(o.archiveDir) < dbBytes(o.dbPath) * 1.1 + 64 * 1_048_576) vacuum = 'skipped: not enough free disk';
    else {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.exec('VACUUM');
      db.pragma('wal_checkpoint(TRUNCATE)');
      vacuum = 'done';
    }
  }
  return {
    segment: name, sha256: written.sha256, envelopes: written.envelopes, steps: written.steps, bytes: plan.archive.bytes,
    sizeBefore, sizeAfter: dbBytes(o.dbPath), vacuum, seconds: (performance.now() - t0) / 1000, removedOrphans,
  };
}

export interface RestoreResult {
  readonly segment: string;
  /** `present`: kept, already in the DB; `differ`: of those, how many are not byte-identical to the archived bytes. */
  readonly envelopes: { readonly inserted: number; readonly present: number; readonly differ: number };
  readonly steps: { readonly inserted: number; readonly present: number };
  /** Archived steps a later run made again (their step row exists, in any status): left whole as they are. */
  readonly stepsSkipped: number;
  /** Archived steps one of whose envelope ids or rowids is taken by another row now: left out whole. */
  readonly stepsConflicting: number;
}

/** The `store.compacted` events, by segment name. */
function compactedEvents(store: Store): Map<string, { sha256: string; envelopes: number; steps: number }> {
  const out = new Map<string, { sha256: string; envelopes: number; steps: number }>();
  for (const e of store.db.prepare(`SELECT data FROM events WHERE kind = ? ORDER BY seq`).all(COMPACTED_EVENT) as { data: string }[]) {
    const d = JSON.parse(e.data) as { segment: string; sha256: string; envelopes: number; steps: number };
    out.set(d.segment, d);
  }
  return out;
}

const SEGMENT = /^envelopes-[0-9TZ]+(?:-s\d+)?(?:-\d+)?\.jsonl\.gz$/;

/** The archived segments, oldest first. */
export function listSegments(archiveDir: string): string[] {
  if (!existsSync(archiveDir)) return [];
  return readdirSync(archiveDir).filter((f) => SEGMENT.test(f)).sort();
}

/** Removes `*.tmp` files and segments (with their manifests) that no `store.compacted` event records. */
function removeOrphans(store: Store, archiveDir: string): string[] {
  const recorded = compactedEvents(store);
  const removed: string[] = [];
  for (const f of readdirSync(archiveDir).sort()) {
    const segment = f.endsWith('.manifest.json') ? f.slice(0, -'.manifest.json'.length) : f;
    if (f.endsWith('.tmp') || (SEGMENT.test(segment) && !recorded.has(segment))) {
      unlinkSync(join(archiveDir, f));
      removed.push(f);
    }
  }
  return removed;
}

export class OrphanSegment extends RetentionRefused {}

/**
 * Restores one segment, STEP BY STEP (retention review: the step is the unit here too). Refused unless the audit chain
 * verifies in full (its events are what the segment is checked against), the segment has its manifest, and its sha256
 * equals both the manifest's and its `store.compacted` event's. Then, in ONE transaction, for each archived step:
 * - its step row exists now (a later run made it again: done, failed, running, any status): the step is left whole
 *   as it is, none of its archived envelopes or its row are put back (`stepsSkipped`);
 * - one of its envelope ids or original rowids is taken by another row: left out whole (`stepsConflicting`);
 * - else its row and every envelope come back exactly as archived, at their original rowids.
 * Envelopes with no step row (none when archived) follow the same rules on their own. A `store.restored` event is
 * appended with the counts.
 */
export async function restoreSegment(app: AppStore, o: { readonly archiveDir: string; readonly segment: string; readonly now: string }): Promise<RestoreResult> {
  const path = join(o.archiveDir, o.segment);
  if (!SEGMENT.test(o.segment) || !existsSync(path)) throw new RetentionRefused(`no segment ${o.segment} in ${o.archiveDir}`);
  const chain = verifyChain(app.kernel);
  if (!chain.ok) throw new RetentionRefused(`the audit chain does not verify (${'headMismatch' in chain ? chain.reason : `at event ${chain.brokenAt}: ${chain.reason}`}); refusing to restore against it`);
  const event = compactedEvents(app.kernel).get(o.segment);
  if (event === undefined) throw new OrphanSegment(`segment ${o.segment} has no ${COMPACTED_EVENT} event in the audit chain; refusing to restore it`);
  const mpath = `${path}.manifest.json`;
  if (!existsSync(mpath)) throw new RetentionRefused(`segment ${o.segment} has no manifest (${o.segment}.manifest.json); refusing to restore it`);
  let manifest: SegmentManifest;
  try {
    manifest = JSON.parse(readFileSync(mpath, 'utf8')) as SegmentManifest;
  } catch {
    throw new RetentionRefused(`the manifest of ${o.segment} is not readable; refusing to restore it`);
  }
  const { sha256: actual, lines } = await readSegment(path);
  if (actual !== event.sha256 || manifest.sha256 !== event.sha256) {
    throw new RetentionRefused(`segment ${o.segment}: sha256 ${actual} does not match its chain event (${event.sha256}) and manifest (${manifest.sha256}); refusing to restore it`);
  }
  const envs = lines.filter((l) => l.t === 'envelope').map((l) => l.row);
  const steps = lines.filter((l) => l.t === 'step').map((l) => l.row);
  if (envs.length !== event.envelopes || steps.length !== event.steps) throw new RetentionRefused(`segment ${o.segment}: its counts do not match its chain event`);
  const db = app.kernel.db;
  return db.transaction((): RestoreResult => {
    const byStep = new Map<string, Record<string, unknown>[]>();
    for (const e of envs) (byStep.get(String(e['step_key'])) ?? byStep.set(String(e['step_key']), []).get(String(e['step_key'])) as Record<string, unknown>[]).push(e);
    const stepRows = new Map(steps.map((r) => [String(r['step_key']), r]));
    const stepExists = db.prepare(`SELECT 1 FROM steps WHERE step_key = ?`);
    const idTaken = db.prepare(`SELECT body FROM envelopes WHERE envelope_id = ?`);
    const rowidTaken = db.prepare(`SELECT envelope_id FROM envelopes WHERE rowid = ?`);
    const insEnv = db.prepare(`INSERT INTO envelopes (rowid, envelope_id, step_key, idx, type, body) VALUES (@rowid, @envelope_id, @step_key, @idx, @type, @body)`);
    const cols = Object.keys(steps[0] ?? {});
    const insStep = cols.length === 0 ? undefined : db.prepare(`INSERT INTO steps (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`);
    let inserted = 0;
    let present = 0;
    let differ = 0;
    let stepsInserted = 0;
    let stepsSkipped = 0;
    let stepsConflicting = 0;
    for (const key of [...new Set([...byStep.keys(), ...stepRows.keys()])].sort()) {
      const mine = byStep.get(key) ?? [];
      if (stepExists.get(key) !== undefined) {
        stepsSkipped++;
        for (const e of mine) {
          const cur = idTaken.get(e['envelope_id']) as { body: string } | undefined;
          if (cur !== undefined) {
            present++;
            if (cur.body !== e['body']) differ++;
          }
        }
        continue;
      }
      const clash = mine.some((e) => idTaken.get(e['envelope_id']) !== undefined || rowidTaken.get(e['rowid']) !== undefined);
      if (clash) {
        stepsConflicting++;
        continue;
      }
      for (const e of mine) {
        insEnv.run(e);
        inserted++;
      }
      const row = stepRows.get(key);
      if (row !== undefined && insStep !== undefined) {
        insStep.run(row);
        stepsInserted++;
      }
    }
    const result: RestoreResult = {
      segment: o.segment, envelopes: { inserted, present, differ }, steps: { inserted: stepsInserted, present: stepsSkipped }, stepsSkipped, stepsConflicting,
    };
    app.kernel.appendEvent(`store-restore-${o.now.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`, o.now, RESTORED_EVENT, { ...result, sha256: actual }, manifest.policyHash);
    return result;
  })();
}
