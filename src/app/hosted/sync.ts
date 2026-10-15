import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { HostedConfig } from './config.js';
import { checkpointDb, checkState, sealFiles, StateError, stateFiles, type Sealed } from './bundle.js';
import { archiveTagOf, assetOf, fetchGeneration, publishGeneration, tagOf } from './generations.js';
import type { GitHubClient, StateHead } from './github.js';
import { refuseDefaultHome } from './home-guard.js';
import type { GenRecord, LastDone, Pointer } from './pointer.js';
import { acquireLease, commitGeneration, releaseLease, StateConflict, type Holder } from './state.js';

const MB = 1_048_576;
/** How long a laptop `push` / `seed` holds the lease (a long, deliberate operation; expiry frees a crashed one). */
export const LAPTOP_LEASE_MINUTES = 60;

export interface PublishInput {
  readonly gh: GitHubClient;
  readonly key: Buffer; // STATE_KEY
  readonly home: string; // the home to bundle (never the default one)
  readonly tmpDir: string;
  readonly base: StateHead; // read under our lease
  readonly holder: Holder;
  readonly now: string;
  readonly codeSha: string;
  readonly lastDone: LastDone;
  readonly files?: Readonly<Record<string, string>>;
  readonly state: HostedConfig['state'];
  readonly budget: Pointer['budget'];
  /** File names inside `<home>/archive/` to upload as the release archive-g<G+1>. */
  readonly archiveSegments?: readonly string[];
}
export type PublishOutcome =
  | { readonly ok: true; readonly head: StateHead; readonly sealed: Sealed; readonly sizeLevel: 'ok' | 'warning' | 'hard limit' }
  | { readonly ok: false; readonly reason: 'bundle' | 'upload' | 'verify' | 'cas' };

/** Compressed size against the configured thresholds (spec 3.3). */
export function sizeLevelOf(bytes: number, state: Pick<HostedConfig['state'], 'warnCompressedMB' | 'hardCompressedMB'>): 'ok' | 'warning' | 'hard limit' {
  if (bytes >= state.hardCompressedMB * MB) return 'hard limit';
  if (bytes >= state.warnCompressedMB * MB) return 'warning';
  return 'ok';
}

/** The DB's schema record: kernel user_version and app_schema.version, read-only. */
export function schemaOf(db: string): { kernel: number; app: number } {
  const d = new Database(db, { readonly: true, fileMustExist: true });
  try {
    const kernel = d.pragma('user_version', { simple: true }) as number;
    const hasApp = d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_schema'`).get() !== undefined;
    const app = hasApp ? (d.prepare(`SELECT version FROM app_schema WHERE id = 1`).get() as { version: number } | undefined)?.version ?? 0 : 0;
    return { kernel, app };
  } finally {
    d.close();
  }
}

/** The newest runs_summary pack hash, or 'none'. */
export function packHashOf(db: string): string {
  const d = new Database(db, { readonly: true, fileMustExist: true });
  try {
    const has = d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs_summary'`).get() !== undefined;
    if (!has) return 'none';
    const row = d.prepare(`SELECT pack_hash FROM runs_summary ORDER BY at DESC, run_id DESC LIMIT 1`).get() as { pack_hash: string } | undefined;
    return row !== undefined && row.pack_hash !== '' ? row.pack_hash : 'none';
  } finally {
    d.close();
  }
}

const DAILY = /^daily-(\d{4}-\d{2}-\d{2})(?:-\d+)?$/;
const FREELANCE = /^freelance-(\d{4}-\d{2}-\d{2})-am(?:-\d+)?$/;
const COVERAGE = /^coverage-(\d{4}-\d{2}-\d{2})(?:-\d+)?$/;

/** The date of the newest completed daily, freelance (`am`) and coverage run in the DB (null when none). */
export function lastDoneOf(db: string): LastDone {
  const d = new Database(db, { readonly: true, fileMustExist: true });
  try {
    const hasRuns = d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'`).get() !== undefined;
    const ids = hasRuns ? (d.prepare(`SELECT run_id FROM runs WHERE status = 'completed'`).all() as { run_id: string }[]) : [];
    const newest = (re: RegExp): string | null => {
      let best: string | null = null;
      for (const { run_id } of ids) {
        const m = re.exec(run_id)?.[1];
        if (m !== undefined && (best === null || m > best)) best = m;
      }
      return best;
    };
    return { daily: newest(DAILY), freelance: newest(FREELANCE), coverage: newest(COVERAGE) };
  } finally {
    d.close();
  }
}

const scratchName = (): string => randomBytes(6).toString('hex');

