import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { AppStore } from '../../src/app/store/app-store.js';
import { storeCompactCommand, storeRestoreCommand } from '../../src/app/store/compact-command.js';
import { applyCompaction, COMPACTED_EVENT, restoreSegment } from '../../src/app/store/retention.js';
import type { Envelope } from '../../src/kernel/envelope.js';
import { archived, clock, doneStep, env, history, homes, newHome, NOW, plan, tableDump } from '../support/retention-fixture.js';

/**
 * Retention review round: restore by WHOLE step (a step re-made since compaction is never mixed or broken), original
 * rowids and rowid-independent "newest" readers, orphan segments, the chain checked before its event is trusted, and
 * the mutants the review found alive (Q7-Q11).
 */
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const compact = async (home: string, app: AppStore, p = plan(app), extra: Partial<Parameters<typeof applyCompaction>[2]> = {}) =>
  applyCompaction(app, p, { dbPath: join(home, 'jobpilot.db'), archiveDir: join(home, 'archive'), now: NOW, vacuum: false, ...extra });
const segmentOf = (home: string): string => readdirSync(join(home, 'archive')).find((f) => f.endsWith('.jsonl.gz')) as string;
const stepOf = (app: AppStore, envelopeId: string) => {
  const k = app.kernel;
  const { step_key } = k.db.prepare(`SELECT step_key FROM envelopes WHERE envelope_id = ?`).get(envelopeId) as { step_key: string };
  return { key: step_key, row: k.db.prepare(`SELECT * FROM steps WHERE step_key = ?`).get(step_key) as { agent_id: string; input_envelope_id: string } };
};
const cost = { usd: 0, inputTokens: 0, outputTokens: 0 };

