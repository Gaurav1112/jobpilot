import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAREERS_MAX_PAGES,
  CAREERS_RENDER_INTERVAL_MS,
  CAREERS_TEXT_MAX_BYTES,
  careersHosts,
  careersSourceId,
  canonicalJobUrl,
  makeSrcCareers,
} from '../../src/app/agents/sources/careers.js';
import { sha256Hex } from '../../src/app/agents/sources/sha256.js';
import { loadPack } from '../../src/app/pack/load.js';
import type { DiscoveryRequest, RawPosting } from '../../src/app/types.js';
import type { AgentContext } from '../../src/kernel/agent.js';
import { CHALLENGE_PATTERN, freezePack, issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { fakeBrowser } from '../../src/kernel/fakes.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import type { BrowserPage } from '../../src/kernel/providers.js';

const HOST = 'careers.example.com';
const H = `https://${HOST}`;
const LIST = `${H}/jobs`;
const req = (ats: DiscoveryRequest['ats'] = 'careers', slug = 'example-careers'): DiscoveryRequest => ({ ats, slug, company: 'Example Careers Co', runDate: '2026-10-09' });
const entry = (extra: Record<string, unknown> = {}) => ({ company: 'Example Careers Co', ats: 'careers', slug: 'example-careers', listUrl: LIST, hiresInIndia: true, allRemote: false, ...extra });
const packOf = (...watchlist: unknown[]) => freezePack({ watchlist });
type Route = Partial<BrowserPage> & { html: string };
const sha16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function run(routes: Record<string, Route>, opts: { pack?: unknown; maxPages?: number; r?: DiscoveryRequest } = {}) {
  const agent = makeSrcCareers([HOST], opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {});
  const browser = fakeBrowser(routes);
  const ctx = issueContext({
    contract: agent.contract,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: { fetch: async () => ({ status: 404, text: async () => '' }), browser },
    clock: fixedClock('2026-10-09T00:00:00Z'),
    signal: new AbortController().signal,
    pack: opts.pack ?? packOf(entry()),
  });
  return { browser, out: agent.run(opts.r ?? req(), ctx) };
}

const a = (href: string, text = 'A role', attrs = '') => `<a href="${href}"${attrs}>${text}</a>`;
const listing = (...links: string[]) => `<html><body><nav>${a('/about', 'About')}${a('/jobs', 'Jobs')}</nav><main>${links.join('\n')}</main></body></html>`;
const plainJob = (title: string) => ({ html: `<html><body><main><h1 class="t">${title}</h1><p>Role text</p></main></body></html>`, text: `${title}\nRole text` });
const jsonLdJob = (title: string, more: Record<string, unknown> = {}) => ({
  html: `<html><body><h1>${title} (page)</h1></body></html>`,
  text: 'page text',
  jsonLd: [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', name: 'X' }, { '@type': ['JobPosting'], title, description: '<p>Build <b>things</b>.</p><ul><li>Go</li></ul>', datePosted: '2026-10-01', ...more }] }],
});

describe('src-careers contract', () => {
  it('is an io sourcing agent that reads the pack, renders up to 60 pages, with a timeout of 60 x (10 s + 20 s)', () => {
    const { contract } = makeSrcCareers([HOST]);
    expect(contract).toMatchObject({ id: 'src-careers', kind: 'io', team: 'sourcing', capabilities: { browser: { maxPages: 60 }, pack: true }, egress: [HOST], timeoutMs: 1_800_000 });
    expect(CAREERS_MAX_PAGES).toBe(60);
    expect(CAREERS_RENDER_INTERVAL_MS).toBe(PRODUCT_POLICY_V1.minBrowserIntervalMs);
    expect(contract.retry.on).not.toContain('timeout');
    expect(contract.consumes.id).toBe('DiscoveryRequest@1');
    expect(contract.produces.id).toBe('RawPosting@1');
  });

  it('takes the exact careers hosts of the watchlist, sorted and deduplicated', () => {
    const hosts = careersHosts([
      { ats: 'greenhouse' },
      { ats: 'careers', listUrl: 'https://jobs.b.example/list' },
      { ats: 'careers', listUrl: 'https://Careers.A.example/x' },
      { ats: 'careers', listUrl: 'https://jobs.b.example/other' },
    ]);
    expect(hosts).toEqual(['careers.a.example', 'jobs.b.example']);
    expect(makeSrcCareers(['jobs.b.example', 'careers.a.example', 'jobs.b.example']).contract.egress).toEqual(hosts);
    expect(() => makeSrcCareers([])).toThrow(/at least one careers host/);
  });

  it('the fixture pack yields its careers host', () => {
    const { pack } = loadPack(resolve(import.meta.dirname, '../fixtures/pack'));
    expect(careersHosts(pack.watchlist)).toEqual([HOST]);
  });

  it('sourceId is the first 16 hex of sha256 of the job URL without query or fragment', () => {
    expect(canonicalJobUrl(`${H}/jobs/a?utm=x#apply`)).toBe(`${H}/jobs/a`);
    expect(careersSourceId(`${H}/jobs/a?utm=x#apply`)).toBe(sha16(`${H}/jobs/a`));
  });

  it('sha256Hex matches node:crypto', () => {
    for (const s of ['', 'abc', 'é日本語', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'q'.repeat(1000)]) {
      expect(sha256Hex(s), s.slice(0, 10)).toBe(createHash('sha256').update(s).digest('hex'));
    }
  });
});

describe('src-careers with a fake browser', () => {
  it('ignores other requests without rendering anything', async () => {
    const { browser, out } = run({}, { r: req('greenhouse', 'example-careers') });
    await expect(out).resolves.toEqual([]);
    expect(browser.calls).toHaveLength(0);
  });

  it('renders the listing, then each same-host job link, and emits sorted RawPostings', async () => {
    const { browser, out } = run({
      [LIST]: { html: listing(a('/jobs/zeta-engineer'), a('/jobs/alpha-engineer#apply'), a('https://elsewhere.example/jobs/x'), a('/team'), a('mailto:jobs@careers.example.com'), a('/jobs/alpha-engineer')) },
      [`${H}/jobs/alpha-engineer`]: jsonLdJob('Alpha Engineer'),
      [`${H}/jobs/zeta-engineer`]: plainJob('Zeta &amp; Co Engineer'),
    });
    const postings = (await out) as RawPosting[];
    expect(browser.calls.map((c) => c.url)).toEqual([LIST, `${H}/jobs/alpha-engineer`, `${H}/jobs/zeta-engineer`]);
    expect(postings.map((p) => p.sourceId)).toEqual([sha16(`${H}/jobs/alpha-engineer`), sha16(`${H}/jobs/zeta-engineer`)].sort());
    const alpha = postings.find((p) => (p.raw as { url: string }).url.endsWith('alpha-engineer'));
    expect(alpha).toMatchObject({ source: 'careers', company: 'Example Careers Co', slug: 'example-careers' });
    expect(alpha?.raw).toEqual({
      url: `${H}/jobs/alpha-engineer`,
      jsonLd: expect.objectContaining({ title: 'Alpha Engineer', datePosted: '2026-10-01' }),
      title: 'Alpha Engineer',
      text: 'Build things.\nGo',
    });
    const zeta = postings.find((p) => (p.raw as { url: string }).url.endsWith('zeta-engineer'));
    expect(zeta?.raw).toEqual({ url: `${H}/jobs/zeta-engineer`, jsonLd: null, title: 'Zeta & Co Engineer', text: 'Zeta &amp; Co Engineer\nRole text' });
  });

  it('uses linkPattern when the entry has one', async () => {
    const { browser, out } = run(
      { [LIST]: { html: listing(a('/jobs/one'), a('/positions/two'), a('/careers/three')) }, [`${H}/positions/two`]: plainJob('Two') },
      { pack: packOf(entry({ linkPattern: '^/positions/' })) },
    );
    expect(((await out) as RawPosting[]).map((p) => (p.raw as { title: string }).title)).toEqual(['Two']);
    expect(browser.calls.map((c) => c.url)).toEqual([LIST, `${H}/positions/two`]);
  });

  it('collects JSON-LD ItemList links from the listing too', async () => {
    const { out } = run({
      [LIST]: { html: listing(), jsonLd: [{ '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', url: `${H}/jobs/from-list` }, { '@type': 'ListItem', item: { '@id': '/jobs/relative' } }] }] },
      [`${H}/jobs/from-list`]: plainJob('From List'),
      [`${H}/jobs/relative`]: plainJob('Relative'),
    });
    expect(((await out) as RawPosting[]).map((p) => (p.raw as { title: string }).title).sort()).toEqual(['From List', 'Relative']);
  });

  it('fails loudly when job links exceed the page budget, before rendering any job', async () => {
    const links = Array.from({ length: 4 }, (_, i) => a(`/jobs/j${i}`));
    const { browser, out } = run({ [LIST]: { html: listing(...links) } }, { maxPages: 4 });
    await expect(out).rejects.toMatchObject({ code: 'invalid_output', message: 'careers example-careers: 4 job links exceed page budget' });
    expect(browser.calls).toHaveLength(1);
    // Exactly maxPages - 1 links fit.
    const fits = run({ [LIST]: { html: listing(...links.slice(0, 3)) }, ...Object.fromEntries([0, 1, 2].map((i) => [`${H}/jobs/j${i}`, plainJob(`J${i}`)])) }, { maxPages: 4 });
    await expect(fits.out).resolves.toHaveLength(3);
  });

  it('follows rel=next and same-host "load more" links across listing pages, within the budget', async () => {
    const { browser, out } = run({
      [LIST]: { html: `<html><head><link rel="next" href="/jobs?page=2"></head><body>${a('/jobs/one')}</body></html>` },
      [`${H}/jobs?page=2`]: { html: `<html><body>${a('/jobs/two')}${a('/jobs?page=3', 'Load more jobs')}</body></html>` },
      [`${H}/jobs?page=3`]: { html: `<html><body>${a('/jobs/three')}</body></html>` },
      [`${H}/jobs/one`]: plainJob('One'),
      [`${H}/jobs/two`]: plainJob('Two'),
      [`${H}/jobs/three`]: plainJob('Three'),
    });
    expect(((await out) as RawPosting[]).map((p) => (p.raw as { title: string }).title).sort()).toEqual(['One', 'Three', 'Two']);
    expect(browser.calls.slice(0, 3).map((c) => c.url)).toEqual([LIST, `${H}/jobs?page=2`, `${H}/jobs?page=3`]);
  });

  it('fails loudly when pagination loops, or when listing pages plus job links exceed the budget', async () => {
    const loop = run({
      [LIST]: { html: `<html><head><link rel="next" href="/jobs?page=2"></head><body>${a('/jobs/one')}</body></html>` },
      [`${H}/jobs?page=2`]: { html: `<html><head><link rel="next" href="/jobs"></head><body>${a('/jobs/two')}</body></html>` },
    });
    await expect(loop.out).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/careers example-careers: listing pagination repeats/) });

    const pages = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [i === 0 ? LIST : `${H}/jobs?page=${i + 1}`, { html: `<html><head><link rel="next" href="/jobs?page=${i + 2}"></head><body></body></html>` }]));
    const long = run(pages, { maxPages: 4 });
    await expect(long.out).rejects.toMatchObject({ code: 'invalid_output', message: 'careers example-careers: listing pagination exceeds page budget of 4' });

    const tight = run({
      [LIST]: { html: `<html><head><link rel="next" href="/jobs?page=2"></head><body>${a('/jobs/one')}${a('/jobs/two')}</body></html>` },
      [`${H}/jobs?page=2`]: { html: `<html><body>${a('/jobs/three')}</body></html>` },
    }, { maxPages: 4 });
    await expect(tight.out).rejects.toMatchObject({ code: 'invalid_output', message: 'careers example-careers: 3 job links exceed page budget' });
  });

  it('fails loudly on a "load more" control it cannot follow without clicking', async () => {
    for (const more of ['<button type="button" class="more">Load more</button>', '<a href="#">Show more jobs</a>', '<a>View more</a>']) {
      const { out } = run({ [LIST]: { html: listing(a('/jobs/one'), more) } });
      await expect(out, more).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/careers example-careers: the listing has a "load more" control/) });
    }
  });

  it('fails loudly when two job links differ only by query string, since their ids would collide', async () => {
    const { out } = run({ [LIST]: { html: listing(a('/jobs/view?id=1'), a('/jobs/view?id=2')) } });
    await expect(out).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/differ only by query string: https:\/\/careers.example.com\/jobs\/view/) });
  });

  it('skips a job page that is gone or has no title, but fails when every job fails', async () => {
    const some = run({
      [LIST]: { html: listing(a('/jobs/gone'), a('/jobs/untitled'), a('/jobs/fine')) },
      [`${H}/jobs/untitled`]: { html: '<html><body><p>No heading</p></body></html>' },
      [`${H}/jobs/fine`]: plainJob('Fine'),
    });
    expect(((await some.out) as RawPosting[]).map((p) => (p.raw as { title: string }).title)).toEqual(['Fine']);
    const none = run({ [LIST]: { html: listing(a('/jobs/gone')) } });
    await expect(none.out).rejects.toMatchObject({ code: 'invalid_output', message: 'careers: all 1 jobs failed to parse' });
  });

  it('falls back to og:title, then <title>, when a page has neither JSON-LD nor an h1', async () => {
    const { out } = run({
      [LIST]: { html: listing(a('/jobs/og'), a('/jobs/titled')) },
      [`${H}/jobs/og`]: { html: '<html><head><meta property="og:title" content="Site Reliability Engineer"><title>Work With Us &#8211; SRE</title></head><body><h2>Site Reliability Engineer</h2></body></html>', text: 'SRE text' },
      [`${H}/jobs/titled`]: { html: '<html><head><title>Work With Us &#8211; Product Designer</title></head><body><h2>x</h2></body></html>', text: 'PD text' },
    });
    expect(((await out) as RawPosting[]).map((p) => (p.raw as { title: string }).title).sort()).toEqual(['Site Reliability Engineer', 'Work With Us \u2013 Product Designer']);
  });

  it('skips a job link that redirects back to the listing (a closed job)', async () => {
    const { out } = run({
      [LIST]: { html: listing(a('/jobs/closed'), a('/jobs/open')) },
      [`${H}/jobs/closed`]: { html: listing(), finalUrl: LIST },
      [`${H}/jobs/open`]: plainJob('Open'),
    });
    expect(((await out) as RawPosting[]).map((p) => (p.raw as { title: string }).title)).toEqual(['Open']);
  });

  it('fails on a listing error, a missing watchlist entry, or a challenge, without partial output', async () => {
    await expect(run({ [LIST]: { html: 'x', status: 404 } }).out).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/listing .* returned 404/) });
    await expect(run({}, { pack: packOf(entry({ slug: 'other' })) }).out).rejects.toMatchObject({ code: 'invalid_output', message: 'careers example-careers: no careers entry in the watchlist' });
    const wall = run({ [LIST]: { html: listing(a('/jobs/one')) }, [`${H}/jobs/one`]: { html: '<p>Are you a robot?</p>' } });
    await expect(wall.out).rejects.toMatchObject({ code: 'challenged' });
    expect(wall.browser.calls).toHaveLength(2);
  });

  it('caps the fallback text at 50 KB on a character boundary', async () => {
    const long = 'é'.repeat(40_000);
    const { out } = run({ [LIST]: { html: listing(a('/jobs/long')) }, [`${H}/jobs/long`]: { html: '<h1>Long</h1>', text: long } });
    const text = ((await out) as RawPosting[])[0]?.raw as { text: string };
    expect(CAREERS_TEXT_MAX_BYTES).toBe(51_200);
    expect(new TextEncoder().encode(text.text).length).toBeLessThanOrEqual(51_200);
    expect(text.text).toBe('é'.repeat(25_600));
  });

  it('is deterministic whatever order the listing shows its links in', async () => {
    const routes = (order: string[]) => ({ [LIST]: { html: listing(...order.map((p) => a(p))) }, [`${H}/jobs/a`]: plainJob('A'), [`${H}/jobs/b`]: plainJob('B') });
    const one = await run(routes(['/jobs/a', '/jobs/b'])).out;
    const two = await run(routes(['/jobs/b', '/jobs/a'])).out;
    expect(one).toEqual(two);
  });
});

