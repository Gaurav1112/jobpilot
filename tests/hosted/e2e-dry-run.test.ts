import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/kernel/canonical.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { HostedConfig } from '../../src/app/hosted/config.js';
import { verifyGeneration, type VerifyRecord } from '../../src/app/hosted/generations.js';
import { dirGitHub } from '../../src/app/hosted/github-dir.js';
import { isTemplateLine } from '../../src/app/hosted/log-gateway.js';
import { seedAndPublish } from '../../src/app/hosted/seed.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { spawnPipeline } from '../../src/app/hosted/spawn.js';
import { runHosted, type HostedDeps, type HostedRunOptions } from '../../src/app/hosted/wrapper.js';
import { parse as parseYaml } from 'yaml';

/**
 * Task 20, part A: the hosted wrapper over two simulated days, end to end and offline. A "Mac" home runs the real CLI
 * for both days; a seeded hosted state (directory-backed GitHub) is advanced by `runHosted` with the real child
 * pipelines; then `shadow digest` and `shadow compare` put the two side by side. Fictional pack, fixture boards, fake
 * keys, temp homes only. The Mac home is never written by a `hosted` or `shadow` command.
 */
const repo = join(import.meta.dirname, '..', '..');
const FIXTURES = join(repo, 'tests', 'fixtures', 'freelance-e2e');
const PACK = join(repo, 'tests', 'fixtures', 'pack');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();
if (pdftotext === undefined) console.warn('tests/hosted/e2e-dry-run.test.ts skipped: pdftotext is not installed');

const DAY1 = { date: '2026-11-02', mac: '2026-11-02T02:10:00.000Z', hosted: '2026-11-02T02:07:00.000Z' }; // 07:40 and 07:37 IST
const DAY2 = { date: '2026-11-03', mac: '2026-11-03T02:10:00.000Z', hosted: '2026-11-03T02:07:00.000Z' };
const STATE_KEY = randomBytes(32).toString('base64');
const PACK_KEY = randomBytes(32).toString('base64');
const SHA = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');

