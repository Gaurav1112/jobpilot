import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  assertRecordDir,
  formatProbeTable,
  judgeGigs,
  judgeGigsCounted,
  probeCommand,
  PARKED_IDS,
  probeScore,
  promoteDue,
  PROBE_SOURCE_IDS,
  runProbe,
  tallyGigs,
  type ParkedGet,
  type ProbeDeps,
} from '../../../src/app/freelance/probe.js';
import { isoWeek } from '../../../src/app/freelance/health.js';
import type { RawGig } from '../../../src/app/freelance/types.js';
import { loadRunPack } from '../../../src/app/kernel.js';
import { LOCK_FILE } from '../../../src/app/lock.js';
import { AppStore } from '../../../src/app/store/app-store.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import type { FetchLike } from '../../../src/kernel/providers.js';

vi.stubGlobal('fetch', () => {
  throw new Error('the probe tests must not use the network');
});

const root = join(import.meta.dirname, '../../..');
const fixtures = (name: string): string => join(root, 'tests/fixtures/freelance', name);
const loaded = loadRunPack(join(root, 'tests/fixtures/pack'), {}, '2026-10', undefined, 'strict');
const NOW = '2026-10-12T04:00:00.000Z';
const clock = fixedClock(NOW);
const tmps: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'jobpilot-probe-'));
  tmps.push(d);
  return d;
};
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const FREELANCER_JSON = readFileSync(join(fixtures('freelancer'), 'typescript.json'), 'utf8');
const REMOTIVE_JSON = readFileSync(join(fixtures('remotive'), 'software-dev.json'), 'utf8');
const hnIndex = JSON.parse(readFileSync(join(fixtures('hn'), 'index.json'), 'utf8')) as Record<string, string>;

/** Serves the recorded fixtures for the kept sources; `fail` makes the named hosts answer 500. */
function keptFetch(fail: readonly string[] = []): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const host = new URL(url).hostname;
    if (fail.includes(host)) return { status: 500, text: async () => 'down' };
    if (host === 'www.freelancer.com') return { status: 200, text: async () => FREELANCER_JSON };
    if (host === 'remotive.com') return { status: 200, text: async () => REMOTIVE_JSON };
    const file = hnIndex[url];
    return file === undefined ? { status: 404, text: async () => 'nope' } : { status: 200, text: async () => readFileSync(join(fixtures('hn'), file), 'utf8') };
  };
  return Object.assign(fetch, { calls });
}

const SYNTH_WNOMADS = JSON.stringify([
  { title: 'Contract Java Kafka engineer', url: 'https://wn.test/1', description: 'Contract role, 10 hours per week, $60/hr. Java, Kafka, AWS, Kubernetes. Worldwide.', tags: 'java', location: 'Anywhere', pub_date: '2026-10-10T00:00:00Z' },
]);
const parkedGet = (fail: readonly string[] = []): ParkedGet & { calls: string[] } => {
  const calls: string[] = [];
  const get = async (url: string) => {
    calls.push(url);
    const host = new URL(url).hostname;
    if (fail.includes(host)) return { status: 503, text: 'down' };
    if (host === 'www.workingnomads.com') return { status: 200, text: SYNTH_WNOMADS };
    if (host === 'remoteok.com') return { status: 200, text: '[{"legal":"x"}]' };
    if (host.includes('arbeitnow')) return { status: 200, text: '{"data":[]}' };
    return { status: 200, text: '<rss><channel></channel></rss>' };
  };
  return Object.assign(get, { calls });
};

function deps(app: AppStore, over: Partial<ProbeDeps> = {}): ProbeDeps {
  return { loaded, app, clock, sleep: async () => {}, fetch: keptFetch(), get: parkedGet(), ...over };
}

const raw = (platform: RawGig['platform'], sourceId: string, body: Record<string, unknown>): RawGig => ({ platform, sourceId, raw: body });
const hnComment = (id: number, text: string): RawGig =>
  raw('hn-freelancer', String(id), { id, author: 'x', created_at: '2026-10-10T00:00:00Z', created_at_i: 1791590400, text, story_id: 1, parent_id: 1, thread: { id: '1', title: 'Ask HN: Freelancer? Seeking freelancer? (October 2026)' } });

