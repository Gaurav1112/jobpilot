import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProfile } from '../../src/app/profiles/commands.js';

const repo = join(import.meta.dirname, '../..');
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jobpilot-privacy-cli-'));
  createProfile({ root, id: 'asha', clock: { now: () => '2026-10-15T08:00:00.000Z' }, fromPack: join(repo, 'tests/fixtures/pack') });
  rmSync(join(root, 'active-profile'), { force: true }); // a root with no active profile: the scan must still read every profile
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const scan = (dir: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, JOBPILOT_ROOT: root };
  delete env['JOBPILOT_HOME'];
  delete env['JOBPILOT_PROFILE'];
  return spawnSync(process.execPath, ['--import', 'tsx', join(repo, 'src/bin.ts'), 'privacy', 'scan', dir], { cwd: repo, env, encoding: 'utf8' });
};

describe('jobpilot privacy scan', () => {
  it('needs no active profile; clean exits 0, a hit exits 1 and never prints the term', () => {
    const dir = join(root, 'repo');
    mkdirSync(dir);
    writeFileSync(join(dir, 'ok.md'), 'nothing here\n');
    const clean = scan(dir);
    expect(clean.stderr).toBe('');
    expect(clean.status).toBe(0);
    expect(clean.stdout).toMatch(/^privacy scan: clean \(1 profiles, \d+ terms\)$/m);
    writeFileSync(join(dir, 'bad.md'), 'ask Asha Rao\n');
    const dirty = scan(dir);
    expect(dirty.status).toBe(1);
    expect(dirty.stdout.trim()).toBe('bad.md (asha, term #2)');
    expect(dirty.stdout).not.toMatch(/asha rao/i);
  }, 60_000);
});

describe('privacy scan takes no --profile', () => {
  it('refuses it rather than silently scanning every profile anyway', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, JOBPILOT_ROOT: root };
    delete env['JOBPILOT_HOME'];
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(repo, 'src/bin.ts'), 'privacy', 'scan', root, '--profile', 'asha'], { cwd: repo, env, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown option '--profile'/);
  }, 60_000);
});

describe('privacy scan fails closed', () => {
  it('a profile whose pack cannot be read exits 2 and names the profile, never "clean"', () => {
    writeFileSync(join(root, 'profiles/asha/pack/contact.yaml'), 'name: [unclosed\n');
    const dir = join(root, 'repo');
    mkdirSync(dir);
    const r = scan(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('privacy scan: asha: contact.yaml does not parse');
    expect(r.stdout).not.toMatch(/clean/);
  }, 60_000);
});
