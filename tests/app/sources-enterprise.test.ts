import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decideEligibility, type EligibilityPack } from '../../src/app/agents/eligibility.js';
import { normalize } from '../../src/app/agents/normalizer.js';
import {
  eightfoldApiOfPage,
  eightfoldBoardOfUrl,
  eightfoldDetailUrl,
  eightfoldJobUrl,
  eightfoldListUrl,
  EIGHTFOLD_MAX_DETAILS,
  EIGHTFOLD_MAX_REQUESTS,
  EIGHTFOLD_MIN_INTERVAL_MS,
  EIGHTFOLD_TIMEOUT_MS,
  eightfoldPagesPerList,
  eightfoldScopes,
  makeSrcEightfold,
  parseEightfoldRef,
  parseListPage as parseEightfoldPage,
  srcEightfoldContract,
  type EightfoldApi,
  type EightfoldHosts,
  type EightfoldRaw,
} from '../../src/app/agents/sources/platforms/eightfold.js';
import {
  makeSrcOracle,
  oracleBoardOfUrl,
  oracleDetailUrl,
  oracleJobUrl,
  oracleListUrl,
  ORACLE_MAX_DETAILS,
  ORACLE_MAX_PAGES,
  ORACLE_MIN_INTERVAL_MS,
  ORACLE_PAGE_SIZE,
  ORACLE_TIMEOUT_MS,
  oracleScopes,
  parseListPage as parseOraclePage,
  parseOracleRef,
  srcOracleContract,
  type OracleHosts,
  type OracleRaw,
} from '../../src/app/agents/sources/platforms/oracle.js';
import { scopeMiss } from '../../src/app/agents/sources/platforms/shared.js';
import { dailyEightfoldHosts, dailyOracleHosts } from '../../src/app/daily-hosts.js';
import { Posting, type DiscoveryRequest, type RawPosting } from '../../src/app/types.js';
import { createHostPacer, issueContext } from '../../src/kernel/broker.js';
import type { AnyContract } from '../../src/kernel/contract.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import type { FetchLike } from '../../src/kernel/providers.js';

