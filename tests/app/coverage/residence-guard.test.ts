import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fullChainCheck, readBroken, readCheckpoint } from '../../../src/app/chain-status.js';
import { coverageProbeCommand } from '../../../src/app/coverage/probe.js';
import { AUDIT_INTERVAL_MS, AUDIT_PENDING_KEY, coverageRefusal, coverageScheduleLine, runCoverage } from '../../../src/app/coverage/run.js';
import { COVERAGE_START_FILE } from '../../../src/app/due.js';
import { runCoverageCommand } from '../../../src/app/run-command.js';
import { installSchedule, type Runner } from '../../../src/app/schedule.js';
import { AppStore } from '../../../src/app/store/app-store.js';
import { createDashboard } from '../../../src/app/web/server.js';
import { Sessions } from '../../../src/app/web/security.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import type { FetchLike } from '../../../src/kernel/providers.js';

/**
 * Coverage discovery is India-only (its discovery queries and the freehire evidence read India's tables), so for a
 * profile living elsewhere discovery is refused the way Task 21 refuses freelance: `coverage probe` refuses and the
 * dashboard's Companies tab shows the one-line notice instead of its lists. The weekly coverage job stays installed
 * all the same, because the weekly FULL AUDIT of the event chain lives in it: for such a profile `run-coverage` runs
 * only that audit (when one is due: no full check in the last 7 days), never any discovery.
 */
