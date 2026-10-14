import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readCheckpoint } from '../src/app/chain-status.js';
import { AppStore } from '../src/app/store/app-store.js';

const bin = readFileSync(join(import.meta.dirname, '..', 'src', 'bin.ts'), 'utf8');

describe('src/bin.ts: the Node version guard runs before anything is loaded', () => {
  it('has no static import of a non-node: specifier', () => {
    const specs = [...bin.matchAll(/^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specs.filter((s) => !s?.startsWith('node:'))).toEqual([]);
  });

  it('checks the version before importing the CLI', () => {
    const check = bin.indexOf('process.versions.node');
    const load = bin.indexOf("import('./cli.js')");
    expect(check).toBeGreaterThanOrEqual(0);
    expect(load).toBeGreaterThan(check);
  });
});

describe('audit verify', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobpilot-cli-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'jp.db');
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/bin.ts', ...args], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' });

  it('prints the chain head and checks it against --expect-head', () => {
    const demo = cli('demo', '--db', db, '--count', '2', '--run', 'run-1');
    expect(demo.status).toBe(0);

    const ok = cli('audit', 'verify', '--db', db);
    expect(ok.status).toBe(0);
    const m = /^audit chain intact: (\d+) events\nhead ([0-9a-f]+) \((\d+) events\)$/m.exec(ok.stdout);
    expect(m).not.toBeNull();
    const [, n, hash, count] = m as RegExpExecArray;
    expect(count).toBe(n);

    const good = cli('audit', 'verify', '--db', db, '--expect-head', `${hash}:${count}`);
    expect(good.status).toBe(0);
    expect(good.stdout).toContain('audit chain intact');

    const upper = cli('audit', 'verify', '--db', db, '--expect-head', `${hash!.toUpperCase()}:${count}`);
    expect(upper.status).toBe(0);
    expect(upper.stdout).toContain('audit chain intact');

    const bad = cli('audit', 'verify', '--db', db, '--expect-head', 'deadbeef:1');
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('chain head mismatch');
    expect(bad.stdout).toContain('chain head differs from the expected head');
    expect(bad.stdout).not.toContain('BROKEN');
  }, 60_000);

  it('records the verified checkpoint in a jobpilot home database when the full walk passes (dashboard-perf fix 1)', () => {
    const appDb = join(dir, 'app.db');
    const app = AppStore.open(appDb);
    for (let i = 0; i < 3; i++) app.kernel.appendEvent('r', `t${i}`, 'k', { i }, 'p');
    app.close();
    const ok = cli('audit', 'verify', '--db', appDb);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('checkpoint recorded through event 3');
    const s = AppStore.open(appDb);
    try {
      expect(readCheckpoint(s.kernel.db)).toMatchObject({ seq: 3, count: 3 });
      s.kernel.db.prepare(`UPDATE events SET data = '{"i":9}' WHERE seq = 2`).run();
    } finally {
      s.close();
    }
    const bad = cli('audit', 'verify', '--db', appDb);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('BROKEN at event 2');
    expect(bad.stdout).not.toContain('checkpoint recorded');
  }, 60_000);

  it('rejects a malformed --expect-head', () => {
    const r = cli('audit', 'verify', '--db', db, '--expect-head', 'nonsense');
    expect(r.status).toBe(1);
  }, 30_000);
});

describe('contracts export', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobpilot-contracts-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/bin.ts', ...args], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' });

  it('prints a refusal as error: <message> with exit code 1 and no stack', () => {
    const ok = cli('contracts', 'export', '--out', dir);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`wrote ${join(dir, 'demo-source@1.json')}`);
    // The exported 1.0.0 file now records a different egress than the code has at the same version.
    const file = join(dir, 'demo-source@1.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ hash: 'other', shape: { ...doc.shape, egress: ['evil.example'] } }));
    const r = cli('contracts', 'export', '--out', dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe('error: demo-source@1.0.0: egress changed without a version bump; bump the major version before exporting\n');
    expect(r.stdout).toBe('');
  }, 60_000);
});