describe('probe score (spec 4.6)', () => {
  const m = { relevant: 10, indiaOpen: 4, indiaUnknown: 2, payKnown: 5, payOk: 3 };

  it('is exact on synthetic rows: access + volume + India + pay, one decimal', () => {
    const volume = (30 * Math.log(11)) / Math.log(51);
    const india = (20 * (4 + 1)) / 10;
    const pay = (20 * (3 + 0.25 * 5)) / 10;
    expect(probeScore('ok', m)).toBe(Math.round((30 + volume + india + pay) * 10) / 10);
    expect(probeScore('ok', m)).toBeCloseTo(30 + 30 * (Math.log(11) / Math.log(51)) + 10 + 8.5, 1);
  });

  it('access points: ok 30, partial 22, key 20, email 10, failed 0', () => {
    const none = { relevant: 0, indiaOpen: 0, indiaUnknown: 0, payKnown: 0, payOk: 0 };
    expect([probeScore('ok', none), probeScore('partial', none), probeScore('key', none), probeScore('email', none), probeScore('failed', none)]).toEqual([30, 22, 20, 10, 0]);
  });

  it('zero relevant gives no volume, India or pay points; volume saturates at 30', () => {
    expect(probeScore('ok', { relevant: 0, indiaOpen: 0, indiaUnknown: 0, payKnown: 0, payOk: 0 })).toBe(30);
    expect(probeScore('ok', { relevant: 147, indiaOpen: 147, indiaUnknown: 0, payKnown: 30, payOk: 6 })).toBe(Math.round((30 + 30 + 20 + (20 * (6 + 0.25 * 117)) / 147) * 10) / 10);
  });

  it('the pay term counts unknown at a quarter and known low pay at zero', () => {
    // 4 relevant: 1 at/above 40, 1 known below, 2 unknown -> 20 * (1 + 0.5) / 4 = 7.5
    const s = probeScore('ok', { relevant: 4, indiaOpen: 0, indiaUnknown: 0, payKnown: 2, payOk: 1 });
    expect(s).toBe(Math.round((30 + (30 * Math.log(5)) / Math.log(51) + 7.5) * 10) / 10);
  });
});

describe('the real pipeline decides relevance', () => {
  const stack = 'Java, Kafka, AWS and Kubernetes';
  it('the hours rule excludes a full-time contract; part-time stays relevant', async () => {
    const fullTime = hnComment(1, `SEEKING FREELANCER | Remote worldwide | We need a full-time remote contract role: ${stack}. $70/hour.`);
    const part = hnComment(2, `SEEKING FREELANCER | Remote worldwide | 10 hours per week, ${stack}. $70/hour.`);
    const out = await judgeGigs([fullTime, part], loaded, clock);
    const t = tallyGigs(out, { now: NOW, fitFloor: loaded.pack.freelance.fitFloor });
    expect(t.skillMatched).toBe(2);
    expect(t.fullTimeExcluded).toBe(1);
    expect(t.relevant).toBe(1);
  });

  it('counts the verdicts, the fit floor, India and pay from the real modules', async () => {
    const part = hnComment(2, `SEEKING FREELANCER | Remote worldwide | 10 hours per week, ${stack}. $70/hour.`);
    const t = tallyGigs(await judgeGigs([part], loaded, clock), { now: NOW, fitFloor: loaded.pack.freelance.fitFloor });
    expect(t.relevant).toBe(1);
    expect(t.payKnown).toBe(1);
    expect(t.payOk).toBe(1);
    expect(t.eligible + t.review).toBe(1);
    expect(t.aboveFloor).toBeLessThanOrEqual(1);
    expect(t.indiaOpen + t.indiaUnknown).toBeLessThanOrEqual(1);
  });

  it('a gig with fewer than two strong or medium skills is not relevant', async () => {
    const thin = hnComment(3, 'SEEKING FREELANCER | Remote worldwide | 10 hours per week, Java only. $70/hour.');
    const t = tallyGigs(await judgeGigs([thin], loaded, clock), { now: NOW, fitFloor: 45 });
    expect(t.skillMatched).toBe(0);
    expect(t.relevant).toBe(0);
  });
});

