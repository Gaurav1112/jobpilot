import { chmodSync, closeSync, constants, lstatSync, openSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { canonicalJson, sha256 } from '../canonical.js';
import type { Cost, Envelope } from '../envelope.js';
import type { ErrorCode } from '../errors.js';
import type { StateMachine } from '../state-machine.js';
import { MIGRATIONS } from './migrations.js';

export type StepStatus = 'running' | 'done' | 'failed' | 'quarantined';
export type QueueStatus = 'pending' | 'done' | 'failed' | 'quarantined' | 'skipped';

/** One entity, named by its tracker kind and id. */
export interface EntityRef {
  readonly kind: string;
  readonly entityId: string;
}

export interface StepRow {
  readonly step_key: string;
  readonly agent_id: string;
  readonly contract_version: string;
  readonly contract_hash: string;
  readonly input_envelope_id: string;
  readonly status: StepStatus;
  readonly attempts: number;
  readonly error_code: ErrorCode | null;
  readonly detail: string | null;
}

export interface QueueRow {
  readonly run_id: string;
  readonly stage: number;
  readonly agent_id: string;
  readonly envelope_id: string;
  readonly status: QueueStatus;
}

export interface EventRow {
  readonly seq: number;
  readonly run_id: string;
  readonly at: string;
  readonly kind: string;
  readonly data: string;
  readonly policy_hash: string;
  readonly prev_hash: string;
  readonly hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

export function eventHash(prevHash: string, e: Pick<EventRow, 'run_id' | 'at' | 'kind' | 'data' | 'policy_hash'>): string {
  return sha256(prevHash + canonicalJson({ run_id: e.run_id, at: e.at, kind: e.kind, data: e.data, policy_hash: e.policy_hash }));
}

/**
 * The only module that touches SQLite. better-sqlite3 is synchronous, so
 * writes happen in program order and every multi-row write is one transaction.
 */
/**
 * Makes an existing file owner-only (`mode`) when it is a regular file (never through a symlink) the user owns and
 * other accounts can read. Anything else it cannot or may not fix, a file someone else owns or a refused chmod,
 * is reported through `onLoose` instead; it never throws for that.
 */
export type LooseReason = 'link' | 'not-owned' | 'refused';

export function tightenOwnedFile(path: string, mode: number, onLoose: (path: string, why: LooseReason) => void): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return;
    throw e;
  }
  if (st.isSymbolicLink()) {
    // Never chmod through a link (it may point anywhere); report an open target instead. A dangling link has none.
    try {
      if ((statSync(path).mode & 0o077) !== 0) onLoose(path, 'link');
    } catch {
      // dangling: nothing to report
    }
    return;
  }
  if (!st.isFile() || (st.mode & 0o077) === 0) return;
  if (process.getuid !== undefined && st.uid !== process.getuid()) return onLoose(path, 'not-owned');
  try {
    chmodSync(path, mode);
  } catch (e) {
    const c = (e as { code?: string }).code;
    if (c === 'EPERM' || c === 'EACCES') return onLoose(path, 'refused');
    throw e;
  }
}

export class Store {
  private constructor(readonly db: Database.Database) {}

