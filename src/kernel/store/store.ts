import Database from 'better-sqlite3';
import { canonicalJson, sha256 } from '../canonical.js';
import type { Cost, Envelope } from '../envelope.js';
import type { ErrorCode } from '../errors.js';
import type { StateMachine } from '../state-machine.js';
import { MIGRATIONS } from './migrations.js';

export type StepStatus = 'running' | 'done' | 'failed' | 'quarantined';
export type QueueStatus = 'pending' | 'done' | 'failed' | 'quarantined' | 'skipped';

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
export class Store {
  private constructor(readonly db: Database.Database) {}

  static open(path: string): Store {
    const db = new Database(path);
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
      if (a.cost.usd > 0 || a.cost.inputTokens > 0 || a.cost.outputTokens > 0) {
        this.db
          .prepare(`INSERT INTO cost_ledger (run_id, step_key, agent_id, usd, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(a.runId, a.stepKey, a.agentId, a.cost.usd, a.cost.inputTokens, a.cost.outputTokens);
      }
      if (a.event) this.appendEvent(a.runId, a.event.at, a.event.kind, a.event.data, a.event.policyHash);
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

  events(runId?: string): EventRow[] {
    return (
      runId === undefined
        ? this.db.prepare(`SELECT * FROM events ORDER BY seq`).all()
        : this.db.prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY seq`).all(runId)
    ) as EventRow[];
  }

  // entities: idempotent per (entity, step, event), so a replayed step never double-applies
  applyTransition(entityId: string, kind: string, stepKey: string, event: string, machine: StateMachine): string | undefined {
    return this.tx(() => {
      const done = this.db
        .prepare(`SELECT 1 FROM entity_transitions WHERE entity_id = ? AND step_key = ? AND event = ?`)
        .get(entityId, stepKey, event);
      if (done) return undefined;
      const cur = this.db.prepare(`SELECT state FROM entities WHERE entity_id = ?`).get(entityId) as { state: string } | undefined;
      const from = cur?.state ?? machine.def.initial;
      const to = machine.next(from, event);
      this.db
        .prepare(`INSERT INTO entities (entity_id, kind, state) VALUES (?, ?, ?) ON CONFLICT (entity_id) DO UPDATE SET state = excluded.state`)
        .run(entityId, kind, to);
      this.db
        .prepare(`INSERT INTO entity_transitions (entity_id, step_key, event, from_state, to_state) VALUES (?, ?, ?, ?, ?)`)
        .run(entityId, stepKey, event, from, to);
      return to;
    });
  }

  entityState(entityId: string): string | undefined {
    return (this.db.prepare(`SELECT state FROM entities WHERE entity_id = ?`).get(entityId) as { state: string } | undefined)?.state;
  }

  saveContract(agentId: string, version: string, hash: string, shape: unknown): void {
    this.db
      .prepare(`INSERT INTO contracts (agent_id, version, hash, shape) VALUES (?, ?, ?, ?) ON CONFLICT (agent_id, version) DO UPDATE SET hash = excluded.hash, shape = excluded.shape`)
      .run(agentId, version, hash, canonicalJson(shape));
  }

  // quarantine release: the user fixed the cause, so the step may run again
  quarantinedSteps(): { step_key: string; agent_id: string; detail: string | null }[] {
    return this.db.prepare(`SELECT step_key, agent_id, detail FROM steps WHERE status = 'quarantined' ORDER BY step_key`).all() as {
      step_key: string;
      agent_id: string;
      detail: string | null;
    }[];
  }

  /**
   * Forgets a quarantined step so the next run executes it again, and puts every entity
   * its trip moved back where it was. One transaction, audited as `quarantine_released`.
   */
  releaseQuarantine(stepKey: string, runId: string, at: string, policyHash: string): { released: boolean; entities: string[] } {
    return this.tx(() => {
      if (this.getStep(stepKey)?.status !== 'quarantined') return { released: false, entities: [] };
      this.db.prepare(`DELETE FROM steps WHERE step_key = ? AND status = 'quarantined'`).run(stepKey);
      const trips = this.db
        .prepare(`SELECT entity_id, from_state FROM entity_transitions WHERE step_key = ? AND event = 'trip' ORDER BY entity_id`)
        .all(stepKey) as { entity_id: string; from_state: string }[];
      for (const t of trips) {
        this.db.prepare(`UPDATE entities SET state = ? WHERE entity_id = ?`).run(t.from_state, t.entity_id);
        this.db.prepare(`DELETE FROM entity_transitions WHERE entity_id = ? AND step_key = ? AND event = 'trip'`).run(t.entity_id, stepKey);
      }
      const entities = trips.map((t) => t.entity_id);
      this.appendEvent(runId, at, 'quarantine_released', { stepKey, entities }, policyHash);
      return { released: true, entities };
    });
  }

  /** Every contract version any run on this database has used. */
  contracts(): { agent_id: string; version: string; hash: string }[] {
    return this.db.prepare(`SELECT agent_id, version, hash FROM contracts ORDER BY agent_id, version`).all() as {
      agent_id: string;
      version: string;
      hash: string;
    }[];
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
