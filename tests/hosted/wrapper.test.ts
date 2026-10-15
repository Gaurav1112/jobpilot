import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALERT_LABEL, ALERTS } from '../../src/app/hosted/alerts.js';
import { parseLedger } from '../../src/app/hosted/budget.js';
import { packFiles, sealFiles } from '../../src/app/hosted/bundle.js';
import { HOSTED_RETENTION_YAML, HostedConfig } from '../../src/app/hosted/config.js';
import { dirGitHub } from '../../src/app/hosted/github-dir.js';
import type { GitHubClient } from '../../src/app/hosted/github.js';
import { isTemplateLine } from '../../src/app/hosted/log-gateway.js';
import { pointerJson, type Pointer } from '../../src/app/hosted/pointer.js';
import { seedAndPublish } from '../../src/app/hosted/seed.js';
import { GMAIL_ENV_NAMES, type PipelineRun } from '../../src/app/hosted/spawn.js';
import { acquireLease, appendStateFiles } from '../../src/app/hosted/state.js';
import { pullHome } from '../../src/app/hosted/sync.js';
import { runHosted, type HostedDeps, type HostedRunOptions, type WrapperStep } from '../../src/app/hosted/wrapper.js';
import { buildHostedHome, FIXTURE_PACK } from '../support/hosted-home.js';

const NOW = '2026-11-02T02:07:00.000Z';
const LOCK = 'a'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'jp-wrapper-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => join(root, `w${n++}`);
const STATE_KEY = randomBytes(32);
const PACK_KEY = randomBytes(32);
const GMAIL = { JOBPILOT_SECRET_GMAIL_CLIENT_ID: 'gm-id-fake-77', JOBPILOT_SECRET_GMAIL_CLIENT_SECRET: 'gm-secret-fake-88', JOBPILOT_SECRET_GMAIL_REFRESH: 'gm-refresh-fake-99' };
const ENV: NodeJS.ProcessEnv = {
  PATH: '/bin',
  HOME: '/home/runner',
  JOBPILOT_SECRET_HOSTED_STATE_KEY: STATE_KEY.toString('base64'),
  JOBPILOT_SECRET_HOSTED_PACK_KEY: PACK_KEY.toString('base64'),
  GH_TOKEN: 'ghp_fake_token_1',
  GITHUB_TOKEN: 'ghp_fake_token_2',
  ...GMAIL,
};
const CLI = ['node', '--import', 'tsx', '/code/src/bin.ts'] as const;
const STATE = { keepGenerations: 5, keepWeekly: 2, archiveDays: 30, warnCompressedMB: 100, hardCompressedMB: 200 };

const hostedYaml = (state = STATE, windows: ('am' | 'pm')[] = ['am']): string =>
  [
    'version: 1',
    'owner: example-user',
    'view: {repo: jobpilot-view, url: "https://example-user.github.io/jobpilot-view/"}',
    'budget: {monthlyMinutes: 2000, safetyMinutes: 100, cycleStartDay: 1, dailyEstimateMinutes: 60}',
    `freelance: {windows: [${windows.join(', ')}]}`,
    'coverage: {everyWeeks: 2, anchor: "2026-11-01", maxSliceMinutes: 300, endBy: "06:30"}',
    `state: {keepGenerations: ${state.keepGenerations}, keepWeekly: ${state.keepWeekly}, archiveDays: ${state.archiveDays}, warnCompressedMB: ${state.warnCompressedMB}, hardCompressedMB: ${state.hardCompressedMB}}`,
    'snapshot: {budgetMB: 20, staleHours: 48}',
    'skipSources: []',
    '',
  ].join('\n');

let templateGh = '';
let packJpst = '';
beforeAll(async () => {
  const mac = join(root, 'mac');
  buildHostedHome(mac, '2026-11-01T01:30:00.000Z');
  templateGh = join(root, 'template-gh');
  const gh = dirGitHub(templateGh, { now: () => NOW });
  const out = await seedAndPublish({ gh, key: STATE_KEY, from: mac, work: join(root, 'seed-work'), now: '2026-11-01T01:30:00.000Z', codeSha: LOCK, state: HostedConfig.shape.state.parse(STATE) });
  expect(out.ok).toBe(true);
  packJpst = join(root, 'pack.jpst');
  await sealFiles(packFiles(FIXTURE_PACK, join(root, 'pack-tmp'), { 'retention.yaml': HOSTED_RETENTION_YAML }), packJpst, PACK_KEY);
});