describe('restore: the step is the unit', () => {
  it('T1: an archived step a later run re-made and FAILED is skipped whole; the retry can still complete', async () => {
    const home = newHome();
    const { app, ids } = history(home);
    const p = plan(app);
    const target = ids['posting 3333333333333333 2026-10-01'] as string;
    expect(archived(p).has(target)).toBe(true);
    const S = stepOf(app, target);
    await compact(home, app, p);
    const k = app.kernel;
    k.markRunning({ stepKey: S.key, agentId: S.row.agent_id, version: '1.0.0', contractHash: 'h', inputEnvelopeId: S.row.input_envelope_id });
    k.finishStep({ runId: 'daily-2026-10-14', stepKey: S.key, agentId: S.row.agent_id, status: 'failed', envelopes: [], cost, errorCode: 'timeout' as never, detail: 'x' });
    const r = await restoreSegment(app, { archiveDir: join(home, 'archive'), segment: segmentOf(home), now: NOW });
    expect(r.stepsSkipped).toBe(1);
    expect(k.getStep(S.key)?.status).toBe('failed');
    expect(k.db.prepare(`SELECT COUNT(*) AS n FROM envelopes WHERE step_key = ?`).get(S.key)).toEqual({ n: 0 });
    k.markRunning({ stepKey: S.key, agentId: S.row.agent_id, version: '1.0.0', contractHash: 'h', inputEnvelopeId: S.row.input_envelope_id });
    expect(() => k.finishStep({ runId: 'daily-2026-10-15', stepKey: S.key, agentId: S.row.agent_id, status: 'done', envelopes: [env(S.key, 0, 'Posting@1', { jobKey: '3333333333333333', date: '2026-10-01' })], cost })).not.toThrow();
    app.close();
  });

  it('T2: a step re-made with fewer outputs keeps only its own outputs (Q11: never replaced, never mixed)', async () => {
    const home = newHome();
    const { app } = history(home);
    // no pins on day 1: its 3-output source step is archived whole
    app.kernel.db.prepare(`DELETE FROM job_docs`).run();
    app.kernel.db.prepare(`UPDATE jobs SET last_seen = '2026-01-01T00:00:00.000Z'`).run();
    const p = plan(app, false, { version: 1, keep: { daily: 1, freelance: 1, coverage: 1, rebuild: 1 } });
    const k = app.kernel;
    const big = k.db.prepare(`SELECT step_key, COUNT(*) AS n FROM envelopes WHERE envelope_id IN (${p.envelopeIds.map(() => '?').join(',')}) GROUP BY step_key ORDER BY n DESC LIMIT 1`).get(...p.envelopeIds) as { step_key: string; n: number };
    expect(big.n).toBe(3);
    const row = k.db.prepare(`SELECT * FROM steps WHERE step_key = ?`).get(big.step_key) as { agent_id: string; input_envelope_id: string };
    await compact(home, app, p);
    k.markRunning({ stepKey: big.step_key, agentId: row.agent_id, version: '1.0.0', contractHash: 'h', inputEnvelopeId: row.input_envelope_id });
    k.finishStep({ runId: 'daily-2026-10-14', stepKey: big.step_key, agentId: row.agent_id, status: 'done', envelopes: [env(big.step_key, 0, 'RawPosting@1', { jobKey: 'new', text: 'refetched' })], cost });
    const ofStep = () => JSON.stringify(k.db.prepare(`SELECT rowid, * FROM envelopes WHERE step_key = ? ORDER BY envelope_id`).all(big.step_key)) + JSON.stringify(k.getStep(big.step_key));
    const remade = ofStep();
    const r = await restoreSegment(app, { archiveDir: join(home, 'archive'), segment: segmentOf(home), now: NOW });
    expect(r.stepsSkipped).toBe(1);
    expect(k.envelopesOfStep(big.step_key).map((e) => e.payload)).toEqual([{ jobKey: 'new', text: 'refetched' }]);
    // nothing of the re-made step changed; everything else came back
    expect(ofStep()).toBe(remade);
    expect(r.envelopes.inserted).toBe(p.archive.envelopes - 3);
    app.close();
  });

  it('an envelope whose rowid was taken meanwhile: its whole step is skipped and reported', async () => {
    const home = newHome();
    const { app, ids } = history(home);
    const target = ids['rendered 3333333333333333 2026-10-01'] as string;
    const { rowid } = app.kernel.db.prepare(`SELECT rowid FROM envelopes WHERE envelope_id = ?`).get(target) as { rowid: number };
    await compact(home, app);
    app.kernel.db.prepare(`INSERT INTO envelopes (rowid, envelope_id, step_key, idx, type, body) VALUES (?, 'other', 'other-step', 0, 'X@1', '{}')`).run(rowid);
    const r = await restoreSegment(app, { archiveDir: join(home, 'archive'), segment: segmentOf(home), now: NOW });
    expect(r.stepsConflicting).toBe(1);
    expect(app.kernel.db.prepare(`SELECT envelope_id FROM envelopes WHERE rowid = ?`).get(rowid)).toEqual({ envelope_id: 'other' });
    expect(app.kernel.db.prepare(`SELECT COUNT(*) AS n FROM envelopes WHERE envelope_id = ?`).get(target)).toEqual({ n: 0 });
    app.close();
  });
});

