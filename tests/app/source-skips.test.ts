import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { sourceSkipWarnings } from '../../src/app/problems.js';
import { runDaily } from '../../src/app/run.js';
import { AppStore } from '../../src/app/store/app-store.js';
import type { FetchLike } from '../../src/kernel/providers.js';
import { Store } from '../../src/kernel/store/store.js';

/** Final minor: a source that skips some malformed jobs (but not all) says so in the run's warnings. */
const naming = { forbiddenTerms: ['Forbiddenco'] };
const ev = (s: Store, run: string, kind: string, data: Record<string, unknown>) => s.appendEvent(run, '2026-10-09T00:00:00Z', kind, data, 'p');

describe('sourceSkipWarnings', () => {
  it('sums the skips per agent over done and replayed steps (each step once), and names the first note', () => {
    const s = Store.open(':memory:');
    ev(s, 'r', 'step_done', { agent: 'src-lever', stepKey: 'a', skipped: 2, skippedNotes: ['page 1: lever x posting 3: missing id or text', 'n2'] });
    ev(s, 'r', 'step_replayed', { agent: 'src-lever', stepKey: 'b', status: 'done', skipped: 1, skippedNotes: ['page 1: lever y posting 0: missing id or text'] });
    ev(s, 'r', 'step_replayed', { agent: 'src-lever', stepKey: 'b', status: 'done', skipped: 1, skippedNotes: ['dup'] });
    ev(s, 'r', 'step_done', { agent: 'src-ashby', stepKey: 'c', skipped: 1, skippedNotes: ['ashby forbiddenco job 2: missing id or title'] });
    ev(s, 'r', 'step_done', { agent: 'src-greenhouse', stepKey: 'd', outputs: 3 });
    ev(s, 'other', 'step_done', { agent: 'src-jobicy', stepKey: 'e', skipped: 4, skippedNotes: [] });
    expect(sourceSkipWarnings(s, 'r', naming)).toEqual([
      '1 posting skipped by src-ashby as malformed (1 board; first: [hidden: contains a forbidden term])',
      '3 postings skipped by src-lever as malformed (2 boards; first: page 1: lever x posting 3: missing id or text)',
    ]);
    expect(sourceSkipWarnings(s, 'none', naming)).toEqual([]);
  });
});

const root = join(import.meta.dirname, '../..');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();
const GH = 'https://boards-api.greenhouse.io/v1/boards/example-gh/jobs?content=true&pay_transparency=true';

describe.skipIf(pdftotext === undefined)('a daily run with a partly malformed board', () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-skips-'));
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('warns "N postings skipped by <source>" in the summary and keeps it in the recorded run', async () => {
    const offline = offlineProviders(join(root, 'tests/fixtures/e2e'));
    const board = JSON.parse(readFileSync(join(root, 'tests/fixtures/e2e/greenhouse-example-gh.json'), 'utf8')) as { jobs: unknown[] };
    const broken = JSON.stringify({ ...board, jobs: [...board.jobs, { nope: 1 }, { title: 'no id' }] });
    const fetch: FetchLike = async (url, init) =>
      url === GH ? { status: 200, text: async () => broken } : offline.fetch(url, init);
    const s = await runDaily({ home, clock: { now: () => '2026-10-09T01:30:00.000Z' }, fetch, browser: offline.browser, notifier: async () => {}, sleep: async () => {}, pdftotext: pdftotext as string });
    const n = board.jobs.length;
    const warning = `2 postings skipped by src-greenhouse as malformed (1 board; first: greenhouse example-gh job ${n}: missing id or title)`;
    expect(s.warnings).toContain(warning);
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(app.latestRun('daily-')?.warnings).toContain(warning);
    } finally {
      app.close();
    }
  });
});
