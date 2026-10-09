import { cpSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diskDocCheck } from '../../src/app/docs-check.js';
import { LockError } from '../../src/app/lock.js';
import { offlineProviders } from '../../src/app/offline.js';
import { rebuildDocs, REFRESH_HINT, runDaily, type DailySummary, type RunOutcome } from '../../src/app/run.js';
import { AppStore, type JobView } from '../../src/app/store/app-store.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import type { AgentCounts } from '../../src/app/project.js';

/**
 * The daily product end to end: the fictional fixture pack, recorded-shape fixture boards served offline (index.json
 * maps URL -> file; the careers pages go through the offline browser), the real pipeline, renderer, qa-gate (real
 * pdftotext), projector and notification.
 */
const root = join(import.meta.dirname, '../..');
const FIXTURES = join(root, 'tests/fixtures/e2e');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();

const SOURCES = ['src-ashby', 'src-careers-job', 'src-careers-list', 'src-greenhouse', 'src-himalayas', 'src-jobicy', 'src-lever'];
const PACK_READERS = ['eligibility', 'scorer-lexicon', 'evidence-matcher', 'resume-planner', 'cover-writer', 'renderer', 'qa-gate', 'src-careers-list'];
const WRITING = ['evidence-matcher', 'resume-planner', 'cover-writer', 'renderer', 'qa-gate'];

let home: string;
let now = '2026-10-09T01:30:00.000Z'; // 07:00 IST
const clock = { now: () => now };
const notes: string[] = [];
const notifier = async (text: string) => void notes.push(text);
let offline: ReturnType<typeof offlineProviders>;

const run = (): Promise<DailySummary> =>
  runDaily({ home, clock, fetch: offline.fetch, browser: offline.browser, notifier, sleep: async () => {}, pdftotext: pdftotext as string });
const jobs = (): JobView[] => {
  const app = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return app.listJobs({ band: ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'] });
  } finally {
    app.close();
  }
};
const docsOf = (jobKey: string) => {
  const app = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return app.getJob(jobKey)?.docs ?? [];
  } finally {
    app.close();
  }
};
const byAgent = (s: RunOutcome): Record<string, AgentCounts> => s.counts.byAgent;
/** Agents that executed at least one step (not answered from the store). */
const executed = (s: RunOutcome): string[] =>
  Object.entries(byAgent(s))
    .filter(([, c]) => c.done + c.quarantined + c.failed - c.replayed > 0)
    .map(([a]) => a)
    .sort();

