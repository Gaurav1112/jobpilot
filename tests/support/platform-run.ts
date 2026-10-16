import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSrcEightfold, srcEightfoldContract } from '../../src/app/agents/sources/platforms/eightfold.js';
import { makeSrcOracle, srcOracleContract } from '../../src/app/agents/sources/platforms/oracle.js';
import { REMOTE_TYPE } from '../../src/app/agents/sources/platforms/shared.js';
import { makeSrcSuccessFactors, SF_EGRESS, srcSuccessFactorsContract } from '../../src/app/agents/sources/platforms/successfactors.js';
import { makeSrcWorkday, srcWorkdayContract } from '../../src/app/agents/sources/platforms/workday.js';
import { dailyEightfoldHosts, dailyOracleHosts, dailyPlatformHosts, dailyWorkdayHosts } from '../../src/app/daily-hosts.js';
import type { DiscoveryRequest, RawPosting } from '../../src/app/types.js';
import { createHostPacer, issueContext } from '../../src/kernel/broker.js';
import type { AnyContract } from '../../src/kernel/contract.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import type { FetchLike, FetchResponse } from '../../src/kernel/providers.js';

/**
 * Profiles Task 14: the registry platform adapters run on a recorded board fixture (`tests/fixtures/sources/…`, or a
 * derived one under `residence/`), offline. Each fake replays the fixture by the platform's own request shapes: the
 * discovery page, the residence-scoped list (the fixture's `scoped.india`, whatever country it names), the remote
 * list, an office list (the scoped list's jobs at that office), the recorded details. Pages past the recorded ones
 * are empty (a short list, never a network call). Every request is recorded as `{ url, body? }`.
 */

const root = join(import.meta.dirname, '../..');
export const sourceFixture = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(join(root, 'tests/fixtures/sources', name), 'utf8')) as T;

export const PLATFORM_PACK = {
  filters: { roleDeny: ['\\bqa\\b', '\\bintern(ship)?\\b', 'designer', 'hardware engineer', '^manager\\b'] },
  targets: { titles: ['software engineer', 'senior engineer', 'staff engineer', 'lead engineer', 'engineering manager', 'devops engineer', 'solution analyst'] },
};

export interface Eligibility {
  readonly residence?: string;
  readonly officeCities?: readonly string[];
}

export interface PlatformRun {
  readonly postings: RawPosting[];
  readonly requests: { url: string; body?: string }[];
  readonly skipped: string[];
}

const json = (status: number, o: unknown): FetchResponse => ({ status, text: async () => (typeof o === 'string' ? o : JSON.stringify(o)) });
const NF = json(404, 'not found');

function context(contract: AnyContract, egress: string, fetch: FetchLike, host: string, eligibility: Eligibility) {
  let now = Date.parse('2026-10-14T01:30:00Z');
  const clock = { now: () => new Date(now).toISOString() };
  const hostPacer = createHostPacer(PRODUCT_POLICY_V1.minHostIntervalMs, clock, async (ms) => {
    now += ms;
  });
  const pack = { ...PLATFORM_PACK, eligibility };
  return issueContext({ contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock, signal: new AbortController().signal, egressSets: { [egress]: [host] }, pack, hostPacer });
}

function recorder(serve: (url: URL, body: string | undefined, method: string) => FetchResponse) {
  const requests: { url: string; body?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, ...(init.body !== undefined ? { body: init.body } : {}) });
    return serve(new URL(url), init.body, init.method ?? 'GET');
  };
  return { fetch, requests };
}

// ---------------------------------------------------------------------------
// Workday
// ---------------------------------------------------------------------------

type WdPage = { total: number; jobPostings: { locationsText?: string }[]; facets?: unknown[] };
export interface WorkdayFixture {
  readonly board: string;
  readonly robots: string;
  readonly discovery: WdPage;
  readonly scoped: { readonly india: WdPage; readonly remote?: WdPage };
  readonly details: Record<string, unknown>;
}
type WdFacet = { facetParameter?: string; descriptor?: string; id?: string; count?: number; values?: WdFacet[] };

/** The fixture with every remote-type facet value taken out (a board whose facets offer no remote list). */
export function withoutRemote<T extends { discovery: { facets?: unknown[] } }>(fx: T): T {
  const strip = (nodes: readonly WdFacet[]): WdFacet[] => nodes.filter((n) => n.values !== undefined || !REMOTE_TYPE.test(n.descriptor ?? '')).map((n) => (n.values === undefined ? n : { ...n, values: strip(n.values) }));
  return { ...fx, discovery: { ...fx.discovery, facets: strip((fx.discovery.facets ?? []) as WdFacet[]) } };
}

