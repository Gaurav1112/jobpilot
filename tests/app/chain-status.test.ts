import { describe, expect, it } from 'vitest';
import { CHAIN_CHECKPOINT_KEY, chainStatus, fullChainCheck, readCheckpoint } from '../../src/app/chain-status.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { Store } from '../../src/kernel/store/store.js';

/**
 * dashboard-perf fix 1: `/runs` verifies only the events after the last full verification's checkpoint
 * (`app_settings`, `audit.chain_checkpoint`), falls back to the full walk whenever the checkpoint is missing or does not
 * match, and never says "intact" without having verified.
 */
const T0 = '2026-10-14T01:00:00.000Z';
const T1 = '2026-10-14T02:00:00.000Z';

const appWith = (n: number): AppStore => {
  const app = AppStore.on(Store.open(':memory:'));
  for (let i = 0; i < n; i++) app.kernel.appendEvent('r', `t${i}`, 'k', { i }, 'p');
  return app;
};
const tamper = (app: AppStore, seq: number): void => {
  app.kernel.db.prepare(`UPDATE events SET data = '{"i":99}' WHERE seq = ?`).run(seq);
};

describe('fullChainCheck (jobpilot audit)', () => {
  it('records the checkpoint when the full walk passes', () => {
    const app = appWith(3);
    expect(fullChainCheck(app.kernel, T0)).toEqual({ ok: true, events: 3 });
    const head = app.kernel.chainHead();
    expect(readCheckpoint(app.kernel.db)).toEqual({ seq: 3, hash: head?.hash, count: 3, verifiedAt: T0 });
  });

  it('records nothing when it fails, and keeps the old checkpoint', () => {
    const app = appWith(3);
    fullChainCheck(app.kernel, T0);
    const before = readCheckpoint(app.kernel.db);
    app.kernel.appendEvent('r', 't3', 'k', { i: 3 }, 'p');
    tamper(app, 2);
    expect(fullChainCheck(app.kernel, T1)).toMatchObject({ ok: false, brokenAt: 2 });
    expect(readCheckpoint(app.kernel.db)).toEqual(before);
  });

  it('records nothing for a head that differs from --expect-head', () => {
    const app = appWith(2);
    expect(fullChainCheck(app.kernel, T0, { hash: 'bad', count: 2 })).toMatchObject({ ok: false, headMismatch: true });
    expect(readCheckpoint(app.kernel.db)).toBeUndefined();
  });

  it('on a kernel-only database (no app tables) it verifies and records nothing', () => {
    const k = Store.open(':memory:');
    k.appendEvent('r', 't', 'k', {}, 'p');
    expect(fullChainCheck(k, T0)).toEqual({ ok: true, events: 1 });
    expect(k.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'app_settings'`).get()).toBeUndefined();
  });
});

describe('chainStatus (/runs)', () => {
  it('with no checkpoint: a full walk now, which records one', () => {
    const app = appWith(3);
    expect(chainStatus(app.kernel, T0)).toEqual({ ok: true, events: 3, check: { kind: 'full-now' } });
    expect(readCheckpoint(app.kernel.db)).toMatchObject({ seq: 3, count: 3, verifiedAt: T0 });
  });

  it('with a checkpoint: only the newer events, and says when the last full check ran', () => {
    const app = appWith(3);
    fullChainCheck(app.kernel, T0);
    app.kernel.appendEvent('r', 't3', 'k', { i: 3 }, 'p');
    app.kernel.appendEvent('r', 't4', 'k', { i: 4 }, 'p');
    expect(chainStatus(app.kernel, T1)).toEqual({ ok: true, events: 5, check: { kind: 'since', fullAt: T0, through: 3, newer: 2 } });
    // the dashboard never moves the checkpoint forward on its own walk of the newer events
    expect(readCheckpoint(app.kernel.db)).toMatchObject({ seq: 3, verifiedAt: T0 });
  });

  it('detects tampering after the checkpoint', () => {
    const app = appWith(3);
    fullChainCheck(app.kernel, T0);
    app.kernel.appendEvent('r', 't3', 'k', { i: 3 }, 'p');
    tamper(app, 4);
    expect(chainStatus(app.kernel, T1)).toMatchObject({ ok: false, reason: 'at event 4: hash does not match the event contents' });
  });

  it('tampering before the checkpoint: /runs does not claim a fresh full check; audit catches it', () => {
    const app = appWith(4);
    fullChainCheck(app.kernel, T0);
    tamper(app, 2);
    const st = chainStatus(app.kernel, T1);
    expect(st).toEqual({ ok: true, events: 4, check: { kind: 'since', fullAt: T0, through: 4, newer: 0 } });
    expect(fullChainCheck(app.kernel, T1)).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('a checkpoint that does not match the chain falls back to the full walk', () => {
    const app = appWith(3);
    fullChainCheck(app.kernel, T0);
    const cp = readCheckpoint(app.kernel.db);
    app.kernel.db.prepare(`UPDATE app_settings SET value = ? WHERE key = ?`).run(JSON.stringify({ ...cp, hash: 'f'.repeat(64) }), CHAIN_CHECKPOINT_KEY);
    expect(chainStatus(app.kernel, T1)).toEqual({ ok: true, events: 3, check: { kind: 'full-now' } });
    expect(readCheckpoint(app.kernel.db)).toMatchObject({ hash: cp?.hash, verifiedAt: T1 });
  });

  it('a mismatched checkpoint over a tampered chain reports the break, never "intact"', () => {
    const app = appWith(4);
    fullChainCheck(app.kernel, T0);
    tamper(app, 2);
    app.kernel.db.prepare(`UPDATE app_settings SET value = ? WHERE key = ?`).run(JSON.stringify({ seq: 4, hash: 'f'.repeat(64), count: 4, verifiedAt: T0 }), CHAIN_CHECKPOINT_KEY);
    expect(chainStatus(app.kernel, T1)).toMatchObject({ ok: false, reason: 'at event 2: hash does not match the event contents' });
  });

  it('a missing checkpoint over a tampered chain reports the break', () => {
    const app = appWith(3);
    tamper(app, 1);
    expect(chainStatus(app.kernel, T0)).toMatchObject({ ok: false, reason: 'at event 1: hash does not match the event contents' });
    expect(readCheckpoint(app.kernel.db)).toBeUndefined();
  });

  it('an unreadable checkpoint is treated as missing', () => {
    for (const bad of ['not json', '{}', JSON.stringify({ seq: 'x', hash: 'h', count: 1, verifiedAt: T0 }), JSON.stringify({ seq: 1, hash: 'nothex', count: 1, verifiedAt: T0 })]) {
      const app = appWith(2);
      app.kernel.db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)`).run(CHAIN_CHECKPOINT_KEY, bad);
      expect(readCheckpoint(app.kernel.db)).toBeUndefined();
      expect(chainStatus(app.kernel, T0)).toEqual({ ok: true, events: 2, check: { kind: 'full-now' } });
    }
  });

  it('an empty chain is intact with nothing to record', () => {
    const app = appWith(0);
    expect(chainStatus(app.kernel, T0)).toEqual({ ok: true, events: 0, check: { kind: 'full-now' } });
    expect(readCheckpoint(app.kernel.db)).toBeUndefined();
  });
});
