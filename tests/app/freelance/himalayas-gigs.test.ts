import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideGig } from '../../../src/app/freelance/gig-eligibility.js';
import { normalizeGig } from '../../../src/app/freelance/gig-normalizer.js';
import { freelanceAgents, freelancePipeline, freelanceSeeds } from '../../../src/app/freelance/pipeline.js';
import { rateOf } from '../../../src/app/freelance/rate.js';
import {
  HIMALAYAS_GIGS_MIN_INTERVAL_MS,
  HIMALAYAS_ROBOTS_URL,
  himalayasGigsHosts,
  himalayasGigsUrl,
  makeSrcHimalayasGigs,
  srcHimalayasGigsContract,
} from '../../../src/app/freelance/sources/himalayas-gigs.js';
import type { GigRequest, RawGig } from '../../../src/app/freelance/types.js';
import { offlineProviders } from '../../../src/app/offline.js';
import { FreelanceFile } from '../../../src/app/pack/freelance-schema.js';
import { loadPack } from '../../../src/app/pack/load.js';
import { AppStore, type GigUpsert } from '../../../src/app/store/app-store.js';
import { gigDedupeKey, gigKey } from '../../../src/app/freelance/keys.js';
import { Store } from '../../../src/kernel/store/store.js';
import { issueContext, type HostPacer } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { KernelError } from '../../../src/kernel/errors.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import type { FetchLike } from '../../../src/kernel/providers.js';

const root = join(import.meta.dirname, '../../..');
const FIX = join(root, 'tests/fixtures/freelance/himalayas');
const { pack } = loadPack(join(root, 'tests/fixtures/pack'));
const gigPack = { filters: pack.filters, naming: pack.naming, platformRules: pack.platformRules, freelance: pack.freelance };

const req = (query: string): GigRequest => ({ platform: 'himalayas', query, runDate: '2026-10-14', half: 'pm' });

function ctxFor(fetch: FetchLike, waits: number[] = []) {
  const hostPacer: HostPacer = { wait: async (_h, ms) => void waits.push(ms ?? 0) };
  return issueContext({ contract: srcHimalayasGigsContract(), policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock: fixedClock('2026-10-14T15:00:00Z'), signal: new AbortController().signal, hostPacer });
}

/** Serves the recorded fixtures and logs every URL asked. */
function recorded(): FetchLike & { calls: string[] } {
  const inner = offlineProviders(FIX).fetch;
  const calls: string[] = [];
  return Object.assign(async (url: string, init?: unknown) => {
    calls.push(url);
    return inner(url, init as never);
  }, { calls });
}

/** A fake host: robots.txt as given, every search answering `status` with `body`. */
function host(o: { robots?: { status: number; body: string }; status?: number; body?: string }): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign(async (url: string) => {
    calls.push(url);
    if (url === HIMALAYAS_ROBOTS_URL) return { status: o.robots?.status ?? 404, text: async () => o.robots?.body ?? '' };
    return { status: o.status ?? 200, text: async () => o.body ?? JSON.stringify({ offset: 0, limit: 20, totalCount: 0, jobs: [] }) };
  }, { calls });
}

describe('src-himalayas-gigs: the contract', () => {
  it('io, its own team, one host, no LLM, never retries a 429', () => {
    const c = srcHimalayasGigsContract();
    expect(c).toMatchObject({ id: 'src-himalayas-gigs', kind: 'io', team: 'sourcing-himalayas', egress: ['himalayas.app'], capabilities: { http: true } });
    expect(c.capabilities.llm).toBeFalsy();
    expect(c.retry.on).not.toContain('rate_limit');
  });

  it('asks contract and part-time work open to India, one skill, newest first, and never a page parameter', () => {
    const u = new URL(himalayasGigsUrl('spring boot'));
    expect(u.host).toBe('himalayas.app');
    expect(u.pathname).toBe('/jobs/api/search');
    expect(Object.fromEntries(u.searchParams)).toEqual({ q: 'spring boot', employment_type: 'Contractor,Part Time', country: 'India', sort: 'recent' });
    expect(u.search).not.toMatch(/page=|offset=|cursor=/);
  });
});

