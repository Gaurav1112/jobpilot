import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideEligibility, type EligibilityPack } from '../../src/app/agents/eligibility.js';
import { normalize } from '../../src/app/agents/normalizer.js';
import { platformClient } from '../../src/app/agents/sources/platforms/client.js';
import { fetchIcimsListing, icimsBoardOfUrl, icimsJobs, makeSrcIcims, parseIcimsRef, srcIcimsContract, ICIMS_EGRESS } from '../../src/app/agents/sources/platforms/icims.js';
import { jsonLdBoardOfUrl, jsonLdJobUrls, makeSrcJsonLd, parseJsonLdRef, srcJsonLdContract, JSONLD_EGRESS, JSONLD_LISTING_MAX_REQUESTS } from '../../src/app/agents/sources/platforms/jsonld-sitemap.js';
import { anchorHrefs, memoryPageState, PAGE_MAX_FETCHES } from '../../src/app/agents/sources/platforms/pages.js';
import type { PlatformHosts } from '../../src/app/agents/sources/platforms/shared.js';
import { makeSrcSmartRecruiters, parseSmartRecruitersRef, smartRecruitersBoardOfUrl, srcSmartRecruitersContract, srJobs, SR_EGRESS, SR_HOSTS } from '../../src/app/agents/sources/platforms/smartrecruiters.js';
import {
  makeSrcSuccessFactors,
  parseSitemal,
  parseSuccessFactorsRef,
  sitemalParser,
  srcSuccessFactorsContract,
  successFactorsBoardOfUrl,
  SF_EGRESS,
  SF_SITEMAL_MAX_BYTES,
} from '../../src/app/agents/sources/platforms/successfactors.js';
import { dailyPlatformHosts } from '../../src/app/daily-hosts.js';
import { Posting, type DiscoveryRequest, type RawPosting } from '../../src/app/types.js';
import type { Agent, AgentContext } from '../../src/kernel/agent.js';
import { createHostPacer, issueContext } from '../../src/kernel/broker.js';
import type { AnyContract } from '../../src/kernel/contract.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import type { FetchLike, FetchResponse } from '../../src/kernel/providers.js';

/**
 * Task 8: the daily adapters that read job PAGES (iCIMS, SuccessFactors, SmartRecruiters, the generic jsonld-sitemap)
 * and their verifier clients. The recorded fixtures (2026-10-14, one polite request each, trimmed and scrubbed) are the
 * real shapes: Atlassian's iCIMS sitemap and job page, HCLTech's sitemal.xml and job page, Bosch's SmartRecruiters job
 * page, Okta's sitemap and job page.
 */

const root = join(import.meta.dirname, '../..');
const fx = (name: string): string => readFileSync(join(root, 'tests/fixtures/pages', name), 'utf8');
const MB = 1024 * 1024;
const rep = (x: string): string => x.repeat(Math.ceil(MB / x.length)).slice(0, MB);
const time = (f: () => unknown): number => {
  const t = performance.now();
  f();
  return performance.now() - t;
};

const PACK = {
  filters: { roleDeny: ['\\bqa\\b', '\\bintern(ship)?\\b', 'designer', '^manager\\b'] },
  targets: { titles: ['software engineer', 'senior engineer', 'staff engineer', 'lead engineer', 'backend engineer', 'principal engineer', 'platform engineer'] },
  eligibility: { officeCities: ['bengaluru'] },
};
const ELIG: EligibilityPack = {
  filters: { roleDeny: [], companyDeny: [], employmentDeny: [] },
  eligibility: { employmentTypes: ['full-time'], officeCities: ['bengaluru'] },
  watchlist: [],
  offers: { floor: null },
  fx: { toINR: { INR: 1, USD: 85, EUR: 92, GBP: 108 } },
};

type Route = { status: number; body?: string; headers?: Record<string, string> };
const enc = new TextEncoder();
function respond(r: Route): FetchResponse {
  const bytes = enc.encode(r.body ?? '');
  // a streamed body in 1 KB chunks, so getStream sees several chunks
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 1024) c.enqueue(bytes.slice(i, i + 1024));
      c.close();
    },
  });
  return { status: r.status, body, text: async () => r.body ?? '', headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null } };
}

/** A step context like the supervisor's: the registry hosts as egress, the pack, a host pacer on a moving clock. */
function harness(contract: AnyContract, egress: string, hostsList: readonly string[], routes: Record<string, Route>, pack: unknown = PACK) {
  const calls: string[] = [];
  let now = Date.parse('2026-10-14T01:30:00Z');
  const clock = { now: () => new Date(now).toISOString() };
  const slept: number[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    return respond(routes[url] ?? { status: 404, body: 'not found' });
  };
  const hostPacer = createHostPacer(PRODUCT_POLICY_V1.minHostIntervalMs, clock, async (ms) => {
    slept.push(ms);
    now += ms;
  });
  const skipped: string[] = [];
  const base = issueContext({ contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock, signal: new AbortController().signal, egressSets: { [egress]: [...hostsList] }, pack, hostPacer });
  const ctx = { ...base, skipped: (n: readonly string[]) => void skipped.push(...n) } as AgentContext;
  return { ctx, calls, slept, skipped };
}
const req = (ats: DiscoveryRequest['ats'], slug: string, company: string, runDate = '2026-10-14'): DiscoveryRequest => ({ ats, slug, company, runDate });
const runAgent = (a: Agent<DiscoveryRequest, RawPosting>, r: DiscoveryRequest, ctx: AgentContext): Promise<RawPosting[]> => a.run(r, ctx) as Promise<RawPosting[]>;
const valid = (p: ReturnType<typeof normalize>) => {
  expect(Posting.schema.safeParse(p).success).toBe(true);
  return p;
};
const ld = (o: Record<string, unknown>) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', ...o })}</script></head><body>${'x'.repeat(40_000)}</body></html>`;
const BLR = { '@type': 'Place', address: { addressLocality: 'Bengaluru', addressRegion: 'Karnataka', addressCountry: 'IN' } };

// ---------------------------------------------------------------------------
// iCIMS
// ---------------------------------------------------------------------------

const ICIMS = 'careers-apac-atlassian.icims.com';
const IC = `https://${ICIMS}`;

