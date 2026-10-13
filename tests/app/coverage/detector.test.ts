import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { capabilityProblems, CAPABILITY_ALLOW_LIST } from '../../../src/app/allow-list.js';
import { appEvalSpecs } from '../../../src/app/evals.js';
import { runEval } from '../../../src/evals/runner.js';
import { makePlatformDetector, platformDetectorContract, detectorEgressSets, detectorHosts, eightfoldConfigDomain, pageSignals, jobsLink, isSoft404, MAX_SCAN_CHARS } from '../../../src/app/coverage/detector.js';
import { makeRunGate, memoryHostStateStore } from '../../../src/app/coverage/gate.js';
import { careersLocatorContract, locatorEgressSets, makeCareersLocator } from '../../../src/app/coverage/locator.js';
import { matchUrl, SIGNATURES } from '../../../src/app/coverage/signatures.js';
import { CareersSite, CompanyCandidate, Platform, PlatformGuess } from '../../../src/app/coverage/types.js';
import { AppStore } from '../../../src/app/store/app-store.js';
import { issueContext } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import type { FetchLike } from '../../../src/kernel/providers.js';
import { Store } from '../../../src/kernel/store/store.js';

/** A fresh run gate's source: its own key on an explicit memory store. */
const fresh = () => ({ runKey: 'test', store: memoryHostStateStore() });

const RUN = '2026-10-13';
const cand = (domain: string, over: Partial<CompanyCandidate> = {}): CompanyCandidate => ({
  companyKey: domain,
  name: 'Example Co',
  website: `https://www.${domain}`,
  careersUrl: null,
  source: 'pick',
  runDate: RUN,
  ...over,
});
const site = (domain: string, careersUrl: string | null, over: Partial<CareersSite> = {}): CareersSite => ({
  candidate: cand(domain),
  careersUrl,
  method: careersUrl === null ? 'none' : 'path',
  evidence: careersUrl === null ? null : 'GET /careers 200',
  ...over,
});

interface Route {
  readonly status?: number;
  readonly body?: string;
  readonly location?: string;
}
/** A fake fetch serving exact URLs (anything else is a 404). `calls` records every URL asked for. */
function serve(routes: Record<string, Route | string>) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const r = routes[url];
    const route: Route = r === undefined ? { status: 404, body: 'Not Found' } : typeof r === 'string' ? { status: 200, body: r } : r;
    const body = route.body ?? '';
    return {
      status: route.status ?? 200,
      headers: { get: (n: string) => (n.toLowerCase() === 'location' ? (route.location ?? null) : null) },
      text: async () => body,
    };
  };
  return { fetch, calls };
}

function ctxFor(fetch: FetchLike, sites: readonly CareersSite[], contract = platformDetectorContract) {
  return issueContext({
    contract,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: { fetch },
    clock: fixedClock('2026-10-13T00:00:00Z'),
    signal: new AbortController().signal,
    egressSets: contract === platformDetectorContract ? detectorEgressSets(sites) : locatorEgressSets(sites.map((s) => s.candidate)),
  });
}

async function detect(s: CareersSite, fetch: FetchLike, agent = makePlatformDetector(fresh()), egressFor: readonly CareersSite[] = [s]): Promise<PlatformGuess> {
  const ctx = ctxFor(fetch, egressFor);
  const out = await agent.run(s, ctx);
  expect(out).toHaveLength(1);
  expect(ctx.denials()).toEqual([]);
  return PlatformGuess.schema.parse(out[0]);
}

const page = (body: string, title = 'Careers'): string => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const verdict = (g: PlatformGuess): string => (g.evidence[0] ?? '').split(':')[0] ?? '';

