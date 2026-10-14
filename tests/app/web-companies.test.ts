import { cpSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { RunGate } from '../../src/app/coverage/gate.js';
import { registryPickItems } from '../../src/app/coverage/seed.js';
import { resolveCompany } from '../../src/app/coverage/resolve.js';
import { runCoverage } from '../../src/app/coverage/run.js';
import type { CompanyVerdict } from '../../src/app/coverage/types.js';
import { withLock } from '../../src/app/lock.js';
import { offlineProviders } from '../../src/app/offline.js';
import { registryBoards } from '../../src/app/pipeline.js';
import { ADDED_PICK_REASON, AppStore } from '../../src/app/store/app-store.js';
import { createDashboard, type DashboardDeps } from '../../src/app/web/server.js';
import { Sessions } from '../../src/app/web/security.js';
import type { FetchLike } from '../../src/kernel/providers.js';
import { jobRow } from '../support/app-fixtures.js';

/**
 * The Companies tab (career-sites Task 11, spec §5) through Hono's `app.request()`: a temp JOBPILOT_HOME with the
 * fictional pack, registry rows written through the app store's own API, and Resolve now on the recorded coverage
 * fixtures (never the network).
 */
const root = join(import.meta.dirname, '../..');
const FIX = join(root, 'tests/fixtures/coverage/e2e');
const NOW = '2026-10-14T04:30:00.000Z'; // Wednesday 10:00 IST, coverage week 2026-10-11
const AT = '2026-10-11T01:30:00.000Z';

const XSS_NAME = '<script>alert(1)</script> Bank & "Co"';
const XSS_REASON = `board name '<img src=x onerror=alert(2)>' ≈ 'jpm', please confirm`;
/** The recorded coverage fixtures, plus a homepage for alpha.test that links its careers page (the e2e pick lists it). */
const ALPHA_HOME = '<!doctype html><html><body><a href="/careers">Careers</a></body></html>';
const fixtures: FetchLike = async (url, init) => (url === 'https://alpha.test/' ? { status: 200, text: async () => ALPHA_HOME } : offlineProviders(FIX).fetch(url, init));
const WD_BOARD = 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs';

let home: string;
type App = { request: (path: string, init?: RequestInit) => Promise<Response> };
let app: App;
let cookie = '';
let token = '';
let gates: { gate: RunGate; runId: string }[] = [];
let calls: string[] = [];

const withStore = <T>(fn: (s: AppStore) => T): T => {
  const s = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return fn(s);
  } finally {
    s.close();
  }
};

function verdict(key: string, name: string, status: CompanyVerdict['status'], o: { platform?: CompanyVerdict['guess']['platform']; boardUrl?: string | null; slug?: string | null; careersUrl?: string | null; reasons?: string[]; jobsSeen?: number | null; source?: 'pick' | 'remoteintech' | 'yc' | 'jobs' } = {}): CompanyVerdict {
  return {
    guess: {
      site: { candidate: { companyKey: key, name, website: `https://${key}`, careersUrl: null, source: o.source ?? 'remoteintech', runDate: '2026-10-11' }, careersUrl: o.careersUrl === undefined ? `https://${key}/careers` : o.careersUrl, method: 'listed', evidence: null },
      platform: o.platform === undefined ? null : o.platform, slug: o.slug ?? null, boardUrl: o.boardUrl ?? null, signature: null, routedFrom: null, evidence: [],
    },
    status, reasons: o.reasons ?? [], boardName: null, jobsSeen: o.jobsSeen ?? null,
  };
}

