import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { fullChainCheck } from '../../src/app/chain-status.js';
import { withLock } from '../../src/app/lock.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { storeCompactCommand, storeRestoreCommand } from '../../src/app/store/compact-command.js';
import { applyCompaction, COMPACTED_EVENT, DEFAULT_RETENTION, loadRetentionPolicy, planCompaction, RESTORED_EVENT, restoreSegment, type RetentionPolicy } from '../../src/app/store/retention.js';
import type { Envelope } from '../../src/kernel/envelope.js';
import { archived, clock, doneStep, env, history, homes, KEEP2, newHome, NOW, plan, quiet, root, sha, tableDump } from '../support/retention-fixture.js';
import { createDashboard } from '../../src/app/web/server.js';
import { Sessions } from '../../src/app/web/security.js';

/**
 * Retention (`jobpilot store compact` / `store restore`): the keep set and each pin rule, archive-never-delete, the
 * chain event before the rows go, memo safety (an archived step loses its step row), dry run, refusals, restore byte
 * for byte. The pipeline-level proof (re-run after compaction = a fresh run, docs rebuild, the dashboard) is in
 * retention-e2e.test.ts.
 */
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('the keep set: runs and each pin rule', () => {
  it('R1 keeps the last N completed daily runs whole; older runs are archived step by step', () => {
    const { app, ids } = history(newHome());
    const p = plan(app);
    expect(p.keptRuns).toEqual(['daily-2026-10-03', 'daily-2026-10-04']);
    const a = archived(p);
    expect(a.has(ids['seed 2026-10-03'] as string)).toBe(false);
    expect(a.has(ids['rendered 3333333333333333 2026-10-04'] as string)).toBe(false);
    // day 1 job 3 has nothing pinning it
    expect(a.has(ids['rendered 3333333333333333 2026-10-01'] as string)).toBe(true);
    expect(a.has(ids['posting 3333333333333333 2026-10-01'] as string)).toBe(true);
    expect(p.archive.steps).toBeGreaterThan(0);
    app.close();
  });

  it('R4 keeps the Rendered@1 behind a job\'s current documents, and R6 its whole lineage up to the seed', () => {
    const { app, ids } = history(newHome());
    const a = archived(plan(app));
    for (const k of ['rendered 1111111111111111 2026-10-01', 'posting 1111111111111111 2026-10-01', 'raw 1111111111111111 2026-10-01', 'seed 2026-10-01']) expect(a.has(ids[k] as string), k).toBe(false);
    expect(app.renderedPlanOf('1111111111111111')).toEqual({ date: '2026-10-01' });
    app.close();
  });

  it('R5 keeps the newest Posting@1 of each job seen in the last 14 days (contractPostings), not older ones', () => {
    const { app, ids } = history(newHome());
    const p = plan(app);
    const a = archived(p);
    expect(a.has(ids['posting 2222222222222222 2026-10-02'] as string)).toBe(false);
    expect(a.has(ids['posting 2222222222222222 2026-10-01'] as string)).toBe(true);
    expect(p.pinnedBy['R5 newest postings']).toBeGreaterThan(0);
    app.close();
  });

  it('R2 keeps the latest daily run\'s queue inputs (docs rebuild, coverage probe) even with daily: 1', () => {
    const { app, ids } = history(newHome());
    // the runs_summary latest differs from the kernel's newest completed run: both are kept
    app.kernel.db.prepare(`UPDATE runs_summary SET at = '2026-10-30T00:00:00.000Z' WHERE run_id = 'daily-2026-10-02'`).run();
    const p = plan(app, false, { ...KEEP2, keep: { ...KEEP2.keep, daily: 1 } });
    expect(archived(p).has(ids['seed 2026-10-02'] as string)).toBe(false);
    expect(p.pinnedBy['R2 latest daily']).toBeGreaterThan(0);
    app.close();
  });

  it('R3 keeps incomplete runs; --include-incomplete archives only stale ones (resumable ones stay)', () => {
    const home = newHome();
    const { app } = history(home);
    const k = app.kernel;
    for (const [runId, date] of [['daily-2026-09-20', '2026-09-20'], ['daily-2026-10-14', '2026-10-14']] as const) {
      k.startRun(runId, 'jobpilot-daily@1.0.0', 'p', `${date}T01:30:00.000Z`);
      const seed = env(`seed-${runId}`, 0, 'DiscoveryRequest@1', { runDate: date });
      k.putSeed(seed.stepKey, seed, '1.0.0', 'h');
      k.enqueue(runId, 0, 'src-greenhouse', seed.envelopeId);
    }
    const seedOf = (runId: string): string => (k.db.prepare(`SELECT envelope_id FROM queue WHERE run_id = ?`).get(runId) as { envelope_id: string }).envelope_id;
    const strict = plan(app);
    expect(strict.incomplete).toEqual([{ runId: 'daily-2026-09-20', pinned: true }, { runId: 'daily-2026-10-14', pinned: true }]);
    expect(archived(strict).has(seedOf('daily-2026-09-20'))).toBe(false);
    const loose = plan(app, true);
    expect(loose.incomplete).toEqual([{ runId: 'daily-2026-09-20', pinned: false }, { runId: 'daily-2026-10-14', pinned: true }]);
    expect(archived(loose).has(seedOf('daily-2026-09-20'))).toBe(true);
    expect(archived(loose).has(seedOf('daily-2026-10-14'))).toBe(false);
    app.close();
  });

  it('R4/R5 for gigs: the GigRendered@1 gigExtras returns (newest match) and the newest Gig@1 of each gig', () => {
    const { app } = history(newHome());
    const k = app.kernel;
    k.db.prepare(`INSERT INTO gigs (gig_key, dedupe_key, platform, source_id, url, title, client, kind, budget, hours, first_seen, last_seen) VALUES ('g1', 'd', 'freelancer', '1', 'https://x.test', 'T', '{}', 'gig', '{}', '{}', 'a', 'a')`).run();
    k.db.prepare(`INSERT INTO gig_docs (gig_key, kind, format, path, sha256) VALUES ('g1', 'proposal', 'txt', 'g1/proposal.txt', 'aa')`).run();
    const runId = 'freelance-2026-09-01-am';
    k.startRun(runId, 'jobpilot-freelance@1.0.0', 'p', '2026-09-01T01:30:00.000Z');
    const ids: string[] = [];
    for (const [n, type, payload] of [
      [0, 'Gig@1', { gigKey: 'g1', v: 1 }],
      [1, 'Gig@1', { gigKey: 'g1', v: 2 }],
      [2, 'GigRendered@1', { gigKey: 'g1', files: [{ path: 'g1/proposal.txt', sha256: 'aa' }], v: 1 }],
      [3, 'GigRendered@1', { gigKey: 'g1', files: [{ path: 'g1/proposal.txt', sha256: 'aa' }], v: 2 }],
      [4, 'GigRendered@1', { gigKey: 'g1', files: [{ path: 'g1/proposal.txt', sha256: 'bb' }], v: 3 }],
    ] as const) {
      // each made by a step with its step_done event, as the freelance pipeline writes them (the order readers use)
      const input = env(`gig-input-${n}`, 0, 'GigRequest@1', { n });
      k.putSeed(input.stepKey, input, '1.0.0', 'h');
      const [e] = doneStep(app, runId, type === 'Gig@1' ? 'gig-normalizer' : 'gig-renderer', input, [{ type, payload }]) as [Envelope];
      ids.push(e.envelopeId);
    }
    k.finishRun(runId, '2026-09-01T02:00:00.000Z');
    // a newer freelance run is kept (freelance: 1); this one is not
    k.startRun('freelance-2026-10-13-am', 'jobpilot-freelance@1.0.0', 'p', '2026-10-13T01:30:00.000Z');
    k.finishRun('freelance-2026-10-13-am', '2026-10-13T02:00:00.000Z');
    const extrasBefore = app.gigExtras(['g1']);
    const a = archived(plan(app));
    expect([ids[0], ids[1], ids[2], ids[3], ids[4]].map((id) => a.has(id as string))).toEqual([true, false, true, false, true]);
    expect(app.gigExtras(['g1'])).toEqual(extrasBefore);
    expect(extrasBefore['g1']).toMatchObject({ gig: { v: 2 }, rendered: { v: 2 } });
    app.close();
  });

  it('a step is the unit: no step keeps some envelopes and archives others', () => {
    const { app } = history(newHome());
    const p = plan(app);
    const a = archived(p);
    const rows = app.kernel.db.prepare(`SELECT envelope_id, step_key FROM envelopes`).all() as { envelope_id: string; step_key: string }[];
    const mixed = new Map<string, Set<boolean>>();
    for (const r of rows) (mixed.get(r.step_key) ?? mixed.set(r.step_key, new Set()).get(r.step_key) as Set<boolean>).add(a.has(r.envelope_id));
    expect([...mixed.values()].filter((s) => s.size > 1)).toEqual([]);
    app.close();
  });

  it('the policy: the pack\'s retention.yaml, validated; the default when absent', () => {
    const home = newHome();
    expect(loadRetentionPolicy(join(home, 'pack')).policy).toEqual(DEFAULT_RETENTION);
    writeFileSync(join(home, 'pack/retention.yaml'), 'version: 1\nkeep: { daily: 5, freelance: 2, coverage: 1, rebuild: 1 }\n');
    expect(loadRetentionPolicy(join(home, 'pack'))).toMatchObject({ policy: { keep: { daily: 5 } }, source: 'pack' });
    writeFileSync(join(home, 'pack/retention.yaml'), 'version: 1\nkeep: { daily: 0, freelance: 1, coverage: 1, rebuild: 1 }\n');
    expect(() => loadRetentionPolicy(join(home, 'pack'))).toThrow(/retention.yaml: keep.daily/);
    writeFileSync(join(home, 'pack/retention.yaml'), 'version: 1\nkeep: { daily: 3, freelance: 1, coverage: 1, rebuild: 1, envelopes: 9 }\n');
    expect(() => loadRetentionPolicy(join(home, 'pack'))).toThrow(/retention.yaml/);
  });
});

