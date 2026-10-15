import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { checkState, stateFiles, StateError } from '../../src/app/hosted/bundle.js';
import { HostedConfig } from '../../src/app/hosted/config.js';
import { verifyGeneration } from '../../src/app/hosted/generations.js';
import { dirGitHub } from '../../src/app/hosted/github-dir.js';
import type { GitHubClient } from '../../src/app/hosted/github.js';
import { DefaultHomeError } from '../../src/app/hosted/home-guard.js';
import { pointerJson } from '../../src/app/hosted/pointer.js';
import { seedAndPublish, seedHome } from '../../src/app/hosted/seed.js';
import { acquireLease, StateBusy } from '../../src/app/hosted/state.js';
import { lastDoneOf, packHashOf, publishHome, pullHome, pushHome, schemaOf, sizeLevelOf } from '../../src/app/hosted/sync.js';
import { schemaState } from '../../src/app/store/app-store.js';
import { APP_MIGRATIONS } from '../../src/app/store/schema.js';
import { MIGRATIONS } from '../../src/kernel/store/migrations.js';
import { BEHIND_VERSION, LAST_INDEX } from '../support/behind-schema.js';
import { history, NOW as HISTORY_NOW, newHome, homes } from '../support/retention-fixture.js';

const NOW = '2026-10-15T01:30:00.000Z';
const SHA = 'c'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'jp-seed-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const key = randomBytes(32);
let n = 0;
const fresh = (): string => join(root, `w${n++}`);
const STATE = HostedConfig.shape.state.parse({ keepGenerations: 5, keepWeekly: 2, archiveDays: 30, warnCompressedMB: 100, hardCompressedMB: 200 });
const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');

/** A fictional stand-in for the Mac's home: four completed daily runs, one freelance run, a schema one migration behind. */
function macHome(): string {
  const home = newHome();
  const { app } = history(home);
  app.kernel.startRun('freelance-2026-10-04-am', 'jobpilot-freelance@1.0.0', 'p', '2026-10-04T01:40:00.000Z');
  app.kernel.finishRun('freelance-2026-10-04-am', '2026-10-04T01:50:00.000Z');
  app.close();
  const d = new Database(join(home, 'jobpilot.db'));
  d.exec(`DROP INDEX ${LAST_INDEX}; UPDATE app_schema SET version = ${BEHIND_VERSION}`);
  d.close();
  mkdirSync(join(home, 'out', '0123456789abcdef'), { recursive: true });
  writeFileSync(join(home, 'out', '0123456789abcdef', 'resume.pdf'), '%PDF-1.4 fictional\n');
  writeFileSync(join(home, 'daily-attempts.json'), '{}\n');
  return home;
}
const newGh = (hooks = {}): GitHubClient => dirGitHub(fresh(), hooks);

describe('helpers', () => {
  it('schemaOf, packHashOf, lastDoneOf read a migrated home', async () => {
    const mac = macHome();
    const { home } = await seedHome({ from: mac, work: fresh(), now: HISTORY_NOW });
    const db = join(home, 'jobpilot.db');
    expect(schemaOf(db)).toEqual({ kernel: MIGRATIONS.length, app: APP_MIGRATIONS.length });
    expect(packHashOf(db)).toBe('x');
    expect(lastDoneOf(db)).toEqual({ daily: '2026-10-04', freelance: '2026-10-04', coverage: null });
  });
  it('sizeLevelOf', () => {
    const s = { warnCompressedMB: 2, hardCompressedMB: 4 };
    expect(sizeLevelOf(2 * 1_048_576 - 1, s)).toBe('ok');
    expect(sizeLevelOf(2 * 1_048_576, s)).toBe('warning');
    expect(sizeLevelOf(4 * 1_048_576, s)).toBe('hard limit');
  });
});

