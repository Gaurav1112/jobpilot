import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dirGitHub } from '../../src/app/hosted/github-dir.js';
import type { GitHubClient } from '../../src/app/hosted/github.js';
import type { GenRecord } from '../../src/app/hosted/pointer.js';
import { pointerJson } from '../../src/app/hosted/pointer.js';
import {
  StateBusy,
  StateConflict,
  acquireLease,
  appendStateFiles,
  commitGeneration,
  releaseLease,
  rollbackTo,
} from '../../src/app/hosted/state.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'jp-state-'));
const T0 = '2030-01-01T00:00:00.000Z';
const T1 = '2030-01-01T01:00:00.000Z';
const T2 = '2030-01-01T02:00:00.000Z';
const A = 'actions:100' as const;
const B = 'actions:200' as const;
const budget = { month: '2030-01', level: 'L0' } as const;

const rec = (gen: number, schema = { kernel: 1, app: 1 }): GenRecord => ({
  gen,
  tag: `state-g${gen}`,
  asset: 'state.jpst',
  sha256: 'a'.repeat(64),
  bytes: 10,
  schema,
  codeSha: 'b'.repeat(40),
  packHash: 'pack',
  lastDone: { daily: null, freelance: null, coverage: null },
  at: '2030-01-01T00:00:00.000Z',
});

async function fresh(hooks = {}): Promise<{ gh: GitHubClient; dir: string }> {
  const dir = tmp();
  const gh = dirGitHub(dir, hooks);
  await gh.initState('init');
  return { gh, dir };
}

describe('acquireLease', () => {
  it('takes a free lease; a second holder is busy until it expires, then takes over', async () => {
    const { gh } = await fresh();
    const head = await acquireLease(gh, A, T0, T1);
    expect(head.pointer.lease).toEqual({ holder: A, until: T1 });
    expect((await gh.readState())?.pointer.lease).toEqual({ holder: A, until: T1 });
    const err = await acquireLease(gh, B, T0, T2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateBusy);
    expect((err as StateBusy).holder).toBe(A);
    expect((err as StateBusy).until).toBe(T1);
    expect(String((err as Error).message)).toContain(A);
    // exactly at until is still live (free only when until < now)
    await expect(acquireLease(gh, B, T1, T2)).rejects.toBeInstanceOf(StateBusy);
    const taken = await acquireLease(gh, B, '2030-01-01T01:00:00.001Z', T2);
    expect(taken.pointer.lease).toEqual({ holder: B, until: T2 });
  });

  it('two writers race: exactly one lease, the loser is busy', async () => {
    const dir = tmp();
    const other = dirGitHub(dir);
    let fired = false;
    const mine = dirGitHub(dir, {
      beforeCas: async () => {
        if (fired) return;
        fired = true;
        await acquireLease(other, B, T0, T1);
      },
    });
    await mine.initState('init');
    await expect(acquireLease(mine, A, T0, T1)).rejects.toBeInstanceOf(StateBusy);
    expect((await mine.readState())?.pointer.lease?.holder).toBe(B);
  });
});

describe('commitGeneration', () => {
  it('moves gen 0 to 1, keeps shadow files, clears the lease', async () => {
    const { gh } = await fresh();
    const base = await acquireLease(gh, A, T0, T1);
    const head = await commitGeneration(gh, base, A, rec(1), { files: { 'shadow/d.json': '{}' }, sizeHard: true, budget });
    expect(head.pointer.gen).toBe(1);
    const p = (await gh.readState())?.pointer;
    expect(p?.current).toEqual(rec(1));
    expect(p?.history).toEqual([rec(1)]);
    expect(p?.lease).toBeNull();
    expect(p?.sizeHard).toBe(true);
    expect(p?.budget).toEqual(budget);
    expect(await gh.readStateFile('shadow/d.json')).toBe('{}');
  });

  it('retries benignly when a ledger append slips in, and keeps the ledger line', async () => {
    const dir = tmp();
    const other = dirGitHub(dir);
    let fired = false;
    const mine = dirGitHub(dir, {
      beforeCas: async () => {
        if (!fired) return;
        fired = false;
        await appendStateFiles(other, async (_h, read) => ({ 'ledger/2030-01.jsonl': `${(await read('ledger/2030-01.jsonl')) ?? ''}x\n` }), 'ledger');
      },
    });
    await mine.initState('init');
    const base = await acquireLease(mine, A, T0, T1);
    fired = true;
    const head = await commitGeneration(mine, base, A, rec(1), { sizeHard: false, budget });
    expect(head.pointer.gen).toBe(1);
    expect(await mine.readStateFile('ledger/2030-01.jsonl')).toBe('x\n');
  });

  it("throws StateConflict when another holder's lease appears; gen unchanged", async () => {
    const dir = tmp();
    const other = dirGitHub(dir);
    let fired = false;
    const mine = dirGitHub(dir, {
      beforeCas: async (parent) => {
        if (!fired) return;
        fired = false;
        const h = await other.readState();
        const p = { ...h!.pointer, lease: { holder: B, until: T2 } };
        await other.casState(parent, { 'pointer.json': pointerJson(p) }, 'steal');
      },
    });
    await mine.initState('init');
    const base = await acquireLease(mine, A, T0, T1);
    fired = true;
    await expect(commitGeneration(mine, base, A, rec(1), { sizeHard: false, budget })).rejects.toBeInstanceOf(StateConflict);
    const p = (await mine.readState())?.pointer;
    expect(p?.gen).toBe(0);
    expect(p?.lease?.holder).toBe(B);
  });

  it('refuses without our lease or on a stale base', async () => {
    const { gh } = await fresh();
    const base = await gh.readState();
    await expect(commitGeneration(gh, base!, A, rec(1), { sizeHard: false, budget })).rejects.toBeInstanceOf(StateConflict);
  });

  it('caps history at 30, newest first', async () => {
    const { gh } = await fresh();
    for (let g = 1; g <= 33; g++) {
      const base = await acquireLease(gh, A, T0, T1);
      await commitGeneration(gh, base, A, rec(g), { sizeHard: false, budget });
    }
    const h = (await gh.readState())!.pointer.history;
    expect(h).toHaveLength(30);
    expect(h[0]?.gen).toBe(33);
    expect(h[29]?.gen).toBe(4);
  });
});