describe.skipIf(pdftotext === undefined)('jobpilot run, end to end (offline fixtures)', () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-e2e-'));
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: [himalayas]\n');
    offline = offlineProviders(FIXTURES);
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  let first: DailySummary;
  let readyShas: Map<string, string>;

  it('run 1: rows and verdicts, ready grounded documents on disk, and the notification', async () => {
    first = await run();
    expect(first.runId).toBe('daily-2026-10-09');
    expect(first.runDate).toBe('2026-10-09');
    expect(first.report.status).toBe('completed');
    expect(first.warnings).toEqual([]);

    const rows = Object.fromEntries(jobs().map((j) => [j.title, { verdict: j.verdict, docs: j.docsState, company: j.company }]));
    expect(rows).toEqual({
      'Senior Backend Engineer': { verdict: 'eligible', docs: 'ready', company: 'Example Greenhouse Co' },
      'Backend Engineer': { verdict: 'rejected', docs: 'none', company: 'Example Greenhouse Co' },
      'Software Engineer': { verdict: 'eligible', docs: 'below-floor', company: 'Example Greenhouse Co' },
      'Senior Frontend Engineer': { verdict: 'rejected', docs: 'none', company: 'Example Greenhouse Co' },
      'Staff Platform Engineer': { verdict: 'eligible', docs: 'ready', company: 'Example Lever Co' },
      'Lead Backend Engineer, Payments': { verdict: 'eligible', docs: 'ready', company: 'Example Careers Co' },
      'Backend Developer': { verdict: 'review', docs: 'below-floor', company: 'Example Feed Co' },
    });

    // every ready job lists six files, each on disk with its recorded sha256
    const check = diskDocCheck(join(home, 'out'));
    readyShas = new Map();
    for (const j of jobs().filter((x) => x.docsState === 'ready')) {
      const docs = docsOf(j.jobKey);
      expect(docs.map((d) => `${d.kind}.${d.format}`).sort()).toEqual(['cover.docx', 'cover.html', 'cover.pdf', 'resume.docx', 'resume.html', 'resume.pdf']);
      for (const d of docs) {
        expect(check(d.path, d.sha256), d.path).toBe('ok');
        readyShas.set(d.path, d.sha256);
      }
    }
    expect(readyShas.size).toBe(18);

    // grounding 1.0: no step quarantined anywhere, writing team included; nothing failed or skipped
    expect(first.counts.totals.quarantined).toBe(0);
    for (const a of WRITING) expect(byAgent(first)[a]?.quarantined ?? 0, a).toBe(0);
    expect(first.counts.totals.failed).toBe(0);
    expect(first.counts.totals.skipped).toBe(0);
    expect(first.projection.unresolvedQuarantines).toBe(0);
    expect(first.projection.docs.ready).toBe(3);

    const top = jobs().filter((j) => j.docsState === 'ready').sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] as JobView;
    expect(first.notification).toBe(`3 new matches · top: ${top.score} ${top.company} — ${top.title}`);
    expect(notes).toEqual([first.notification]);
  });

  it('run 2, same day: a new run id, every step replays (sources included) and the documents keep their sha', async () => {
    const fetched = offline.fetch.calls.length;
    const rendered = offline.browser.calls.length;
    now = '2026-10-09T04:30:00.000Z';
    const second = await run();
    expect(second.runId).toBe('daily-2026-10-09-2');
    for (const [agent, c] of Object.entries(byAgent(second))) {
      // every non-source step is replayed: replayed equals the step count
      if (!SOURCES.includes(agent)) expect(c.replayed, agent).toBe(c.done + c.quarantined);
    }
    expect(executed(second)).toEqual([]);
    // the seeds carry the run date, so on the same day the sources replay too: nothing is fetched again
    expect(offline.fetch.calls.length).toBe(fetched);
    expect(offline.browser.calls.length).toBe(rendered);
    expect(second.report.replayed).toBe(second.counts.totals.done + second.counts.totals.quarantined);
    for (const j of jobs().filter((x) => x.docsState === 'ready')) for (const d of docsOf(j.jobKey)) expect(readyShas.get(d.path), d.path).toBe(d.sha256);
    // m8: a job is announced once; a second run the same day has nothing new
    expect(second.notification).toBe('No new matches today');
    expect(second.warnings).toEqual([REFRESH_HINT]);
    expect(second.exitCode).toBe(0);
  });

  it('run --refresh, same day: the sources fetch again (attempt = the run ordinal); every other step replays; docs keep their sha', async () => {
    const fetched = offline.fetch.calls.length;
    now = '2026-10-09T04:45:00.000Z';
    const r = await runDaily({ home, clock, fetch: offline.fetch, browser: offline.browser, notifier, sleep: async () => {}, pdftotext: pdftotext as string, refresh: true });
    expect(r.runId).toBe('daily-2026-10-09-3');
    expect(r.refresh).toBe(true);
    for (const [agent, c] of Object.entries(byAgent(r))) {
      if (agent.startsWith('src-') && agent !== 'src-careers-job') expect(c.replayed, agent).toBe(0);
      else expect(c.replayed, agent).toBe(c.done + c.quarantined);
    }
    expect(offline.fetch.calls.length).toBeGreaterThan(fetched);
    const sourceSteps = Object.entries(byAgent(r)).filter(([a]) => a.startsWith('src-') && a !== 'src-careers-job').reduce((n, [, c]) => n + c.done, 0);
    expect(r.report.replayed).toBe(r.counts.totals.done - sourceSteps);
    expect(r.warnings).toEqual([]);
    expect(r.notification).toBe('No new matches today');
    // every announced job carries the time it was announced, from run 1
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      const ready = app.listJobs({}).filter((j) => j.docsState === 'ready');
      expect(ready.map((j) => j.notifiedAt)).toEqual(ready.map(() => '2026-10-09T01:30:00.000Z'));
    } finally {
      app.close();
    }
    for (const j of jobs().filter((x) => x.docsState === 'ready')) for (const d of docsOf(j.jobKey)) expect(readyShas.get(d.path), d.path).toBe(d.sha256);
  });

  it('a fact override re-runs only the pack-reading steps', async () => {
    const app = AppStore.open(join(home, 'jobpilot.db'));
    app.setFactOverride('f-nw-05', 'verified', now);
    app.close();
    now = '2026-10-09T05:30:00.000Z';
    const third = await run();
    expect(third.runId).toBe('daily-2026-10-09-4');
    expect(third.packHash).not.toBe(first.packHash);
    // the careers job, normalizer and API sources replay; every pack reader runs again
    expect(executed(third)).toEqual([...PACK_READERS].sort());
    for (const a of PACK_READERS) expect(byAgent(third)[a]?.replayed ?? 0, a).toBe(0);
    for (const a of ['normalizer', 'src-careers-job', 'src-greenhouse', 'src-lever']) expect(byAgent(third)[a]?.replayed, a).toBe(byAgent(third)[a]?.done);
    expect(third.counts.totals.quarantined).toBe(0);
  });

  it('a new month (from the clock) moves experience.asOf, so the pack-reading steps re-run', async () => {
    now = '2026-11-02T01:30:00.000Z';
    const before = offline.fetch.calls.length;
    const nov = await run();
    expect(nov.runId).toBe('daily-2026-11-02');
    expect(nov.asOf).toBe('2026-11');
    expect(nov.packHash).not.toBe(first.packHash);
    for (const a of PACK_READERS) expect(byAgent(nov)[a]?.replayed ?? 0, a).toBe(0);
    // a new run date fetches again; the same postings come back, so the normalizer replays
    expect(offline.fetch.calls.length).toBeGreaterThan(before);
    expect(byAgent(nov)['normalizer']?.replayed).toBe(byAgent(nov)['normalizer']?.done);
    expect(nov.counts.totals.quarantined).toBe(0);
    expect(nov.projection.docs.ready).toBe(3);
    // nothing first seen today
    expect(nov.notification).toBe('No new matches today');
  });

  it('a deleted document heals on the next run (I1); docs rebuild re-runs only the renderer and the qa-gate replays when the bytes are identical', async () => {
    const ready = jobs().filter((j) => j.docsState === 'ready');
    const target = ready[0] as JobView;
    const [doc] = docsOf(target.jobKey);
    unlinkSync(join(home, 'out', doc!.path));

    now = '2026-11-02T03:00:00.000Z';
    const missing = await run();
    expect(missing.runId).toBe('daily-2026-11-02-2');
    // review I1: the renderer's replay finds the deleted file and renders that job again; nothing else runs
    expect(jobs().find((j) => j.jobKey === target.jobKey)?.docsState).toBe('ready');
    expect(existsSync(join(home, 'out', doc!.path))).toBe(true);
    expect(executed(missing)).toEqual(['renderer']);
    expect((byAgent(missing)['renderer']?.done ?? 0) - (byAgent(missing)['renderer']?.replayed ?? 0)).toBe(1);
    expect(missing.problems).toEqual([]);

    now = '2026-11-02T03:30:00.000Z';
    const r = await rebuildDocs({ home, clock, sleep: async () => {}, pdftotext: pdftotext as string });
    expect(r.runId).toBe('rebuild-2026-11-02');
    expect(r.from).toBe('daily-2026-11-02-2');
    expect(r.fullPackHash).not.toBe(missing.fullPackHash);
    expect(r.packHash).toBe(missing.packHash);
    // only the renderer and the qa-gate exist in a rebuild; the renderer renders again, the qa-gate replays
    expect(Object.keys(byAgent(r)).sort()).toEqual(['qa-gate', 'renderer']);
    expect(executed(r)).toEqual(['renderer']);
    expect(byAgent(r)['qa-gate']?.replayed).toBe(3);
    expect(r.problems).toEqual([]);
    expect(r.changes.map((c) => `${c.from}->${c.to}`)).toEqual(['ready->ready', 'ready->ready', 'ready->ready']);
    expect(r.notRebuilt).toEqual([]);
    expect(existsSync(join(home, 'out', doc!.path))).toBe(true);
    const after = jobs().find((j) => j.jobKey === target.jobKey);
    expect(after?.docsState).toBe('ready');
    for (const d of docsOf(target.jobKey)) expect(diskDocCheck(join(home, 'out'))(d.path, d.sha256)).toBe('ok');

    // the nonce is kept: the next daily run replays the rebuilt renderer steps
    now = '2026-11-02T04:00:00.000Z';
    const next = await run();
    expect(next.fullPackHash).toBe(r.fullPackHash);
    expect(executed(next)).toEqual([]);
  });

  it('the lock refuses a concurrent run', async () => {
    now = '2026-11-02T05:00:00.000Z';
    const a = run();
    await expect(run()).rejects.toThrow(LockError);
    await expect(rebuildDocs({ home, clock, sleep: async () => {}, pdftotext: pdftotext as string })).rejects.toThrow(LockError);
    const done = await a;
    expect(done.report.status).toBe('completed');
  });

  it('a crashed run resumes under its own id the next time', async () => {
    now = '2026-11-03T01:30:00.000Z';
    const crash = (n: number) => {
      if (n === 12) throw new Error('simulated crash');
    };
    await expect(
      runDaily({ home, clock, fetch: offline.fetch, browser: offline.browser, notifier, sleep: async () => {}, pdftotext: pdftotext as string, afterStep: crash }),
    ).rejects.toThrow('simulated crash');
    const resumed = await run();
    expect(resumed.runId).toBe('daily-2026-11-03');
    expect(resumed.resumed).toBe(true);
    expect(resumed.report.status).toBe('completed');
    expect(resumed.projection.docs.ready).toBe(3);
    expect((await run()).runId).toBe('daily-2026-11-03-2');
  });

  it('names every problem: a broken board fails, a missing board is gone; the notification counts them and the run exits 1', async () => {
    now = '2026-11-04T01:30:00.000Z';
    const broken = Object.assign(
      async (url: string, init: Parameters<typeof offline.fetch>[1]) =>
        url.includes('example-ab') ? { status: 200, text: async () => '<html>maintenance</html>' } : url.includes('example-lv') ? { status: 404, text: async () => 'nope' } : offline.fetch(url, init),
      { calls: [] as string[] },
    );
    const s = await runDaily({ home, clock, fetch: broken, browser: offline.browser, notifier, sleep: async () => {}, pdftotext: pdftotext as string });
    expect(s.problems).toEqual([
      { kind: 'failed', agent: 'src-ashby', item: 'Example Ashby Co (ashby:example-ab)', reason: expect.stringMatching(/^invalid_output: response from api\.ashbyhq\.com is not valid JSON/) },
      { kind: 'gone', agent: 'src-lever', item: 'Example Lever Co (lever:example-lv)', reason: 'gone: board not found: example-lv' },
    ]);
    expect(s.exitCode).toBe(1);
    expect(s.notification).toBe('No new matches today · 2 problems');
    expect(notes.at(-1)).toBe(s.notification);
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(app.latestRun('daily-')).toMatchObject({ runId: s.runId, problems: s.problems, warnings: s.warnings });
    } finally {
      app.close();
    }
  });

  it('a gone board alone is a problem but not a failure: exit code 0 (ruling 4)', async () => {
    now = '2026-11-05T01:30:00.000Z';
    const gone = Object.assign(
      async (url: string, init: Parameters<typeof offline.fetch>[1]): Promise<{ status: number; text: () => Promise<string> }> => (url.includes('example-lv') ? { status: 404, text: async () => 'nope' } : offline.fetch(url, init)),
      { calls: [] as string[] },
    );
    const s = await runDaily({ home, clock, fetch: gone, browser: offline.browser, notifier, sleep: async () => {}, pdftotext: pdftotext as string });
    expect(s.problems.map((p) => p.kind)).toEqual(['gone']);
    expect(s.notification).toBe('No new matches today · 1 problem');
    expect(s.exitCode).toBe(0);
  });

  it('m1: a crash right after a replayed step does not count that replay twice when the run resumes', async () => {
    now = '2026-11-06T04:00:00.000Z';
    await run(); // after this, every step of a same-day run replays
    now = '2026-11-06T04:30:00.000Z';
    await expect(
      runDaily({ home, clock, fetch: offline.fetch, browser: offline.browser, notifier, sleep: async () => {}, pdftotext: pdftotext as string, afterStep: (n) => {
        if (n === 20) throw new Error('crash after a replay');
      } }),
    ).rejects.toThrow('crash after a replay');
    const resumed = await run();
    expect(resumed.resumed).toBe(true);
    for (const [agent, c] of Object.entries(byAgent(resumed))) expect(c.replayed, agent).toBeLessThanOrEqual(c.done + c.quarantined);
    expect(resumed.report.replayed).toBe(resumed.counts.totals.replayed);
  });

  it('warns about an incomplete daily run from an earlier date on every run (m5)', async () => {
    const app = AppStore.open(join(home, 'jobpilot.db'));
    app.kernel.startRun('daily-2026-10-01', 'jobpilot-daily@1.0.0', 'old-policy', '2026-10-01T01:30:00.000Z');
    app.close();
    now = '2026-11-06T05:30:00.000Z';
    const s = await run();
    expect(s.warnings).toContain('run daily-2026-10-01 never completed and is from an earlier date; it will not be resumed');
  });

  it('refuses to start when the pack policy breaks the pacing arithmetic, naming the setting', async () => {
    writeFileSync(join(home, 'pack/policy.user.yaml'), 'minBrowserIntervalMs: 20000\n');
    await expect(run()).rejects.toThrow(/minBrowserIntervalMs 20000 ms breaks the careers timeout arithmetic/);
    writeFileSync(join(home, 'pack/policy.user.yaml'), 'maxUsdPerRun: 1\n');
  });
});