describe('signature table: one example per row, slug and boardUrl', () => {
  const cases: [string, Platform, string, string][] = [
    ['https://mastercard.wd1.myworkdayjobs.com/CorporateCareers/job/Pune-India/Engineer_R-1/apply', 'workday', 'mastercard/CorporateCareers', 'https://mastercard.wd1.myworkdayjobs.com/wday/cxs/mastercard/CorporateCareers/jobs'],
    ['https://Acme.wd5.myworkdayjobs.com/en-US/External?q=1#x', 'workday', 'acme/External', 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs'],
    ['https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs', 'workday', 'acme/External', 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs'],
    ['https://wd3.myworkdaysite.com/recruiting/acme/Careers', 'workday', 'acme/Careers', 'https://wd3.myworkdaysite.com/wday/cxs/acme/Careers/jobs'],
    ['https://acme.eightfold.ai/careers?domain=Acme.com&start=0', 'eightfold', 'acme.eightfold.ai/acme.com', 'https://acme.eightfold.ai/api/apply/v2/jobs?domain=acme.com'],
    ['https://apply.careers.example.test/api/apply/v2/jobs?domain=example.test&num=10', 'eightfold', 'apply.careers.example.test/example.test', 'https://apply.careers.example.test/api/apply/v2/jobs?domain=example.test'],
    ['https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/jobs?mode=location', 'oracle', 'jpmc.fa.oraclecloud.com/CX_1001', 'https://jpmc.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=CX_1001'],
    ['https://acme.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?finder=findReqs;siteNumber=CX_7,limit=25', 'oracle', 'acme.fa.us2.oraclecloud.com/CX_7', 'https://acme.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=CX_7'],
    ['https://careers-acme.icims.com/jobs/123/engineer/job?in_iframe=1', 'icims', 'careers-acme.icims.com', 'https://careers-acme.icims.com/sitemap.xml'],
    ['https://career5.successfactors.eu/career?company=AcmeP&career_ns=job_listing', 'successfactors', 'career5.successfactors.eu/AcmeP', 'https://career5.successfactors.eu/career?company=AcmeP'],
    ['https://jobs.smartrecruiters.com/BoschGroup/744000012345-engineer', 'smartrecruiters', 'BoschGroup', 'https://jobs.smartrecruiters.com/BoschGroup'],
    ['https://careers.smartrecruiters.com/Visa1', 'smartrecruiters', 'Visa1', 'https://jobs.smartrecruiters.com/Visa1'],
    ['https://jobs.smartrecruiters.com/oneclick-ui/company/BoschGroup/publication/abc', 'smartrecruiters', 'BoschGroup', 'https://jobs.smartrecruiters.com/BoschGroup'],
    ['https://apply.workable.com/huggingface/j/ABC123/', 'workable', 'huggingface', 'https://apply.workable.com/api/v1/widget/accounts/huggingface'],
    ['https://apply.workable.com/api/v1/widget/accounts/huggingface', 'workable', 'huggingface', 'https://apply.workable.com/api/v1/widget/accounts/huggingface'],
    ['https://bunq.recruitee.com/o/engineer', 'recruitee', 'bunq', 'https://bunq.recruitee.com/api/offers/'],
    ['https://career.teamtailor.com/jobs', 'teamtailor', 'career.teamtailor.com', 'https://career.teamtailor.com/jobs.rss'],
    ['https://personio.jobs.personio.de/job/1?display=en', 'personio', 'personio', 'https://personio.jobs.personio.de/xml'],
    ['https://acme.jobs.personio.com/', 'personio', 'acme', 'https://acme.jobs.personio.com/xml'],
    ['https://rednucleus.bamboohr.com/careers/12', 'bamboohr', 'rednucleus', 'https://rednucleus.bamboohr.com/careers/list'],
    ['https://acme.breezy.hr/p/abc-engineer', 'breezy', 'acme', 'https://acme.breezy.hr/json'],
    ['https://grasshopper.pinpointhq.com/en/postings/x', 'pinpoint', 'grasshopper', 'https://grasshopper.pinpointhq.com/postings.json'],
    ['https://ats.rippling.com/rippling/jobs', 'rippling', 'rippling', 'https://api.rippling.com/platform/api/ats/v1/board/rippling/jobs'],
    ['https://ats.rippling.com/en-GB/acme/jobs/1', 'rippling', 'acme', 'https://api.rippling.com/platform/api/ats/v1/board/acme/jobs'],
    ['https://jobs.gem.com/gem/abc', 'gem', 'gem', 'https://api.gem.com/job_board/v0/gem/job_posts/'],
    ['https://boards.greenhouse.io/Okta/jobs/1?gh_jid=1', 'greenhouse', 'okta', 'https://boards-api.greenhouse.io/v1/boards/okta/jobs'],
    ['https://job-boards.greenhouse.io/acme', 'greenhouse', 'acme', 'https://boards-api.greenhouse.io/v1/boards/acme/jobs'],
    ['https://boards.greenhouse.io/embed/job_board?for=Acme&b=https://x.test', 'greenhouse', 'acme', 'https://boards-api.greenhouse.io/v1/boards/acme/jobs'],
    ['https://boards.greenhouse.io/embed/job_board/js?for=acme', 'greenhouse', 'acme', 'https://boards-api.greenhouse.io/v1/boards/acme/jobs'],
    ['https://jobs.lever.co/Acme/abc-123/apply', 'lever', 'acme', 'https://api.lever.co/v0/postings/acme'],
    ['https://jobs.ashbyhq.com/Ramp/123', 'ashby', 'Ramp', 'https://api.ashbyhq.com/posting-api/job-board/Ramp'],
  ];
  it.each(cases)('%s -> %s %s', (url, platform, slug, boardUrl) => {
    expect(matchUrl(new URL(url))).toEqual({ platform, board: { slug, boardUrl } });
  });

  it('every row of the table has an example above', () => {
    expect(new Set(cases.map((c) => c[1]))).toEqual(new Set(SIGNATURES.map((r) => r.platform)));
  });

  it('a URL on the platform that names no board is slugless', () => {
    for (const u of ['https://acme.wd5.myworkdayjobs.com/', 'https://acme.eightfold.ai/careers', 'https://rmkcdn.successfactors.com/x/main.css', 'https://apply.workable.com/', 'https://boards.greenhouse.io/', 'https://rednucleus.bamboohr.com/login', 'https://jpmc.fa.oraclecloud.com/hcmUI/x']) {
      expect(matchUrl(new URL(u))?.board, u).toBe('slugless');
    }
  });

  it('vendor asset hosts and asset paths never name a board (seen live: assets-cdn.breezy.hr, jobs.lever.co/js, jobs.gem.com/manifest.json)', () => {
    for (const u of ['https://assets-cdn.breezy.hr/x.css', 'https://static.recruitee.com/x.js', 'https://jobs.lever.co/js/main.js', 'https://jobs.gem.com/manifest.json', 'https://jobs.ashbyhq.com/favicon.ico', 'https://boards.greenhouse.io/assets/x.png']) {
      expect(matchUrl(new URL(u))?.board, u).toBe('slugless');
    }
  });

  it('Workday: only a ll-CC segment is a locale, so a two-letter site name is the site (fix round 1)', () => {
    expect(matchUrl(new URL('https://acme.wd5.myworkdayjobs.com/ab'))).toEqual({ platform: 'workday', board: { slug: 'acme/ab', boardUrl: 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/ab/jobs' } });
    expect(matchUrl(new URL('https://acme.wd5.myworkdayjobs.com/en-US/ab/job/x'))?.board).toMatchObject({ slug: 'acme/ab' });
  });

  it("Workable's error paths (oops) are not a board", () => {
    expect(matchUrl(new URL('https://apply.workable.com/oops'))?.board).toBe('slugless');
    expect(matchUrl(new URL('https://apply.workable.com/huggingface/?not_found=true'))?.board).toMatchObject({ slug: 'huggingface' });
  });

  it('Ashby: an encoded board name is decoded; the boardUrl encodes it again for the posting API', () => {
    expect(matchUrl(new URL('https://jobs.ashbyhq.com/Blackpoint%20Cyber/1d5c'))).toEqual({
      platform: 'ashby', board: { slug: 'Blackpoint Cyber', boardUrl: 'https://api.ashbyhq.com/posting-api/job-board/Blackpoint%20Cyber' },
    });
    expect(matchUrl(new URL('https://jobs.ashbyhq.com/a%2Fb'))?.board).toBe('slugless');
  });

  it('telemetry and error-reporting vendor hosts are not platform signals', () => {
    for (const u of ['https://vs-errors.eightfold.ai/api/report', 'https://content.bhrpendo.bamboohr.com/agent/x.js', 'https://otel-collector.gem.com/v1/traces']) expect(matchUrl(new URL(u)), u).toBeNull();
    expect(pageSignals('<script src="https://vs-errors.eightfold.ai/x.js"></script>', 'https://careers.acme.test/careers?domain=acme.test').ats).toEqual([]);
  });

  it('vendor marketing sites, look-alikes and the SmartRecruiters API are not signatures', () => {
    for (const u of [
      'https://www.greenhouse.io/', 'https://www.lever.co/', 'https://lever.co/', 'https://notmyworkdayjobs.com/x', 'https://www.workable.com/', 'https://www.icims.com/', 'https://icims.com/',
      'https://www.teamtailor.com/', 'https://www.bamboohr.com/careers', 'https://www.successfactors.com/', 'https://www.recruitee.com/', 'https://api.smartrecruiters.com/v1/companies/X/postings',
      'https://myworkdayjobs.com.evil.test/acme/External', 'https://www.eightfold.ai/careers?domain=x.com',
    ]) {
      expect(matchUrl(new URL(u)), u).toBeNull();
    }
  });
});

describe('pageSignals: what the HTML says', () => {
  it('reads hrefs, link hrefs, script srcs, iframe srcs and form actions, resolved against the page', () => {
    const html = `<a href="https://jobs.lever.co/acme">Jobs</a><link rel="preconnect" href="//jobs.ashbyhq.com/acme">
      <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script><iframe src="https://apply.workable.com/acme/"></iframe>
      <form action="https://acme.breezy.hr/apply"></form>`;
    const s = pageSignals(html, 'https://www.acme.test/careers');
    expect(s.ats.map((x) => [x.platform, x.slug, x.where])).toEqual([
      ['lever', 'acme', 'a'], ['ashby', 'acme', 'link'], ['greenhouse', 'acme', 'script'], ['workable', 'acme', 'iframe'], ['breezy', 'acme', 'form'],
    ]);
  });

  it('decodes &amp; in attributes and reads relative links on a platform-hosted page', () => {
    const s = pageSignals('<a href="/embed/job_board?for=acme&amp;b=1">x</a>', 'https://boards.greenhouse.io/acme');
    expect(s.ats.map((x) => [x.platform, x.slug, x.where])).toEqual([['greenhouse', 'acme', 'a']]);
  });

  it('finds URLs in inline scripts, JSON-escaped ones included', () => {
    const html = `<script>window.ddo = {"applyUrl":"https:\\/\\/mastercard.wd1.myworkdayjobs.com\\/CorporateCareers\\/job\\/x\\/apply","x":1};</script>`;
    const s = pageSignals(html, 'https://careers.example.test/');
    expect(s.ats.map((x) => [x.platform, x.slug, x.where])).toEqual([['workday', 'mastercard/CorporateCareers', 'inline']]);
  });

  it('recognises a Phenom front-end', () => {
    expect(pageSignals('<link href="https://cdn.phenompeople.com/CareerConnectResources/x.css" rel="stylesheet">', 'https://careers.example.test/').phenom).toBe(true);
    expect(pageSignals('<a href="/x">x</a>', 'https://careers.example.test/').phenom).toBe(false);
  });

  it('JobPosting JSON-LD: plain, in @graph, with an array @type; malformed or other types are no signal', () => {
    const ld = (j: string) => `<script type="application/ld+json">${j}</script>`;
    const u = 'https://www.acme.test/careers/1';
    expect(pageSignals(ld('{"@context":"https://schema.org","@type":"JobPosting","title":"x"}'), u).jobPosting).toBe(true);
    expect(pageSignals(ld('{"@graph":[{"@type":"Organization"},{"@type":["JobPosting"]}]}'), u).jobPosting).toBe(true);
    expect(pageSignals(ld('[{"@type":"WebPage"},{"@type":"JobPosting"}]'), u).jobPosting).toBe(true);
    expect(pageSignals(ld('{"@type":"JobPosting",'), u).jobPosting).toBe(false);
    expect(pageSignals(ld('{"@type":"Organization"}'), u).jobPosting).toBe(false);
    expect(pageSignals(`<script type='application/ld+json'>{"@type":"JobPosting"}</script>`, u).jobPosting).toBe(true);
  });

  it('gh_jid on a company page is a Greenhouse signal without a board slug', () => {
    const s = pageSignals('<a href="/company/careers/opportunity/123?gh_jid=123">Engineer</a>', 'https://www.okta.test/company/careers/');
    expect(s.ats.map((x) => [x.platform, x.slug, x.where])).toEqual([['greenhouse', null, 'marker']]);
  });

  it('a Teamtailor or SuccessFactors asset on the company host makes that host the board', () => {
    const tt = pageSignals('<script src="https://scripts.teamtailor-cdn.com/assets/x.js"></script>', 'https://careers.acme.test/jobs');
    expect(tt.ats.map((x) => [x.platform, x.slug, x.boardUrl])).toEqual([['teamtailor', 'careers.acme.test', 'https://careers.acme.test/jobs.rss']]);
    const sf = pageSignals('<link href="https://rmkcdn.successfactors.com/84d1/main.css" rel="stylesheet">', 'https://careers.acme.test/');
    expect(sf.ats.map((x) => [x.platform, x.slug, x.boardUrl])).toEqual([['successfactors', 'careers.acme.test', 'https://careers.acme.test/sitemal.xml']]);
  });

  it('an Eightfold script on a /careers?domain= page names the board', () => {
    const s = pageSignals('<script src="https://static.vscdn.net/images/careers/demo/x.js"></script>', 'https://apply.careers.example.test/careers?domain=example.test&hl=en');
    expect(s.ats.map((x) => [x.platform, x.slug])).toEqual([['eightfold', 'apply.careers.example.test/example.test']]);
  });

  it('an Eightfold custom domain without ?domain= names the board from its embedded configuration', () => {
    const html = `<script src="https://static.vscdn.net/x.js"></script><code id="pcsx-data" style="display:none;">{&#34;domain&#34;: &#34;Example.test&#34;, &#34;x&#34;: 1}</code>`;
    expect(eightfoldConfigDomain(html)).toBe('example.test');
    expect(pageSignals(html, 'https://explore.jobs.example.test/careers').ats.map((x) => [x.platform, x.slug])).toEqual([['eightfold', 'explore.jobs.example.test/example.test']]);
    expect(eightfoldConfigDomain('<code id="pcsx-data">{&#34;domain&#34;: </code>')).toBeNull();
    expect(pageSignals('<script src="https://static.vscdn.net/x.js"></script>', 'https://explore.jobs.example.test/careers').ats.map((x) => [x.platform, x.slug])).toEqual([['eightfold', null]]);
  });

  it('is linear on pathological input and stops at the scan cap', () => {
    const t0 = performance.now();
    pageSignals('<a href="x" '.repeat(100_000) + '<script>'.repeat(50_000) + 'https://'.repeat(50_000), 'https://www.acme.test/');
    expect(performance.now() - t0).toBeLessThan(2000);
    const late = 'x'.repeat(MAX_SCAN_CHARS) + '<a href="https://jobs.lever.co/acme">Jobs</a>';
    expect(pageSignals(late, 'https://www.acme.test/').ats).toEqual([]);
  });

  it('isSoft404 and jobsLink are linear on 1 MB adversarial input (< 100 ms each)', () => {
    const MB = 1 << 20;
    const rep = (x: string): string => x.repeat(Math.ceil(MB / x.length)).slice(0, MB);
    const time = (f: () => unknown): number => {
      const t0 = performance.now();
      f();
      return performance.now() - t0;
    };
    expect(time(() => isSoft404(`<title>${rep('<')}</title>`))).toBeLessThan(100);
    expect(time(() => isSoft404(`<title>${rep('<a ')}</title>`))).toBeLessThan(100);
    expect(time(() => jobsLink(rep(`<a href="/x">${'<'.repeat(2000)}</a>`), 'https://acme.test/careers'))).toBeLessThan(100);
    expect(time(() => jobsLink(rep('<a href="'), 'https://acme.test/careers'))).toBeLessThan(100);
    expect(isSoft404(`<title>${'<'.repeat(5000)} Page not found</title>`)).toBe(false); // only the first 1000 characters are read
  });

  it('soft-404: a 200 page whose title says the page is not there', () => {
    expect(isSoft404('<title>Page Not Found | Acme</title>')).toBe(true);
    expect(isSoft404('<title>404</title>')).toBe(true);
    expect(isSoft404('<title>Careers at Acme</title>')).toBe(false);
  });

  it('jobsLink: the first same-domain jobs/openings/positions link, in document order', () => {
    const html = `<a href="https://other.example/jobs">Jobs</a><a href="mailto:jobs@acme.test">Jobs</a><a href="#jobs">Jobs</a>
      <a href="/life">Life at Acme</a><a href="https://careers.acme.test/open-positions">See open positions</a><a href="/jobs">Jobs</a>`;
    expect(jobsLink(html, 'https://www.acme.test/careers')).toBe('https://careers.acme.test/open-positions');
    expect(jobsLink('<a href="/careers">Careers</a>', 'https://www.acme.test/careers')).toBeNull();
    // the same page with another query (seen live: a sign-up CTA link back to the jobs page) is not a second page
    expect(jobsLink('<a href="/careers/jobs?cta=nav">Jobs</a><a href="/careers/jobs/all">All jobs</a>', 'https://www.acme.test/careers/jobs')).toBe('https://www.acme.test/careers/jobs/all');
  });
});

describe('platform detector: decisions', () => {
  it('a careers page linking to its ATS: the platform, slug and boardUrl, with evidence', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const net = serve({ 'https://www.acme.test/careers': page('<a href="https://jobs.lever.co/acme/1">Engineer</a>') });
    const g = await detect(s, net.fetch);
    expect(g).toMatchObject({ platform: 'lever', slug: 'acme', boardUrl: 'https://api.lever.co/v0/postings/acme', routedFrom: null, signature: 'lever:a' });
    expect(g.evidence[0]).toBe('detected: lever acme');
    expect(net.calls).toEqual(['https://www.acme.test/robots.txt', 'https://www.acme.test/careers']);
  });

  it('a back-end ATS beats JobPosting JSON-LD (jsonld-sitemap is front-end when any ATS is present)', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const html = page('<script type="application/ld+json">{"@type":"JobPosting"}</script><a href="https://acme.recruitee.com/o/x">Apply</a>');
    const g = await detect(s, serve({ 'https://www.acme.test/careers': html }).fetch);
    expect(g).toMatchObject({ platform: 'recruitee', slug: 'acme', routedFrom: 'jsonld' });
  });

  it('JobPosting JSON-LD alone: jsonld-sitemap on the careers host', async () => {
    const s = site('acme.test', 'https://careers.acme.test/jobs/1');
    const g = await detect(s, serve({ 'https://careers.acme.test/jobs/1': page('<script type="application/ld+json">{"@type":"JobPosting"}</script>') }).fetch);
    expect(g).toMatchObject({ platform: 'jsonld-sitemap', slug: 'careers.acme.test', boardUrl: 'https://careers.acme.test/sitemap.xml', routedFrom: null });
  });

  it('Phenom routes to the ATS of its apply links (routedFrom phenom)', async () => {
    const s = site('mc.test', 'https://careers.mc.test/us/en/search-results');
    const html = page(`<link href="https://cdn.phenompeople.com/CareerConnectResources/MC/x.css" rel="stylesheet">
      <script>phApp.ddo = {"applyUrl":"https://mc.wd1.myworkdayjobs.com/CorporateCareers/job/Pune/X_R-1/apply"};</script>`);
    const g = await detect(s, serve({ 'https://careers.mc.test/us/en/search-results': html }).fetch);
    expect(g).toMatchObject({ platform: 'workday', slug: 'mc/CorporateCareers', routedFrom: 'phenom', boardUrl: 'https://mc.wd1.myworkdayjobs.com/wday/cxs/mc/CorporateCareers/jobs' });
  });

  it('Phenom with no apply link to an ATS: null, front-end only', async () => {
    const s = site('mc.test', 'https://careers.mc.test/');
    const g = await detect(s, serve({ 'https://careers.mc.test/': page('<script src="https://cdn.phenompeople.com/x.js"></script>') }).fetch);
    expect(g.platform).toBeNull();
    expect(verdict(g)).toBe('front-end-only');
  });

  it('the Okta rule: JobPosting JSON-LD plus a Greenhouse apply link on a company page -> greenhouse, routedFrom jsonld', async () => {
    const s = site('okta.test', 'https://www.okta.test/company/careers/opportunity/123?gh_jid=123');
    const html = page(`<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Engineer"}</script>
      <a href="https://boards.greenhouse.io/okta/jobs/123?gh_jid=123">Apply</a>`);
    const g = await detect(s, serve({ 'https://www.okta.test/company/careers/opportunity/123?gh_jid=123': html }).fetch);
    expect(g).toMatchObject({ platform: 'greenhouse', slug: 'okta', routedFrom: 'jsonld', boardUrl: 'https://boards-api.greenhouse.io/v1/boards/okta/jobs' });
  });

  it('JobPosting plus gh_jid but no board slug anywhere: null, no board slug', async () => {
    const s = site('okta.test', 'https://www.okta.test/company/careers/opportunity/123?gh_jid=123');
    const html = page('<script type="application/ld+json">{"@type":"JobPosting"}</script><a href="/company/careers/opportunity/9?gh_jid=9">Next</a>');
    const g = await detect(s, serve({ 'https://www.okta.test/company/careers/opportunity/123?gh_jid=123': html }).fetch);
    expect(g.platform).toBeNull();
    expect(verdict(g)).toBe('no-board-slug');
    expect(g.evidence.join(' ')).toMatch(/greenhouse/);
  });

  it('two different ATS platforms: null, both in the evidence', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const html = page('<a href="https://boards.greenhouse.io/acme">US jobs</a><a href="https://jobs.lever.co/acme-eu">EU jobs</a>');
    const g = await detect(s, serve({ 'https://www.acme.test/careers': html }).fetch);
    expect(g).toMatchObject({ platform: null, slug: null, boardUrl: null, signature: null });
    expect(g.evidence[0]).toBe('several-platforms: greenhouse, lever');
    expect(g.evidence.join('\n')).toMatch(/greenhouse acme/);
    expect(g.evidence.join('\n')).toMatch(/lever acme-eu/);
  });

  it('the same ATS with two slugs: null, both slugs in the evidence', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const html = page('<a href="https://boards.greenhouse.io/acme">US</a><a href="https://boards.greenhouse.io/acmeindia">India</a>');
    const g = await detect(s, serve({ 'https://www.acme.test/careers': html }).fetch);
    expect(g.platform).toBeNull();
    expect(g.evidence[0]).toBe('several-boards: greenhouse acme, acmeindia');
  });

  it('the same board in two letter cases on a case-sensitive platform is one board (first-seen case kept)', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const html = page('<a href="https://jobs.smartrecruiters.com/AcmeCo/1">x</a><a href="https://jobs.smartrecruiters.com/acmeco/2">y</a>');
    expect(await detect(s, serve({ 'https://www.acme.test/careers': html }).fetch)).toMatchObject({ platform: 'smartrecruiters', slug: 'AcmeCo' });
  });

  it('Phenom is removed before counting back-ends (Phenom + one ATS is not two)', async () => {
    const s = site('mc.test', 'https://careers.mc.test/');
    const html = page('<script src="https://cdn.phenompeople.com/x.js"></script><a href="https://jobs.smartrecruiters.com/McCo/1">Apply</a>');
    expect(await detect(s, serve({ 'https://careers.mc.test/': html }).fetch)).toMatchObject({ platform: 'smartrecruiters', slug: 'McCo', routedFrom: 'phenom' });
  });

  it('no signature: null with the reason', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const g = await detect(s, serve({ 'https://www.acme.test/careers': page('<a href="/about">About</a>') }).fetch);
    expect(g).toMatchObject({ platform: null, routedFrom: null });
    expect(verdict(g)).toBe('no-signature');
  });

  it('a slugless signal alone is not a platform', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const g = await detect(s, serve({ 'https://www.acme.test/careers': page('<a href="https://apply.workable.com/">Apply</a>') }).fetch);
    expect(g.platform).toBeNull();
    expect(g.evidence[0]).toBe('no-board-slug: workable');
  });

  it('a soft-404: null, nothing detected from the page', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const g = await detect(s, serve({ 'https://www.acme.test/careers': page('<a href="https://jobs.lever.co/acme">x</a>', 'Page not found') }).fetch);
    expect(g.platform).toBeNull();
    expect(verdict(g)).toBe('soft-404');
  });

  it('a page that will not load (404): null with the status', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const g = await detect(s, serve({}).fetch);
    expect(g.platform).toBeNull();
    expect(g.evidence[0]).toBe('unavailable: 404');
  });

  it('method none: no careers URL, nothing fetched', async () => {
    const net = serve({});
    const g = await detect(site('acme.test', null), net.fetch);
    expect(g).toMatchObject({ platform: null, evidence: ['no-careers-url'] });
    expect(net.calls).toEqual([]);
  });
});