function seed(): void {
  withStore((s) => {
    s.upsertCompanyVerdict(verdict('acme.example', 'Acme Robotics', 'verified', { platform: 'workday', boardUrl: WD_BOARD, slug: 'acme.wd5.myworkdayjobs.com/acme/External', jobsSeen: 42 }), AT);
    s.upsertCompanyVerdict(verdict('bank.example', XSS_NAME, 'proposed', { platform: 'oracle', boardUrl: 'https://bank.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=CX_1', slug: 'bank.fa.us2.oraclecloud.com/CX_1', careersUrl: 'javascript:alert(3)', reasons: [XSS_REASON] }), AT);
    s.upsertCompanyVerdict(verdict('hooli.example', 'Hooli', 'proposed', { reasons: ['no platform detected'] }), AT);
    // failing: verified, then three failed weeks
    s.upsertCompanyVerdict(verdict('globodyne.example', 'Globodyne', 'verified', { platform: 'workday', boardUrl: 'https://globodyne.wd1.myworkdayjobs.com/wday/cxs/globodyne/Careers/jobs' }), '2026-09-20T01:30:00.000Z');
    for (const w of ['2026-09-27', '2026-10-04', '2026-10-11']) s.upsertCompanyVerdict(verdict('globodyne.example', 'Globodyne', 'failed', { reasons: ['board answered http-500'] }), `${w}T01:30:00.000Z`);
    s.upsertCompanyVerdict(verdict('umbrella.example', 'Umbrella', 'verified', { platform: 'workday', boardUrl: 'https://umbrella.wd1.myworkdayjobs.com/wday/cxs/umbrella/Jobs/jobs' }), AT);
    s.setCompanyOverride('umbrella.example', 'rejected', AT);
    s.upsertCompanyVerdict(verdict('vandelay.example', 'Vandelay', 'failed', { platform: 'lever', reasons: ['board returned 0 jobs'], source: 'pick' }), AT);
    s.upsertCompanyVerdict(verdict('soylent.example', 'Soylent', 'failed', { platform: 'lever', reasons: ['board returned 0 jobs'] }), AT);
    // jobs of Acme: one passing, one not eligible (with its reason)
    s.upsertJob(jobRow({ jobKey: 'a1a1a1a1a1a1a1a1', sourceId: '1', dedupeKey: 'd1d1d1d1d1d1d1d1', company: 'Acme Robotics, Inc.', title: 'Backend Engineer' }));
    s.upsertJob(jobRow({ jobKey: 'a2a2a2a2a2a2a2a2', sourceId: '2', dedupeKey: 'd2d2d2d2d2d2d2d2', company: 'Acme Robotics', title: 'Product Manager', verdict: 'rejected', score: null, reasons: ['role:product manager'] }));
    s.upsertJob(jobRow({ jobKey: 'a3a3a3a3a3a3a3a3', sourceId: '3', dedupeKey: 'd3d3d3d3d3d3d3d3', company: 'Hooli', title: 'Platform Engineer' }));
  });
}

const wrap = (raw: ReturnType<typeof createDashboard>): App => ({
  request: async (path, init = {}) => raw.request(path, { ...init, headers: { host: 'localhost', ...((init.headers as Record<string, string> | undefined) ?? {}) } }),
});

function makeApp(over: Partial<DashboardDeps> & { readonly noResolve?: boolean } = {}): App {
  const { noResolve, ...rest } = over;
  if (noResolve === true) return wrap(createDashboard({ home, clock: { now: () => NOW }, sessions: new Sessions(Buffer.alloc(32, 7)) }));
  return wrap(createDashboard({
    home, clock: { now: () => NOW }, sessions: new Sessions(Buffer.alloc(32, 7)),
    resolve: { fetch: (async (url, init) => (calls.push(url), fixtures(url, init))) as FetchLike, sleep: async () => {}, codeHash: 'web-companies', onGate: (gate, runId) => gates.push({ gate, runId }) },
    ...rest,
  }));
}

async function startSession(): Promise<void> {
  const res = await app.request('/companies');
  cookie = /jp_sid=[0-9a-f]{32}/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? '';
  token = /name="_csrf" value="([0-9a-f]{64})"/.exec(await res.text())?.[1] ?? '';
  expect(cookie).not.toBe('');
  expect(token).not.toBe('');
}
const post = (path: string, form: Record<string, string>, headers: Record<string, string> = { origin: 'http://localhost' }) =>
  app.request(path, { method: 'POST', body: new URLSearchParams(form).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...headers } });
