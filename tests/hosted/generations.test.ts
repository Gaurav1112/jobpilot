import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkState, sealFiles, stateFiles, StateError } from '../../src/app/hosted/bundle.js';
import { archiveTagOf, assetOf, fetchGeneration, IN_FLIGHT_GRACE_MS, prunePlan, publishGeneration, tagOf, verifyGeneration } from '../../src/app/hosted/generations.js';
import { dirGitHub } from '../../src/app/hosted/github-dir.js';
import type { GitHubClient, Release } from '../../src/app/hosted/github.js';
import { JpstError } from '../../src/app/hosted/jpst.js';
import { EMPTY_POINTER, type GenRecord, type Pointer } from '../../src/app/hosted/pointer.js';
import { buildHostedHome } from '../support/hosted-home.js';

const NOW = '2026-10-15T01:30:00.000Z';
const d = mkdtempSync(join(tmpdir(), 'jp-gens-'));
afterAll(() => rmSync(d, { recursive: true, force: true }));
const key = randomBytes(32);
let n = 0;
const fresh = (): string => join(d, `w${n++}`);

async function sealed(corrupt = false, tamper = false): Promise<{ file: string; s: Awaited<ReturnType<typeof sealFiles>> }> {
  const home = fresh();
  buildHostedHome(home, NOW);
  if (tamper) {
    const db = new Database(join(home, 'jobpilot.db'));
    db.prepare(`UPDATE events SET data = '{"n":99}' WHERE seq = 1`).run();
    db.close();
  }
  if (corrupt) {
    const fd = openSync(join(home, 'jobpilot.db'), 'r+');
    writeSync(fd, Buffer.alloc(4096), 0, 4096, 8192);
    closeSync(fd);
  }
  const file = fresh() + '.jpst';
  return { file, s: await sealFiles(stateFiles(home, NOW), file, key) };
}
const recOf = (gen: number, s: { sha256: string; bytes: number }): GenRecord => ({
  gen,
  tag: tagOf(gen),
  asset: assetOf(gen),
  sha256: s.sha256,
  bytes: s.bytes,
  schema: { kernel: 1, app: 1 },
  codeSha: 'b'.repeat(40),
  packHash: 'pack',
  lastDone: { daily: null, freelance: null, coverage: null },
  at: NOW,
});
const ghOf = async (over: Partial<GitHubClient> = {}): Promise<GitHubClient> => {
  const gh = dirGitHub(fresh());
  await gh.initState('init');
  return { ...gh, ...over } as GitHubClient;
};

describe('tags', () => {
  it('pads generations', () => {
    expect(tagOf(7)).toBe('state-g000007');
    expect(assetOf(7)).toBe('state-g000007.jpst');
    expect(archiveTagOf(12)).toBe('archive-g000012');
  });
  it('a per-attempt nonce makes each publish its own tag', () => {
    expect(tagOf(7, '0a1b2c3d')).toBe('state-g000007-0a1b2c3d');
    expect(archiveTagOf(12, '0a1b2c3d')).toBe('archive-g000012-0a1b2c3d');
  });
});

