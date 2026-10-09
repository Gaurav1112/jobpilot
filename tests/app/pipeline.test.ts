import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { srcLever } from '../../src/app/agents/sources/lever.js';
import { renderer } from '../../src/app/agents/writing/renderer.js';
import { appGuardrails } from '../../src/app/guardrails.js';
import { LOCK_FILE, LockError, withLock } from '../../src/app/lock.js';
import { appleScriptString, notificationFor } from '../../src/app/notify.js';
import { offlineProviders } from '../../src/app/offline.js';
import { compileDaily, DAILY_PIPELINE, dailyAgents, dailyPipeline, dailySeeds, pacingProblems } from '../../src/app/pipeline.js';
import { istDate, istMonth, pickRunId } from '../../src/app/run.js';
import { Store } from '../../src/kernel/store/store.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { defineAgent } from '../../src/kernel/agent.js';
import { defineContract } from '../../src/kernel/contract.js';
import { mergePolicy, PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';

const careersEntry = { company: 'Example Careers Co', ats: 'careers' as const, slug: 'example-careers', listUrl: 'https://careers.example.com/jobs', linkPattern: '^/jobs/', hiresInIndia: true, allRemote: false };
const leverEntry = { company: 'Example Lever Co', ats: 'lever' as const, slug: 'example-lv', hiresInIndia: true, allRemote: true };
const ghEntry = { company: 'Example Greenhouse Co', ats: 'greenhouse' as const, slug: 'example-gh', hiresInIndia: true, allRemote: false };
const ids = (agents: readonly { contract: { id: string } }[]) => agents.map((a) => a.contract.id).sort();

describe('the daily pipeline wiring', () => {
  it('wires every edge of spec §5, with careers agents when the watchlist has careers entries', () => {
    const agents = dailyAgents([ghEntry, careersEntry]);
    const p = dailyPipeline(agents);
    expect(`${p.id}@${p.version}`).toBe('jobpilot-daily@1.0.0');
    expect(DAILY_PIPELINE).toEqual({ id: 'jobpilot-daily', version: '1.0.0' });
    expect(p.seed.type.id).toBe('DiscoveryRequest@1');
    expect(p.edges.map((e) => `${e.type} -> ${e.to}`)).toEqual([
      'DiscoveryRequest@1 -> src-ashby',
      'DiscoveryRequest@1 -> src-greenhouse',
      'DiscoveryRequest@1 -> src-himalayas',
      'DiscoveryRequest@1 -> src-jobicy',
      'DiscoveryRequest@1 -> src-lever',
      'DiscoveryRequest@1 -> src-careers-list',
      'CareerLink@1 -> src-careers-job',
      'RawPosting@1 -> normalizer',
      'Posting@1 -> eligibility',
      'EligibilityVerdict@1 -> scorer-lexicon',
      'Scored@1 -> evidence-matcher',
      'Evidence@1 -> resume-planner',
      'ResumePlan@1 -> cover-writer',
      'CoverPlan@1 -> renderer',
      'Rendered@1 -> qa-gate',
    ]);
    expect(Object.fromEntries(p.teams.map((t) => [t.id, [...t.members].sort()]))).toEqual({
      sourcing: ['src-ashby', 'src-careers-job', 'src-careers-list', 'src-greenhouse', 'src-himalayas', 'src-jobicy', 'src-lever'],
      understanding: ['normalizer'],
      evaluation: ['eligibility', 'scorer-lexicon'],
      writing: ['cover-writer', 'evidence-matcher', 'qa-gate', 'renderer', 'resume-planner'],
    });
    const { compiled } = compileDaily(agents, appGuardrails());
    expect(compiled.routes.get('DiscoveryRequest@1')).toHaveLength(6);
    // the careers egress is the watchlist's careers hosts
    expect(agents.find((a) => a.contract.id === 'src-careers-list')?.contract.egress).toEqual(['careers.example.com']);
  });

  it('leaves the careers agents out when the watchlist has no careers entries', () => {
    const agents = dailyAgents([ghEntry, leverEntry]);
    expect(ids(agents)).not.toContain('src-careers-list');
    expect(ids(agents)).not.toContain('src-careers-job');
    const p = dailyPipeline(agents);
    expect(p.edges.some((e) => e.type === 'CareerLink@1')).toBe(false);
    expect(() => compileDaily(agents, appGuardrails())).not.toThrow();
  });

  it('no team breaker opens before its most tolerant member: the understanding team allows 10,000 failures', () => {
    const p = dailyPipeline(dailyAgents([careersEntry]));
    const breaker = Object.fromEntries(p.teams.map((t) => [t.id, t.breaker.consecutiveFailures]));
    expect(breaker['understanding']).toBe(10_000);
    expect(breaker['sourcing']).toBe(10); // src-careers-job's own breaker
    for (const t of p.teams) expect(t.exitGuarantees).toEqual([]);
  });

  it("refuses to compile when an agent breaks the capability allow-list (only the renderer may read the 'full' pack)", () => {
    const { emits: _e, ...spec } = renderer.contract;
    const sneaky = defineAgent(defineContract({ ...spec, id: 'eligibility', team: 'evaluation', emits: 'P1' }), async () => []);
    const agents = dailyAgents([ghEntry]).map((a) => (a.contract.id === 'eligibility' ? sneaky : a));
    expect(() => compileDaily(agents, appGuardrails())).toThrow(/capability allow-list.*eligibility declares capabilities\.pack 'full'/s);
  });
});

describe('pacing against the timeout arithmetic (M5)', () => {
  const pack = { watchlist: [leverEntry, careersEntry], feeds: { enabled: ['jobicy'] } };
  it('accepts the product policy', () => {
    expect(pacingProblems(PRODUCT_POLICY_V1, pack)).toEqual([]);
  });
  it('refuses a browser interval the careers step timeouts were not sized for, naming the setting', () => {
    const problems = pacingProblems(mergePolicy(PRODUCT_POLICY_V1, { minBrowserIntervalMs: 15_000 }), pack);
    expect(problems).toEqual([expect.stringMatching(/^minBrowserIntervalMs 15000 ms breaks the careers timeout arithmetic/)]);
  });
  it('refuses a host interval the Lever, Jobicy and careers budgets cannot absorb', () => {
    const problems = pacingProblems(mergePolicy(PRODUCT_POLICY_V1, { minHostIntervalMs: 13_000 }), pack);
    expect(problems.join('\n')).toMatch(/minHostIntervalMs 13000 ms breaks the src-lever timeout arithmetic/);
    expect(problems.join('\n')).toMatch(/minHostIntervalMs 13000 ms breaks the src-jobicy timeout arithmetic/);
    expect(problems.join('\n')).toMatch(/minHostIntervalMs 13000 ms breaks the careers timeout arithmetic/);
  });
  it('checks only the sources the run seeds', () => {
    const policy = mergePolicy(PRODUCT_POLICY_V1, { minHostIntervalMs: 13_000, minBrowserIntervalMs: 15_000 });
    expect(pacingProblems(policy, { watchlist: [ghEntry], feeds: { enabled: [] } })).toEqual([]);
  });
});

describe('seeds', () => {
  it('one per watchlist entry and one per known enabled feed, dated with the run date; unknown feeds are warned about', () => {
    const r = dailySeeds({ watchlist: [ghEntry, leverEntry, ghEntry], feeds: { enabled: ['himalayas', 'remoteok'] } }, '2026-10-09');
    expect(r.seeds).toEqual([
      { ats: 'greenhouse', slug: 'example-gh', company: 'Example Greenhouse Co', runDate: '2026-10-09' },
      { ats: 'lever', slug: 'example-lv', company: 'Example Lever Co', runDate: '2026-10-09' },
      { ats: 'feed', slug: 'himalayas', company: 'himalayas', runDate: '2026-10-09' },
    ]);
    expect(r.warnings).toEqual(['feed remoteok has no source agent; it was not fetched (known feeds: himalayas, jobicy)']);
  });
});

describe('IST dates', () => {
  it('takes the date and month in India from an ISO instant', () => {
    expect(istDate('2026-10-08T18:29:59.000Z')).toBe('2026-10-08');
    expect(istDate('2026-10-08T18:30:00.000Z')).toBe('2026-10-09');
    expect(istMonth('2026-10-31T18:30:00.000Z')).toBe('2026-11');
  });
});

describe('run ids', () => {
  it('daily-<date>, then -2, -3 after completed runs; a crashed run is resumed unless its policy differs', () => {
    const store = Store.open(':memory:');
    expect(pickRunId(store, 'daily-2026-10-09', 'p1')).toEqual({ runId: 'daily-2026-10-09', resume: false, skipped: [] });
    store.startRun('daily-2026-10-09', 'jobpilot-daily@1.0.0', 'p1', '2026-10-09T01:30:00Z');
    expect(pickRunId(store, 'daily-2026-10-09', 'p1')).toEqual({ runId: 'daily-2026-10-09', resume: true, skipped: [] });
    expect(pickRunId(store, 'daily-2026-10-09', 'p2')).toEqual({ runId: 'daily-2026-10-09-2', resume: false, skipped: ['daily-2026-10-09'] });
    store.finishRun('daily-2026-10-09', '2026-10-09T01:40:00Z');
    expect(pickRunId(store, 'daily-2026-10-09', 'p1')).toEqual({ runId: 'daily-2026-10-09-2', resume: false, skipped: [] });
    store.close();
  });
});

describe('the run lock', () => {
  let home: string | undefined;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('holds an exclusive lock file for the run and removes it after', async () => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-lock-'));
    const h = home;
    const seen = await withLock(h, 'run', async () => JSON.parse(readFileSync(join(h, LOCK_FILE), 'utf8')) as { pid: number; command: string });
    expect(seen).toMatchObject({ pid: process.pid, command: 'run' });
    expect(existsSync(join(h, LOCK_FILE))).toBe(false);
  });

  it('refuses a second holder while the first is alive, and releases on failure', async () => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-lock-'));
    const h = home;
    let release!: () => void;
    const first = withLock(h, 'run', () => new Promise<void>((r) => (release = r)));
    await expect(withLock(h, 'docs rebuild', async () => 1)).rejects.toThrow(LockError);
    await expect(withLock(h, 'docs rebuild', async () => 1)).rejects.toThrow(/another jobpilot process \(pid \d+, run\) holds/);
    release();
    await first;
    await expect(withLock(h, 'run', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(existsSync(join(h, LOCK_FILE))).toBe(false);
  });

  it('takes over a stale lock whose process is gone', async () => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-lock-'));
    writeFileSync(join(home, LOCK_FILE), JSON.stringify({ pid: 2 ** 22 + 12345, command: 'run', at: '2026-10-01T00:00:00Z' }));
    expect(await withLock(home, 'run', async () => 'ran')).toBe('ran');
  });
});

