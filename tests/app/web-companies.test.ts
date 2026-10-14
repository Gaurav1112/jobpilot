import { cpSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { RunGate } from '../../src/app/coverage/gate.js';
import { registrableDomain, registryPickItems } from '../../src/app/coverage/seed.js';
import { resolveCompany } from '../../src/app/coverage/resolve.js';
import { runCoverage } from '../../src/app/coverage/run.js';
import type { CompanyVerdict } from '../../src/app/coverage/types.js';
import { withLock } from '../../src/app/lock.js';
import { offlineProviders } from '../../src/app/offline.js';
import { readsDaily, registryBoards } from '../../src/app/pipeline.js';
import { ADDED_PICK_REASON, AppStore } from '../../src/app/store/app-store.js';
import { MAX_PENDING_ADDED } from '../../src/app/web/companies.js';
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
    const r = await post('/companies/add', { _csrf: token, website: 'https://www.Globex-Industries.com:443/about', name: '  Globex   Corporation ' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/companies?done=added&key=globex-industries.com#co-globex-industries-com');
    expect(company('globex-industries.com')).toMatchObject({ name: 'Globex Corporation', website: 'https://www.globex-industries.com', status: 'proposed', source: 'pick', reasons: [ADDED_PICK_REASON], platform: null, userOverride: null });
    expect(readFileSync(join(home, 'pack', 'companies.yaml'), 'utf8')).toBe(pack);
    expect(withStore((s) => s.userActions())).toEqual([{ at: NOW, kind: 'company.add', data: { companyKey: 'globex-industries.com', name: 'Globex Corporation', website: 'https://www.globex-industries.com' } }]);
    const page = (await get(r.headers.get('location') as string)).body;
    expect(keysIn(sectionOf(page, 'proposed'))).toContain('globex-industries.com');
    expect(page).toContain(ADDED_PICK_REASON);
    // the next weekly coverage run seeds it as a pick
    expect(withStore((s) => registryPickItems(s, []))).toContainEqual({ name: 'Globex Corporation', website: 'https://www.globex-industries.com' });
  });

  it('a website alone: the name is its domain label', async () => {
    await post('/companies/add', { _csrf: token, website: 'https://stark-industries.net' });
    expect(company('stark-industries.net')).toMatchObject({ name: 'stark-industries' });
  });

  it('a duplicate company key: a clear message, no new row', async () => {
    await post('/companies/add', { _csrf: token, website: 'https://globex-industries.com', name: 'Globex' });
    const before = withStore((s) => s.listCompanies().length);
    const r = await post('/companies/add', { _csrf: token, website: 'https://careers.globex-industries.com', name: 'Globex Again' });
    expect(r.status).toBe(409);
    expect(await r.text()).toContain('Globex (globex-industries.com) is already in your companies, under proposed; nothing was added.');
    expect(withStore((s) => s.listCompanies().length)).toBe(before);
    expect(company('globex-industries.com')).toMatchObject({ name: 'Globex' });
    expect(withStore((s) => s.userActions().map((a) => a.kind))).toEqual(['company.add']);
  });

  it.each([
    [{ website: '' }, 'Give the company’s website'],
    [{ website: 'http://plain.example' }, 'Only https:// websites are accepted.'],
    [{ website: 'javascript:alert(1)' }, 'Only https:// websites are accepted.'],
    [{ website: 'not a url' }, 'not a web address'],
    [{ website: 'https://user:pw@x.example' }, 'must not carry a user name or password'],
    [{ website: 'https://localhost' }, 'is not a public website'],
    [{ website: 'https://10.0.0.1' }, 'is not a public website'],
    [{ website: 'https://[::1]' }, 'is not a public website'],
    [{ website: 'https://intranet' }, 'is not a public website'],
    [{ website: 'https://acmecorp' }, 'is not a public website'],
    [{ website: 'https://printer.local' }, 'is not a public website'],
    [{ website: 'https://nas.home.arpa' }, 'is not a public website'],
    [{ website: 'https://wiki.corp.internal' }, 'is not a public website'],
    [{ website: 'https://app.localhost' }, 'is not a public website'],
    [{ website: 'https://alpha.test' }, 'is not a public website'],
    [{ website: 'https://ok.example' }, 'is not a public website'],
    [{ website: 'https://nothing.invalid' }, 'is not a public website'],
    [{ website: 'https://acme.c0m' }, 'is not a public website'],
    [{ website: 'https://ok-company.com:8443' }, 'without a port'],
    [{ website: 'https://sites.google.com/view/acme' }, 'no registrable domain'],
    [{ website: 'https://workers.dev' }, 'no registrable domain'],
    [{ website: 'https://boards.greenhouse.io/acme' }, 'is a job board or applicant system'],
    [{ website: 'https://www.linkedin.com/company/acme' }, 'is a job board or applicant system'],
    [{ website: `https://${'a'.repeat(300)}.example` }, 'longer than 300 characters'],
    [{ website: 'https://ok-company.com', name: 'x'.repeat(101) }, 'longer than 100 characters'],
    [{ website: 'https://ok-company.com', name: 'Careers' }, 'does not say which company'],
    [{ website: 'https://ok-company.com', name: 'Inc.' }, 'does not say which company'],
    [{ website: 'https://ok-company.com', name: 'bad\u0007name' }, 'control characters'],
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
    withStore((s) => s.upsertJob(jobRow({ jobKey: 'b1b1b1b1b1b1b1b1', sourceId: '9', dedupeKey: 'e1e1e1e1e1e1e1e1', company: 'Wayne Enterprises', source: 'careers', ats: 'careers', url: 'https://jobs.wayne-enterprises.com/o/1' })));
    const r = await post('/companies/add', { _csrf: token, name: 'Wayne Enterprises' });
    expect(r.status).toBe(303);
    expect(company('wayne-enterprises.com')).toMatchObject({ name: 'Wayne Enterprises', website: 'https://jobs.wayne-enterprises.com' });
  });
});