describe('seedHome', () => {
  it('leaves the source untouched and migrates and compacts the copy', async () => {
    const mac = macHome();
    const db = join(mac, 'jobpilot.db');
    const before = { sha: sha(db), mtime: statSync(db).mtimeMs, files: readdirSync(mac).sort() };
    const r = await seedHome({ from: mac, work: fresh(), now: HISTORY_NOW });
    expect(sha(db)).toBe(before.sha);
    expect(statSync(db).mtimeMs).toBe(before.mtime);
    expect(readdirSync(mac).sort()).toEqual(before.files);
    expect(existsSync(`${db}-wal`)).toBe(false);
    expect(existsSync(`${db}-shm`)).toBe(false);
    expect(schemaState(db)).toBe('behind');
    expect(schemaOf(db).app).toBe(BEHIND_VERSION);
    // the copy
    const copy = join(r.home, 'jobpilot.db');
    expect(schemaState(copy)).toBe('current');
    expect(readdirSync(join(r.home, 'archive')).some((f) => f.startsWith('envelopes-'))).toBe(true);
    expect(r.outFiles).toBe(1);
    expect(r.dbBytes).toBe(statSync(copy).size);
    expect(existsSync(join(r.home, 'out', '0123456789abcdef', 'resume.pdf'))).toBe(true);
    expect(existsSync(join(r.home, 'daily-attempts.json'))).toBe(true);
    expect(checkState(r.home, HISTORY_NOW).ok).toBe(true);
    // pack/ is only the retention policy, and never bundled
    expect(readdirSync(join(r.home, 'pack'))).toEqual(['retention.yaml']);
    expect(stateFiles(r.home, HISTORY_NOW).some((f) => f.name.startsWith('pack/'))).toBe(false);
  });
  it('removes a -wal/-shm it created beside a WAL source', async () => {
    const mac = macHome();
    const db = join(mac, 'jobpilot.db');
    const d = new Database(db);
    d.pragma('journal_mode = WAL');
    d.close();
    const r = await seedHome({ from: mac, work: fresh(), now: HISTORY_NOW });
    expect(existsSync(`${db}-wal`)).toBe(false);
    expect(existsSync(`${db}-shm`)).toBe(false);
    expect(schemaState(join(r.home, 'jobpilot.db'))).toBe('current');
  });
});

describe('seedAndPublish, pull, push', () => {
  it('seeds generation 1, verifies, and refuses a second seed', async () => {
    const mac = macHome();
    const gh = newGh();
    const out = await seedAndPublish({ gh, key, from: mac, work: fresh(), now: HISTORY_NOW, codeSha: SHA, state: STATE });
    expect(out.ok).toBe(true);
    const head = await gh.readState();
    expect(head?.pointer.gen).toBe(1);
    expect(head?.pointer.lease).toBeNull();
    expect(head?.pointer.current?.lastDone).toEqual({ daily: '2026-10-04', freelance: '2026-10-04', coverage: null });
    expect(head?.pointer.current?.schema).toEqual({ kernel: MIGRATIONS.length, app: APP_MIGRATIONS.length });
    expect((await gh.release('state-g000001'))?.assets[0]?.name).toBe('state-g000001.jpst');
    expect((await gh.release('archive-g000001'))?.assets.length).toBeGreaterThan(0);
    const v = await verifyGeneration(gh, head!.pointer.current!, key, root, NOW);
    expect(v.ok).toBe(true);
    await expect(seedAndPublish({ gh, key, from: mac, work: fresh(), now: HISTORY_NOW, codeSha: SHA, state: STATE })).rejects.toThrow(/state exists/);
  });

  it('pull: new dir ok, non-empty refused, default home refused', async () => {
    const mac = macHome();
    const gh = newGh();
    await seedAndPublish({ gh, key, from: mac, work: fresh(), now: HISTORY_NOW, codeSha: SHA, state: STATE });
    const to = fresh();
    const defaultHome = fresh();
    expect(await pullHome({ gh, key, to, tmpDir: root, defaultHome })).toEqual({ gen: 1 });
    expect(checkState(to, NOW).ok).toBe(true);
    expect(schemaState(join(to, 'jobpilot.db'))).toBe('current');
    expect(existsSync(join(to, 'out', '0123456789abcdef', 'resume.pdf'))).toBe(true);
    const full = fresh();
    mkdirSync(full);
    writeFileSync(join(full, 'x'), 'x');
    await expect(pullHome({ gh, key, to: full, tmpDir: root, defaultHome })).rejects.toMatchObject({ code: 'not-empty' });
    await expect(pullHome({ gh, key, to: full, tmpDir: root, defaultHome })).rejects.toBeInstanceOf(StateError);
    await expect(pullHome({ gh, key, to: defaultHome, tmpDir: root, defaultHome })).rejects.toBeInstanceOf(DefaultHomeError);
  });

  it('push after a change makes generation 2; a live actions lease is StateBusy', async () => {
    const mac = macHome();
    const gh = newGh();
    await seedAndPublish({ gh, key, from: mac, work: fresh(), now: HISTORY_NOW, codeSha: SHA, state: STATE });
    const home = fresh();
    const defaultHome = fresh();
    await pullHome({ gh, key, to: home, tmpDir: root, defaultHome });
    const d = new Database(join(home, 'jobpilot.db'));
    d.prepare(`UPDATE runs SET status = status`).run();
    d.exec(`INSERT INTO runs (run_id, pipeline, policy_hash, started_at, finished_at, status) VALUES ('daily-2026-10-05', 'jobpilot-daily@1.0.0', 'p', '2026-10-05T01:30:00.000Z', '2026-10-05T02:00:00.000Z', 'completed')`);
    d.close();
    const holder = 'laptop:abcdef12' as const;
    await acquireLease(gh, 'actions:777', NOW, '2026-10-15T03:30:00.000Z');
    await expect(pushHome({ gh, key, from: home, tmpDir: root, now: NOW, codeSha: SHA, state: STATE, holder, defaultHome })).rejects.toBeInstanceOf(StateBusy);
    // the Actions lease expires
    const later = '2026-10-15T05:00:00.000Z';
    const out = await pushHome({ gh, key, from: home, tmpDir: root, now: later, codeSha: SHA, state: STATE, holder, defaultHome });
    expect(out.ok).toBe(true);
    const p = (await gh.readState())?.pointer;
    expect(p?.gen).toBe(2);
    expect(p?.lease).toBeNull();
    expect(p?.current?.lastDone.daily).toBe('2026-10-05');
    expect(p?.history.map((h) => h.gen)).toEqual([2, 1]);
    await expect(pushHome({ gh, key, from: defaultHome, tmpDir: root, now: later, codeSha: SHA, state: STATE, holder, defaultHome })).rejects.toBeInstanceOf(DefaultHomeError);
  });
});