interface Script {
  exit?: number | null;
  killed?: boolean;
  /** No summary file (a run that could not run). */
  noSummary?: boolean;
  status?: 'completed' | 'paused';
  gmail?: 'connected' | 'off' | 'failed';
  problems?: Record<string, number>;
  bigOut?: number;
  notification?: string;
}
interface Call { pipeline: 'daily' | 'freelance'; argv: readonly string[]; env: Record<string, string>; deadlineAt: number; logFile: string }

interface Setup {
  readonly ghDir: string;
  readonly gh: GitHubClient;
  readonly o: HostedRunOptions;
  d: HostedDeps;
  readonly calls: Call[];
  readonly out: string[];
  readonly summaryFile: string;
  script: { daily: Script; freelance: Script };
}

function setup(over: { state?: typeof STATE; windows?: ('am' | 'pm')[]; now?: string; git?: HostedDeps['git']; fault?: (s: WrapperStep) => void } = {}): Setup {
  const ghDir = fresh();
  cpSync(templateGh, ghDir, { recursive: true });
  const gh = dirGitHub(ghDir, { now: () => over.now ?? NOW });
  const dataDir = fresh();
  mkdirSync(join(dataDir, 'pack'), { recursive: true });
  writeFileSync(join(dataDir, 'hosted.yaml'), hostedYaml(over.state, over.windows));
  writeFileSync(join(dataDir, 'code.lock'), `${LOCK}\n`);
  cpSync(packJpst, join(dataDir, 'pack', 'pack.jpst'));
  const workDir = fresh();
  mkdirSync(workDir, { recursive: true });
  const calls: Call[] = [];
  const out: string[] = [];
  const summaryFile = join(fresh(), 'summary.md');
  mkdirSync(join(summaryFile, '..'), { recursive: true });
  const s: Setup = {
    ghDir,
    gh,
    calls,
    out,
    summaryFile,
    script: { daily: {}, freelance: {} },
    o: { pipeline: 'daily', dataDir, codeDir: '/code', workDir, trigger: 'primary', runId: '4242', jobTimeoutMinutes: 150, ancestorRef: 'origin/main', fetchMain: true },
    d: {
      gh,
      clock: { now: () => over.now ?? NOW },
      env: ENV,
      out: (l) => out.push(l),
      summaryFile,
      git: over.git ?? ((args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? `${LOCK}\n` : '' })),
      spawn: async (a): Promise<PipelineRun> => {
        const pipeline = a.argv[CLI.length] === 'run-freelance' ? 'freelance' : 'daily';
        const sc = s.script[pipeline];
        calls.push({ pipeline, argv: a.argv, env: { ...a.env }, deadlineAt: a.deadlineAt, logFile: a.logFile });
        const home = a.env['JOBPILOT_HOME'] as string;
        if (sc.killed === true) return { exit: null, stopped: true, killed: true, ms: 61_000 };
        const date = '2026-11-02';
        const runId = pipeline === 'daily' ? `daily-${date}` : `freelance-${date}-am`;
        if (sc.noSummary !== true) {
          const db = new Database(join(home, 'jobpilot.db'));
          db.prepare(`INSERT INTO runs (run_id, pipeline, policy_hash, started_at, finished_at, status) VALUES (?, ?, 'p', ?, ?, 'completed')`).run(runId, 'jobpilot', '2026-11-02T01:40:00.000Z', '2026-11-02T01:50:00.000Z');
          db.close();
          const file = a.argv[a.argv.indexOf('--summary-json') + 1] as string;
          writeFileSync(
            file,
            JSON.stringify({ v: 1, pipeline, runId, status: sc.status ?? 'completed', exitCode: sc.exit ?? 0, items: 3, problems: sc.problems ?? {}, skippedSources: 0, ...(pipeline === 'freelance' ? { gmail: sc.gmail ?? 'connected' } : {}) }),
          );
        }
        if (pipeline === 'daily') writeFileSync(join(home, 'daily-attempts.json'), '{"fake-attempt":1}\n');
        if (sc.bigOut !== undefined) {
          mkdirSync(join(home, 'out'), { recursive: true });
          writeFileSync(join(home, 'out', 'big.bin'), randomBytes(sc.bigOut));
        }
        if (sc.notification !== undefined) {
          mkdirSync(join(home, 'logs'), { recursive: true });
          writeFileSync(join(home, 'logs', 'notifications.jsonl'), `${JSON.stringify({ at: NOW, text: sc.notification })}\n`);
        }
        return { exit: sc.exit ?? 0, stopped: false, killed: false, ms: 120_000 };
      },
      freeBytes: () => 1e12,
      cli: CLI,
      ...(over.fault ? { fault: over.fault } : {}),
    },
  };
  return s;
}

