import { describe, expect, it } from 'vitest';
import { verifyChain, verifyChainSince, verifyChainThrough } from '../../src/kernel/store/audit.js';
import { Store } from '../../src/kernel/store/store.js';

/**
 * dashboard-perf fix 1: the audit chain verified from a checkpoint (the last full verification's seq, hash and count),
 * so `/runs` walks only the events after it. `verifyChain` (the full walk) is unchanged and stays authoritative.
 */
const chain = (n: number): Store => {
  const s = Store.open(':memory:');
  for (let i = 0; i < n; i++) s.appendEvent('r', `t${i}`, 'k', { i }, 'p');
  return s;
};

describe('verifyChainThrough: the full walk, with the point it verified through', () => {
  it('returns the last seq, hash and count on success, nothing on failure', () => {
    const s = chain(4);
    const head = s.chainHead();
    expect(verifyChainThrough(s)).toEqual({ result: { ok: true, events: 4 }, through: { seq: 4, hash: head?.hash, count: 4 } });
    s.db.prepare(`UPDATE events SET data = '{"i":99}' WHERE seq = 2`).run();
    const bad = verifyChainThrough(s);
    expect(bad.result).toMatchObject({ ok: false, brokenAt: 2 });
    expect(bad.through).toBeUndefined();
    expect(verifyChain(s)).toEqual(bad.result);
  });

  it('an empty chain verifies through nothing', () => {
    expect(verifyChainThrough(Store.open(':memory:'))).toEqual({ result: { ok: true, events: 0 }, through: undefined });
  });
});

describe('verifyChainSince', () => {
  const cpOf = (s: Store) => {
    const t = verifyChainThrough(s).through;
    if (t === undefined) throw new Error('no checkpoint');
    return t;
  };

  it('checks only the events after the checkpoint and agrees with the head', () => {
    const s = chain(3);
    const cp = cpOf(s);
    expect(verifyChainSince(s, cp)).toEqual({ ok: true, events: 3, checked: 0, head: cp });
    s.appendEvent('r', 't3', 'k', { i: 3 }, 'p');
    s.appendEvent('r', 't4', 'k', { i: 4 }, 'p');
    expect(verifyChainSince(s, cp)).toEqual({ ok: true, events: 5, checked: 2, head: { seq: 5, hash: s.chainHead()?.hash, count: 5 } });
  });

  it('detects an edited event after the checkpoint', () => {
    const s = chain(3);
    const cp = cpOf(s);
    s.appendEvent('r', 't3', 'k', { i: 3 }, 'p');
    s.appendEvent('r', 't4', 'k', { i: 4 }, 'p');
    s.db.prepare(`UPDATE events SET data = '{"i":99}' WHERE seq = 4`).run();
    expect(verifyChainSince(s, cp)).toMatchObject({ ok: false, brokenAt: 4, reason: 'hash does not match the event contents' });
  });

  it('detects a deleted event and a truncated tail after the checkpoint', () => {
    const s = chain(3);
    const cp = cpOf(s);
    for (let i = 3; i < 6; i++) s.appendEvent('r', `t${i}`, 'k', { i }, 'p');
    s.db.prepare(`DELETE FROM events WHERE seq = 5`).run();
    expect(verifyChainSince(s, cp)).toMatchObject({ ok: false, brokenAt: 6 });
    const t = chain(3);
    const cp2 = cpOf(t);
    t.appendEvent('r', 't3', 'k', { i: 3 }, 'p');
    t.db.prepare(`DELETE FROM events WHERE seq = 4`).run();
    expect(verifyChainSince(t, cp2)).toMatchObject({ ok: false, reason: expect.stringMatching(/chain head/) });
  });

  it('does not see an edit before the checkpoint (the full walk does)', () => {
    const s = chain(4);
    const cp = cpOf(s);
    s.db.prepare(`UPDATE events SET data = '{"i":99}' WHERE seq = 2`).run();
    expect(verifyChainSince(s, cp)).toMatchObject({ ok: true, events: 4, checked: 0 });
    expect(verifyChain(s)).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('reports a checkpoint that does not match the stored chain at its seq', () => {
    const s = chain(3);
    const cp = cpOf(s);
    expect(verifyChainSince(s, { ...cp, hash: 'f'.repeat(64) })).toEqual({ ok: false, mismatch: true, reason: expect.stringMatching(/checkpoint/) });
    expect(verifyChainSince(s, { ...cp, seq: 99 })).toMatchObject({ ok: false, mismatch: true });
    expect(verifyChainSince(s, { ...cp, count: 7 })).toMatchObject({ ok: false, mismatch: true });
    // the event at the checkpoint rewritten with a consistent hash: a different chain, not this checkpoint's
    s.db.prepare(`UPDATE events SET hash = ? WHERE seq = 3`).run('e'.repeat(64));
    expect(verifyChainSince(s, cp)).toMatchObject({ ok: false, mismatch: true });
  });

  it('reports a missing chain head as broken', () => {
    const s = chain(2);
    const cp = cpOf(s);
    s.db.prepare(`DELETE FROM chain_head`).run();
    expect(verifyChainSince(s, cp)).toMatchObject({ ok: false, reason: expect.stringMatching(/chain head/) });
  });
});