describe('publishGeneration', () => {
  it('publishes and the release matches', async () => {
    const { file, s } = await sealed();
    const gh = await ghOf();
    expect(await publishGeneration(gh, tagOf(1), file, assetOf(1), s, d)).toEqual({ ok: true });
    const r = await gh.release(tagOf(1));
    expect(r?.assets[0]).toMatchObject({ name: assetOf(1), size: s.bytes, digest: `sha256:${s.sha256}` });
  });
  it('a size mismatch is verify and the release is gone', async () => {
    const { file, s } = await sealed();
    const base = await ghOf();
    const gh = await ghOf({
      ...base,
      release: async (t) => {
        const r = await base.release(t);
        return r && { ...r, assets: r.assets.map((a) => ({ ...a, size: a.size + 1 })) };
      },
    });
    expect(await publishGeneration(gh, tagOf(1), file, assetOf(1), s, d)).toEqual({ ok: false, reason: 'verify' });
    expect(await base.release(tagOf(1))).toBeNull();
  });
  it('a null digest falls back to download and hash', async () => {
    const { file, s } = await sealed();
    const base = await ghOf();
    let downloads = 0;
    const gh = await ghOf({
      ...base,
      release: async (t) => {
        const r = await base.release(t);
        return r && { ...r, assets: r.assets.map((a) => ({ ...a, digest: null })) };
      },
      downloadAsset: async (t, nm, to) => {
        downloads++;
        return base.downloadAsset(t, nm, to);
      },
    });
    expect(await publishGeneration(gh, tagOf(1), file, assetOf(1), s, d)).toEqual({ ok: true });
    expect(downloads).toBe(1);
  });
  it('a throwing upload is upload and the release is gone', async () => {
    const { file, s } = await sealed();
    const base = await ghOf();
    const gh = await ghOf({ ...base, uploadAsset: async () => { throw new Error('boom'); } });
    expect(await publishGeneration(gh, tagOf(1), file, assetOf(1), s, d)).toEqual({ ok: false, reason: 'upload' });
    expect(await base.release(tagOf(1))).toBeNull();
  });
  it('a createRelease failure (the tag exists, another writer owns it) leaves that release alone', async () => {
    const { file, s } = await sealed();
    const gh = await ghOf();
    // another writer's release of the same tag, already verified
    expect(await publishGeneration(gh, tagOf(1), file, assetOf(1), s, d)).toEqual({ ok: true });
    expect(await publishGeneration(gh, tagOf(1), file, assetOf(1), s, d)).toEqual({ ok: false, reason: 'upload' });
    expect((await gh.release(tagOf(1)))?.assets.map((a) => a.name)).toEqual([assetOf(1)]);
  });
});

describe('fetchGeneration', () => {
  it('restores a checked home', async () => {
    const { file, s } = await sealed();
    const gh = await ghOf();
    await publishGeneration(gh, tagOf(1), file, assetOf(1), s, d);
    const home = fresh();
    await fetchGeneration(gh, recOf(1, s), key, d, home);
    expect(checkState(home, NOW)).toMatchObject({ ok: true });
  });
  it('a pointer checksum mismatch is StateError sha256 and home is not created', async () => {
    const { file, s } = await sealed();
    const gh = await ghOf();
    await publishGeneration(gh, tagOf(1), file, assetOf(1), s, d);
    const home = fresh();
    const err = await fetchGeneration(gh, recOf(1, { ...s, sha256: 'c'.repeat(64) }), key, d, home).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateError);
    expect((err as StateError).code).toBe('sha256');
    expect(existsSync(home)).toBe(false);
  });
  it('a wrong key is JpstError wrong-key', async () => {
    const { file, s } = await sealed();
    const gh = await ghOf();
    await publishGeneration(gh, tagOf(1), file, assetOf(1), s, d);
    const err = await fetchGeneration(gh, recOf(1, s), randomBytes(32), d, fresh()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JpstError);
    expect((err as JpstError).code).toBe('wrong-key');
  });
});

describe('verifyGeneration', () => {
  it('a good generation passes all four checks', async () => {
    const { file, s } = await sealed();
    const gh = await ghOf();
    await publishGeneration(gh, tagOf(1), file, assetOf(1), s, d);
    expect(await verifyGeneration(gh, recOf(1, s), key, d, NOW)).toEqual({
      v: 1, gen: 1, ok: true, checks: { sha256: true, decrypt: true, quickCheck: true, audit: true }, code: null,
    });
  });
  it('a corrupted DB fails quickCheck', async () => {
    const { file, s } = await sealed(true);
    const gh = await ghOf();
    await publishGeneration(gh, tagOf(1), file, assetOf(1), s, d);
    const v = await verifyGeneration(gh, recOf(1, s), key, d, NOW);
    expect(v.ok).toBe(false);
    expect(v.checks).toMatchObject({ sha256: true, decrypt: true, quickCheck: false });
    expect(v.code).toBe('quick-check');
  });
  it('an audit-broken but quick_check-clean DB records quickCheck true, audit false', async () => {
    const { file, s } = await sealed(false, true);
    const gh = await ghOf();
    await publishGeneration(gh, tagOf(1), file, assetOf(1), s, d);
    const v = await verifyGeneration(gh, recOf(1, s), key, d, NOW);
    expect(v).toEqual({ v: 1, gen: 1, ok: false, checks: { sha256: true, decrypt: true, quickCheck: true, audit: false }, code: 'audit' });
  });
});