describe('src-himalayas-gigs: the recorded responses (scrubbed)', () => {
  it('robots.txt once per run (its 404 body is honoured), then one request per skill, paced at 2 s or more', async () => {
    const fetch = recorded();
    const waits: number[] = [];
    const agent = makeSrcHimalayasGigs(himalayasGigsHosts());
    const a = await agent.run(req('backend'), ctxFor(fetch, waits));
    const b = await agent.run(req('llm'), ctxFor(fetch, waits));
    expect(fetch.calls).toEqual([HIMALAYAS_ROBOTS_URL, himalayasGigsUrl('backend'), himalayasGigsUrl('llm')]);
    expect(waits.every((w) => w >= HIMALAYAS_GIGS_MIN_INTERVAL_MS)).toBe(true);
    expect(a.length).toBeGreaterThan(5);
    expect(b.length).toBeGreaterThan(5);
  });

  it('keeps only India-eligible jobs, links back to the Himalayas page, and keeps only the named fields', async () => {
    const fetch = recorded();
    const ctx = ctxFor(fetch);
    const gigs = await makeSrcHimalayasGigs().run(req('llm'), ctx);
    const all = (JSON.parse(readFileSync(join(FIX, 'llm.json'), 'utf8')) as { jobs: { guid: string; locationRestrictions: string[] }[] }).jobs;
    const excluded = all.filter((j) => j.locationRestrictions.length > 0 && !j.locationRestrictions.some((r) => /^(india|asia|apac|worldwide|anywhere)$/i.test(r)));
    expect(gigs.length).toBe(all.length - excluded.length);
    for (const g of gigs) {
      expect(g.platform).toBe('himalayas');
      expect(g.sourceId).toMatch(/^https:\/\/himalayas\.app\/companies\/.+\/jobs\/.+/);
      expect(Object.keys(g.raw as object).sort()).toEqual(['companyName', 'currency', 'description', 'employmentType', 'guid', 'locationRestrictions', 'maxSalary', 'minSalary', 'pubDate', 'salaryPeriod', 'timezoneRestrictions', 'title']);
    }
    expect([...gigs.map((g) => g.sourceId)]).toEqual([...gigs.map((g) => g.sourceId)].sort());
  });

  it('the paging cap is loud: page 1 only, and the rest is a named note with the count', async () => {
    const ctx = ctxFor(recorded());
    await makeSrcHimalayasGigs().run(req('backend'), ctx);
    expect(ctx.skips()).toContain('himalayas backend: 119 more not read (page 1 only: robots.txt disallows paging under /jobs)');
  });

  it('every recorded gig normalizes; structured hourly pay maps directly, labelled as the pay field', async () => {
    const gigs = [...(await makeSrcHimalayasGigs().run(req('backend'), ctxFor(recorded()))), ...(await makeSrcHimalayasGigs().run(req('llm'), ctxFor(recorded())))];
    const normalized = gigs.map(normalizeGig);
    const hourly = normalized.filter((g) => g.budget.from === 'platform');
    expect(hourly.length).toBeGreaterThan(0);
    for (const g of hourly) expect(rateOf(g, pack.fx, 20).method).toBe('stated');
    for (const g of normalized) expect(g.url).toBe(g.sourceId);
  });

  it('the recorded "$500/task" job filed by the platform as hourly 500 is no rate, never $500/h', async () => {
    const gigs = (await makeSrcHimalayasGigs().run(req('llm'), ctxFor(recorded()))).map(normalizeGig);
    const task = gigs.find((g) => /\/task/i.test(g.title));
    expect(task).toBeDefined();
    expect(task?.budget.type).toBe('unknown');
    expect(decideGig({ gig: task!, rate: rateOf(task!, pack.fx, 20) }, gigPack).verdict).not.toBe('eligible');
  });
});

