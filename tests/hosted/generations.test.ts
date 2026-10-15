import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkState, sealFiles, stateFiles, StateError } from '../../src/app/hosted/bundle.js';
import { archiveTagOf, assetOf, fetchGeneration, prunePlan, publishGeneration, tagOf, verifyGeneration } from '../../src/app/hosted/generations.js';
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
  const rel = (tag: string, ageDays: number): Release => ({ tag, createdAt: new Date(Date.parse(now) - ageDays * DAY).toISOString(), assets: [] });
  const keep = { generations: 7, weekly: 4, archiveDays: 30 };
  it('keeps the newest, one per recent week, pointer.gen; prunes archives; ignores foreign tags', () => {
    const rels: Release[] = [];
    for (let g = 1; g <= 20; g++) rels.push(rel(tagOf(g), 20 - g));
    rels.push(rel(archiveTagOf(1), 31), rel(archiveTagOf(2), 29), rel('v1.0', 400));
    const pointer: Pointer = { ...EMPTY_POINTER, gen: 3 };
    const del = prunePlan(rels, pointer, now, keep);
    const kept = rels.map((r) => r.tag).filter((t) => t.startsWith('state-') && !del.includes(t));
    for (let g = 14; g <= 20; g++) expect(kept).toContain(tagOf(g));
    expect(kept).toContain(tagOf(3));
    expect(kept.length).toBeLessThanOrEqual(12);
    expect(kept.length).toBeGreaterThanOrEqual(8);
    expect(del).toContain(archiveTagOf(1));
    expect(del).not.toContain(archiveTagOf(2));
    expect(del).not.toContain('v1.0');
    expect(del).toEqual([...del].sort());
  });
  it('reads the generation of a nonce tag; prunes nonce archives by age', () => {
    const rels: Release[] = [];
    for (let g = 1; g <= 10; g++) rels.push(rel(tagOf(g, `0000000${g % 10}`), 10 - g));
    rels.push(rel(archiveTagOf(1, 'aaaaaaaa'), 31), rel(archiveTagOf(2, 'bbbbbbbb'), 29));
    const del = prunePlan(rels, { ...EMPTY_POINTER, gen: 10 }, now, { generations: 3, weekly: 0, archiveDays: 30 });
    expect(del).toContain(tagOf(1, '00000001'));
    expect(del).not.toContain(tagOf(8, '00000008'));
    expect(del).toContain(archiveTagOf(1, 'aaaaaaaa'));
    expect(del).not.toContain(archiveTagOf(2, 'bbbbbbbb'));
  });
  it('an orphan attempt of a committed generation goes; the attempt above the pointer (in flight) stays', () => {
    const recs = [3, 2, 1].map((g) => ({ ...recOf(g, { sha256: 'a'.repeat(64), bytes: 1 }), tag: tagOf(g, `${g}`.repeat(8)) }));
    const pointer: Pointer = { ...EMPTY_POINTER, gen: 3, current: recs[0]!, history: recs };
    const rels = [...recs.map((r) => rel(r.tag, 1)), rel(tagOf(2, 'dead0000'), 1), rel(tagOf(4, 'eeeeeeee'), 0)];
    const del = prunePlan(rels, pointer, now, { generations: 7, weekly: 4, archiveDays: 30 });
    expect(del).toEqual([tagOf(2, 'dead0000')]);
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