describe('publishHome failures', () => {
  async function setup(over: Partial<GitHubClient> = {}): Promise<{ gh: GitHubClient; raw: GitHubClient; home: string; base: Awaited<ReturnType<typeof acquireLease>> }> {
    const mac = macHome();
    const raw = newGh();
    await seedAndPublish({ gh: raw, key, from: mac, work: fresh(), now: HISTORY_NOW, codeSha: SHA, state: STATE });
    const home = fresh();
    await pullHome({ gh: raw, key, to: home, tmpDir: root, defaultHome: fresh() });
    mkdirSync(join(home, 'archive'), { recursive: true });
    writeFileSync(join(home, 'archive', 'seg-1.jsonl.gz'), 'gz');
    const gh = { ...raw, ...over } as GitHubClient;
    const base = await acquireLease(gh, 'laptop:abcdef12', NOW, '2026-10-15T03:00:00.000Z');
    return { gh, raw, home, base };
  }
  const input = (s: Awaited<ReturnType<typeof setup>>) => ({
    gh: s.gh, key, home: s.home, tmpDir: root, base: s.base, holder: 'laptop:abcdef12' as const, now: NOW, codeSha: SHA,
    lastDone: { daily: null, freelance: null, coverage: null }, state: STATE, budget: null, archiveSegments: ['seg-1.jsonl.gz'],
  });

  it('an upload failure leaves no new release and the pointer unchanged', async () => {
    const fail = async (): Promise<void> => {
      throw new Error('boom');
    };
    const s = await setup({ uploadAsset: fail });
    const before = pointerJson((await s.raw.readState())!.pointer);
    const out = await publishHome(input(s));
    expect(out).toEqual({ ok: false, reason: 'upload' });
    const tags = (await s.raw.listReleases()).map((r) => r.tag);
    expect(tags).toEqual(['archive-g000001', 'state-g000001'].sort().filter((t) => tags.includes(t)));
    expect(tags).not.toContain('state-g000002');
    expect(tags).not.toContain('archive-g000002');
    expect(pointerJson((await s.raw.readState())!.pointer)).toBe(before);
  });

  it('an archive upload failure deletes both new releases', async () => {
    const s = await setup();
    const gh = { ...s.gh, uploadAsset: async (t: string, f: string, nme: string) => (t.startsWith('archive-') ? Promise.reject(new Error('boom')) : s.raw.uploadAsset(t, f, nme)) } as GitHubClient;
    const out = await publishHome({ ...input(s), gh });
    expect(out).toEqual({ ok: false, reason: 'upload' });
    const tags = (await s.raw.listReleases()).map((r) => r.tag);
    expect(tags).not.toContain('state-g000002');
    expect(tags).not.toContain('archive-g000002');
  });

  it('a racing writer that takes the lease: reason cas, both new releases deleted', async () => {
    const s = await setup();
    let fired = false;
    const gh = {
      ...s.gh,
      casState: async (parent: string, files: Record<string, string>, msg: string) => {
        if (!fired) {
          fired = true;
          const h = (await s.raw.readState())!;
          await s.raw.casState(h.commit, { 'pointer.json': pointerJson({ ...h.pointer, lease: { holder: 'actions:42', until: '2026-10-15T09:00:00.000Z' } }) }, 'steal');
        }
        return s.raw.casState(parent, files, msg);
      },
    } as GitHubClient;
    const out = await publishHome({ ...input(s), gh });
    expect(out).toEqual({ ok: false, reason: 'cas' });
    const tags = (await s.raw.listReleases()).map((r) => r.tag);
    expect(tags).not.toContain('state-g000002');
    expect(tags).not.toContain('archive-g000002');
    const p = (await s.raw.readState())!.pointer;
    expect(p.gen).toBe(1);
    expect(p.lease?.holder).toBe('actions:42');
  });
});
