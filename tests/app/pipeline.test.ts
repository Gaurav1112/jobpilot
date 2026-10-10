import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { srcLever } from '../../src/app/agents/sources/lever.js';
import { renderer } from '../../src/app/agents/writing/renderer.js';
import { appGuardrails } from '../../src/app/guardrails.js';
import { capabilityProblems } from '../../src/app/allow-list.js';
import { LOCK_FILE, LockError, parseLstartUtc, withLock, type ProcessProbe } from '../../src/app/lock.js';
import { spawn, spawnSync } from 'node:child_process';
import { appleScriptString, notificationFor } from '../../src/app/notify.js';
import { offlineProviders } from '../../src/app/offline.js';
import { careersEgressSets, compileDaily, DAILY_PIPELINE, dailyAgents, dailyPipeline, dailySeeds, pacingProblems } from '../../src/app/pipeline.js';
import { failureNotification, istDate, istMonth, pickRunId } from '../../src/app/run.js';
import { Store } from '../../src/kernel/store/store.js';
import { loadRunPack, resolvePdftotext } from '../../src/app/kernel.js';
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
    // the careers egress is the symbolic set; the supervisor resolves it to the watchlist's careers hosts
    expect(agents.find((a) => a.contract.id === 'src-careers-list')?.contract.egress).toEqual(['pack:careers-hosts']);
    expect(careersEgressSets([ghEntry, careersEntry])).toEqual({ 'pack:careers-hosts': ['careers.example.com'] });
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