describe('src-himalayas-gigs: politeness and refusals', () => {
  const ROBOTS_DENY = { status: 200, body: 'User-Agent: *\nDisallow: /jobs/api\n' };

  it('a robots.txt rule against the search is a named skip, and no search request is sent', async () => {
    const fetch = host({ robots: ROBOTS_DENY });
    const ctx = ctxFor(fetch);
    expect(await makeSrcHimalayasGigs().run(req('java'), ctx)).toEqual([]);
    expect(fetch.calls).toEqual([HIMALAYAS_ROBOTS_URL]);
    expect(ctx.skips()[0]).toMatch(/^robots-disallow himalayas\.app: himalayas java not read today/);
  });

  it('a robots.txt served with 404 but carrying rules is still honoured (stricter than RFC 9309)', async () => {
    const fetch = host({ robots: { status: 404, body: ROBOTS_DENY.body } });
    expect(await makeSrcHimalayasGigs().run(req('java'), ctxFor(fetch))).toEqual([]);
    expect(fetch.calls).toEqual([HIMALAYAS_ROBOTS_URL]);
  });

  it('a job restricted to places without India is left out', async () => {
    const job = (guid: string, locationRestrictions: string[]) => ({ guid, title: 'Backend Engineer', employmentType: 'Contractor', locationRestrictions, description: 'x' });
    const body = JSON.stringify({ offset: 0, limit: 20, totalCount: 3, jobs: [job('https://himalayas.app/a', ['United States']), job('https://himalayas.app/b', ['India']), job('https://himalayas.app/c', [])] });
    const gigs = await makeSrcHimalayasGigs().run(req('java'), ctxFor(host({ body })));
    expect(gigs.map((g) => g.sourceId)).toEqual(['https://himalayas.app/b', 'https://himalayas.app/c']);
  });

  it.each([
    [403, 'challenged'],
    [401, 'challenged'],
    [429, 'rate_limit'],
  ])('a %i disables the host for the run (%s); the next skill is deferred without a request', async (status, code) => {
    const fetch = host({ status, body: 'nope' });
    const agent = makeSrcHimalayasGigs(himalayasGigsHosts());
    await expect(agent.run(req('java'), ctxFor(fetch))).rejects.toMatchObject({ code });
    const before = fetch.calls.length;
    await expect(agent.run(req('kafka'), ctxFor(fetch))).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^host-disabled:http-\d+ on himalayas\.app/) });
    expect(fetch.calls.length).toBe(before);
  });

  it('a challenge page disables the host (challenged)', async () => {
    const fetch = host({ status: 503, body: '<html><title>Just a moment...</title></html>' });
    const agent = makeSrcHimalayasGigs(himalayasGigsHosts());
    await expect(agent.run(req('java'), ctxFor(fetch))).rejects.toMatchObject({ code: 'challenged' });
    await expect(agent.run(req('go'), ctxFor(fetch))).rejects.toMatchObject({ code: 'input_rejected' });
  });

  it('a 429 on robots.txt disables the host too', async () => {
    const fetch = host({ robots: { status: 429, body: '' } });
    await expect(makeSrcHimalayasGigs().run(req('java'), ctxFor(fetch))).rejects.toBeInstanceOf(KernelError);
    expect(fetch.calls).toEqual([HIMALAYAS_ROBOTS_URL]);
  });

  it('a body without a jobs array is invalid_output; an empty result is []', async () => {
    await expect(makeSrcHimalayasGigs().run(req('java'), ctxFor(host({ body: '{"x":1}' })))).rejects.toMatchObject({ code: 'invalid_output' });
    expect(await makeSrcHimalayasGigs().run(req('java'), ctxFor(host({})))).toEqual([]);
  });

  it('answers only himalayas requests', async () => {
    const fetch = host({});
    expect(await makeSrcHimalayasGigs().run({ ...req('java'), platform: 'freelancer' }, ctxFor(fetch))).toEqual([]);
    expect(fetch.calls).toEqual([]);
  });
});

describe('himalayas in the wiring and the pack defaults', () => {
  it('one seed per keyword; the default keywords are the backend/AI list without react or python', () => {
    const rules = FreelanceFile.parse({});
    const seeds = freelanceSeeds(rules, '2026-10-14', 'pm', []).filter((s) => s.platform === 'himalayas').map((s) => s.query);
    expect(seeds).toEqual(rules.platforms.himalayas.queries);
    expect(seeds).toEqual(expect.arrayContaining(['backend', 'java', 'spring boot', 'kafka', 'golang', 'microservices', 'aws', 'llm', 'ai agent', 'rag']));
    expect(seeds).not.toContain('react');
    expect(seeds).not.toContain('python');
    expect(rules.platforms.himalayas.enabled).toBe(true);
    expect(FreelanceFile.parse({ platforms: { himalayas: { enabled: false } } }).platforms.himalayas.enabled).toBe(false);
  });

  it('a team of its own in the freelance wiring; each wiring gets fresh host state', () => {
    const a = freelanceAgents();
    const p = freelancePipeline(a);
    expect(p.teams.find((t) => t.id === 'sourcing-himalayas')?.members).toEqual(['src-himalayas-gigs']);
    expect(p.edges).toContainEqual({ type: 'GigRequest@1', to: 'src-himalayas-gigs' });
    expect(a.find((x) => x.contract.id === 'src-himalayas-gigs')).not.toBe(freelanceAgents().find((x) => x.contract.id === 'src-himalayas-gigs'));
  });
});

