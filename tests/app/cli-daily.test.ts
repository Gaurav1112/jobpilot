import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCK_FILE } from '../../src/app/lock.js';
import { resolvePdftotext } from '../../src/app/kernel.js';

const root = join(import.meta.dirname, '../..');
let home: string;
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/bin.ts'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, JOBPILOT_HOME: home } });
const hasPdftotext = (() => {
  try {
    resolvePdftotext();
    return true;
  } catch {
    return false;
  }
})();

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'jobpilot-cli-daily-'));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('jobpilot daily commands', () => {
  it('lists the commands in --help', () => {
    const r = cli('--help');
    expect(r.status).toBe(0);
    for (const c of ['run', 'pack', 'migrate', 'facts', 'docs']) expect(r.stdout).toMatch(new RegExp(`^  ${c}\\b`, 'm'));
  });

  it('migrate desk refuses without the pack naming rules', () => {
    const r = cli('migrate', 'desk', join(root, 'tests/fixtures/desk'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/naming\.yaml/);
    expect(existsSync(join(home, 'jobpilot.db'))).toBe(false);
  });

  it('pack check validates the pack and prints its hash, or fails naming the problem', () => {
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    // no careers entry: the careers agents are left out of this home's pipeline
    const watch = readFileSync(join(home, 'pack/watchlist.yaml'), 'utf8').split('\n').filter((l) => !l.includes('ats: careers')).join('\n');
    writeFileSync(join(home, 'pack/watchlist.yaml'), watch);
    writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: [himalayas, remoteok]\n');
    const unknown = cli('pack', 'check');
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/feeds\.yaml: unknown feed remoteok \(known: himalayas, jobicy\)/);
    writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: [himalayas]\n');
    const ok = cli('pack', 'check');
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^pack hash [0-9a-f]{64}$/m);

    writeFileSync(join(home, 'pack/policy.user.yaml'), 'minHostIntervalMs: 40000\n');
    const slow = cli('pack', 'check');
    expect(slow.status).toBe(1);
    expect(slow.stderr).toMatch(/minHostIntervalMs 40000 ms breaks the src-greenhouse timeout arithmetic/);
    // a run that cannot start exits 2 (and would post `jobpilot run failed: …`)
    const cannot = cli('run', '--offline-fixtures', join(root, 'tests/fixtures/e2e'), '--no-notify');
    expect(cannot.status).toBe(2);
    expect(cannot.stderr).toMatch(/minHostIntervalMs 40000 ms breaks/);
    writeFileSync(join(home, 'pack/policy.user.yaml'), 'maxUsdPerRun: 1\n');
    expect(cli('pack', 'check').status).toBe(0);
  });

  it('facts list, verify and reject write fact overrides', () => {
    const before = cli('facts', 'list');
    expect(before.status).toBe(0);
    expect(before.stdout).toMatch(/^f-nw-05\s+derived-unverified\s/m);
    const v = cli('facts', 'verify', 'f-nw-05');
    expect(v.status).toBe(0);
    expect(v.stdout).toContain('f-nw-05: derived-unverified -> verified');
    expect(cli('facts', 'list').stdout).toMatch(/^f-nw-05\s+verified \(override\)\s/m);
    const bad = cli('facts', 'reject', 'no-such-fact');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/unknown fact no-such-fact/);
  });

  it.skipIf(!hasPdftotext)('run --offline-fixtures prints the summary; a held lock refuses; docs rebuild re-renders', () => {
    const r = cli('run', '--offline-fixtures', join(root, 'tests/fixtures/e2e'), '--no-notify');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^run daily-\d{4}-\d{2}-\d{2} for /m);
    expect(r.stdout).toMatch(/^agent\s+done\s+replayed\s+failed\s+gone\s+rejected\s+skipped\s+quarantined$/m);
    expect(r.stdout).toMatch(/^renderer\s+2\s+0\s+0\s+0\s+0\s+0\s+0$/m);
    expect(r.stdout).toContain('notification: 2 new matches · top: 94 Example Lever Co — Staff Platform Engineer');
    const again = cli('run', '--offline-fixtures', join(root, 'tests/fixtures/e2e'), '--no-notify');
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('warning: All sources were already fetched today; use --refresh to fetch again');
    expect(r.stdout).not.toMatch(/src-careers/);

    writeFileSync(join(home, LOCK_FILE), JSON.stringify({ pid: process.pid, command: 'run', at: 'now' }));
    const locked = cli('run', '--offline-fixtures', join(root, 'tests/fixtures/e2e'), '--no-notify');
    expect(locked.status).toBe(2);
    expect(locked.stderr).toMatch(/another jobpilot process \(pid \d+, run\) holds/);
    rmSync(join(home, LOCK_FILE));

    expect(cli('docs', 'rebuild', '0123456789abcdef').status).not.toBe(0);
    const rb = cli('docs', 'rebuild');
    expect(rb.stderr).toBe('');
    expect(rb.status).toBe(0);
    expect(rb.stdout).toMatch(/rebuilt from daily-/);
    expect(rb.stdout).toMatch(/^qa-gate\s+2\s+2\s/m);
    expect(rb.stdout).toMatch(/^documents rebuilt: 2 jobs$/m);
    expect(rb.stdout).not.toMatch(/^src-/m);

    const m = cli('migrate', 'desk', join(root, 'tests/fixtures/desk'));
    expect(m.stderr).toBe('');
    expect(m.status).toBe(0);
    expect(m.stdout).toMatch(/"read": \d+/);
  }, 120_000);
});
