import { GENESIS_HASH, type Store, eventHash } from './store.js';

export type AuditResult =
  | { ok: true; events: number }
  | { ok: false; brokenAt: number; reason: string }
  /** The chain itself is intact, but its head is not the one the caller expected. */
  | { ok: false; headMismatch: true; events: number; reason: string };

/**
 * Walks the event chain from genesis, then checks it against the stored chain head.
 * Edited, inserted, deleted and truncated events are all caught.
 *
 * Limits: the chain is unkeyed, so it detects accidental and naive tampering only. A writer
 * with full database access can rewrite events and the head consistently; pass `expectedHead`
 * (an out-of-band copy, e.g. noted by the user) to catch that. Envelope bodies and the cost
 * ledger are not chained.
 */
export function verifyChain(store: Store, expectedHead?: { hash: string; count: number }): AuditResult {
  let prev = GENESIS_HASH;
  const rows = store.events();
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, brokenAt: r.seq, reason: 'prev_hash does not match the previous event' };
    if (eventHash(prev, r) !== r.hash) return { ok: false, brokenAt: r.seq, reason: 'hash does not match the event contents' };
    prev = r.hash;
  }
  const head = store.chainHead();
  if (rows.length > 0 || head !== undefined) {
    if (head === undefined || head.count !== rows.length || head.hash !== prev) {
      return {
        ok: false,
        brokenAt: rows[rows.length - 1]?.seq ?? 0,
        reason: 'chain head does not match the events (truncated or rewritten tail)',
      };
    }
  }
  if (expectedHead !== undefined && (head === undefined || head.hash !== expectedHead.hash || head.count !== expectedHead.count)) {
    return { ok: false, headMismatch: true, events: rows.length, reason: 'chain head differs from the expected head' };
  }
  return { ok: true, events: rows.length };
}
