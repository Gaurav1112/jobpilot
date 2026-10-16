import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coverageProbeCommand } from '../../../src/app/coverage/probe.js';
import { coverageRefusal } from '../../../src/app/coverage/run.js';
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
 * profile living elsewhere the weekly coverage run is refused the way Task 21 refuses freelance: the run exits 2 and
 * records nothing, `coverage probe` refuses, the schedule leaves the profile's coverage job out, and the dashboard's
 * Companies tab shows the one-line notice instead of its lists.
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

describe('coverage outside India', () => {
  it('IN runs as before; DE is refused by name', () => {
    expect(coverageRefusal('IN')).toBeNull();
    expect(coverageRefusal('in')).toBeNull();
    expect(coverageRefusal('DE')).toBe('coverage discovery is India-only for now; this profile lives in Germany (residence DE); nothing ran');
    expect(coverageRefusal('UK')).toBe('coverage discovery is India-only for now; this profile lives in United Kingdom (residence GB); nothing ran');
  });

  it('run-coverage exits 2 for a DE profile, fetches nothing and writes no run', async () => {
    liveIn('DE');
    const err: string[] = [];
    const posted: string[] = [];
    const code = await runCoverageCommand({ notify: true, freehire: true }, { home, clock: { now: () => NOW }, fetch: noNetwork, notifier: async (l) => void posted.push(l), out: () => {}, err: (l) => err.push(l), yieldCheck: () => null });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('error: coverage discovery is India-only for now; this profile lives in Germany (residence DE); nothing ran');
    expect(posted).toEqual(['jobpilot run-coverage failed: coverage discovery is India-only for now; this profile lives in Germany (residence DE); nothing ran']);
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(app.kernel.db.prepare(`SELECT COUNT(*) AS n FROM runs`).get()).toEqual({ n: 0 });
      expect(app.listCompanies()).toEqual([]);
    } finally {
      app.close();
    }
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

describe('the schedule leaves a non-IN profile\'s coverage job out', () => {
  const node = '/opt/homebrew/Cellar/node/24.15.0/bin/node';
  const run: Runner = (_cmd, args) => (args[0] === '--version' ? { status: 0, stdout: 'v24.15.0\n', stderr: '' } : { status: 0, stdout: '', stderr: '' });
  it('coverage: false installs no coverage job and owes no first coverage week', () => {
    const root = join(home, 'root');
    const phome = join(root, 'profiles', 'lena');
    mkdirSync(phome, { recursive: true });
    const r = installSchedule({ node, repo: '/Users/x/jobpilot', home: phome, profile: { id: 'lena', root }, uid: 501, agentsDir: join(home, 'agents'), freelance: false, coverage: false, now: new Date('2026-10-14T00:00:00Z') }, run);
    expect(r.plists.map((p) => p.split('/').pop())).toEqual(['com.jobpilot.lena.daily.plist', 'com.jobpilot.dashboard.plist']);
    expect(r.coverageFrom).toBeNull();
    expect(existsSync(join(phome, COVERAGE_START_FILE))).toBe(false);
    expect(existsSync(join(home, 'agents', 'com.jobpilot.lena.coverage.plist'))).toBe(false);
  });
  it('without the option a profile keeps its coverage job (IN, unchanged)', () => {
    const root = join(home, 'root');
    const phome = join(root, 'profiles', 'asha');
    mkdirSync(phome, { recursive: true });
    const r = installSchedule({ node, repo: '/Users/x/jobpilot', home: phome, profile: { id: 'asha', root }, uid: 501, agentsDir: join(home, 'agents'), now: new Date('2026-10-14T00:00:00Z') }, run);
    expect(r.plists.some((p) => p.endsWith('com.jobpilot.asha.coverage.plist'))).toBe(true);
    expect(r.coverageFrom).not.toBeNull();
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