describe('R-I3: only the careers agents may name the symbolic careers egress', () => {
  it('refuses any other agent declaring pack:careers-hosts', () => {
    const evil = defineAgent(defineContract({ ...srcLever.contract, id: 'src-lever', egress: ['pack:careers-hosts', 'api.lever.co'] }), async () => []);
    const agents = dailyAgents([ghEntry, careersEntry]).map((a) => (a.contract.id === 'src-lever' ? evil : a));
    expect(() => compileDaily(agents, appGuardrails())).toThrow(
      /src-lever declares egress pack:careers-hosts; only src-careers-list, src-careers-job may contact the watchlist's careers sites/,
    );
    expect(capabilityProblems(dailyAgents([careersEntry]).map((a) => a.contract))).toEqual([]);
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
  it('one per watchlist entry and one per enabled feed, dated with the run date; refresh sets attempt', () => {
    const r = dailySeeds({ watchlist: [ghEntry, leverEntry, ghEntry], feeds: { enabled: ['himalayas'] } }, '2026-10-09');
    expect(r).toEqual([
      { ats: 'greenhouse', slug: 'example-gh', company: 'Example Greenhouse Co', runDate: '2026-10-09' },
      { ats: 'lever', slug: 'example-lv', company: 'Example Lever Co', runDate: '2026-10-09' },
      { ats: 'feed', slug: 'himalayas', company: 'himalayas', runDate: '2026-10-09' },
    ]);
    expect(dailySeeds({ watchlist: [ghEntry], feeds: { enabled: [] } }, '2026-10-09', 3)).toEqual([
      { ats: 'greenhouse', slug: 'example-gh', company: 'Example Greenhouse Co', runDate: '2026-10-09', attempt: 3 },
    ]);
    expect(dailySeeds({ watchlist: [ghEntry], feeds: { enabled: [] } }, '2026-10-09', 1)[0]).not.toHaveProperty('attempt');
    expect(() => dailySeeds({ watchlist: [], feeds: { enabled: ['remoteok'] } }, '2026-10-09')).toThrow(/unknown feed remoteok/);
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
    expect(pickRunId(store, 'daily-2026-10-09', 'p1')).toEqual({ runId: 'daily-2026-10-09', n: 1, resume: false, skipped: [] });
    store.startRun('daily-2026-10-09', 'jobpilot-daily@1.0.0', 'p1', '2026-10-09T01:30:00Z');
    expect(pickRunId(store, 'daily-2026-10-09', 'p1')).toEqual({ runId: 'daily-2026-10-09', n: 1, resume: true, skipped: [] });
    expect(pickRunId(store, 'daily-2026-10-09', 'p2')).toEqual({ runId: 'daily-2026-10-09-2', n: 2, resume: false, skipped: ['daily-2026-10-09'] });
    store.finishRun('daily-2026-10-09', '2026-10-09T01:40:00Z');
    expect(pickRunId(store, 'daily-2026-10-09', 'p1')).toEqual({ runId: 'daily-2026-10-09-2', n: 2, resume: false, skipped: [] });
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

  it('m2: a stale takeover is serialised by an exclusive takeover file; a dead takeover holder is cleared', async () => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-lock-'));
    const dead = 2 ** 22 + 12345;
    writeFileSync(join(home, LOCK_FILE), JSON.stringify({ pid: dead, command: 'run', at: 'x', token: 't1' }));
    // another live process is taking over right now: refuse, never delete under it
    writeFileSync(join(home, `${LOCK_FILE}.takeover`), JSON.stringify({ pid: process.pid, command: 'run', at: 'x', token: 't2' }));
    await expect(withLock(home, 'run', async () => 1)).rejects.toThrow(/taking over a stale lock/);
    expect(existsSync(join(home, LOCK_FILE))).toBe(true);
    // a takeover holder that died is cleared, and the stale lock is taken over
    writeFileSync(join(home, `${LOCK_FILE}.takeover`), JSON.stringify({ pid: dead, command: 'run', at: 'x', token: 't3' }));
    expect(await withLock(home, 'run', async () => 'ran')).toBe('ran');
    expect(existsSync(join(home, LOCK_FILE))).toBe(false);
    expect(existsSync(join(home, `${LOCK_FILE}.takeover`))).toBe(false);
  });

  it('m2: the lock file appears whole (written aside, then linked), so a crash never leaves an empty lock', async () => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-lock-'));
    const h = home;
    // a temp file left by a crash before the link blocks nothing
    writeFileSync(join(h, `${LOCK_FILE}.99999.tmp`), '');
    const body = await withLock(h, 'run', async () => JSON.parse(readFileSync(join(h, LOCK_FILE), 'utf8')) as { pid: number; token: string });
    expect(body.pid).toBe(process.pid);
    expect(body.token).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ruling 6: a lock is held only when both its pid and that process start time match, within 1 s (pid reuse is stale)', async () => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-lock-'));
    const h = home;
    const probe = (start: number): ProcessProbe => ({ alive: (pid) => pid === 4242 || pid === process.pid, startTime: (pid) => (pid === 4242 ? start : 1_790_000_000) });
    writeFileSync(join(h, LOCK_FILE), JSON.stringify({ pid: 4242, command: 'run', at: 'x', token: 'old', started: 1_791_000_000 }));
    // same pid, same start (and within the 1 s tolerance): held
    await expect(withLock(h, 'run', async () => 1, probe(1_791_000_000))).rejects.toThrow(/pid 4242, run/);
    await expect(withLock(h, 'run', async () => 1, probe(1_791_000_001))).rejects.toThrow(/pid 4242, run/);
    // a start time that cannot be read keeps the lock (fail closed)
    await expect(withLock(h, 'run', async () => 1, { alive: () => true, startTime: () => undefined })).rejects.toThrow(LockError);
    // same pid, another start: the pid was reused, so the lock is stale and is taken over
    const body = await withLock(h, 'run', async () => JSON.parse(readFileSync(join(h, LOCK_FILE), 'utf8')) as { started: number }, probe(1_791_000_005));
    expect(body.started).toBe(1_790_000_000);
  });

  it('R-I1: ps lstart is parsed in C/UTC into epoch seconds; the real probe records this process start', async () => {
    expect(parseLstartUtc('Fri Oct  9 14:13:37 2026')).toBe(Date.UTC(2026, 9, 9, 14, 13, 37) / 1000);
    expect(parseLstartUtc('金 10/ 9 19:43:55 2026')).toBeUndefined();
    expect(parseLstartUtc('Fri  9 Oct 19:43:55 2026')).toBeUndefined();
    home = mkdtempSync(join(tmpdir(), 'jobpilot-lock-'));
    const h = home;
    const body = await withLock(h, 'run', async () => JSON.parse(readFileSync(join(h, LOCK_FILE), 'utf8')) as { started: number });
    const expected = Date.now() / 1000 - process.uptime();
    expect(Math.abs(body.started - expected)).toBeLessThan(3);
  });

  it('R-I1: a live holder recorded under one TZ and locale is refused under any other', async () => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-lock-'));
    const h = home;
    const lockTs = join(import.meta.dirname, '../../src/app/lock.ts');
    const script = (body: string) => {
      const f = join(h, `s-${Math.random().toString(16).slice(2)}.mts`);
      writeFileSync(f, `import { withLock } from ${JSON.stringify(lockTs)};\n${body}`);
      return f;
    };
    const holder = spawn(process.execPath, ['--import', 'tsx', script(`await withLock(${JSON.stringify(h)}, 'run', () => new Promise((r) => setTimeout(r, 60_000)));`)], {
      env: { ...process.env, TZ: 'Asia/Kolkata', LC_ALL: 'en_GB.UTF-8', LANG: 'en_GB.UTF-8' }, stdio: 'ignore',
    });
    try {
      for (let i = 0; i < 100 && !existsSync(join(h, LOCK_FILE)); i++) await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(join(h, LOCK_FILE))).toBe(true);
      const check = script(`try { await withLock(${JSON.stringify(h)}, 'run', async () => 0); console.log('TOOK'); } catch (e) { console.log(e instanceof Error ? e.name : 'x'); }`);
      for (const env of [{ TZ: 'UTC' }, { LC_ALL: 'ja_JP.UTF-8', LANG: 'ja_JP.UTF-8' }, { TZ: 'America/Los_Angeles', LC_ALL: 'de_DE.UTF-8' }]) {
        const r = spawnSync(process.execPath, ['--import', 'tsx', check], { env: { ...process.env, ...env }, encoding: 'utf8' });
        expect(r.stdout.trim(), JSON.stringify(env)).toBe('LockError');
      }
    } finally {
      holder.kill('SIGKILL');
    }
  }, 60_000);

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
    expect(notificationFor([job(72, 'Acme', 'Backend Engineer')], naming)).toBe('1 new match · top: 72 Acme — Backend Engineer');
    expect(notificationFor([], naming)).toBe('No new matches today');
  });
  it('appends the problem count', () => {
    expect(notificationFor([job(72, 'Acme', 'Backend Engineer')], naming, 2)).toBe('1 new match · top: 72 Acme — Backend Engineer · 2 problems');
    expect(notificationFor([], naming, 1)).toBe('No new matches today · 1 problem');
  });
  it('never carries a forbidden term: the top match is left out, and a term in the fixed words falls back', () => {
    expect(notificationFor([job(90, 'Initech Global', 'Backend Engineer')], naming)).toBe('1 new match');
    expect(notificationFor([job(90, 'Acme', 'Backend')], { forbiddenTerms: ['match'] })).toBe('jobpilot run finished');
  });
  it('folds line breaks and drops control characters (m3)', () => {
    expect(notificationFor([job(80, 'Acme\nCorp', 'Back\u0000end\tEngineer')], naming)).toBe('1 new match · top: 80 Acme Corp — Backend Engineer');
    expect(appleScriptString('a\u0000b\u0007c')).toBe('"abc"');
  });
  it('escapes text for an AppleScript string literal', () => {
    expect(appleScriptString('a "b" \\ c\nd')).toBe('"a \\"b\\" \\\\ c d"');
  });
});

