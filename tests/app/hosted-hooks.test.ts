import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAILY_DUE, FREELANCE_DUE, due } from '../../src/app/due.js';
import { runFreelance } from '../../src/app/freelance/run.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { fileNotifier } from '../../src/app/notify.js';
import { offlineProviders } from '../../src/app/offline.js';
import { PROBLEM_CODES } from '../../src/app/hosted/log-gateway.js';
import { runCommand, runFreelanceCommand, type RunCommandDeps } from '../../src/app/run-command.js';
import type { RunSummaryJson } from '../../src/app/run-summary.js';
import { HOME_NETWORK_NOTE, runDaily, skipSeed } from '../../src/app/run.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { cliClock } from '../../src/app/test-clock.js';
import { KernelError } from '../../src/kernel/errors.js';
import type { FetchLike } from '../../src/kernel/providers.js';

const root = join(import.meta.dirname, '../..');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();
const E2E = join(root, 'tests/fixtures/e2e');
const FREELANCE = join(root, 'tests/fixtures/freelance-e2e');
const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-hooks-'));
  homes.push(home);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  return home;
}
const AT = '2026-10-09T02:30:00.000Z'; // 08:00 IST
const deps = (home: string, at = AT): RunCommandDeps & { lines: string[] } => {
  const lines: string[] = [];
  return { home, clock: { now: () => at }, notifier: async () => {}, out: (l) => void lines.push(l), err: (l) => void lines.push(l), sleep: async () => {}, pdftotext: pdftotext as string, lines };
};
const dailyRun = (home: string, extra: Record<string, unknown> = {}) => {
  const off = offlineProviders(E2E);
  return runDaily({ home, clock: { now: () => AT }, fetch: off.fetch, browser: off.browser, sleep: async () => {}, pdftotext: pdftotext as string, ...extra });
};
const GH = 'https://boards-api.greenhouse.io/v1/boards/example-gh/jobs?content=true&pay_transparency=true';

describe('skipSeed', () => {
  it('matches `ats` or `ats:slug`', () => {
    expect(skipSeed({ ats: 'feed', slug: 'remotive' }, ['feed:remotive'])).toBe(true);
    expect(skipSeed({ ats: 'feed', slug: 'remotive' }, ['feed'])).toBe(true);
    expect(skipSeed({ ats: 'feed', slug: 'remotive' }, ['greenhouse'])).toBe(false);
    expect(skipSeed({ ats: 'feed', slug: 'remotive' }, ['feed:jobicy'])).toBe(false);
    expect(skipSeed({ ats: 'feed', slug: 'remotive' }, [])).toBe(false);
  });
});

describe('cliClock', () => {
  it('starts at JOBPILOT_TEST_NOW under test only', () => {
    const c = cliClock({ VITEST: 'true', JOBPILOT_TEST_NOW: '2026-11-02T02:07:00.000Z' });
    const t = Date.parse(c.now());
    expect(t).toBeGreaterThanOrEqual(Date.parse('2026-11-02T02:07:00.000Z'));
    expect(t).toBeLessThan(Date.parse('2026-11-02T02:07:30.000Z'));
    const real = Date.parse(cliClock({ JOBPILOT_TEST_NOW: '2026-11-02T02:07:00.000Z' }).now());
    expect(Math.abs(real - Date.now())).toBeLessThan(5000);
    expect(() => cliClock({ NODE_ENV: 'test', JOBPILOT_TEST_NOW: 'garbage' })).toThrow(/JOBPILOT_TEST_NOW/);
  });
});

