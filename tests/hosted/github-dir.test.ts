import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dirGitHub } from '../../src/app/hosted/github-dir.js';
import { EMPTY_POINTER } from '../../src/app/hosted/pointer.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'jp-ghdir-'));

describe('dirGitHub state', () => {
  it('init gives EMPTY_POINTER; a CAS moves the head and keeps other files; initState twice throws', async () => {
    const gh = dirGitHub(tmp());
    expect(await gh.readState()).toBeNull();
    const init = await gh.initState('init');
    expect(init.pointer).toEqual(EMPTY_POINTER);
    expect((await gh.readState())?.commit).toBe(init.commit);
    await expect(gh.initState('again')).rejects.toThrow();
    const a = await gh.casState(init.commit, { 'ledger.jsonl': 'one\n' }, 'a');
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = await gh.casState(a.commit, { 'other.txt': 'x' }, 'b');
    expect(b.ok).toBe(true);
    expect(await gh.readStateFile('ledger.jsonl')).toBe('one\n');
    expect(await gh.readStateFile('other.txt')).toBe('x');
    expect(await gh.readStateFile('missing')).toBeNull();
    expect((await gh.readState())?.pointer).toEqual(EMPTY_POINTER);
  });

  it('a CAS from a stale parent fails and leaves the head', async () => {
    const gh = dirGitHub(tmp());
    const init = await gh.initState('init');
    const a = await gh.casState(init.commit, { f: '1' }, 'a');
    expect(a.ok).toBe(true);
    expect(await gh.casState(init.commit, { f: '2' }, 'stale')).toEqual({ ok: false });
    expect((await gh.readState())?.commit).toBe(a.ok ? a.commit : '');
    expect(await gh.readStateFile('f')).toBe('1');
  });

  it('two writers race: exactly one wins', async () => {
    const dir = tmp();
    const second = dirGitHub(dir);
    let fired = false;
    const first = dirGitHub(dir, {
      beforeCas: async (parent) => {
        if (fired) return;
        fired = true;
        expect((await second.casState(parent, { who: 'second' }, 'second')).ok).toBe(true);
      },
    });
    const init = await first.initState('init');
    const mine = await first.casState(init.commit, { who: 'first' }, 'first');
    expect(mine).toEqual({ ok: false });
    expect(await first.readStateFile('who')).toBe('second');
  });
});

describe('dirGitHub releases', () => {
  it('create, upload, list size and digest, download identical, delete idempotent', async () => {
    let t = 0;
    const gh = dirGitHub(tmp(), { now: () => new Date(Date.UTC(2026, 9, 15, 0, 0, t++)).toISOString() });
    const src = join(tmp(), 'blob.bin');
    const bytes = Buffer.from([0, 1, 2, 250, 251, 7]);
    writeFileSync(src, bytes);
    expect(await gh.release('g1')).toBeNull();
    await gh.createRelease('g1');
    await gh.createRelease('g2');
    await gh.uploadAsset('g1', src, 'state.jpst');
    const rel = await gh.release('g1');
    expect(rel?.assets).toEqual([{ name: 'state.jpst', size: 6, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }]);
    expect((await gh.listReleases()).map((r) => r.tag)).toEqual(['g2', 'g1']);
    const out = join(tmp(), 'sub', 'back.bin');
    await gh.downloadAsset('g1', 'state.jpst', out);
    expect(readFileSync(out).equals(bytes)).toBe(true);
    await gh.deleteRelease('g1');
    await gh.deleteRelease('g1');
    expect(await gh.release('g1')).toBeNull();
  });
});

describe('dirGitHub issues, runs, facts', () => {
  it('opens, finds by label and title, comments', async () => {
    const gh = dirGitHub(tmp());
    expect(await gh.findOpenIssue('alert', 'Red')).toBeNull();
    const n = await gh.openIssue('Red', 'body', ['alert']);
    expect(await gh.findOpenIssue('alert', 'Red')).toBe(n);
    expect(await gh.findOpenIssue('other', 'Red')).toBeNull();
    await gh.commentIssue(n, 'more');
    await expect(gh.commentIssue(99, 'x')).rejects.toThrow();
  });

  it('reads runs and repo facts', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'runs'));
    const run = (id: string, startedAt: string, log: string): void =>
      writeFileSync(join(dir, 'runs', `${id}.json`), JSON.stringify({ workflow: 'daily.yml', startedAt, log }));
    run('100', '2026-10-13T01:00:00Z', 'log-100');
    run('101', '2026-10-14T01:00:00Z', 'log-101');
    run('102', '2026-10-15T01:00:00Z', 'log-102');
    const gh = dirGitHub(dir);
    expect(await gh.jobStartedAt('101')).toBe('2026-10-14T01:00:00Z');
    expect(await gh.jobStartedAt('9')).toBeNull();
    expect(await gh.previousRunId('daily.yml', '102')).toBe('101');
    expect(await gh.previousRunId('daily.yml', '100')).toBeNull();
    expect(await gh.runLog('100')).toBe('log-100');
    expect(await gh.runLog('7')).toBeNull();
    expect(await gh.repoFacts()).toEqual({ private: true, defaultWorkflowPermissions: 'read', secretNames: [] });
  });
});