describe('the failure notification (I1)', () => {
  it('names the first line of the error, unless it holds a forbidden term or the naming rules cannot be read', () => {
    expect(failureNotification(new Error('refusing to start:\n- minHostIntervalMs 40000 ms breaks …'), ['Initech'])).toBe('jobpilot run failed: refusing to start:');
    expect(failureNotification(new Error('pack: Initech appears'), ['Initech'])).toBe('jobpilot run failed; see the log');
    expect(failureNotification(new Error('anything'), undefined)).toBe('jobpilot run failed; see the log');
  });

  it('never shows a fragment of a term split across lines, glued or not (rereview-2 M5)', () => {
    const leaks = (s: string) => /ini|tech/i.test(s.replace(/^jobpilot run failed[:;] ?/, ''));
    for (const m of ['pack bad near Ini-\ntech', 'pack bad near Ini\ntech', 'pack bad near Ini-\ntechPay', 'pack bad near Ini- techPay', 'pack bad near I n i\nt e c h', 'pack bad near Ini\n-\ntech', 'pack bad near Ini\n\n\ntech']) {
      const note = failureNotification(new Error(m), ['Initech']);
      expect(note, JSON.stringify(m)).toBe('jobpilot run failed; see the log');
      expect(leaks(note)).toBe(false);
    }
    // a clean first line is still named when the term is only on a later, separate line
    expect(failureNotification(new Error('refusing to start:\n- fact id InitechPay-01 is duplicated'), ['Initech'])).toBe('jobpilot run failed: refusing to start:');
  });

  it('for pack text problems, says how many and points to `jobpilot pack check`, never echoing a term (rereview R11)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jp-r11-'));
    try {
      cpSync(join(import.meta.dirname, '../fixtures/pack'), dir, { recursive: true });
      const f = join(dir, 'facts.yaml');
      writeFileSync(f, readFileSync(f, 'utf8').replace('on Kafka handling 40M events a day.', 'on Kafka for InitechPay handling 40M events a day.'));
      writeFileSync(join(dir, 'answers.yaml'), readFileSync(join(dir, 'answers.yaml'), 'utf8').replace('notice_period: 30 days', 'notice_period: 30 days per InitechHR'));
      let err: unknown;
      try {
        loadRunPack(dir, {}, '2026-10');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      const note = failureNotification(err, ['Initech']);
      expect(note).toBe('jobpilot run failed: the pack has 2 text problems; nothing runs until they are fixed (`jobpilot pack check` lists them)');
      expect(note).not.toMatch(/initech/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
