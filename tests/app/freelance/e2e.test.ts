import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, writeFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FREELANCE_REPLAY_HINT, runFreelance, type FreelanceRunOptions, type FreelanceSummary } from '../../../src/app/freelance/run.js';
import { resolvePdftotext } from '../../../src/app/kernel.js';
import { offlineProviders } from '../../../src/app/offline.js';
import { forbiddenTermStrict } from '../../../src/app/pack/rules.js';
import { docxText } from '../../../src/app/render/docx.js';
import { runFreelanceCommand } from '../../../src/app/run-command.js';
import { runDaily } from '../../../src/app/run.js';
import { AppStore } from '../../../src/app/store/app-store.js';

/**
 * Task 9 end to end: the freelance pipeline over recorded responses (`tests/fixtures/freelance-e2e`, the Task 4
 * Freelancer, Remotive and HN recordings plus the daily e2e boards with one contract posting added), on the
 * fictional pack. The daily run goes first, so the boards source has a stored contract job to seed.
 */
const root = join(import.meta.dirname, '../../..');
const FIXTURES = join(root, 'tests/fixtures/freelance-e2e');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();
const AM = '2026-10-12T03:00:00.000Z'; // 08:30 IST
const AM2 = '2026-10-12T03:30:00.000Z';
const PM = '2026-10-12T14:30:00.000Z'; // 20:00 IST
const NAMING = { forbiddenTerms: ['Initech'] };

const homes: string[] = [];
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-freelance-'));
  homes.push(home);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  return home;
}
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const sink = () => {
  const posted: string[] = [];
  return { posted, notifier: async (t: string) => void posted.push(t) };
};
const runAt = (home: string, at: string, extra: Partial<FreelanceRunOptions> = {}) =>
  runFreelance({ home, clock: { now: () => at }, fetch: offlineProviders(FIXTURES).fetch, sleep: async () => {}, pdftotext: pdftotext as string, ...extra });