const run = (s: Setup, o: Partial<HostedRunOptions> = {}): Promise<0 | 1> => runHosted({ ...s.o, ...o }, s.d);
const pointer = async (s: Setup): Promise<Pointer> => (await s.gh.readState())!.pointer;
const ledger = async (s: Setup): Promise<ReturnType<typeof parseLedger>> => parseLedger((await s.gh.readStateFile('ledger/2026-11.jsonl')) ?? '');
const issueTitles = (s: Setup): string[] => (existsSync(join(s.ghDir, 'issues.json')) ? (JSON.parse(readFileSync(join(s.ghDir, 'issues.json'), 'utf8')) as { title: string }[]).map((i) => i.title) : []);
const hasAlert = (s: Setup, kind: keyof typeof ALERTS): boolean => issueTitles(s).includes(ALERTS[kind]);
const releases = async (s: Setup): Promise<string[]> => (await s.gh.listReleases()).map((r) => r.tag);
/** Release tags of generation 2 (state or archive, any attempt). */
const gen2 = async (s: Setup): Promise<string[]> => (await releases(s)).filter((t) => /^(?:state|archive)-g000002(?:-|$)/.test(t)).sort();
async function patchPointer(s: Setup, f: (p: Pointer) => Pointer): Promise<void> {
  await appendStateFiles(s.gh, async (head) => ({ 'pointer.json': pointerJson(f(head.pointer)) }), 'test patch');
}
async function addLedger(s: Setup, minutes: number[]): Promise<void> {
  const lines = minutes.map((m, i) => JSON.stringify({ runId: String(900 + i), workflow: 'maintenance', startedAt: '2026-11-01T05:00:00.000Z', billedMinutes: m, outcome: 'committed' }));
  await appendStateFiles(s.gh, async (_h, read) => ({ 'ledger/2026-11.jsonl': `${(await read('ledger/2026-11.jsonl')) ?? ''}${lines.join('\n')}\n` }), 'test ledger');
}
const lastOutcome = async (s: Setup): Promise<string | undefined> => (await ledger(s)).at(-1)?.outcome;

describe('runHosted: the happy path', () => {
  it('commits generation 2 with shadow digests, a ledger line and only template lines on stdout', async () => {
    const s = setup();
    expect(await run(s)).toBe(0);
    const p = await pointer(s);
    expect(p.gen).toBe(2);
    expect(p.history.map((h) => h.gen)).toEqual([2, 1]);
    expect(p.lease).toBeNull();
    expect(p.current?.lastDone).toMatchObject({ daily: '2026-11-02', freelance: '2026-11-02' });
    expect(await s.gh.readStateFile('shadow/hosted/2026-11-02-daily.json')).toContain('"env":"hosted"');
    expect(await s.gh.readStateFile('shadow/hosted/2026-11-02-freelance.json')).not.toBeNull();
    const l = await ledger(s);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ runId: '4242', workflow: 'daily', outcome: 'committed', date: '2026-11-02', gen: 2, pipelines: { daily: 0, freelance: 0 }, level: 'L0' });
    expect(l[0]?.committedAt).toBeDefined();
    for (const line of s.out) expect(isTemplateLine(line) || line.startsWith('::add-mask::'), line).toBe(true);
    expect(s.out.some((x) => x.startsWith('::add-mask::'))).toBe(true);
    const summary = readFileSync(s.summaryFile, 'utf8').trimEnd().split('\n');
    expect(summary).toEqual(s.out.filter((x) => !x.startsWith('::add-mask::')));
    expect(s.out.some((x) => /^state: generation 2 committed \(/.test(x))).toBe(true);
  });

  it('the attempts file written by the child survives into the next generation', async () => {
    const s = setup();
    expect(await run(s)).toBe(0);
    const to = fresh();
    await pullHome({ gh: s.gh, key: STATE_KEY, to, tmpDir: root, defaultHome: fresh() });
    expect(readFileSync(join(to, 'daily-attempts.json'), 'utf8')).toContain('fake-attempt');
  });

  it('pipeline exit 0, 1 and 2 all commit', async () => {
    for (const exit of [0, 1, 2]) {
      const s = setup();
      s.script.daily = exit === 2 ? { exit, noSummary: true } : { exit };
      expect(await run(s), `exit ${exit}`).toBe(0);
      expect((await pointer(s)).gen).toBe(2);
      expect(await lastOutcome(s)).toBe('committed');
    }
  });

  it('a daily run that could not run does not mark the day done', async () => {
    const s = setup();
    s.script.daily = { exit: 2, noSummary: true };
    await run(s);
    expect((await pointer(s)).current?.lastDone.daily).toBeNull();
    expect(s.out.some((x) => /^daily: could not run /.test(x))).toBe(true);
  });
});