/**
 * Real headless chromium against a local node:http server. The broker only renders https on port 443, so this test
 * drives the provider directly (with its test-only loopback flag) and runs the agent over a context whose browser is
 * that provider; the broker's own checks are covered by the fake-provider tests above and in tests/kernel/browser.test.ts.
 */
describe('src-careers with real chromium', async () => {
  const { chromium } = await import('playwright');
  const { existsSync } = await import('node:fs');
  const installed = existsSync(chromium.executablePath());
  if (!installed) console.warn(`[careers] chromium headless shell not installed at ${chromium.executablePath()}: skipping the real-browser test`);
  const fixtures = resolve(import.meta.dirname, '../fixtures/careers');
  const hits: string[] = [];
  let server: Server;
  let base = '';
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  let provider: import('../../src/app/browser/playwright-provider.js').PlaywrightBrowserProvider;

  beforeAll(async () => {
    if (!installed) return;
    const files: Record<string, [string, string]> = {
      '/listing.html': ['listing.html', 'text/html'],
      '/api/jobs.json': ['jobs.json', 'application/json'],
      '/jobs/backend-engineer': ['job-jsonld.html', 'text/html'],
      '/jobs/data-engineer': ['job-plain.html', 'text/html'],
      '/challenge.html': ['challenge.html', 'text/html'],
    };
    server = createServer((rq, rs) => {
      const path = (rq.url ?? '/').split('?')[0] as string;
      hits.push(`${rq.headers.host?.split(':')[0]}${path} ${rq.headers['user-agent']} ${rq.headers.accept ?? ''}`);
      if (path === '/hop') {
        rs.writeHead(302, { location: '/listing.html' });
        return rs.end();
      }
      if (path === '/hop-then-leave') {
        rs.writeHead(301, { location: '/moved' });
        return rs.end();
      }
      if (path === '/moved') {
        rs.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/listing.html` });
        return rs.end();
      }
      const f = files[path];
      if (!f) {
        rs.writeHead(404, { 'content-type': 'text/plain' });
        return rs.end('not found');
      }
      rs.writeHead(200, { 'content-type': f[1] });
      rs.end(readFileSync(join(fixtures, f[0])));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { PlaywrightBrowserProvider } = await import('../../src/app/browser/playwright-provider.js');
    provider = new PlaywrightBrowserProvider({ allowInsecureLocalhostForTests: true });
  }, 30_000);

  afterAll(async () => {
    if (!installed) return;
    await provider?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const render = (url: string, deniedHosts: string[] = []) =>
    provider.render({ url, navigationHosts: ['127.0.0.1'], deniedHosts, signal: new AbortController().signal });

  it.skipIf(!installed)('renders links that JavaScript adds after load, with the honest user-agent, and loads no images', async () => {
    const page = await render(`${base}/listing.html`);
    expect(page.status).toBe(200);
    expect(page.finalUrl).toBe(`${base}/listing.html`);
    expect(page.html).toContain('href="/jobs/backend-engineer"');
    expect(page.text).toContain('3 roles');
    expect(page.text).not.toContain('About us');
    const listingHit = hits.find((h) => h.startsWith('127.0.0.1/listing.html'));
    expect(listingHit).toContain('jobpilot/0.1 (+local)');
    expect(listingHit).toContain('application/json, text/plain;q=0.8, */*;q=0.1');
    expect(hits.some((h) => h.includes('/logo.png'))).toBe(false);
  }, 30_000);

  it.skipIf(!installed)('returns parsed JSON-LD, and plain pages with none', async () => {
    const withLd = await render(`${base}/jobs/backend-engineer`);
    expect(withLd.jsonLd).toEqual([expect.objectContaining({ '@type': 'JobPosting', title: 'Senior Backend Engineer' })]);
    const plain = await render(`${base}/jobs/data-engineer`);
    expect(plain.jsonLd).toEqual([]);
    expect(plain.text).toContain('Own the data pipeline');
  }, 30_000);

  it.skipIf(!installed)('shows a challenge page as one the broker stops on', async () => {
    const page = await render(`${base}/challenge.html`);
    expect(CHALLENGE_PATTERN.test(page.html)).toBe(true);
  }, 30_000);

  it.skipIf(!installed)('aborts a redirect to a host outside the navigation hosts and reports where it tried to go', async () => {
    const before = hits.length;
    const page = await render(`${base}/moved`);
    expect(new URL(page.finalUrl).hostname).toBe('localhost');
    expect(page.status).toBe(0);
    expect(hits.slice(before).some((h) => h.startsWith('localhost/'))).toBe(false);
  }, 30_000);

  it.skipIf(!installed)('follows a same-host redirect, and still stops a later hop that leaves the navigation hosts', async () => {
    const hop = await render(`${base}/hop`);
    expect(hop).toMatchObject({ status: 200, finalUrl: `${base}/listing.html` });
    const before = hits.length;
    const leave = await render(`${base}/hop-then-leave`);
    expect(new URL(leave.finalUrl).hostname).toBe('localhost');
    expect(hits.slice(before).map((h) => h.split(' ')[0])).toEqual(['127.0.0.1/hop-then-leave', '127.0.0.1/moved']);
  }, 30_000);

  it.skipIf(!installed)('aborts page requests to a denied host', async () => {
    const before = hits.length;
    await render(`${base}/listing.html`, ['127.0.0.1']);
    // The navigation itself is governed by navigationHosts (the broker refuses denied hosts before this point);
    // the page's own fetch of the job list goes to the denied host and is aborted.
    expect(hits.slice(before).map((h) => h.split(' ')[0])).toEqual(['127.0.0.1/listing.html']);
  }, 30_000);

  it.skipIf(!installed)('runs the whole agent: listing, then both job pages, JSON-LD and fallback', async () => {
    const agent = makeSrcCareers(['127.0.0.1']);
    const signal = new AbortController().signal;
    const ctx: AgentContext = {
      clock: fixedClock('2026-10-09T00:00:00Z'),
      signal,
      pack: packOf(entry({ listUrl: `${base}/listing.html` })),
      browser: { render: (url) => render(url, [...PRODUCT_POLICY_V1.deniedEgressHosts]) },
      spent: () => ({ usd: 0, inputTokens: 0, outputTokens: 0 }),
      maxCall: () => 0,
      denials: () => [],
    };
    const postings = (await agent.run(req(), ctx)) as RawPosting[];
    expect(postings).toHaveLength(2);
    const byTitle = Object.fromEntries(postings.map((p) => [(p.raw as { title: string }).title, p]));
    expect(byTitle['Senior Backend Engineer']?.raw).toMatchObject({ url: `${base}/jobs/backend-engineer`, jsonLd: expect.objectContaining({ jobLocationType: 'TELECOMMUTE' }) });
    expect(byTitle['Data & Platform Engineer']?.raw).toMatchObject({ url: `${base}/jobs/data-engineer?utm_source=list`, jsonLd: null });
    expect(byTitle['Data & Platform Engineer']?.sourceId).toBe(sha16(`${base}/jobs/data-engineer`));
  }, 60_000);
});
