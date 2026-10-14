import { GENESIS_HASH, type Store, eventHash } from './store.js';

export type AuditResult =
  | { ok: true; events: number }
  | { ok: false; brokenAt: number; reason: string }
  /** The chain itself is intact, but its head is not the one the caller expected. */
  | { ok: false; headMismatch: true; events: number; reason: string };

/** A point on the chain: an event's seq and hash, and how many events there are up to and including it. */
export interface ChainPoint {
  readonly seq: number;
  readonly hash: string;
  readonly count: number;
}

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
  return verifyChainThrough(store, expectedHead).result;
}

/**
 * `verifyChain`, plus the point it verified through (the last event) when it passed: a checkpoint `verifyChainSince`
 * can start from. The events are streamed (never all in memory at once) inside one read transaction, so a run that
 * appends meanwhile is not mistaken for a truncated tail.
 */
export function verifyChainThrough(store: Store, expectedHead?: { hash: string; count: number }): { result: AuditResult; through: ChainPoint | undefined } {
  return store.db.transaction((): { result: AuditResult; through: ChainPoint | undefined } => {
    let prev = GENESIS_HASH;
    let count = 0;
    let lastSeq = 0;
    for (const r of store.eventsAfter(0)) {
      if (r.prev_hash !== prev) return broken(r.seq, 'prev_hash does not match the previous event');
      if (eventHash(prev, r) !== r.hash) return broken(r.seq, 'hash does not match the event contents');
      prev = r.hash;
      lastSeq = r.seq;
      count++;
    }
    const head = store.chainHead();
    if (count > 0 || head !== undefined) {
      if (head === undefined || head.count !== count || head.hash !== prev) {
        return broken(lastSeq, 'chain head does not match the events (truncated or rewritten tail)');
      }
    }
    if (expectedHead !== undefined && (head === undefined || head.hash !== expectedHead.hash || head.count !== expectedHead.count)) {
      return { result: { ok: false, headMismatch: true, events: count, reason: 'chain head differs from the expected head' }, through: undefined };
    }
    return { result: { ok: true, events: count }, through: count === 0 ? undefined : { seq: lastSeq, hash: prev, count } };
  })();
}

const broken = (brokenAt: number, reason: string): { result: AuditResult; through: undefined } => ({ result: { ok: false, brokenAt, reason }, through: undefined });

export type SinceResult =
  | { ok: true; events: number; checked: number }
  | { ok: false; brokenAt: number; reason: string }
  /** The checkpoint is not a point on the stored chain (its event is gone or differs, or the counts disagree): only a full walk can say more. */
  | { ok: false; mismatch: true; reason: string };

/**
 * Verifies only the events after `from` (a checkpoint a full `verifyChainThrough` returned): the event at `from.seq`
 * must still carry `from.hash`, every later event must chain to it, and the stored head must be the last of them with
 * `from.count` plus their number. One read transaction; O(events after the checkpoint).
 *
 * It does NOT re-check the events up to the checkpoint: an edit there is caught by the full walk (`jobpilot audit`)
 * only. A `mismatch` means the checkpoint does not describe this chain; the caller falls back to the full walk.
 */
export function verifyChainSince(store: Store, from: ChainPoint): SinceResult {
  return store.db.transaction((): SinceResult => {
    const at = store.eventLink(from.seq);
    if (at === undefined || at.hash !== from.hash) return { ok: false, mismatch: true, reason: `the checkpoint at event ${from.seq} does not match the stored chain` };
    let prev = from.hash;
    let lastSeq = from.seq;
    let checked = 0;
    for (const r of store.eventsAfter(from.seq)) {
      if (r.prev_hash !== prev) return { ok: false, brokenAt: r.seq, reason: 'prev_hash does not match the previous event' };
      if (eventHash(prev, r) !== r.hash) return { ok: false, brokenAt: r.seq, reason: 'hash does not match the event contents' };
      prev = r.hash;
      lastSeq = r.seq;
      checked++;
    }
    const head = store.chainHead();
    if (head === undefined || head.hash !== prev || head.seq !== lastSeq) {
      return { ok: false, brokenAt: lastSeq, reason: 'chain head does not match the events (truncated or rewritten tail)' };
    }
    if (head.count !== from.count + checked) return { ok: false, mismatch: true, reason: `the checkpoint's event count does not match the chain head` };
    return { ok: true, events: head.count, checked };
  })();
}