describe('runHosted: failures leave the pointer at G', () => {
  const steps: WrapperStep[] = ['lease', 'download', 'integrity', 'disk', 'pack', 'daily', 'freelance', 'compact', 'digest', 'bundle', 'upload'];
  for (const step of steps) {
    it(`a fault at ${step}: generation 1 stays, lease released, state-failure alert, ledger failed`, async () => {
      const s = setup({ fault: (x) => { if (x === step) throw new Error('boom'); } });
      expect(await run(s)).toBe(1);
      const p = await pointer(s);
      expect(p.gen).toBe(1);
      expect(p.lease).toBeNull();
      expect(hasAlert(s, 'state-failure')).toBe(true);
      expect(await lastOutcome(s)).toBe('failed');
      expect(await gen2(s)).toEqual([]);
      for (const line of s.out) expect(isTemplateLine(line) || line.startsWith('::add-mask::'), line).toBe(true);
    });
  }

  it('a fault at commit: generation 1 stays and no state-g000002 release is left', async () => {
    const s = setup({ fault: (x) => { if (x === 'commit') throw new Error('boom'); } });
    expect(await run(s)).toBe(1);
    const p = await pointer(s);
    expect(p.gen).toBe(1);
    expect(p.lease).toBeNull();
    expect(await gen2(s)).toEqual([]);
    expect(hasAlert(s, 'state-failure')).toBe(true);
    expect(await lastOutcome(s)).toBe('failed');
  });

  it('releases this run did not create (an abandoned line after a rollback) survive a failed publish', async () => {
    const s = setup({ fault: (x) => { if (x === 'commit') throw new Error('boom'); } });
    // generation 2 of a line a rollback abandoned, named as an older build named it
    for (const t of ['state-g000002', 'archive-g000002']) await s.gh.createRelease(t);
    expect(await run(s)).toBe(1);
    expect((await pointer(s)).gen).toBe(1);
    expect(await gen2(s)).toEqual(['archive-g000002', 'state-g000002']);
  });

  it('a CAS rejected by another writer: conflict alert, generation not ours, releases removed', async () => {
    const s = setup();
    let moved = false;
    const gh = dirGitHub(s.ghDir, {
      now: () => NOW,
      beforeCas: async () => {
        if (moved) return;
        const head = await dirGitHub(s.ghDir).readState();
        if (head?.pointer.current && head.pointer.lease?.holder === 'actions:4242' && existsSync(join(s.ghDir, 'releases')) && readdirSync(join(s.ghDir, 'releases')).some((t) => t.startsWith('state-g000002'))) {
          moved = true;
          // a second writer moves the pointer: our lease is gone
          const p = { ...head.pointer, lease: null };
          const raw = dirGitHub(s.ghDir);
          await raw.casState(head.commit, { 'pointer.json': pointerJson(p) }, 'other writer');
        }
      },
    });
    const sw: Setup = { ...s, gh, d: { ...s.d, gh } };
    expect(await run(sw)).toBe(1);
    expect(moved).toBe(true);
    expect((await pointer(sw)).gen).toBe(1);
    expect(await gen2(sw)).toEqual([]);
    expect(hasAlert(sw, 'conflict')).toBe(true);
  });

  it('a fault at prune: committed, exit 0', async () => {
    const s = setup({ fault: (x) => { if (x === 'prune') throw new Error('boom'); } });
    expect(await run(s)).toBe(0);
    expect((await pointer(s)).gen).toBe(2);
    expect(await lastOutcome(s)).toBe('committed');
  });

  it('a fault at ledger: committed, exit 1, an alert', async () => {
    const s = setup({ fault: (x) => { if (x === 'ledger') throw new Error('boom'); } });
    expect(await run(s)).toBe(1);
    expect((await pointer(s)).gen).toBe(2);
    expect(hasAlert(s, 'state-failure')).toBe(true);
    expect(await ledger(s)).toHaveLength(0);
  });

  it('a killed pipeline: nothing uploaded, killed alert, lease released', async () => {
    const s = setup();
    s.script.daily = { killed: true };
    expect(await run(s)).toBe(1);
    const p = await pointer(s);
    expect(p.gen).toBe(1);
    expect(p.lease).toBeNull();
    expect(await gen2(s)).toEqual([]);
    expect(hasAlert(s, 'killed')).toBe(true);
    expect(await lastOutcome(s)).toBe('killed');
    expect(s.out.some((x) => /^daily: killed 60 s after the deadline stop; nothing is uploaded$/.test(x))).toBe(true);
  });

  it('a wrong state key is wrong-key, not committed', async () => {
    const s = setup();
    s.d = { ...s.d, env: { ...ENV, JOBPILOT_SECRET_HOSTED_STATE_KEY: randomBytes(32).toString('base64') } };
    expect(await run(s)).toBe(1);
    expect(s.out.some((x) => x === 'state: not committed (wrong-key); generation 1 stays')).toBe(true);
    expect((await pointer(s)).gen).toBe(1);
  });
});