const withApp = <T>(home: string, f: (app: AppStore) => T): T => {
  const app = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return f(app);
  } finally {
    app.close();
  }
};
function* files(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

describe.skipIf(pdftotext === undefined)('run-freelance end to end (offline fixtures)', () => {
  let home: string;
  let first: FreelanceSummary;
  let second: FreelanceSummary;
  const notes = sink();

  beforeAll(async () => {
    home = newHome();
    const off = offlineProviders(FIXTURES);
    await runDaily({ home, clock: { now: () => '2026-10-12T01:30:00.000Z' }, fetch: off.fetch, browser: off.browser, sleep: async () => {}, pdftotext: pdftotext as string });
    first = await runAt(home, AM, { notifier: notes.notifier });
    second = await runAt(home, AM2, { notifier: notes.notifier });
  }, 600_000);

  it('runs as freelance-<date>-am and fills all three lists, the board contract included', () => {
    expect(first.runId).toBe('freelance-2026-10-12-am');
    expect(first.report.status).toBe('completed');
    expect(first.exitCode).toBe(0);
    expect(first.projection.lists.contracts).toBeGreaterThan(0);
    expect(first.projection.lists.gigs).toBeGreaterThan(0);
    expect(first.projection.lists.review).toBeGreaterThan(0);
    const gigs = withApp(home, (app) => app.listGigs({ duplicates: true }));
    expect(new Set(gigs.map((g) => g.platform))).toEqual(new Set(['freelancer', 'remotive', 'hn-freelancer', 'hn-hiring', 'boards']));
    const board = gigs.filter((g) => g.platform === 'boards');
    expect(board.map((g) => g.title)).toEqual(['Backend Contractor (Go, TypeScript)']);
    // One row per gigKey: the four projects both the java and the typescript queries returned are one gig each.
    expect(new Set(gigs.map((g) => g.gigKey)).size).toBe(gigs.length);
    expect(gigs.filter((g) => ['40754937', '40752899', '40754075', '40761628'].includes(g.sourceId))).toHaveLength(4);
  });

  it('writes the documents of every shortlisted gig, on disk with their recorded sha256', () => {
    const out = join(home, 'out');
    const shortlisted = withApp(home, (app) => app.listGigs().filter((g) => g.list === 'contracts' || g.list === 'gigs').map((g) => app.getGig(g.gigKey)!));
    expect(shortlisted.length).toBeGreaterThan(0);
    for (const g of shortlisted) {
      expect(g.docsState, g.gigKey).toBe('ready');
      expect(g.docs.map((d) => `${d.kind}.${d.format}`).sort()).toEqual(g.kind === 'contract' ? ['pitch.txt', 'resume.docx', 'resume.pdf'] : ['proposal.txt', 'resume.docx', 'resume.pdf']);
      for (const d of g.docs) expect(createHash('sha256').update(readFileSync(join(out, d.path))).digest('hex')).toBe(d.sha256);
    }
    // Below the fit floor nothing is written.
    const below = withApp(home, (app) => app.listGigs().filter((g) => g.list === 'below-floor'));
    expect(below.length).toBeGreaterThan(0);
    for (const g of below) expect(existsSync(join(out, 'gigs', g.gigKey))).toBe(false);
  });

  it('has 0 forbidden-term hits in every output file', () => {
    const hits: string[] = [];
    let n = 0;
    for (const abs of files(join(home, 'out'))) {
      const body = abs.endsWith('.pdf') ? execFileSync(pdftotext as string, ['-layout', abs, '-'], { encoding: 'utf8' }) : abs.endsWith('.docx') ? docxText(readFileSync(abs)) : readFileSync(abs, 'utf8');
      n += 1;
      if (forbiddenTermStrict(body, NAMING) !== undefined) hits.push(relative(home, abs));
    }
    expect(n).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });

  it('posts the exact notification once, and only a posted one announces', () => {
    expect(first.notified).toBe(true);
    expect(notes.posted[0]).toBe(first.notification);
    expect(first.notification).toBe(EXPECTED_NOTIFICATION);
    expect(second.notification).toBe('No new gigs this morning');
    const fresh = withApp(home, (app) => app.listGigs().filter((g) => (g.list === 'contracts' || g.list === 'gigs') && g.docsState === 'ready'));
    expect(fresh.every((g) => g.notifiedAt === AM)).toBe(true);
  });

  it('counts source health for the ISO week, once per fetching run', () => {
    const rows = withApp(home, (app) => app.sourceHealth());
    expect(rows.map((r) => `${r.platform} ${r.week} runs=${r.runs}`)).toEqual([
      'boards 2026-W42 runs=1',
      'freelancer 2026-W42 runs=1',
      'hn-freelancer 2026-W42 runs=1',
      'hn-hiring 2026-W42 runs=1',
      'remotive 2026-W42 runs=1',
    ]);
    const fl = rows.find((r) => r.platform === 'freelancer')!;
    expect(fl.fetched).toBeGreaterThan(fl.eligible);
    expect(fl.shortlisted).toBeGreaterThan(0);
    expect(fl.failedRuns).toBe(0);
    expect(fl.probeFailures).toBe(0);
  });

  it('a second run in the same half replays every step at $0', () => {
    expect(second.runId).toBe('freelance-2026-10-12-am-2');
    const t = second.counts.totals;
    expect(t.done).toBeGreaterThan(0);
    expect(t.replayed).toBe(t.done + t.quarantined);
    expect(t.failed).toBe(0);
    expect(second.report.costUsd).toBe(0);
    expect(second.warnings).toContain(FREELANCE_REPLAY_HINT);
    expect(second.projection.gigs).toBe(first.projection.gigs);
    expect(second.projection.inserted).toBe(0);
  });

  it('the pm half fetches again but Remotive does not, and the am Remotive rows are kept', async () => {
    const before = withApp(home, (app) => app.listGigs({ duplicates: true }).filter((g) => g.platform === 'remotive'));
    expect(before.length).toBeGreaterThan(0);
    const pm = await runAt(home, PM);
    expect(pm.runId).toBe('freelance-2026-10-12-pm');
    expect(pm.counts.byAgent['src-freelancer']?.replayed).toBe(0);
    const after = withApp(home, (app) => app.listGigs({ duplicates: true }).filter((g) => g.platform === 'remotive'));
    expect(after).toEqual(before);
    const rows = withApp(home, (app) => app.sourceHealth());
    expect(rows.find((r) => r.platform === 'remotive')?.runs).toBe(1);
    expect(rows.find((r) => r.platform === 'freelancer')?.runs).toBe(2);
  }, 600_000);
});

/**
 * The banner of the first fixture run: 3 newly shortlisted gigs (the synthetic $70/h HN contract and two fixed-price
 * Freelancer gigs); the top is the contract (a stated rate ranks before an unknown one), its title cut to 40 characters.
 */
// 2, not 3, since Task 10 fix round 1: "Cross-Platform Multi-Purpose App Build" backs no term with a fact (covered 0/3) and goes to review.
const EXPECTED_NOTIFICATION = '2 new gigs ≥$40/h · top: $70/h SEEKING FREELANCER | Remote, worldwide… (HN)';

describe('run-freelance --if-due', () => {
  const deps = (home: string, at: string, out: string[]) => ({
    home, clock: { now: () => at }, notifier: async () => {}, out: (l: string) => out.push(l), err: () => {}, ...(pdftotext ? { pdftotext } : {}), sleep: async () => {},
  });

  it('before 07:30 IST does nothing and opens no DB', async () => {
    const home = newHome();
    const out: string[] = [];
    expect(await runFreelanceCommand({ offlineFixtures: FIXTURES, notify: true, ifDue: true }, deps(home, '2026-10-12T01:59:00.000Z', out))).toBe(0);
    expect(out).toEqual(['not due: before 07:30 IST']);
    expect(existsSync(join(home, 'jobpilot.db'))).toBe(false);
  });

  it('records its attempts in freelance-attempts.json, never in the daily file', async () => {
    const home = newHome();
    const out: string[] = [];
    // a policy the freelance pacing check refuses: the run cannot run (exit 2) and the attempt is recorded
    writeFileSync(join(home, 'pack/policy.user.yaml'), 'minHostIntervalMs: 40000\n');
    expect(await runFreelanceCommand({ offlineFixtures: FIXTURES, notify: false, ifDue: true }, deps(home, '2026-10-12T02:30:00.000Z', out))).toBe(2);
    expect(existsSync(join(home, 'freelance-attempts.json'))).toBe(true);
    expect(existsSync(join(home, 'daily-attempts.json'))).toBe(false);
    expect(await runFreelanceCommand({ offlineFixtures: FIXTURES, notify: false, ifDue: true }, deps(home, '2026-10-12T03:00:00.000Z', out))).toBe(0);
    expect(out.at(-1)).toBe('not due: the last attempt failed at 08:00 IST; retrying from 09:00 IST');
  });
});