const repo = join(import.meta.dirname, '../../..');
const NOW = '2026-10-18T01:30:00.000Z'; // Sunday 07:00 IST: the coverage week is owed
const NOTICE = 'Coverage discovery is India-only for now; this profile lives in Germany (residence DE).';
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jobpilot-covguard-'));
  cpSync(join(repo, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const liveIn = (code: string): void => {
  const elig = readFileSync(join(home, 'pack/eligibility.yaml'), 'utf8').replace('residence: IN', `residence: ${code}`);
  writeFileSync(join(home, 'pack/eligibility.yaml'), elig);
};
const noNetwork: FetchLike = async (url) => {
  throw new Error(`no request may be made: ${url}`);
};
const REFUSED_AUDIT_ONLY = 'coverage discovery is India-only for now; this profile lives in Germany (residence DE); no discovery ran, only the weekly audit';

const withApp = <T>(f: (app: AppStore) => T): T => {
  const app = AppStore.open(join(home, 'jobpilot.db'), { schema: 'migrate' });
  try {
    return f(app);
  } finally {
    app.close();
  }
};
/** Three events on the chain and a full check recorded at `fullAt`. */
const seedChain = (fullAt: string): void =>
  withApp((app) => {
    for (let i = 0; i < 3; i++) app.kernel.appendEvent('daily-2026-10-01', '2026-10-01T02:00:00.000Z', 'step_done', { i }, 'h');
    fullChainCheck(app.kernel, fullAt);
  });
/** `run-coverage` (with notifications) on the test home; every request the fake fetch sees is listed. */
const coverage = async (opt: { now?: string; ifDue?: boolean } = {}) => {
  const requests: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const posted: string[] = [];
  const fetch: FetchLike = async (url) => {
    requests.push(String(url));
    throw new Error(`no request may be made: ${url}`);
  };
  const code = await runCoverageCommand(
    { notify: true, freehire: true, ...(opt.ifDue === true ? { ifDue: true } : {}) },
    { home, clock: { now: () => opt.now ?? NOW }, fetch, notifier: async (l) => void posted.push(l), out: (l) => out.push(...l.split('\n')), err: (l) => err.push(l), yieldCheck: () => null },
  );
  return { code, requests, out, err, posted };
};

describe('coverage outside India', () => {
  it('IN runs as before; DE is refused by name', () => {
    expect(coverageRefusal('IN')).toBeNull();
    expect(coverageRefusal('in')).toBeNull();
    expect(coverageRefusal('DE')).toBe('coverage discovery is India-only for now; this profile lives in Germany (residence DE); nothing ran');
    expect(coverageRefusal('UK')).toBe('coverage discovery is India-only for now; this profile lives in United Kingdom (residence GB); nothing ran');
  });

  it('run-coverage of a DE profile with a stale audit runs the full audit only: exit 0, no request, no run', async () => {
    liveIn('DE');
    seedChain('2026-10-05T03:30:00.000Z'); // 13 days before NOW: due
    const r = await coverage();
    expect(r.code).toBe(0);
    expect(r.requests).toEqual([]);
    expect(r.out.join('\n')).toBe([REFUSED_AUDIT_ONLY, 'audit: the event chain is intact (3 events, full check)'].join('\n'));
    expect(r.posted).toEqual([]);
    expect(r.err).toEqual([]);
    withApp((app) => {
      expect(readCheckpoint(app.kernel.db)).toMatchObject({ verifiedAt: NOW, fullCount: 3 });
      expect(app.kernel.db.prepare(`SELECT COUNT(*) AS n FROM runs`).get()).toEqual({ n: 0 });
      expect(app.listCompanies()).toEqual([]);
    });
  });

  it('run-coverage of a DE profile with a fresh audit (a full check within 7 days) runs nothing: exit 0', async () => {
    liveIn('DE');
    const fresh = new Date(Date.parse(NOW) - AUDIT_INTERVAL_MS + 60_000).toISOString();
    seedChain(fresh);
    const r = await coverage();
    expect(r.code).toBe(0);
    expect(r.requests).toEqual([]);
    expect(r.out.join('\n')).toBe([REFUSED_AUDIT_ONLY, `audit: the full check of the event chain is not due (the last one ran at ${fresh}; it runs weekly)`].join('\n'));
    withApp((app) => expect(readCheckpoint(app.kernel.db)?.verifiedAt).toBe(fresh));
  });

  it('an owed (deferred) audit of a DE profile runs even when the last full check is fresh, and the debt is cleared', async () => {
    liveIn('DE');
    seedChain(new Date(Date.parse(NOW) - 60_000).toISOString());
    withApp((app) => app.setSetting(AUDIT_PENDING_KEY, 'coverage-2026-10-11'));
    const r = await coverage();
    expect(r.code).toBe(0);
    expect(r.out[1]).toBe('audit: the event chain is intact (3 events, full check)');
    withApp((app) => {
      expect(app.getSetting(AUDIT_PENDING_KEY)).toBeUndefined();
      expect(readCheckpoint(app.kernel.db)?.verifiedAt).toBe(NOW);
    });
  });

  it('a DE profile with a broken chain: exit 1, an audit-broken problem, the broken line first in the notification; a week later only', async () => {
    liveIn('DE');
    seedChain('2026-10-05T03:30:00.000Z');
    withApp((app) => app.kernel.db.prepare(`UPDATE events SET data = '{"i":99}' WHERE seq = 2`).run());
    const r = await coverage();
    expect(r.code).toBe(1);
    expect(r.requests).toEqual([]);
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0]).toMatch(/^audit chain broken at seq 2: /);
    const text = r.out.join('\n');
    expect(text).toContain(REFUSED_AUDIT_ONLY);
    expect(text).toMatch(/\nproblems: 1\n  audit-broken {3}audit  seq 2: audit chain broken at seq 2: /);
    expect(text).toContain('AUDIT CHAIN BROKEN at seq 2: ');
    expect(text).toMatch(/\nnotification: audit chain broken at seq 2: /);
    withApp((app) => expect(readBroken(app.kernel.db)).toMatchObject({ seq: 2, at: NOW }));
    // the failed walk was a full check: the next half-hourly start does not walk (or notify) again within the week
    const again = await coverage({ now: new Date(Date.parse(NOW) + 30 * 60_000).toISOString() });
    expect(again.code).toBe(0);
    expect(again.posted).toEqual([]);
    expect(again.out[1]).toMatch(/^audit: the full check of the event chain is not due/);
  });

  it('the scheduled start (--if-due) of a DE profile asks no network and runs the due audit', async () => {
    liveIn('DE');
    seedChain('2026-10-05T03:30:00.000Z');
    const r = await coverage({ ifDue: true });
    expect(r.code).toBe(0);
    expect(r.requests).toEqual([]);
    expect(r.out.join('\n')).toBe([REFUSED_AUDIT_ONLY, 'audit: the event chain is intact (3 events, full check)'].join('\n'));
  });

  it('coverage probe refuses a DE profile with exit 2 and prints no report', async () => {
    AppStore.open(join(home, 'jobpilot.db'), { schema: 'migrate' }).close();
    liveIn('DE');
    const out: string[] = [];
    const err: string[] = [];
    const code = await coverageProbeCommand({ home, json: true, clock: fixedClock(NOW), out: (l) => out.push(l), err: (l) => err.push(l) });
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err).toEqual(['error: coverage discovery is India-only for now; this profile lives in Germany (residence DE); nothing ran']);
  });

  it('coverage probe of an IN profile still reports', async () => {
    AppStore.open(join(home, 'jobpilot.db'), { schema: 'migrate' }).close();
    const out: string[] = [];
    const code = await coverageProbeCommand({ home, json: true, clock: fixedClock(NOW), out: (l) => out.push(l), err: () => {} });
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n'))).toHaveProperty('version', 1);
  });
});