describe('platform detector: URL signatures and redirects', () => {
  it('a JavaScript-only page on a platform host: detected from the URL', async () => {
    const s = site('acme.test', 'https://careers-acme.icims.com/jobs/intro', { method: 'listed', evidence: 'listed careersUrl redirected (target unfetched)' });
    const g = await detect(s, serve({ 'https://careers-acme.icims.com/jobs/intro': page('<div id="root"></div>') }).fetch);
    expect(g).toMatchObject({ platform: 'icims', slug: 'careers-acme.icims.com', signature: 'icims:url' });
  });

  it('a redirect to a platform host is detected from its Location, unfetched', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const net = serve({ 'https://www.acme.test/careers': { status: 302, location: 'https://acme.wd5.myworkdayjobs.com/External' } });
    const g = await detect(s, net.fetch);
    expect(g).toMatchObject({ platform: 'workday', slug: 'acme/External' });
    expect(g.evidence.join(' ')).toMatch(/unfetched/);
    expect(net.calls.some((u) => u.includes('myworkdayjobs'))).toBe(false);
  });

  it('a URL signature on a page that will not load is evidence, not a platform', async () => {
    const s = site('acme.test', 'https://jobs.lever.co/acme');
    const g = await detect(s, serve({ 'https://jobs.lever.co/acme': { status: 404 } }).fetch);
    expect(g.platform).toBeNull();
    expect(g.evidence.join('\n')).toMatch(/lever acme via url/);
  });

  it('a board URL redirected to a page of the same platform that names no board (its error page): null, unavailable', async () => {
    const s = site('acme.test', 'https://apply.workable.com/no-such-acme/');
    const g = await detect(s, serve({ 'https://apply.workable.com/no-such-acme/': { status: 302, location: '/oops' }, 'https://apply.workable.com/oops': page('<div id="app"></div>') }).fetch);
    expect(g.platform).toBeNull();
    expect(g.evidence[0]).toBe('unavailable: board redirected to https://apply.workable.com/oops');
  });

  it('a URL signature that disagrees with the page HTML: two platforms, null', async () => {
    const s = site('acme.test', 'https://jobs.lever.co/acme');
    const g = await detect(s, serve({ 'https://jobs.lever.co/acme': page('<a href="https://boards.greenhouse.io/acme">Old board</a>') }).fetch);
    expect(g.platform).toBeNull();
    expect(verdict(g)).toBe('several-platforms');
  });
});