export async function runWorkday(fixture: string | WorkdayFixture, eligibility: Eligibility): Promise<PlatformRun> {
  const fx = typeof fixture === 'string' ? sourceFixture<WorkdayFixture>(fixture) : fixture;
  const [host, tenant, site] = fx.board.split('/') as [string, string, string];
  const values = new Map<string, WdFacet>();
  const walk = (nodes: readonly WdFacet[]): void => {
    for (const n of nodes) {
      if (n.values !== undefined) walk(n.values);
      else if (n.id !== undefined) values.set(n.id, n);
    }
  };
  walk((fx.discovery.facets ?? []) as WdFacet[]);
  const base = `/wday/cxs/${tenant}/${site}`;
  const net = recorder((u, body, method) => {
    if (u.hostname !== host) return NF;
    if (u.pathname === '/robots.txt') return json(200, fx.robots);
    if (method === 'POST' && u.pathname === `${base}/jobs`) {
      const q = JSON.parse(body ?? '{}') as { offset: number; appliedFacets: Record<string, string[]> };
      const ids = Object.values(q.appliedFacets).flat();
      if (q.offset > 0) return json(200, { total: 0, jobPostings: [] });
      if (ids.length === 0) return json(200, fx.discovery);
      const vs = ids.map((id) => values.get(id));
      if (vs.some((v) => v === undefined)) return json(400, '');
      if (vs.every((v) => REMOTE_TYPE.test(v?.descriptor ?? ''))) return json(200, fx.scoped.remote ?? { total: 0, jobPostings: [] });
      // one city value: an office list, the scoped list's jobs at that value, under the value's count
      const one = vs.length === 1 ? vs[0] : undefined;
      if (one !== undefined && (one.descriptor ?? '').includes(',')) return json(200, { total: one.count ?? 0, jobPostings: fx.scoped.india.jobPostings.filter((j) => j.locationsText === one.descriptor) });
      return json(200, fx.scoped.india);
    }
    if (method === 'GET' && u.pathname.startsWith(`${base}/job/`)) {
      const d = fx.details[u.pathname.slice(base.length)];
      return d === undefined ? NF : json(200, d);
    }
    return NF;
  });
  const ctx = context(srcWorkdayContract, 'registry:workday-hosts', net.fetch, host, eligibility);
  const req: DiscoveryRequest = { ats: 'workday', slug: fx.board, company: 'Acme', runDate: '2026-10-14' };
  const postings = (await makeSrcWorkday({ hosts: dailyWorkdayHosts() }).run(req, ctx)) as RawPosting[];
  return { postings, requests: net.requests, skipped: [...ctx.skips()] };
}

// ---------------------------------------------------------------------------
// Eightfold (PCSX and v2 pages as recorded)
// ---------------------------------------------------------------------------

interface EfFixture {
  readonly board: string;
  readonly robots: string;
  readonly careersPage: string;
  readonly discovery: unknown;
  readonly scoped: { readonly india: unknown };
  readonly details: Record<string, unknown>;
}

export async function runEightfold(fixture: string, eligibility: Eligibility, residenceQuery: string): Promise<PlatformRun> {
  const fx = sourceFixture<EfFixture>(fixture);
  const [host, domain] = fx.board.split('/') as [string, string];
  const scopedPages = Array.isArray(fx.scoped.india) ? (fx.scoped.india as unknown[]) : [fx.scoped.india];
  const empty = (count: number) => ({ status: 200, error: { message: '', body: '' }, data: { count, positions: [] } });
  const net = recorder((u) => {
    if (u.hostname !== host) return NF;
    if (u.pathname === '/robots.txt') return json(200, fx.robots);
    if (u.pathname === '/careers') return json(200, fx.careersPage);
    if (u.pathname === '/api/pcsx/search') {
      if (u.searchParams.get('domain') !== domain) return NF;
      const start = Number(u.searchParams.get('start'));
      const location = u.searchParams.get('location') ?? '';
      if (location === '') return start === 0 ? json(200, fx.discovery) : json(200, empty(0));
      if (location !== residenceQuery) return json(200, empty(0));
      return json(200, scopedPages[start / 10] ?? empty(0));
    }
    if (u.pathname === '/api/pcsx/position_details') {
      const d = fx.details[u.searchParams.get('position_id') ?? ''];
      return d === undefined ? NF : json(200, d);
    }
    return NF;
  });
  const ctx = context(srcEightfoldContract, 'registry:eightfold-hosts', net.fetch, host, eligibility);
  const req: DiscoveryRequest = { ats: 'eightfold', slug: fx.board, company: 'Acme', runDate: '2026-10-14' };
  const postings = (await makeSrcEightfold({ hosts: dailyEightfoldHosts() }).run(req, ctx)) as RawPosting[];
  return { postings, requests: net.requests, skipped: [...ctx.skips()] };
}