const get = async (path: string): Promise<{ status: number; body: string }> => {
  const r = await app.request(path, { headers: { cookie } });
  return { status: r.status, body: await r.text() };
};
/** The `<section>` of one list. */
const sectionOf = (body: string, list: string): string => {
  const m = new RegExp(`<section class="card wide" aria-labelledby="${list}-h">([\\s\\S]*?)</section>`).exec(body);
  return m?.[1] ?? '';
};
const keysIn = (s: string): string[] => [...s.matchAll(/data-company="([^"]+)"/g)].map((m) => m[1] as string);
const company = (key: string) => withStore((s) => s.getCompany(key));

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'jobpilot-webco-'));
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  copyFileSync(join(FIX, 'companies.yaml'), join(home, 'pack', 'companies.yaml'));
  gates = [];
  calls = [];
  seed();
  app = makeApp();
  await startSession();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('companies: the lists', () => {
  it('the nav has Companies; every list renders with its count, ordered by company key', async () => {
    const { status, body } = await get('/companies');
    expect(status).toBe(200);
    expect(body).toContain('<a href="/companies" aria-current="page">Companies</a>');
    expect((await get('/')).body).toContain('<a href="/companies">Companies</a>');
    expect(keysIn(sectionOf(body, 'verified'))).toEqual(['acme.example']);
    expect(keysIn(sectionOf(body, 'proposed'))).toEqual(['bank.example', 'hooli.example']);
    expect(keysIn(sectionOf(body, 'failing'))).toEqual(['globodyne.example']);
    expect(keysIn(sectionOf(body, 'rejected'))).toEqual(['umbrella.example']);
    expect(keysIn(sectionOf(body, 'unverified'))).toEqual(['vandelay.example']);
    expect(sectionOf(body, 'unverified')).toContain('1 company from the seed lists did not pass either');
    for (const [l, n] of [['Verified', 1], ['Proposed', 2], ['Failing', 1], ['Rejected', 1], ['Deferred this week', 0]] as const) {
      expect(body).toContain(`>${l} <span class="num tab-count">${n}</span></a>`);
    }
  });

  it('verified: platform, careers link (https, noopener noreferrer), open jobs, jobs passing your rules, last verified, read daily', async () => {
    const v = sectionOf((await get('/companies')).body, 'verified');
    expect(v).toContain('Workday');
    expect(v).toContain('<a class="src-link" href="https://acme.example/careers" rel="noopener noreferrer" target="_blank">Careers page');
    expect(v).toMatch(/<span class="num">42<\/span> open on the board/);
    expect(v).toMatch(/<span class="num">1<\/span> passing your rules, <span class="num">1<\/span> not eligible/);
    expect(v).toContain('Last verified 11 Oct 2026');
    expect(v).toContain('Read daily.');
  });

  it('proposed: what was found, why, and Approve / Reject / Resolve now as CSRF forms', async () => {
    const p = sectionOf((await get('/companies')).body, 'proposed');
    expect(p).toContain('Oracle Recruiting');
    expect(p).toContain('no platform detected');
    for (const verb of ['approve', 'reject', 'resolve']) expect(p).toMatch(new RegExp(`<form method="post" action="/companies/bank.example/${verb}"><input type="hidden" name="_csrf" value="${token}">`));
    expect(p).toContain('Not read until you approve it.');
  });

  it('failing: the error and the since-week', async () => {
    const f = sectionOf((await get('/companies')).body, 'failing');
    expect(f).toContain('<strong>board answered http-500</strong>');
    expect(f).toContain('failing since the week of 27 Sep 2026 (3 weeks)');
    expect(f).toContain('Still read daily, so it can recover.');
  });

  it('escapes untrusted names, reasons and URLs; a non-https careers URL is text, never a link', async () => {
    const { body } = await get('/companies');
    expect(body).not.toContain('<script>alert(1)');
    expect(body).not.toContain('<img src=x');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Bank &amp; &quot;Co&quot;');
    expect(body).toContain('board name &#39;&lt;img src=x onerror=alert(2)&gt;&#39;');
    expect(body).not.toMatch(/href="javascript:/);
    expect(body).toContain('careers page (not https, not linked): <code>javascript:alert(3)</code>');
    // the only links out of the dashboard are careers pages
    const external = [...body.matchAll(/<a [^>]*href="(https?:[^"]*)"[^>]*>/g)].map((m) => m[0]);
    expect(external.length).toBeGreaterThan(0);
    for (const a of external) expect(a).toMatch(/href="https:\/\/[a-z0-9.]+\.example\/careers" rel="noopener noreferrer"/);
  });

  it('hides a name that holds a forbidden term', async () => {
    const term = (parseYaml(readFileSync(join(home, 'pack', 'naming.yaml'), 'utf8')) as { forbiddenTerms: string[] }).forbiddenTerms[0];
    expect(term).toBeDefined();
    withStore((s) => s.upsertCompanyVerdict(verdict('hidden.example', `${term as string} Labs`, 'proposed'), AT));
    const { body } = await get('/companies');
    expect(body).not.toContain(term as string);
    expect(body).toContain('[hidden: contains a forbidden term]');
  });

  it('deferred this week: the hosts this week\'s coverage run disabled, with the reason and their companies', async () => {
    withStore((s) => {
      s.kernel.startRun('coverage-2026-10-11', 'jobpilot-coverage', 'p', AT);
      s.disableCoverageHost('coverage-2026-10-11', 'acme.example', 'http-429', AT);
      // a run of another week is not this week's
      s.kernel.startRun('coverage-2026-10-04', 'jobpilot-coverage', 'p', '2026-10-04T01:30:00.000Z');
      s.disableCoverageHost('coverage-2026-10-04', 'hooli.example', 'challenge', AT);
    });
    const { body } = await get('/companies');
    const d = sectionOf(body, 'deferred');
    expect(d).toContain('<code>acme.example</code> rate-limited (HTTP 429) <span class="muted">(http-429)</span>');
    expect(d).toContain('Acme Robotics');
    expect(d).not.toContain('hooli.example');
    expect(body).toContain('>Deferred this week <span class="num tab-count">1</span></a>');
  });
});

describe('companies: approve and reject', () => {
  it('approving a proposed company with a board makes it verified and read by the next daily run; logged', async () => {
    expect(withStore((s) => s.verifiedCompanies().map((c) => c.companyKey))).not.toContain('bank.example');
    const r = await post('/companies/bank.example/approve', { _csrf: token });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/companies?done=approved&key=bank.example#co-bank-example');
    expect(company('bank.example')).toMatchObject({ status: 'verified', userOverride: 'approved' });
    expect(withStore((s) => s.verifiedCompanies().map((c) => c.companyKey))).toContain('bank.example');
    expect(registryBoards(withStore((s) => s.verifiedCompanies())).map((b) => b.platform)).toContain('oracle');
    const page = (await get(r.headers.get('location') as string)).body;
    expect(page).toContain('Approved: &lt;script&gt;alert(1)&lt;/script&gt; Bank &amp; &quot;Co&quot; is read daily from the next run.');
    expect(withStore((s) => s.userActions())).toEqual([
      { at: NOW, kind: 'company.override', data: { companyKey: 'bank.example', from: null, to: 'approved', statusBefore: 'proposed', statusAfter: 'verified' } },
    ]);
  });

  it('approving a proposed company with no board keeps it proposed and says nothing is read yet', async () => {
    await post('/companies/hooli.example/approve', { _csrf: token });
    expect(company('hooli.example')).toMatchObject({ status: 'proposed', userOverride: 'approved' });
    expect((await get('/companies?done=approved&key=hooli.example')).body).toContain('Approved. Approved; nothing is read until a board is found');
  });

  it('reject removes it from daily reads, a coverage verdict never brings it back, approve undoes it (both logged)', async () => {
    await post('/companies/acme.example/reject', { _csrf: token });
    expect(company('acme.example')).toMatchObject({ status: 'rejected', userOverride: 'rejected' });
    expect(withStore((s) => s.verifiedCompanies().map((c) => c.companyKey))).not.toContain('acme.example');
    withStore((s) => s.upsertCompanyVerdict(verdict('acme.example', 'Acme Robotics', 'verified', { platform: 'workday', boardUrl: WD_BOARD }), NOW));
    expect(company('acme.example')).toMatchObject({ status: 'rejected' });
    expect(keysIn(sectionOf((await get('/companies')).body, 'rejected'))).toEqual(['acme.example', 'umbrella.example']);
    await post('/companies/acme.example/approve', { _csrf: token });
    expect(company('acme.example')).toMatchObject({ status: 'verified', userOverride: 'approved' });
    expect(withStore((s) => s.verifiedCompanies().map((c) => c.companyKey))).toContain('acme.example');
    expect(withStore((s) => s.userActions().map((a) => a.data))).toEqual([
      { companyKey: 'acme.example', from: null, to: 'rejected', statusBefore: 'verified', statusAfter: 'rejected' },
      { companyKey: 'acme.example', from: 'rejected', to: 'approved', statusBefore: 'rejected', statusAfter: 'verified' },
    ]);
  });

  it('refuses a POST without the CSRF token, with a wrong one, or from another origin, and changes nothing', async () => {
    expect((await post('/companies/bank.example/approve', {})).status).toBe(403);
    expect((await post('/companies/bank.example/approve', { _csrf: 'f'.repeat(64) })).status).toBe(403);
    expect((await post('/companies/bank.example/approve', { _csrf: token }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await post('/companies/add', { website: 'https://new.example' })).status).toBe(403);
    expect((await post('/companies/bank.example/resolve', {})).status).toBe(403);
    expect(company('bank.example')).toMatchObject({ status: 'proposed', userOverride: null });
    expect(company('new.example')).toBeUndefined();
    expect(withStore((s) => s.userActions())).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('an unknown or malformed key is refused', async () => {
    expect((await post('/companies/nope.example/approve', { _csrf: token })).status).toBe(404);
    expect((await post('/companies/NOT%20A%20KEY/reject', { _csrf: token })).status).toBe(400);
  });
});

describe('companies: add a company', () => {
  it('writes a pick to Proposed with the added reason; never the pack; logged', async () => {
    const pack = readFileSync(join(home, 'pack', 'companies.yaml'), 'utf8');
    const r = await post('/companies/add', { _csrf: token, website: 'https://www.Globex.example/about', name: '  Globex   Corporation ' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/companies?done=added&key=globex.example#co-globex-example');
    expect(company('globex.example')).toMatchObject({ name: 'Globex Corporation', website: 'https://www.globex.example', status: 'proposed', source: 'pick', reasons: [ADDED_PICK_REASON], platform: null, userOverride: null });
    expect(readFileSync(join(home, 'pack', 'companies.yaml'), 'utf8')).toBe(pack);
    expect(withStore((s) => s.userActions())).toEqual([{ at: NOW, kind: 'company.add', data: { companyKey: 'globex.example', name: 'Globex Corporation', website: 'https://www.globex.example' } }]);
    const page = (await get(r.headers.get('location') as string)).body;
    expect(keysIn(sectionOf(page, 'proposed'))).toContain('globex.example');
    expect(page).toContain(ADDED_PICK_REASON);
    // the next weekly coverage run seeds it as a pick
    expect(withStore((s) => registryPickItems(s, []))).toContainEqual({ name: 'Globex Corporation', website: 'https://www.globex.example' });
  });

  it('a website alone: the name is its domain label', async () => {
    await post('/companies/add', { _csrf: token, website: 'https://stark.example' });
    expect(company('stark.example')).toMatchObject({ name: 'stark' });
  });

  it('a duplicate company key: a clear message, no new row', async () => {
    const before = withStore((s) => s.listCompanies().length);
    const r = await post('/companies/add', { _csrf: token, website: 'https://careers.acme.example', name: 'Acme Again' });
    expect(r.status).toBe(409);
    expect(await r.text()).toContain('Acme Robotics (acme.example) is already in your companies, under verified; nothing was added.');
    expect(withStore((s) => s.listCompanies().length)).toBe(before);
    expect(company('acme.example')).toMatchObject({ name: 'Acme Robotics' });
    expect(withStore((s) => s.userActions())).toEqual([]);
  });

  it.each([
    [{ website: '' }, 'Give the company’s website'],
    [{ website: 'http://plain.example' }, 'Only https:// websites are accepted.'],
    [{ website: 'javascript:alert(1)' }, 'Only https:// websites are accepted.'],
    [{ website: 'not a url' }, 'not a web address'],
    [{ website: 'https://user:pw@x.example' }, 'must not carry a user name or password'],
    [{ website: 'https://localhost' }, 'no registrable domain'],
    [{ website: 'https://10.0.0.1' }, 'no registrable domain'],
    [{ website: 'https://boards.greenhouse.io/acme' }, 'is a job board or applicant system'],
    [{ website: 'https://www.linkedin.com/company/acme' }, 'is a job board or applicant system'],
    [{ website: `https://${'a'.repeat(300)}.example` }, 'longer than 300 characters'],
    [{ website: 'https://ok.example', name: 'x'.repeat(101) }, 'longer than 100 characters'],
    [{ website: 'https://ok.example', name: 'Careers' }, 'does not say which company'],
    [{ website: 'https://ok.example', name: 'Inc.' }, 'does not say which company'],
    [{ website: 'https://ok.example', name: 'bad\u0007name' }, 'control characters'],
    [{ name: 'Nobody Knows Co' }, 'needs the company’s website'],
  ])('refuses %j with a message, writing nothing', async (form, message) => {
    const before = withStore((s) => s.listCompanies().length);
    const r = await post('/companies/add', { _csrf: token, ...form });
    expect(r.status).toBe(400);
    const body = await r.text();
    expect(body).toContain(message.replace(/'/g, '&#39;'));
    expect(withStore((s) => s.listCompanies().length)).toBe(before);
  });

  it('echoes the input escaped', async () => {
    const r = await post('/companies/add', { _csrf: token, website: 'http://"><script>x</script>' });
    const body = await r.text();
    expect(body).not.toContain('<script>x');
    expect(body).toContain('value="http://&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
  });

  it('a name alone resolves through a careers page you already have jobs from', async () => {
    withStore((s) => s.upsertJob(jobRow({ jobKey: 'b1b1b1b1b1b1b1b1', sourceId: '9', dedupeKey: 'e1e1e1e1e1e1e1e1', company: 'Wayne Enterprises', source: 'careers', ats: 'careers', url: 'https://jobs.wayne.example/o/1' })));
    const r = await post('/companies/add', { _csrf: token, name: 'Wayne Enterprises' });
    expect(r.status).toBe(303);
    expect(company('wayne.example')).toMatchObject({ name: 'Wayne Enterprises', website: 'https://jobs.wayne.example' });
  });
});

describe('companies: resolve now', () => {
  const add = async () => {
    expect((await post('/companies/add', { _csrf: token, website: 'https://alpha.test', name: 'Alpha Robotics' })).status).toBe(303);
  };

  it('runs the four coverage agents for that one company on the recorded fixtures and writes the verdict', async () => {
    await add();
    const r = await post('/companies/alpha.test/resolve', { _csrf: token });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/companies?done=resolved&key=alpha.test#co-alpha-test');
    expect(company('alpha.test')).toMatchObject({ status: 'verified', platform: 'greenhouse', platformSlug: 'alpharobotics', source: 'pick' });
    expect(calls.every((u) => /^https:\/\/(alpha\.test|boards-api\.greenhouse\.io)\//.test(u))).toBe(true);
    expect(calls.some((u) => u.includes('boards-api.greenhouse.io/v1/boards/alpharobotics/jobs'))).toBe(true);
    expect(gates.map((g) => g.runId)).toEqual(['resolve-2026-10-14-alpha-test']);
    expect(withStore((s) => s.userActions().map((a) => a.kind))).toEqual(['company.add', 'company.resolve']);
    expect((await get(r.headers.get('location') as string)).body).toContain('Resolved now: verified.');
    // the lock is released
    expect(() => readFileSync(join(home, 'jobpilot.lock'))).toThrow();
  });

  it('builds a fresh gate and run key per request', async () => {
    await add();
    await post('/companies/alpha.test/resolve', { _csrf: token });
    await post('/companies/alpha.test/resolve', { _csrf: token });
    expect(gates).toHaveLength(2);
    expect(gates[0]?.gate).not.toBe(gates[1]?.gate);
    expect(gates.map((g) => g.runId)).toEqual(['resolve-2026-10-14-alpha-test', 'resolve-2026-10-14-alpha-test-2']);
  });

  it('holds the run lock while it runs', async () => {
    await add();
    let held: string | undefined;
    app = makeApp({ resolve: { fetch: (async (url, init) => {
      held ??= readFileSync(join(home, 'jobpilot.lock'), 'utf8');
      return fixtures(url, init);
    }) as FetchLike, sleep: async () => {}, codeHash: 'web-companies' } });
    await post('/companies/alpha.test/resolve', { _csrf: token });
    expect(JSON.parse(held as string)).toMatchObject({ pid: process.pid, command: 'resolve-company' });
  });

  it('refuses at once while another run holds the lock, and fetches nothing', async () => {
    await add();
    await withLock(home, 'run', async () => {
      const r = await post('/companies/alpha.test/resolve', { _csrf: token });
      expect(r.headers.get('location')).toBe('/companies?done=resolve-busy');
    });
    expect(calls).toEqual([]);
    expect(company('alpha.test')).toMatchObject({ status: 'proposed' });
    expect((await get('/companies?done=resolve-busy')).body).toContain('another jobpilot run holds the lock');
  });

  it('refuses when the daily run is due (the coverage yield rule), and fetches nothing', async () => {
    await add();
    // a scheduled home (its attempts file exists) at 10:00 IST with no daily run today: the daily run is owed
    writeFileSync(join(home, 'daily-attempts.json'), JSON.stringify({ date: '2026-10-14', attempts: [] }));
    const r = await post('/companies/alpha.test/resolve', { _csrf: token });
    expect(r.headers.get('location')).toBe('/companies?done=resolve-due-daily');
    expect(calls).toEqual([]);
    expect(gates).toEqual([]);
    expect(company('alpha.test')).toMatchObject({ status: 'proposed' });
    expect((await get('/companies?done=resolve-due-daily')).body).toContain('the daily run is due now or within 5 minutes');
  });

  it('refuses a rejected company; is not offered without a fetcher', async () => {
    const r = await post('/companies/umbrella.example/resolve', { _csrf: token });
    expect(r.headers.get('location')).toBe('/companies?done=resolve-rejected&key=umbrella.example#co-umbrella-example');
    app = makeApp({ noResolve: true });
    expect((await get('/companies')).body).not.toContain('/resolve"');
    expect((await post('/companies/bank.example/resolve', { _csrf: token })).headers.get('location')).toBe('/companies?done=resolve-off');
    expect(calls).toEqual([]);
  });

  it('stops between steps at its time limit, writing nothing', async () => {
    await add();
    let t = Date.parse(NOW);
    const res = await resolveCompany({
      home, clock: { now: () => new Date((t += 61_000)).toISOString() }, fetch: fixtures, companyKey: 'alpha.test', sleep: async () => {}, codeHash: 'x', yieldCheck: () => null,
    });
    expect(res).toMatchObject({ kind: 'stopped', reason: 'time limit' });
    expect(company('alpha.test')).toMatchObject({ status: 'proposed', reasons: [ADDED_PICK_REASON] });
  });
});

describe('companies: the weekly coverage run and added companies', () => {
  it('the next weekly run seeds a company added on the dashboard as a pick and verifies it; a rejected one is never seeded', async () => {
    writeFileSync(join(home, 'pack', 'companies.yaml'), 'companies: []\n');
    expect((await post('/companies/add', { _csrf: token, website: 'https://alpha.test', name: 'Alpha Robotics' })).status).toBe(303);
    await post('/companies/add', { _csrf: token, website: 'https://nope.example', name: 'Nope' });
    await post('/companies/nope.example/reject', { _csrf: token });
    expect(withStore((s) => registryPickItems(s, []).map((i) => i.website))).toEqual(['https://alpha.test', 'https://vandelay.example']);
    const r = await runCoverage({ home, clock: { now: () => '2026-10-18T01:30:00.000Z' }, fetch: fixtures, sleep: async () => {}, codeHash: 'web-companies', yieldCheck: () => null, limit: 0 });
    expect(r.status).toBe('completed');
    expect(company('alpha.test')).toMatchObject({ status: 'verified', platform: 'greenhouse', source: 'pick' });
    expect(company('nope.example')).toMatchObject({ status: 'rejected' });
    // a pick companies.yaml already holds is seeded by the file, not twice
    expect(withStore((s) => registryPickItems(s, [{ website: 'https://www.alpha.test' }]).map((i) => i.name))).toEqual(['Vandelay']);
  });
});

describe('companies: links to their jobs', () => {
  it('a company links to its jobs in the jobs list, every band; a not-eligible job shows its reason', async () => {
    const v = sectionOf((await get('/companies')).body, 'verified');
    const href = /<a href="(\/\?company=[^"]+)">/.exec(v)?.[1]?.replace(/&amp;/g, '&');
    expect(href).toBe('/?company=Acme+Robotics&band=disclosed&band=undisclosed&band=review&band=below-floor&band=rejected');
    const { body } = await get(href as string);
    const keys = [...body.matchAll(/data-job="([0-9a-f]{16})"/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual(['a1a1a1a1a1a1a1a1', 'a2a2a2a2a2a2a2a2']);
    expect(body).toContain('Jobs at <strong>Acme Robotics</strong> only');
    expect(body).toContain('<input type="hidden" name="company" value="Acme Robotics">');
    expect(body).toContain('Not eligible: The title matches a role you filtered out <code>role:product manager</code>');
  });
});