describe('releaseLease', () => {
  it('clears our lease, leaves gen; false for a foreign or missing lease', async () => {
    const { gh } = await fresh();
    expect(await releaseLease(gh, A)).toBe(false);
    await acquireLease(gh, A, T0, T1);
    expect(await releaseLease(gh, B)).toBe(false);
    expect((await gh.readState())?.pointer.lease?.holder).toBe(A);
    expect(await releaseLease(gh, A)).toBe(true);
    const p = (await gh.readState())!.pointer;
    expect(p.lease).toBeNull();
    expect(p.gen).toBe(0);
  });
});

describe('appendStateFiles', () => {
  it('re-runs edit on a racing append: both lines present, in order', async () => {
    const dir = tmp();
    const other = dirGitHub(dir);
    let fired = false;
    const mine = dirGitHub(dir, {
      beforeCas: async () => {
        if (fired) return;
        fired = true;
        await appendStateFiles(other, async (_h, read) => ({ 'ledger/m.jsonl': `${(await read('ledger/m.jsonl')) ?? ''}first\n` }), 'a');
      },
    });
    await mine.initState('init');
    await appendStateFiles(mine, async (_h, read) => ({ 'ledger/m.jsonl': `${(await read('ledger/m.jsonl')) ?? ''}second\n` }), 'b');
    expect(await mine.readStateFile('ledger/m.jsonl')).toBe('first\nsecond\n');
  });
});

describe('rollbackTo', () => {
  async function withGens(schemas: { kernel: number; app: number }[]): Promise<GitHubClient> {
    const { gh } = await fresh();
    for (const [i, s] of schemas.entries()) {
      const base = await acquireLease(gh, A, T0, T1);
      await commitGeneration(gh, base, A, rec(i + 1, s), { sizeHard: false, budget });
    }
    return gh;
  }

  it('refuses under a live lease and for an unknown generation', async () => {
    const gh = await withGens([{ kernel: 1, app: 1 }, { kernel: 1, app: 1 }]);
    await acquireLease(gh, A, T0, T1);
    await expect(rollbackTo(gh, 1, T0, {})).rejects.toBeInstanceOf(StateBusy);
    await releaseLease(gh, A);
    await expect(rollbackTo(gh, 9, T0, {})).rejects.toThrow(/history/);
  });

  it('moves to K, history unchanged; a later commit stays well-formed', async () => {
    const gh = await withGens([{ kernel: 1, app: 1 }, { kernel: 1, app: 1 }, { kernel: 1, app: 1 }]);
    const before = (await gh.readState())!.pointer.history;
    const head = await rollbackTo(gh, 1, T0, {});
    expect(head.pointer.gen).toBe(1);
    expect(head.pointer.current).toEqual(rec(1));
    expect(head.pointer.history).toEqual(before);
    const base = await acquireLease(gh, A, T0, T1);
    const next = await commitGeneration(gh, base, A, rec(2), { sizeHard: false, budget });
    expect(next.pointer.history.map((r) => r.gen)).toEqual([2, 1]);
  });

  it('refuses a lower schema without withCode, allows it with', async () => {
    const gh = await withGens([{ kernel: 1, app: 1 }, { kernel: 1, app: 2 }]);
    await expect(rollbackTo(gh, 1, T0, {})).rejects.toThrow(
      'rollback below schema 1.2 needs the code that wrote it: pass --with-code <sha> and set code.lock to it',
    );
    const head = await rollbackTo(gh, 1, T0, { withCode: 'c'.repeat(40) });
    expect(head.pointer.gen).toBe(1);
    expect(head.pointer.current).toEqual(rec(1));
  });
});