/**
 * Task 7: the Eightfold and Oracle Recruiting Cloud daily adapters (and the shared scope rules they reuse from Workday).
 * Fakes serve each platform's recorded request shapes; the recorded fixtures (2026-10-14, trimmed and scrubbed) check
 * the real response shapes, facets and mapping.
 */

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/sources/${name}.json`, import.meta.url), 'utf8')) as T;

const PACK = {
  filters: { roleDeny: ['\\bqa\\b', '\\bintern(ship)?\\b', 'designer', '^manager\\b'] },
  targets: { titles: ['software engineer', 'senior engineer', 'staff engineer', 'lead engineer'] },
  eligibility: { officeCities: ['bengaluru'] },
};

/** A step context like the supervisor's: the registry hosts as egress, the pack, a host pacer on a moving clock. */
function context(contract: AnyContract, egress: string, fetch: FetchLike, hosts: readonly string[], pack: unknown = PACK) {
  let now = Date.parse('2026-10-14T01:30:00Z');
  const clock = { now: () => new Date(now).toISOString() };
  const slept: number[] = [];
  const hostPacer = createHostPacer(PRODUCT_POLICY_V1.minHostIntervalMs, clock, async (ms) => {
    slept.push(ms);
    now += ms;
  });
  const ctx = issueContext({ contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock, signal: new AbortController().signal, egressSets: { [egress]: [...hosts] }, pack, hostPacer });
  return { ctx, slept };
}

const json = (status: number, o: unknown) => ({ status, text: async () => (typeof o === 'string' ? o : JSON.stringify(o)) });
const NF = json(404, 'not found');

// ---------------------------------------------------------------------------
// Eightfold fake tenant
// ---------------------------------------------------------------------------

interface EfJob {
  readonly id: number;
  readonly name: string;
  readonly locations: readonly string[];
  readonly work?: string;
  readonly ts?: number;
  readonly std?: readonly string[];
}
interface EfTenant {
  readonly host: string;
  readonly domain: string;
  readonly api: EightfoldApi;
  readonly jobs: readonly EfJob[];
  readonly count?: number;
  /** The unscoped page's facets, in the API's own shape (v2 `{name: {value: n}}`, PCSX `{name: [[value, n]]}`). */
  readonly facets?: Record<string, unknown>;
  /** Scoped lists by their filter (`location=India`, `Work Type=remote`). */
  readonly scopes?: Readonly<Record<string, { readonly jobs: readonly EfJob[]; readonly count?: number }>>;
  readonly robots?: { readonly status?: number; readonly body: string };
  readonly careers?: { readonly status?: number; readonly body?: string };
  readonly details?: Readonly<Record<string, unknown>>;
  readonly anyDetail?: boolean;
  readonly listStatus?: number;
  readonly ignoreStart?: boolean;
}
const efPos = (api: EightfoldApi, j: EfJob) =>
  api === 'v2'
    ? { id: j.id, name: j.name, locations: j.locations, work_location_option: j.work ?? 'onsite', ...(j.ts === undefined ? {} : { t_create: j.ts }), t_update: 1791930858 }
    : { id: j.id, name: j.name, locations: j.locations, standardizedLocations: j.std ?? [], workLocationOption: j.work ?? 'onsite', ...(j.ts === undefined ? {} : { postedTs: j.ts }) };
const efDetail = (api: EightfoldApi, j: EfJob) =>
  api === 'v2' ? { id: j.id, name: j.name, job_description: `<p>${j.name}: build services in Java.</p>`, locations: j.locations } : { status: 200, data: { id: j.id, name: j.name, jobDescription: `<p>${j.name}: build services in Java.</p>`, locations: j.locations, efcustomTextWorkSite: ['3 days / week in-office'], efcustomTextEmploymentType: ['Full-Time'] } };
const MARKER: Record<EightfoldApi, string> = { v2: '<code id="smartApplyData">{}</code>', pcsx: '<code id="pcsx-data">{}</code>' };

function eightfold(tenants: readonly EfTenant[]) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const u = new URL(url);
    for (const t of tenants) {
      // tenants share a host by their domain parameter (robots.txt has none)
      if (u.hostname !== t.host || (u.searchParams.has('domain') && u.searchParams.get('domain') !== t.domain)) continue;
      if (u.pathname === '/robots.txt') return json(t.robots?.status ?? 200, t.robots?.body ?? 'User-agent: *\nDisallow: /\nAllow: /careers\nAllow: /api/apply\nAllow: /api/pcsx\n');
      if (u.pathname === '/careers') return json(t.careers?.status ?? 200, t.careers?.body ?? `<html>${MARKER[t.api]}</html>`);
      const v2 = u.pathname === '/api/apply/v2/jobs';
      const pcsx = u.pathname === '/api/pcsx/search';
      if (v2 || pcsx) {
        // each tenant answers 403 on the other API (seen live)
        if ((v2 && t.api !== 'v2') || (pcsx && t.api !== 'pcsx')) return json(403, { message: 'PCSX is not enabled for this user.' });
        if (t.listStatus !== undefined) return json(t.listStatus, '');
        if (v2) expect(u.searchParams.get('num')).toBe('10');
        const start = t.ignoreStart === true ? 0 : Number(u.searchParams.get('start'));
        const filters = [...u.searchParams.entries()].filter(([k, v]) => !['domain', 'start', 'num', 'query', 'sort_by'].includes(k) && v !== '');
        const key = filters.map(([k, v]) => `${k}=${v}`).join('&');
        const scope = key === '' ? undefined : t.scopes?.[key];
        if (key !== '' && scope === undefined) return json(400, '');
        const jobs = scope?.jobs ?? t.jobs;
        const count = scope === undefined ? (t.count ?? jobs.length) : (scope.count ?? jobs.length);
        const positions = jobs.slice(start, start + 10).map((j) => efPos(t.api, j));
        // PCSX serves the board's own (unscoped) facets on every page; v2 only on the unscoped page here
        const facets = t.facets !== undefined && (scope === undefined || t.api === 'pcsx') ? t.facets : undefined;
        return json(200, v2 ? { count, positions, ...(facets ? { facets } : {}) } : { status: 200, error: { message: '', body: '' }, data: { count, positions, ...(facets ? { filterDef: { facets } } : {}) } });
      }
      const id = u.pathname.startsWith('/api/apply/v2/jobs/') ? u.pathname.slice('/api/apply/v2/jobs/'.length) : u.pathname === '/api/pcsx/position_details' ? (u.searchParams.get('position_id') ?? '') : null;
      if (id !== null) {
        const listed = [...t.jobs, ...Object.values(t.scopes ?? {}).flatMap((s) => s.jobs)].find((j) => String(j.id) === id);
        const d = t.details?.[id] ?? (t.anyDetail === true && listed !== undefined ? efDetail(t.api, listed) : undefined);
        if (d === undefined) return NF;
        if (typeof d === 'number') return json(d, '');
        return json(200, d);
      }
    }
    return NF;
  };
  return { fetch, calls };
}

const EF_HOST = 'acme.eightfold.ai';
const efJob = (i: number, name = `Senior Software Engineer ${i}`, locations: readonly string[] = ['Bengaluru, KA, India']): EfJob => ({ id: 1000 + i, name, locations, ts: 1791849600 + i });
const efJobs = (n: number, name?: (i: number) => string, where?: (i: number) => readonly string[]): EfJob[] => Array.from({ length: n }, (_, i) => efJob(i, name?.(i), where?.(i)));
/** v2 facets whose counts match the given lists (India values, the remote type). */
const v2Facets = (india: number, remote?: number) => ({ locations: { Remote: 999999, 'Bengaluru, KA, India': india, 'Austin, TX, United States': 3 }, ...(remote === undefined ? {} : { 'Work Type': { onsite: 5, remote } }) });
const tenant = (t: Partial<EfTenant> = {}): EfTenant => ({ host: EF_HOST, domain: 'acme.com', api: 'v2', jobs: [], ...t });
const efReq = (t: { host: string; domain: string }, company = 'Acme'): DiscoveryRequest => ({ ats: 'eightfold', slug: `${t.host}/${t.domain}`, company, runDate: '2026-10-14' });

async function runEf(tenants: readonly EfTenant[], opts: { hosts?: EightfoldHosts; maxPages?: number; maxDetails?: number; pack?: unknown; req?: DiscoveryRequest } = {}) {
  const net = eightfold(tenants);
  const hosts = opts.hosts ?? dailyEightfoldHosts();
  const agent = makeSrcEightfold({ hosts, ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}), ...(opts.maxDetails !== undefined ? { maxDetails: opts.maxDetails } : {}) });
  const { ctx, slept } = context(srcEightfoldContract, 'registry:eightfold-hosts', net.fetch, [...new Set(tenants.map((t) => t.host))], opts.pack ?? PACK);
  const out = await agent.run(opts.req ?? efReq(tenants[0] as EfTenant), ctx);
  return { out, calls: net.calls, skips: ctx.skips(), slept, hosts, agent, ctx };
}
const paths = (calls: readonly string[]) => calls.map((c) => {
  const u = new URL(c);
  return `${u.pathname}${u.search}`;
});
const efLists = (calls: readonly string[]) => calls.filter((c) => /\/api\/(?:apply\/v2\/jobs|pcsx\/search)\?/u.test(c));
const efDetails = (calls: readonly string[]) => calls.filter((c) => /\/api\/apply\/v2\/jobs\/\d|position_details/u.test(c));

describe('Eightfold board refs and URLs', () => {
  it('reads the board from the detector slug or the stored board URL (v2 or PCSX), and refuses anything else', () => {
    expect(parseEightfoldRef('explore.jobs.netflix.net/netflix.com')).toEqual({ host: 'explore.jobs.netflix.net', domain: 'netflix.com' });
    expect(eightfoldBoardOfUrl('https://apply.careers.microsoft.com/api/apply/v2/jobs?domain=microsoft.com')).toEqual({ host: 'apply.careers.microsoft.com', domain: 'microsoft.com' });
    expect(eightfoldBoardOfUrl('https://apply.careers.microsoft.com/api/pcsx/search?domain=Microsoft.com&start=0')).toEqual({ host: 'apply.careers.microsoft.com', domain: 'microsoft.com' });
    for (const bad of ['http://acme.eightfold.ai/api/apply/v2/jobs?domain=acme.com', 'https://acme.eightfold.ai/careers?domain=acme.com', 'https://acme.eightfold.ai/api/apply/v2/jobs', 'https://acme.eightfold.ai:8443/api/apply/v2/jobs?domain=acme.com', 'not a url']) expect(eightfoldBoardOfUrl(bad), bad).toBeNull();
    for (const bad of ['acme.eightfold.ai', 'acme.eightfold.ai/acme.com/x', 'Acme.eightfold.ai/acme.com', 'acme.eightfold.ai/acme']) expect(parseEightfoldRef(bad), bad).toBeNull();
  });

  it('builds the list, detail and job URLs from the recorded patterns', () => {
    const nf = { host: 'explore.jobs.netflix.net', domain: 'netflix.com' };
    const ms = { host: 'apply.careers.microsoft.com', domain: 'microsoft.com' };
    expect(eightfoldListUrl(nf, 'v2', 0)).toBe('https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com&start=0&num=10');
    expect(eightfoldListUrl(nf, 'v2', 20, { 'Work Type': 'remote' })).toBe('https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com&start=20&num=10&Work%20Type=remote');
    expect(eightfoldListUrl(nf, 'v2', 0, { location: 'India' })).toBe('https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com&start=0&num=10&location=India');
    expect(eightfoldListUrl(ms, 'pcsx', 0)).toBe('https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com&query=&location=&start=0&sort_by=relevance');
    expect(eightfoldListUrl(ms, 'pcsx', 10, { location: 'India' })).toBe('https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com&query=&location=India&start=10&sort_by=relevance');
    expect(eightfoldDetailUrl(nf, 'v2', '790318927263')).toBe('https://explore.jobs.netflix.net/api/apply/v2/jobs/790318927263?domain=netflix.com');
    expect(eightfoldDetailUrl(ms, 'pcsx', '1970393556994911')).toBe('https://apply.careers.microsoft.com/api/pcsx/position_details?position_id=1970393556994911&domain=microsoft.com&hl=en');
    // the recorded public job URLs follow the pattern
    const nfx = fixture<{ scoped: { india: { positions: { id: number; canonicalPositionUrl: string }[] } } }>('eightfold-netflix');
    for (const p of nfx.scoped.india.positions) expect(eightfoldJobUrl(nf, String(p.id))).toBe(p.canonicalPositionUrl);
    const msx = fixture<{ details: Record<string, { data: { id: number; publicUrl: string } }> }>('eightfold-microsoft');
    for (const d of Object.values(msx.details)) expect(eightfoldJobUrl(ms, String(d.data.id))).toBe(d.data.publicUrl);
  });

  it('the API comes from the careers page configuration marker, never from a guess', () => {
    const nfx = fixture<{ careersPage: string }>('eightfold-netflix');
    const msx = fixture<{ careersPage: string }>('eightfold-microsoft');
    expect(eightfoldApiOfPage(nfx.careersPage)).toBe('v2');
    expect(eightfoldApiOfPage(msx.careersPage)).toBe('pcsx');
    expect(eightfoldApiOfPage('<html><div id="careers">x</div></html>')).toBeNull();
  });
});

describe('src-eightfold: the API flavour, paging and shapes', () => {
  it('reads a PCSX tenant through PCSX only, and a v2 tenant through v2 only: the other API (a 403) is never asked', async () => {
    for (const api of ['v2', 'pcsx'] as const) {
      const r = await runEf([tenant({ api, jobs: efJobs(3, () => 'Account Executive', () => ['Austin, TX, United States']) })]);
      expect(r.out).toHaveLength(3);
      const other = api === 'v2' ? '/api/pcsx/' : '/api/apply/';
      expect(r.calls.some((c) => c.includes(other)), api).toBe(false);
      expect(paths(r.calls)[0]).toBe('/robots.txt');
      expect(paths(r.calls)[1]).toBe('/careers?domain=acme.com');
    }
  });

  it('a careers page naming neither API is input_rejected (eightfold-api-unknown), nothing listed', async () => {
    const r = runEf([tenant({ careers: { body: '<html>no config</html>' }, jobs: efJobs(1) })]);
    await expect(r).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^eightfold-api-unknown Acme: /) });
  });

  it('pages by start += 10 until start >= count (the unscoped fallback, no locations facet)', async () => {
    const { out, calls } = await runEf([tenant({ jobs: efJobs(25, () => 'Account Executive', () => ['Austin, TX, United States']) })]);
    expect(out).toHaveLength(25);
    // the discovery page is the fallback's page 1
    expect(efLists(calls).map((c) => new URL(c).searchParams.get('start'))).toEqual(['0', '10', '20']);
    expect(out.map((p) => p.sourceId)).toEqual([...out.map((p) => p.sourceId)].sort());
  });

  it('cap: a list longer than the page cap fails loudly (input_rejected), never truncated', async () => {
    const r = runEf([tenant({ jobs: efJobs(35, () => 'Account Executive', () => ['Austin, TX, United States']) })], { maxPages: 3 });
    await expect(r).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/page cap reached at 30 postings \(count 35, 3 pages\)/) });
  });

  it('a page repeating earlier postings (start ignored) is invalid_output; a short list gets a named note', async () => {
    await expect(runEf([tenant({ jobs: efJobs(25, () => 'Account Executive', () => ['Austin, TX, United States']), ignoreStart: true })])).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/repeats earlier postings/) });
    const { out, skips } = await runEf([tenant({ jobs: efJobs(12, () => 'Account Executive', () => ['Austin, TX, United States']), count: 30 })]);
    expect(out).toHaveLength(12);
    expect(skips).toContain('short-list Acme: count 30, listed 12');
  });

  it('a response missing an expected field is invalid_output, never partially parsed; a bare entry is skipped with a note', () => {
    expect(() => parseEightfoldPage('v2', { positions: [] }, 'eightfold x')).toThrow(/response shape is not valid \(count:/);
    expect(() => parseEightfoldPage('pcsx', { data: { count: 1 } }, 'eightfold x')).toThrow(/response shape is not valid \(data\.positions:/);
    expect(() => parseEightfoldPage('v2', { count: 1, positions: [{ name: 'x' }] }, 'eightfold x')).toThrow(/all 1 entries lack an id or a name/);
    const p = parseEightfoldPage('v2', { count: 2, positions: [{ id: 1, name: 'A' }, { name: '' }] }, 'eightfold x');
    expect(p.positions.map((x) => x.id)).toEqual(['1']);
    expect(p.malformed).toEqual([1]);
    expect(p.listed).toBe(2);
  });

  it('a detail without its description is invalid_output; a gone detail (404) drops the job with a named note', async () => {
    const jobs = efJobs(2);
    const bad = runEf([tenant({ jobs, facets: v2Facets(2), scopes: { 'location=India': { jobs } }, details: { '1000': { id: 1000, name: 'x' } } })]);
    await expect(bad).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/detail: response shape is not valid \(job_description:/) });
    const { out, skips } = await runEf([tenant({ jobs, facets: v2Facets(2), scopes: { 'location=India': { jobs } }, details: { '1000': 404, '1001': efDetail('v2', jobs[1] as EfJob) } })]);
    expect(out.map((p) => p.sourceId)).toEqual(['1001']);
    expect(skips).toContain('detail-gone Acme: 1 job gone between list and detail (1000)');
  });

  it('a retired board (careers page 404) is gone; answers only eightfold requests', async () => {
    await expect(runEf([tenant({ careers: { status: 404 } })])).rejects.toMatchObject({ code: 'gone' });
    const r = await runEf([tenant()], { req: { ats: 'workday', slug: 'x', company: 'X', runDate: '2026-10-14' } });
    expect(r.out).toEqual([]);
    expect(r.calls).toEqual([]);
  });
});

describe('src-eightfold scope: India and remote, checked against the facet counts', () => {
  const remoteJobs = efJobs(4, (i) => `Staff Engineer R${i}`, () => ['Remote, United States']).map((j, i) => ({ ...j, id: 2000 + i, work: 'remote' }));
  const india = efJobs(3);

  it('reads location=India and the v2 work-type remote list, their union deduped by job id', async () => {
    const both = india[0] as EfJob;
    const t = tenant({ jobs: [...india, ...remoteJobs], facets: v2Facets(3, 5), scopes: { 'location=India': { jobs: india }, 'Work Type=remote': { jobs: [...remoteJobs, both] } }, anyDetail: true });
    const { out, calls } = await runEf([t]);
    expect(out.map((p) => p.sourceId)).toEqual(['1000', '1001', '1002', '2000', '2001', '2002', '2003']);
    expect(efLists(calls).map((c) => paths([c])[0])).toEqual([
      '/api/apply/v2/jobs?domain=acme.com&start=0&num=10',
      '/api/apply/v2/jobs?domain=acme.com&start=0&num=10&location=India',
      '/api/apply/v2/jobs?domain=acme.com&start=0&num=10&Work%20Type=remote',
    ]);
  });

  it('discovers the recorded tenants: Netflix India 9 and Work Type remote 112; Microsoft India (Bengaluru 131 + Hyderabad 117), no remote count (sentinel)', () => {
    const nf = fixture<{ discovery: unknown; scoped: { india: { count: number }; remote: { count: number } } }>('eightfold-netflix');
    const n = eightfoldScopes('v2', parseEightfoldPage('v2', nf.discovery, 'nf'));
    expect(n.india).toEqual({ query: { location: 'India' }, expected: 9, largest: 9 });
    expect(n.remote).toEqual({ query: { 'Work Type': 'remote' }, expected: 112, largest: 112 });
    expect(scopeMiss(nf.scoped.india.count, n.india!)).toBeNull();
    expect(scopeMiss(nf.scoped.remote.count, n.remote!)).toBeNull();
    const ms = fixture<{ discovery: unknown; scoped: { india: { data: { count: number } }[] } }>('eightfold-microsoft');
    const m = eightfoldScopes('pcsx', parseEightfoldPage('pcsx', ms.discovery, 'ms'));
    expect(m.india).toEqual({ query: { location: 'India' }, expected: 248, largest: 131 });
    expect(m.remote).toBeNull();
    expect(scopeMiss(ms.scoped.india[0]!.data.count, m.india!)).toBeNull();
  });

  it('scope-not-applied, both bounds: a total above the counts (the filter ignored) or far below the largest value fails input_rejected, nothing read', async () => {
    const all = efJobs(40, () => 'Account Executive', (i) => (i < 3 ? ['Bengaluru, KA, India'] : ['Austin, TX, United States']));
    const above = runEf([tenant({ jobs: all, facets: v2Facets(3), scopes: { 'location=India': { jobs: all } } })]);
    await expect(above).rejects.toMatchObject({ code: 'input_rejected', message: 'scope-not-applied Acme india list: total 40, the facet counts 3; Eightfold did not apply the scope, nothing read from it' });
    const below = runEf([tenant({ jobs: all, facets: v2Facets(30), scopes: { 'location=India': { jobs: [] } } })]);
    await expect(below).rejects.toMatchObject({ code: 'input_rejected', message: 'scope-not-applied Acme india list: total 0, below its largest facet value 30; Eightfold did not apply the scope, nothing read from it' });
    // within max(5, 5%): applied
    const near = await runEf([tenant({ jobs: all, facets: v2Facets(3), scopes: { 'location=India': { jobs: all.slice(0, 8) } } })]);
    expect(near.out).toHaveLength(8);
  });

  it('a locations facet naming neither India nor a remote type: a named skip, nothing read past discovery', async () => {
    const { out, calls, skips } = await runEf([tenant({ jobs: efJobs(3), facets: { locations: { 'Austin, TX, United States': 3 } } })]);
    expect(out).toEqual([]);
    expect(efLists(calls)).toHaveLength(1);
    expect(skips).toEqual(['no-india-or-remote-facet Acme: its locations facet names neither India nor a remote type']);
  });

  it('PCSX: no remote list (its "Remote" value is a sentinel); India read with location=India', async () => {
    const pcsxFacets = { locations: [['Remote', 999999], ['Redmond, WA, United States', 769], ['Bengaluru, KA, India', 3]] };
    const { out, calls } = await runEf([tenant({ api: 'pcsx', jobs: india, facets: pcsxFacets, scopes: { 'location=India': { jobs: india } }, anyDetail: true })]);
    expect(out).toHaveLength(3);
    expect(efLists(calls).map((c) => new URL(c).searchParams.get('location'))).toEqual(['', 'India']);
  });

  it('dedupe across lists prefers the posting naming an office city, then India, then the first seen', async () => {
    const elsewhere = { ...(india[0] as EfJob), locations: ['Remote, United States'] };
    const t = tenant({ jobs: india, facets: v2Facets(3, 1), scopes: { 'Work Type=remote': { jobs: [elsewhere] }, 'location=India': { jobs: india } } });
    const { out } = await runEf([t], { maxDetails: 0 });
    expect((out.find((p) => p.sourceId === '1000')?.raw as EightfoldRaw).locations).toEqual(['Bengaluru, KA, India']);
  });

  it('the discovery (API and scopes) is cached per company per run: a second read skips the careers and discovery pages', async () => {
    const hosts = dailyEightfoldHosts();
    const t = tenant({ jobs: india, facets: v2Facets(3), scopes: { 'location=India': { jobs: india } } });
    const first = await runEf([t], { hosts, maxDetails: 0 });
    const again = await runEf([t], { hosts, maxDetails: 0 });
    expect(again.out).toEqual(first.out);
    expect(paths(again.calls)).toEqual(['/api/apply/v2/jobs?domain=acme.com&start=0&num=10&location=India']);
  });
});

describe('src-eightfold details: rank 0, the title pre-filter and the budget', () => {
  it('budget stop: details for the first N rank-0 passing jobs only (ties by id), a named note for the rest; every job flows', async () => {
    const jobs = [...efJobs(5), efJob(5, 'Senior Software Engineer X', ['Austin, TX, United States']), efJob(6, 'Account Executive')];
    const t = tenant({ jobs, facets: v2Facets(7), scopes: { 'location=India': { jobs } }, anyDetail: true });
    const { out, calls, skips } = await runEf([t], { maxDetails: 2 });
    expect(out).toHaveLength(7);
    expect(efDetails(calls).map((c) => new URL(c).pathname.split('/').pop())).toEqual(['1000', '1001']);
    expect(skips).toContain('detail-budget Acme: 4 jobs without detail (3 over the budget, 1 not India-named)');
    expect(out.filter((p) => (p.raw as EightfoldRaw).detail !== null).map((p) => p.sourceId)).toEqual(['1000', '1001']);
    expect(EIGHTFOLD_MAX_DETAILS).toBe(40);
  });

  it('a PCSX standardized location ("Gurugram, HR, IN") counts as India-named', async () => {
    const j = { ...efJob(0, 'Senior Software Engineer', ['India, Haryana, Gurgaon']), std: ['Gurugram, HR, IN'] };
    const t = tenant({ api: 'pcsx', jobs: [j], facets: { locations: [['Bengaluru, KA, India', 1]] }, scopes: { 'location=India': { jobs: [j] } }, anyDetail: true });
    const { out } = await runEf([t]);
    expect((out[0]?.raw as EightfoldRaw).detail?.workSite).toBe('3 days / week in-office');
  });
});

describe('src-eightfold robots.txt, refusals and spacing', () => {
  it('a robots.txt disallowing the API is a named skip for the company today: nothing else is fetched', async () => {
    const { out, calls, skips } = await runEf([tenant({ jobs: efJobs(2), robots: { body: 'User-agent: *\nDisallow: /\nAllow: /careers\n' } })]);
    expect(out).toEqual([]);
    expect(paths(calls)).toEqual(['/robots.txt', '/careers?domain=acme.com']);
    expect(skips).toEqual(['robots-disallow acme.eightfold.ai: Acme not read today (robots-disallow /api/apply/v2/jobs)']);
  });

  it('a 403 robots.txt refuses (robots-forbidden); robots.txt is fetched once per host per run', async () => {
    const r = await runEf([tenant({ robots: { status: 403, body: '' } })]);
    expect(r.skips[0]).toContain('(robots-forbidden)');
    const hosts = dailyEightfoldHosts();
    const a = tenant({ jobs: efJobs(1, () => 'Account Executive', () => ['Austin, TX, United States']) });
    const b = { ...a, domain: 'acme-two.com' };
    const net = eightfold([a, b]);
    const agent = makeSrcEightfold({ hosts });
    const { ctx } = context(srcEightfoldContract, 'registry:eightfold-hosts', net.fetch, [EF_HOST]);
    await agent.run(efReq(a), ctx);
    await agent.run(efReq(b, 'Acme Two'), ctx);
    expect(net.calls.filter((c) => c.endsWith('/robots.txt'))).toHaveLength(1);
  });

  it('403 on the list: challenged and the host disabled; a sibling on the host is deferred without a request. 429: rate_limit, never retried', async () => {
    const hosts = dailyEightfoldHosts();
    const a = tenant({ listStatus: 403 });
    const net = eightfold([a]);
    const agent = makeSrcEightfold({ hosts });
    const { ctx } = context(srcEightfoldContract, 'registry:eightfold-hosts', net.fetch, [EF_HOST]);
    await expect(agent.run(efReq(a), ctx)).rejects.toMatchObject({ code: 'challenged', message: expect.stringMatching(/answered 403: the host is disabled for this run, never retried around/) });
    const before = net.calls.length;
    await expect(agent.run(efReq({ host: EF_HOST, domain: 'other.com' }), ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^host-disabled:http-403 on acme\.eightfold\.ai/) });
    expect(net.calls.length).toBe(before);
    const h2 = dailyEightfoldHosts();
    await expect(runEf([tenant({ listStatus: 429 })], { hosts: h2 })).rejects.toMatchObject({ code: 'rate_limit' });
    expect(h2.disabledWhy(EF_HOST)).toBe('http-429');
    expect(srcEightfoldContract.retry.on).not.toContain('rate_limit');
    expect(srcEightfoldContract.team).toBe('sourcing-eightfold');
  });

  it('every request to the host is at least 5 s after the previous one', async () => {
    const { calls, slept } = await runEf([tenant({ jobs: efJobs(3), facets: v2Facets(3), scopes: { 'location=India': { jobs: efJobs(3) } }, anyDetail: true })]);
    expect(calls.length).toBe(1 + 1 + 1 + 1 + 3);
    expect(slept).toHaveLength(calls.length - 1);
    expect(slept.every((ms) => ms >= EIGHTFOLD_MIN_INTERVAL_MS)).toBe(true);
    expect(EIGHTFOLD_MIN_INTERVAL_MS).toBe(5000);
  });

  it('the per-list page cap keeps the worst case within the step timeout at the 5 s spacing', () => {
    const worst = 3 + EIGHTFOLD_MAX_DETAILS + 2 * eightfoldPagesPerList(2);
    expect(worst).toBeLessThanOrEqual(EIGHTFOLD_MAX_REQUESTS);
    expect(worst * EIGHTFOLD_MIN_INTERVAL_MS).toBeLessThan(EIGHTFOLD_TIMEOUT_MS);
    expect(eightfoldPagesPerList(1)).toBeLessThanOrEqual(100);
  });

  it('a host outside the run egress is refused by the broker', async () => {
    const net = eightfold([tenant({ jobs: efJobs(1) })]);
    const { ctx } = context(srcEightfoldContract, 'registry:eightfold-hosts', net.fetch, ['other.eightfold.ai']);
    await expect(makeSrcEightfold({ hosts: dailyEightfoldHosts() }).run(efReq(tenant()), ctx)).rejects.toThrow(/G-EGRESS/);
    expect(net.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Oracle fake tenant
// ---------------------------------------------------------------------------

interface OrReq {
  readonly Id: string;
  readonly Title: string;
  readonly PrimaryLocation: string;
  readonly PrimaryLocationCountry: string;
  readonly PostedDate?: string | null;
  readonly secondaryLocations?: readonly { readonly Name: string; readonly CountryCode: string }[];
  readonly WorkplaceTypeCode?: string | null;
}
interface OrFacet {
  readonly Id: number | string;
  readonly Name: string;
  readonly TotalCount: number;
}
interface OrTenant {
  readonly host: string;
  readonly site: string;
  readonly reqs: readonly OrReq[];
  readonly total?: number;
  readonly locations?: readonly OrFacet[];
  readonly workplace?: readonly OrFacet[];
  /** Scoped lists by their finder filter (`locationId=300`, `selectedWorkplaceTypesFacet=ORA_REMOTE`). */
  readonly scopes?: Readonly<Record<string, { readonly reqs: readonly OrReq[]; readonly total?: number }>>;
  readonly robots?: { readonly status?: number; readonly body: string };
  readonly details?: Readonly<Record<string, unknown>>;
  readonly anyDetail?: boolean;
  readonly listStatus?: number;
  readonly ignoreOffset?: boolean;
}
const orDetail = (r: OrReq) => ({ items: [{ Id: r.Id, Title: r.Title, ExternalDescriptionStr: `<p>${r.Title}: build services in Java.</p>`, ExternalResponsibilitiesStr: '<ul><li>Design APIs</li></ul>', ExternalQualificationsStr: '', JobSchedule: 'Full time', PrimaryLocation: r.PrimaryLocation, PrimaryLocationCountry: r.PrimaryLocationCountry, secondaryLocations: [] }], count: 1 });
const finderOf = (u: URL): Record<string, string> => {
  const f = u.searchParams.get('finder') ?? '';
  const body = f.slice(f.indexOf(';') + 1);
  return Object.fromEntries(body.split(',').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
};

function oracle(tenants: readonly OrTenant[]) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const u = new URL(url);
    for (const t of tenants) {
      if (u.hostname !== t.host) continue;
      // Oracle's WAF answers 403 for robots.txt (seen live)
      if (u.pathname === '/robots.txt') return json(t.robots?.status ?? 403, t.robots?.body ?? '<html><h1>W4S-402: Blocked by WAF4SaaS</h1></html>');
      if (u.pathname === '/hcmRestApi/resources/latest/recruitingCEJobRequisitions') {
        if (t.listStatus !== undefined) return json(t.listStatus, '');
        const f = finderOf(u);
        expect(f['siteNumber']).toBe(t.site);
        expect(f['limit']).toBe(String(ORACLE_PAGE_SIZE));
        expect(u.searchParams.get('onlyData')).toBe('true');
        const offset = t.ignoreOffset === true ? 0 : Number(f['offset']);
        const filters = Object.entries(f).filter(([k]) => k === 'locationId' || k === 'selectedWorkplaceTypesFacet');
        const key = filters.map(([k, v]) => `${k}=${v}`).join('&');
        const scope = key === '' ? undefined : t.scopes?.[key];
        if (key !== '' && scope === undefined) return json(400, '');
        const reqs = scope?.reqs ?? t.reqs;
        const total = scope === undefined ? (t.total ?? reqs.length) : (scope.total ?? reqs.length);
        return json(200, { items: [{ TotalJobsCount: total, Offset: offset, Limit: ORACLE_PAGE_SIZE, requisitionList: reqs.slice(offset, offset + ORACLE_PAGE_SIZE), locationsFacet: t.locations ?? [], workplaceTypesFacet: t.workplace ?? [] }], count: 1, hasMore: false });
      }
      if (u.pathname === '/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails') {
        const id = /Id="([^"]+)"/u.exec(u.searchParams.get('finder') ?? '')?.[1] ?? '';
        const listed = [...t.reqs, ...Object.values(t.scopes ?? {}).flatMap((s) => s.reqs)].find((r) => r.Id === id);
        const d = t.details?.[id] ?? (t.anyDetail === true && listed !== undefined ? orDetail(listed) : undefined);
        if (d === undefined) return json(200, { items: [], count: 0 });
        if (typeof d === 'number') return json(d, '');
        return json(200, d);
      }
    }
    return NF;
  };
  return { fetch, calls };
}

const OR_HOST = 'acme.fa.us2.oraclecloud.com';
const INDIA_ID = 300000000289360;
const orReq = (i: number, Title = `Senior Software Engineer ${i}`, PrimaryLocation = 'Bengaluru, Karnataka, India', PrimaryLocationCountry = 'IN'): OrReq => ({ Id: String(210700000 + i), Title, PrimaryLocation, PrimaryLocationCountry, PostedDate: '2026-10-13', secondaryLocations: [], WorkplaceTypeCode: null });
const orReqs = (n: number, title?: (i: number) => string, where?: (i: number) => [string, string]): OrReq[] => Array.from({ length: n }, (_, i) => orReq(i, title?.(i), ...(where?.(i) ?? [])));
const indiaFacet = (n: number): OrFacet[] => [{ Id: 300000000289738, Name: 'United States', TotalCount: 500 }, { Id: INDIA_ID, Name: 'India', TotalCount: n }, { Id: 300000081145775, Name: 'Bengaluru, Karnataka, India', TotalCount: n }];
const site = (t: Partial<OrTenant> = {}): OrTenant => ({ host: OR_HOST, site: 'CX_1', reqs: [], ...t });
const orReqFor = (t: { host: string; site: string }, company = 'Acme Bank'): DiscoveryRequest => ({ ats: 'oracle', slug: `${t.host}/${t.site}`, company, runDate: '2026-10-14' });

async function runOr(tenants: readonly OrTenant[], opts: { hosts?: OracleHosts; maxPages?: number; maxDetails?: number; pack?: unknown; req?: DiscoveryRequest } = {}) {
  const net = oracle(tenants);
  const hosts = opts.hosts ?? dailyOracleHosts();
  const agent = makeSrcOracle({ hosts, ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}), ...(opts.maxDetails !== undefined ? { maxDetails: opts.maxDetails } : {}) });
  const { ctx, slept } = context(srcOracleContract, 'registry:oracle-hosts', net.fetch, [...new Set(tenants.map((t) => t.host))], opts.pack ?? PACK);
  const out = await agent.run(opts.req ?? orReqFor(tenants[0] as OrTenant), ctx);
  return { out, calls: net.calls, skips: ctx.skips(), slept, hosts, ctx };
}
const orLists = (calls: readonly string[]) => calls.filter((c) => c.includes('recruitingCEJobRequisitions?'));
const orDetails = (calls: readonly string[]) => calls.filter((c) => c.includes('recruitingCEJobRequisitionDetails?'));
const offsetOf = (c: string) => finderOf(new URL(c))['offset'];

describe('Oracle Recruiting Cloud board refs and URLs', () => {
  it('reads the board from the detector slug or its stored board URL, and refuses anything else', () => {
    expect(parseOracleRef('jpmc.fa.oraclecloud.com/CX_1001')).toEqual({ host: 'jpmc.fa.oraclecloud.com', site: 'CX_1001' });
    expect(oracleBoardOfUrl('https://jpmc.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=CX_1001')).toEqual({ host: 'jpmc.fa.oraclecloud.com', site: 'CX_1001' });
    for (const bad of ['https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001', 'http://jpmc.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?finder=findReqs;siteNumber=CX_1', 'https://evil.test/hcmRestApi/resources/latest/recruitingCEJobRequisitions?finder=findReqs;siteNumber=CX_1', 'x']) expect(oracleBoardOfUrl(bad), bad).toBeNull();
    for (const bad of ['jpmc.fa.oraclecloud.com', 'evil.test/CX_1', 'jpmc.fa.oraclecloud.com/CX 1', 'jpmc.fa.oraclecloud.com/CX_1/x']) expect(parseOracleRef(bad), bad).toBeNull();
  });

  it('builds the list (limit and offset inside the finder), detail and job URLs from the recorded patterns', () => {
    const b = { host: 'jpmc.fa.oraclecloud.com', site: 'CX_1001' };
    const base = 'https://jpmc.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=CX_1001,facetsList=LOCATIONS%3BWORKPLACE_TYPES,limit=100';
    expect(oracleListUrl(b, 0)).toBe(`${base},offset=0`);
    expect(oracleListUrl(b, 200, { locationId: String(INDIA_ID) })).toBe(`${base},offset=200,locationId=300000000289360`);
    expect(oracleDetailUrl(b, '210749291')).toBe('https://jpmc.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22210749291%22,siteNumber=CX_1001');
    expect(oracleJobUrl(b, '210749291')).toBe('https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210749291');
  });
});

describe('src-oracle: robots.txt unreadable (403), spacing, the page cap', () => {
  it('robots.txt answering 403 (the WAF) is "unknown": the API is read, every request at least 5 s after the previous one', async () => {
    const reqs = orReqs(3);
    const { out, calls, slept, skips } = await runOr([site({ reqs, locations: indiaFacet(3), scopes: { [`locationId=${INDIA_ID}`]: { reqs } }, anyDetail: true })]);
    expect(out).toHaveLength(3);
    expect(skips).toEqual([]);
    expect(calls[0]).toBe(`https://${OR_HOST}/robots.txt`);
    expect(calls).toHaveLength(1 + 2 + 3);
    expect(slept).toHaveLength(calls.length - 1);
    expect(slept.every((ms) => ms >= ORACLE_MIN_INTERVAL_MS)).toBe(true);
    expect(ORACLE_MIN_INTERVAL_MS).toBe(5000);
  });

  it('a readable robots.txt disallowing the REST path is a named skip; a challenge page on robots.txt disables the host', async () => {
    const { out, calls, skips } = await runOr([site({ reqs: orReqs(2), robots: { status: 200, body: 'User-agent: *\nDisallow: /hcmRestApi/\n' } })]);
    expect(out).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(skips).toEqual(['robots-disallow acme.fa.us2.oraclecloud.com: Acme Bank not read today (robots-disallow /hcmRestApi/resources/latest/recruitingCEJobRequisitions)']);
    const hosts = dailyOracleHosts();
    await expect(runOr([site({ robots: { status: 403, body: '<title>Just a moment...</title>' } })], { hosts })).rejects.toMatchObject({ code: 'challenged' });
    expect(hosts.disabledWhy(OR_HOST)).toBe('challenge');
  });

  it('401/403/429 on the API disables the host for the run, named; never retried around', async () => {
    for (const [status, code, why] of [[401, 'challenged', 'http-401'], [403, 'challenged', 'http-403'], [429, 'rate_limit', 'http-429']] as const) {
      const hosts = dailyOracleHosts();
      await expect(runOr([site({ listStatus: status })], { hosts })).rejects.toMatchObject({ code });
      expect(hosts.disabledWhy(OR_HOST)).toBe(why);
    }
    expect(srcOracleContract.retry.on).not.toContain('rate_limit');
    expect(srcOracleContract.team).toBe('sourcing-oracle');
  });

  it(`pages by offset += ${ORACLE_PAGE_SIZE}; at most ${ORACLE_MAX_PAGES} list pages per company, discovery included: a longer read fails loudly`, async () => {
    const reqs = orReqs(250, () => 'Account Executive');
    const { out, calls } = await runOr([site({ reqs, locations: indiaFacet(250), scopes: { [`locationId=${INDIA_ID}`]: { reqs } } })]);
    expect(out).toHaveLength(250);
    expect(orLists(calls).map(offsetOf)).toEqual(['0', '0', '100', '200']);
    const big = orReqs(950, () => 'Account Executive');
    const r = runOr([site({ reqs: big, locations: indiaFacet(950), scopes: { [`locationId=${INDIA_ID}`]: { reqs: big } } })]);
    await expect(r).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/page cap reached at 900 postings \(total 950; 10 list pages per company per day, discovery included\)/) });
    expect(ORACLE_MAX_PAGES).toBe(10);
  });

  it('a repeated page is invalid_output; a short list gets a named note; a missing field is never partially parsed', async () => {
    const reqs = orReqs(150, () => 'Account Executive');
    await expect(runOr([site({ reqs, locations: indiaFacet(150), scopes: { [`locationId=${INDIA_ID}`]: { reqs } }, ignoreOffset: true })])).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/repeats earlier postings/) });
    const { skips } = await runOr([site({ reqs: orReqs(5, () => 'Account Executive'), locations: indiaFacet(9), scopes: { [`locationId=${INDIA_ID}`]: { reqs: orReqs(5, () => 'Account Executive'), total: 9 } } })]);
    expect(skips).toContain('short-list Acme Bank (india list): total 9, listed 5');
    expect(() => parseOraclePage({ items: [] }, 'oracle x')).toThrow(/response shape is not valid \(items:/);
    expect(() => parseOraclePage({ items: [{ requisitionList: [] }] }, 'oracle x')).toThrow(/response shape is not valid \(items\.0\.TotalJobsCount:/);
    expect(() => parseOraclePage({ items: [{ TotalJobsCount: 1, requisitionList: [{ Title: 'x' }] }] }, 'oracle x')).toThrow(/all 1 entries lack an Id or a Title/);
  });
});