describe('platform detector: the second GET', () => {
  it('no back-end signature on the careers page: follows the first same-domain jobs link, once', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const net = serve({
      'https://www.acme.test/careers': page('<a href="/about">About</a><a href="/careers/open-positions">Open positions</a><a href="/careers/jobs">Jobs</a>'),
      'https://www.acme.test/careers/open-positions': page('<a href="/careers/jobs/all">All jobs</a>'),
      'https://www.acme.test/careers/jobs': page('<a href="https://jobs.lever.co/acme">x</a>'),
    });
    const g = await detect(s, net.fetch);
    expect(g.platform).toBeNull();
    expect(net.calls.filter((u) => !u.endsWith('/robots.txt'))).toEqual(['https://www.acme.test/careers', 'https://www.acme.test/careers/open-positions']);
  });

  it('the second page can carry the signature', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const net = serve({
      'https://www.acme.test/careers': page('<a href="https://careers.acme.test/jobs">See jobs</a>'),
      'https://careers.acme.test/jobs': page('<iframe src="https://boards.greenhouse.io/embed/job_board?for=acme"></iframe>'),
    });
    const g = await detect(s, net.fetch);
    expect(g).toMatchObject({ platform: 'greenhouse', slug: 'acme', signature: 'greenhouse:iframe' });
    expect(g.evidence.join('\n')).toMatch(/second page https:\/\/careers\.acme\.test\/jobs/);
  });

  it('no second GET when the careers page already names an ATS', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const net = serve({ 'https://www.acme.test/careers': page('<a href="https://jobs.ashbyhq.com/acme">Jobs</a><a href="/jobs">Jobs</a>') });
    await detect(s, net.fetch);
    expect(net.calls.filter((u) => !u.endsWith('/robots.txt'))).toEqual(['https://www.acme.test/careers']);
  });

  it('a jobs link on another registrable domain is not followed', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const net = serve({ 'https://www.acme.test/careers': page('<a href="https://www.jobboard.example/acme/jobs">Jobs</a>') });
    const g = await detect(s, net.fetch);
    expect(verdict(g)).toBe('no-signature');
    expect(net.calls.filter((u) => !u.endsWith('/robots.txt'))).toEqual(['https://www.acme.test/careers']);
  });
});

