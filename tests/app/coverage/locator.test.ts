import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  makeCareersLocator,
  careersLocatorContract,
  findCareersLink,
  isChallenge,
  locatorEgressSets,
  locatorHosts,
  sitemapLocs,
} from '../../../src/app/coverage/locator.js';
import { CareersSite, CompanyCandidate } from '../../../src/app/coverage/types.js';
import { offlineProviders } from '../../../src/app/offline.js';
import { issueContext } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import type { FetchLike } from '../../../src/kernel/providers.js';
import { memoryHostStateStore } from '../../../src/app/coverage/gate.js';

/** A fresh run gate's source: its own key on an explicit memory store. */
const fresh = () => ({ runKey: 'test', store: memoryHostStateStore() });

const FIX = new URL('../../fixtures/coverage/locator/', import.meta.url);
const file = (name: string): string => readFileSync(new URL(name, FIX), 'utf8');
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

async function locate(c: CompanyCandidate, fetch: FetchLike, agent = makeCareersLocator(fresh()), egressFor: readonly CompanyCandidate[] = [c]): Promise<CareersSite> {
  const ctx = issueContext({
    contract: careersLocatorContract,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: { fetch },
    clock: fixedClock('2026-10-13T00:00:00Z'),
    signal: new AbortController().signal,
    egressSets: locatorEgressSets(egressFor),
  });
  const out = await agent.run(c, ctx);
  expect(out).toHaveLength(1);
  expect(ctx.denials()).toEqual([]);
  return CareersSite.schema.parse(out[0]);
}

describe('careers locator: the six recorded sites', () => {
  it('Drupal site: the homepage nav link (relative) wins', async () => {
    const c = cand('northgate-identity.test');
    const s = serve({ 'https://www.northgate-identity.test/': file('drupal-home.html') });
    const site = await locate(c, s.fetch);
    expect(site.method).toBe('homepage-link');
    expect(site.careersUrl).toBe('https://www.northgate-identity.test/company/careers/');
    expect(s.calls).toEqual(['https://www.northgate-identity.test/robots.txt', 'https://www.northgate-identity.test/']);
  });

  it('homepage linking to myworkdayjobs: the platform host is accepted, the LinkedIn jobs link is not', async () => {
    const c = cand('harborpoint.test');
    const s = serve({ 'https://www.harborpoint.test/': file('workday-home.html') });
    const site = await locate(c, s.fetch);
    expect(site.method).toBe('homepage-link');
    expect(site.careersUrl).toBe('https://harborpoint.wd5.myworkdayjobs.com/en-US/Harborpoint_Careers');
    expect(s.calls.some((u) => u.includes('myworkdayjobs'))).toBe(false);
  });

  it('a /careers path site (served through the offline provider; robots.txt is a 404)', async () => {
    const off = offlineProviders(new URL('./', FIX).pathname);
    const site = await locate(cand('quillworks.test'), off.fetch);
    expect(site.method).toBe('path');
    expect(site.careersUrl).toBe('https://www.quillworks.test/careers');
    expect(off.fetch.calls).toEqual(['https://www.quillworks.test/robots.txt', 'https://www.quillworks.test/', 'https://www.quillworks.test/careers']);
  });

  it('a careers. subdomain site, after the four paths miss', async () => {
    const c = cand('tidewater.test');
    const s = serve({ 'https://www.tidewater.test/': file('plain-home.html'), 'https://careers.tidewater.test/': file('careers-page.html') });
    const site = await locate(c, s.fetch);
    expect(site.method).toBe('subdomain');
    expect(site.careersUrl).toBe('https://careers.tidewater.test/');
    expect(site.reasons).toContain('homepage: no careers link');
    expect(site.reasons).toContain('/about/careers: 404');
  });

  it('a sitemap-only site, the sitemap named in robots.txt included in the plan', async () => {
    const c = cand('lumenfield.test');
    const s = serve({
      'https://www.lumenfield.test/robots.txt': file('robots-open.txt'),
      'https://www.lumenfield.test/': file('plain-home.html'),
      'https://www.lumenfield.test/sitemap.xml': file('sitemap.xml'),
    });
    const site = await locate(c, s.fetch);
    expect(site.method).toBe('sitemap');
    expect(site.careersUrl).toBe('https://www.lumenfield.test/en/jobs/');
    expect(s.calls.filter((u) => u.endsWith('/robots.txt'))).toEqual(['https://www.lumenfield.test/robots.txt', 'https://careers.lumenfield.test/robots.txt', 'https://jobs.lumenfield.test/robots.txt']);
  });

  it('a challenge page on the homepage: none, reason challenge, nothing further asked of that host', async () => {
    const c = cand('fortress.test');
    const s = serve({ 'https://www.fortress.test/': { status: 403, body: file('challenge.html') } });
    const site = await locate(c, s.fetch);
    expect(site).toMatchObject({ method: 'none', careersUrl: null });
    expect(site.reasons?.join(' ')).toMatch(/challenge/);
    expect(s.calls).toEqual(['https://www.fortress.test/robots.txt', 'https://www.fortress.test/']);
  });
});

