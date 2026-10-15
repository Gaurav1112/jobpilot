import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '../../..');
const cli = (args: readonly string[], env: Record<string, string>) =>
  spawnSync(process.execPath, ['--import', 'tsx', join(repo, 'src/bin.ts'), ...args], { cwd: repo, encoding: 'utf8', input: '', timeout: 60_000, env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env } });

/** Every leaf command path, from the --help trees. */
function leaves(path: string[] = []): string[][] {
  const out = cli([...path, '--help'], {}).stdout;
  const at = out.indexOf('Commands:');
  if (at < 0) return [path];
  const subs = out.slice(at).split('\n').slice(1).map((l) => /^ {2}([a-z][a-z0-9-]*)\b/u.exec(l)?.[1]).filter((n): n is string => n !== undefined && n !== 'help');
  return subs.flatMap((s) => leaves([...path, s]));
}

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'jobpilot-cliprof-'));
  mkdirSync(join(root, 'profiles', 'asha'), { recursive: true });
  cpSync(join(repo, 'tests/fixtures/pack'), join(root, 'profiles', 'asha', 'pack'), { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('--profile', () => {
  it('every leaf command outside the profile group documents --profile', () => {
    const missing = leaves().filter((p) => p[0] !== 'profile').filter((p) => !cli([...p, '--help'], {}).stdout.includes('--profile <id>'));
    expect(missing).toEqual([]);
  }, 300_000);
  it('pack check reads the named profile', () => {
    const r = cli(['pack', 'check', '--profile', 'asha'], { JOBPILOT_ROOT: root });
    expect(r.stdout).toContain(`pack ok: ${join(root, 'profiles', 'asha', 'pack')}`);
    expect(r.status).toBe(0);
  });
  it('a profile that does not exist stops before the command, exit 2', () => {
    const r = cli(['pack', 'check', '--profile', 'sam'], { JOBPILOT_ROOT: root });
    expect(r.stderr).toContain('error: no profile sam in');
    expect(r.status).toBe(2);
  });
  it('--profile with JOBPILOT_HOME is refused', () => {
    const r = cli(['pack', 'check', '--profile', 'asha'], { JOBPILOT_HOME: join(root, 'profiles', 'asha') });
    expect(r.stderr).toContain('--profile cannot be combined with JOBPILOT_HOME');
    expect(r.status).toBe(2);
  });
  it('without --profile and with JOBPILOT_HOME the command is exactly as before', () => {
    const r = cli(['pack', 'check'], { JOBPILOT_HOME: join(root, 'profiles', 'asha') });
    expect(r.stdout).toContain(`pack ok: ${join(root, 'profiles', 'asha', 'pack')}`);
  });
});