describe('sources probed', () => {
  it('lists the kept sources and the parked ones; GitHub, bounties and Algora are absent', () => {
    expect([...PROBE_SOURCE_IDS].sort()).toEqual(['arbeitnow', 'freelancer', 'golangprojects', 'himalayas', 'hn-freelancer', 'hn-hiring', 'remoteok', 'remotive', 'workingnomads', 'wwr']);
    expect(PARKED_IDS).toEqual(['arbeitnow', 'golangprojects', 'remoteok', 'workingnomads', 'wwr']);
    for (const id of PROBE_SOURCE_IDS) expect(id).not.toMatch(/github|algora|bount/i);
  });

  it('a probe run reports no GitHub or Algora row and asks Remotive once', async () => {
    const app = AppStore.open(':memory:');
    const fetch = keptFetch();
    const report = await runProbe(deps(app, { fetch }));
    app.close();
    expect(report.rows.map((r) => r.id).sort()).toEqual([...PROBE_SOURCE_IDS].sort());
    expect(JSON.stringify(report)).not.toMatch(/github|algora/i);
    expect(fetch.calls.filter((u) => u.startsWith('https://remotive.com/')).length).toBe(1);
    expect(fetch.calls.some((u) => /github|algora/.test(u))).toBe(false);
    const table = formatProbeTable(report);
    expect(table).toMatch(/Source\s+Score\s+Skill-matched\s+Relevant \(hours ok\)\s+Pass all rules\s+Review/);
    expect(table).toMatch(/Freelancer/);
  });

  it('the parked Working Nomads row measures the synthetic contract', async () => {
    const app = AppStore.open(':memory:');
    const report = await runProbe(deps(app));
    app.close();
    const wn = report.rows.find((r) => r.id === 'workingnomads');
    expect(wn?.relevant).toBe(1);
    expect(wn?.verdict).toBe('park');
  });
});

describe('--record', () => {
  it('writes every raw response as a fixture candidate', async () => {
    const app = AppStore.open(':memory:');
    const files = new Map<string, string>();
    const record = (name: string, text: string): void => void files.set(name, text);
    await runProbe(deps(app, { record }));
    app.close();
    expect(files.size).toBeGreaterThan(5);
    expect([...files.keys()].some((n) => n.startsWith('remotive'))).toBe(true);
    expect([...files.keys()].some((n) => n.startsWith('workingnomads'))).toBe(true);
  });

  it('assertRecordDir allows a scratch folder and refuses ~/.jobpilot, the home and tests/ unless forced', () => {
    const ok = tmp();
    expect(() => assertRecordDir(ok, { home: '/h/.jobpilot', repoRoot: root, force: false })).not.toThrow();
    expect(() => assertRecordDir(join(homedir(), '.jobpilot', 'raw'), { home: '/h/.jobpilot', repoRoot: root, force: false })).toThrow(/\.jobpilot/);
    expect(() => assertRecordDir('/h/.jobpilot/out/raw', { home: '/h/.jobpilot', repoRoot: root, force: false })).toThrow(/jobpilot home/);
    expect(() => assertRecordDir(join(root, 'tests/fixtures/x'), { home: '/h/.jobpilot', repoRoot: root, force: false })).toThrow(/tests/);
    expect(() => assertRecordDir(join(root, 'tests/fixtures/x'), { home: '/h/.jobpilot', repoRoot: root, force: true })).not.toThrow();
  });

  it('writes files through the command writer', async () => {
    const { fileRecorder } = await import('../../../src/app/freelance/probe.js');
    const dir = join(tmp(), 'raw');
    const rec = fileRecorder(dir);
    rec('remotive-api.json', '{"a":1}');
    expect(readdirSync(dir)).toEqual(['remotive-api.json']);
    expect(readFileSync(join(dir, 'remotive-api.json'), 'utf8')).toBe('{"a":1}');
  });
});