describe('src-oracle scope: the India location id, the remote workplace type, both bounds', () => {
  it('discovers the recorded JPMorgan facets: India 297 by its location id; on-site only, so no remote list', () => {
    const fx = fixture<{ discovery: unknown; scoped: { india: { items: [{ TotalJobsCount: number }] } } }>('oracle-jpmorgan');
    const s = oracleScopes(parseOraclePage(fx.discovery, 'jpm'));
    expect(s.india).toEqual({ query: { locationId: String(INDIA_ID) }, expected: 297, largest: 297 });
    expect(s.remote).toBeNull();
    expect(s.located).toBe(true);
    expect(scopeMiss(fx.scoped.india.items[0].TotalJobsCount, s.india!)).toBeNull();
  });

  it('reads the India list by locationId and the remote list by its workplace type, deduped by requisition id', async () => {
    const india = orReqs(3);
    const remote = [orReq(9, 'Staff Engineer', 'United States', 'US'), india[0] as OrReq];
    const t = site({ reqs: [...india, ...remote], locations: indiaFacet(3), workplace: [{ Id: 'ORA_ON_SITE', Name: 'On-site', TotalCount: 3 }, { Id: 'ORA_REMOTE', Name: 'Remote', TotalCount: 2 }], scopes: { [`locationId=${INDIA_ID}`]: { reqs: india }, 'selectedWorkplaceTypesFacet=ORA_REMOTE': { reqs: remote } } });
    const { out, calls } = await runOr([t], { maxDetails: 0 });
    expect(out.map((p) => p.sourceId)).toEqual(['210700000', '210700001', '210700002', '210700009']);
    expect(orLists(calls).map((c) => Object.keys(finderOf(new URL(c))).filter((k) => k === 'locationId' || k === 'selectedWorkplaceTypesFacet'))).toEqual([[], ['locationId'], ['selectedWorkplaceTypesFacet']]);
  });

  it('scope-not-applied, both bounds: input_rejected, nothing read from the list', async () => {
    const all = orReqs(60, () => 'Account Executive');
    await expect(runOr([site({ reqs: all, locations: indiaFacet(20), scopes: { [`locationId=${INDIA_ID}`]: { reqs: all } } })])).rejects.toMatchObject({ code: 'input_rejected', message: 'scope-not-applied Acme Bank india list: total 60, the facet counts 20; Oracle did not apply the scope, nothing read from it' });
    await expect(runOr([site({ reqs: all, locations: indiaFacet(20), scopes: { [`locationId=${INDIA_ID}`]: { reqs: [] } } })])).rejects.toMatchObject({ code: 'input_rejected', message: 'scope-not-applied Acme Bank india list: total 0, below its largest facet value 20; Oracle did not apply the scope, nothing read from it' });
  });

  it('location facets without India or a remote type: a named skip; no location facets at all: the unscoped read from the discovery page', async () => {
    const r = await runOr([site({ reqs: orReqs(2), locations: [{ Id: 1, Name: 'United States', TotalCount: 2 }] })]);
    expect(r.out).toEqual([]);
    expect(r.skips).toEqual(['no-india-or-remote-facet Acme Bank: its location facets name neither India nor a remote workplace type']);
    expect(orLists(r.calls)).toHaveLength(1);
    const u = await runOr([site({ reqs: orReqs(2, () => 'Account Executive') })]);
    expect(u.out).toHaveLength(2);
    expect(orLists(u.calls)).toHaveLength(1);
  });

  it('dedupe across lists: the posting naming an office city wins over another of the same requisition', async () => {
    const india = [orReq(0, 'Senior Software Engineer', 'Mumbai, Maharashtra, India')].map((r) => ({ ...r, secondaryLocations: [{ Name: 'Bengaluru, Karnataka, India', CountryCode: 'IN' }] }));
    const remote = [orReq(0, 'Senior Software Engineer', 'United States', 'US')];
    const t = site({ reqs: india, locations: indiaFacet(1), workplace: [{ Id: 'ORA_REMOTE', Name: 'Remote', TotalCount: 1 }], scopes: { 'selectedWorkplaceTypesFacet=ORA_REMOTE': { reqs: remote }, [`locationId=${INDIA_ID}`]: { reqs: india } } });
    const { out } = await runOr([t], { maxDetails: 0 });
    expect((out[0]?.raw as OracleRaw).primaryLocation).toBe('Mumbai, Maharashtra, India');
  });
});

