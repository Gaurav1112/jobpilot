import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { coverageWeek } from '../due.js';
import { checkState, openInto, sha256File, StateError, type Sealed } from './bundle.js';
import type { GitHubClient, Release } from './github.js';
import type { GenRecord, Pointer } from './pointer.js';

const pad = (gen: number): string => String(gen).padStart(6, '0');
export const tagOf = (gen: number): string => `state-g${pad(gen)}`;
export const assetOf = (gen: number): string => `${tagOf(gen)}.jpst`;
export const archiveTagOf = (gen: number): string => `archive-g${pad(gen)}`;

export type PublishResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'upload' | 'verify' };

const scratch = (tmpDir: string, prefix: string): string => {
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(tmpDir, prefix));
};

/** Creates the release, uploads, then checks the API's size and `sha256:` digest (or downloads again and hashes). Deletes the release on any failure. */
export async function publishGeneration(gh: GitHubClient, tag: string, file: string, name: string, sealed: Sealed, tmpDir: string): Promise<PublishResult> {
  const fail = async (reason: 'upload' | 'verify'): Promise<PublishResult> => {
    await gh.deleteRelease(tag).catch(() => undefined);
    return { ok: false, reason };
  };
  try {
    await gh.createRelease(tag);
    await gh.uploadAsset(tag, file, name);
  } catch {
    return fail('upload');
  }
  try {
    const asset = (await gh.release(tag))?.assets.find((a) => a.name === name);
    if (asset === undefined || asset.size !== sealed.bytes) return await fail('verify');
    if (asset.digest !== null) {
      if (asset.digest !== `sha256:${sealed.sha256}`) return await fail('verify');
    } else {
      const dir = scratch(tmpDir, 'pub-');
      try {
        const back = join(dir, name);
        await gh.downloadAsset(tag, name, back);
        const got = await sha256File(back);
        if (got.bytes !== sealed.bytes || got.sha256 !== sealed.sha256) return await fail('verify');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    return { ok: true };
  } catch {
    return fail('verify');
  }
}

/** Downloads `rec`'s asset, checks size + sha256 against the pointer, opens it into `home` (spec 3.3 step 1). */
export async function fetchGeneration(gh: GitHubClient, rec: GenRecord, key: Buffer, tmpDir: string, home: string): Promise<void> {
  const dir = scratch(tmpDir, 'fetch-');
  try {
    const file = join(dir, rec.asset);
    await gh.downloadAsset(rec.tag, rec.asset, file);
    await openInto(file, key, home, { sha256: rec.sha256, bytes: rec.bytes });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface VerifyRecord {
  readonly v: 1;
  readonly gen: number;
  readonly ok: boolean;
  readonly checks: { readonly sha256: boolean; readonly decrypt: boolean; readonly quickCheck: boolean; readonly audit: boolean };
  readonly code: string | null;
}

/** `hosted verify`: fetch into a temp home, then checkState; never throws for a failed check (it is the record). */
export async function verifyGeneration(gh: GitHubClient, rec: GenRecord, key: Buffer, tmpDir: string, now: string): Promise<VerifyRecord> {
  const checks = { sha256: false, decrypt: false, quickCheck: false, audit: false };
  const done = (code: string | null): VerifyRecord => ({ v: 1, gen: rec.gen, ok: code === null, checks: { ...checks }, code });
  const dir = scratch(tmpDir, 'verify-');
  try {
    const file = join(dir, rec.asset);
    try {
      await gh.downloadAsset(rec.tag, rec.asset, file);
    } catch {
      return done('download');
    }
    const got = await sha256File(file);
    if (got.bytes !== rec.bytes) return done('size');
    if (got.sha256 !== rec.sha256) return done('sha256');
    checks.sha256 = true;
    const home = join(dir, 'home');
    try {
      await openInto(file, key, home);
    } catch (e) {
      return done(e instanceof StateError ? e.code : 'decrypt');
    }
    checks.decrypt = true;
    const r = checkState(home, now);
    // an audit failure means quick_check had already passed
    if (r.ok || r.code === 'audit') checks.quickCheck = true;
    if (!r.ok) return done(r.code);
    checks.audit = true;
    return done(null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DAY_MS = 86_400_000;
const genOf = (tag: string): number | null => {
  const m = /^state-g(\d+)$/.exec(tag);
  return m === null ? null : Number(m[1]);
};

/** Pure: the release tags to delete. */
export function prunePlan(
  releases: readonly Release[],
  pointer: Pointer,
  now: string,
  keep: { readonly generations: number; readonly weekly: number; readonly archiveDays: number },
): string[] {
  const states = releases.flatMap((r) => {
    const gen = genOf(r.tag);
    return gen === null ? [] : [{ gen, tag: r.tag, createdAt: r.createdAt }];
  });
  const kept = new Set<number>();
  for (const s of [...states].sort((a, b) => b.gen - a.gen).slice(0, keep.generations)) kept.add(s.gen);

  // newest generation of each of the last `weekly` IST weeks (this week and the ones before it)
  const thisWeek = Date.parse(`${coverageWeek(now)}T00:00:00Z`);
  const best = new Map<number, number>();
  for (const s of states) {
    const w = Math.round((thisWeek - Date.parse(`${coverageWeek(s.createdAt)}T00:00:00Z`)) / (7 * DAY_MS));
    if (w < 0 || w >= keep.weekly) continue;
    best.set(w, Math.max(best.get(w) ?? 0, s.gen));
  }
  for (const g of best.values()) kept.add(g);

  kept.add(pointer.gen);
  // the newest generation of every older schema stays as a rollback target
  const cur = pointer.current?.schema;
  const newestBySchema = new Map<string, number>();
  for (const h of pointer.history) {
    const k = `${h.schema.kernel}.${h.schema.app}`;
    newestBySchema.set(k, Math.max(newestBySchema.get(k) ?? 0, h.gen));
  }
  for (const [k, g] of newestBySchema) if (cur === undefined || k !== `${cur.kernel}.${cur.app}`) kept.add(g);

  const out: string[] = states.filter((s) => !kept.has(s.gen)).map((s) => s.tag);
  const cutoff = Date.parse(now) - keep.archiveDays * DAY_MS;
  for (const r of releases) if (/^archive-g\d+$/.test(r.tag) && Date.parse(r.createdAt) < cutoff) out.push(r.tag);
  return out.sort();
}