describe('the schedule keeps a non-IN profile\'s coverage job (it runs the weekly audit only)', () => {
  const node = '/opt/homebrew/Cellar/node/24.15.0/bin/node';
  const run: Runner = (_cmd, args) => (args[0] === '--version' ? { status: 0, stdout: 'v24.15.0\n', stderr: '' } : { status: 0, stdout: '', stderr: '' });
  const install = (agents: string) => {
    const root = join(home, 'root');
    const phome = join(root, 'profiles', 'lena');
    mkdirSync(phome, { recursive: true });
    cpSync(join(home, 'pack'), join(phome, 'pack'), { recursive: true });
    rmSync(join(phome, COVERAGE_START_FILE), { force: true });
    const r = installSchedule({ node, repo: '/Users/x/jobpilot', home: phome, profile: { id: 'lena', root }, uid: 501, agentsDir: join(home, agents), freelance: false, now: new Date('2026-10-14T00:00:00Z') }, run);
    return { r, phome };
  };
  it('a DE profile installs the coverage job with the same plist as IN and owes the first week the same way', () => {
    const inside = install('agents-in');
    const inPlist = readFileSync(join(home, 'agents-in', 'com.jobpilot.lena.coverage.plist'), 'utf8');
    liveIn('DE');
    const de = install('agents-de');
    expect(de.r.plists.map((p) => p.split('/').pop())).toEqual(['com.jobpilot.lena.daily.plist', 'com.jobpilot.lena.coverage.plist', 'com.jobpilot.dashboard.plist']);
    expect(readFileSync(join(home, 'agents-de', 'com.jobpilot.lena.coverage.plist'), 'utf8')).toBe(inPlist);
    expect(de.r.coverageFrom).toBe(inside.r.coverageFrom);
    expect(de.r.coverageFrom).not.toBeNull();
    expect(existsSync(join(de.phome, COVERAGE_START_FILE))).toBe(true);
  });
  it('the schedule output says the coverage job runs the weekly audit only (IN: no such line)', () => {
    expect(coverageScheduleLine('DE')).toBe('coverage run: weekly audit only (coverage discovery is India-only for now; this profile lives in Germany)');
    expect(coverageScheduleLine('uk')).toBe('coverage run: weekly audit only (coverage discovery is India-only for now; this profile lives in United Kingdom)');
    expect(coverageScheduleLine('IN')).toBeNull();
  });
});