describe('restore keeps the original order, and the readers never depend on rowid', () => {
  /** history plus gigs, whose newest Gig@1 and GigRendered@1 are read by gigExtras */
  const withGigs = (home: string) => {
    const h = history(home);
    const { app } = h;
    const k = app.kernel;
    // job 2 is a contract job: contractPostings returns its newest Posting@1
    k.db.prepare(`UPDATE jobs SET reasons = '["employment:contract"]' WHERE job_key = '2222222222222222'`).run();
    k.db.prepare(`INSERT INTO gigs (gig_key, dedupe_key, platform, source_id, url, title, client, kind, budget, hours, first_seen, last_seen) VALUES ('g1', 'd', 'freelancer', '1', 'https://x.test', 'T', '{}', 'gig', '{}', '{}', 'a', 'a')`).run();
    k.db.prepare(`INSERT INTO gig_docs (gig_key, kind, format, path, sha256) VALUES ('g1', 'proposal', 'txt', 'g1/proposal.txt', 'aa')`).run();
    for (const [i, runId] of ['freelance-2026-09-01-am', 'freelance-2026-09-02-am', 'freelance-2026-10-13-am'].entries()) {
      k.startRun(runId, 'jobpilot-freelance@1.0.0', 'p', `2026-09-0${i + 1}T01:30:00.000Z`);
      if (i < 2) {
        const input = env(`gig-input-${i}`, 0, 'GigRequest@1', { i });
        k.putSeed(input.stepKey, input, '1.0.0', 'h');
        doneStep(app, runId, 'gig-normalizer', input, [{ type: 'Gig@1', payload: { gigKey: 'g1', v: i } }]);
        doneStep(app, runId, 'gig-renderer', env(`x-${i}`, 0, 'GigPlan@1', {}), [{ type: 'GigRendered@1', payload: { gigKey: 'g1', files: [{ path: 'g1/proposal.txt', sha256: 'aa' }], v: i } }]);
      }
      k.finishRun(runId, `2026-09-0${i + 1}T02:00:00.000Z`);
    }
    return h;
  };
  const readers = (app: AppStore) => JSON.stringify({
    postings: app.contractPostings('2026-09-01T00:00:00.000Z'),
    gigs: app.gigExtras(['g1']),
    plans: ['1111111111111111', '2222222222222222', '3333333333333333'].map((k) => app.renderedPlanOf(k)),
  });

  it('contractPostings, gigExtras and renderedPlanOf answer the same before compaction and after restore; rowids are the originals', async () => {
    const home = newHome();
    const { app } = withGigs(home);
    const before = readers(app);
    expect(JSON.parse(before).postings.postings).toEqual([{ jobKey: '2222222222222222', posting: { jobKey: '2222222222222222', date: '2026-10-02' } }]);
    const rowids = app.kernel.db.prepare(`SELECT rowid, envelope_id FROM envelopes ORDER BY rowid`).all();
    const p = plan(app, false, { version: 1, keep: { daily: 1, freelance: 1, coverage: 1, rebuild: 1 } });
    await compact(home, app, p);
    await restoreSegment(app, { archiveDir: join(home, 'archive'), segment: segmentOf(home), now: NOW });
    expect(readers(app)).toBe(before);
    expect(app.kernel.db.prepare(`SELECT rowid, envelope_id FROM envelopes ORDER BY rowid`).all()).toEqual(rowids);
    app.close();
  });

  it('the newest Posting@1 and Gig@1 are the newest by their step_done event, whatever the rowids say', () => {
    const home = newHome();
    const { app, ids } = withGigs(home);
    const before = readers(app);
    // move the OLDEST versions to the highest rowids: a rowid-ordered reader would now pick them
    const old = [ids['posting 2222222222222222 2026-10-01'] as string];
    const gigOld = (app.kernel.db.prepare(`SELECT envelope_id FROM envelopes WHERE type IN ('Gig@1', 'GigRendered@1') AND json_extract(body, '$.payload.v') = 0`).all() as { envelope_id: string }[]).map((r) => r.envelope_id);
    for (const id of [...old, ...gigOld]) app.kernel.db.prepare(`UPDATE envelopes SET rowid = (SELECT MAX(rowid) FROM envelopes) + 1 WHERE envelope_id = ?`).run(id);
    expect(readers(app)).toBe(before);
    // and compaction pins what the readers return, not what the rowids say
    const a = archived(plan(app, false, { version: 1, keep: { daily: 1, freelance: 1, coverage: 1, rebuild: 1 } }));
    expect(a.has(ids['posting 2222222222222222 2026-10-02'] as string)).toBe(false);
    expect(a.has(old[0] as string)).toBe(true);
    const gigNew = (app.kernel.db.prepare(`SELECT envelope_id FROM envelopes WHERE type IN ('Gig@1', 'GigRendered@1') AND json_extract(body, '$.payload.v') = 1`).all() as { envelope_id: string }[]).map((r) => r.envelope_id);
    for (const id of gigNew) expect(a.has(id), id).toBe(false);
    app.close();
  });
});