// ---------------------------------------------------------------------------
// Oracle Recruiting Cloud
// ---------------------------------------------------------------------------

type OrPage = { items: [{ TotalJobsCount: number; locationsFacet: { Id: number | string; Name: string }[] } & Record<string, unknown>] };
interface OrFixture {
  readonly site: string;
  readonly robots: { readonly status: number; readonly body: string };
  readonly discovery: OrPage;
  readonly scoped: { readonly india: OrPage };
  readonly details: Record<string, unknown>;
}

/** The location value the JPMorgan scoped list was recorded under (the country level: "India", "Germany" in the derived fixture). */
const ORACLE_RECORDED_LOCATION_ID = '300000000289360';

export async function runOracle(fixture: string, eligibility: Eligibility): Promise<PlatformRun> {
  const fx = sourceFixture<OrFixture>(fixture);
  const [host, site] = fx.site.split('/') as [string, string];
  const finder = (u: URL): Record<string, string> => {
    const f = u.searchParams.get('finder') ?? '';
    return Object.fromEntries(f.slice(f.indexOf(';') + 1).split(',').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  };
  const emptyPage = (offset: number) => ({ items: [{ ...fx.discovery.items[0], TotalJobsCount: 0, Offset: offset, requisitionList: [] }], count: 1, hasMore: false });
  const net = recorder((u) => {
    if (u.hostname !== host) return NF;
    if (u.pathname === '/robots.txt') return json(fx.robots.status, fx.robots.body);
    if (u.pathname === '/hcmRestApi/resources/latest/recruitingCEJobRequisitions') {
      const f = finder(u);
      if (f['siteNumber'] !== site) return NF;
      const offset = Number(f['offset']);
      if (offset > 0) return json(200, emptyPage(offset));
      if (f['locationId'] === undefined && f['selectedWorkplaceTypesFacet'] === undefined) return json(200, fx.discovery);
      // the scoped list is the recorded one for the location value it was recorded under, whatever its name
      return f['locationId'] === ORACLE_RECORDED_LOCATION_ID ? json(200, fx.scoped.india) : json(200, emptyPage(0));
    }
    if (u.pathname === '/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails') {
      const id = /Id="([^"]+)"/u.exec(u.searchParams.get('finder') ?? '')?.[1] ?? '';
      const d = fx.details[id];
      return d === undefined ? json(200, { items: [], count: 0 }) : json(200, d);
    }
    return NF;
  });
  const ctx = context(srcOracleContract, 'registry:oracle-hosts', net.fetch, host, eligibility);
  const req: DiscoveryRequest = { ats: 'oracle', slug: fx.site, company: 'Acme', runDate: '2026-10-14' };
  const postings = (await makeSrcOracle({ hosts: dailyOracleHosts() }).run(req, ctx)) as RawPosting[];
  return { postings, requests: net.requests, skipped: [...ctx.skips()] };
}

// ---------------------------------------------------------------------------
// SuccessFactors (the sitemal feed, streamed)
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const stream = (status: number, text: string): FetchResponse => {
  const bytes = enc.encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 1024) c.enqueue(bytes.slice(i, i + 1024));
      c.close();
    },
  });
  return { status, body, text: async () => text, headers: { get: () => null } };
};

/** SuccessFactors on `host`, from its robots.txt and sitemal.xml texts (pages are never served: items with a location). */
export async function runSuccessFactors(host: string, robots: string, sitemal: string, eligibility: Eligibility): Promise<PlatformRun> {
  const net = recorder((u) => {
    if (u.hostname !== host) return NF;
    if (u.pathname === '/robots.txt') return stream(200, robots);
    if (u.pathname === '/sitemal.xml') return stream(200, sitemal);
    return NF;
  });
  const base = context(srcSuccessFactorsContract, SF_EGRESS, net.fetch, host, eligibility);
  const req: DiscoveryRequest = { ats: 'successfactors', slug: host, company: 'Acme', runDate: '2026-10-14' };
  const postings = (await makeSrcSuccessFactors({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }).run(req, base)) as RawPosting[];
  return { postings, requests: net.requests, skipped: [...base.skips()] };
}