describe('runHosted: nothing to do', () => {
  it('busy: a live laptop lease', async () => {
    const s = setup();
    await acquireLease(s.gh, 'laptop:abcdef12', NOW, '2026-11-02T05:00:00.000Z');
    expect(await run(s)).toBe(0);
    expect(s.out.some((x) => x === 'hosted run daily: state is in use by laptop:abcdef12 until 10:30 IST')).toBe(true);
    expect((await pointer(s)).gen).toBe(1);
    expect((await pointer(s)).lease?.holder).toBe('laptop:abcdef12');
    expect(await lastOutcome(s)).toBe('busy');
    expect(s.calls).toHaveLength(0);
  });

  it('nothing owed when both ran today: no lease, no child', async () => {
    const s = setup();
    await patchPointer(s, (p) => {
      const cur = { ...p.current!, lastDone: { daily: '2026-11-02', freelance: '2026-11-02', coverage: null } };
      return { ...p, current: cur, history: [cur, ...p.history.slice(1)] };
    });
    const before = (await s.gh.readState())!.pointer;
    expect(await run(s)).toBe(0);
    expect(s.out.some((x) => x === 'hosted run daily: nothing owed today (generation 1)')).toBe(true);
    expect(s.calls).toHaveLength(0);
    expect(await lastOutcome(s)).toBe('nothing-owed');
    expect((await pointer(s)).lease).toBeNull();
    expect((await pointer(s)).gen).toBe(before.gen);
  });

  it('nothing owed before 07:00 IST', async () => {
    const s = setup({ now: '2026-11-01T23:00:00.000Z' });
    expect(await run(s)).toBe(0);
    expect(await lastOutcome(s)).toBe('nothing-owed');
    expect(s.calls).toHaveLength(0);
  });
});

