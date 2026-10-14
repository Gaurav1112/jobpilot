import type Database from 'better-sqlite3';
import { verifyChainSince, verifyChainThrough, type AuditResult, type ChainPoint } from '../kernel/store/audit.js';
import type { Store } from '../kernel/store/store.js';

/**
 * The audit chain's verified checkpoint (dashboard-perf fix 1). A full walk of the chain is O(every event ever) (about
 * 500k events and 5 s cold on a real home), so `/runs` no longer does one per view:
 *
 * - `jobpilot audit verify` walks the whole chain (`fullChainCheck`) and, when it passes, records where it got to: the
 *   last event's seq and hash, the event count and the time, in `app_settings` under `audit.chain_checkpoint`.
 * - `/runs` (`chainStatus`) checks that the checkpoint is still a point on the stored chain and walks only the events
 *   after it, and says when the last full check ran. When those newer events chain onto it, it moves the verified point
 *   (seq, hash, count) to the head, so the next view walks only what came after (O(new events), not O(events since the
 *   last audit)); it never changes the last FULL check's time, seq or count, which only a full walk records.
 * - Whenever the checkpoint is missing, unreadable or does not match the chain, `/runs` falls back to the full walk
 *   (authoritative, and recorded when it passes). A failed check is reported, never hidden; "intact" is only ever
 *   shown for a chain verified now (fully, or from a checkpoint a full walk recorded).
 *
 * The threat model is unchanged (see `verifyChain`): the chain is unkeyed and the checkpoint lives in the same file, so
 * a writer with database access can rewrite both. An edit before the checkpoint is caught by the full walk only.
 */
export const CHAIN_CHECKPOINT_KEY = 'audit.chain_checkpoint';

export interface Checkpoint extends ChainPoint {
  /** When the last full walk ran (ISO). */
  readonly verifiedAt: string;
  /** The last event and the event count that full walk reached (the verified point may have moved on since). */
  readonly fullSeq: number;
  readonly fullCount: number;
}

/** `since`: the last full check (`fullAt`, `through` its last event), `newer` events after it, `checkedNow` walked for this view. */
export type ChainCheck =
  | { readonly kind: 'full-now' }
  | { readonly kind: 'since'; readonly fullAt: string; readonly through: number; readonly newer: number; readonly checkedNow: number };
export type ChainStatus = { readonly ok: true; readonly events: number; readonly check: ChainCheck } | { readonly ok: false; readonly reason: string };

/** How long a best-effort checkpoint write from the dashboard waits for a run's write lock. */
const DASHBOARD_RECORD_TIMEOUT_MS = 250;
const HASH = /^[0-9a-f]{64}$/;

const hasSettings = (db: Database.Database): boolean => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'`).get() !== undefined;

/** The recorded checkpoint, or undefined when there is none or it is not a well-formed one. */
export function readCheckpoint(db: Database.Database): Checkpoint | undefined {
  if (!hasSettings(db)) return undefined;
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(CHAIN_CHECKPOINT_KEY) as { value: string } | undefined;
  if (row === undefined) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(row.value);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const { seq, hash, count, verifiedAt, fullSeq, fullCount } = v as Record<string, unknown>;
  const pos = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 1;
  if (!pos(seq) || !pos(count) || !pos(fullSeq) || !pos(fullCount) || fullSeq > seq || fullCount > count) return undefined;
  if (typeof hash !== 'string' || !HASH.test(hash) || typeof verifiedAt !== 'string' || verifiedAt === '') return undefined;
  return { seq, hash, count, verifiedAt, fullSeq, fullCount };
}

function writeCheckpoint(db: Database.Database, cp: Checkpoint): void {
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(
    CHAIN_CHECKPOINT_KEY,
    JSON.stringify({ seq: cp.seq, hash: cp.hash, count: cp.count, verifiedAt: cp.verifiedAt, fullSeq: cp.fullSeq, fullCount: cp.fullCount }),
  );
}

const isBusy = (e: unknown): boolean => typeof (e as { code?: unknown })?.code === 'string' && (e as { code: string }).code.startsWith('SQLITE_BUSY');

/**
 * The full walk from genesis (`verifyChain`); when it passes and the database has the app's tables, its end point is
 * recorded as the checkpoint. `bestEffort`: a busy database (a run writing) skips the record instead of waiting.
 */
export function fullChainCheck(store: Store, at: string, expectedHead?: { hash: string; count: number }, bestEffort = false): AuditResult {
  const { result, through } = verifyChainThrough(store, expectedHead);
  if (result.ok && through !== undefined) record(store, { ...through, verifiedAt: at, fullSeq: through.seq, fullCount: through.count }, bestEffort);
  return result;
}

/** Writes the checkpoint when the database has the app's tables. `bestEffort`: a busy database (a run writing) skips it. */
function record(store: Store, cp: Checkpoint, bestEffort: boolean): void {
  if (!hasSettings(store.db)) return;
  if (!bestEffort) return writeCheckpoint(store.db, cp);
  const before = store.db.pragma('busy_timeout', { simple: true }) as number;
  store.db.pragma(`busy_timeout = ${DASHBOARD_RECORD_TIMEOUT_MS}`);
  try {
    writeCheckpoint(store.db, cp);
  } catch (e) {
    if (!isBusy(e)) throw e;
    console.error('jobpilot dashboard: the audit checkpoint was not recorded (a run is writing); the next view checks those events again');
  } finally {
    store.db.pragma(`busy_timeout = ${before}`);
  }
}

const reasonOf = (r: Exclude<AuditResult, { ok: true }>): string => ('headMismatch' in r ? r.reason : `at event ${r.brokenAt}: ${r.reason}`);

/** What `/runs` shows: from the checkpoint when it matches the chain, else (and only then) the full walk. */
export function chainStatus(store: Store, at: string): ChainStatus {
  const cp = readCheckpoint(store.db);
  if (cp !== undefined) {
    const r = verifyChainSince(store, cp);
    if (r.ok) {
      if (r.checked > 0) record(store, { ...r.head, verifiedAt: cp.verifiedAt, fullSeq: cp.fullSeq, fullCount: cp.fullCount }, true);
      return { ok: true, events: r.events, check: { kind: 'since', fullAt: cp.verifiedAt, through: cp.fullSeq, newer: r.events - cp.fullCount, checkedNow: r.checked } };
    }
    if (!('mismatch' in r)) return { ok: false, reason: `at event ${r.brokenAt}: ${r.reason}` };
    // the checkpoint is not a point on this chain: only the full walk can tell
  }
  const full = fullChainCheck(store, at, undefined, true);
  return full.ok ? { ok: true, events: full.events, check: { kind: 'full-now' } } : { ok: false, reason: reasonOf(full) };
}