describe('assertRecordDir resolves symlinks and relative paths', () => {
  const home = () => {
    const h = tmp();
    return h;
  };
  it('refuses a symlink to the home and a symlink to tests/', () => {
    const h = home();
    const out = tmp();
    symlinkSync(h, join(out, 'to-home'));
    symlinkSync(join(root, 'tests'), join(out, 'to-tests'));
    const o = { home: h, repoRoot: root, force: false };
    expect(() => assertRecordDir(join(out, 'to-home', 'raw'), o)).toThrow(/jobpilot home/);
    expect(() => assertRecordDir(join(out, 'to-tests', 'x'), o)).toThrow(/tests/);
    expect(() => assertRecordDir(join(out, 'to-home', 'raw'), { ...o, force: true })).not.toThrow();
  });
  it('refuses a relative .jobpilot/x with cwd = HOME, and allows a normal scratch dir', () => {
    const cwd = process.cwd();
    try {
      process.chdir(homedir());
      expect(() => assertRecordDir('.jobpilot/x', { home: '/nowhere/h', repoRoot: root, force: false })).toThrow(/\.jobpilot/);
    } finally {
      process.chdir(cwd);
    }
    expect(() => assertRecordDir(join(tmp(), 'new', 'deeper'), { home: home(), repoRoot: root, force: false })).not.toThrow();
  });
  it('a sibling named like the root is not inside it', () => {
    const h = home();
    mkdirSync(`${h}-sibling`, { recursive: true });
    tmps.push(`${h}-sibling`);
    expect(() => assertRecordDir(`${h}-sibling/x`, { home: h, repoRoot: root, force: false })).not.toThrow();
  });
});

describe('probeCommand end to end', () => {
  it('runs on fixtures, writes the recorded files and returns the report', async () => {
    const h = tmp();
    mkdirSync(join(h, 'pack'), { recursive: true });
    const { cpSync } = await import('node:fs');
    cpSync(join(root, 'tests/fixtures/pack'), join(h, 'pack'), { recursive: true });
    const rec = join(tmp(), 'raw');
    const lines: string[] = [];
    const code = await probeCommand({ home: h, repoRoot: root, json: true, record: rec, force: false, clock, sleep: async () => {}, fetch: keptFetch(), get: parkedGet(), out: (l) => lines.push(l) });
    expect(code).toBe(0);
    const report = JSON.parse(lines.join('\n')) as { rows: { id: string }[] };
    expect(report.rows.map((r) => r.id).sort()).toEqual([...PROBE_SOURCE_IDS].sort());
    expect(readdirSync(rec).length).toBeGreaterThan(5);
  });
  it('takes the run lock: refuses while another jobpilot holds it, and writes nothing (final review M9)', async () => {
    const h = tmp();
    const { cpSync, existsSync, writeFileSync } = await import('node:fs');
    cpSync(join(root, 'tests/fixtures/pack'), join(h, 'pack'), { recursive: true });
    writeFileSync(join(h, LOCK_FILE), JSON.stringify({ pid: process.pid, command: 'run-freelance', at: 'now' }));
    const lines: string[] = [];
    await expect(probeCommand({ home: h, repoRoot: root, json: true, force: false, clock, sleep: async () => {}, fetch: keptFetch(), get: parkedGet(), out: (l) => lines.push(l) })).rejects.toThrow(
      /another jobpilot process \(pid \d+, run-freelance\) holds/,
    );
    expect(lines).toEqual([]);
    expect(existsSync(join(h, 'jobpilot.db'))).toBe(false);
  });
  it('counts a raw gig the normalizer refuses', async () => {
    const bad: RawGig = { platform: 'hn-freelancer', sourceId: '9', raw: { not: 'a comment' } };
    const r = await judgeGigsCounted([bad], loaded, clock);
    expect(r.rejectedByNormalizer).toBe(1);
    expect(r.outcomes).toEqual([]);
  });
});