describe('runHosted: the minutes budget', () => {
  it('catch-up at L2 is off', async () => {
    const s = setup();
    await addLedger(s, [150]);
    expect(await run(s, { trigger: 'catch-up' })).toBe(0);
    expect(s.out.some((x) => x === 'hosted run daily: catch-up check off: minutes budget')).toBe(true);
    expect(await lastOutcome(s)).toBe('catch-up-off');
    expect(s.calls).toHaveLength(0);
    expect((await pointer(s)).gen).toBe(1);
  });

  it('L3: the daily runs, freelance is cut, one budget alert, and no second alert on the next run', async () => {
    const s = setup();
    await patchPointer(s, (p) => ({ ...p, budget: { month: '2026-11', level: 'L0' } }));
    await addLedger(s, [200]);
    expect(await run(s)).toBe(0);
    expect(s.calls.map((c) => c.pipeline)).toEqual(['daily']);
    expect(s.out.some((x) => x === 'freelance: paused until 1 Dec: minutes budget')).toBe(true);
    expect((await pointer(s)).budget).toEqual({ month: '2026-11', level: 'L3' });
    const issues = (): { title: string; comments: string[] }[] => JSON.parse(readFileSync(join(s.ghDir, 'issues.json'), 'utf8')) as { title: string; comments: string[] }[];
    const budget = (): { title: string; comments: string[] } | undefined => issues().find((i) => i.title === ALERTS.budget);
    expect(budget()?.comments).toHaveLength(0);
    // the run itself was short, so top the month up to L3 again before the next start
    await addLedger(s, [400, 400, 400, 400, 79]);
    s.out.length = 0;
    const second = await run(s, { runId: '4243', workDir: fresh() });
    expect(second, s.out.join(' / ')).toBe(0);
    expect(budget()?.comments).toHaveLength(0);
    expect(issues().filter((i) => i.title === ALERTS.budget)).toHaveLength(1);
  });

  it('L4: refused, no lease', async () => {
    const s = setup();
    await addLedger(s, [400, 400, 400, 400, 400]);
    expect(await run(s)).toBe(1);
    expect(s.out.some((x) => x === 'hosted run daily: refused: budget-l4')).toBe(true);
    expect(s.calls).toHaveLength(0);
    expect(await lastOutcome(s)).toBe('refused');
    expect((await pointer(s)).gen).toBe(1);
    expect(hasAlert(s, 'refused')).toBe(true);
  });
});

describe('runHosted: refusals', () => {
  const cases: { name: string; reason: string; prep?: (s: Setup) => Promise<void> | void; opts?: Partial<HostedRunOptions>; git?: HostedDeps['git'] }[] = [
    { name: 'repo not private', reason: 'repo-public', prep: (s) => writeFileSync(join(s.ghDir, 'facts.json'), JSON.stringify({ private: false, defaultWorkflowPermissions: 'read', secretNames: [] })) },
    { name: 'code.lock differs from HEAD', reason: 'code-lock-mismatch', git: (args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? `${'b'.repeat(40)}\n` : '' }) },
    { name: 'not an ancestor', reason: 'code-not-ancestor', git: (args) => ({ status: args[0] === 'merge-base' ? 1 : 0, stdout: args[0] === 'rev-parse' ? `${LOCK}\n` : '' }) },
    { name: 'trigger manual', reason: 'bad-trigger', opts: { trigger: 'manual' } },
    { name: 'pipeline coverage', reason: 'coverage-not-in-this-build', opts: { pipeline: 'coverage' } },
    { name: 'pointer sizeHard', reason: 'size-hard', prep: (s) => patchPointer(s, (p) => ({ ...p, sizeHard: true })) },
    { name: 'no hosted.yaml', reason: 'config', prep: (s) => rmSync(join(s.o.dataDir, 'hosted.yaml')) },
  ];
  for (const c of cases) {
    it(`${c.name}: refused ${c.reason}, no lease, exit 1`, async () => {
      const s = setup(c.git ? { git: c.git } : {});
      await c.prep?.(s);
      expect(await run(s, c.opts)).toBe(1);
      expect(s.out.some((x) => x === `hosted run ${c.opts?.pipeline ?? 'daily'}: refused: ${c.reason}`), s.out.join('|')).toBe(true);
      expect(s.calls).toHaveLength(0);
      const p = await pointer(s);
      expect(p.gen).toBe(1);
      expect(p.lease).toBeNull();
      if (c.reason !== 'config') expect(await lastOutcome(s)).toBe('refused');
      expect(hasAlert(s, 'refused')).toBe(true);
    });
  }
  it('the private check needs no secret listing: repoFacts failing (a 403 on secrets) still runs', async () => {
    const s = setup();
    const gh: GitHubClient = { ...s.gh, repoFacts: () => Promise.reject(new Error('gh secret list failed (exit 1)')) };
    s.d = { ...s.d, gh };
    expect(await run(s)).toBe(0);
    expect((await pointer(s)).gen).toBe(2);
  });
  it('a failing private check is refused repo-public (fails closed)', async () => {
    const s = setup();
    const gh: GitHubClient = { ...s.gh, repoPrivate: () => Promise.reject(new Error('gh api failed (exit 1)')) };
    s.d = { ...s.d, gh };
    expect(await run(s)).toBe(1);
    expect(s.out).toContain('hosted run daily: refused: repo-public');
  });
  it('a missing key is refused (keys)', async () => {
    const s = setup();
    s.d = { ...s.d, env: { ...ENV, JOBPILOT_SECRET_HOSTED_PACK_KEY: '' } };
    expect(await run(s)).toBe(1);
    expect(s.out.some((x) => x === 'hosted run daily: refused: keys')).toBe(true);
  });
  it('an absent state branch is refused (state-missing)', async () => {
    const s = setup();
    rmSync(join(s.ghDir, 'state'), { recursive: true });
    expect(await run(s)).toBe(1);
    expect(s.out.some((x) => x === 'hosted run daily: refused: state-missing')).toBe(true);
  });
});

