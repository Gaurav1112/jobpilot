import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

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

  it('rejects a malformed --expect-head', () => {
    const r = cli('audit', 'verify', '--db', db, '--expect-head', 'nonsense');
    expect(r.status).toBe(1);
  }, 30_000);
});