describe('platform detector: the shared run gate', () => {
  it('robots.txt disallowing the careers page: not fetched, null with the reason', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const net = serve({ 'https://www.acme.test/robots.txt': 'User-agent: *\nDisallow: /careers\n', 'https://www.acme.test/careers': page('<a href="https://jobs.lever.co/acme">x</a>') });
    const g = await detect(s, net.fetch);
    expect(g.platform).toBeNull();
    expect(g.evidence[0]).toBe('unavailable: robots-disallow /careers (www.acme.test)');
    expect(net.calls).toEqual(['https://www.acme.test/robots.txt']);
  });

  it('a challenge page disables the host (persisted before the step returns): null, refused', async () => {
    const app = AppStore.on(Store.open(':memory:'));
    const gate = makeRunGate({ runKey: 'run-1', store: app });
    const s = site('acme.test', 'https://www.acme.test/careers');
    const g = await detect(s, serve({ 'https://www.acme.test/careers': { status: 403, body: '<title>Just a moment...</title>' } }).fetch, makePlatformDetector({ gate }));
    expect(g.platform).toBeNull();
    expect(g.evidence[0]).toBe('refused: challenge (403) on www.acme.test');
    expect([...app.coverageHostState('run-1')]).toEqual([['www.acme.test', 'challenge']]);
  });

  it('a host disabled by the locator of the same run defers the detector step: input_rejected host-disabled, nothing fetched', async () => {
    const app = AppStore.on(Store.open(':memory:'));
    const gate = makeRunGate({ runKey: 'run-1', store: app });
    const locator = makeCareersLocator({ gate });
    const other = cand('beta.test', { careersUrl: 'https://boards.greenhouse.io/beta' });
    const net = serve({ 'https://boards.greenhouse.io/beta': { status: 429, body: 'slow down' } });
    const locCtx = issueContext({
      contract: careersLocatorContract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: net.fetch },
      clock: fixedClock('2026-10-13T00:00:00Z'), signal: new AbortController().signal, egressSets: locatorEgressSets([other]),
    });
    await locator.run(other, locCtx);
    expect(gate.state.disabled.get('boards.greenhouse.io')).toBe('http-429');

    const s = site('acme.test', 'https://boards.greenhouse.io/acme');
    const before = net.calls.length;
    await expect(detect(s, net.fetch, makePlatformDetector({ gate }))).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringContaining('host-disabled:http-429') });
    expect(net.calls.slice(before)).toEqual([]);
  });

  it('one robots.txt fetch per host per run, across the locator and the detector', async () => {
    const gate = makeRunGate(fresh());
    const c = cand('acme.test');
    const net = serve({ 'https://www.acme.test/': page('<a href="/careers">Careers</a>'), 'https://www.acme.test/careers': page('<a href="https://jobs.lever.co/acme">x</a>') });
    const locCtx = issueContext({
      contract: careersLocatorContract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: net.fetch },
      clock: fixedClock('2026-10-13T00:00:00Z'), signal: new AbortController().signal, egressSets: locatorEgressSets([c]),
    });
    const [found] = await makeCareersLocator({ gate }).run(c, locCtx);
    const g = await detect(CareersSite.schema.parse(found), net.fetch, makePlatformDetector({ gate }));
    expect(g.platform).toBe('lever');
    expect(net.calls.filter((u) => u === 'https://www.acme.test/robots.txt')).toHaveLength(1);
  });

  it('is deterministic', async () => {
    const s = site('acme.test', 'https://www.acme.test/careers');
    const mk = () => serve({ 'https://www.acme.test/careers': page('<a href="https://jobs.lever.co/acme">x</a><a href="https://boards.greenhouse.io/acme">y</a>') });
    expect(await detect(s, mk().fetch)).toEqual(await detect(s, mk().fetch));
  });
});