describe('fileNotifier', () => {
  it('appends one {at, text} line per call, mode 0600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobpilot-fn-'));
    homes.push(dir);
    const file = join(dir, 'logs', 'notifications.jsonl');
    const n = fileNotifier(file, { now: () => '2026-10-15T01:00:00.000Z' });
    await n('first');
    await n('second\nline');
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { at: '2026-10-15T01:00:00.000Z', text: 'first' },
      { at: '2026-10-15T01:00:00.000Z', text: 'second\nline' },
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe.skipIf(pdftotext === undefined)('stop between steps', () => {
  it('a daily run pauses, the next run resumes the same run id; runCommand records `paused`', async () => {
    const home = newHome();
    let steps = 0;
    const first = await dailyRun(home, { stop: () => (steps >= 3 ? 'stopped: test' : null), afterStep: (n: number) => (steps = n) });
    expect(first.report.status).toBe('paused');
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(app.kernel.getRun(first.runId)?.status).not.toBe('completed');
    } finally {
      app.close();
    }
    const second = await dailyRun(home);
    expect(second.runId).toBe(first.runId);
    expect(second.resumed).toBe(true);
    expect(second.report.status).toBe('completed');

    // through runCommand with --if-due: the attempt is `paused`, so the run is still owed
    const h2 = newHome();
    let n2 = 0;
    const d = deps(h2);
    const code = await runCommand({ notify: false, ifDue: true, offlineFixtures: E2E, stop: () => (n2++ >= 3 ? 'stopped: test' : null) } as never, d);
    expect(code).toBe(0);
    const attempts = JSON.parse(readFileSync(join(h2, DAILY_DUE.attemptsFile), 'utf8')) as { attempts: { outcome: string }[] };
    expect(attempts.attempts.map((a) => a.outcome)).toEqual(['paused']);
    expect(due(DAILY_DUE, h2, AT).due).toBe(true);
  }, 120_000);

  it('a freelance run pauses and resumes the same way', async () => {
    const home = newHome();
    const off = offlineProviders(FREELANCE);
    const base = { home, clock: { now: () => AT }, fetch: off.fetch, sleep: async () => {}, pdftotext: pdftotext as string };
    let steps = 0;
    const first = await runFreelance({ ...base, stop: () => (steps >= 2 ? 'stopped: test' : null), afterStep: (n) => (steps = n) });
    expect(first.report.status).toBe('paused');
    const second = await runFreelance(base);
    expect(second.runId).toBe(first.runId);
    expect(second.resumed).toBe(true);
    expect(second.report.status).toBe('completed');

    const h2 = newHome();
    let n2 = 0;
    const code = await runFreelanceCommand({ notify: false, ifDue: true, offlineFixtures: FREELANCE, stop: () => (n2++ >= 2 ? 'stopped: test' : null) } as never, deps(h2));
    expect(code).toBe(0);
    const file = JSON.parse(readFileSync(join(h2, FREELANCE_DUE.attemptsFile), 'utf8')) as { attempts: { outcome: string }[] };
    expect(file.attempts.map((a) => a.outcome)).toEqual(['paused']);
    expect(due(FREELANCE_DUE, h2, AT).due).toBe(true);
  }, 120_000);
});

describe.skipIf(pdftotext === undefined)('source skips', () => {
  it('a skipped board is never asked and is named in a warning; with no skips the run is unchanged', async () => {
    const plain = await dailyRun(newHome());
    const asked: string[] = [];
    const off = offlineProviders(E2E);
    const fetch: FetchLike = async (url, init) => {
      asked.push(url);
      return off.fetch(url, init);
    };
    const skipped = await dailyRun(newHome(), { fetch, skipSources: ['greenhouse:example-gh'] });
    expect(asked).not.toContain(GH);
    expect(skipped.warnings).toContain(`${HOME_NETWORK_NOTE} (greenhouse:example-gh)`);
    expect(plain.warnings.some((w) => w.startsWith(HOME_NETWORK_NOTE))).toBe(false);
    const again = await dailyRun(newHome(), { skipSources: [] });
    expect(again.runId).toBe(plain.runId);
    expect(again.counts).toEqual(plain.counts);
  }, 120_000);

  it('freelance:<platform> drops that platform`s seeds', async () => {
    const home = newHome();
    const off = offlineProviders(FREELANCE);
    const asked: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      asked.push(url);
      return off.fetch(url, init);
    };
    const s = await runFreelance({ home, clock: { now: () => AT }, fetch, sleep: async () => {}, pdftotext: pdftotext as string, skipSources: ['freelance:freelancer'] });
    expect(asked.some((u) => new URL(u).hostname === 'www.freelancer.com')).toBe(false);
    expect(s.warnings).toContain(`${HOME_NETWORK_NOTE} (freelance:freelancer)`);
  }, 120_000);
});

