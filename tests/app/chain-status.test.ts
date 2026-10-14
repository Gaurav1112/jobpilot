import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAIN_BROKEN_KEY, CHAIN_CHECKPOINT_KEY, chainStatus, fullChainCheck, readBroken, readCheckpoint } from '../../src/app/chain-status.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { eventHash, Store } from '../../src/kernel/store/store.js';

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
    expect(readCheckpoint(app.kernel.db)).toEqual({ seq: 3, hash: head?.hash, count: 3, verifiedAt: T0, fullSeq: 3, fullCount: 3 });
  });

  it('a failed full walk marks the chain broken: /runs is red until a later full walk passes and clears it', () => {
    const app = appWith(3);
    fullChainCheck(app.kernel, T0);
    app.kernel.appendEvent('r', 't3', 'k', { i: 3 }, 'p');
    tamper(app, 2);
    expect(fullChainCheck(app.kernel, T1)).toMatchObject({ ok: false, brokenAt: 2 });
    expect(readBroken(app.kernel.db)).toEqual({ seq: 2, reason: 'hash does not match the event contents', at: T1 });
    // the checkpoint still matches the stored chain and the events after it verify: still red, never "intact"
    const red = chainStatus(app.kernel, T1);
    expect(red).toEqual({ ok: false, reason: `at event 2: hash does not match the event contents (found by the full check at ${T1})` });
    expect(chainStatus(app.kernel, T1)).toEqual(red);
    // repaired (restored from a backup, say): the next full walk passes and clears it
    app.kernel.db.prepare(`UPDATE events SET data = '{"i":1}' WHERE seq = 2`).run();
    expect(chainStatus(app.kernel, T1)).toEqual(red);
    expect(fullChainCheck(app.kernel, '2026-10-14T03:00:00.000Z')).toEqual({ ok: true, events: 4 });
    expect(readBroken(app.kernel.db)).toBeUndefined();
    expect(chainStatus(app.kernel, '2026-10-14T03:00:00.000Z')).toMatchObject({ ok: true, events: 4 });
  });

  it('a head that differs from --expect-head is a failed full check too: marked, no checkpoint', () => {
    const app = appWith(2);
    expect(fullChainCheck(app.kernel, T0, { expectedHead: { hash: 'bad', count: 2 } })).toMatchObject({ ok: false, headMismatch: true });
    expect(readCheckpoint(app.kernel.db)).toBeUndefined();
    expect(readBroken(app.kernel.db)).toEqual({ seq: null, reason: 'chain head differs from the expected head', at: T0 });
    expect(chainStatus(app.kernel, T1)).toMatchObject({ ok: false, reason: expect.stringMatching(/chain head differs from the expected head/) });
  });

  it('record: false (--no-record) verifies and writes nothing, pass or fail', () => {
    const app = appWith(2);
    expect(fullChainCheck(app.kernel, T0, { record: false })).toEqual({ ok: true, events: 2 });
    tamper(app, 1);
    expect(fullChainCheck(app.kernel, T0, { record: false })).toMatchObject({ ok: false });
    expect([readCheckpoint(app.kernel.db), readBroken(app.kernel.db)]).toEqual([undefined, undefined]);
  });

  it('a record that cannot be written is reported, never thrown: the walk result stands', () => {
    const app = appWith(2);
    app.kernel.db.exec(`CREATE TRIGGER ro_i BEFORE INSERT ON app_settings BEGIN SELECT RAISE(ABORT, 'read-only copy'); END;
      CREATE TRIGGER ro_u BEFORE UPDATE ON app_settings BEGIN SELECT RAISE(ABORT, 'read-only copy'); END;`);
    const told: string[] = [];
    expect(fullChainCheck(app.kernel, T0, { onRecordFailed: (m) => told.push(m) })).toEqual({ ok: true, events: 2 });
    expect(told).toEqual([expect.stringMatching(/not recorded: read-only copy/)]);
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
    expect(chainStatus(app.kernel, T1)).toEqual({ ok: true, events: 5, check: { kind: 'since', fullAt: T0, through: 3, newer: 2, checkedNow: 2 } });
    // the walked events extend the verified point; the last FULL check (time, seq, count) is never moved by the dashboard
    expect(readCheckpoint(app.kernel.db)).toEqual({ seq: 5, hash: app.kernel.chainHead()?.hash, count: 5, verifiedAt: T0, fullSeq: 3, fullCount: 3 });
    expect(chainStatus(app.kernel, T1)).toEqual({ ok: true, events: 5, check: { kind: 'since', fullAt: T0, through: 3, newer: 2, checkedNow: 0 } });
    app.kernel.appendEvent('r', 't5', 'k', { i: 5 }, 'p');
    expect(chainStatus(app.kernel, T1)).toEqual({ ok: true, events: 6, check: { kind: 'since', fullAt: T0, through: 3, newer: 3, checkedNow: 1 } });
  });

  it('an event the dashboard already checked and that is edited later: /runs does not see it, audit does', () => {
    const app = appWith(2);
    fullChainCheck(app.kernel, T0);
    app.kernel.appendEvent('r', 't2', 'k', { i: 2 }, 'p');
    app.kernel.appendEvent('r', 't3', 'k', { i: 3 }, 'p');
    chainStatus(app.kernel, T1);
    tamper(app, 3);
    expect(chainStatus(app.kernel, T1)).toMatchObject({ ok: true, check: { kind: 'since', fullAt: T0, through: 2 } });
    expect(fullChainCheck(app.kernel, T1)).toMatchObject({ ok: false, brokenAt: 3 });
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
    expect(st).toEqual({ ok: true, events: 4, check: { kind: 'since', fullAt: T0, through: 4, newer: 0, checkedNow: 0 } });
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
    const ok = { seq: 2, hash: 'a'.repeat(64), count: 2, verifiedAt: T0, fullSeq: 1, fullCount: 1 };
    const bads = ['not json', '{}', JSON.stringify({ ...ok, seq: 'x' }), JSON.stringify({ ...ok, hash: 'nothex' }), JSON.stringify({ ...ok, fullSeq: 3 }), JSON.stringify({ ...ok, fullCount: 0 }), JSON.stringify({ ...ok, verifiedAt: '' }), JSON.stringify({ ...ok, verifiedAt: 'x' }), JSON.stringify({ ...ok, verifiedAt: '2026-13-45T99:00:00Z' }), JSON.stringify({ ...ok, verifiedAt: 'Tue, 14 Oct 2026' })];
    for (const bad of bads) {
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

describe('review findings', () => {
  it('M4: the last event edited and re-hashed, the head not updated: detected', () => {
    const app = appWith(3);
    fullChainCheck(app.kernel, T0);
    for (let i = 3; i < 5; i++) app.kernel.appendEvent('r', `t${i}`, 'k', { i }, 'p');
    const db = app.kernel.db;
    db.prepare(`UPDATE events SET data = '{"i":99}' WHERE seq = 5`).run();
    const r = db.prepare(`SELECT * FROM events WHERE seq = 5`).get() as Parameters<typeof eventHash>[1] & { prev_hash: string };
    db.prepare(`UPDATE events SET hash = ? WHERE seq = 5`).run(eventHash(r.prev_hash, r));
    expect(chainStatus(app.kernel, T1)).toMatchObject({ ok: false, reason: expect.stringMatching(/chain head/) });
  });

  it('A5: /runs moving the verified point never overwrites a newer full check (compare-and-set)', () => {
    const app = appWith(3);
    fullChainCheck(app.kernel, T0);
    app.kernel.appendEvent('r', 'x', 'k', {}, 'p');
    // /runs has read the checkpoint (T0); `audit verify` runs (T1) before /runs writes its moved point
    const db = app.kernel.db;
    const prepare = db.prepare.bind(db);
    let raced = false;
    db.prepare = ((sql: string) => {
      if (!raced && /^\s*(INSERT INTO|UPDATE) app_settings/.test(sql)) {
        raced = true;
        db.prepare = prepare;
        fullChainCheck(app.kernel, T1);
      }
      return prepare(sql);
    }) as typeof db.prepare;
    try {
      chainStatus(app.kernel, T1);
    } finally {
      db.prepare = prepare;
    }
    expect(raced).toBe(true);
    expect(readCheckpoint(db)).toMatchObject({ verifiedAt: T1, fullSeq: 4, fullCount: 4, seq: 4 });
  });

  it('A5b: a full check that reached further meanwhile is never moved back by /runs', () => {
    const app = appWith(3);
    fullChainCheck(app.kernel, T0);
    app.kernel.appendEvent('r', 'x', 'k', {}, 'p');
    const db = app.kernel.db;
    const prepare = db.prepare.bind(db);
    let raced = false;
    db.prepare = ((sql: string) => {
      if (!raced && /^\s*(INSERT INTO|UPDATE) app_settings/.test(sql)) {
        raced = true;
        db.prepare = prepare;
        app.kernel.appendEvent('r', 'y', 'k', {}, 'p'); // a run appends, then audit verify walks to event 5
        fullChainCheck(app.kernel, T1);
      }
      return prepare(sql);
    }) as typeof db.prepare;
    try {
      chainStatus(app.kernel, T1); // walked to event 4 before the race
    } finally {
      db.prepare = prepare;
    }
    expect(raced).toBe(true);
    expect(readCheckpoint(db)).toMatchObject({ seq: 5, count: 5, verifiedAt: T1, fullSeq: 5, fullCount: 5 });
  });
});

describe('re-review: the marker is compare-and-set, and fails closed', () => {
  const T2 = '2026-10-14T03:00:00.000Z';
  /** Runs `during` once, in the middle of `walker`'s event walk (after its 3rd event): another process acting meanwhile. */
  const midWalk = (walker: AppStore, during: () => void): (() => void) => {
    const orig = walker.kernel.eventsAfter.bind(walker.kernel);
    let n = 0;
    (walker.kernel as unknown as { eventsAfter: unknown }).eventsAfter = function* (s: number) {
      for (const r of orig(s)) {
        if (n++ === 2) during();
        yield r;
      }
    };
    return () => {
      (walker.kernel as unknown as { eventsAfter: unknown }).eventsAfter = orig;
    };
  };
  const twoConnections = (fn: (walker: AppStore, other: AppStore) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'jobpilot-r2-'));
    try {
      const path = join(dir, 'j.db');
      const walker = AppStore.open(path);
      for (let i = 0; i < 6; i++) walker.kernel.appendEvent('r', `t${i}`, 'k', { i }, 'p');
      const other = AppStore.open(path);
      try {
        fn(walker, other);
      } finally {
        other.close();
        walker.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const tamperAndFail = (other: AppStore) => () => {
    // meanwhile: an edit commits and the weekly full check (coverage) fails and writes the marker
    other.kernel.db.prepare(`UPDATE events SET data = '{"i":99}' WHERE seq = 1`).run();
    expect(fullChainCheck(other.kernel, T1)).toMatchObject({ ok: false, brokenAt: 1 });
  };

  it('R2: /runs\' fallback walk on a pre-edit snapshot never clears a marker written meanwhile, nor says intact', () => {
    twoConnections((walker, other) => {
      const restore = midWalk(walker, tamperAndFail(other));
      let st;
      try {
        st = chainStatus(walker.kernel, T2);
      } finally {
        restore();
      }
      expect(st).toMatchObject({ ok: false, reason: expect.stringMatching(/^at event 1: hash does not match/) });
      expect(readBroken(walker.kernel.db)).toMatchObject({ seq: 1, at: T1 });
      expect(readCheckpoint(walker.kernel.db)).toBeUndefined();
      expect(chainStatus(walker.kernel, T2)).toMatchObject({ ok: false });
    });
  });

  it('R2 for audit verify: a pass on the older snapshot records nothing and says why', () => {
    twoConnections((walker, other) => {
      fullChainCheck(walker.kernel, T0);
      const before = readCheckpoint(walker.kernel.db);
      const told: string[] = [];
      const restore = midWalk(walker, tamperAndFail(other));
      try {
        expect(fullChainCheck(walker.kernel, T2, { onRecordFailed: (m) => told.push(m) })).toMatchObject({ ok: true });
      } finally {
        restore();
      }
      expect(told).toEqual([expect.stringMatching(/a full check recorded the chain broken meanwhile/)]);
      expect(readBroken(walker.kernel.db)).toMatchObject({ seq: 1, at: T1 });
      expect(readCheckpoint(walker.kernel.db)).toEqual(before);
    });
  });

  it('a pass whose snapshot already saw the marker clears it (the repair case is unchanged)', () => {
    twoConnections((walker, other) => {
      tamperAndFail(other)();
      other.kernel.db.prepare(`UPDATE events SET data = '{"i":0}' WHERE seq = 1`).run();
      expect(fullChainCheck(walker.kernel, T2)).toMatchObject({ ok: true });
      expect(readBroken(walker.kernel.db)).toBeUndefined();
    });
  });

  it('P6: a pass on an older snapshot never moves the full-check checkpoint backwards', () => {
    twoConnections((walker, other) => {
      const restore = midWalk(walker, () => {
        // meanwhile: a run appends and another full check (audit verify) reaches further and records it
        for (let i = 6; i < 8; i++) other.kernel.appendEvent('r', `t${i}`, 'k', { i }, 'p');
        expect(fullChainCheck(other.kernel, T1)).toMatchObject({ ok: true, events: 8 });
      });
      try {
        expect(fullChainCheck(walker.kernel, T2)).toMatchObject({ ok: true, events: 6 });
      } finally {
        restore();
      }
      expect(readCheckpoint(walker.kernel.db)).toMatchObject({ seq: 8, fullSeq: 8, fullCount: 8, verifiedAt: T1 });
    });
  });

  it('N9: an unreadable or garbage marker value counts as broken (fail closed)', () => {
    for (const bad of ['not json', 'null', '42', '"x"', '[]', '{}', '{"seq":"x"}']) {
      const app = appWith(2);
      app.kernel.db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)`).run(CHAIN_BROKEN_KEY, bad);
      expect(readBroken(app.kernel.db), bad).toBeDefined();
      expect(chainStatus(app.kernel, T1), bad).toMatchObject({ ok: false });
    }
  });
});

