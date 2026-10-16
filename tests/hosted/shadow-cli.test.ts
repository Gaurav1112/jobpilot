import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirGitHub } from '../../src/app/hosted/github-dir.js';
import { buildShadowFixture } from '../support/shadow-fixture.js';

const root = mkdtempSync(join(tmpdir(), 'jp-shcli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const repoRoot = join(import.meta.dirname, '../..');
const GOLD = join(repoRoot, 'tests', 'fixtures', 'hosted', 'shadow');
const REPO = 'example-user/jobpilot-data';
const fx = join(root, 'fx');
const ghDir = join(root, 'gh');

const cli = (args: string[]): { status: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(repoRoot, 'src/bin.ts'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: { PATH: process.env['PATH'] ?? '', HOME: root, VITEST: 'true' },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const compare = (over: Partial<Record<'mac' | 'hosted' | 'ledger' | 'verify' | 'out', string>> = {}, extra: string[] = []) =>
  cli([
    'shadow', 'compare',
    '--mac', over.mac ?? join(fx, 'mac'),
    '--hosted', over.hosted ?? join(fx, 'hosted'),
    '--ledger', over.ledger ?? join(fx, 'ledger'),
    '--verify', over.verify ?? join(fx, 'verify'),
    '--from', '2026-11-02',
    '--out', over.out ?? join(root, 'out'),
    ...extra,
  ]);

beforeAll(() => {
  buildShadowFixture(fx);
});

describe('shadow compare', () => {
  it('writes the golden report and prints FAIL (C3) with exit 0', () => {
    const r = compare();
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(r.out.trim()).toBe('side-by-side 2026-11-02: FAIL (C3)');
    expect(readFileSync(join(root, 'out', 'report-2026-11-02.md'), 'utf8')).toBe(readFileSync(join(GOLD, 'report-base.md'), 'utf8'));
    expect(readFileSync(join(root, 'out', 'report-2026-11-02.json'), 'utf8')).toBe(readFileSync(join(GOLD, 'report-base.json'), 'utf8'));
  }, 120_000);

  it('run twice gives identical bytes', () => {
    const a = join(root, 'out-a');
    const b = join(root, 'out-b');
    expect(compare({ out: a }, ['--days', '7']).status).toBe(0);
    expect(compare({ out: b }).status).toBe(0);
    for (const f of readdirSync(a)) expect(readFileSync(join(a, f))).toEqual(readFileSync(join(b, f)));
    expect(readdirSync(a).sort()).toEqual(['report-2026-11-02.json', 'report-2026-11-02.md']);
  }, 120_000);

  it('a missing folder exits 1 and names it', () => {
    const r = compare({ hosted: join(root, 'no-such-hosted') });
    expect(r.status).toBe(1);
    expect(r.err).toContain('no-such-hosted');
  }, 120_000);

  it('a malformed file exits 1 and names it', () => {
    const bad = join(root, 'bad');
    buildShadowFixture(bad);
    writeFileSync(join(bad, 'ledger', 'broken.jsonl'), '{not json\n');
    const l = compare({ ledger: join(bad, 'ledger') });
    expect(l.status).toBe(1);
    expect(l.err).toContain('broken.jsonl');
    writeFileSync(join(bad, 'verify', 'verify-g000099.json'), '{"v":1}');
    const v = compare({ verify: join(bad, 'verify') });
    expect(v.status).toBe(1);
    expect(v.err).toContain('verify-g000099.json');
  }, 120_000);
});

describe('shadow push', () => {
  it('writes the files under shadow/mac at a new state head and leaves the pointer', async () => {
    const gh = dirGitHub(ghDir, { now: () => '2026-11-09T01:00:00.000Z' });
    const before = await gh.initState('init');
    const r = cli(['shadow', 'push', '--repo', REPO, '--dir', join(fx, 'mac'), '--to', 'shadow/mac', '--github-dir', ghDir]);
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    const after = await gh.readState();
    expect(after?.commit).not.toBe(before.commit);
    expect(after?.pointer).toEqual(before.pointer);
    const name = '2026-11-02-daily.json';
    expect(await gh.readStateFile(`shadow/mac/${name}`)).toBe(readFileSync(join(fx, 'mac', name), 'utf8'));
    expect(await gh.readStateFile('shadow/mac/2026-11-08-freelance.json')).not.toBeNull();
  }, 120_000);

  it('a report folder goes under shadow/, and a bad --to or empty dir exits 1', async () => {
    const r = cli(['shadow', 'push', '--repo', REPO, '--dir', join(root, 'out'), '--to', 'shadow', '--github-dir', ghDir]);
    expect(r.status).toBe(0);
    const gh = dirGitHub(ghDir, { now: () => '2026-11-09T01:00:00.000Z' });
    expect(await gh.readStateFile('shadow/report-2026-11-02.md')).not.toBeNull();
    expect(cli(['shadow', 'push', '--repo', REPO, '--dir', join(root, 'out'), '--to', 'elsewhere', '--github-dir', ghDir]).status).toBe(1);
    const empty = join(root, 'empty');
    mkdirSync(empty);
    expect(cli(['shadow', 'push', '--repo', REPO, '--dir', empty, '--to', 'shadow', '--github-dir', ghDir]).status).toBe(1);
  }, 120_000);
});
