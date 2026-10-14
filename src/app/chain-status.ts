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
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
/** A UTC ISO time the dashboard can show (`toISOString` shape, a real date): anything else is not a checkpoint. */
const isIsoTime = (x: unknown): x is string => typeof x === 'string' && ISO.test(x) && Number.isFinite(Date.parse(x)) && new Date(Date.parse(x)).toISOString().slice(0, 19) === x.slice(0, 19);

/**
 * The broken marker (review I1): written by every failed full walk (`audit verify`, the weekly coverage check, the
 * dashboard's own fallback walk), cleared only by a later full walk that passes. While it is there, `/runs` is red
 * whatever the checkpoint says: a failed check is never followed by "intact".
 */
export const CHAIN_BROKEN_KEY = 'audit.chain_broken';
export interface BrokenMarker {
  /** The event the walk broke at; null when the chain verified but its head differed from `--expect-head`. */
  readonly seq: number | null;
  readonly reason: string;
  readonly at: string;
}

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
  if (typeof hash !== 'string' || !HASH.test(hash) || !isIsoTime(verifiedAt)) return undefined;
  return { seq, hash, count, verifiedAt, fullSeq, fullCount };
}

/** The broken marker, or undefined. An unreadable one still counts as broken (never silently intact). */
export function readBroken(db: Database.Database): BrokenMarker | undefined {
  if (!hasSettings(db)) return undefined;
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(CHAIN_BROKEN_KEY) as { value: string } | undefined;
  if (row === undefined) return undefined;
  try {
    const v = JSON.parse(row.value) as Record<string, unknown>;
    const seq = Number.isSafeInteger(v['seq']) ? (v['seq'] as number) : null;
    return { seq, reason: typeof v['reason'] === 'string' ? v['reason'] : 'unknown', at: typeof v['at'] === 'string' ? v['at'] : 'unknown' };
  } catch {
    return { seq: null, reason: 'a full check found the chain broken (its record is unreadable)', at: 'unknown' };
  }
}

const putSetting = (db: Database.Database, key: string, value: string): void => {
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, value);
};

export interface FullCheckOptions {
  /** `--expect-head`: an out-of-band copy of the head; a differing head fails the check. */
  readonly expectedHead?: { hash: string; count: number };
  /** False (`audit verify --no-record`, a forensic copy): write nothing, pass or fail. Default true. */
  readonly record?: boolean;
  /** How long the record waits for a run's write lock (SQLite busy_timeout); default the connection's own. */
  readonly lockWaitMs?: number;
  /** Told (instead of `console.error`) when the record could not be written; the walk's result stands either way. */
  readonly onRecordFailed?: (message: string) => void;
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
export function fullChainCheck(store: Store, at: string, opts: FullCheckOptions = {}): AuditResult {
  const { result, through } = verifyChainThrough(store, opts.expectedHead);
  if (opts.record === false || !hasSettings(store.db)) return result;
  const db = store.db;
  record(store, opts, () =>
    db.transaction(() => {
      if (result.ok) {
        if (through !== undefined) writeCheckpoint(db, { ...through, verifiedAt: at, fullSeq: through.seq, fullCount: through.count });
        db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(CHAIN_BROKEN_KEY);
      } else {
        const marker: BrokenMarker = 'headMismatch' in result ? { seq: null, reason: result.reason, at } : { seq: result.brokenAt, reason: result.reason, at };
        putSetting(db, CHAIN_BROKEN_KEY, JSON.stringify(marker));
      }
    })(),
  );
  return result;
}

/** Runs a record write: within `lockWaitMs` when given; a failure is reported (`onRecordFailed`), never thrown. */
function record(store: Store, opts: Pick<FullCheckOptions, 'lockWaitMs' | 'onRecordFailed'>, write: () => void): void {
  const db = store.db;
  const before = db.pragma('busy_timeout', { simple: true }) as number;
  if (opts.lockWaitMs !== undefined) db.pragma(`busy_timeout = ${opts.lockWaitMs}`);
  try {
    write();
  } catch (e) {
    const why = `${isBusy(e) ? 'a run is writing: ' : ''}${e instanceof Error ? e.message : String(e)}`;
    (opts.onRecordFailed ?? ((m: string) => console.error(`jobpilot: ${m}`)))(`the audit check's result was not recorded: ${why}`);
  } finally {
    if (opts.lockWaitMs !== undefined) db.pragma(`busy_timeout = ${before}`);
  }
}

const reasonOf = (r: Exclude<AuditResult, { ok: true }>): string => ('headMismatch' in r ? r.reason : `at event ${r.brokenAt}: ${r.reason}`);

/** What `/runs` shows: red while a full walk's broken marker stands; else from the checkpoint when it matches the chain, else (and only then) the full walk. */
export function chainStatus(store: Store, at: string): ChainStatus {
  const broken = readBroken(store.db);
  if (broken !== undefined) return { ok: false, reason: `${broken.seq !== null ? `at event ${broken.seq}: ` : ''}${broken.reason} (found by the full check at ${broken.at})` };
  const cp = readCheckpoint(store.db);
  const dashboard = { lockWaitMs: DASHBOARD_RECORD_TIMEOUT_MS };
  if (cp !== undefined) {
    const r = verifyChainSince(store, cp);
    if (r.ok) {
      // compare-and-set (review): move only seq, hash and count, and only if the checkpoint is still the one read here,
      // so a full check recorded meanwhile (`audit verify`, coverage) is never overwritten with this older one
      if (r.checked > 0) {
        record(store, dashboard, () =>
          store.db
            .prepare(
              `UPDATE app_settings SET value = json_set(value, '$.seq', @seq, '$.hash', @hash, '$.count', @count)
               WHERE key = @key AND json_extract(value, '$.seq') = @oldSeq AND json_extract(value, '$.hash') = @oldHash AND json_extract(value, '$.count') = @oldCount
                 AND json_extract(value, '$.verifiedAt') = @oldAt`,
            )
            .run({ key: CHAIN_CHECKPOINT_KEY, seq: r.head.seq, hash: r.head.hash, count: r.head.count, oldSeq: cp.seq, oldHash: cp.hash, oldCount: cp.count, oldAt: cp.verifiedAt }),
        );
      }
      return { ok: true, events: r.events, check: { kind: 'since', fullAt: cp.verifiedAt, through: cp.fullSeq, newer: r.events - cp.fullCount, checkedNow: r.checked } };
    }
    if (!('mismatch' in r)) return { ok: false, reason: `at event ${r.brokenAt}: ${r.reason}` };
    // the checkpoint is not a point on this chain: only the full walk can tell
  }
  const full = fullChainCheck(store, at, dashboard);
  return full.ok ? { ok: true, events: full.events, check: { kind: 'full-now' } } : { ok: false, reason: reasonOf(full) };
}