/** checkpoint → stateFiles → seal → publish release G+1 (+ archive) → commitGeneration; on CAS conflict deletes the new releases. */
export async function publishHome(i: PublishInput): Promise<PublishOutcome> {
  const gen = i.base.pointer.gen + 1;
  const tag = tagOf(gen);
  const archiveTag = archiveTagOf(gen);
  mkdirSync(i.tmpDir, { recursive: true, mode: 0o700 });
  const bundle = join(i.tmpDir, `${assetOf(gen)}.${scratchName()}`);
  let sealed: Sealed;
  const db = join(i.home, 'jobpilot.db');
  try {
    checkpointDb(db);
    sealed = await sealFiles(stateFiles(i.home, i.now), bundle, i.key);
  } catch {
    rmSync(bundle, { force: true });
    return { ok: false, reason: 'bundle' };
  }
  let rec: GenRecord;
  try {
    rec = {
      gen,
      tag,
      asset: assetOf(gen),
      sha256: sealed.sha256,
      bytes: sealed.bytes,
      schema: schemaOf(db),
      codeSha: i.codeSha,
      packHash: packHashOf(db),
      lastDone: i.lastDone,
      at: new Date(Date.parse(i.now)).toISOString(),
    };
  } catch {
    rmSync(bundle, { force: true });
    return { ok: false, reason: 'bundle' };
  }
  try {
    const pub = await publishGeneration(i.gh, tag, bundle, assetOf(gen), sealed, i.tmpDir);
    if (!pub.ok) return pub;
  } finally {
    rmSync(bundle, { force: true });
  }
  const dropAll = async (): Promise<void> => {
    await i.gh.deleteRelease(tag).catch(() => undefined);
    await i.gh.deleteRelease(archiveTag).catch(() => undefined);
  };
  const segments = i.archiveSegments ?? [];
  if (segments.length > 0) {
    try {
      await i.gh.createRelease(archiveTag);
      for (const name of segments) await i.gh.uploadAsset(archiveTag, join(i.home, 'archive', name), name);
    } catch {
      await dropAll();
      return { ok: false, reason: 'upload' };
    }
  }
  const sizeLevel = sizeLevelOf(sealed.bytes, i.state);
  try {
    const head = await commitGeneration(i.gh, i.base, i.holder, rec, { ...(i.files !== undefined ? { files: i.files } : {}), sizeHard: sizeLevel === 'hard limit', budget: i.budget });
    return { ok: true, head, sealed, sizeLevel };
  } catch (e) {
    if (!(e instanceof StateConflict)) throw e; // unknown outcome: leave the releases, a later prune takes them
    await dropAll();
    return { ok: false, reason: 'cas' };
  }
}

/** `hosted pull`: the current generation into a NEW (empty or missing) folder, verified. Never the default home. */
export async function pullHome(o: { gh: GitHubClient; key: Buffer; to: string; tmpDir: string; defaultHome?: string }): Promise<{ gen: number }> {
  refuseDefaultHome(o.to, 'pull', o.defaultHome);
  const head = await o.gh.readState();
  if (head === null || head.pointer.current === null) throw new Error('hosted pull: there is no generation yet (run hosted seed)');
  if (existsSync(o.to) && readdirSync(o.to).length > 0) throw new StateError('not-empty', 'the target folder is not empty');
  await fetchGeneration(o.gh, head.pointer.current, o.key, o.tmpDir, o.to);
  const r = checkState(o.to, new Date().toISOString());
  if (!r.ok) throw new StateError(r.code, `the pulled state failed its check: ${r.detail}`);
  return { gen: head.pointer.gen };
}

/** `laptop:<first 8 hex of sha256(hostname)>`: the lease holder of this machine. */
export const laptopHolder = (): Holder => `laptop:${createHash('sha256').update(hostname()).digest('hex').slice(0, 8)}`;

/** `hosted push`: takes the lease (StateBusy while Actions holds it), publishes G+1 from `from`, or releases the lease again. */
export async function pushHome(o: {
  gh: GitHubClient;
  key: Buffer;
  from: string;
  tmpDir: string;
  now: string;
  codeSha: string;
  state: HostedConfig['state'];
  holder: Holder;
  defaultHome?: string;
}): Promise<PublishOutcome> {
  refuseDefaultHome(o.from, 'push', o.defaultHome);
  const db = join(o.from, 'jobpilot.db');
  if (!existsSync(db)) throw new Error('hosted push: there is no jobpilot.db in the home');
  const until = new Date(Date.parse(o.now) + LAPTOP_LEASE_MINUTES * 60_000).toISOString();
  const base = await acquireLease(o.gh, o.holder, o.now, until);
  let out: PublishOutcome | undefined;
  try {
    const check = checkState(o.from, o.now);
    if (!check.ok) throw new StateError(check.code, `the home failed its check, nothing was pushed: ${check.detail}`);
    out = await publishHome({
      gh: o.gh,
      key: o.key,
      home: o.from,
      tmpDir: o.tmpDir,
      base,
      holder: o.holder,
      now: o.now,
      codeSha: o.codeSha,
      lastDone: lastDoneOf(db),
      state: o.state,
      budget: base.pointer.budget,
    });
    return out;
  } finally {
    if (out === undefined || !out.ok) await releaseLease(o.gh, o.holder).catch(() => undefined);
  }
}