const root = mkdtempSync(join(tmpdir(), 'jp-e2e-dry-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const p = (...s: string[]): string => join(root, ...s);

const baseEnv = (): Record<string, string> => ({ PATH: process.env['PATH'] ?? '', HOME: root, TMPDIR: root, VITEST: 'true', NODE_NO_WARNINGS: '1' });
const cli = (args: string[], env: Record<string, string>): { status: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(repo, 'src', 'bin.ts'), ...args], { cwd: repo, encoding: 'utf8', timeout: 240_000, env: { ...baseEnv(), ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const git = (args: readonly string[], cwd: string): { status: number; stdout: string } => {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status ?? 1, stdout: r.stdout };
};

describe.skipIf(pdftotext === undefined)('hosted wrapper, two simulated days, then the side-by-side comparison', () => {
  const mac = p('mac');
  const ghDir = p('gh');
  const data = p('data');
  const work = p('work');
  const lines: string[][] = [];
  let macHashAfterRuns = '';
  let headSha = '';
  let nowIso = DAY1.hosted;
  const clock = { now: (): string => nowIso };
  const gh = dirGitHub(ghDir, { now: () => nowIso });

  const macRun = (at: string, args: string[]): void => {
    const r = cli(args, { JOBPILOT_HOME: mac, JOBPILOT_TEST_NOW: at });
    expect([0, 1], `${args[0]} at ${at}: ${r.err.slice(-400)}`).toContain(r.status);
  };

  const hostedOpts = (runId: string): HostedRunOptions => ({
    pipeline: 'daily',
    dataDir: data,
    codeDir: repo,
    workDir: join(work, `run-${runId}`),
    trigger: 'dispatch',
    runId,
    jobTimeoutMinutes: 150,
    ancestorRef: 'HEAD',
    fetchMain: false,
    offlineFixtures: FIXTURES,
  });
  const hostedDeps = (out: string[]): HostedDeps => ({
    gh,
    clock,
    env: { ...baseEnv(), JOBPILOT_SECRET_HOSTED_STATE_KEY: STATE_KEY, JOBPILOT_SECRET_HOSTED_PACK_KEY: PACK_KEY, GH_TOKEN: 'ghp_fake_token_for_tests' },
    out: (l) => out.push(l),
    git,
    // the real child, with the test clock handed down (honoured under VITEST only) and a deadline that is not in the past
    spawn: (a) => spawnPipeline({ ...a, env: { ...a.env, VITEST: 'true', JOBPILOT_TEST_NOW: nowIso }, deadlineAt: Date.now() + 30 * 60_000 }),
    freeBytes: () => 1e12,
    cli: [process.execPath, '--import', 'tsx', join(repo, 'src', 'bin.ts')],
  });
  const runDay = async (at: string, runId: string): Promise<{ code: 0 | 1; out: string[] }> => {
    nowIso = at;
    const out: string[] = [];
    const code = await runHosted(hostedOpts(runId), hostedDeps(out));
    lines.push(out);
    return { code, out };
  };

  beforeAll(() => {
    headSha = git(['rev-parse', 'HEAD'], repo).stdout.trim();
    // 1. the "Mac": both days, daily then the am freelance window
    cpSync(PACK, join(mac, 'pack'), { recursive: true });
    for (const day of [DAY1, DAY2]) {
      macRun(day.mac, ['run', '--offline-fixtures', FIXTURES, '--no-notify']);
      macRun(day.mac, ['run-freelance', '--windows', 'am', '--offline-fixtures', FIXTURES, '--no-notify']);
    }
    macHashAfterRuns = SHA(join(mac, 'jobpilot.db'));
  }, 480_000);

  it('seeds generation 1, pushes the pack, and the wrapper commits generations 2 and 3 over two days', async () => {
    // 2. a fresh hosted seed
    const seedHome = p('seedhome');
    cpSync(PACK, join(seedHome, 'pack'), { recursive: true });
    AppStore.open(join(seedHome, 'jobpilot.db'), { schema: 'migrate' }).close(); // `facts list` does not create a missing DB
    const state = HostedConfig.shape.state.parse((parseYaml(readFileSync(join(repo, 'examples', 'hosted', 'hosted.yaml'), 'utf8')) as { state: unknown }).state);
    const seeded = await seedAndPublish({ gh, key: Buffer.from(STATE_KEY, 'base64'), from: seedHome, work: p('seedwork'), now: DAY1.hosted, codeSha: headSha, state });
    expect(seeded.ok).toBe(true);
    mkdirSync(data, { recursive: true });
    const push = cli(['hosted', 'pack', 'push', '--pack', PACK, '--data', data], { JOBPILOT_RUN_ENV: 'hosted', JOBPILOT_SECRET_HOSTED_PACK_KEY: PACK_KEY });
    expect(push.status, push.err).toBe(0);
    writeFileSync(join(data, 'code.lock'), `${headSha}\n`);
    cpSync(join(repo, 'examples', 'hosted', 'hosted.yaml'), join(data, 'hosted.yaml'));

    // 3. day 1, day 1 again, day 2
    const first = await runDay(DAY1.hosted, '1001');
    expect(first.code, first.out.join('\n')).toBe(0);
    let head = (await gh.readState())!;
    expect(head.pointer.gen).toBe(2);
    expect(head.pointer.lease).toBeNull();
    const ledger1 = await gh.readStateFile('ledger/2026-11.jsonl');
    expect(JSON.parse((ledger1 ?? '').trim().split('\n').at(-1) as string)).toMatchObject({ runId: '1001', outcome: 'committed' });
    expect(await gh.readStateFile(`shadow/hosted/${DAY1.date}-daily.json`)).not.toBeNull();
    expect(await gh.readStateFile(`shadow/hosted/${DAY1.date}-freelance.json`)).not.toBeNull();
    for (const l of first.out) expect(isTemplateLine(l) || l.startsWith('::add-mask::'), l).toBe(true);

    const again = await runDay('2026-11-02T02:30:00.000Z', '1002');
    expect(again.code, again.out.join('\n')).toBe(0);
    head = (await gh.readState())!;
    expect(head.pointer.gen).toBe(2);
    expect(head.pointer.lease).toBeNull();
    expect(again.out.some((l) => l.startsWith('hosted run daily: nothing owed today'))).toBe(true);
    for (const l of again.out) expect(isTemplateLine(l) || l.startsWith('::add-mask::'), l).toBe(true);

    const second = await runDay(DAY2.hosted, '1003');
    expect(second.code, second.out.join('\n')).toBe(0);
    head = (await gh.readState())!;
    expect(head.pointer.gen).toBe(3);
    expect(head.pointer.lease).toBeNull();
    for (const l of second.out) expect(isTemplateLine(l) || l.startsWith('::add-mask::'), l).toBe(true);

    const recs: VerifyRecord[] = [];
    mkdirSync(p('verify'), { recursive: true });
    for (const r of head.pointer.history) {
      const v = await verifyGeneration(gh, r, Buffer.from(STATE_KEY, 'base64'), root, nowIso);
      expect(v.ok, JSON.stringify(v)).toBe(true);
      recs.push(v);
      writeFileSync(p('verify', `verify-g${String(v.gen).padStart(6, '0')}.json`), `${canonicalJson(v)}\n`);
    }
    expect(recs.map((r) => r.gen).sort()).toEqual([1, 2, 3]);
  }, 900_000);

  it('shadow digest and compare over both days: recall 1.000, every criterion NOT EVALUATED, the Mac DB untouched', async () => {
    // 4. the digests, the ledger, the report
    const macDigests = p('digests-mac');
    const d = cli(['shadow', 'digest', '--home', mac, '--from', DAY1.date, '--days', '2', '--env', 'local', '--out', macDigests, '--code-sha', headSha], {});
    expect(d.status, d.err).toBe(0);
    const hostedDigests = p('digests-hosted');
    mkdirSync(hostedDigests, { recursive: true });
    for (const day of [DAY1, DAY2]) {
      for (const pl of ['daily', 'freelance']) {
        const text = await gh.readStateFile(`shadow/hosted/${day.date}-${pl}.json`);
        expect(text, `${day.date} ${pl}`).not.toBeNull();
        writeFileSync(join(hostedDigests, `${day.date}-${pl}.json`), text as string);
      }
    }
    mkdirSync(p('ledger'), { recursive: true });
    writeFileSync(p('ledger', '2026-11.jsonl'), (await gh.readStateFile('ledger/2026-11.jsonl')) ?? '');
    const c = cli(['shadow', 'compare', '--mac', macDigests, '--hosted', hostedDigests, '--ledger', p('ledger'), '--verify', p('verify'), '--from', DAY1.date, '--days', '2', '--out', p('report')], {});
    expect(c.status, c.err).toBe(0);
    const report = JSON.parse(readFileSync(p('report', `report-${DAY1.date}.json`), 'utf8')) as {
      days: { date: string; comparable: boolean; eligible: { recall: number | null }; gigs: { recall: number | null } }[];
      criteria: { id: string; status: string; numbers: string }[];
    };
    expect(report.days.map((x) => x.date)).toEqual([DAY1.date, DAY2.date]);
    for (const day of report.days) {
      expect(day.comparable, day.date).toBe(true);
      expect(day.eligible.recall, `${day.date} eligible`).toBe(1);
      expect(day.gigs.recall, `${day.date} gigs`).toBe(1);
    }
    const md = readFileSync(p('report', `report-${DAY1.date}.md`), 'utf8');
    expect(md).toContain('1.000');
    expect(report.criteria).toHaveLength(8);
    for (const crit of report.criteria) {
      expect(crit.status, crit.id).toBe('NOT EVALUATED');
    }
    for (const crit of report.criteria.filter((x) => x.id !== 'C8')) expect(crit.numbers).toBe('the window is 2 days; the criteria need 7');

    // 5. no hosted or shadow command wrote to the Mac home
    expect(existsSync(join(mac, 'jobpilot.db'))).toBe(true);
    expect(SHA(join(mac, 'jobpilot.db'))).toBe(macHashAfterRuns);
  }, 300_000);
});