describe('careers locator: rules', () => {
  it('probe 1: a listed careersUrl that answers 2xx is used first', async () => {
    const c = cand('acme.test', { careersUrl: 'https://acme.test/join' });
    const s = serve({ 'https://acme.test/join': file('careers-page.html') });
    const site = await locate(c, s.fetch);
    expect(site).toMatchObject({ method: 'listed', careersUrl: 'https://acme.test/join' });
    expect(s.calls).toEqual(['https://acme.test/robots.txt', 'https://acme.test/join']);
  });

  it('a listed URL that fails falls through to the homepage, with a reason', async () => {
    const c = cand('acme.test', { careersUrl: 'https://acme.test/gone' });
    const s = serve({ 'https://www.acme.test/': file('drupal-home.html') });
    const site = await locate(c, s.fetch);
    expect(site.method).toBe('homepage-link');
    expect(site.reasons?.[0]).toMatch(/^listed: 404/);
  });

  it('a 4xx on the homepage is none with the status as the reason, and no path is tried', async () => {
    const s = serve({ 'https://www.acme.test/': { status: 404 }, 'https://www.acme.test/careers': 'x' });
    const site = await locate(cand('acme.test'), s.fetch);
    expect(site).toMatchObject({ method: 'none', reasons: ['homepage: 404'] });
    expect(s.calls).not.toContain('https://www.acme.test/careers');
  });

  it('robots.txt: a disallowed path is not fetched, the next probe runs', async () => {
    const s = serve({
      'https://www.acme.test/robots.txt': file('robots-closed.txt'),
      'https://www.acme.test/': file('plain-home.html'),
      'https://www.acme.test/jobs': 'jobs',
    });
    const site = await locate(cand('acme.test'), s.fetch);
    expect(site).toMatchObject({ method: 'path', careersUrl: 'https://www.acme.test/jobs' });
    expect(s.calls).not.toContain('https://www.acme.test/careers');
    expect(site.reasons).toContain('/careers: robots-disallow /careers (www.acme.test)');
  });

  it('robots.txt 5xx disallows the host for the run: none with robots-unavailable', async () => {
    const s = serve({ 'https://www.acme.test/robots.txt': { status: 503, body: 'down' }, 'https://www.acme.test/': file('drupal-home.html') });
    const site = await locate(cand('acme.test'), s.fetch);
    expect(site.method).toBe('none');
    expect(site.reasons?.join(' ')).toMatch(/robots-unavailable/);
    expect(s.calls).not.toContain('https://www.acme.test/');
  });

  it('a 429 is a stop for the host and never retried', async () => {
    const s = serve({ 'https://www.acme.test/': { status: 429, body: 'slow down' } });
    const site = await locate(cand('acme.test'), s.fetch);
    expect(site.method).toBe('none');
    expect(site.reasons?.join(' ')).toMatch(/rate-limited/);
    expect(s.calls.filter((u) => u === 'https://www.acme.test/')).toHaveLength(1);
  });

  it('follows a redirect within the company domain (apex to www), fetching the target', async () => {
    const c = cand('acme.test', { website: 'https://acme.test' });
    const s = serve({ 'https://acme.test/': { status: 301, location: 'https://www.acme.test/' }, 'https://www.acme.test/': file('drupal-home.html') });
    const site = await locate(c, s.fetch);
    expect(site).toMatchObject({ method: 'homepage-link', careersUrl: 'https://www.acme.test/company/careers/' });
  });

  it('a /careers redirect to a platform host is a hit on the Location, unfetched', async () => {
    const s = serve({
      'https://www.acme.test/': file('plain-home.html'),
      'https://www.acme.test/careers': { status: 302, location: 'https://boards.greenhouse.io/acme' },
    });
    const site = await locate(cand('acme.test'), s.fetch);
    expect(site).toMatchObject({ method: 'path', careersUrl: 'https://boards.greenhouse.io/acme' });
    expect(s.calls.some((u) => u.includes('greenhouse'))).toBe(false);
  });

  it('a redirect off the domain is a miss with a reason; the next probe runs', async () => {
    const s = serve({
      'https://www.acme.test/': file('plain-home.html'),
      'https://www.acme.test/careers': { status: 302, location: 'https://evil.example/x' },
      'https://www.acme.test/jobs': 'ok',
    });
    const site = await locate(cand('acme.test'), s.fetch);
    expect(site).toMatchObject({ method: 'path', careersUrl: 'https://www.acme.test/jobs' });
    expect(site.reasons?.join(' ')).toMatch(/off-domain/);
  });

  it('stops after 5 redirect hops', async () => {
    const routes: Record<string, Route | string> = { 'https://www.acme.test/': file('plain-home.html') };
    for (let i = 0; i < 8; i++) routes[`https://www.acme.test/${i === 0 ? 'careers' : `h${i}`}`] = { status: 302, location: `https://www.acme.test/h${i + 1}` };
    const s = serve(routes);
    const site = await locate(cand('acme.test'), s.fetch);
    expect(site.reasons?.join(' ')).toMatch(/more than 5 redirects/);
    expect(s.calls.filter((u) => /\/h\d$/.test(u))).toHaveLength(5);
  });

  it('nothing found: none, careersUrl null, reasons for every probe', async () => {
    const s = serve({ 'https://www.acme.test/': file('plain-home.html') });
    const site = await locate(cand('acme.test'), s.fetch);
    expect(site).toMatchObject({ method: 'none', careersUrl: null, evidence: null });
    expect(site.reasons?.length).toBeGreaterThanOrEqual(8);
  });

  it('is deterministic', async () => {
    const mk = () => serve({ 'https://www.acme.test/': file('plain-home.html'), 'https://jobs.acme.test/': 'x' });
    expect(await locate(cand('acme.test'), mk().fetch)).toEqual(await locate(cand('acme.test'), mk().fetch));
  });

  it('never asks a host outside its plan (no egress denial): http and port websites are handled', async () => {
    const s = serve({});
    const site = await locate(cand('acme.test', { website: 'https://www.acme.test:8443' }), s.fetch);
    expect(site.method).toBe('none');
    expect(s.calls).toEqual([]);
  });
});