describe('iCIMS: sitemap → job pages → JSON-LD', () => {
  it('reads the recorded sitemap: every /jobs/<id>/<slug>/job URL on the host, a title from the slug, the page read with in_iframe=1', () => {
    const jobs = icimsJobs(fx('icims-atlassian-sitemap.xml'), ICIMS);
    expect(jobs.length).toBe(65);
    expect(jobs[0]).toEqual({ url: `${IC}/jobs/25565/senior-backend-software-engineer/job`, title: 'senior backend software engineer', sourceId: '25565', fetchUrl: `${IC}/jobs/25565/senior-backend-software-engineer/job?in_iframe=1` });
    expect(jobs.some((j) => j.url.endsWith('/jobs/intro'))).toBe(false);
    // another host's URL in the sitemap is never a job of this board
    expect(icimsJobs(`<urlset><url><loc>https://careers-other.icims.com/jobs/1/x/job</loc></url></urlset>`, ICIMS)).toEqual([]);
  });

  it('refs: the tenant host; a stored board URL on that host', () => {
    expect(parseIcimsRef(ICIMS)).toBe(ICIMS);
    expect(parseIcimsRef('www.icims.com')).toBeNull();
    expect(parseIcimsRef('evil.test')).toBeNull();
    expect(parseIcimsRef(`${ICIMS}/x`)).toBeNull();
    expect(icimsBoardOfUrl(`${IC}/sitemap.xml`)).toBe(ICIMS);
    expect(icimsBoardOfUrl('https://careers-acme.icims.com/jobs/1/x/job?in_iframe=1')).toBe('careers-acme.icims.com');
    expect(icimsBoardOfUrl('https://acme.test/sitemap.xml')).toBeNull();
  });

  const routes = (extra: Record<string, Route> = {}): Record<string, Route> => ({
    [`${IC}/robots.txt`]: { status: 200, body: fx('icims-atlassian-robots.txt') },
    [`${IC}/sitemap.xml`]: { status: 200, body: fx('icims-atlassian-sitemap.xml') },
    [`${IC}/jobs/25565/senior-backend-software-engineer/job?in_iframe=1`]: { status: 200, body: fx('icims-atlassian-job-25565.html') },
    ...extra,
  });

  it('pre-filters on the slug titles, fetches at most the budget, names the queue; the recorded page maps to a remote posting', async () => {
    const h = harness(srcIcimsContract, ICIMS_EGRESS, [ICIMS], routes());
    const out = await runAgent(makeSrcIcims({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }), maxPages: 3 }), req('icims', ICIMS, 'Atlassian'), h.ctx);
    // robots.txt, the sitemap, then 3 job pages (the first three title-passing ones, in sitemap order)
    expect(h.calls.slice(0, 3)).toEqual([`${IC}/robots.txt`, `${IC}/sitemap.xml`, `${IC}/jobs/25565/senior-backend-software-engineer/job?in_iframe=1`]);
    expect(h.calls).toHaveLength(5);
    expect(h.skipped[0]).toMatch(/^title-prefilter Atlassian: \d+ of 65 listed jobs not fetched \(the title pre-filter\)$/);
    expect(h.skipped).toContainEqual(expect.stringMatching(/^page-budget Atlassian: \d+ job pages queued \(\d+ never fetched, 0 stale kept from their last fetch\)$/));
    expect(h.slept.every((ms) => ms >= 2000)).toBe(true);
    expect(out.map((p) => p.sourceId)).toEqual(['25565']);
    const p = valid(normalize(out[0] as RawPosting));
    expect(p).toMatchObject({ ats: 'icims', source: 'icims', title: 'Senior Backend Software Engineer', url: `${IC}/jobs/25565/senior-backend-software-engineer/job`, locationText: 'Sydney, AU; Auckland, NZ', postedAt: '2026-08-31T04:00:00.000Z' });
    expect(p.remote.structured).toBe('remote');
    expect(p.descriptionText.length).toBeGreaterThan(1000);
    // an Australia/New Zealand remote job is not eligible for India: never silently accepted
    expect(decideEligibility(p, ELIG).verdict).not.toBe('eligible');
  });

  it('the strict robots rule: a 403 robots.txt is a named skip, nothing else is fetched', async () => {
    const h = harness(srcIcimsContract, ICIMS_EGRESS, [ICIMS], routes({ [`${IC}/robots.txt`]: { status: 403, body: 'denied' } }));
    expect(await runAgent(makeSrcIcims({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('icims', ICIMS, 'Atlassian'), h.ctx)).toEqual([]);
    expect(h.calls).toEqual([`${IC}/robots.txt`]);
    expect(h.skipped).toEqual([`robots-disallow ${ICIMS}: Atlassian not read today (robots-forbidden)`]);
  });

  it('a job path robots.txt disallows is never fetched (path and query matched)', async () => {
    const robots = 'User-agent: *\nDisallow: /jobs/*candidate\nDisallow: /jobs/*in_iframe=1$\n';
    const h = harness(srcIcimsContract, ICIMS_EGRESS, [ICIMS], routes({ [`${IC}/robots.txt`]: { status: 200, body: robots } }));
    expect(await runAgent(makeSrcIcims({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }), maxPages: 2 }), req('icims', ICIMS, 'Atlassian'), h.ctx)).toEqual([]);
    expect(h.calls).toEqual([`${IC}/robots.txt`, `${IC}/sitemap.xml`]);
    // fix round 2: every denied page leaves the plan without spending the budget, so all 24 title-passing pages are named
    expect(h.skipped).toContainEqual(expect.stringMatching(new RegExp(`^robots-disallow ${ICIMS.replaceAll('.', '\\.')}: 24 job pages of Atlassian not read \\(robots-disallow /jobs/`)));
  });

  it('a missing sitemap is gone (never a breaker); a 429 on it disables the host, named, Retry-After never honoured', async () => {
    const gone = harness(srcIcimsContract, ICIMS_EGRESS, [ICIMS], routes({ [`${IC}/sitemap.xml`]: { status: 404, body: 'nf' } }));
    await expect(runAgent(makeSrcIcims({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('icims', ICIMS, 'Atlassian'), gone.ctx)).rejects.toMatchObject({ code: 'gone' });
    const hosts = dailyPlatformHosts({ minIntervalMs: 2000 });
    const slow = harness(srcIcimsContract, ICIMS_EGRESS, [ICIMS], routes({ [`${IC}/sitemap.xml`]: { status: 429, body: 'slow', headers: { 'retry-after': '3600' } } }));
    await expect(runAgent(makeSrcIcims({ hosts }), req('icims', ICIMS, 'Atlassian'), slow.ctx)).rejects.toMatchObject({ code: 'rate_limit' });
    expect(slow.slept.every((ms) => ms < 3_600_000)).toBe(true);
    // a sibling company on that host is deferred, never asked
    const again = harness(srcIcimsContract, ICIMS_EGRESS, [ICIMS], routes());
    await expect(runAgent(makeSrcIcims({ hosts }), req('icims', ICIMS, 'Atlassian'), again.ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^host-disabled:http-429 on /) });
    expect(again.calls).toEqual([]);
  });

  it('a second run the same day reads only new or stale pages and keeps the first run\'s postings', async () => {
    const state = memoryPageState();
    const page = (t: string) => ({ status: 200, body: ld({ title: t, description: '<p>Build.</p>', jobLocation: BLR }) });
    const sitemap = `<urlset>${['1/software-engineer', '2/senior-software-engineer', '3/staff-engineer'].map((s) => `<url><loc>${IC}/jobs/${s}/job</loc></url>`).join('')}</urlset>`;
    const r = {
      [`${IC}/robots.txt`]: { status: 404, body: '' },
      [`${IC}/sitemap.xml`]: { status: 200, body: sitemap },
      [`${IC}/jobs/1/software-engineer/job?in_iframe=1`]: page('Software Engineer'),
      [`${IC}/jobs/2/senior-software-engineer/job?in_iframe=1`]: page('Senior Software Engineer'),
      [`${IC}/jobs/3/staff-engineer/job?in_iframe=1`]: page('Staff Engineer'),
    };
    const h1 = harness(srcIcimsContract, ICIMS_EGRESS, [ICIMS], r);
    const first = await runAgent(makeSrcIcims({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }), state, maxPages: 2 }), req('icims', ICIMS, 'Atlassian'), h1.ctx);
    expect(first.map((p) => p.sourceId)).toEqual(['1', '2']);
    const h2 = harness(srcIcimsContract, ICIMS_EGRESS, [ICIMS], r);
    const second = await runAgent(makeSrcIcims({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }), state, maxPages: 2 }), req('icims', ICIMS, 'Atlassian'), h2.ctx);
    expect(h2.calls).toEqual([`${IC}/robots.txt`, `${IC}/sitemap.xml`, `${IC}/jobs/3/staff-engineer/job?in_iframe=1`]);
    expect(second.map((p) => p.sourceId)).toEqual(['1', '2', '3']);
    expect(second.slice(0, 2)).toEqual(first);
    // India/Bengaluru from JSON-LD: the existing eligibility, unchanged
    const p = valid(normalize(second[2] as RawPosting));
    expect(p.locationText).toBe('Bengaluru, Karnataka, IN');
    expect(p.remote.countries).toContain('india');
    expect(PAGE_MAX_FETCHES).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// SuccessFactors