describe('probe failures feed source health', () => {
  it('increments probe_failures for the current ISO week, once per failed source and run', async () => {
    const app = AppStore.open(':memory:');
    const week = isoWeek('2026-10-12');
    const first = await runProbe(deps(app, { fetch: keptFetch(['remotive.com']), get: parkedGet(['remoteok.com']) }));
    expect(first.rows.find((r) => r.id === 'remotive')?.access).toBe('failed');
    expect(app.sourceHealth('remotive').map((r) => [r.week, r.probeFailures, r.runs])).toEqual([[week, 1, 0]]);
    expect(app.sourceHealth('remoteok').map((r) => r.probeFailures)).toEqual([1]);
    expect(app.sourceHealth('freelancer')).toEqual([]);
    await runProbe(deps(app, { fetch: keptFetch(['remotive.com']) }));
    expect(app.sourceHealth('remotive').map((r) => r.probeFailures)).toEqual([2]);
    app.close();
  });
});

describe('promote rule', () => {
  const h = (a: number | undefined, b: number | undefined) => ({ remoteok: { ...(a === undefined ? {} : { '2026-09': a }), ...(b === undefined ? {} : { '2026-10': b }) } });
  it('promotes a parked source with relevant >= 5 in two consecutive monthly probes', () => {
    expect(promoteDue(h(5, 7), 'remoteok', '2026-10')).toBe(true);
    expect(promoteDue(h(4, 9), 'remoteok', '2026-10')).toBe(false);
    expect(promoteDue(h(9, 4), 'remoteok', '2026-10')).toBe(false);
    expect(promoteDue(h(undefined, 9), 'remoteok', '2026-10')).toBe(false);
  });
  it('months must be consecutive, across a year end too', () => {
    expect(promoteDue({ wwr: { '2026-08': 9, '2026-10': 9 } }, 'wwr', '2026-10')).toBe(false);
    expect(promoteDue({ wwr: { '2025-12': 6, '2026-01': 6 } }, 'wwr', '2026-01')).toBe(true);
  });
  it('the report says "promote: add an adapter" after a second qualifying month, and never auto-promotes', async () => {
    const app = AppStore.open(':memory:');
    const many = JSON.stringify(
      Array.from({ length: 6 }, (_, i) => ({ title: `Contract Java Kafka engineer ${i}`, url: `https://wn.test/${i}`, description: 'Contract, 10 hours per week, $60/hr. Java, Kafka, AWS, Kubernetes. Worldwide.', tags: 'java', location: 'Anywhere', pub_date: '2026-10-10T00:00:00Z' })),
    );
    const get: ParkedGet = async (url) => (new URL(url).hostname === 'www.workingnomads.com' ? { status: 200, text: many } : { status: 200, text: '[]' });
    const sept = await runProbe(deps(app, { get, clock: fixedClock('2026-09-12T04:00:00.000Z') }));
    expect(sept.rows.find((r) => r.id === 'workingnomads')?.verdict).toBe('park');
    const oct = await runProbe(deps(app, { get }));
    expect(oct.rows.find((r) => r.id === 'workingnomads')?.verdict).toBe('promote: add an adapter');
    expect(oct.promote).toEqual(['workingnomads']);
    // Re-probing in the same month keeps one entry for the month.
    const again = await runProbe(deps(app, { get }));
    expect(again.rows.find((r) => r.id === 'workingnomads')?.verdict).toBe('promote: add an adapter');
    app.close();
  });
});

describe('verify never runs the live probe', () => {
  it('the verify script does not name sources probe, and only the CLI imports probe.ts', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['verify']).not.toMatch(/probe|sources/);
    const importers = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /from '[^']*freelance\/probe\.js'|import\('[^']*probe\.js'\)/.test(readFileSync(join(root, 'src', f), 'utf8')));
    expect(importers).toEqual(['cli.ts']);
    expect(existsSync(join(root, 'src/app/freelance/probe.ts'))).toBe(true);
  });
});