describe('store compact: dry run, refusals, archive, chain event, memo safety', () => {
  it('a dry run (the default) prints the plan and writes nothing', async () => {
    const home = newHome();
    history(home).app.close();
    const before = sha(readFileSync(join(home, 'jobpilot.db')));
    const out: string[] = [];
    expect(await storeCompactCommand({ home, clock, out: (l) => out.push(l), err: (l) => out.push(l), apply: false, includeIncomplete: false, vacuum: true })).toBe(0);
    expect(out.join('\n')).toMatch(/archive: \d+ envelopes from \d+ steps/);
    expect(out.join('\n')).toContain('dry run: nothing was written');
    expect(out.join('\n')).toMatch(/by agent:[\s\S]*normalizer/);
    expect(existsSync(join(home, 'archive'))).toBe(false);
    expect(sha(readFileSync(join(home, 'jobpilot.db')))).toBe(before);
  });

  it('refuses while the run lock is held, and --apply refuses while a run is incomplete', async () => {
    const home = newHome();
    const { app } = history(home);
    app.kernel.startRun('daily-2026-10-14', 'jobpilot-daily@1.0.0', 'p', NOW);
    app.close();
    await expect(withLock(home, 'run', () => storeCompactCommand({ home, clock, ...quiet, apply: true, includeIncomplete: false, vacuum: false }))).rejects.toThrow(/lock|another jobpilot/i);
    const err: string[] = [];
    expect(await storeCompactCommand({ home, clock, out: () => {}, err: (l) => err.push(l), apply: true, includeIncomplete: false, vacuum: false })).toBe(1);
    expect(err.join('\n')).toMatch(/refused: runs are incomplete or resumable \(daily-2026-10-14\)/);
    expect(existsSync(join(home, 'archive'))).toBe(false);
  });

  it('--apply: a verified segment and manifest, the chain event before the rows go, step rows removed with their envelopes', async () => {
    const home = newHome();
    const { app } = history(home);
    const p = plan(app);
    const r = await applyCompaction(app, p, { dbPath: join(home, 'jobpilot.db'), archiveDir: join(home, 'archive'), now: NOW, vacuum: true });
    expect(r).toMatchObject({ envelopes: p.archive.envelopes, steps: p.archive.steps, vacuum: 'done' });
    const files = readdirSync(join(home, 'archive')).sort();
    expect(files).toEqual([r.segment, `${r.segment}.manifest.json`]);
    const seg = readFileSync(join(home, 'archive', r.segment as string));
    const manifest = JSON.parse(readFileSync(join(home, 'archive', `${r.segment}.manifest.json`), 'utf8')) as { sha256: string; envelopeIds: string[]; counts: { envelopes: number }; policyVersion: number };
    expect(manifest).toMatchObject({ sha256: sha(seg), envelopeIds: p.envelopeIds, counts: { envelopes: p.archive.envelopes }, policyVersion: 1 });
    const ev = app.kernel.db.prepare(`SELECT data FROM events WHERE kind = ?`).get(COMPACTED_EVENT) as { data: string };
    expect(JSON.parse(ev.data)).toMatchObject({ segment: r.segment, sha256: sha(seg), envelopes: p.archive.envelopes, steps: p.archive.steps, policyVersion: 1, policyHash: 'ph' });
    // memo safety: no archived envelope left, no archived step row left, every remaining done step with outputs has them
    const ph = (xs: readonly string[]) => xs.map(() => '?').join(', ');
    expect(app.kernel.db.prepare(`SELECT COUNT(*) AS n FROM envelopes WHERE envelope_id IN (${ph(p.envelopeIds)})`).get(...p.envelopeIds)).toEqual({ n: 0 });
    expect(app.kernel.db.prepare(`SELECT COUNT(*) AS n FROM steps WHERE step_key IN (${ph(p.stepKeys)})`).get(...p.stepKeys)).toEqual({ n: 0 });
    // the chain verifies after compaction, and the readers still answer
    expect(fullChainCheck(app.kernel, NOW, { record: false })).toMatchObject({ ok: true });
    expect(app.renderedPlanOf('1111111111111111')).toEqual({ date: '2026-10-01' });
    expect(app.contractPostings('2026-09-30T00:00:00.000Z').missing).toEqual(expect.not.arrayContaining(['2222222222222222']));
    app.close();
  });

  it('works beside a running dashboard (its long-lived connection), VACUUM included', async () => {
    const home = newHome();
    const { app } = history(home);
    const dash = createDashboard({ home, clock, sessions: new Sessions(Buffer.alloc(32, 7)) });
    const get = async (p: string) => (await dash.request(p, { headers: { host: 'localhost', cookie: 'jp_sid=' + 'ab'.repeat(16) } })).status;
    expect(await get('/')).toBe(200);
    const r = await applyCompaction(app, plan(app), { dbPath: join(home, 'jobpilot.db'), archiveDir: join(home, 'archive'), now: NOW, vacuum: true });
    expect(r.vacuum).toBe('done');
    for (const p of ['/', '/runs', '/jobs/1111111111111111', '/freelance']) expect(await get(p), p).toBe(200);
    app.close();
  });

  it('VACUUM is skipped, with a reason, when the disk lacks the database\'s size', async () => {
    const home = newHome();
    const { app } = history(home);
    const r = await applyCompaction(app, plan(app), { dbPath: join(home, 'jobpilot.db'), archiveDir: join(home, 'archive'), now: NOW, vacuum: true, freeBytes: () => 1024 });
    expect(r.vacuum).toBe('skipped: not enough free disk');
    app.close();
  });

  it('a segment that does not read back as written removes nothing', async () => {
    const home = newHome();
    const { app } = history(home);
    const before = tableDump(app);
    const p = plan(app);
    // the disk returns other bytes than were written (one envelope line lost)
    const corrupt = (path: string): void => {
      const lines = gunzipSync(readFileSync(path)).toString('utf8').split('\n');
      writeFileSync(path, gzipSync(lines.slice(1).join('\n')));
    };
    await expect(applyCompaction(app, p, { dbPath: join(home, 'jobpilot.db'), archiveDir: join(home, 'archive'), now: NOW, vacuum: false, beforeVerify: corrupt })).rejects.toThrow(/did not read back as written; nothing was removed/);
    expect(tableDump(app)).toBe(before);
    expect(app.kernel.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = ?`).get(COMPACTED_EVENT)).toEqual({ n: 0 });
    app.close();
  });
});

describe('store restore', () => {
  it('brings the envelopes and step rows back byte for byte, and records it', async () => {
    const home = newHome();
    const { app } = history(home);
    const before = tableDump(app);
    const r = await applyCompaction(app, plan(app), { dbPath: join(home, 'jobpilot.db'), archiveDir: join(home, 'archive'), now: NOW, vacuum: false });
    expect(tableDump(app)).not.toBe(before);
    app.close();
    const out: string[] = [];
    expect(await storeRestoreCommand({ home, clock, out: (l) => out.push(l), err: () => {}, all: true })).toBe(0);
    expect(out[0]).toBe(`restored ${r.segment as string}: ${r.envelopes} envelopes and ${r.steps} step rows; recorded (store.restored)`);
    const s = AppStore.open(join(home, 'jobpilot.db'));
    expect(tableDump(s)).toBe(before);
    expect(s.kernel.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = ?`).get(RESTORED_EVENT)).toEqual({ n: 1 });
    expect(fullChainCheck(s.kernel, NOW, { record: false })).toMatchObject({ ok: true });
    s.close();
  });

  it('refuses a segment whose bytes do not match its chain event, and one with no event', async () => {
    const home = newHome();
    const { app } = history(home);
    const r = await applyCompaction(app, plan(app), { dbPath: join(home, 'jobpilot.db'), archiveDir: join(home, 'archive'), now: NOW, vacuum: false });
    const path = join(home, 'archive', r.segment as string);
    const lines = gunzipSync(readFileSync(path)).toString('utf8').replace('"normalizer"', '"normaliser"');
    writeFileSync(path, gzipSync(lines));
    const after = tableDump(app);
    await expect(restoreSegment(app, { archiveDir: join(home, 'archive'), segment: r.segment as string, now: NOW })).rejects.toThrow(/does not match its chain event/);
    expect(tableDump(app)).toBe(after);
    // an event edited away breaks the chain: the restore does not trust it (retention-restore.test.ts covers orphans)
    app.kernel.db.prepare(`UPDATE events SET kind = 'x' WHERE kind = ?`).run(COMPACTED_EVENT);
    await expect(restoreSegment(app, { archiveDir: join(home, 'archive'), segment: r.segment as string, now: NOW })).rejects.toThrow(/the audit chain does not verify/);
    app.close();
  });
});

describe('the CLI', () => {
  it('jobpilot store compact is a dry run by default; --apply archives; restore --all brings it back', () => {
    const home = newHome();
    history(home).app.close();
    const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/bin.ts'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, JOBPILOT_HOME: home, VITEST: 'true' } });
    const dry = cli('store', 'compact');
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('dry run: nothing was written');
    expect(existsSync(join(home, 'archive'))).toBe(false);
    const both = cli('store', 'compact', '--apply', '--dry-run');
    expect(both.status).toBe(1);
    const apply = cli('store', 'compact', '--apply');
    expect(apply.status, apply.stderr).toBe(0);
    expect(apply.stdout).toMatch(/archived \d+ envelopes and \d+ step rows/);
    expect(apply.stdout).toMatch(/database: [\d.]+ MB -> [\d.]+ MB; vacuum done/);
    const restore = cli('store', 'restore', '--all');
    expect(restore.status, restore.stderr).toBe(0);
    expect(restore.stdout).toMatch(/restored envelopes-.*: \d+ envelopes and \d+ step rows; recorded/);
  }, 120_000);
});