// ---------------------------------------------------------------------------

const HCL = 'careers.hcltech.com';
const SF = `https://${HCL}`;

describe('SuccessFactors: sitemal.xml streamed under a 50 MB cap', () => {
  it('parses the recorded sitemal: title, link, id, employer, country; the same items whatever the chunking', () => {
    const xml = fx('successfactors-hcltech-sitemal.xml');
    const all = parseSitemal(xml);
    expect(all.items.length).toBe(22);
    expect(all.malformed).toBe(0);
    const first = all.items[0]!;
    expect(first.link.startsWith(`${SF}/job/`)).toBe(true);
    expect(first.location).toBe('IN');
    expect(first.employer).toBe('HCL Technologies Limited');
    expect(first.description.length).toBeGreaterThan(50);
    expect(all.items.filter((i) => i.location !== 'IN').length).toBe(4);
    for (const size of [1, 7, 333, 4096]) {
      const p = sitemalParser();
      for (let i = 0; i < xml.length; i += size) p.feed(xml.slice(i, i + size));
      expect(p.result().items).toEqual(all.items);
    }
  });

  it('is linear on 1 MB adversarial feeds (< 150 ms each, fed in chunks)', () => {
    const feed = (s: string) => {
      const p = sitemalParser();
      for (let i = 0; i < s.length; i += 16 * 1024) p.feed(s.slice(i, i + 16 * 1024));
      return p.result();
    };
    expect(time(() => feed(rep('<item>')))).toBeLessThan(150);
    expect(time(() => feed(`<item>${rep('<title>')}`))).toBeLessThan(150);
    expect(time(() => feed(rep('<item><title>x</title></item>')))).toBeLessThan(500);
    expect(time(() => feed(`<item><description><![CDATA[${rep('<')}`))).toBeLessThan(150);
  });

  it('refs: the Career Site Builder host; a stored sitemal URL', () => {
    expect(parseSuccessFactorsRef(HCL)).toBe(HCL);
    expect(parseSuccessFactorsRef('career5.successfactors.eu/AcmeP')).toBeNull();
    expect(successFactorsBoardOfUrl(`${SF}/sitemal.xml`)).toBe(HCL);
    expect(successFactorsBoardOfUrl('https://career5.successfactors.eu/career?company=AcmeP')).toBeNull();
    expect(SF_SITEMAL_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  const routes = (extra: Record<string, Route> = {}): Record<string, Route> => ({
    [`${SF}/robots.txt`]: { status: 200, body: fx('successfactors-hcltech-robots.txt') },
    [`${SF}/sitemal.xml`]: { status: 200, body: fx('successfactors-hcltech-sitemal.xml') },
    ...extra,
  });

  it('reads postings straight from the feed (title, description, country): no page fetch, outside India not read, titles pre-filtered', async () => {
    const h = harness(srcSuccessFactorsContract, SF_EGRESS, [HCL], routes());
    const out = await runAgent(makeSrcSuccessFactors({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('successfactors', HCL, 'HCLTech'), h.ctx);
    expect(h.calls).toEqual([`${SF}/robots.txt`, `${SF}/sitemal.xml`]);
    expect(out.length).toBe(8);
    expect(h.skipped).toEqual([expect.stringMatching(/^title-prefilter HCLTech: 10 of 18 listed jobs not fetched/), 'not-india HCLTech: 4 listed jobs located outside India not read']);
    const p = valid(normalize(out[0] as RawPosting));
    expect(p).toMatchObject({ ats: 'successfactors', source: 'successfactors', postedAt: null, locationText: 'IN' });
    expect(p.url.startsWith(`${SF}/job/`)).toBe(true);
    expect(p.remote.countries).toEqual(['india']);
    expect(p.descriptionText.length).toBeGreaterThan(50);
    // India, city unknown: never eligible on a guess. The existing eligibility, unchanged, reads `IN` as a generic
    // location field (as Workday's "2 Locations"): an office city only from the description, else onsite elsewhere
    expect(decideEligibility(p, ELIG)).toMatchObject({ verdict: 'rejected', reasons: ['onsite'] });
    const blr = valid(normalize({ ...(out[0] as RawPosting), raw: { ...((out[0] as RawPosting).raw as object), description: '<p>Location: Bengaluru</p><p>Build.</p>' } }));
    expect(decideEligibility(blr, ELIG).verdict).toBe('eligible');
  });

  it('over the cap: a loud refusal naming the cap, nothing emitted, never truncated', async () => {
    const h = harness(srcSuccessFactorsContract, SF_EGRESS, [HCL], routes());
    await expect(runAgent(makeSrcSuccessFactors({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }), maxBytes: 4096 }), req('successfactors', HCL, 'HCLTech'), h.ctx)).rejects.toMatchObject({
      code: 'input_rejected',
      message: expect.stringMatching(/^listing-cap HCLTech: sitemal\.xml passed its 4096-byte cap; nothing read, never truncated/),
    });
    const big = harness(srcSuccessFactorsContract, SF_EGRESS, [HCL], routes({ [`${SF}/sitemal.xml`]: { status: 200, body: 'x', headers: { 'content-length': String(SF_SITEMAL_MAX_BYTES + 1) } } }));
    await expect(runAgent(makeSrcSuccessFactors({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('successfactors', HCL, 'HCLTech'), big.ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^listing-cap HCLTech: sitemal\.xml passed its 52428800-byte cap/) });
  });

  it('an item without a location is read from its job page (JSON-LD), under the page budget; not a feed → refused', async () => {
    const feed = `<?xml version="1.0"?><rss><channel><item><title>Senior Software Engineer</title><description><![CDATA[&lt;p&gt;x&lt;/p&gt;]]></description><link>${SF}/job/Senior-Software-Engineer/77/</link><g:id>77</g:id><g:employer>HCL Technologies Limited</g:employer></item></channel></rss>`;
    const h = harness(srcSuccessFactorsContract, SF_EGRESS, [HCL], routes({ [`${SF}/sitemal.xml`]: { status: 200, body: feed }, [`${SF}/job/Senior-Software-Engineer/77/`]: { status: 302, headers: { location: '/job/Senior-Software-Engineer/9-en_US/' } }, [`${SF}/job/Senior-Software-Engineer/9-en_US/`]: { status: 200, body: ld({ title: 'Senior Software Engineer', description: '<p>Build.</p>', jobLocation: BLR }) } }));
    const out = await runAgent(makeSrcSuccessFactors({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('successfactors', HCL, 'HCLTech'), h.ctx);
    expect(out.map((p) => p.sourceId)).toEqual(['77']);
    const p = valid(normalize(out[0] as RawPosting));
    expect(p.locationText).toBe('Bengaluru, Karnataka, IN');
    expect(decideEligibility(p, ELIG).verdict).not.toBe('rejected');
    const html = harness(srcSuccessFactorsContract, SF_EGRESS, [HCL], routes({ [`${SF}/sitemal.xml`]: { status: 200, body: '<html><body>maintenance</body></html>' } }));
    await expect(runAgent(makeSrcSuccessFactors({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('successfactors', HCL, 'HCLTech'), html.ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/not a sitemal feed/) });
  });

  it('the recorded HCLTech job page has no JSON-LD (microdata only): it would be named, never guessed', () => {
    const page = fx('successfactors-hcltech-job.html');
    expect(page).toContain('itemtype="http://schema.org/JobPosting"');
    expect(page).not.toContain('application/ld+json');
  });
});

// ---------------------------------------------------------------------------
// SmartRecruiters
// ---------------------------------------------------------------------------

const JOBS = 'https://jobs.smartrecruiters.com';
const CAREERS = 'https://careers.smartrecruiters.com';

describe('SmartRecruiters: the jobs.smartrecruiters.com listing → job pages → JSON-LD (never the API)', () => {
  it('never names api.smartrecruiters.com anywhere in src/', () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const hits = walk(join(root, 'src')).filter((f) => readFileSync(f, 'utf8').toLowerCase().includes('api.smartrecruiters.com'));
    expect(hits).toEqual([]);
    expect(SR_HOSTS).toEqual(['careers.smartrecruiters.com', 'jobs.smartrecruiters.com']);
  });

  it('refs: the company id (its case kept); a stored board URL', () => {
    expect(parseSmartRecruitersRef('BoschGroup')).toBe('BoschGroup');
    expect(parseSmartRecruitersRef('Bosch/x')).toBeNull();
    expect(parseSmartRecruitersRef('api')).toBeNull();
    expect(smartRecruitersBoardOfUrl(`${JOBS}/BoschGroup`)).toBe('BoschGroup');
    expect(smartRecruitersBoardOfUrl('https://evil.test/BoschGroup')).toBeNull();
  });

  it('reads job links of the company from a listing, linearly', () => {
    const html = `<a href="/BoschGroup/744000155167930-senior-software-engineer">Senior Software Engineer</a><a href='${JOBS}/BoschGroup/744000100000001-qa-intern'>x</a><a href="${JOBS}/OtherCo/744000100000002-engineer">y</a><a href="/BoschGroup">all</a>`;
    expect(srJobs(html, 'BoschGroup', `${JOBS}/BoschGroup`).jobs).toEqual([
      { url: `${JOBS}/BoschGroup/744000155167930-senior-software-engineer`, title: 'senior software engineer', sourceId: '744000155167930', fetchUrl: `${JOBS}/BoschGroup/744000155167930-senior-software-engineer` },
      { url: `${JOBS}/BoschGroup/744000100000001-qa-intern`, title: 'qa intern', sourceId: '744000100000001', fetchUrl: `${JOBS}/BoschGroup/744000100000001-qa-intern` },
    ]);
    expect(time(() => anchorHrefs(rep('<a href="')))).toBeLessThan(100);
    expect(time(() => anchorHrefs(rep('<a ')))).toBeLessThan(100);
    expect(time(() => anchorHrefs(`<a ${rep('href=')}>`))).toBeLessThan(100);
  });

  it('a paged listing is refused loudly (never a silent first page)', () => {
    expect(() => srJobs(`<a href="/BoschGroup/744000155167930-x">x</a><a href="/BoschGroup?page=2">next</a>`, 'BoschGroup', `${JOBS}/BoschGroup`)).toThrow(/listing-paged BoschGroup/);
  });

  it('the strict rule live: the listing moved to careers.smartrecruiters.com, whose robots.txt redirects off-host (robots-unavailable): a named skip', async () => {
    const routes: Record<string, Route> = {
      [`${JOBS}/robots.txt`]: { status: 404, body: 'nf' },
      [`${JOBS}/BoschGroup`]: { status: 301, headers: { location: `${CAREERS}/BoschGroup` } },
      [`${CAREERS}/robots.txt`]: { status: 302, body: 'Found. Redirecting to https://jobs.smartrecruiters.com', headers: { location: JOBS } },
    };
    const h = harness(srcSmartRecruitersContract, SR_EGRESS, SR_HOSTS, routes);
    expect(await runAgent(makeSrcSmartRecruiters({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('smartrecruiters', 'BoschGroup', 'Bosch'), h.ctx)).toEqual([]);
    expect(h.calls).toEqual([`${JOBS}/robots.txt`, `${JOBS}/BoschGroup`, `${CAREERS}/robots.txt`]);
    expect(h.skipped).toEqual(['robots-disallow careers.smartrecruiters.com: Bosch not read today (robots-unavailable)']);
  });

  it('job pages: the recorded Bosch page (microdata, no JSON-LD) is named; a JSON-LD page maps to Bengaluru, India', async () => {
    const listing = `<a href="/BoschGroup/744000155167930-senior-data-scientist">a</a><a href="/BoschGroup/744000100000009-senior-software-engineer">b</a>`;
    const routes: Record<string, Route> = {
      [`${JOBS}/robots.txt`]: { status: 404, body: 'nf' },
      [`${JOBS}/BoschGroup`]: { status: 200, body: listing },
      [`${JOBS}/BoschGroup/744000155167930-senior-data-scientist`]: { status: 200, body: fx('smartrecruiters-bosch-job.html') + 'x'.repeat(40_000) },
      [`${JOBS}/BoschGroup/744000100000009-senior-software-engineer`]: { status: 200, body: ld({ title: 'Senior Software Engineer', description: '<p>Build.</p>', jobLocation: { '@type': 'Place', address: { addressLocality: 'Bangalore', addressCountry: 'India' } }, hiringOrganization: { name: 'Bosch Group' }, employmentType: 'FULL_TIME' }) },
    };
    const h = harness(srcSmartRecruitersContract, SR_EGRESS, SR_HOSTS, routes, { ...PACK, targets: { titles: [] } });
    const out = await runAgent(makeSrcSmartRecruiters({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('smartrecruiters', 'BoschGroup', 'Bosch'), h.ctx);
    expect(out.map((p) => p.sourceId)).toEqual(['744000100000009']);
    expect(h.skipped).toEqual(['no-jobposting Bosch: 1 job pages without a valid JobPosting (744000155167930: no JobPosting JSON-LD)']);
    const p = valid(normalize(out[0] as RawPosting));
    expect(p).toMatchObject({ ats: 'smartrecruiters', locationText: 'Bangalore, India' });
    expect(decideEligibility(p, ELIG).verdict).toBe('eligible');
  });
});

// ---------------------------------------------------------------------------
// The generic jsonld-sitemap adapter
// ---------------------------------------------------------------------------

const OKTA = 'www.okta.com';
const OK = `https://${OKTA}`;

describe('jsonld-sitemap: careers-domain sitemap → job URLs → JSON-LD', () => {
  it('the default job-URL rule on the recorded Okta sitemap: a careers/jobs segment, then a job slug', () => {
    const jobs = jsonLdJobUrls(sitemapOf(fx('jsonld-okta-sitemap.xml')), { host: OKTA, prefix: null });
    expect(jobs.length).toBeGreaterThan(40);
    expect(jobs.every((j) => new URL(j.url).pathname.startsWith('/company/careers/'))).toBe(true);
    expect(jobs.some((j) => j.url.includes('/video/'))).toBe(false);
    const pse = jobs.find((j) => j.url === `${OK}/company/careers/principal-software-engineer-7781674/`);
    expect(pse).toMatchObject({ title: 'principal software engineer 7781674' });
    expect(pse!.sourceId).toMatch(/^[0-9a-f]{16}$/);
    // a stored prefix narrows it; a section page (no digit, no hyphen) is never a job
    expect(jsonLdJobUrls([`${OK}/company/careers/ga/x-1/`, `${OK}/company/careers/ga/`, `${OK}/company/careers/sales/`, `${OK}/jobs/`], { host: OKTA, prefix: null }).map((j) => j.url)).toEqual([`${OK}/company/careers/ga/x-1/`]);
    expect(jsonLdJobUrls([`${OK}/company/careers/ga/x-1/`, `${OK}/careers/y-2/`], { host: OKTA, prefix: '/careers/' }).map((j) => j.url)).toEqual([`${OK}/careers/y-2/`]);
  });

  it('refs: a host, optionally with a stored path prefix; the stored board URL', () => {
    expect(parseJsonLdRef(OKTA)).toEqual({ host: OKTA, prefix: null });
    expect(parseJsonLdRef(`${OKTA}/company/careers/`)).toEqual({ host: OKTA, prefix: '/company/careers/' });
    expect(parseJsonLdRef('not a host')).toBeNull();
    expect(jsonLdBoardOfUrl(`${OK}/sitemap.xml`)).toBe(OKTA);
  });

  const routes = (extra: Record<string, Route> = {}): Record<string, Route> => ({
    [`${OK}/robots.txt`]: { status: 200, body: fx('jsonld-okta-robots.txt') },
    [`${OK}/sitemap.xml`]: { status: 200, body: fx('jsonld-okta-sitemap.xml') },
    [`${OK}/company/careers/principal-software-engineer-7781674/`]: { status: 301, headers: { location: `${OK}/company/careers/rd/principal-software-engineer-7781674/` } },
    [`${OK}/company/careers/rd/principal-software-engineer-7781674/`]: { status: 200, body: fx('jsonld-okta-job.html') + 'x'.repeat(40_000) },
    ...extra,
  });

  it('reads the recorded page (after its same-host redirect): Bengaluru, India, eligible under the existing rules', async () => {
    const h = harness(srcJsonLdContract, JSONLD_EGRESS, [OKTA], routes(), { ...PACK, targets: { titles: ['principal software engineer'] } });
    const out = await runAgent(makeSrcJsonLd({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('jsonld-sitemap', OKTA, 'Okta'), h.ctx);
    const pse = out.find((p) => (p.raw as { url: string }).url === `${OK}/company/careers/principal-software-engineer-7781674/`);
    expect(pse).toBeDefined();
    const p = valid(normalize(pse as RawPosting));
    expect(p).toMatchObject({ ats: 'jsonld-sitemap', title: 'Principal Software Engineer', locationText: 'Bengaluru, India', employmentType: 'FULL_TIME', postedAt: '2026-07-15' });
    expect(decideEligibility(p, ELIG).verdict).toBe('eligible');
  });

  it('no /sitemap.xml: the sitemaps robots.txt names on the same host are used; none at all is refused by name', async () => {
    const robots = `User-agent: *\nDisallow: /search/\nSitemap: ${OK}/sitemaps/careers.xml\nSitemap: https://elsewhere.test/s.xml\n`;
    const sm = `<urlset><url><loc>${OK}/careers/senior-software-engineer-1/</loc></url></urlset>`;
    const h = harness(srcJsonLdContract, JSONLD_EGRESS, [OKTA], routes({ [`${OK}/robots.txt`]: { status: 200, body: robots }, [`${OK}/sitemap.xml`]: { status: 404 }, [`${OK}/sitemaps/careers.xml`]: { status: 200, body: sm }, [`${OK}/careers/senior-software-engineer-1/`]: { status: 200, body: ld({ title: 'Senior Software Engineer', description: 'x', jobLocation: BLR }) } }));
    const out = await runAgent(makeSrcJsonLd({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('jsonld-sitemap', OKTA, 'Okta'), h.ctx);
    expect(out).toHaveLength(1);
    expect(h.calls).not.toContain('https://elsewhere.test/s.xml');
    const none = harness(srcJsonLdContract, JSONLD_EGRESS, [OKTA], routes({ [`${OK}/robots.txt`]: { status: 404 }, [`${OK}/sitemap.xml`]: { status: 404 } }));
    await expect(runAgent(makeSrcJsonLd({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('jsonld-sitemap', OKTA, 'Okta'), none.ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^jsonld-sitemap Okta: no sitemap/) });
  });

  it('a sitemap index: the careers/jobs sitemaps first, within a loud listing cap', async () => {
    const index = (n: number) => `<?xml version="1.0"?><sitemapindex>${Array.from({ length: n }, (_, i) => `<sitemap><loc>${OK}/s/blog-${i}.xml</loc></sitemap>`).join('')}<sitemap><loc>${OK}/s/careers.xml</loc></sitemap></sitemapindex>`;
    const sm = `<urlset><url><loc>${OK}/careers/senior-software-engineer-1/</loc></url></urlset>`;
    const h = harness(srcJsonLdContract, JSONLD_EGRESS, [OKTA], routes({ [`${OK}/sitemap.xml`]: { status: 200, body: index(30) }, [`${OK}/s/careers.xml`]: { status: 200, body: sm }, [`${OK}/careers/senior-software-engineer-1/`]: { status: 200, body: ld({ title: 'Senior Software Engineer', description: 'x' }) } }));
    expect(await runAgent(makeSrcJsonLd({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('jsonld-sitemap', OKTA, 'Okta'), h.ctx)).toHaveLength(1);
    expect(h.calls.filter((u) => u.includes('/s/blog-'))).toEqual([]);
    // no careers/jobs child: every child is read, and more than the cap is refused loudly
    const plain = `<?xml version="1.0"?><sitemapindex>${Array.from({ length: JSONLD_LISTING_MAX_REQUESTS }, (_, i) => `<sitemap><loc>${OK}/s/blog-${i}.xml</loc></sitemap>`).join('')}</sitemapindex>`;
    const capped = harness(srcJsonLdContract, JSONLD_EGRESS, [OKTA], routes({ [`${OK}/sitemap.xml`]: { status: 200, body: plain } }));
    await expect(runAgent(makeSrcJsonLd({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('jsonld-sitemap', OKTA, 'Okta'), capped.ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^listing-cap Okta: /) });
  });
});

const sitemapOf = (xml: string): string[] => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1] as string);

// ---------------------------------------------------------------------------
// The verifier clients
// ---------------------------------------------------------------------------

describe('verifier clients: the listing once, at least one job URL, one job page with a valid JobPosting', () => {
  const hosts = (): PlatformHosts => dailyPlatformHosts({ minIntervalMs: 2000 });
  const icRoutes: Record<string, Route> = {
    [`${IC}/robots.txt`]: { status: 200, body: fx('icims-atlassian-robots.txt') },
    [`${IC}/sitemap.xml`]: { status: 200, body: fx('icims-atlassian-sitemap.xml') },
    [`${IC}/jobs/25565/senior-backend-software-engineer/job?in_iframe=1`]: { status: 200, body: fx('icims-atlassian-job-25565.html') },
  };

  it('iCIMS: 65 jobs, the board name from hiringOrganization (Atlassian), 3 requests', async () => {
    const c = platformClient('icims')!;
    expect(c.refOf(ICIMS, `${IC}/sitemap.xml`)).toBe(ICIMS);
    expect(c.hostOf(ICIMS)).toBe(ICIMS);
    const h = harness(srcIcimsContract, ICIMS_EGRESS, [ICIMS], icRoutes);
    const read = await c.readBoard(ICIMS, h.ctx.http!, { hosts: hosts() });
    expect(read).toMatchObject({ boardName: 'Atlassian', boardNames: ['Atlassian'], complete: true, nameKey: null, url: `${IC}/sitemap.xml` });
    expect(read.jobs).toHaveLength(65);
    expect(h.calls).toHaveLength(3);
  });

  it('a job page with no valid JobPosting fails the read (invalid_output); a 429 or a challenge is a refusal the verifier defers', async () => {
    const c = platformClient('icims')!;
    const bad = harness(srcIcimsContract, ICIMS_EGRESS, [ICIMS], { ...icRoutes, [`${IC}/jobs/25565/senior-backend-software-engineer/job?in_iframe=1`]: { status: 200, body: `<html>${'x'.repeat(40_000)}</html>` } });
    await expect(c.readBoard(ICIMS, bad.ctx.http!, { hosts: hosts() })).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/no valid JobPosting/) });
    const slow = harness(srcIcimsContract, ICIMS_EGRESS, [ICIMS], { ...icRoutes, [`${IC}/jobs/25565/senior-backend-software-engineer/job?in_iframe=1`]: { status: 429, body: '' } });
    await expect(c.readBoard(ICIMS, slow.ctx.http!, { hosts: hosts() })).rejects.toMatchObject({ code: 'rate_limit' });
    const wall = harness(srcIcimsContract, ICIMS_EGRESS, [ICIMS], { ...icRoutes, [`${IC}/sitemap.xml`]: { status: 503, body: 'Just a moment...' } });
    await expect(c.readBoard(ICIMS, wall.ctx.http!, { hosts: hosts() })).rejects.toMatchObject({ code: 'challenged' });
  });

  it('SuccessFactors: the feed is read only up to its first item (the daily adapter reads postings from the feed itself)', async () => {
    const c = platformClient('successfactors')!;
    expect(c.refOf(HCL, `${SF}/sitemal.xml`)).toBe(HCL);
    const h = harness(srcSuccessFactorsContract, SF_EGRESS, [HCL], { [`${SF}/robots.txt`]: { status: 200, body: fx('successfactors-hcltech-robots.txt') }, [`${SF}/sitemal.xml`]: { status: 200, body: fx('successfactors-hcltech-sitemal.xml') } });
    const read = await c.readBoard(HCL, h.ctx.http!, { hosts: hosts() });
    expect(read).toMatchObject({ boardName: 'HCL Technologies Limited', complete: false, nameKey: null });
    expect(read.jobs).toHaveLength(1);
  });

  it('SmartRecruiters and jsonld-sitemap clients exist; the generic one reads Okta (board name Okta, Inc.)', async () => {
    expect(platformClient('smartrecruiters')!.refOf('BoschGroup', `${JOBS}/BoschGroup`)).toBe('BoschGroup');
    const c = platformClient('jsonld-sitemap')!;
    expect(c.refOf(OKTA, `${OK}/sitemap.xml`)).toBe(OKTA);
    const routes: Record<string, Route> = {
      [`${OK}/robots.txt`]: { status: 200, body: fx('jsonld-okta-robots.txt') },
      [`${OK}/sitemap.xml`]: { status: 200, body: `<urlset><url><loc>${OK}/company/careers/principal-software-engineer-7781674/</loc></url></urlset>` },
      [`${OK}/company/careers/principal-software-engineer-7781674/`]: { status: 200, body: fx('jsonld-okta-job.html') + 'x'.repeat(40_000) },
    };
    const h = harness(srcJsonLdContract, JSONLD_EGRESS, [OKTA], routes);
    await expect(c.readBoard(OKTA, h.ctx.http!, { hosts: hosts() })).resolves.toMatchObject({ boardName: 'Okta, Inc.', jobs: [expect.anything()] });
  });

  it('a listing with no job URL reads as 0 jobs (proposed), no page fetched', async () => {
    const h = harness(srcIcimsContract, ICIMS_EGRESS, [ICIMS], { ...icRoutes, [`${IC}/sitemap.xml`]: { status: 200, body: '<urlset></urlset>' } });
    const read = await platformClient('icims')!.readBoard(ICIMS, h.ctx.http!, { hosts: hosts() });
    expect(read.jobs).toEqual([]);
    expect(h.calls).toHaveLength(2);
    void fetchIcimsListing;
  });
});

describe('fix round 2', () => {
  it('mutant M22: the SmartRecruiters title pre-filter runs before the budget (a failing title is never fetched, and named)', async () => {
    const listing = `<a href="/BoschGroup/744000100000009-senior-software-engineer">a</a><a href="/BoschGroup/744000100000010-qa-intern">b</a>`;
    const routes: Record<string, Route> = {
      [`${JOBS}/robots.txt`]: { status: 404, body: 'nf' },
      [`${JOBS}/BoschGroup`]: { status: 200, body: listing },
      [`${JOBS}/BoschGroup/744000100000009-senior-software-engineer`]: { status: 200, body: ld({ title: 'Senior Software Engineer', description: 'x' }) },
    };
    const h = harness(srcSmartRecruitersContract, SR_EGRESS, SR_HOSTS, routes);
    expect((await runAgent(makeSrcSmartRecruiters({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('smartrecruiters', 'BoschGroup', 'Bosch'), h.ctx)).map((p) => p.sourceId)).toEqual(['744000100000009']);
    expect(h.calls.some((c) => c.includes('qa-intern'))).toBe(false);
    expect(h.skipped).toEqual(['title-prefilter Bosch: 1 of 2 listed jobs not fetched (the title pre-filter)']);
  });

  it('minor 3: a SmartRecruiters listing that loads a captcha script but lists job links is read, not a challenge', async () => {
    const listing = `<script src="https://www.google.com/recaptcha/api.js"></script><a href="/BoschGroup/744000100000009-senior-software-engineer">a</a>`;
    const h = harness(srcSmartRecruitersContract, SR_EGRESS, SR_HOSTS, { [`${JOBS}/robots.txt`]: { status: 404 }, [`${JOBS}/BoschGroup`]: { status: 200, body: listing }, [`${JOBS}/BoschGroup/744000100000009-senior-software-engineer`]: { status: 200, body: ld({ title: 'Senior Software Engineer', description: 'x' }) } });
    expect(await runAgent(makeSrcSmartRecruiters({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('smartrecruiters', 'BoschGroup', 'Bosch'), h.ctx)).toHaveLength(1);
  });

  it('mutant M23: the jsonld-sitemap title pre-filter runs before the budget', async () => {
    const sm = `<urlset><url><loc>${OK}/careers/senior-software-engineer-1/</loc></url><url><loc>${OK}/careers/account-executive-2/</loc></url></urlset>`;
    const h = harness(srcJsonLdContract, JSONLD_EGRESS, [OKTA], { [`${OK}/robots.txt`]: { status: 404 }, [`${OK}/sitemap.xml`]: { status: 200, body: sm }, [`${OK}/careers/senior-software-engineer-1/`]: { status: 200, body: ld({ title: 'Senior Software Engineer', description: 'x' }) } });
    expect(await runAgent(makeSrcJsonLd({ hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) }), req('jsonld-sitemap', OKTA, 'Okta'), h.ctx)).toHaveLength(1);
    expect(h.calls.some((c) => c.includes('account-executive'))).toBe(false);
    expect(h.skipped).toEqual(['title-prefilter Okta: 1 of 2 listed jobs not fetched (the title pre-filter)']);
  });

  it('mutant M29: a 429 on sitemal.xml disables the host (named, never retried around); a sibling is deferred without a request', async () => {
    const hosts = dailyPlatformHosts({ minIntervalMs: 2000 });
    const h = harness(srcSuccessFactorsContract, SF_EGRESS, [HCL], { [`${SF}/robots.txt`]: { status: 404 }, [`${SF}/sitemal.xml`]: { status: 429, body: 'slow down', headers: { 'retry-after': '600' } } });
    await expect(runAgent(makeSrcSuccessFactors({ hosts }), req('successfactors', HCL, 'HCLTech'), h.ctx)).rejects.toMatchObject({ code: 'rate_limit' });
    expect(hosts.disabledWhy(HCL)).toBe('http-429');
    const again = harness(srcSuccessFactorsContract, SF_EGRESS, [HCL], {});
    await expect(runAgent(makeSrcSuccessFactors({ hosts }), req('successfactors', HCL, 'HCLTech'), again.ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^host-disabled:http-429 on /) });
    expect(again.calls).toEqual([]);
  });

  it('minor 5: a 2xx bot wall instead of the feed is a challenge (the host disabled), not "not a sitemal feed"', async () => {
    const hosts = dailyPlatformHosts({ minIntervalMs: 2000 });
    const h = harness(srcSuccessFactorsContract, SF_EGRESS, [HCL], { [`${SF}/robots.txt`]: { status: 404 }, [`${SF}/sitemal.xml`]: { status: 200, body: '<html><head><title>Just a moment...</title></head><body>cf-chl</body></html>' } });
    await expect(runAgent(makeSrcSuccessFactors({ hosts }), req('successfactors', HCL, 'HCLTech'), h.ctx)).rejects.toMatchObject({ code: 'challenged' });
    expect(hosts.disabledWhy(HCL)).toBe('challenge');
  });

  it('important 2: the sitemal parser is linear in the stream, an item never closed included (< 500 ms each)', () => {
    const chunked = (total: number, size: number, prefix: string): number => {
      const p = sitemalParser();
      const filler = 'x'.repeat(size);
      return time(() => {
        p.feed(prefix);
        for (let n = 0; n < total; n += size) p.feed(filler);
        p.result();
      });
    };
    expect(chunked(32 * MB, 16 * 1024, '<rss><channel><item><title>never closed')).toBeLessThan(500);
    expect(chunked(MB, 64, '<rss><channel><item><description><![CDATA[')).toBeLessThan(500);
    // a split end marker across chunks still closes the item
    const p = sitemalParser();
    for (const c of ['<rss><channel><it', 'em><title>A</title><link>https://a.test/job/101/</link></ite', 'm><item><title>B</title><link>https://a.test/job/102/</link></item', '>']) p.feed(c);
    expect(p.result().items.map((i) => i.title)).toEqual(['A', 'B']);
  });

  it('minor 4: the verifier tries up to 3 listed job pages, in order, before failing (Okta lists stale 404s first)', async () => {
    const c = platformClient('jsonld-sitemap')!;
    const sm = (n: number) => `<urlset>${Array.from({ length: n }, (_, i) => `<url><loc>${OK}/careers/job-${i + 1}/</loc></url>`).join('')}</urlset>`;
    const good = { status: 200, body: ld({ title: 'Engineer', description: 'x', hiringOrganization: { name: 'Okta, Inc.' } }) };
    const ok = harness(srcJsonLdContract, JSONLD_EGRESS, [OKTA], { [`${OK}/robots.txt`]: { status: 404 }, [`${OK}/sitemap.xml`]: { status: 200, body: sm(4) }, [`${OK}/careers/job-3/`]: good });
    await expect(c.readBoard(OKTA, ok.ctx.http!, { hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) })).resolves.toMatchObject({ boardName: 'Okta, Inc.' });
    expect(ok.calls.filter((u) => u.includes('/careers/job-'))).toEqual([`${OK}/careers/job-1/`, `${OK}/careers/job-2/`, `${OK}/careers/job-3/`]);
    const bad = harness(srcJsonLdContract, JSONLD_EGRESS, [OKTA], { [`${OK}/robots.txt`]: { status: 404 }, [`${OK}/sitemap.xml`]: { status: 200, body: sm(4) }, [`${OK}/careers/job-4/`]: good });
    await expect(c.readBoard(OKTA, bad.ctx.http!, { hosts: dailyPlatformHosts({ minIntervalMs: 2000 }) })).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/no valid JobPosting on 3 job pages/) });
    expect(bad.calls.some((u) => u.endsWith('/careers/job-4/'))).toBe(false);
  });
});
