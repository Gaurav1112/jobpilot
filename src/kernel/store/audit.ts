import { GENESIS_HASH, type Store, eventHash } from './store.js';

export type AuditResult = { ok: true; events: number } | { ok: false; brokenAt: number; reason: string };

/** Walks the event chain from genesis; any edited, inserted or deleted row breaks it. */
export function verifyChain(store: Store): AuditResult {
  let prev = GENESIS_HASH;
  const rows = store.events();
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, brokenAt: r.seq, reason: 'prev_hash does not match the previous event' };
    if (eventHash(prev, r) !== r.hash) return { ok: false, brokenAt: r.seq, reason: 'hash does not match the event contents' };
    prev = r.hash;
  }
  return { ok: true, events: rows.length };
}