describe('prunePlan', () => {
  const DAY = 86_400_000;
  const now = '2030-01-21T06:00:00.000Z';
  const ago = (days: number): string => new Date(Date.parse(now) - days * DAY).toISOString();
  const rel = (tag: string, ageDays: number): Release => ({ tag, createdAt: ago(ageDays), assets: [] });
  const keep = { generations: 7, weekly: 4, archiveDays: 30 };
  /** A committed record of `gen` with its own nonce, committed `ageDays` ago. */
  const rec = (gen: number, nonce: string, ageDays = 0): GenRecord => ({ ...recOf(gen, { sha256: 'a'.repeat(64), bytes: 1 }), tag: tagOf(gen, nonce), at: ago(ageDays) });
  const nonce = (g: number): string => String(g % 10).repeat(8);
  /** The pointer at the newest of `history` (newest first). */
  const at = (history: GenRecord[]): Pointer => ({ ...EMPTY_POINTER, gen: history[0]!.gen, current: history[0]!, history });
  const keptOf = (history: readonly GenRecord[], del: readonly string[]): number[] => history.filter((h) => !del.includes(h.tag)).map((h) => h.gen);

  it('keeps the newest committed, one per recent week, the current; prunes archives; ignores foreign tags', () => {
    const history = Array.from({ length: 20 }, (_, i) => rec(20 - i, nonce(20 - i), i));
    const rels = [...history.map((h, i) => rel(h.tag, i)), rel(archiveTagOf(1), 31), rel(archiveTagOf(2), 29), rel('v1.0', 400)];
    const del = prunePlan(rels, at(history), now, keep);
    const kept = keptOf(history, del);
    for (let g = 14; g <= 20; g++) expect(kept).toContain(g);
    expect(kept.length).toBeLessThanOrEqual(11);
    expect(kept.length).toBeGreaterThanOrEqual(8);
    expect(del).toContain(archiveTagOf(1));
    expect(del).not.toContain(archiveTagOf(2));
    expect(del).not.toContain('v1.0');
    expect(del).toEqual([...del].sort());
  });
  it('prunes nonce archives by age', () => {
    const history = Array.from({ length: 10 }, (_, i) => rec(10 - i, nonce(10 - i), i));
    const rels = [...history.map((h, i) => rel(h.tag, i)), rel(archiveTagOf(1, 'aaaaaaaa'), 31), rel(archiveTagOf(2, 'bbbbbbbb'), 29)];
    const del = prunePlan(rels, at(history), now, { generations: 3, weekly: 0, archiveDays: 30 });
    expect(keptOf(history, del)).toEqual([10, 9, 8]);
    expect(del).toContain(archiveTagOf(1, 'aaaaaaaa'));
    expect(del).not.toContain(archiveTagOf(2, 'bbbbbbbb'));
  });
  it('an orphan attempt of a committed generation goes; a young attempt above the pointer (in flight) stays', () => {
    const recs = [3, 2, 1].map((g) => rec(g, nonce(g), 1));
    const rels = [...recs.map((r) => rel(r.tag, 1)), rel(tagOf(2, 'dead0000'), 1), rel(tagOf(4, 'eeeeeeee'), 0)];
    const del = prunePlan(rels, at(recs), now, { generations: 7, weekly: 4, archiveDays: 30 });
    expect(del).toEqual([tagOf(2, 'dead0000')]);
  });
  it('orphan attempts at the newest generation never take a kept slot', () => {
    const history = [5, 4, 3, 2, 1].map((g) => rec(g, nonce(g)));
    const rels = [...history.map((h) => rel(h.tag, 0)), rel(tagOf(5, 'dead0001'), 0), rel(tagOf(5, 'dead0002'), 0)];
    const del = prunePlan(rels, at(history), now, { generations: 3, weekly: 0, archiveDays: 30 });
    expect(keptOf(history, del)).toEqual([5, 4, 3]);
    expect(del).toEqual([history[4]!.tag, history[3]!.tag, tagOf(5, 'dead0001'), tagOf(5, 'dead0002')].sort());
  });
  it('after a rollback and a new commit, the abandoned line never takes a slot of the committed history', () => {
    const line = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((g) => rec(g, nonce(g)));
    const g8 = rec(8, 'abcdef01');
    const history = [g8, ...line.filter((h) => h.gen < 8)];
    const rels = [...line.map((h) => rel(h.tag, 2)), rel(g8.tag, 0)];
    const del = prunePlan(rels, at(history), now, { generations: 7, weekly: 0, archiveDays: 30 });
    expect(keptOf(history, del)).toEqual([8, 7, 6, 5, 4, 3, 2]);
    // the abandoned g8 is an orphan of a committed number; g9 and g10 are above the pointer and two days old
    for (const g of [8, 9, 10]) expect(del).toContain(tagOf(g, nonce(g)));
  });
  it('a weekly slot goes to a committed record, never to an abandoned or above-pointer release', () => {
    const history = [3, 2, 1].map((g) => rec(g, nonce(g), 7 * (3 - g) + 1)); // g3 this week, g2 last week, g1 the week before
    const rels = [...history.map((h) => rel(h.tag, 7 * (3 - h.gen) + 1)), rel(tagOf(2, 'dead0000'), 8), rel(tagOf(9, 'eeeeeeee'), 9)];
    const del = prunePlan(rels, at(history), now, { generations: 1, weekly: 3, archiveDays: 30 });
    expect(keptOf(history, del)).toEqual([3, 2, 1]);
    expect(del).toEqual([tagOf(2, 'dead0000'), tagOf(9, 'eeeeeeee')]);
  });
  it('a release above the pointer is kept for the in-flight grace, then deleted', () => {
    const history = [2, 1].map((g) => rec(g, nonce(g), 1));
    const young = tagOf(3, 'aaaaaaaa');
    const old = tagOf(4, 'bbbbbbbb');
    const rels = [...history.map((h) => rel(h.tag, 1)), { tag: young, createdAt: new Date(Date.parse(now) - IN_FLIGHT_GRACE_MS + 60_000).toISOString(), assets: [] }, { tag: old, createdAt: new Date(Date.parse(now) - IN_FLIGHT_GRACE_MS - 60_000).toISOString(), assets: [] }];
    const del = prunePlan(rels, at(history), now, keep);
    expect(del).toEqual([old]);
  });
  it('never deletes the current record, even with keep 0', () => {
    const history = [2, 1].map((g) => rec(g, nonce(g), 1));
    const del = prunePlan(history.map((h) => rel(h.tag, 1)), at(history), now, { generations: 0, weekly: 0, archiveDays: 30 });
    expect(del).toEqual([history[1]!.tag]);
  });
  it('never deletes the newest generation of an older schema', () => {
    const rels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((g) => rel(tagOf(g), 10 - g));
    const mk = (gen: number, app: number): GenRecord => ({ ...recOf(gen, { sha256: 'a'.repeat(64), bytes: 1 }), schema: { kernel: 1, app } });
    const history = [10, 9, 8, 3, 2].map((g) => mk(g, g > 5 ? 2 : 1));
    const pointer: Pointer = { ...EMPTY_POINTER, gen: 10, current: history[0]!, history };
    const del = prunePlan(rels, pointer, now, { generations: 2, weekly: 0, archiveDays: 30 });
    expect(del).not.toContain(tagOf(3));
    expect(del).toContain(tagOf(2));
  });
});