describe('companies: resolve now', () => {
  // alpha.test is a reserved test host the add form refuses, so the recorded fixtures' company is written directly
  const add = async () => {
    expect(withStore((s) => s.addCompanyPick({ companyKey: 'alpha.test', name: 'Alpha Robotics', website: 'https://alpha.test' }, NOW))).toBe(true);
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
    expect(withStore((s) => s.userActions().map((a) => a.kind))).toEqual(['company.resolve']);
    expect((await get(r.headers.get('location') as string)).body).toContain('Resolved now: verified.');
    // the lock is released
    expect(() => readFileSync(join(home, 'jobpilot.lock'))).toThrow();
  });

  it('builds a fresh gate and run key per request', async () => {
    // hooli's careers page is not in the fixtures: it stays proposed, so it can be resolved twice
    await post('/companies/hooli.example/resolve', { _csrf: token });
    await post('/companies/hooli.example/resolve', { _csrf: token });
    expect(gates).toHaveLength(2);
    expect(gates[0]?.gate).not.toBe(gates[1]?.gate);
    expect(gates.map((g) => g.runId)).toEqual(['resolve-2026-10-14-hooli-example', 'resolve-2026-10-14-hooli-example-2']);
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

  it('C1: a network outage while resolving is "deferred", never a verdict; nothing written', async () => {
    await add();
    // robots.txt answers (404: allow all), every page fails in transport: no host is disabled, the step fails network
    const reset = (async (url: string) => {
      if (url.endsWith('/robots.txt')) return { status: 404, text: async () => 'Not Found' };
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    }) as FetchLike;
    const res = await resolveCompany({ home, clock: { now: () => NOW }, fetch: reset, companyKey: 'alpha.test', sleep: async () => {}, codeHash: 'x', yieldCheck: () => null, online: async () => true });
    expect(res).toMatchObject({ kind: 'deferred' });
    expect(company('alpha.test')).toMatchObject({ status: 'proposed', reasons: [ADDED_PICK_REASON] });
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
    withStore((s) => s.addCompanyPick({ companyKey: 'alpha.test', name: 'Alpha Robotics', website: 'https://alpha.test' }, NOW));
    withStore((s) => s.addCompanyPick({ companyKey: 'nope.example', name: 'Nope', website: 'https://nope.example' }, NOW));
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
    const href = /<a href="(\/\?companyKey=[^"]+)">/.exec(v)?.[1]?.replace(/&amp;/g, '&');
    expect(href).toBe('/?companyKey=acme.example&band=disclosed&band=undisclosed&band=review&band=below-floor&band=rejected');
    const { body } = await get(href as string);
    const keys = [...body.matchAll(/data-job="([0-9a-f]{16})"/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual(['a1a1a1a1a1a1a1a1', 'a2a2a2a2a2a2a2a2']);
    expect(body).toContain('Jobs at <strong>Acme Robotics</strong> only');
    expect(body).toContain('<input type="hidden" name="companyKey" value="acme.example">');
    expect(body).toContain('Not eligible: The title matches a role you filtered out <code>role:product manager</code>');
  });
});

describe('fix round 2: undo of a reject restores coverage', () => {
  it('verified, rejected by mistake, undone: verified and read daily again; the notice says so', async () => {
    await post('/companies/acme.example/reject', { _csrf: token });
    const r = await post('/companies/acme.example/undo', { _csrf: token });
    expect(company('acme.example')).toMatchObject({ status: 'verified', userOverride: null });
    expect(withStore((s) => s.verifiedCompanies().map((c) => c.companyKey))).toContain('acme.example');
    const page = (await get(r.headers.get('location') as string)).body;
    expect(page).toContain('Undone: your choice on Acme Robotics is cleared; it is verified as coverage decided. Read daily.');
  });

  it('verified, rejected, a new verified verdict, undone: verified', async () => {
    await post('/companies/acme.example/reject', { _csrf: token });
    withStore((s) => s.upsertCompanyVerdict(verdict('acme.example', 'Acme Robotics', 'verified', { platform: 'workday', boardUrl: WD_BOARD }), NOW));
    expect(company('acme.example')).toMatchObject({ status: 'rejected', coverageStatus: 'verified' });
    await post('/companies/acme.example/undo', { _csrf: token });
    expect(company('acme.example')).toMatchObject({ status: 'verified' });
  });

  it('verified, rejected, coverage then only proposes it, undone: proposed; the notice says so', async () => {
    await post('/companies/acme.example/reject', { _csrf: token });
    withStore((s) => s.upsertCompanyVerdict(verdict('acme.example', 'Acme Robotics', 'proposed', { platform: 'workday', boardUrl: WD_BOARD, reasons: ['board name changed'] }), NOW));
    // nothing but the coverage status moves while it is rejected
    expect(company('acme.example')).toMatchObject({ status: 'rejected', coverageStatus: 'proposed', reasons: [] });
    const r = await post('/companies/acme.example/undo', { _csrf: token });
    expect(company('acme.example')).toMatchObject({ status: 'proposed', userOverride: null });
    expect((await get(r.headers.get('location') as string)).body).toContain('it is proposed as coverage decided. Not read until you approve it.');
  });
});

describe('fix round 1: undo', () => {
  it('reject then undo: back to proposed, not read daily; Approve and Reject stay explicit; both logged', async () => {
    await post('/companies/bank.example/reject', { _csrf: token });
    const rej = sectionOf((await get('/companies')).body, 'rejected');
    expect(rej).toContain('action="/companies/bank.example/undo"');
    expect(rej).toContain('action="/companies/bank.example/approve"');
    const r = await post('/companies/bank.example/undo', { _csrf: token });
    expect(r.status).toBe(303);
    expect(company('bank.example')).toMatchObject({ status: 'proposed', userOverride: null });
    expect(withStore((s) => s.verifiedCompanies().map((c) => c.companyKey))).not.toContain('bank.example');
    expect(withStore((s) => s.userActions().map((a) => (a.data as { to: unknown }).to))).toEqual(['rejected', null]);
  });

  it('approve then undo: back to proposed when coverage never verified it', async () => {
    await post('/companies/bank.example/approve', { _csrf: token });
    expect(company('bank.example')).toMatchObject({ status: 'verified' });
    expect(sectionOf((await get('/companies')).body, 'verified')).toContain('action="/companies/bank.example/undo"');
    await post('/companies/bank.example/undo', { _csrf: token });
    expect(company('bank.example')).toMatchObject({ status: 'proposed', userOverride: null });
    expect(withStore((s) => s.verifiedCompanies().map((c) => c.companyKey))).not.toContain('bank.example');
  });

  it('approve then undo: verified again when coverage had verified it', async () => {
    await post('/companies/acme.example/approve', { _csrf: token });
    await post('/companies/acme.example/undo', { _csrf: token });
    expect(company('acme.example')).toMatchObject({ status: 'verified', userOverride: null });
  });

  it('approve, then a coverage week that only proposes it, then undo: proposed', async () => {
    await post('/companies/acme.example/approve', { _csrf: token });
    withStore((s) => s.upsertCompanyVerdict(verdict('acme.example', 'Acme Robotics', 'proposed', { platform: 'workday', boardUrl: WD_BOARD, reasons: ['board name changed'] }), NOW));
    expect(company('acme.example')).toMatchObject({ status: 'verified' });
    await post('/companies/acme.example/undo', { _csrf: token });
    expect(company('acme.example')).toMatchObject({ status: 'proposed', userOverride: null });
  });

  it('undo with no override is refused', async () => {
    expect((await post('/companies/hooli.example/undo', { _csrf: token })).status).toBe(409);
  });
});

describe('fix round 1: the cap on added companies', () => {
  const fill = (n: number) => withStore((s) => {
    for (let i = 0; i < n; i++) s.addCompanyPick({ companyKey: `pending${i}.com`, name: `Pending ${i}`, website: `https://pending${i}.com` }, NOW);
  });

  it(`refuses a new company while ${MAX_PENDING_ADDED} you added are still waiting`, async () => {
    expect(MAX_PENDING_ADDED).toBe(50);
    fill(MAX_PENDING_ADDED);
    const r = await post('/companies/add', { _csrf: token, website: 'https://one-more.com' });
    expect(r.status).toBe(409);
    expect(await r.text()).toContain('50 companies you added are still waiting');
    expect(company('one-more.com')).toBeUndefined();
  });

  it('a pick coverage has decided, or one you rejected, no longer counts', async () => {
    fill(MAX_PENDING_ADDED - 1);
    withStore((s) => {
      s.addCompanyPick({ companyKey: 'decided.com', name: 'Decided', website: 'https://decided.com' }, NOW);
      s.upsertCompanyVerdict(verdict('decided.com', 'Decided', 'proposed', { source: 'pick', reasons: ['careers site not located'] }), NOW);
      s.addCompanyPick({ companyKey: 'nope.com', name: 'Nope', website: 'https://nope.com' }, NOW);
      s.setCompanyOverride('nope.com', 'rejected', NOW);
    });
    expect((await post('/companies/add', { _csrf: token, website: 'https://one-more.com' })).status).toBe(303);
  });
});

describe('fix round 1: website hosts', () => {
  it('strips the default port; keeps the tenant label on a shared host', async () => {
    expect((await post('/companies/add', { _csrf: token, website: 'https://acme-co.workers.dev:443/jobs' })).status).toBe(303);
    expect(company('acme-co.workers.dev')).toMatchObject({ website: 'https://acme-co.workers.dev' });
    expect((await post('/companies/add', { _csrf: token, website: 'https://jobs.beta-co.pages.dev' })).status).toBe(303);
    expect(company('beta-co.pages.dev')).toBeDefined();
    expect((await post('/companies/add', { _csrf: token, website: 'https://gamma-co.netlify.app' })).status).toBe(303);
    expect((await post('/companies/add', { _csrf: token, website: 'https://delta-co.netlify.app' })).status).toBe(303);
    expect(company('gamma-co.netlify.app')).toBeDefined();
    expect(registrableDomain('acme.sites.google.com')).toBe('acme.sites.google.com');
    expect(registrableDomain('sites.google.com')).toBeNull();
    expect(registrableDomain('api.shop.myshopify.com')).toBe('shop.myshopify.com');
    expect(company('delta-co.netlify.app')).toBeDefined();
  });
});

describe('fix round 1: resolve guards', () => {
  const add = () => withStore((s) => s.addCompanyPick({ companyKey: 'alpha.test', name: 'Alpha Robotics', website: 'https://alpha.test' }, NOW));

  it('M5: a daily run that becomes due mid-resolve makes it yield before the next step, writing nothing', async () => {
    add();
    app = makeApp({ resolve: { fetch: (async (url, init) => {
      calls.push(url);
      // the scheduled daily run becomes owed while resolve is running
      writeFileSync(join(home, 'daily-attempts.json'), JSON.stringify({ date: '2026-10-14', attempts: [] }));
      return fixtures(url, init);
    }) as FetchLike, sleep: async () => {}, codeHash: 'web-companies' } });
    const r = await post('/companies/alpha.test/resolve', { _csrf: token });
    expect(r.headers.get('location')).toBe('/companies?done=resolve-stopped&key=alpha.test#co-alpha-test');
    expect(calls.some((u) => u.includes('greenhouse'))).toBe(false);
    expect(company('alpha.test')).toMatchObject({ status: 'proposed', reasons: [ADDED_PICK_REASON] });
    expect(withStore((s) => s.userActions().at(-1)?.data)).toMatchObject({ result: 'stopped', reason: 'yielded to daily' });
  });

  it('M6: a failed resolve never adds a fail week (a real failed verdict: detected, then the board answers 404)', async () => {
    const before = company('globodyne.example');
    const careers = readFileSync(join(FIX, 'alpha-careers.html'), 'utf8');
    app = makeApp({ resolve: { fetch: (async (url) => {
      calls.push(url);
      // the careers page shows a Greenhouse board; the board itself is gone
      if (url === 'https://globodyne.example/careers') return { status: 200, text: async () => careers };
      return { status: 404, text: async () => 'Not Found' };
    }) as FetchLike, sleep: async () => {}, codeHash: 'web-companies' } });
    const r = await post('/companies/globodyne.example/resolve', { _csrf: token });
    expect(r.headers.get('location')).toBe('/companies?done=resolved&key=globodyne.example#co-globodyne-example');
    expect(calls.some((u) => u.startsWith('https://boards-api.greenhouse.io/'))).toBe(true);
    const after = company('globodyne.example');
    // the failed verdict was written (its reasons), but the fail week was not counted
    expect(after?.reasons.join(' ')).toMatch(/404/);
    expect(after).toMatchObject({ status: 'failing', failWeeks: before?.failWeeks, failingSince: before?.failingSince });
  });

  it('M9: a host that refuses during resolve defers it; no verdict is written', async () => {
    add();
    app = makeApp({ resolve: { fetch: (async (url, init) => (calls.push(url), url === 'https://alpha.test/careers' ? { status: 403, text: async () => 'Forbidden' } : fixtures(url, init))) as FetchLike, sleep: async () => {}, codeHash: 'web-companies' } });
    const r = await post('/companies/alpha.test/resolve', { _csrf: token });
    expect(r.headers.get('location')).toMatch(/^\/companies\?done=resolve-deferred&key=alpha\.test&run=resolve-2026-10-14-alpha-test#co-alpha-test$/);
    expect(company('alpha.test')).toMatchObject({ status: 'proposed', reasons: [ADDED_PICK_REASON], updatedAt: NOW });
    expect((await get(r.headers.get('location') as string)).body).toContain('alpha.test (refused access)');
  });

  it('refuses an already-verified company and leaves its source alone', async () => {
    const r = await post('/companies/acme.example/resolve', { _csrf: token });
    expect(r.headers.get('location')).toBe('/companies?done=resolve-verified&key=acme.example#co-acme-example');
    expect((await get(r.headers.get('location') as string)).body).toContain('already verified; it is re-checked weekly');
    expect(company('acme.example')).toMatchObject({ source: 'remoteintech', status: 'verified' });
    expect(calls).toEqual([]);
    expect(sectionOf((await get('/companies')).body, 'verified')).not.toContain('/resolve"');
  });
});

describe('fix round 1: rendering', () => {
  it('M7: a careers URL carrying a user name and password is text, never a link', async () => {
    withStore((s) => s.upsertCompanyVerdict(verdict('cred.example', 'Cred Co', 'proposed', { careersUrl: 'https://user:pw@cred.example/careers' }), AT));
    const p = sectionOf((await get('/companies')).body, 'proposed');
    expect(p).not.toMatch(/href="https:\/\/user:pw@/);
    expect(p).toContain('<code>https://user:pw@cred.example/careers</code>');
  });

  it('M8: reasons show only on not-eligible jobs', async () => {
    withStore((s) => s.upsertJob(jobRow({ jobKey: 'a4a4a4a4a4a4a4a4', sourceId: '4', dedupeKey: 'd4d4d4d4d4d4d4d4', company: 'Acme Robotics', title: 'SRE', verdict: 'review', reasons: ['remote-unclear'] })));
    const { body } = await get('/?companyKey=acme.example&band=review&band=rejected&band=disclosed&band=undisclosed');
    const row = (k: string) => body.slice(body.indexOf(`data-job="${k}"`), body.indexOf('</li>', body.indexOf(`data-job="${k}"`)));
    expect(row('a4a4a4a4a4a4a4a4')).not.toContain('Not eligible');
    expect(row('a4a4a4a4a4a4a4a4')).not.toContain('remote-unclear');
    expect(row('a2a2a2a2a2a2a2a2')).toContain('Not eligible');
  });

  it('M10: "Read daily" exactly when the daily run reads it (board AND a platform it reads), one helper shared with the daily seeding', async () => {
    withStore((s) => {
      s.upsertCompanyVerdict(verdict('ghco.example', 'GH Co', 'verified', { platform: 'greenhouse', boardUrl: 'https://boards-api.greenhouse.io/v1/boards/ghco/jobs', slug: 'ghco' }), AT);
      s.upsertCompanyVerdict(verdict('noboard.example', 'No Board', 'verified', { platform: 'workday', boardUrl: null }), AT);
    });
    const { body } = await get('/companies');
    const daily = new Set(withStore((s) => s.verifiedCompanies().filter((c) => readsDaily(c)).map((c) => c.companyKey)));
    expect(registryBoards(withStore((s) => s.verifiedCompanies())).map((b) => b.company).sort()).toEqual(
      withStore((s) => s.verifiedCompanies().filter((c) => daily.has(c.companyKey)).map((c) => c.name)).sort(),
    );
    for (const c of withStore((s) => s.listCompanies())) {
      const li = body.slice(body.indexOf(`data-company="${c.companyKey}"`), body.indexOf('</li>', body.indexOf(`data-company="${c.companyKey}"`)));
      expect(/Read daily\.|Still read daily/.test(li), c.companyKey).toBe(daily.has(c.companyKey));
    }
    // Task 11b: a verified Greenhouse company with its board is read daily, by the existing src-greenhouse
    expect(daily.has('ghco.example')).toBe(true);
    const gh = body.slice(body.indexOf('data-company="ghco.example"'), body.indexOf('</li>', body.indexOf('data-company="ghco.example"')));
    expect(gh).toContain('Read daily.');
    expect(body).not.toContain('not one the daily run reads in this build');
    expect(daily.has('noboard.example')).toBe(false);
    expect(daily.has('acme.example')).toBe(true);
  });

  it('the jobs link of a company whose name is hidden still lists its jobs (by company key)', async () => {
    const term = (parseYaml(readFileSync(join(home, 'pack', 'naming.yaml'), 'utf8')) as { forbiddenTerms: string[] }).forbiddenTerms[0] as string;
    withStore((s) => {
      s.upsertCompanyVerdict(verdict('hidden-co.example', `${term} Labs`, 'verified', { platform: 'workday', boardUrl: 'https://hid.wd1.myworkdayjobs.com/wday/cxs/hid/Ext/jobs' }), AT);
      s.upsertJob(jobRow({ jobKey: 'c1c1c1c1c1c1c1c1', sourceId: '11', dedupeKey: 'f1f1f1f1f1f1f1f1', company: `${term} Labs`, title: 'Backend Engineer' }));
    });
    const v = sectionOf((await get('/companies')).body, 'verified');
    expect(v).toContain('href="/?companyKey=hidden-co.example&amp;band=');
    expect(v).not.toContain(term);
    const { body } = await get('/?companyKey=hidden-co.example&band=disclosed&band=undisclosed&band=review');
    expect(body).toContain('data-job="c1c1c1c1c1c1c1c1"');
    expect(body).not.toContain(term);
  });

  it('job counts and links match by company key: a job on the company domain, or on its registry board, whatever its name', async () => {
    withStore((s) => {
      s.addCompanyPick({ companyKey: 'stark-industries.net', name: 'SI Group', website: 'https://stark-industries.net' }, NOW);
      s.upsertJob(jobRow({ jobKey: 'c2c2c2c2c2c2c2c2', sourceId: 'https://careers.stark-industries.net/jobs/1', dedupeKey: 'f2f2f2f2f2f2f2f2', company: 'Stark Industries Inc', source: 'careers', ats: 'careers', url: 'https://careers.stark-industries.net/jobs/1' }));
      s.upsertJob(jobRow({ jobKey: 'c3c3c3c3c3c3c3c3', sourceId: 'acme.wd5.myworkdayjobs.com/acme/External|JR9', dedupeKey: 'f3f3f3f3f3f3f3f3', company: 'ACME Holdings Group', source: 'workday', ats: 'workday', url: 'https://acme.wd5.myworkdayjobs.com/External/job/JR9' }));
    });
    const { body } = await get('/companies');
    const stark = body.slice(body.indexOf('data-company="stark-industries.net"'), body.indexOf('</li>', body.indexOf('data-company="stark-industries.net"')));
    expect(stark).toMatch(/<span class="num">1<\/span> passing your rules/);
    expect(sectionOf(body, 'verified')).toMatch(/<span class="num">2<\/span> passing your rules, <span class="num">1<\/span> not eligible/);
    expect((await get('/?companyKey=stark-industries.net&band=disclosed&band=undisclosed&band=review')).body).toContain('data-job="c2c2c2c2c2c2c2c2"');
    const acme = (await get('/?companyKey=acme.example&band=disclosed&band=undisclosed&band=review&band=rejected')).body;
    expect([...acme.matchAll(/data-job="([0-9a-f]{16})"/g)].map((m) => m[1]).sort()).toEqual(['a1a1a1a1a1a1a1a1', 'a2a2a2a2a2a2a2a2', 'c3c3c3c3c3c3c3c3']);
  });
});
