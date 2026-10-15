import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bumpCode, doctor, type GitRun } from '../../src/app/hosted/cli.js';
import { HostedConfig } from '../../src/app/hosted/config.js';
import { dirGitHub } from '../../src/app/hosted/github-dir.js';
import { seedAndPublish } from '../../src/app/hosted/seed.js';
import { buildHostedHome } from '../support/hosted-home.js';

const root = mkdtempSync(join(tmpdir(), 'jp-hcli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const repoRoot = join(import.meta.dirname, '../..');
const KEY = randomBytes(32);
const SEED_AT = '2026-11-01T01:30:00.000Z';
const SHA = 'c'.repeat(40);
const REPO = 'example-user/jobpilot-data';
const ghDir = join(root, 'gh');
const home = join(root, 'jphome');
const defaultHome = join(root, 'default-home');

const cli = (args: string[], env: Record<string, string> = {}): { status: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(repoRoot, 'src/bin.ts'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: root,
      VITEST: 'true',
      JOBPILOT_HOME: home,
      JOBPILOT_HOSTED_DEFAULT_HOME: defaultHome,
      JOBPILOT_RUN_ENV: 'hosted',
      JOBPILOT_SECRET_HOSTED_STATE_KEY: KEY.toString('base64'),
      ...env,
    },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

beforeAll(async () => {
  const mac = join(root, 'mac');
  buildHostedHome(mac, SEED_AT);
  const out = await seedAndPublish({
    gh: dirGitHub(ghDir, { now: () => SEED_AT }),
    key: KEY,
    from: mac,
    work: join(root, 'seed-work'),
    now: SEED_AT,
    codeSha: SHA,
    state: HostedConfig.shape.state.parse({ keepGenerations: 5, keepWeekly: 2, archiveDays: 30, warnCompressedMB: 100, hardCompressedMB: 200 }),
  });
  expect(out.ok).toBe(true);
}, 120_000);

describe('the hosted command group', () => {
  it('hosted run refuses outside a hosted environment', () => {
    const r = cli(['hosted', 'run', 'daily'], { JOBPILOT_RUN_ENV: '' });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/run environment must be hosted/);
  });

  it('hosted run refuses a check-only flag on GitHub Actions', () => {
    const r = cli(['hosted', 'run', 'daily', '--github-dir', ghDir], { GITHUB_ACTIONS: 'true' });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/check-only flag/);
  });

  it('hosted pull refuses the default home', () => {
    const r = cli(['hosted', 'pull', '--to', defaultHome, '--repo', REPO, '--github-dir', ghDir]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/refusing to write the default home/);
  });

  it('hosted status prints gen 1 of a seeded backend', () => {
    const r = cli(['hosted', 'status', '--repo', REPO, '--github-dir', ghDir]);
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^gen 1 /m);
    expect(r.out).toMatch(/lease: none/);
    expect(r.out).toMatch(/ledger \(last 5\)/);
  });

  it('hosted verify --all --out writes verify-g000001.json with ok: true', () => {
    const out = join(root, 'verify-out');
    const r = cli(['hosted', 'verify', '--repo', REPO, '--all', '--out', out, '--github-dir', ghDir]);
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/gen 1: ok/);
    const rec = JSON.parse(readFileSync(join(out, 'verify-g000001.json'), 'utf8')) as { ok: boolean; gen: number };
    expect(rec).toMatchObject({ ok: true, gen: 1 });
  }, 120_000);

  it('hosted verify needs exactly one of --gen and --all', () => {
    expect(cli(['hosted', 'verify', '--repo', REPO, '--github-dir', ghDir]).status).toBe(1);
  });

  it('hosted pull into a new folder works and says to copy the pack', () => {
    const to = join(root, 'pulled');
    const r = cli(['hosted', 'pull', '--to', to, '--repo', REPO, '--github-dir', ghDir]);
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/generation 1 pulled/);
    expect(r.out).toMatch(/copy your pack into .*pack/);
  }, 120_000);

  it('hosted bump with a non-ancestor sha exits 1 and writes nothing', () => {
    const data = join(root, 'bump-data');
    const r = cli(['hosted', 'bump', '--data', data, '--sha', 'd'.repeat(40)]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/not an ancestor/);
    expect(() => readFileSync(join(data, 'code.lock'))).toThrow();
  });

  it('a malformed --repo is a usage error', () => {
    expect(cli(['hosted', 'status', '--repo', 'nonsense', '--github-dir', ghDir]).status).toBe(1);
  });
});