describe('locator: run-scoped host state, status handling, budget (fix round 1)', () => {
  const gh = (slug: string): CompanyCandidate => cand(`${slug}.test`, { website: `https://www.${slug}.test`, careersUrl: `https://boards.greenhouse.io/${slug}` });
  const hostsOf = (...cs: CompanyCandidate[]) => cs;

  it('one robots.txt fetch per host per run, across candidates', async () => {
    const a = gh('alpha');
    const b = gh('beta');
    const agent = makeCareersLocator(fresh());
    const s = serve({ 'https://boards.greenhouse.io/alpha': 'x', 'https://boards.greenhouse.io/beta': 'x' });
    await locate(a, s.fetch, agent, hostsOf(a, b));
    await locate(b, s.fetch, agent, hostsOf(a, b));
    expect(s.calls.filter((u) => u === 'https://boards.greenhouse.io/robots.txt')).toHaveLength(1);
  });

  it('a host disabled by one candidate (429) is skipped by the next, with host-disabled:<why>', async () => {
    const a = gh('alpha');
    const b = gh('beta');
    const agent = makeCareersLocator(fresh());
    const s = serve({ 'https://boards.greenhouse.io/alpha': { status: 429, body: 'slow' }, 'https://www.beta.test/': file('plain-home.html') });
    await locate(a, s.fetch, agent, hostsOf(a, b));
    const before = s.calls.length;
    // B's outcome depends on A's (the sibling's) state, so it is a refused step (input_rejected), never a stored result.
    await expect(locate(b, s.fetch, agent, hostsOf(a, b))).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringContaining('listed: host-disabled:http-429') });
    expect(s.calls.slice(before).filter((u) => u.includes('boards.greenhouse.io'))).toEqual([]);
  });

  it('a plain 403 on a path disables that host (named http-403) but the careers. subdomain is still probed', async () => {
    const s = serve({ 'https://www.acme.test/': file('plain-home.html'), 'https://www.acme.test/careers': { status: 403, body: 'Forbidden' }, 'https://careers.acme.test/': 'ok' });
    const site = await locate(cand('acme.test'), s.fetch);
    expect(site).toMatchObject({ method: 'subdomain', careersUrl: 'https://careers.acme.test/' });
    expect(s.calls).not.toContain('https://www.acme.test/jobs');
    expect(site.reasons?.join(' ')).toMatch(/http-403/);
  });

  it('a plain 401 on the listed host disables it', async () => {
    const c = cand('acme.test', { careersUrl: 'https://acme.test/join' });
    const s = serve({ 'https://acme.test/join': { status: 401, body: 'no' } });
    const site = await locate(c, s.fetch);
    expect(site.reasons?.[0]).toMatch(/http-401/);
  });

  it('robots.txt 404 and 410 allow all', async () => {
    for (const status of [404, 410]) {
      const s = serve({ 'https://www.acme.test/robots.txt': { status }, 'https://www.acme.test/': file('drupal-home.html') });
      expect((await locate(cand('acme.test'), s.fetch)).method).toBe('homepage-link');
    }
  });

  it('robots.txt 401/403 is robots-forbidden and disallows the host', async () => {
    for (const status of [401, 403]) {
      const s = serve({ 'https://www.acme.test/robots.txt': { status, body: 'no' }, 'https://www.acme.test/': file('drupal-home.html') });
      const site = await locate(cand('acme.test'), s.fetch);
      expect(site.method).toBe('none');
      expect(site.reasons?.join(' ')).toMatch(/robots-forbidden/);
      expect(s.calls).not.toContain('https://www.acme.test/');
    }
  });

  it('robots.txt 400, 5xx are robots-unavailable; 429 disables the host', async () => {
    for (const status of [400, 500]) {
      const s = serve({ 'https://www.acme.test/robots.txt': { status }, 'https://www.acme.test/': file('drupal-home.html') });
      expect((await locate(cand('acme.test'), s.fetch)).reasons?.join(' ')).toMatch(/robots-unavailable/);
    }
    const s = serve({ 'https://www.acme.test/robots.txt': { status: 429 }, 'https://www.acme.test/': file('drupal-home.html') });
    expect((await locate(cand('acme.test'), s.fetch)).reasons?.join(' ')).toMatch(/http-429/);
    expect(s.calls).not.toContain('https://www.acme.test/');
  });

  it('the contract declares coverage:candidate-hosts', () => {
    expect(careersLocatorContract.egress).toEqual(['coverage:candidate-hosts']);
    expect(Object.keys(locatorEgressSets([cand('acme.test')]))).toEqual(['coverage:candidate-hosts']);
  });

  it('a listed URL that only redirects (to a platform host) is reported as unfetched', async () => {
    const c = cand('acme.test', { careersUrl: 'https://acme.test/join' });
    const s = serve({ 'https://acme.test/join': { status: 302, location: 'https://acme.wd5.myworkdayjobs.com/site' } });
    const site = await locate(c, s.fetch);
    expect(site).toMatchObject({ method: 'listed', careersUrl: 'https://acme.wd5.myworkdayjobs.com/site' });
    expect(site.evidence).toMatch(/unfetched/);
  });

  it('a listed URL redirecting to a vendor marketing root is not a hit', async () => {
    const c = cand('acme.test', { careersUrl: 'https://acme.test/join' });
    const s = serve({ 'https://acme.test/join': { status: 302, location: 'https://www.icims.com/' }, 'https://www.acme.test/': file('plain-home.html') });
    const site = await locate(c, s.fetch);
    expect(site.method).toBe('none');
    expect(site.reasons?.[0]).toMatch(/^listed: redirect to www\.icims\.com/);
  });

  it('a sitemap hit returns the https-normalised URL', async () => {
    const s = serve({ 'https://www.acme.test/': file('plain-home.html'), 'https://www.acme.test/sitemap.xml': '<loc>http://www.acme.test/en/jobs/#top</loc>' });
    const site = await locate(cand('acme.test'), s.fetch);
    expect(site).toMatchObject({ method: 'sitemap', careersUrl: 'https://www.acme.test/en/jobs/' });
  });

  it('over the request budget: none with budget-exhausted, never a throw', async () => {
    const s = serve({ 'https://www.acme.test/': file('plain-home.html') });
    const site = await locate(cand('acme.test'), s.fetch, makeCareersLocator({ ...fresh(), maxRequests: 4 }));
    expect(site).toMatchObject({ method: 'none', careersUrl: null });
    expect(site.reasons).toContain('budget-exhausted');
    expect(s.calls.length).toBeLessThanOrEqual(5);
  });
});