describe('platform detector: contract and egress', () => {
  it('declares coverage:candidate-hosts; its hosts are the careers URL host plus the candidate site hosts', () => {
    expect(platformDetectorContract).toMatchObject({ id: 'platform-detector', kind: 'io', egress: ['coverage:candidate-hosts'] });
    expect(platformDetectorContract.description).not.toMatch(/\band\b/i);
    expect(detectorHosts(site('acme.test', 'https://acme.wd5.myworkdayjobs.com/External'))).toEqual([
      'acme.test', 'acme.wd5.myworkdayjobs.com', 'careers.acme.test', 'jobs.acme.test', 'www.acme.test',
    ]);
    expect(Object.keys(detectorEgressSets([site('acme.test', null)]))).toEqual(['coverage:candidate-hosts']);
  });

  it('the allow-list admits the detector to the candidate egress', () => {
    expect(CAPABILITY_ALLOW_LIST.candidateEgress).toEqual(['careers-locator', 'platform-detector', 'board-verifier']);
    expect(capabilityProblems([platformDetectorContract, careersLocatorContract])).toEqual([]);
  });
});

describe('the coverage-detector golden set', () => {
  const root = new URL('../../../', import.meta.url).pathname;
  const lines = readFileSync(`${root}evals/datasets/coverage-detector.jsonl`, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const cases = lines.map((l) => JSON.parse(l) as { id: string; note: string; input: CareersSite; expected: { platform: string | null; slug: string | null; routedFrom: string | null; verdict: string } });
  const index = JSON.parse(readFileSync(`${root}evals/datasets/coverage-detector/index.json`, 'utf8')) as Record<string, unknown>;

  it('has at least 40 recorded, hand-labelled careers pages, every input a valid CareersSite', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    for (const c of cases) {
      expect(CareersSite.schema.parse(c.input)).toEqual(c.input);
      expect(c.note.length).toBeGreaterThan(10);
    }
  });

  it('covers the named companies, every platform and the negatives', () => {
    const by = (id: string) => cases.find((c) => c.id === id)?.expected;
    expect(by('mastercard-phenom')).toMatchObject({ platform: 'workday', routedFrom: 'phenom' });
    expect(by('microsoft-eightfold')).toMatchObject({ platform: 'eightfold' });
    expect(by('jpmorgan-careers')).toMatchObject({ platform: 'oracle' });
    expect(by('atlassian-icims')).toMatchObject({ platform: 'icims' });
    expect(by('hcltech-careers')).toMatchObject({ platform: 'successfactors' });
    expect(by('asana-job')).toMatchObject({ platform: 'greenhouse', routedFrom: 'jsonld' });
    expect(by('okta-job')).toBeDefined();
    const platforms = new Set(cases.map((c) => c.expected.platform));
    for (const p of Platform.options) expect(platforms.has(p), p).toBe(true);
    const verdicts = new Set(cases.map((c) => c.expected.verdict));
    // several-boards has no real recorded page (the one candidate was Workable's /oops error page); it is unit-tested above
    for (const v of ['no-signature', 'several-platforms', 'no-board-slug', 'refused', 'unavailable', 'unfetched']) expect(verdicts.has(v), v).toBe(true);
  });

  it('serves only recorded responses: every fixture file named in the index exists', () => {
    for (const v of Object.values(index)) {
      const file = typeof v === 'string' ? v : (v as { file?: string }).file;
      if (file !== undefined) expect(() => readFileSync(`${root}evals/datasets/coverage-detector/${file}`), file).not.toThrow();
    }
  });

  it('privacy: no e-mail address, mailto:/tel: link, JSON-LD Person, social or people profile URL, cookie or session token in any fixture', () => {
    const PRIVATE: readonly [string, RegExp][] = [
      ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
      ['mailto-tel', /\b(?:mailto|tel):/gi],
      ['jsonld-person', /"@type"\s*:\s*(?:\[[^\]]*)?"Person"/g],
      ['social-profile', /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com|facebook\.com|instagram\.com|github\.com|threads\.net|bsky\.app)\/[A-Za-z0-9_.-]+|linkedin\.com\/in\//gi],
      ['people-page', /\/(?:team|people|authors?|community\/profiles)\/[A-Za-z0-9_-]+/gi],
      ['cookie-session', /set-cookie|__cf_chl_tk|cf_clearance|jsessionid=|phpsessid/gi],
    ];
    const dir = `${root}evals/datasets/coverage-detector`;
    // file and offset only: a match is never printed, so a failure cannot leak what it found
    const hits: string[] = [];
    for (const file of readdirSync(dir)) {
      const text = readFileSync(`${dir}/${file}`, 'utf8');
      for (const [kind, re] of PRIVATE) for (const m of text.matchAll(re)) hits.push(`${kind} in ${file} at offset ${m.index}`);
    }
    expect(hits).toEqual([]);
  });

  it('is registered as the coverage-detector eval and passes at 1.000', async () => {
    const spec = appEvalSpecs(`${root}evals/datasets`, `${root}tests/fixtures/pack`).find((s) => s.name === 'coverage-detector');
    expect(spec?.agent.contract).toBe(platformDetectorContract);
    const report = await runEval(spec!, { providers: {} as never, policy: PRODUCT_POLICY_V1 });
    expect(report.failures).toEqual([]);
    expect(report.score).toBe(1);
    expect(report.n).toBeGreaterThanOrEqual(40);
  });
});