describe('the Companies tab of a non-IN profile', () => {
  const start = () => {
    AppStore.open(join(home, 'jobpilot.db'), { schema: 'migrate' }).close();
    const raw = createDashboard({ home, clock: { now: () => NOW }, sessions: new Sessions(Buffer.alloc(32, 7)), resolve: { fetch: noNetwork, sleep: async () => {} } });
    let cookie = '';
    const req = async (p: string, init: RequestInit = {}) => {
      const r = await raw.request(p, { ...init, headers: { host: 'localhost', ...(cookie === '' ? {} : { cookie }), ...((init.headers as Record<string, string> | undefined) ?? {}) } });
      const set = /jp_sid=[0-9a-f]{32}/.exec(r.headers.get('set-cookie') ?? '')?.[0];
      if (set !== undefined) cookie = set;
      return { status: r.status, body: await r.text(), location: r.headers.get('location') };
    };
    return { req };
  };

  it('shows the one-line notice instead of the lists and the add form; IN keeps them', async () => {
    const { req } = start();
    const inPage = await req('/companies');
    expect(inPage.body).not.toContain('India-only');
    expect(inPage.body).toContain('aria-label="Company lists"');
    liveIn('DE');
    for (const p of ['/companies', '/companies/skipped']) {
      const page = await req(p);
      expect(page.status).toBe(200);
      expect(page.body).toContain(NOTICE);
      expect(page.body).not.toContain('aria-label="Company lists"');
      expect(page.body).not.toContain('name="website"');
    }
  });

  it('Add and Resolve now are refused with the notice (409), nothing is added or fetched', async () => {
    const { req } = start();
    const token = /name="_csrf" value="([0-9a-f]{64})"/.exec((await req('/companies')).body)?.[1] ?? '';
    expect(token).not.toBe('');
    liveIn('DE');
    const form = (f: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams({ _csrf: token, ...f }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' } });
    const add = await req('/companies/add', form({ name: 'Initech', website: 'https://initech.example' }));
    expect(add.status).toBe(409);
    expect(add.body).toContain(NOTICE);
    const resolve = await req('/companies/initech.example/resolve', form({}));
    expect(resolve.status).toBe(409);
    expect(resolve.body).toContain(NOTICE);
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(app.listCompanies()).toEqual([]);
    } finally {
      app.close();
    }
  });
});

describe('the runs page of a non-IN profile (the stale-audit banner and the full-check line)', () => {
  const runsPage = async (): Promise<string> => {
    const raw = createDashboard({ home, clock: { now: () => NOW }, sessions: new Sessions(Buffer.alloc(32, 7)), resolve: { fetch: noNetwork, sleep: async () => {} } });
    return (await raw.request('/runs', { headers: { host: 'localhost' } })).text();
  };
  it('says the weekly job runs the audit, without claiming coverage; IN keeps its text', async () => {
    seedChain('2026-10-05T03:30:00.000Z'); // 13 days: stale
    withApp((app) => app.kernel.appendEvent('daily-2026-10-17', NOW, 'step_done', { i: 3 }, 'h'));
    const inPage = await runsPage();
    expect(inPage).toContain('days ago (5 Oct 2026). Coverage runs it weekly; run &quot;jobpilot audit verify&quot; now.');
    expect(inPage).toContain('(it runs weekly with coverage, or run <code>jobpilot audit verify</code>)');
    liveIn('DE');
    const dePage = await runsPage();
    expect(dePage).toContain('The audit log&#39;s last full check was 13 days ago (5 Oct 2026). The scheduled job runs it weekly; run &quot;jobpilot audit verify&quot; now.');
    expect(dePage).toContain('(it runs weekly with the scheduled job, or run <code>jobpilot audit verify</code>)');
    expect(dePage).not.toContain('Coverage runs it');
    expect(dePage).not.toContain('with coverage');
  });
});

describe('a library caller of runCoverage (not the weekly job)', () => {
  it('is still refused for a DE profile with a PackError, and nothing is written', async () => {
    liveIn('DE');
    await expect(runCoverage({ home, clock: { now: () => NOW }, fetch: noNetwork, sleep: async () => {}, yieldCheck: () => null })).rejects.toThrow(
      'coverage discovery is India-only for now; this profile lives in Germany (residence DE); nothing ran',
    );
    withApp((app) => expect(app.kernel.db.prepare(`SELECT COUNT(*) AS n FROM runs`).get()).toEqual({ n: 0 }));
  });
});