describe('locator helpers', () => {
  it('isChallenge also knows "Just a moment"', () => {
    expect(isChallenge(503, '<title>Just a moment...</title>')).toBe(true);
  });

  it('CAREERS_LINK (as briefed) matches a blog link such as steve-jobs', () => {
    expect(findCareersLink('<a href="/blog/steve-jobs-and-design">Read</a>', 'https://x.test/', () => true)?.url).toBe('https://x.test/blog/steve-jobs-and-design');
  });

  it('isChallenge needs a status in {403,429,503} and a marker', () => {
    expect(isChallenge(403, '<script src="/cdn-cgi/challenge-platform/h/b"></script>')).toBe(true);
    expect(isChallenge(503, '<title>Attention Required</title>')).toBe(true);
    expect(isChallenge(200, 'captcha')).toBe(false);
    expect(isChallenge(403, 'Forbidden')).toBe(false);
  });

  it('findCareersLink: document order, skips non-web schemes, fragments and off-domain', () => {
    const html = `<a href="mailto:jobs@x.test">Jobs</a><a href="#careers">Careers</a><a href="javascript:void(0)">Careers</a>
      <a href="https://other.example/jobs">Jobs</a><a href="/team">Join us</a><a href="/careers">Careers</a>`;
    const f = findCareersLink(html, 'https://x.test/', (u) => u.hostname === 'x.test');
    expect(f?.url).toBe('https://x.test/team');
  });

  it('findCareersLink matches on href alone and decodes &amp;', () => {
    const f = findCareersLink('<a class="b" href="/jobs?a=1&amp;b=2"><img alt=""></a>', 'https://x.test/', () => true);
    expect(f?.url).toBe('https://x.test/jobs?a=1&b=2');
  });

  it('sitemapLocs reads plain and CDATA locs', () => {
    expect(sitemapLocs('<loc> https://a.test/x </loc><loc><![CDATA[https://a.test/y]]></loc>')).toEqual(['https://a.test/x', 'https://a.test/y']);
  });

  it('locatorHosts: website, apex, www, careers., jobs. and the listed host', () => {
    expect(locatorHosts(cand('acme.test', { careersUrl: 'http://boards.greenhouse.io/acme' }))).toEqual([
      'acme.test', 'boards.greenhouse.io', 'careers.acme.test', 'jobs.acme.test', 'www.acme.test',
    ]);
  });
});