describe('orphan segments, names, the chain and the manifest', () => {
  it('restore --all skips and reports a segment with no chain event, and restores the others', async () => {
    const home = newHome();
    const { app } = history(home);
    await compact(home, app);
    app.close();
    const seg = segmentOf(home);
    const orphan = seg.replace('.jsonl.gz', '-9.jsonl.gz');
    copyFileSync(join(home, 'archive', seg), join(home, 'archive', orphan));
    copyFileSync(join(home, 'archive', `${seg}.manifest.json`), join(home, 'archive', `${orphan}.manifest.json`));
    const out: string[] = [];
    const err: string[] = [];
    expect(await storeRestoreCommand({ home, clock, out: (l) => out.push(l), err: (l) => err.push(l), all: true })).toBe(0);
    expect(err.join('\n')).toContain(`skipped ${orphan}: no store.compacted event in the audit chain`);
    expect(out.join('\n')).toContain(`restored ${seg}`);
  });

  it('compaction removes orphan segments and .tmp files an interrupted compaction left, and never reuses a name', async () => {
    const home = newHome();
    const { app } = history(home);
    const first = await compact(home, app, plan(app, false, { version: 1, keep: { daily: 3, freelance: 1, coverage: 1, rebuild: 1 } }));
    // leftovers of a crash: a segment written but never recorded, and a temp file
    writeFileSync(join(home, 'archive', 'envelopes-20261014T060000Z-s9999.jsonl.gz'), 'x');
    writeFileSync(join(home, 'archive', 'envelopes-20261014T060000Z-s9999.jsonl.gz.manifest.json'), '{}');
    writeFileSync(join(home, 'archive', 'envelopes-20261014T060001Z-s1.jsonl.gz.tmp'), 'x');
    const second = await compact(home, app, plan(app, false, { version: 1, keep: { daily: 1, freelance: 1, coverage: 1, rebuild: 1 } }));
    expect(second.segment).not.toBe(first.segment);
    expect(readdirSync(join(home, 'archive')).sort()).toEqual([first.segment, `${first.segment}.manifest.json`, second.segment, `${second.segment}.manifest.json`].sort());
    expect(second.removedOrphans).toEqual(['envelopes-20261014T060000Z-s9999.jsonl.gz', 'envelopes-20261014T060000Z-s9999.jsonl.gz.manifest.json', 'envelopes-20261014T060001Z-s1.jsonl.gz.tmp']);
    app.close();
  });

  it('restore refuses while the audit chain does not verify (it does not trust an event in a broken chain)', async () => {
    const home = newHome();
    const { app } = history(home);
    await compact(home, app);
    app.kernel.db.prepare(`UPDATE events SET data = '{"x":1}' WHERE seq = 2`).run();
    const before = tableDump(app);
    await expect(restoreSegment(app, { archiveDir: join(home, 'archive'), segment: segmentOf(home), now: NOW })).rejects.toThrow(/the audit chain does not verify \(at event 2/);
    expect(tableDump(app)).toBe(before);
    app.close();
  });

  it('a missing manifest is a clear refusal', async () => {
    const home = newHome();
    const { app } = history(home);
    await compact(home, app);
    rmSync(join(home, 'archive', `${segmentOf(home)}.manifest.json`));
    await expect(restoreSegment(app, { archiveDir: join(home, 'archive'), segment: segmentOf(home), now: NOW })).rejects.toThrow(/has no manifest/);
    app.close();
  });

  it('Q9: a segment and manifest both rewritten to agree with each other are still refused by the chain event', async () => {
    const home = newHome();
    const { app } = history(home);
    await compact(home, app);
    const seg = segmentOf(home);
    const path = join(home, 'archive', seg);
    const forged = gzipSync(gunzipSync(readFileSync(path)).toString('utf8').replace('"normalizer"', '"normaliser"'));
    writeFileSync(path, forged);
    const mpath = `${path}.manifest.json`;
    const m = JSON.parse(readFileSync(mpath, 'utf8')) as { sha256: string };
    const { createHash } = await import('node:crypto');
    writeFileSync(mpath, JSON.stringify({ ...m, sha256: createHash('sha256').update(forged).digest('hex') }));
    await expect(restoreSegment(app, { archiveDir: join(home, 'archive'), segment: seg, now: NOW })).rejects.toThrow(/does not match its chain event/);
    app.close();
  });
});

describe('compaction guards the review found untested', () => {
  it('Q8: a segment that reads back with other bytes (same rows) is refused before anything is removed', async () => {
    const home = newHome();
    const { app } = history(home);
    const before = tableDump(app);
    const recompress = (path: string): void => writeFileSync(path, gzipSync(gunzipSync(readFileSync(path)), { level: 1 }));
    await expect(compact(home, app, plan(app), { beforeVerify: recompress })).rejects.toThrow(/did not read back as written/);
    expect(tableDump(app)).toBe(before);
    expect(app.kernel.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = ?`).get(COMPACTED_EVENT)).toEqual({ n: 0 });
    app.close();
  });

  it('Q7: --include-incomplete never archives an unclosed coverage run, even an old one; a closed one goes', () => {
    const home = newHome();
    const { app } = history(home);
    const k = app.kernel;
    const runId = 'coverage-2026-09-06';
    k.startRun(runId, 'jobpilot-coverage@1.0.0', 'p', '2026-09-06T01:00:00.000Z');
    const seed = env(`seed-${runId}`, 0, 'CoverageRequest@1', { runDate: '2026-09-06' });
    k.putSeed(seed.stepKey, seed, '1.0.0', 'h');
    k.enqueue(`${runId}.seed`, 0, 'coverage-seed', seed.envelopeId);
    expect(plan(app, true).incomplete).toContainEqual({ runId, pinned: true });
    expect(archived(plan(app, true)).has(seed.envelopeId)).toBe(false);
    k.appendEvent(runId, NOW, 'coverage.closed', { status: 'incomplete' }, 'p');
    expect(plan(app, true).incomplete).toContainEqual({ runId, pinned: false });
    expect(archived(plan(app, true)).has(seed.envelopeId)).toBe(true);
    app.close();
  });

  it('Q10: runs of a pipeline the policy does not name are never archived, however old', () => {
    const home = newHome();
    const { app } = history(home);
    const k = app.kernel;
    k.startRun('demo-run-1', 'jobpilot-demo@1.0.0', 'p', '2020-01-01T00:00:00.000Z');
    const seed = env('seed-demo', 0, 'Demo@1', {});
    k.putSeed(seed.stepKey, seed, '1.0.0', 'h');
    const [out] = doneStep(app, 'demo-run-1', 'demo-agent', seed, [{ type: 'DemoOut@1', payload: {} }]) as [Envelope];
    k.finishRun('demo-run-1', '2020-01-01T00:10:00.000Z');
    const p = plan(app);
    expect(p.keptRuns).toContain('demo-run-1');
    expect(archived(p).has(out.envelopeId)).toBe(false);
    app.close();
  });
});

describe('the CLI output', () => {
  it('restore reports skipped steps', async () => {
    const home = newHome();
    const { app, ids } = history(home);
    const S = stepOf(app, ids['posting 3333333333333333 2026-10-01'] as string);
    await compact(home, app);
    app.kernel.markRunning({ stepKey: S.key, agentId: S.row.agent_id, version: '1.0.0', contractHash: 'h', inputEnvelopeId: S.row.input_envelope_id });
    app.close();
    const out: string[] = [];
    expect(await storeRestoreCommand({ home, clock, out: (l) => out.push(l), err: (l) => out.push(l), all: true })).toBe(0);
    expect(out.join('\n')).toMatch(/1 steps skipped: re-made since/);
    expect(existsSync(join(home, 'archive'))).toBe(true);
    void storeCompactCommand;
  });
});