  /** `timeoutMs`: how long a statement waits for another connection's lock (SQLite busy_timeout); default the driver's 5 s. */
  /**
   * `timeoutMs`: SQLite busy_timeout. Owner-only files: a new DB file is created 0600 before SQLite opens it (SQLite
   * gives its -wal and -shm files the database file's mode); an existing looser one is tightened when it is a regular
   * file the user owns, else `onLooseFile` is told (default: nothing).
   */
  static open(path: string, opts: { readonly timeoutMs?: number; readonly onLooseFile?: (path: string, why: LooseReason) => void } = {}): Store {
    const onDisk = path !== ':memory:' && path !== '';
    if (onDisk) {
      try {
        closeSync(openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
      } catch (e) {
        const c = (e as { code?: string }).code;
        if (c !== 'EEXIST' && c !== 'ELOOP') throw e;
      }
    }
    const db = new Database(path, opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {});
    if (onDisk) for (const f of [path, `${path}-wal`, `${path}-shm`]) tightenOwnedFile(f, 0o600, opts.onLooseFile ?? (() => {}));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    try {
      const version = db.pragma('user_version', { simple: true }) as number;
      if (version > MIGRATIONS.length) {
        throw new Error(`database schema version ${version} is newer than this jobpilot (${MIGRATIONS.length})`);
      }
      for (let v = version; v < MIGRATIONS.length; v++) {
        db.transaction(() => {
          db.exec(MIGRATIONS[v] ?? '');
          db.pragma(`user_version = ${v + 1}`);
        })();
      }
    } catch (err) {
      db.close();
      throw err;
    }
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // runs
  startRun(runId: string, pipeline: string, policyHash: string, at: string): void {
    this.db
      .prepare(`INSERT INTO runs (run_id, pipeline, policy_hash, started_at, status) VALUES (?, ?, ?, ?, 'running')`)
      .run(runId, pipeline, policyHash, at);
  }

  finishRun(runId: string, at: string): void {
    this.db.prepare(`UPDATE runs SET status = 'completed', finished_at = ? WHERE run_id = ?`).run(at, runId);
  }

  /** Runs that started but never completed (a crash, a kill), oldest first. */
  incompleteRuns(): { run_id: string; pipeline: string; policy_hash: string }[] {
    return this.db.prepare(`SELECT run_id, pipeline, policy_hash FROM runs WHERE status != 'completed' ORDER BY started_at, run_id`).all() as {
      run_id: string;
      pipeline: string;
      policy_hash: string;
    }[];
  }

  getRun(runId: string): { run_id: string; pipeline: string; policy_hash: string; status: string } | undefined {
    return this.db.prepare(`SELECT run_id, pipeline, policy_hash, status FROM runs WHERE run_id = ?`).get(runId) as
      | { run_id: string; pipeline: string; policy_hash: string; status: string }
      | undefined;
  }

  // steps
  getStep(stepKey: string): StepRow | undefined {
    return this.db.prepare(`SELECT * FROM steps WHERE step_key = ?`).get(stepKey) as StepRow | undefined;
  }

  markRunning(s: { stepKey: string; agentId: string; version: string; contractHash: string; inputEnvelopeId: string }): void {
    this.db
      .prepare(
        `INSERT INTO steps (step_key, agent_id, contract_version, contract_hash, input_envelope_id, status, attempts)
         VALUES (?, ?, ?, ?, ?, 'running', 1)
         ON CONFLICT (step_key) DO UPDATE SET agent_id = excluded.agent_id, contract_version = excluded.contract_version,
           contract_hash = excluded.contract_hash, input_envelope_id = excluded.input_envelope_id,
           status = 'running', attempts = attempts + 1, error_code = NULL, detail = NULL`,
      )
      .run(s.stepKey, s.agentId, s.version, s.contractHash, s.inputEnvelopeId);
  }

  /** Writes the step outcome, its envelopes, its cost and (when given) its hash-chained event atomically. */
  finishStep(a: {
    runId: string;
    stepKey: string;
    agentId: string;
    status: Exclude<StepStatus, 'running'>;
    envelopes: readonly Envelope[];
    cost: Cost;
    /** The largest single model call paid in this step. */
    maxCallUsd?: number;
    errorCode?: ErrorCode;
    detail?: string;
    event?: { at: string; kind: string; data: unknown; policyHash: string };
  }): void {
    this.tx(() => {
      const res = this.db
        .prepare(`UPDATE steps SET status = ?, error_code = ?, detail = ? WHERE step_key = ? AND status = 'running'`)
        .run(a.status, a.errorCode ?? null, a.detail ?? null, a.stepKey);
      if (res.changes !== 1) throw new Error(`finishStep: step ${a.stepKey} is not running`);
      const ins = this.db.prepare(`INSERT INTO envelopes (envelope_id, step_key, idx, type, body) VALUES (?, ?, ?, ?, ?)`);
      for (const e of a.envelopes) ins.run(e.envelopeId, e.stepKey, e.index, e.type, canonicalJson(e));
      this.addCost(a);
      if (a.event) this.appendEvent(a.runId, a.event.at, a.event.kind, a.event.data, a.event.policyHash);
    });
  }

  /**
   * Records the spend of a finished attempt of a still-running step (before its retry sleep),
   * with its hash-chained event, in one transaction. finishStep later records only what came after.
   */
  recordAttemptSpend(a: {
    runId: string;
    stepKey: string;
    agentId: string;
    cost: Cost;
    maxCallUsd?: number;
    event: { at: string; kind: string; data: unknown; policyHash: string };
  }): void {
    this.tx(() => {
      this.addCost(a);
      this.appendEvent(a.runId, a.event.at, a.event.kind, a.event.data, a.event.policyHash);
    });
  }

  private addCost(a: { runId: string; stepKey: string; agentId: string; cost: Cost; maxCallUsd?: number }): void {
    if (a.cost.usd > 0 || a.cost.inputTokens > 0 || a.cost.outputTokens > 0) {
      this.db
        .prepare(`INSERT INTO cost_ledger (run_id, step_key, agent_id, usd, input_tokens, output_tokens, max_call_usd) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(a.runId, a.stepKey, a.agentId, a.cost.usd, a.cost.inputTokens, a.cost.outputTokens, a.maxCallUsd ?? 0);
    }
  }

  /**
   * Turns a done step into a quarantined one (e.g. a tracker could not key its outputs): its
   * envelopes are dropped, so nothing downstream can use them and a released step can run again.
   * Spend already recorded stays recorded.
   */
  quarantineDoneStep(stepKey: string, detail: string): void {
    this.tx(() => {
      const res = this.db.prepare(`UPDATE steps SET status = 'quarantined', detail = ? WHERE step_key = ? AND status = 'done'`).run(detail, stepKey);
      if (res.changes !== 1) throw new Error(`quarantineDoneStep: step ${stepKey} is not done`);
      this.db.prepare(`DELETE FROM envelopes WHERE step_key = ?`).run(stepKey);
    });
  }

  /**
   * Review I1: forgets a done step whose files are no longer what its stored output references, so the executor runs it
   * again (memo bypass for this step only). Its envelopes are dropped and it is marked failed, both with the
   * hash-chained `replay-healed` event in one transaction; a crash before the re-execution leaves a failed step, which
   * the next run executes anyway. Spend already recorded stays recorded.
   */
  forgetDoneStep(runId: string, stepKey: string, event: { at: string; kind: string; data: unknown; policyHash: string }): void {
    this.tx(() => {
      const res = this.db
        .prepare(`UPDATE steps SET status = 'failed', error_code = 'invalid_output', detail = 'replay-healed: its files changed on disk' WHERE step_key = ? AND status = 'done'`)
        .run(stepKey);
      if (res.changes !== 1) throw new Error(`forgetDoneStep: step ${stepKey} is not done`);
      this.db.prepare(`DELETE FROM envelopes WHERE step_key = ?`).run(stepKey);
      this.appendEvent(runId, event.at, event.kind, event.data, event.policyHash);
    });
  }

  /** For seed envelopes, which have no agent behind them. */
  putSeed(stepKey: string, env: Envelope, pipelineVersion: string, seedHash: string): void {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO steps (step_key, agent_id, contract_version, contract_hash, input_envelope_id, status, attempts)
           VALUES (?, 'supervisor', ?, ?, '', 'done', 0)`,
        )
        .run(stepKey, pipelineVersion, seedHash);
      this.db
        .prepare(`INSERT OR IGNORE INTO envelopes (envelope_id, step_key, idx, type, body) VALUES (?, ?, ?, ?, ?)`)
        .run(env.envelopeId, env.stepKey, env.index, env.type, canonicalJson(env));
    });
  }

  envelopesOfStep(stepKey: string): Envelope[] {
    const rows = this.db.prepare(`SELECT body FROM envelopes WHERE step_key = ? ORDER BY idx`).all(stepKey) as { body: string }[];
    return rows.map((r) => JSON.parse(r.body) as Envelope);
  }

  getEnvelope(envelopeId: string): Envelope {
    const row = this.db.prepare(`SELECT body FROM envelopes WHERE envelope_id = ?`).get(envelopeId) as { body: string } | undefined;
    if (!row) throw new Error(`unknown envelope ${envelopeId}`);
    return JSON.parse(row.body) as Envelope;
  }

  // cost
  runCost(runId: string, agentId?: string): number {
    const row = (
      agentId === undefined
        ? this.db.prepare(`SELECT COALESCE(SUM(usd), 0) AS usd FROM cost_ledger WHERE run_id = ?`).get(runId)
        : this.db.prepare(`SELECT COALESCE(SUM(usd), 0) AS usd FROM cost_ledger WHERE run_id = ? AND agent_id = ?`).get(runId, agentId)
    ) as { usd: number };
    return row.usd;
  }

  /** The largest single model call this agent was charged in this run. */
  maxCallCost(runId: string, agentId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(max_call_usd), 0) AS usd FROM cost_ledger WHERE run_id = ? AND agent_id = ?`).get(runId, agentId) as {
      usd: number;
    };
    return row.usd;
  }

  // queue
  enqueue(runId: string, stage: number, agentId: string, envelopeId: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO queue (run_id, stage, agent_id, envelope_id, status) VALUES (?, ?, ?, ?, 'pending')`)
      .run(runId, stage, agentId, envelopeId);
  }

  /** Total order: stage, then agent, then envelope id. Network timing never decides what runs next. */
  nextQueued(runId: string): QueueRow | undefined {
    return this.db
      .prepare(`SELECT * FROM queue WHERE run_id = ? AND status = 'pending' ORDER BY stage, agent_id, envelope_id LIMIT 1`)
      .get(runId) as QueueRow | undefined;
  }

  markQueue(runId: string, agentId: string, envelopeId: string, status: QueueStatus): void {
    this.db.prepare(`UPDATE queue SET status = ? WHERE run_id = ? AND agent_id = ? AND envelope_id = ?`).run(status, runId, agentId, envelopeId);
  }

  queueCounts(runId: string): Record<QueueStatus, number> {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM queue WHERE run_id = ? GROUP BY status`).all(runId) as { status: QueueStatus; n: number }[];
    const out: Record<QueueStatus, number> = { pending: 0, done: 0, failed: 0, quarantined: 0, skipped: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /** Read-only: every queue item of one run, in the queue's total order (stage, agent, envelope id). */
  queueItems(runId: string): QueueRow[] {
    return this.db.prepare(`SELECT * FROM queue WHERE run_id = ? ORDER BY stage, agent_id, envelope_id`).all(runId) as QueueRow[];
  }

  // events: append-only, hash-chained
  appendEvent(runId: string, at: string, kind: string, data: unknown, policyHash: string): void {
    this.tx(() => {
      const head = this.chainHead();
      const prev = head?.hash ?? GENESIS_HASH;
      const row = { run_id: runId, at, kind, data: canonicalJson(data), policy_hash: policyHash };
      const hash = eventHash(prev, row);
      const res = this.db
        .prepare(`INSERT INTO events (run_id, at, kind, data, policy_hash, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(row.run_id, row.at, row.kind, row.data, row.policy_hash, prev, hash);
      this.db
        .prepare(
          `INSERT INTO chain_head (id, seq, hash, count) VALUES (1, ?, ?, 1)
           ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, hash = excluded.hash, count = count + 1`,
        )
        .run(Number(res.lastInsertRowid), hash);
    });
  }

  /** The stored anchor of the audit chain: last seq, last hash and number of events appended. */
  chainHead(): { seq: number; hash: string; count: number } | undefined {
    return this.db.prepare(`SELECT seq, hash, count FROM chain_head WHERE id = 1`).get() as
      | { seq: number; hash: string; count: number }
      | undefined;
  }

  /**
   * Read-only, streamed: the events with seq above `afterSeq`, in seq order (a rowid range, so it never scans the
   * events before it). The caller must finish (or `return()`) the iterator: an open one holds a read transaction.
   */
  *eventsAfter(afterSeq: number): Generator<EventRow> {
    yield* this.db.prepare(`SELECT * FROM events WHERE seq > ? ORDER BY seq`).iterate(afterSeq) as IterableIterator<EventRow>;
  }

  /** Read-only: the seq and hash of one event, by seq. */
  eventLink(seq: number): { seq: number; hash: string } | undefined {
    return this.db.prepare(`SELECT seq, hash FROM events WHERE seq = ?`).get(seq) as { seq: number; hash: string } | undefined;
  }

  events(runId?: string): EventRow[] {
    return (
      runId === undefined
        ? this.db.prepare(`SELECT * FROM events ORDER BY seq`).all()
        : this.db.prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY seq`).all(runId)
    ) as EventRow[];
  }

  // entities: one namespace per tracker kind; idempotent per (kind, entity, step, event), so a replayed step never double-applies
  applyTransition(
    entityId: string,
    kind: string,
    stepKey: string,
    event: string,
    machine: StateMachine,
    outcome: 'done' | 'quarantined',
  ): string | undefined {
    return this.tx(() => {
      if (this.hasTransition(entityId, kind, stepKey, event)) return undefined;
      const cur = this.db.prepare(`SELECT state FROM entities WHERE kind = ? AND entity_id = ?`).get(kind, entityId) as { state: string } | undefined;
      const from = cur?.state ?? machine.def.initial;
      const to = machine.next(from, event);
      this.db
        .prepare(`INSERT INTO entities (kind, entity_id, state) VALUES (?, ?, ?) ON CONFLICT (kind, entity_id) DO UPDATE SET state = excluded.state`)
        .run(kind, entityId, to);
      this.db
        .prepare(`INSERT INTO entity_transitions (kind, entity_id, step_key, event, from_state, to_state, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(kind, entityId, stepKey, event, from, to, outcome);
      return to;
    });
  }

  hasTransition(entityId: string, kind: string, stepKey: string, event: string): boolean {
    return (
      this.db.prepare(`SELECT 1 FROM entity_transitions WHERE kind = ? AND entity_id = ? AND step_key = ? AND event = ?`).get(kind, entityId, stepKey, event) !==
      undefined
    );
  }

  /**
   * Read-only: the entity moves a step key made, by kind, entity and event. The only link from an input-side
   * quarantine (which writes no step row) to the entity it held.
   */
  transitionsOfStep(stepKey: string): { kind: string; entity_id: string; event: string; from_state: string; to_state: string; outcome: 'done' | 'quarantined' }[] {
    return this.db
      .prepare(`SELECT kind, entity_id, event, from_state, to_state, outcome FROM entity_transitions WHERE step_key = ? ORDER BY kind, entity_id, event`)
      .all(stepKey) as { kind: string; entity_id: string; event: string; from_state: string; to_state: string; outcome: 'done' | 'quarantined' }[];
  }

  /** The entity's state under `kind`; without a kind, the id must belong to at most one kind. */
  entityState(entityId: string, kind?: string): string | undefined {
    if (kind !== undefined) {
      return (this.db.prepare(`SELECT state FROM entities WHERE kind = ? AND entity_id = ?`).get(kind, entityId) as { state: string } | undefined)?.state;
    }
    const rows = this.db.prepare(`SELECT kind, state FROM entities WHERE entity_id = ? ORDER BY kind`).all(entityId) as { kind: string; state: string }[];
    if (rows.length > 1) throw new Error(`entity ${entityId} is ambiguous: it exists under kinds ${rows.map((r) => r.kind).join(', ')}`);
    return rows[0]?.state;
  }

  saveContract(agentId: string, version: string, hash: string, shape: unknown): void {
    this.db
      .prepare(`INSERT INTO contracts (agent_id, version, hash, shape) VALUES (?, ?, ?, ?) ON CONFLICT (agent_id, version) DO UPDATE SET hash = excluded.hash, shape = excluded.shape`)
      .run(agentId, version, hash, canonicalJson(shape));
  }

  // quarantine release: the user fixed the cause, so the step may run again
  /**
   * Quarantined step rows, plus door trips: an input-side trip writes no step row, but a
   * tracker may have moved entities under its step key. Those take agent and detail from
   * the step's latest `step_quarantined` event.
   */
  quarantinedSteps(): { step_key: string; agent_id: string; detail: string | null }[] {
    const rows = this.db.prepare(`SELECT step_key, agent_id, detail FROM steps WHERE status = 'quarantined'`).all() as {
      step_key: string;
      agent_id: string;
      detail: string | null;
    }[];
    const listed = new Set(rows.map((r) => r.step_key));
    const doorKeys = (
      this.db.prepare(`SELECT DISTINCT step_key FROM entity_transitions WHERE outcome = 'quarantined' ORDER BY step_key`).all() as { step_key: string }[]
    ).filter((r) => !listed.has(r.step_key));
    for (const { step_key } of doorKeys) {
      const ev = this.db
        .prepare(`SELECT data FROM events WHERE kind = 'step_quarantined' AND json_extract(data, '$.stepKey') = ? ORDER BY seq DESC LIMIT 1`)
        .get(step_key) as { data: string } | undefined;
      const d = ev ? (JSON.parse(ev.data) as { agent?: unknown; verdict?: unknown }) : {};
      rows.push({
        step_key,
        agent_id: typeof d.agent === 'string' ? d.agent : '',
        detail: d.verdict === undefined ? null : canonicalJson([d.verdict]),
      });
    }
    return rows.sort((a, b) => (a.step_key < b.step_key ? -1 : a.step_key > b.step_key ? 1 : 0));
  }

  /** The policy hash of the run that last quarantined this step key, from its `step_quarantined` event. */
  quarantinePolicyHash(stepKey: string): string | undefined {
    const row = this.db
      .prepare(`SELECT policy_hash FROM events WHERE kind = 'step_quarantined' AND json_extract(data, '$.stepKey') = ? ORDER BY seq DESC LIMIT 1`)
      .get(stepKey) as { policy_hash: string } | undefined;
    return row?.policy_hash;
  }

  /**
   * Forgets a quarantined step so the next run executes it again, and puts every entity
   * a quarantined outcome moved under that step key back where it was (whatever the event
   * was called). An entity that has moved on since the trip (its state is no longer the
   * trip's `to_state`) is left alone, its transition row kept, and reported in `skipped`.
   * Works for door trips too, which have no step row. One transaction, audited as
   * `quarantine_released`. Idempotent: when nothing was reverted and no step row deleted,
   * returns `released: false` and appends no event.
   */
  releaseQuarantine(stepKey: string, runId: string, at: string, policyHash: string): { released: boolean; entities: EntityRef[]; skipped: EntityRef[] } {
    return this.tx(() => {
      const trips = this.db
        .prepare(
          `SELECT kind, entity_id, event, from_state, to_state FROM entity_transitions WHERE step_key = ? AND outcome = 'quarantined' ORDER BY entity_id, kind, event`,
        )
        .all(stepKey) as { kind: string; entity_id: string; event: string; from_state: string; to_state: string }[];
      const deletedStep = this.db.prepare(`DELETE FROM steps WHERE step_key = ? AND status = 'quarantined'`).run(stepKey).changes > 0;
      const entities = new Map<string, EntityRef>();
      const skipped = new Map<string, EntityRef>();
      for (const t of trips) {
        const ref = { kind: t.kind, entityId: t.entity_id };
        const id = JSON.stringify([t.kind, t.entity_id]);
        const res = this.db
          .prepare(`UPDATE entities SET state = ? WHERE kind = ? AND entity_id = ? AND state = ?`)
          .run(t.from_state, t.kind, t.entity_id, t.to_state);
        if (res.changes !== 1) {
          skipped.set(id, ref);
          continue;
        }
        entities.set(id, ref);
        this.db
          .prepare(`DELETE FROM entity_transitions WHERE kind = ? AND entity_id = ? AND step_key = ? AND event = ?`)
          .run(t.kind, t.entity_id, stepKey, t.event);
      }
      const result = { entities: [...entities.values()], skipped: [...skipped.values()] };
      // Idempotent: a release that changes nothing is not a release and leaves no event.
      if (!deletedStep && result.entities.length === 0) return { released: false, ...result };
      this.appendEvent(runId, at, 'quarantine_released', { stepKey, ...result }, policyHash);
      return { released: true, ...result };
    });
  }

  /** Every contract version any run on this database has used. */
  contracts(): { agent_id: string; version: string; hash: string; shape: Record<string, unknown> }[] {
    const rows = this.db.prepare(`SELECT agent_id, version, hash, shape FROM contracts ORDER BY agent_id, version`).all() as {
      agent_id: string;
      version: string;
      hash: string;
      shape: string;
    }[];
    return rows.map((r) => ({ ...r, shape: JSON.parse(r.shape) as Record<string, unknown> }));
  }

  /** Test and audit helper: a whole table as canonical text, in a fixed order. */
  dump(table: 'envelopes' | 'entities' | 'steps', orderBy: string): string {
    if (!['envelopes', 'entities', 'steps'].includes(table) || !/^[a-z_]+(, ?[a-z_]+)*$/.test(orderBy)) {
      throw new Error('dump: refused');
    }
    const rows = this.db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
    return canonicalJson(rows);
  }
}