describe('the notification', () => {
  const naming = { employerDisplay: {}, forbiddenTerms: ['Initech'] };
  const job = (score: number, company: string, title: string) => ({ score, company, title });
  it('names the count and the top match, or says there is nothing new', () => {
    expect(notificationFor([job(72, 'Acme', 'Backend Engineer'), job(88, 'Example Co', 'Senior Backend Engineer')], naming)).toBe(
      '2 new matches · top: 88 Example Co — Senior Backend Engineer',
    );
    expect(notificationFor([], naming)).toBe('No new matches today');
  });
  it('never carries a forbidden term: the top match is left out', () => {
    expect(notificationFor([job(90, 'Initech Global', 'Backend Engineer')], naming)).toBe('1 new matches');
  });
  it('escapes text for an AppleScript string literal', () => {
    expect(appleScriptString('a "b" \\ c\nd')).toBe('"a \\"b\\" \\\\ c d"');
  });
});

describe('offline fixtures', () => {
  const dir = join(import.meta.dirname, '../fixtures/e2e');
  it('serves index.json URLs to fetch and HTML pages to the browser; anything else is a 404', async () => {
    const { fetch, browser } = offlineProviders(dir);
    const init = { signal: new AbortController().signal, redirect: 'manual' as const, headers: {} };
    const ok = await fetch('https://api.ashbyhq.com/posting-api/job-board/example-ab?includeCompensation=true', init);
    expect(ok.status).toBe(200);
    expect(JSON.parse(await ok.text())).toEqual({ jobs: [] });
    expect((await fetch('https://api.ashbyhq.com/elsewhere', init)).status).toBe(404);
    const page = await browser.render({ url: 'https://careers.example.com/jobs/lead-backend-engineer-payments', navigationHosts: [], deniedHosts: [], deniedBrands: [], maxBytes: 1e6, expand: false, signal: init.signal });
    expect(page.status).toBe(200);
    expect(page.jsonLd).toHaveLength(1);
    expect(page.text).toContain('Lead the payments team');
    const listing = await browser.render({ url: 'https://careers.example.com/jobs', navigationHosts: [], deniedHosts: [], deniedBrands: [], maxBytes: 1e6, expand: true, signal: init.signal });
    expect(listing.expansion).toEqual({ clicks: 0, scrolls: 0, capReached: false, unfollowedControls: [] });
  });
});

describe('pdftotext', () => {
  it('resolves an absolute path or fails naming the fix', () => {
    const r = (() => {
      try {
        return resolvePdftotext();
      } catch (e) {
        return e as Error;
      }
    })();
    if (r instanceof Error) expect(r.message).toMatch(/pdftotext not found.*brew install poppler/);
    else expect(r.startsWith('/')).toBe(true);
    expect(() => resolvePdftotext(['/no/such/pdftotext'])).toThrow(/pdftotext not found/);
  });
});

it('the lever source is in the daily agents', () => {
  expect(dailyAgents([]).map((a) => a.contract.id)).toContain(srcLever.contract.id);
});