describe('runHosted: state size', () => {
  const small = { ...STATE, warnCompressedMB: 1, hardCompressedMB: 2 };
  it('warning: a size line and alert; committed', async () => {
    const s = setup({ state: small });
    s.script.daily = { bigOut: 1_500_000 };
    expect(await run(s)).toBe(0);
    expect(s.out.some((x) => /^state: asset \d+\.\d MB compressed is over the 1 MB warning$/.test(x))).toBe(true);
    expect(hasAlert(s, 'size')).toBe(true);
    expect((await pointer(s)).sizeHard).toBe(false);
  });
  it('hard limit: committed with sizeHard, and the next run is refused size-hard', async () => {
    const s = setup({ state: small });
    s.script.daily = { bigOut: 2_500_000 };
    expect(await run(s)).toBe(0);
    expect(s.out.some((x) => /over the 2 MB hard limit$/.test(x))).toBe(true);
    expect((await pointer(s)).sizeHard).toBe(true);
    s.out.length = 0;
    expect(await run(s, { runId: '4243', workDir: fresh() })).toBe(1);
    expect(s.out.some((x) => x === 'hosted run daily: refused: size-hard')).toBe(true);
  });
});

describe('runHosted: children', () => {
  it('daily has no secret at all, freelance exactly the Gmail three; neither has a token or a hosted key; deadline = start + timeout - 15 min', async () => {
    const s = setup();
    expect(await run(s)).toBe(0);
    const daily = s.calls.find((c) => c.pipeline === 'daily')!;
    const freelance = s.calls.find((c) => c.pipeline === 'freelance')!;
    const secrets = (e: Record<string, string>): string[] => Object.keys(e).filter((k) => k.startsWith('JOBPILOT_SECRET_')).sort();
    expect(secrets(daily.env)).toEqual([]);
    expect(secrets(freelance.env)).toEqual([...GMAIL_ENV_NAMES].sort());
    for (const c of s.calls) {
      expect(Object.keys(c.env).some((k) => /TOKEN|STATE_KEY|PACK_KEY/.test(k))).toBe(false);
      expect(c.env['JOBPILOT_RUN_ENV']).toBe('hosted');
      expect(c.deadlineAt).toBe(Date.parse(NOW) + (150 - 15) * 60_000);
    }
    expect(daily.argv.slice(CLI.length, CLI.length + 2)).toEqual(['run', '--if-due']);
    expect(freelance.argv.slice(CLI.length, CLI.length + 4)).toEqual(['run-freelance', '--if-due', '--windows', 'am']);
    expect(daily.logFile).toContain(join('home', 'logs'));
  });

  it('passes skip-sources and the offline fixtures', async () => {
    const s = setup();
    const yaml = hostedYaml().replace('skipSources: []', 'skipSources: [lever, "feed:example-feed", "freelance:example-board"]');
    writeFileSync(join(s.o.dataDir, 'hosted.yaml'), yaml);
    expect(await run(s, { offlineFixtures: '/fx' })).toBe(0);
    const daily = s.calls.find((c) => c.pipeline === 'daily')!;
    const freelance = s.calls.find((c) => c.pipeline === 'freelance')!;
    const skips = (c: Call): string[] => c.argv.flatMap((a, i) => (a === '--skip-source' ? [c.argv[i + 1] as string] : []));
    expect(skips(daily)).toEqual(['lever', 'feed:example-feed']);
    expect(skips(freelance)).toEqual(['lever', 'feed:example-feed', 'freelance:example-board']);
    expect(daily.argv).toContain('--offline-fixtures');
  });

  it('a Gmail failure and a gave-up notification each raise their alert', async () => {
    const s = setup();
    s.script.freelance = { gmail: 'failed' };
    s.script.daily = { notification: "jobpilot gave up on today's run: example" };
    expect(await run(s)).toBe(0);
    expect(hasAlert(s, 'gmail')).toBe(true);
    expect(hasAlert(s, 'gave-up')).toBe(true);
  });

  it('a pipeline signal death that was not the deadline is a pipeline-crash, nothing committed', async () => {
    const s = setup();
    // exit null without the deadline kill: a signal ended the child
    const orig = s.d.spawn;
    s.d = { ...s.d, spawn: async (a) => ({ ...(await orig(a)), exit: null }) };
    expect(await run(s)).toBe(1);
    expect(s.out.some((x) => x === 'state: not committed (pipeline-crash); generation 1 stays')).toBe(true);
    expect((await pointer(s)).gen).toBe(1);
  });
});