describe('src-oracle details: rank 0, the pre-filter and the budget', () => {
  it('details only for rank-0 passing titles (ties by id), at most the budget; a named note; a gone detail drops the job', async () => {
    const reqs = [...orReqs(4), orReq(5, 'Senior Software Engineer X', 'United States', 'US'), orReq(6, 'Account Executive')];
    const t = site({ reqs, locations: indiaFacet(6), scopes: { [`locationId=${INDIA_ID}`]: { reqs } }, anyDetail: true, details: { '210700001': { items: [], count: 0 } } });
    const { out, calls, skips } = await runOr([t], { maxDetails: 2 });
    expect(orDetails(calls).map((c) => /Id=%22(\d+)%22/u.exec(c)?.[1])).toEqual(['210700000', '210700001']);
    expect(skips).toContain('detail-budget Acme Bank: 3 jobs without detail (2 over the budget, 1 not India-named)');
    expect(skips).toContain('detail-gone Acme Bank: 1 job gone between list and detail (210700001)');
    expect(out.map((p) => p.sourceId)).not.toContain('210700001');
    expect(out).toHaveLength(5);
    expect(ORACLE_MAX_DETAILS).toBe(40);
  });

  it('a detail without its description is invalid_output', async () => {
    const reqs = orReqs(1);
    const t = site({ reqs, locations: indiaFacet(1), scopes: { [`locationId=${INDIA_ID}`]: { reqs } }, details: { '210700000': { items: [{ Id: '210700000', Title: 'x' }] } } });
    await expect(runOr([t])).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/detail: response shape is not valid \(items\.0\.ExternalDescriptionStr:/) });
  });

  it('the worst case (robots.txt, 10 list pages, 40 details) at the 5 s spacing ends within the step timeout', () => {
    expect((1 + ORACLE_MAX_PAGES + ORACLE_MAX_DETAILS) * ORACLE_MIN_INTERVAL_MS).toBeLessThan(ORACLE_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// Mapping into Posting, and the existing eligibility
// ---------------------------------------------------------------------------

const ELIG: EligibilityPack = {
  filters: { roleDeny: [], companyDeny: [], employmentDeny: [] },
  eligibility: { employmentTypes: ['full-time'], officeCities: ['bengaluru'] },
  watchlist: [],
  offers: { floor: null },
  fx: { toINR: { INR: 1, USD: 85, EUR: 92, GBP: 108 } },
};
const valid = (p: ReturnType<typeof normalize>) => {
  expect(Posting.schema.safeParse(p).success).toBe(true);
  return p;
};

describe('Eightfold and Oracle postings: mapping and the existing eligibility', () => {
  it('Microsoft (PCSX): the recorded detail maps to a Bengaluru posting; eligible as a Bengaluru office/hybrid job', async () => {
    const fx = fixture<{ board: string; careersPage: string; robots: string; discovery: unknown; scoped: { india: unknown[] }; details: Record<string, unknown> }>('eightfold-microsoft');
    const b = parseEightfoldRef(fx.board)!;
    const page = parseEightfoldPage('pcsx', fx.scoped.india[0], 'ms');
    const id = Object.keys(fx.details)[0] as string;
    const pos = page.positions.find((p) => p.id === id)!;
    const raw: EightfoldRaw = { api: 'pcsx', title: pos.title, url: eightfoldJobUrl(b, id), id, locations: pos.locations, standardizedLocations: pos.standardizedLocations, workLocationOption: pos.workLocationOption, department: pos.department, postedTs: pos.postedTs, detail: null };
    const { parseDetail } = await import('../../src/app/agents/sources/platforms/eightfold.js');
    const p = valid(normalize({ source: 'eightfold', sourceId: id, company: 'Microsoft', slug: fx.board, raw: { ...raw, detail: parseDetail('pcsx', fx.details[id], 'ms') } }));
    expect(p).toMatchObject({ ats: 'eightfold', title: 'Principal Software Engineering Manager', url: 'https://apply.careers.microsoft.com/careers/job/1970393556994911', locationText: 'India, Karnataka, Bangalore', employmentType: 'Full-Time', postedAt: new Date(1789642649 * 1000).toISOString() });
    expect(p.remote.countries).toContain('india');
    expect(p.remote.structured).toBe('hybrid');
    expect(p.descriptionText.length).toBeGreaterThan(200);
    const v = decideEligibility(p, ELIG);
    expect(v.verdict).toBe('eligible');
    expect(v.notes.join(' ')).toMatch(/office\/hybrid: Bengaluru/);
  });

  it('Netflix (v2): a Mumbai job is onsite outside the office cities (rejected); a remote-India job passes; an absent date is null', () => {
    const fx = fixture<{ board: string; scoped: { india: unknown } }>('eightfold-netflix');
    const b = parseEightfoldRef(fx.board)!;
    const page = parseEightfoldPage('v2', fx.scoped.india, 'nf');
    const pos = page.positions[0]!;
    const base: EightfoldRaw = { api: 'v2', title: pos.title, url: eightfoldJobUrl(b, pos.id), id: pos.id, locations: pos.locations, standardizedLocations: [], workLocationOption: pos.workLocationOption, department: pos.department, postedTs: pos.postedTs, detail: null };
    const mumbai = valid(normalize({ source: 'eightfold', sourceId: pos.id, company: 'Netflix', slug: fx.board, raw: base }));
    expect(mumbai.locationText).toBe('Mumbai,India');
    expect(mumbai.postedAt).toBe(new Date((pos.postedTs as number) * 1000).toISOString());
    expect(decideEligibility(mumbai, ELIG).verdict).toBe('rejected');
    const remote = valid(normalize({ source: 'eightfold', sourceId: '1', company: 'Netflix', slug: fx.board, raw: { ...base, locations: ['Remote, India'], workLocationOption: 'remote', postedTs: null } }));
    expect(remote.postedAt).toBeNull();
    expect(remote.remote.structured).toBe('remote');
    expect(decideEligibility(remote, ELIG).verdict).toBe('eligible');
  });

  it('JPMorgan (Oracle): the recorded India list and detail map to Postings; Bengaluru eligible, Mumbai onsite rejected; the date is the posted day', async () => {
    const fx = fixture<{ site: string; scoped: { india: unknown }; details: Record<string, unknown> }>('oracle-jpmorgan');
    const { pagePostings, parseDetail } = await import('../../src/app/agents/sources/platforms/oracle.js');
    const b = parseOracleRef(fx.site)!;
    const postings: RawPosting[] = pagePostings(b, parseOraclePage(fx.scoped.india, 'jpm'), { company: 'JPMorgan Chase', slug: fx.site });
    expect(postings.length).toBeGreaterThanOrEqual(10);
    for (const r of postings) expect((r.raw as OracleRaw).primaryCountry).toBe('IN');
    const id = Object.keys(fx.details)[0] as string;
    const one = postings.find((r) => r.sourceId === id);
    const raw = one === undefined ? null : { ...(one.raw as OracleRaw), detail: parseDetail(fx.details[id], 'jpm') };
    const blr = valid(normalize({ ...(one ?? postings[0]!), raw: raw ?? postings[0]!.raw }));
    expect(blr.ats).toBe('oracle');
    const mapped = postings.map((r) => valid(normalize(r)));
    const bengaluru = mapped.filter((p) => /Bengaluru/u.test(p.locationText));
    const mumbai = mapped.filter((p) => /^Mumbai/u.test(p.locationText) && !/Bengaluru/u.test(p.locationText));
    expect(bengaluru.length).toBeGreaterThan(0);
    expect(mumbai.length).toBeGreaterThan(0);
    for (const p of bengaluru) expect(decideEligibility(p, ELIG).verdict, p.title).toBe('eligible');
    for (const p of mumbai) expect(decideEligibility(p, ELIG).verdict, p.title).toBe('rejected');
    for (const p of mapped) expect(p.postedAt).toMatch(/^2026-\d\d-\d\d$/u);
    expect(mapped[0]?.url).toBe(oracleJobUrl(b, mapped[0]!.sourceId));
    if (raw !== null) {
      expect(blr.employmentType).toBe('Full time');
      expect(blr.descriptionText.length).toBeGreaterThan(100);
    }
    // a missing date is null
    const noDate = valid(normalize({ ...postings[0]!, raw: { ...(postings[0]!.raw as OracleRaw), postedDate: null } }));
    expect(noDate.postedAt).toBeNull();
  });
});