describe('the himalayas normalizer mapping', () => {
  const raw = (o: Record<string, unknown>): RawGig => ({
    platform: 'himalayas',
    sourceId: 'https://himalayas.app/companies/example-co/jobs/backend-engineer',
    raw: {
      title: 'Backend Engineer', companyName: 'Example Co', employmentType: 'Contractor', minSalary: 50, maxSalary: 100, salaryPeriod: 'hourly', currency: 'USD',
      locationRestrictions: [], timezoneRestrictions: [], description: '<p>Build APIs in Go. 10-20 hours per week.</p>', pubDate: 1791972122,
      guid: 'https://himalayas.app/companies/example-co/jobs/backend-engineer', ...o,
    },
  });

  it('structured hourly pay, worldwide, the Himalayas link, pubDate in seconds', () => {
    const g = normalizeGig(raw({}));
    expect(g).toMatchObject({
      platform: 'himalayas', kind: 'contract', url: 'https://himalayas.app/companies/example-co/jobs/backend-engineer', client: { name: 'Example Co' },
      budget: { type: 'hourly', min: 50, max: 100, currency: 'USD', usdPerUnit: null, from: 'platform' }, hoursPerWeek: { min: 10, max: 20, source: 'text' },
      location: { countries: [], worldwide: true, text: null }, postedAt: '2026-10-14T10:02:02.000Z',
    });
    expect(decideGig({ gig: g, rate: rateOf(g, pack.fx, 20) }, gigPack)).toEqual({ verdict: 'eligible', reasons: [], notes: [] });
  });

  it('an annual salary is no freelance budget: the text is read instead (labelled), else unknown', () => {
    expect(normalizeGig(raw({ salaryPeriod: 'annual', minSalary: 800000, maxSalary: 2500000, currency: 'INR' })).budget).toEqual({ type: 'unknown', min: null, max: null, currency: null, usdPerUnit: null });
    expect(normalizeGig(raw({ salaryPeriod: 'annual', minSalary: null, maxSalary: null, description: 'Rate: $90/hr.' })).budget).toEqual({ type: 'hourly', min: 90, max: 90, currency: 'USD', usdPerUnit: null, from: 'description' });
  });

  it('a structured figure the text states per task or project is not hourly pay', () => {
    expect(normalizeGig(raw({ title: 'AI Project Builder | Up to $500/task', minSalary: 500, maxSalary: 500 })).budget.type).toBe('unknown');
    expect(normalizeGig(raw({ description: 'We pay $100 per project milestone.', minSalary: 100, maxSalary: 100 })).budget.type).toBe('unknown');
  });

  it('a location list names countries; time zones that leave out IST make it not worldwide and go to review', () => {
    expect(normalizeGig(raw({ locationRestrictions: ['India', 'United Kingdom'] })).location).toEqual({ countries: ['india', 'united kingdom'], worldwide: false, text: 'India, United Kingdom' });
    const us = normalizeGig(raw({ timezoneRestrictions: [-8, -7, -6, -5] }));
    expect(us.location).toEqual({ countries: [], worldwide: false, text: 'time zones UTC−8 to UTC−5 only' });
    expect(decideGig({ gig: us, rate: rateOf(us, pack.fx, 20) }, gigPack)).toMatchObject({ verdict: 'review', reasons: ['location-unclear'] });
    expect(normalizeGig(raw({ timezoneRestrictions: [0, 5.5, 8] })).location.worldwide).toBe(true);
  });

  it('a full-time employment type is refused by name', () => {
    expect(() => normalizeGig(raw({ employmentType: 'Full Time' }))).toThrow(/unsupported employmentType "Full Time"/);
  });
});

describe('dedupe against the boards re-read of the daily Himalayas source', () => {
  it('the Himalayas gig (structured pay) is the group row even when the boards copy was seen first', () => {
    const app = AppStore.on(Store.open(':memory:'));
    const row = (platform: string, id: string, at: string): GigUpsert => ({
      gigKey: gigKey(platform, id), dedupeKey: gigDedupeKey('Example Co', 'Backend Engineer'), platform, sourceId: id, url: `https://x.test/${id}`, title: 'Backend Engineer',
      description: '', client: {}, kind: 'contract', budget: {}, rate: null, hours: {}, verdict: 'review', reasons: [], notes: [], flags: [], fit: 50, breakdown: null,
      list: 'review', docsState: 'none', docsDetail: null, postedAt: null, at,
    });
    app.upsertGig(row('boards', 'b1', '2026-10-12T01:00:00.000Z'));
    app.upsertGig(row('himalayas', 'h1', '2026-10-14T13:00:00.000Z'));
    const dupOf = Object.fromEntries(app.listGigs({ duplicates: true }).map((g) => [g.sourceId, g.duplicateOf]));
    expect(dupOf).toEqual({ b1: gigKey('himalayas', 'h1'), h1: null });
    expect(app.listGigs().map((g) => g.sourceId)).toEqual(['h1']);
  });
});
