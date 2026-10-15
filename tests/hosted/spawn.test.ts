import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { childEnv, GMAIL_ENV_NAMES, spawnPipeline } from '../../src/app/hosted/spawn.js';

const root = mkdtempSync(join(tmpdir(), 'jp-spawn-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fx = (n: string): string => join(import.meta.dirname, '..', 'fixtures', 'hosted', n);

describe('spawnPipeline', () => {
  it('SIGTERMs at the deadline; a child that stops is stopped, not killed, and its output is in the log file', async () => {
    const logFile = join(root, 'logs', 'a.log');
    const r = await spawnPipeline({ argv: [process.execPath, fx('child-stops.mjs')], env: { PATH: process.env['PATH'] ?? '' }, cwd: root, logFile, deadlineAt: Date.now() + 600, graceMs: 5000 });
    expect(r).toMatchObject({ stopped: true, killed: false, exit: 0 });
    expect(readFileSync(logFile, 'utf8')).toContain('stopped');
  });
  it('SIGKILLs a child still alive graceMs after the SIGTERM', async () => {
    const logFile = join(root, 'logs', 'b.log');
    const t0 = Date.now();
    const r = await spawnPipeline({ argv: [process.execPath, fx('child-ignores.mjs')], env: { PATH: process.env['PATH'] ?? '' }, cwd: root, logFile, deadlineAt: Date.now() + 400, graceMs: 300 });
    expect(r).toMatchObject({ stopped: true, killed: true, exit: null });
    expect(Date.now() - t0).toBeLessThan(8000);
  });
  it('a child that ends before the deadline is neither stopped nor killed; its exit code is reported', async () => {
    const r = await spawnPipeline({ argv: [process.execPath, '-e', 'process.exit(2)'], env: {}, cwd: root, logFile: join(root, 'c.log'), deadlineAt: Date.now() + 60_000 });
    expect(r).toMatchObject({ exit: 2, stopped: false, killed: false });
  });
  it('appends to the log file', async () => {
    const logFile = join(root, 'd.log');
    for (const n of [1, 2]) await spawnPipeline({ argv: [process.execPath, '-e', `console.log('line${n}')`], env: {}, cwd: root, logFile, deadlineAt: Date.now() + 60_000 });
    expect(readFileSync(logFile, 'utf8')).toBe('line1\nline2\n');
  });
});

describe('childEnv', () => {
  const base = {
    PATH: '/bin', HOME: '/h', LANG: 'C', TZ: 'UTC', TMPDIR: '/t',
    JOBPILOT_SECRET_HOSTED_STATE_KEY: 'k1', JOBPILOT_SECRET_HOSTED_PACK_KEY: 'k2', GH_TOKEN: 't1', GITHUB_TOKEN: 't2', AWS_X: 'x',
    JOBPILOT_SECRET_GMAIL_REFRESH: 'g',
  };
  it('keeps no key and no token', () => {
    const e = childEnv(base, '/work/home');
    expect(e).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C', TZ: 'UTC', TMPDIR: '/t', JOBPILOT_HOME: '/work/home', JOBPILOT_RUN_ENV: 'hosted', NODE_NO_WARNINGS: '1' });
  });
  it('adds exactly the extras given', () => {
    const e = childEnv(base, '/work/home', { JOBPILOT_SECRET_GMAIL_CLIENT_ID: 'a', JOBPILOT_SECRET_GMAIL_CLIENT_SECRET: 'b', JOBPILOT_SECRET_GMAIL_REFRESH: 'c' });
    expect(Object.keys(e).filter((k) => k.startsWith('JOBPILOT_SECRET_')).sort()).toEqual([...GMAIL_ENV_NAMES].sort());
    expect(Object.keys(e).some((k) => /TOKEN|AWS|STATE_KEY|PACK_KEY/.test(k))).toBe(false);
  });
  it('omits base variables that are unset', () => {
    expect(childEnv({ PATH: '/bin' }, '/h')).toEqual({ PATH: '/bin', JOBPILOT_HOME: '/h', JOBPILOT_RUN_ENV: 'hosted', NODE_NO_WARNINGS: '1' });
  });
});
