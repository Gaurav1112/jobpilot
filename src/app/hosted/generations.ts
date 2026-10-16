import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { coverageWeek } from '../due.js';
import { checkState, openInto, sha256File, StateError, type Sealed } from './bundle.js';
import type { GitHubClient, Release } from './github.js';
import type { GenRecord, Pointer } from './pointer.js';

const pad = (gen: number): string => String(gen).padStart(6, '0');
const suffix = (nonce?: string): string => (nonce === undefined ? '' : `-${nonce}`);
/**
 * The release tag of generation `gen`. Each publish attempt adds its own `nonce`, so two writers (a stale lease holder,
 * a line abandoned by a rollback, a job killed mid-publish) never share a tag; the pointer's record names the tag.
 */
export const tagOf = (gen: number, nonce?: string): string => `state-g${pad(gen)}${suffix(nonce)}`;
export const assetOf = (gen: number): string => `state-g${pad(gen)}.jpst`;
export const archiveTagOf = (gen: number, nonce?: string): string => `archive-g${pad(gen)}${suffix(nonce)}`;

export type PublishResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'upload' | 'verify' };

const scratch = (tmpDir: string, prefix: string): string => {
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(tmpDir, prefix));
};

/**
 * Creates the release, uploads, then checks the API's size and `sha256:` digest (or downloads again and hashes).
 * Deletes the release on a later failure, but never when creating it failed: the tag may be another writer's.
 */
export async function publishGeneration(gh: GitHubClient, tag: string, file: string, name: string, sealed: Sealed, tmpDir: string): Promise<PublishResult> {
  const fail = async (reason: 'upload' | 'verify'): Promise<PublishResult> => {
    await gh.deleteRelease(tag).catch(() => undefined);
    return { ok: false, reason };
  };
  try {
    await gh.createRelease(tag);
  } catch {
    return { ok: false, reason: 'upload' }; // not ours to delete (it exists, or creating it is in doubt; prune takes an orphan)
  }
  try {
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
  const m = /^state-g(\d+)(?:-[0-9a-f]+)?$/.exec(tag);
  return m === null ? null : Number(m[1]);
};

/** How long a release above the pointer is left alone: a writer may still be publishing (or committing) it. */
export const IN_FLIGHT_GRACE_MS = DAY_MS;

/**
 * Pure: the release tags to delete. What stays is chosen from the pointer's committed records only (history and
 * current, gen ≤ pointer.gen), each by the tag its record names: the current record, the newest `generations`, the
 * newest of each of the last `weekly` IST weeks, and the newest of every older schema. Every other state release is an
 * orphan or an abandoned attempt and goes, except one above the pointer younger than IN_FLIGHT_GRACE_MS.
 */
export function prunePlan(
  releases: readonly Release[],
  pointer: Pointer,
  now: string,
  keep: { readonly generations: number; readonly weekly: number; readonly archiveDays: number },
): string[] {
  const byGen = new Map<number, GenRecord>();
  for (const h of pointer.history) if (h.gen <= pointer.gen) byGen.set(h.gen, h);
  if (pointer.current !== null) byGen.set(pointer.current.gen, pointer.current);
  const committed = [...byGen.values()].sort((a, b) => b.gen - a.gen); // newest first, one record per generation

  const kept = new Set<string>();
  if (pointer.current !== null) kept.add(pointer.current.tag);
  for (const r of committed.slice(0, Math.max(0, keep.generations))) kept.add(r.tag);
  // after a rollback the history still names the generations above the pointer: they are how the rollback is undone,
  // so they stay whatever their age (the next commit drops those records, and normal pruning resumes)
  for (const h of pointer.history) if (h.gen > pointer.gen) kept.add(h.tag);

  // the newest committed generation of each of the last `weekly` IST weeks (this week and the ones before it)
  const thisWeek = Date.parse(`${coverageWeek(now)}T00:00:00Z`);
  const weeks = new Set<number>();
  for (const r of committed) {
    const w = Math.round((thisWeek - Date.parse(`${coverageWeek(r.at)}T00:00:00Z`)) / (7 * DAY_MS));
    if (w < 0 || w >= keep.weekly || weeks.has(w)) continue;
    weeks.add(w);
    kept.add(r.tag);
  }

  // the newest committed generation of every older schema stays as a rollback target
  const cur = pointer.current?.schema;
  const schemas = new Set<string>();
  for (const r of committed) {
    const k = `${r.schema.kernel}.${r.schema.app}`;
    if (schemas.has(k)) continue;
    schemas.add(k);
    if (cur === undefined || k !== `${cur.kernel}.${cur.app}`) kept.add(r.tag);
  }

  const out: string[] = [];
  const nowMs = Date.parse(now);
  for (const r of releases) {
    const gen = genOf(r.tag);
    if (gen === null || kept.has(r.tag)) continue;
    // above the pointer nothing is committed yet: a writer may be publishing there, so only a stale one goes
    if (gen > pointer.gen && !(nowMs - Date.parse(r.createdAt) >= IN_FLIGHT_GRACE_MS)) continue;
    out.push(r.tag);
  }
  const cutoff = nowMs - keep.archiveDays * DAY_MS;
  for (const r of releases) if (/^archive-g\d+(?:-[0-9a-f]+)?$/.test(r.tag) && Date.parse(r.createdAt) < cutoff) out.push(r.tag);
  return out.sort();
}