describe.skipIf(pdftotext === undefined)('freelance windows', () => {
  it('--windows am at 20:30 IST is the am run; the default windows give pm', async () => {
    const at = '2026-10-15T15:00:00.000Z';
    const h1 = newHome();
    expect(await runFreelanceCommand({ notify: false, offlineFixtures: FREELANCE, windows: ['am'] } as never, deps(h1, at))).toBe(0);
    const a1 = AppStore.open(join(h1, 'jobpilot.db'));
    try {
      expect(a1.kernel.getRun('freelance-2026-10-15-am')).toBeDefined();
      expect(a1.kernel.getRun('freelance-2026-10-15-pm')).toBeUndefined();
    } finally {
      a1.close();
    }
    const h2 = newHome();
    expect(await runFreelanceCommand({ notify: false, offlineFixtures: FREELANCE } as never, deps(h2, at))).toBe(0);
    const a2 = AppStore.open(join(h2, 'jobpilot.db'));
    try {
      expect(a2.kernel.getRun('freelance-2026-10-15-pm')).toBeDefined();
    } finally {
      a2.close();
    }
  }, 120_000);
});

describe.skipIf(pdftotext === undefined)('summary json', () => {
  it('writes RunSummaryJson with a tally of known codes and no company name', async () => {
    const home = newHome();
    const file = join(home, 'summary.json');
    const d = deps(home);
    expect(await runCommand({ notify: false, offlineFixtures: E2E, summaryJson: file } as never, d)).toBeLessThanOrEqual(1);
    const raw = readFileSync(file, 'utf8');
    const s = JSON.parse(raw) as RunSummaryJson;
    const projected = Number(/jobs: (\d+) written/.exec(d.lines.join('\n'))?.[1]);
    expect(s).toMatchObject({ v: 1, pipeline: 'daily', status: 'completed', skippedSources: 0 });
    expect(s.runId).toBe('daily-2026-10-09');
    expect(s.items).toBe(projected);
    expect(s.items).toBeGreaterThan(0);
    for (const k of Object.keys(s.problems)) expect(PROBLEM_CODES).toContain(k);
    for (const name of ['Example Greenhouse Co', 'Example Lever Co', 'Example Ashby']) expect(raw).not.toContain(name);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  }, 120_000);

  it('freelance writes its own, with a gmail state', async () => {
    const home = newHome();
    const file = join(home, 'summary.json');
    expect(await runFreelanceCommand({ notify: false, offlineFixtures: FREELANCE, summaryJson: file } as never, deps(home))).toBeLessThanOrEqual(1);
    const s = JSON.parse(readFileSync(file, 'utf8')) as RunSummaryJson;
    expect(s).toMatchObject({ v: 1, pipeline: 'freelance', status: 'completed' });
    expect(['connected', 'off', 'failed']).toContain(s.gmail);
  }, 120_000);
});

describe.skipIf(pdftotext === undefined)('hosted runner suffix', () => {
  const challenged: FetchLike = async (url, init) => {
    if (url === GH) throw new KernelError('challenged', 'host answered with a challenge page');
    return offlineProviders(E2E).fetch(url, init);
  };
  it('a challenged failure ends with (hosted runner) only in the hosted env', async () => {
    const local = await dailyRun(newHome(), { fetch: challenged });
    const localReason = local.problems.find((p) => /challenged/.test(p.reason))?.reason ?? '';
    expect(localReason).toMatch(/^challenged: /);
    expect(localReason.endsWith('(hosted runner)')).toBe(false);
    vi.stubEnv('JOBPILOT_RUN_ENV', 'hosted');
    const hosted = await dailyRun(newHome(), { fetch: challenged });
    const hostedReason = hosted.problems.find((p) => /challenged/.test(p.reason))?.reason ?? '';
    expect(hostedReason).toMatch(/^challenged: .* \(hosted runner\)$/);
  }, 120_000);
});

describe('CLI flags', () => {
  const cli = (...args: string[]) => {
    const env = { ...process.env, JOBPILOT_HOME: mkdtempSync(join(tmpdir(), 'jobpilot-hooks-cli-')), VITEST: 'true' } as NodeJS.ProcessEnv;
    delete env['JOBPILOT_RUN_ENV'];
    homes.push(env['JOBPILOT_HOME'] as string);
    return spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/bin.ts'), ...args], { cwd: root, encoding: 'utf8', env });
  };
  it('refuses --skip-source outside hosted runs, and a bad --windows', () => {
    const a = cli('run', '--skip-source', 'x');
    expect(a.status).toBe(1);
    expect(a.stderr).toContain('--skip-source is for hosted runs only');
    const b = cli('run-freelance', '--windows', 'xx');
    expect(b.status).toBe(1);
    expect(b.stderr).toMatch(/--windows/);
  }, 60_000);
});