describe('prunePlan after a rollback (final review)', () => {
  const rec = (gen: number, at: string) => ({ gen, tag: tagOf(gen, 'ab'), asset: 'a', sha256: '0'.repeat(64), bytes: 1, schema: { kernel: 1, app: 1 }, codeSha: '0'.repeat(40), packHash: 'p', lastDone: { daily: null, freelance: null, coverage: null }, at });
  it('keeps every release a history record names above the pointer, whatever its age, so the rollback can be undone', () => {
    const hist = [10, 9, 8, 7, 6].map((g) => rec(g, `2026-10-${String(g).padStart(2, '0')}T01:00:00.000Z`));
    const k = hist.find((h) => h.gen === 7)!;
    const pointer = { v: 1 as const, gen: 7, current: k, lease: null, budget: null, sizeHard: false, history: hist };
    const releases = hist.map((h) => ({ tag: h.tag, createdAt: h.at, assets: [] }));
    const plan = prunePlan(releases, pointer, '2026-10-30T01:00:00.000Z', { generations: 2, weekly: 0, archiveDays: 30 });
    for (const g of [10, 9, 8, 7]) expect(plan).not.toContain(tagOf(g, 'ab'));
    expect(plan).toEqual([]); // keep 2 at or below the pointer: 7 and 6
  });
});