describe('runHosted: the previous run log audit', () => {
  it('a mask value in the previous log raises a leak alert; the run goes on', async () => {
    const s = setup();
    mkdirSync(join(s.ghDir, 'runs'), { recursive: true });
    writeFileSync(join(s.ghDir, 'runs', '4100.json'), JSON.stringify({ workflow: 'daily.yml', startedAt: '2026-11-01T01:30:00.000Z', log: 'build\tjobpilot hosted run\t2026-11-01T01:31:00.0000000Z hello Asha Rao here\n' }));
    expect(await run(s)).toBe(0);
    expect(hasAlert(s, 'leak')).toBe(true);
    expect(s.out.some((x) => /^log audit of run 4100: [1-9]\d* hits, \d+ non-template lines$/.test(x))).toBe(true);
    const l = await ledger(s);
    expect(l[0]?.audit?.runId).toBe('4100');
    expect(l[0]?.outcome).toBe('committed');
  });
  it('a clean previous log prints the audit line and no alert', async () => {
    const s = setup();
    mkdirSync(join(s.ghDir, 'runs'), { recursive: true });
    writeFileSync(join(s.ghDir, 'runs', '4100.json'), JSON.stringify({ workflow: 'daily.yml', startedAt: '2026-11-01T01:30:00.000Z', log: 'setup\tCheckout\tfine\n' }));
    expect(await run(s)).toBe(0);
    expect(hasAlert(s, 'leak')).toBe(false);
    expect(s.out).toContain('log audit of run 4100: 0 hits, 0 non-template lines');
  });
});

describe('runHosted: no secret is printed', () => {
  it('stdout, the summary file, the ledger and every issue body hold none of the keys or Gmail values', async () => {
    const happy = setup();
    const failing = setup({ fault: (x) => { if (x === 'compact') throw new Error(`boom ${ENV['JOBPILOT_SECRET_HOSTED_STATE_KEY']}`); } });
    failing.script.freelance = { gmail: 'failed' };
    await run(happy);
    await run(failing);
    const forms = (v: Buffer): string[] => [v.toString('base64'), v.toString('base64').replace(/=+$/, ''), v.toString('base64url'), v.toString('hex')];
    const secrets = [...forms(STATE_KEY), ...forms(PACK_KEY), ...Object.values(GMAIL), 'ghp_fake_token_1', 'ghp_fake_token_2'];
    for (const s of [happy, failing]) {
      const texts: string[] = [s.out.join('\n'), existsSync(s.summaryFile) ? readFileSync(s.summaryFile, 'utf8') : '', (await s.gh.readStateFile('ledger/2026-11.jsonl')) ?? ''];
      if (existsSync(join(s.ghDir, 'issues.json'))) texts.push(readFileSync(join(s.ghDir, 'issues.json'), 'utf8'));
      for (const t of texts) for (const sec of secrets) expect(t.includes(sec), sec.slice(0, 4)).toBe(false);
    }
    expect(ALERT_LABEL).toBe('jobpilot-alert');
  });
});