describe('bumpCode', () => {
  const git = (ancestor: boolean, head = SHA): GitRun => (args) => {
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${head}\n` };
    return { status: ancestor ? 0 : 1, stdout: '' };
  };
  it('writes code.lock for an ancestor (default: origin/main)', () => {
    const data = join(root, 'bump-ok');
    expect(bumpCode({ data, root: repoRoot, git: git(true) })).toBe(SHA);
    expect(readFileSync(join(data, 'code.lock'), 'utf8')).toBe(`${SHA}\n`);
  });
  it('refuses a non-ancestor', () => {
    const data = join(root, 'bump-no');
    expect(() => bumpCode({ data, sha: 'e'.repeat(40), root: repoRoot, git: git(false) })).toThrow(/not an ancestor/);
    expect(() => readFileSync(join(data, 'code.lock'))).toThrow();
  });
});

describe('doctor', () => {
  const data = join(root, 'doctor-data');
  const yaml = [
    'version: 1', 'owner: example-user', 'view: {repo: jobpilot-view, url: "https://example-user.github.io/jobpilot-view/"}',
    'budget: {monthlyMinutes: 2000, safetyMinutes: 100, cycleStartDay: 1, dailyEstimateMinutes: 60}', 'freelance: {windows: [am]}',
    'coverage: {everyWeeks: 2, anchor: "2026-11-01", maxSliceMinutes: 300, endBy: "06:30"}',
    'state: {keepGenerations: 5, keepWeekly: 2, archiveDays: 30, warnCompressedMB: 100, hardCompressedMB: 200}',
    'snapshot: {budgetMB: 20, staleHours: 48}', 'skipSources: []', '',
  ].join('\n');
  const facts = (f: object): void => writeFileSync(join(root, 'doctor-gh', 'facts.json'), JSON.stringify(f));
  const git: GitRun = () => ({ status: 0, stdout: '' });
  beforeAll(() => {
    spawnSync('mkdir', ['-p', data, join(root, 'doctor-gh')]);
    writeFileSync(join(data, 'hosted.yaml'), yaml);
    writeFileSync(join(data, 'code.lock'), `${SHA}\n`);
    spawnSync('mkdir', ['-p', join(data, '.github/workflows')]);
    writeFileSync(join(data, '.github/workflows/daily.yml'), readFileSync(join(repoRoot, 'examples/hosted/daily.yml'), 'utf8'));
  });

  it('passes a good setup, warns on absent Gmail secrets and prints the two reminders', async () => {
    facts({ private: true, defaultWorkflowPermissions: 'read', secretNames: ['STATE_KEY', 'PACK_KEY'] });
    const r = await doctor({ gh: dirGitHub(join(root, 'doctor-gh')), data, root: repoRoot, git });
    expect(r.failed).toBe(false);
    expect(r.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(r.lines.filter((l) => l.startsWith('WARN')).length).toBe(3);
    expect(r.lines.filter((l) => l.startsWith('REMINDER')).length).toBe(2);
  });

  it('lints <data>/.github/workflows/daily.yml and fails on a push trigger', async () => {
    facts({ private: true, defaultWorkflowPermissions: 'read', secretNames: ['STATE_KEY', 'PACK_KEY'] });
    const example = readFileSync(join(repoRoot, 'examples/hosted/daily.yml'), 'utf8');
    const wf = join(data, '.github/workflows');
    try {
      const good = await doctor({ gh: dirGitHub(join(root, 'doctor-gh')), data, root: repoRoot, git });
      expect(good.failed).toBe(false);
      expect(good.lines).toContain('PASS workflow lint');
      writeFileSync(join(wf, 'daily.yml'), example.replace('  workflow_dispatch: {}\n', '  workflow_dispatch: {}\n  push: {}\n'));
      const bad = await doctor({ gh: dirGitHub(join(root, 'doctor-gh')), data, root: repoRoot, git });
      expect(bad.failed).toBe(true);
      expect(bad.lines.filter((l) => l.startsWith('FAIL')).join('\n')).toMatch(/workflow lint: .*push/);
    } finally {
      writeFileSync(join(wf, 'daily.yml'), example);
    }
  });

  it('fails a public repo, write permissions, a missing key secret and a non-ancestor code.lock', async () => {
    facts({ private: false, defaultWorkflowPermissions: 'write', secretNames: ['STATE_KEY'] });
    const r = await doctor({ gh: dirGitHub(join(root, 'doctor-gh')), data, root: repoRoot, git: () => ({ status: 1, stdout: '' }) });
    expect(r.failed).toBe(true);
    const fails = r.lines.filter((l) => l.startsWith('FAIL'));
    expect(fails.length).toBe(4);
    expect(fails.join('\n')).toMatch(/private/);
    expect(fails.join('\n')).toMatch(/PACK_KEY/);
  });
});
