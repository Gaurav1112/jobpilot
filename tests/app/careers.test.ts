import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAREERS_JOB_PAGE_WORST_MS,
  CAREERS_JOB_TIMEOUT_MS,
  CAREERS_LIST_MAX_PAGES,
  CAREERS_LISTING_PAGE_WORST_MS,
  CAREERS_MAX_LINKS,
  CAREERS_RENDER_INTERVAL_MS,
  CAREERS_TEXT_MAX_BYTES,
  careersHosts,
  careersSourceId,
  canonicalJobUrl,
  makeSrcCareersJob,
  makeSrcCareersList,
  CAREERS_REFRESH_DAYS,
  dayNumber,
  titleKeyOf,
  refreshEpoch,
} from '../../src/app/agents/sources/careers.js';
import { sha256Hex } from '../../src/app/agents/sources/sha256.js';
import { DEFAULT_TIMING } from '../../src/app/browser/playwright-provider.js';
import { loadPack } from '../../src/app/pack/load.js';
import { DiscoveryRequest as DiscoveryRequestType, knownAts, type CareerLink, type DiscoveryRequest, type RawPosting } from '../../src/app/types.js';
import type { AgentContext } from '../../src/kernel/agent.js';
import { freezePack, issueContext } from '../../src/kernel/broker.js';
import { challengeReason } from '../../src/kernel/challenge.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { contractHash, type AnyContract } from '../../src/kernel/contract.js';
import { fakeBrowser } from '../../src/kernel/fakes.js';
import { builtinGuardrails } from '../../src/kernel/guardrails/builtin.js';
import { PRODUCT_POLICY_V1, policyHash } from '../../src/kernel/policy.js';
import type { BrowserPage } from '../../src/kernel/providers.js';
import { Registry } from '../../src/kernel/registry.js';
import { Store } from '../../src/kernel/store/store.js';
import { Supervisor } from '../../src/kernel/supervisor.js';
import { compileWiring, type Pipeline } from '../../src/kernel/wiring.js';

const HOST = 'careers.example.com';
const H = `https://${HOST}`;
const LIST = `${H}/jobs`;
const req = (ats: DiscoveryRequest['ats'] = 'careers', slug = 'example-careers', runDate = '2026-10-09'): DiscoveryRequest => ({ ats, slug, company: 'Example Careers Co', runDate });
const entry = (extra: Record<string, unknown> = {}) => ({ company: 'Example Careers Co', ats: 'careers', slug: 'example-careers', listUrl: LIST, linkPattern: '^/jobs/', hiresInIndia: true, allRemote: false, ...extra });
const packOf = (...watchlist: unknown[]) => freezePack({ watchlist });
type Route = Partial<BrowserPage> & { html: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const linkOf = (url: string, extra: Partial<CareerLink> = {}): CareerLink => ({ company: 'Example Careers Co', slug: 'example-careers', listUrl: LIST, url, linkPattern: '^/jobs/', titleKey: '', refresh: refreshEpoch(url, '2026-10-09'), ...extra });

/**
 * Runs src-careers-list, then src-careers-job on every link it emits, in order, over one fake browser.
 * `links` is the list step, `jobs` every job step's posting or error, `out` the postings (rejecting on any error).
 */
function run(routes: Record<string, Route>, opts: { pack?: unknown; maxListingPages?: number; maxLinks?: number; r?: DiscoveryRequest } = {}) {
  const list = makeSrcCareersList({
    ...(opts.maxListingPages !== undefined ? { maxListingPages: opts.maxListingPages } : {}),
    ...(opts.maxLinks !== undefined ? { maxLinks: opts.maxLinks } : {}),
  });
  const job = makeSrcCareersJob();
  const browser = fakeBrowser(routes);
  const ctxFor = (contract: AnyContract) =>
    issueContext({
      egressSets: { 'pack:careers-hosts': [HOST] },
      contract,
      policy: PRODUCT_POLICY_V1,
      inputClass: 'P0',
      providers: { fetch: async () => ({ status: 404, text: async () => '' }), browser },
      clock: fixedClock('2026-10-09T00:00:00Z'),
      signal: new AbortController().signal,
      pack: opts.pack ?? packOf(entry()),
    });
  const links = list.run(opts.r ?? req(), ctxFor(list.contract)) as Promise<CareerLink[]>;
  const jobs = links.then(async (ls) => {
    const postings: RawPosting[] = [];
    const errors: { url: string; error: unknown }[] = [];
    for (const l of ls) {
      try {
        postings.push(...((await job.run(l, ctxFor(job.contract))) as RawPosting[]));
      } catch (error) {
        errors.push({ url: l.url, error });
      }
    }
    return { postings, errors };
  });
  const out = jobs.then(({ postings, errors }) => {
    if (errors[0]) throw errors[0].error;
    return [...postings].sort((x, y) => (x.sourceId < y.sourceId ? -1 : 1));
  });
  // Tests await what they check; the rest must not surface as unhandled rejections.
  jobs.catch(() => undefined);
  out.catch(() => undefined);
  return { browser, links, jobs, out };
}
const titles = (ps: readonly RawPosting[]) => ps.map((p) => (p.raw as { title: string }).title).sort();
const messages = (es: readonly { error: unknown }[]) => es.map((e) => (e.error as Error).message);

const a = (href: string, text = 'A role', attrs = '') => `<a href="${href}"${attrs}>${text}</a>`;
const listing = (...links: string[]) => `<html><body><nav>${a('/about', 'About')}${a('/jobs', 'Jobs')}</nav><main>${links.join('\n')}</main></body></html>`;
const plainJob = (title: string) => ({ html: `<html><body><main><h1 class="t">${title}</h1><p>Role text</p></main></body></html>`, text: `${title}\nRole text` });
const jsonLdJob = (title: string, more: Record<string, unknown> = {}) => ({
  html: `<html><body><h1>${title} (page)</h1></body></html>`,
  text: 'page text',
  jsonLd: [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', name: 'X' }, { '@type': ['JobPosting'], title, description: '<p>Build <b>things</b>.</p><ul><li>Go</li></ul>', datePosted: '2026-10-01', ...more }] }],
});

describe('src-careers contracts', () => {
  it('src-careers-list: io, reads the pack, at most 6 listing pages whose worst case fits the 30-minute cap', () => {
    const { contract } = makeSrcCareersList();
    expect(contract).toMatchObject({ id: 'src-careers-list', kind: 'io', team: 'sourcing', capabilities: { browser: { maxPages: 6 }, pack: true }, egress: ['pack:careers-hosts'], timeoutMs: 1_650_000 });
    expect(contract.consumes.id).toBe('DiscoveryRequest@1');
    expect(contract.produces.id).toBe('CareerLink@1');
    expect(contract.retry.on).not.toContain('timeout');
    expect(CAREERS_LIST_MAX_PAGES).toBe(6);
    expect(CAREERS_MAX_LINKS).toBe(5000);
    // 6 x 275 s = 1,650 s; a seventh page would not fit, and the contract says so when it is built.
    expect(() => makeSrcCareersList({ maxListingPages: 7 })).toThrow(/timeoutMs/);
  });

  it('src-careers-job: io, one page, 75 s worst case plus 15 s, retries network and timeout only, no pack', () => {
    const { contract } = makeSrcCareersJob();
    expect(contract).toMatchObject({ id: 'src-careers-job', kind: 'io', team: 'sourcing', capabilities: { browser: { maxPages: 1 } }, egress: ['pack:careers-hosts'], timeoutMs: 90_000 });
    expect(contract.capabilities.pack).toBeUndefined();
    expect(contract.retry.on).toEqual(['network', 'timeout']);
    expect(contract.consumes.id).toBe('CareerLink@1');
    expect(contract.produces.id).toBe('RawPosting@1');
    expect(CAREERS_JOB_TIMEOUT_MS).toBe(CAREERS_JOB_PAGE_WORST_MS + 15_000);
  });

  it('the worst cases follow the provider product timing and the policy interval', () => {
    const t = DEFAULT_TIMING;
    expect(CAREERS_JOB_PAGE_WORST_MS).toBe(CAREERS_RENDER_INTERVAL_MS + t.navigationMs + t.jobSettleCapMs);
    expect(CAREERS_LISTING_PAGE_WORST_MS).toBe(CAREERS_RENDER_INTERVAL_MS + t.navigationMs + t.settleCapMs + t.expandBudgetMs + 5_000 + t.settleCapMs);
    expect(CAREERS_RENDER_INTERVAL_MS).toBe(PRODUCT_POLICY_V1.minBrowserIntervalMs);
  });

  it('takes the exact careers hosts of the watchlist, sorted and deduplicated, for both agents', () => {
    const hosts = careersHosts([
      { ats: 'greenhouse' },
      { ats: 'careers', listUrl: 'https://jobs.b.example/list' },
      { ats: 'careers', listUrl: 'https://Careers.A.example/x' },
      { ats: 'careers', listUrl: 'https://jobs.b.example/other' },
    ]);
    expect(hosts).toEqual(['careers.a.example', 'jobs.b.example']);
    // The contracts name the set, not the hosts: their hashes never change with the watchlist (fix C1).
    expect(makeSrcCareersList().contract.egress).toEqual(['pack:careers-hosts']);
    expect(makeSrcCareersJob().contract.egress).toEqual(['pack:careers-hosts']);
    expect(contractHash(makeSrcCareersList().contract)).toBe(contractHash(makeSrcCareersList().contract));
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

describe('src-careers-list and src-careers-job with a fake browser', () => {
  it('ignores other requests without rendering anything', async () => {
    const { browser, links } = run({}, { r: req('greenhouse', 'example-careers') });
    await expect(links).resolves.toEqual([]);
    expect(browser.calls).toHaveLength(0);
  });

  it('emits one dateless CareerLink per job link, sorted, carrying the entry it came from', async () => {
    const { links } = run({ [LIST]: { html: listing(a('/jobs/zeta'), a('/jobs/alpha#apply'), a('/jobs/alpha')) } });
    expect(await links).toEqual([linkOf(`${H}/jobs/alpha`, { titleKey: 'a role' }), linkOf(`${H}/jobs/zeta`, { titleKey: 'a role' })]);
    const titled = await run({ [LIST]: { html: listing(a('/jobs/x', '  Senior   Go Engineer '), a('/jobs/x', 'Apply')) } }).links;
    expect(titled.map((l) => l.titleKey)).toEqual(['senior go engineer']);
  });

  it('renders the listing, then each same-host job link, and emits RawPostings', async () => {
    const { browser, out } = run({
      [LIST]: { html: listing(a('/jobs/zeta-engineer'), a('/jobs/alpha-engineer#apply'), a('https://elsewhere.example/jobs/x'), a('/team'), a('mailto:jobs@careers.example.com'), a('/jobs/alpha-engineer')) },
      [`${H}/jobs/alpha-engineer`]: jsonLdJob('Alpha Engineer'),
      [`${H}/jobs/zeta-engineer`]: plainJob('Zeta &amp; Co Engineer'),
    });
    const postings = await out;
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

  it('uses the entry linkPattern', async () => {
    const { browser, out } = run(
      { [LIST]: { html: listing(a('/jobs/one'), a('/positions/two'), a('/careers/three')) }, [`${H}/positions/two`]: plainJob('Two'), [`${H}/careers/three`]: plainJob('Three') },
      { pack: packOf(entry({ linkPattern: '^/(positions|careers)/t' })) },
    );
    expect(titles(await out)).toEqual(['Three', 'Two']);
    expect(browser.calls.map((c) => c.url)).toEqual([LIST, `${H}/careers/three`, `${H}/positions/two`]);
    expect(browser.calls.map((c) => c.expand)).toEqual([true, false, false]);
  });

  it('collects JSON-LD ItemList links from the listing too', async () => {
    const { out } = run({
      [LIST]: { html: listing(), jsonLd: [{ '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', url: `${H}/jobs/from-list` }, { '@type': 'ListItem', item: { '@id': '/jobs/relative' } }] }] },
      [`${H}/jobs/from-list`]: plainJob('From List'),
      [`${H}/jobs/relative`]: plainJob('Relative'),
    });
    expect(titles(await out)).toEqual(['From List', 'Relative']);
  });

  it('fails loudly past the link cap, before any job is rendered', async () => {
    const links = Array.from({ length: 4 }, (_, i) => a(`/jobs/j${i}`));
    const { browser, links: out } = run({ [LIST]: { html: listing(...links) } }, { maxLinks: 3 });
    await expect(out).rejects.toMatchObject({ code: 'invalid_output', message: 'careers example-careers: 4 job links exceed the cap of 3' });
    expect(browser.calls).toHaveLength(1);
    await expect(run({ [LIST]: { html: listing(...links.slice(0, 3)) } }, { maxLinks: 3 }).links).resolves.toHaveLength(3);
  });

  it('follows rel=next and same-host "load more" links across listing pages', async () => {
    const { browser, out } = run({
      [LIST]: { html: `<html><head><link rel="next" href="/jobs?page=2"></head><body>${a('/jobs/one')}</body></html>` },
      [`${H}/jobs?page=2`]: { html: `<html><body>${a('/jobs/two')}${a('/jobs?page=3', 'Load more jobs (12)')}</body></html>` },
      [`${H}/jobs?page=3`]: { html: `<html><body>${a('/jobs/three')}</body></html>` },
      [`${H}/jobs/one`]: plainJob('One'),
      [`${H}/jobs/two`]: plainJob('Two'),
      [`${H}/jobs/three`]: plainJob('Three'),
    });
    expect(titles(await out)).toEqual(['One', 'Three', 'Two']);
    expect(browser.calls.slice(0, 3).map((c) => c.url)).toEqual([LIST, `${H}/jobs?page=2`, `${H}/jobs?page=3`]);
  });

  it('fails loudly when pagination loops, or runs past the listing-page cap', async () => {
    const loop = run({
      [LIST]: { html: `<html><head><link rel="next" href="/jobs?page=2"></head><body>${a('/jobs/one')}</body></html>` },
      [`${H}/jobs?page=2`]: { html: `<html><head><link rel="next" href="/jobs"></head><body>${a('/jobs/two')}</body></html>` },
    });
    await expect(loop.links).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/careers example-careers: listing pagination repeats/) });
    const pages = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i === 0 ? LIST : `${H}/jobs?page=${i + 1}`, { html: `<html><head><link rel="next" href="/jobs?page=${i + 2}"></head><body>${a(`/jobs/p${i}`)}</body></html>` }]));
    await expect(run(pages).links).rejects.toMatchObject({ code: 'invalid_output', message: 'careers example-careers: listing pagination exceeds 6 listing pages' });
    await expect(run(pages, { maxListingPages: 4 }).links).rejects.toMatchObject({ message: 'careers example-careers: listing pagination exceeds 4 listing pages' });
  });

  it('follows numbered pages (?page=N, ?start=N, ?offset=N), unlabelled next arrows and "show all" links', async () => {
    const shapes: [string, Record<string, Route>][] = [
      ['numbered', { [LIST]: { html: listing(a('/jobs/one'), '<nav>' + a('/jobs?page=2', '2') + a('/jobs?page=3', '3') + '</nav>') }, [`${H}/jobs?page=2`]: { html: listing(a('/jobs/two'), a('/jobs?page=1', '1'), a('/jobs?page=3', '3')) }, [`${H}/jobs?page=3`]: { html: listing(a('/jobs/three'), a('/jobs?page=2', '2')) } }],
      ['next arrow', { [LIST]: { html: listing(a('/jobs/one'), a('/jobs?page=2', 'Next ›')) }, [`${H}/jobs?page=2`]: { html: listing(a('/jobs/two'), a('/jobs?page=3', '', ' aria-label="Next page"')) }, [`${H}/jobs?page=3`]: { html: listing(a('/jobs/three')) } }],
      ['offset', { [LIST]: { html: listing(a('/jobs/one'), a('/jobs?start=20', '&gt;', ' aria-label="Next page"')) }, [`${H}/jobs?start=20`]: { html: listing(a('/jobs/two'), a('/jobs?start=40', '&gt;')) }, [`${H}/jobs?start=40`]: { html: listing(a('/jobs/three'), a('/jobs?start=0', '1')) } }],
      ['show 20 more link', { [LIST]: { html: listing(a('/jobs/one'), a('/jobs?page=2', 'Show 20 more')) }, [`${H}/jobs?page=2`]: { html: listing(a('/jobs/two'), a('/jobs/three')) } }],
      ['show all', { [LIST]: { html: listing(a('/jobs/one'), a('/jobs/all', 'Show all jobs')) }, [`${H}/jobs/all`]: { html: listing(a('/jobs/one'), a('/jobs/two'), a('/jobs/three'), a('/jobs/all', 'Show all jobs')) } }],
    ];
    for (const [name, routes] of shapes) {
      const jobs = { [`${H}/jobs/one`]: plainJob('One'), [`${H}/jobs/two`]: plainJob('Two'), [`${H}/jobs/three`]: plainJob('Three') };
      expect(titles(await run({ ...routes, ...jobs }).out), name).toEqual(['One', 'Three', 'Two']);
    }
  });

  it('fails loudly on pagination the browser could not follow, an expansion past its cap, or a listing still loading', async () => {
    const unfollowed = run({ [LIST]: { html: listing(a('/jobs/one')), expansion: { clicks: 0, scrolls: 0, capReached: false, unfollowedControls: ['<button aria-label="next">'] } } });
    await expect(unfollowed.links).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/careers example-careers: unsupported pagination on .*aria-label="next"/) });
    const capped = run({ [LIST]: { html: listing(a('/jobs/one')), expansion: { clicks: 50, scrolls: 3, capReached: true, unfollowedControls: [] } } });
    await expect(capped.links).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/"load more" still adding jobs after 50 clicks and 3 scrolls/) });
    const loading = run({ [LIST]: { html: listing(a('/jobs/one')), settled: false, settleCapMs: 45_000 } });
    await expect(loading.links).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/^careers example-careers: listing still loading at 45 s/) });
    const short = run({ [LIST]: { html: listing(a('/jobs/one')), settled: false, settleCapMs: 6_000 } });
    await expect(short.links).rejects.toMatchObject({ message: expect.stringMatching(/listing still loading at 6 s/) });
  });

  it('fails loudly on a listing with no job links, or an ItemList that announces more items than it lists', async () => {
    await expect(run({ [LIST]: { html: '<div id="app">Loading…</div>' } }).links).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/careers example-careers: no job links found/) });
    const itemList = { '@type': 'ItemList', numberOfItems: 37, itemListElement: [{ '@type': 'ListItem', url: `${H}/jobs/one` }] };
    await expect(run({ [LIST]: { html: listing(a('/jobs/one')), jsonLd: [itemList] } }).links).rejects.toMatchObject({ message: expect.stringMatching(/ItemList shows only 1 of 37 items/) });
  });

  it('a template title, a bare "Loading…" body, a missing title or a gone page fails that job alone, loudly', async () => {
    const { jobs } = run({
      [LIST]: { html: listing(a('/jobs/tpl'), a('/jobs/dollar'), a('/jobs/loading'), a('/jobs/untitled'), a('/jobs/gone'), a('/jobs/fine')) },
      [`${H}/jobs/tpl`]: { html: '<h1>{{ job.title }}</h1>', text: 'x' },
      [`${H}/jobs/dollar`]: { html: '<html><head><title>${title}</title></head><body></body></html>', text: 'x' },
      [`${H}/jobs/loading`]: { html: '<html><head><title>Careers | Acme</title></head><body><div>Loading…</div></body></html>', text: 'Loading…' },
      [`${H}/jobs/untitled`]: { html: '<html><body><p>No heading</p></body></html>' },
      [`${H}/jobs/fine`]: plainJob('Fine'),
    });
    const r = await jobs;
    expect(titles(r.postings)).toEqual(['Fine']);
    expect(messages(r.errors)).toEqual([
      `careers example-careers: job page ${H}/jobs/dollar looks unrendered (title "\${title}")`,
      `careers example-careers: job page ${H}/jobs/gone returned 404`,
      `careers example-careers: job page ${H}/jobs/loading looks unrendered (title "Careers | Acme")`,
      `careers example-careers: job page ${H}/jobs/tpl looks unrendered (title "{{ job.title }}")`,
      `careers example-careers: job page ${H}/jobs/untitled has no JobPosting title, h1, og:title or title`,
    ]);
    expect(r.errors.map((e) => (e.error as { code: string }).code)).toEqual(['invalid_output', 'gone', 'invalid_output', 'invalid_output', 'invalid_output']);
    // The h1 inside a script is not the title.
    const scripted = run({ [LIST]: { html: listing(a('/jobs/s')) }, [`${H}/jobs/s`]: { html: '<html><head><title>Real Title</title></head><body><script>el.innerHTML = "<h1>" + d.t + "</h1>";</script></body></html>', text: 'Real text' } });
    expect(titles(await scripted.out)).toEqual(['Real Title']);
  });

  it('passes its linkPattern with every listing render', async () => {
    const { browser, out } = run({ [LIST]: { html: listing(a('/jobs/one')) }, [`${H}/jobs/one`]: plainJob('One') });
    await out;
    expect(browser.calls.map((c) => [c.expand, c.linkPattern])).toEqual([[true, '^/jobs/'], [false, undefined]]);
  });

  it('fails a job page that never settled, naming the cap', async () => {
    const { out } = run({ [LIST]: { html: listing(a('/jobs/one')) }, [`${H}/jobs/one`]: { ...plainJob('One'), settled: false } });
    await expect(out).rejects.toMatchObject({ code: 'invalid_output', message: `careers example-careers: job page still loading: ${H}/jobs/one` });
  });

  it('the job agent refuses a link off the listing host or outside its linkPattern, before rendering', async () => {
    const job = makeSrcCareersJob();
    const browser = fakeBrowser({});
    const ctx = issueContext({ egressSets: { 'pack:careers-hosts': [HOST, 'other.example.com'] }, contract: job.contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => ({ status: 404, text: async () => '' }), browser }, clock: fixedClock('2026-10-09T00:00:00Z'), signal: new AbortController().signal });
    await expect(job.run(linkOf('https://other.example.com/jobs/x'), ctx)).rejects.toMatchObject({ message: expect.stringMatching(/not on the listing's host/) });
    await expect(job.run(linkOf(`${H}/team/x`), ctx)).rejects.toMatchObject({ message: expect.stringMatching(/does not match linkPattern/) });
    expect(browser.calls).toHaveLength(0);
  });

  it('fails loudly when two job links differ only by query string, since their ids would collide', async () => {
    const { links } = run({ [LIST]: { html: listing(a('/jobs/view?id=1'), a('/jobs/view?id=2')) } });
    await expect(links).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/differ only by query string: https:\/\/careers.example.com\/jobs\/view/) });
  });

  it('falls back to og:title, then <title>, when a page has neither JSON-LD nor an h1', async () => {
    const { out } = run({
      [LIST]: { html: listing(a('/jobs/og'), a('/jobs/titled')) },
      [`${H}/jobs/og`]: { html: '<html><head><meta property="og:title" content="Site Reliability Engineer"><title>Work With Us &#8211; SRE</title></head><body><h2>Site Reliability Engineer</h2></body></html>', text: 'SRE text' },
      [`${H}/jobs/titled`]: { html: '<html><head><title>Work With Us &#8211; Product Designer</title></head><body><h2>x</h2></body></html>', text: 'PD text' },
    });
    expect(titles(await out)).toEqual(['Site Reliability Engineer', 'Work With Us – Product Designer']);
  });

  it('gone only for a redirect to the listing path or the site root; any other off-pattern redirect is invalid_output', async () => {
    const { jobs } = run({
      [LIST]: { html: listing(a('/jobs/c1'), a('/jobs/c2'), a('/jobs/c3'), a('/jobs/m1'), a('/jobs/m2'), a('/jobs/m3'), a('/jobs/moved'), a('/jobs/open'), a('/jobs/g410')) },
      [`${H}/jobs/c1`]: { html: listing(), finalUrl: LIST },
      [`${H}/jobs/c2`]: { html: listing(), finalUrl: `${H}/jobs?page=2` },
      [`${H}/jobs/c3`]: { html: '<h1>Welcome</h1>', finalUrl: `${H}/` },
      [`${H}/jobs/m1`]: { html: '<h1>Down for maintenance</h1>', finalUrl: `${H}/maintenance` },
      [`${H}/jobs/m2`]: { html: '<h1>Sign in</h1>', finalUrl: `${H}/login?next=/jobs/m2` },
      [`${H}/jobs/m3`]: { ...plainJob('Localised'), finalUrl: `${H}/en-us/jobs/m3` },
      [`${H}/jobs/moved`]: { ...plainJob('Moved'), finalUrl: `${H}/jobs/moved-123` },
      [`${H}/jobs/open`]: plainJob('Open'),
      [`${H}/jobs/g410`]: { html: 'gone', status: 410 },
    });
    const r = await jobs;
    expect(titles(r.postings)).toEqual(['Moved', 'Open']);
    const codes = Object.fromEntries(r.errors.map((e) => [e.url.split('/').pop(), (e.error as { code: string }).code]));
    expect(codes).toEqual({ c1: 'gone', c2: 'gone', c3: 'gone', g410: 'gone', m1: 'invalid_output', m2: 'invalid_output', m3: 'invalid_output' });
    expect(messages(r.errors)).toContain(`careers example-careers: job page ${H}/jobs/c2 redirected to the listing (/jobs?page=2): the job closed`);
    expect(messages(r.errors)).toContain(`careers example-careers: job page ${H}/jobs/c3 redirected to the site root (/): the job closed`);
    expect(messages(r.errors)).toContain(
      `careers example-careers: job page ${H}/jobs/m3 redirected to /en-us/jobs/m3, outside linkPattern ^/jobs/; if the site moved its job pages (a locale prefix, for example), widen linkPattern`,
    );
  });

  it('titleKey: a title element inside the anchor wins; otherwise the text loses digits, dates and badges, never "remote"', () => {
    expect(titleKeyOf('<h3>Senior Engineer</h3><span>Posted 3 days ago</span><span>Bengaluru</span>')).toBe('senior engineer');
    expect(titleKeyOf('<div class="JobCard-title">Data Engineer</div><time>2 hours ago</time>')).toBe('data engineer');
    expect(titleKeyOf('<span itemprop="title">Site Reliability Engineer</span> NEW')).toBe('site reliability engineer');
    for (const t of ['Backend Engineer · Posted 3 days ago', 'Backend Engineer · Posted 4 days ago', 'NEW! Backend Engineer – posted today', 'Backend Engineer (Featured) 12 hours ago', 'Backend Engineer just now']) {
      expect(titleKeyOf(t), t).toBe('backend engineer');
    }
    expect(titleKeyOf('Backend Engineer, Remote')).toBe('backend engineer remote');
    expect(titleKeyOf('Ｅｎｇｉｎｅｅｒ')).toBe('engineer'); // NFKC
    expect(titleKeyOf('Senior Backend Engineer')).not.toBe(titleKeyOf('Backend Engineer'));
    expect(titleKeyOf('x'.repeat(500))).toHaveLength(200);
    // m-6: only a whole "title" class token is a title element; subtitle, entitled, title-less words are not.
    expect(titleKeyOf('<span class="subtitle">Bengaluru</span><h3>Senior Engineer</h3>')).toBe('senior engineer');
    expect(titleKeyOf('<span class="entitled">Bengaluru</span>Senior Engineer')).toBe('bengaluru senior engineer');
    expect(titleKeyOf('<div class="card job-title">Data Engineer</div><span>Pune</span>')).toBe('data engineer');
    expect(titleKeyOf('<div class="posting_title">QA Engineer</div><span>Pune</span>')).toBe('qa engineer');
    // m-7: combining marks stay, so Devanagari is intact; unit letters left by "3d" or "2h" go.
    expect(titleKeyOf('सीनियर इंजीनियर')).toBe('सीनियर इंजीनियर');
    expect(titleKeyOf('सीनियर इंजीनियर')).not.toBe(titleKeyOf('जूनियर इंजीनियर'));
    expect(titleKeyOf('Backend Engineer · 3d')).toBe('backend engineer');
    expect(titleKeyOf('Backend Engineer 2h ago')).toBe('backend engineer');
    expect(titleKeyOf('Backend Engineer 1w')).toBe(titleKeyOf('Backend Engineer 3d'));
  });

  it('refresh: every link advances exactly once in any 7 consecutive run dates, spread evenly over the week', () => {
    expect(CAREERS_REFRESH_DAYS).toBe(7);
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayNumber('2026-10-09')).toBe(20_735);
    const urls = Array.from({ length: 700 }, (_, i) => `${H}/jobs/j${i}`);
    const dates = Array.from({ length: 8 }, (_, i) => `2026-10-${String(9 + i).padStart(2, '0')}`);
    const changesPerDay = new Array<number>(7).fill(0);
    for (const url of urls) {
      const epochs = dates.map((d) => refreshEpoch(url, d));
      const changes = epochs.slice(1).map((e, i) => e - (epochs[i] as number));
      expect(changes.filter((c) => c === 1), url).toHaveLength(1);
      expect(changes.every((c) => c === 0 || c === 1)).toBe(true);
      changes.forEach((c, i) => (changesPerDay[i] = (changesPerDay[i] as number) + c));
    }
    // About a seventh each day (700 / 7 = 100).
    for (const n of changesPerDay) expect(n).toBeGreaterThan(70), expect(n).toBeLessThan(130);
  });

  it('fails on a listing error, a missing watchlist entry, or a challenge', async () => {
    await expect(run({ [LIST]: { html: 'x', status: 404 } }).links).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/listing .* returned 404/) });
    await expect(run({}, { pack: packOf(entry({ slug: 'other' })) }).links).rejects.toMatchObject({ code: 'invalid_output', message: 'careers example-careers: no careers entry in the watchlist' });
    const wall = run({ [LIST]: { html: listing(a('/jobs/one')) }, [`${H}/jobs/one`]: { html: '<title>Are you a robot?</title>' } });
    await expect(wall.out).rejects.toMatchObject({ code: 'challenged' });
    expect(wall.browser.calls).toHaveLength(2);
  });

  it('caps the fallback text at 50 KB on a character boundary', async () => {
    const long = 'é'.repeat(40_000);
    const { out } = run({ [LIST]: { html: listing(a('/jobs/long')) }, [`${H}/jobs/long`]: { html: '<h1>Long</h1>', text: long } });
    const text = (await out)[0]?.raw as { text: string };
    expect(CAREERS_TEXT_MAX_BYTES).toBe(51_200);
    expect(new TextEncoder().encode(text.text).length).toBeLessThanOrEqual(51_200);
    expect(text.text).toBe('é'.repeat(25_600));
  });

  it('is deterministic whatever order the listing shows its links in', async () => {
    const routes = (order: string[]) => ({ [LIST]: { html: listing(...order.map((p) => a(p))) }, [`${H}/jobs/a`]: plainJob('A'), [`${H}/jobs/b`]: plainJob('B') });
    expect(await run(routes(['/jobs/a', '/jobs/b'])).links).toEqual(await run(routes(['/jobs/b', '/jobs/a'])).links);
    expect(await run(routes(['/jobs/a', '/jobs/b'])).out).toEqual(await run(routes(['/jobs/b', '/jobs/a'])).out);
  });
});

describe('src-careers through the supervisor', () => {
  const pipeline: Pipeline = {
    id: 'careers',
    version: '1.0.0',
    seed: { type: DiscoveryRequestType, guarantees: [knownAts] },
    teams: [{ id: 'sourcing', lead: 'sourcing-lead', members: ['src-careers-list', 'src-careers-job'], exitGuarantees: [], breaker: { consecutiveFailures: 10 } }],
    edges: [
      { type: 'DiscoveryRequest@1', to: 'src-careers-list' },
      { type: 'CareerLink@1', to: 'src-careers-job' },
    ],
  };
  const forty = Array.from({ length: 40 }, (_, i) => `/jobs/j${String(i).padStart(2, '0')}`);
  const routes: Record<string, Route> = { [LIST]: { html: listing(...forty.map((p) => a(p))) } };
  for (const p of forty) routes[`${H}${p}`] = plainJob(`Job ${p.slice(-2)}`);

  const supervisor = (store: Store, browser: ReturnType<typeof fakeBrowser>, slept: number[]) => {
    const registry = new Registry();
    registry.register(makeSrcCareersList());
    registry.register(makeSrcCareersJob());
    const guardrails = builtinGuardrails();
    const pack = { watchlist: [entry()] };
    return new Supervisor({
      store,
      registry,
      compiled: compileWiring(registry, pipeline, guardrails),
      guardrails,
      policy: PRODUCT_POLICY_V1,
      policyHash: policyHash(PRODUCT_POLICY_V1),
      providers: { fetch: async () => ({ status: 404, text: async () => '' }), browser },
      clock: fixedClock('2026-10-09T07:00:00.000Z'),
      sleep: async (ms) => void slept.push(ms),
      pack,
      packHash: 'pack-1',
      egressSets: { 'pack:careers-hosts': [HOST] },
    });
  };

  it('one listing with 40 links runs 40 job steps; the next day only links due for refresh re-render, the rest replay', async () => {
    const store = Store.open(':memory:');
    const browser = fakeBrowser(routes);
    const slept: number[] = [];
    const day1 = await supervisor(store, browser, slept).start('run-1', [req('careers', 'example-careers', '2026-10-09')]);
    expect(day1.queue).toMatchObject({ done: 41, failed: 0 });
    expect(browser.calls).toHaveLength(41);
    // Pacing holds across steps: with the clock fixed, the k-th render after the first waits k browser intervals.
    expect(slept).toEqual(expect.arrayContaining(Array.from({ length: 40 }, (_, i) => (i + 1) * PRODUCT_POLICY_V1.minBrowserIntervalMs)));

    // Day 2: only the links whose staggered refresh epoch advanced re-render; every other link replays.
    const due = forty.filter((p) => refreshEpoch(`${H}${p}`, '2026-10-10') !== refreshEpoch(`${H}${p}`, '2026-10-09'));
    expect(due.length).toBeGreaterThan(0);
    expect(due.length).toBeLessThan(15);
    const day2 = await supervisor(store, browser, []).start('run-2', [req('careers', 'example-careers', '2026-10-10')]);
    expect(day2.queue).toMatchObject({ done: 41, failed: 0 });
    expect(day2.replayed).toBe(40 - due.length);
    expect(browser.calls[41]?.url).toBe(LIST);
    expect(browser.calls.slice(42).map((c) => c.url).sort()).toEqual(due.map((p) => `${H}${p}`).sort());
  });

  it('a gone job fails its own step as gone; the other jobs are done', async () => {
    const browser = fakeBrowser({ ...routes, [`${H}/jobs/j07`]: { html: 'gone', status: 410 } });
    const r = await supervisor(Store.open(':memory:'), browser, []).start('run-g', [req()]);
    expect(r.queue).toMatchObject({ done: 40, failed: 1 });
    expect(r.gone).toBe(1);
  });

  it('over 8 consecutive days each unchanged link re-renders exactly once after day 1; a retitled link re-renders the next day', async () => {
    const seven = forty.slice(0, 7);
    const page = (text: (p: string) => string) => ({ [LIST]: { html: listing(...seven.map((p) => a(p, text(p)))) } });
    const jobPages = Object.fromEntries(seven.map((p) => [`${H}${p}`, plainJob(`Job ${p.slice(-2)}`)]));
    const store = Store.open(':memory:');
    const rendered: string[][] = [];
    for (let d = 0; d < 8; d++) {
      const browser = fakeBrowser({ ...page((p) => `Role ${p.slice(-2)}`), ...jobPages });
      const r = await supervisor(store, browser, []).start(`day-${d}`, [req('careers', 'example-careers', `2026-10-${String(9 + d).padStart(2, '0')}`)]);
      expect(r.queue).toMatchObject({ done: 8, failed: 0 });
      rendered.push(browser.calls.map((c) => c.url).filter((u) => u !== LIST));
    }
    expect(rendered[0]).toHaveLength(7);
    const later = rendered.slice(1).flat().sort();
    expect(later).toEqual(seven.map((p) => `${H}${p}`).sort());
    // Day 9: one link retitled on the listing re-renders; the rest replay unless their refresh day has come.
    const browser = fakeBrowser({ ...page((p) => (p === seven[3] ? 'Senior Role (retitled)' : `Role ${p.slice(-2)}`)), ...jobPages });
    await supervisor(store, browser, []).start('day-8', [req('careers', 'example-careers', '2026-10-17')]);
    expect(browser.calls.map((c) => c.url)).toContain(`${H}${seven[3]}`);
  });

  it('a redirect to the listing is gone even when the listing path itself matches linkPattern', async () => {
    const closed = { html: '<html><body><h1>Join our team</h1><p>All jobs</p></body></html>', text: 'Join our team' };
    const cases: [string, string, string, string][] = [
      ['/jobs/', '^/jobs/', '/jobs/123', '/jobs/'],
      ['/jobs', '^/jobs/', '/jobs/123', '/jobs/'],
      ['/careers/', '^/careers/', '/careers/eng-1', '/careers/'],
      ['/jobs/', '^/jobs/', '/jobs/123', '/jobs/?expired=1'],
      ['/jobs/search', '^/jobs/', '/jobs/123', '/jobs/search?closed'],
    ];
    for (const [listPath, linkPattern, jobPath, target] of cases) {
      const job = makeSrcCareersJob();
      const browser = fakeBrowser({ [`${H}${jobPath}`]: { ...closed, finalUrl: `${H}${target}` } });
      const ctx = issueContext({ egressSets: { 'pack:careers-hosts': [HOST, 'other.example.com'] }, contract: job.contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => ({ status: 404, text: async () => '' }), browser }, clock: fixedClock('2026-10-09T00:00:00Z'), signal: new AbortController().signal });
      const link = linkOf(`${H}${jobPath}`, { listUrl: `${H}${listPath}`, linkPattern });
      await expect(job.run(link, ctx), `${listPath} ${target}`).rejects.toMatchObject({ code: 'gone', message: expect.stringMatching(/redirected to the listing/) });
    }
    // An on-pattern redirect that is not the listing stays a posting.
    const job = makeSrcCareersJob();
    const browser = fakeBrowser({ [`${H}/jobs/123`]: { ...plainJob('Moved'), finalUrl: `${H}/jobs/moved-1` } });
    const ctx = issueContext({ egressSets: { 'pack:careers-hosts': [HOST, 'other.example.com'] }, contract: job.contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => ({ status: 404, text: async () => '' }), browser }, clock: fixedClock('2026-10-09T00:00:00Z'), signal: new AbortController().signal });
    expect(titles((await job.run(linkOf(`${H}/jobs/123`, { listUrl: `${H}/jobs/` }), ctx)) as RawPosting[])).toEqual(['Moved']);
  });

  it('a site redirecting every job to /maintenance trips the job breaker (it is not gone)', async () => {
    const browser = fakeBrowser({ ...routes, ...Object.fromEntries(forty.map((p) => [`${H}${p}`, { html: '<h1>Down</h1>', finalUrl: `${H}/maintenance` }])) });
    const r = await supervisor(Store.open(':memory:'), browser, []).start('run-m', [req()]);
    expect(r.gone).toBe(0);
    expect(r.queue.failed).toBe(10);
    expect(r.queue.skipped).toBe(30);
  });

  it('"Posted N days ago" inside the anchors changes nothing: over 8 days each link re-renders exactly once after day 1', async () => {
    const seven = forty.slice(0, 7);
    const store = Store.open(':memory:');
    const later: string[] = [];
    for (let d = 0; d < 8; d++) {
      // Half the cards wrap the title in an <h3>; the other half are plain text with the date inline.
      const anchors = seven.map((p, i) => (i % 2 === 0 ? a(p, `<h3>Engineer ${i}</h3><span>Posted ${d + 1} days ago</span>`) : a(p, `Engineer ${i} · Posted ${d + 1} days ago`)));
      const browser = fakeBrowser({ [LIST]: { html: listing(...anchors) }, ...Object.fromEntries(seven.map((p) => [`${H}${p}`, plainJob(`Job ${p}`)])) });
      await supervisor(store, browser, []).start(`posted-${d}`, [req('careers', 'example-careers', `2026-10-${String(9 + d).padStart(2, '0')}`)]);
      if (d > 0) later.push(...browser.calls.map((c) => c.url).filter((u) => u !== LIST));
    }
    expect(later.sort()).toEqual(seven.map((p) => `${H}${p}`).sort());
  });

  it('one employer with 40 gone jobs does not cost another employer a single posting', async () => {
    const ALPHA = 'https://alpha.example.com';
    const BETA = 'https://beta.example.com';
    const alphaLinks = Array.from({ length: 40 }, (_, i) => `/jobs/a${String(i).padStart(2, '0')}`);
    const betaLinks = Array.from({ length: 10 }, (_, i) => `/jobs/b${i}`);
    const browser = fakeBrowser({
      [`${ALPHA}/jobs`]: { html: listing(...alphaLinks.map((p) => a(p))) },
      [`${BETA}/jobs`]: { html: listing(...betaLinks.map((p) => a(p))) },
      ...Object.fromEntries(betaLinks.map((p) => [`${BETA}${p}`, plainJob(`Beta ${p}`)])),
    });
    const registry = new Registry();
    registry.register(makeSrcCareersList());
    registry.register(makeSrcCareersJob());
    const guardrails = builtinGuardrails();
    const watchlist = [
      entry({ company: 'Alpha', slug: 'alpha', listUrl: `${ALPHA}/jobs` }),
      entry({ company: 'Beta', slug: 'beta', listUrl: `${BETA}/jobs` }),
    ];
    const sup = new Supervisor({
      store: Store.open(':memory:'),
      registry,
      compiled: compileWiring(registry, pipeline, guardrails),
      guardrails,
      policy: PRODUCT_POLICY_V1,
      policyHash: policyHash(PRODUCT_POLICY_V1),
      providers: { fetch: async () => ({ status: 404, text: async () => '' }), browser },
      clock: fixedClock('2026-10-09T07:00:00.000Z'),
      sleep: async () => undefined,
      pack: { watchlist },
      packHash: 'pack-ab',
      egressSets: { 'pack:careers-hosts': ['alpha.example.com', 'beta.example.com'] },
    });
    const r = await sup.start('run-ab', [
      { ats: 'careers', slug: 'alpha', company: 'Alpha', runDate: '2026-10-09' },
      { ats: 'careers', slug: 'beta', company: 'Beta', runDate: '2026-10-09' },
    ]);
    expect(r.queue).toMatchObject({ done: 12, failed: 40, skipped: 0 });
    expect(r.gone).toBe(40);
    expect(browser.calls.filter((c) => c.url.startsWith(`${BETA}/jobs/b`))).toHaveLength(10);
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
  type Provider = import('../../src/app/browser/playwright-provider.js').PlaywrightBrowserProvider;
  /** Product timing: used where the test is about the timing itself. */
  let slowProvider: Provider;
  /** Shortened settle timing for everything else. */
  let provider: Provider;

  const two = '<a href="/jobs/a">a</a> <a href="/jobs/b">b</a>';
  const doc = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body><main>${body}</main></body></html>`;
  /** A list filled by script: after `delay` ms, fetch `api` and add one anchor per path. */
  const injector = (api: string, delay = 0) =>
    `<h1>Jobs</h1><div id="list">Loading…</div><script>setTimeout(() => fetch('${api}').then((r) => r.json()).then((js) => { document.getElementById('list').innerHTML = js.map((j) => '<a href="' + j + '">' + j + '</a>').join(' '); }), ${delay});</script>`;
  const loadMore = (pages: number) =>
    `<h1>Jobs</h1><div id="list"><a href="/jobs/p0">p0</a></div><button type="button" id="more">Load more jobs (${pages})</button>
     <script>let n = 0; document.getElementById('more').addEventListener('click', () => { n += 1; setTimeout(() => {
       document.getElementById('list').insertAdjacentHTML('beforeend', '<a href="/jobs/p' + n + '">p' + n + '</a>');
       if (n >= ${pages}) document.getElementById('more').remove(); }, 100); });</script>`;
  const routes: Record<string, (rq: import('node:http').IncomingMessage) => { status?: number; type?: string; body: string; headers?: Record<string, string>; delayMs?: number }> = {
    '/hop': () => ({ status: 302, body: '', headers: { location: '/listing.html' } }),
    '/hop-then-leave': () => ({ status: 301, body: '', headers: { location: '/moved' } }),
    '/moved': () => ({ status: 302, body: '', headers: { location: `http://localhost:${new URL(base).port}/listing.html` } }),
    '/challenge-js': (rq) => ({ status: rq.headers.cookie?.includes('clear=1') ? 200 : 403, body: doc('<p>Checking your browser</p><script>if (!document.cookie.includes("clear=1")) { document.cookie = "clear=1"; setTimeout(() => location.reload(), 100); }</script>') }),
    '/cf-200': () => ({ body: '<!doctype html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt = { cvId: "3" }; document.cookie = "cf_clearance=x"; setTimeout(() => location.reload(), 100);</script></body></html>' }),
    '/recaptcha-job': () => ({ body: doc('<h1>Real Job</h1><p>Great role</p><form action="/apply"><input name="name"><input name="email"><div class="g-recaptcha" data-sitekey="x"></div><p>Protected by reCAPTCHA</p></form>') }),
    '/popup': () => ({ body: doc(`<h1>Popup page</h1><script>window.open("http://localhost:${new URL(base).port}/evil-popup"); window.open("/jobs/backend-engineer");</script>`) }),
    '/autosubmit': () => ({ body: doc('<h1>Consent</h1><form id="f" method="post" action="/posted"><input name="q" value="hello"></form><script>document.getElementById("f").requestSubmit();</script>') }),
    '/timer-listing': () => ({ body: doc(injector('/api/paths', 3000)) }),
    '/api/paths': () => ({ type: 'application/json', body: JSON.stringify(['/jobs/backend-engineer', '/jobs/data-engineer']) }),
    '/slow-listing': () => ({ body: doc(injector('/api/slow')) }),
    '/api/slow': () => ({ type: 'application/json', body: JSON.stringify(['/jobs/backend-engineer', '/jobs/data-engineer']), delayMs: 25_000 }),
    '/growing': () => ({ body: doc('<h1>Jobs</h1><div id="list"></div><script>let i = 0; setInterval(() => { i += 1; document.getElementById("list").insertAdjacentHTML("beforeend", "<a href=\\"/jobs/g" + i + "\\">g</a>"); }, 300);</script>') }),
    '/load-more': () => ({ body: doc(loadMore(2)) }),
    '/load-more-forever': () => ({ body: doc(loadMore(1000)) }),
    '/more-in-form': () => ({ body: doc('<h1>Jobs</h1><a href="/jobs/a">a</a><form action="/search"><input name="q"><button type="button">Load more</button></form>') }),
    '/js-next': () => ({ body: doc('<h1>Jobs</h1><a href="/jobs/a">a</a><nav aria-label="pagination"><button aria-label="next" onclick="void 0"><svg width="10" height="10"></svg></button><button>2</button></nav>') }),
    '/dead-more': () => ({ body: doc('<h1>Jobs</h1><a href="/jobs/a">a</a><button type="button">Show more</button>') }),
    '/empty-listing': () => ({ body: doc('<h1>Jobs</h1><p>No openings right now.</p>') }),
    '/form-attr-get': () => ({ body: doc(`<h1>Jobs</h1>${two}<form id="g" method="get" action="/listing-search"><input name="q" value="x"></form><button type="button" form="g">Show more</button>`) }),
    '/form-attr-post': () => ({ body: doc(`<h1>Jobs</h1>${two}<form id="f" method="post" action="/apply-submit"><input name="email" value="me@x"></form><button form="f">Show more</button>`) }),
    '/in-form-opportunities': () => ({ body: doc(`<h1>Jobs</h1>${two}<form method="get" action="/s"><input name="a"><button type="button" onclick="1">Load more opportunities</button></form>`) }),
    '/submit-type': () => ({ body: doc(`<h1>Jobs</h1>${two}<button type="submit">Show more</button>`) }),
    '/click-post': () => ({ body: doc(`<h1>Jobs</h1>${two}<form id="f" method="post" action="/posted"><input name="q" value="1"></form><button type="button" onclick="document.getElementById('f').requestSubmit()">Load more</button>`) }),
    '/typeless-more': () => ({ body: doc(`<h1>Jobs</h1><div id="l">${two}</div><button onclick="document.getElementById('l').insertAdjacentHTML('beforeend', '<a href=&quot;/jobs/c&quot;>c</a>'); this.remove();">Load more</button>`) }),
    '/reveal-all': () => ({ body: doc(`<h1>Jobs</h1>${two}<div id="more" style="display:none"><a href="/jobs/c">c</a> <a href="/jobs/d">d</a></div><button type="button" onclick="document.getElementById('more').style.display = 'block'; this.remove();">Show all jobs</button>`) }),
    '/show20-untyped': () => ({ body: doc(`<h1>Jobs</h1>${two}<button onclick="1">Show 20 more</button>`) }),
    '/cookie-banner': () => ({ body: doc(`<h1>Jobs</h1>${two}<div class="consent"><button type="button" onclick="fetch('/api/consent', { method: 'POST' })">Show all vendors</button><button type="button">Show all</button></div>`) }),
    '/div-post': () => ({ body: doc(`<h1>Jobs</h1>${two}<div role="button" style="display:inline-block" onclick="fetch('/api/state-change', { method: 'POST' })">Show all</div>`) }),
    '/api/state-change': () => ({ type: 'application/json', body: '{}' }),
    '/show20': () => ({ body: doc(`<h1>Jobs</h1><div id="l">${two}</div><button type="button" onclick="document.getElementById('l').insertAdjacentHTML('beforeend', '<a href=&quot;/jobs/c&quot;>c</a>'); this.remove();">Show 20 more</button>`) }),
    '/infinite': () => ({ body: doc(`<h1>Jobs</h1><div id="l">${two}</div><div style="height:3000px"></div><script>let n = 0; addEventListener('scroll', () => { if (n < 2 && innerHeight + scrollY >= document.body.scrollHeight - 10) { n += 1; document.getElementById('l').insertAdjacentHTML('beforeend', '<a href="/jobs/s' + n + '">s' + n + '</a>'); document.body.insertAdjacentHTML('beforeend', '<div style="height:3000px"></div>'); } });</script>`) }),
    '/slow-job-list': () => ({ body: doc('<h1>Jobs</h1><a href="/jobs/slow">S</a>') }),
    '/jobs/slow': () => ({ body: doc('<div id="j">Loading…</div><script>fetch("/api/slow-desc").then((r) => r.json()).then((d) => { document.getElementById("j").innerHTML = "<h1>" + d.t + "</h1><p>" + d.d + "</p>"; });</script>', '<title>Careers | Acme</title>') }),
    '/slow-job': () => ({ body: doc('<div id="j">Loading…</div><script>fetch("/api/slow-desc").then((r) => r.json()).then((d) => { document.getElementById("j").innerHTML = "<h1>" + d.t + "</h1><p>" + d.d + "</p>"; });</script>', '<title>Careers | Acme</title>') }),
    // I10: subresources, subframes and fetches whose redirect chain ends on a denied brand (linkedin under any suffix).
    '/sub-redirects': () => ({ body: doc('<h1>Subresources</h1><p id="ok">waiting</p><script src="/ok-1.js"></script><script src="/r-1.js"></script><iframe src="/frame-redir"></iframe><script>fetch("/xhr-redir").catch(() => 0);</script>') }),
    '/ok-1.js': () => ({ status: 302, body: '', headers: { location: '/ok-2.js' } }),
    '/ok-2.js': () => ({ status: 302, body: '', headers: { location: '/ok-final.js' } }),
    '/ok-final.js': () => ({ type: 'application/javascript', body: 'document.getElementById("ok").textContent = "loaded via two hops";' }),
    '/r-1.js': () => ({ status: 302, body: '', headers: { location: '/r-2.js' } }),
    '/r-2.js': () => ({ status: 302, body: '', headers: { location: `http://px.linkedin.localhost:${new URL(base).port}/denied.js` } }),
    '/frame-redir': () => ({ status: 302, body: '', headers: { location: `http://www.linkedin.localhost:${new URL(base).port}/denied-frame` } }),
    '/xhr-redir': () => ({ status: 307, body: '', headers: { location: `http://api.linkedin.localhost:${new URL(base).port}/denied-xhr` } }),
    // rereview R4: a SharedWorker's requests bypass context.route; it fetches a denied host directly and via a redirect.
    '/shared-worker': () => ({ body: doc(`<h1>Shared</h1><p id="sw">pending</p><iframe src="/shared-frame"></iframe><script>try { new SharedWorker('/shared.js'); document.getElementById('sw').textContent = 'SharedWorker started'; } catch (e) { document.getElementById('sw').textContent = 'SharedWorker unavailable ' + typeof SharedWorker; } const f = document.createElement('iframe'); document.body.appendChild(f); try { new f.contentWindow.SharedWorker('/shared.js?blank'); document.getElementById('sw').textContent += ' / blank frame worker started'; } catch (e) { document.getElementById('sw').textContent += ' / blank frame has none'; }</script>`) }),
    '/shared-frame': () => ({ body: doc(`<script>try { new SharedWorker('/shared.js?frame'); } catch (e) {}</script>`) }),
    '/shared.js': () => ({ type: 'application/javascript', body: `fetch('/sw-redir').catch(() => 0); fetch('http://direct.linkedin.localhost:' + self.location.port + '/direct').catch(() => 0);` }),
    '/sw-redir': () => ({ status: 302, body: '', headers: { location: `http://shared.linkedin.localhost:${new URL(base).port}/s` } }),
    // rereview-2 M2: careers pages that feature-detect worker APIs and call them synchronously must still render.
    ...Object.fromEntries(Object.entries({
      'inline-sw-register': `if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js'); } FILL`,
      'cra-unregister': `FILL if ('serviceWorker' in navigator) { navigator.serviceWorker.ready.then((r) => r.unregister()); }`,
      'sw-before-render': `if ('serviceWorker' in navigator) { navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())); } FILL`,
      'onload-register': `FILL window.addEventListener('load', () => { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js'); });`,
      'optional-chain': `navigator.serviceWorker?.register('/sw.js').catch(() => 0); FILL`,
      'sharedworker-typeof': `if (typeof SharedWorker !== 'undefined') { new SharedWorker('/noop.js'); } FILL`,
      'sharedworker-in': `if ('SharedWorker' in window) { new SharedWorker('/noop.js'); } FILL`,
      'sw-controller': `if (navigator.serviceWorker.controller) { console.log('controlled'); } FILL`,
    }).map(([name, js]) => [`/worker-shape/${name}`, () => ({ body: doc(`<h1>Careers</h1><ul id="jobs"></ul><script>${js.replace('FILL', `document.getElementById('jobs').innerHTML = '<li><a href="/jobs/backend-engineer">Backend Engineer WORKER-SHAPE-OK</a></li>';`)}</script>`) })])),
    '/sw.js': () => ({ type: 'application/javascript', body: `self.addEventListener('fetch', () => {});` }),
    '/noop.js': () => ({ type: 'application/javascript', body: '' }),
    '/worker-probe': () => ({ body: doc(`<p id="p">pending</p><script>document.getElementById('p').textContent = 'in-window:' + ('SharedWorker' in window);</script>`) }),
    '/api/slow-desc': () => ({ type: 'application/json', body: JSON.stringify({ t: 'Real Title', d: 'Full description' }), delayMs: 25_000 }),
  };

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
      hits.push(`${rq.method} ${rq.headers.host?.split(':')[0]}${path} ${rq.headers['user-agent']} ${rq.headers.accept ?? ''}`);
      const r = routes[path];
      if (r) {
        const out = r(rq);
        setTimeout(() => {
          rs.writeHead(out.status ?? 200, { 'content-type': out.type ?? 'text/html', ...(out.headers ?? {}) });
          rs.end(out.body);
        }, out.delayMs ?? 0);
        return;
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
    slowProvider = new PlaywrightBrowserProvider({ allowInsecureLocalhostForTests: true });
    provider = new PlaywrightBrowserProvider({ allowInsecureLocalhostForTests: true, timing: { pollMs: 200, minSettleMs: 800, settleCapMs: 6_000, jobMinSettleMs: 400, jobSettleCapMs: 6_000 } });
  }, 30_000);

  afterAll(async () => {
    if (!installed) return;
    await provider?.close();
    await slowProvider?.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const render = (url: string, opts: { expand?: boolean; linkPattern?: string | undefined; deniedHosts?: string[]; via?: Provider } = {}) =>
    (opts.via ?? provider).render({
      url, navigationHosts: ['127.0.0.1'], deniedHosts: opts.deniedHosts ?? [], deniedBrands: ['linkedin'], maxBytes: 16_777_216, expand: opts.expand ?? false,
      ...(opts.linkPattern !== undefined ? { linkPattern: opts.linkPattern } : {}), signal: new AbortController().signal,
    });
  const since = (n: number) => hits.slice(n).map((h) => h.split(' ').slice(0, 2).join(' '));
  const agentCtx = (listUrl: string, via: Provider = provider): AgentContext => ({
    clock: fixedClock('2026-10-09T00:00:00Z'),
    signal: new AbortController().signal,
    pack: packOf(entry({ listUrl })),
    browser: { render: (url, o) => render(url, { expand: o?.expand ?? false, linkPattern: o?.linkPattern, deniedHosts: [...PRODUCT_POLICY_V1.deniedEgressHosts], via }) },
    spent: () => ({ usd: 0, inputTokens: 0, outputTokens: 0 }),
    maxCall: () => 0,
    denials: () => [],
    skipped: () => undefined,
    skips: () => [],
  });

  /** src-careers-list, then src-careers-job on each link, over the real provider; the first failure is thrown. */
  const runReal = async (ctx: AgentContext): Promise<RawPosting[]> => {
    const links = (await makeSrcCareersList().run(req(), ctx)) as CareerLink[];
    const job = makeSrcCareersJob();
    const out: RawPosting[] = [];
    for (const l of links) out.push(...((await job.run(l, ctx)) as RawPosting[]));
    return out;
  };

  it.skipIf(!installed)('renders links that JavaScript adds after load, with the honest user-agent, and loads no images', async () => {
    const page = await render(`${base}/listing.html`, { expand: true });
    expect(page).toMatchObject({ status: 200, finalUrl: `${base}/listing.html`, settled: true, expansion: { clicks: 0, scrolls: 0, capReached: false, unfollowedControls: [] } });
    expect(page.html).toContain('href="/jobs/backend-engineer"');
    expect(page.text).toContain('3 roles');
    expect(page.text).not.toContain('About us');
    const listingHit = hits.find((h) => h.startsWith('GET 127.0.0.1/listing.html'));
    expect(listingHit).toContain('jobpilot/0.1 (+local)');
    expect(listingHit).toContain('application/json, text/plain;q=0.8, */*;q=0.1');
    expect(hits.some((h) => h.includes('/logo.png'))).toBe(false);
  }, 30_000);

  it.skipIf(!installed)('returns parsed JSON-LD, and plain pages with none', async () => {
    const withLd = await render(`${base}/jobs/backend-engineer`);
    expect(withLd.jsonLd).toEqual([expect.objectContaining({ '@type': 'JobPosting', title: 'Senior Backend Engineer' })]);
    expect(withLd.settled).toBe(true);
    const plain = await render(`${base}/jobs/data-engineer`);
    expect(plain.jsonLd).toEqual([]);
    expect(plain.text).toContain('Own the data pipeline');
  }, 30_000);

  it.skipIf(!installed)('returns a challenge unrendered: its script never runs, the server sees one GET', async () => {
    for (const [path, status] of [['/challenge-js', 403], ['/cf-200', 200], ['/challenge.html', 200]] as const) {
      const before = hits.length;
      const page = await render(`${base}${path}`);
      await sleep(600); // a reload, had the script run, would land here
      expect(page.status, path).toBe(status);
      expect(challengeReason(page), path).not.toBeNull();
      expect(since(before), path).toEqual([`GET 127.0.0.1${path}`]);
    }
  }, 30_000);

  it.skipIf(!installed)('renders a job page whose apply form carries a reCAPTCHA', async () => {
    const page = await render(`${base}/recaptcha-job`);
    expect(page.html).toContain('Great role');
    expect(challengeReason(page)).toBeNull();
  }, 30_000);

  it.skipIf(!installed)('aborts a redirect to a host outside the navigation hosts and reports where it tried to go', async () => {
    const before = hits.length;
    const page = await render(`${base}/moved`);
    expect(new URL(page.finalUrl).hostname).toBe('localhost');
    expect(page.status).toBe(0);
    expect(since(before)).toEqual(['GET 127.0.0.1/moved']);
  }, 30_000);

  it.skipIf(!installed)('follows a same-host redirect, and still stops a later hop that leaves the navigation hosts', async () => {
    const hop = await render(`${base}/hop`);
    expect(hop).toMatchObject({ status: 200, finalUrl: `${base}/listing.html` });
    const before = hits.length;
    const leave = await render(`${base}/hop-then-leave`);
    expect(new URL(leave.finalUrl).hostname).toBe('localhost');
    expect(since(before)).toEqual(['GET 127.0.0.1/hop-then-leave', 'GET 127.0.0.1/moved']);
  }, 30_000);

  it.skipIf(!installed)('aborts page requests to a denied host', async () => {
    const before = hits.length;
    await render(`${base}/listing.html`, { deniedHosts: ['127.0.0.1'] });
    // The navigation itself is governed by navigationHosts (the broker refuses denied hosts before this point);
    // the page's own fetch of the job list goes to the denied host and is aborted.
    expect(since(before)).toEqual(['GET 127.0.0.1/listing.html']);
  }, 30_000);

  it.skipIf(!installed)('checks every redirect hop of subresources, subframes and fetches: a denied brand is never reached (I10)', async () => {
    const { PlaywrightBrowserProvider } = await import('../../src/app/browser/playwright-provider.js');
    // The denied names resolve to the local server, so a hop the provider let through would be logged below.
    const mapped = new PlaywrightBrowserProvider({
      allowInsecureLocalhostForTests: true,
      resolveToLoopbackForTests: ['px.linkedin.localhost', 'www.linkedin.localhost', 'api.linkedin.localhost'],
      timing: { pollMs: 200, jobMinSettleMs: 400, jobSettleCapMs: 6_000 },
    });
    const before = hits.length;
    const page = await render(`${base}/sub-redirects`, { via: mapped }).finally(() => mapped.close());
    await sleep(800); // anything still following a chain lands here
    const reached = hits.slice(before).filter((h) => /linkedin/.test(h.split(' ')[1] ?? ''));
    expect(reached).toEqual([]);
    // An allowed chain still loads (the hops are followed inside the handler, then fulfilled).
    expect(page.text).toContain('loaded via two hops');
  }, 30_000);

  it.skipIf(!installed)('a page cannot start a SharedWorker, so no denied host is reached through one, directly or via a redirect (rereview R4)', async () => {
    const { PlaywrightBrowserProvider } = await import('../../src/app/browser/playwright-provider.js');
    const mapped = new PlaywrightBrowserProvider({
      allowInsecureLocalhostForTests: true,
      resolveToLoopbackForTests: ['direct.linkedin.localhost', 'shared.linkedin.localhost'],
      timing: { pollMs: 200, jobMinSettleMs: 400, jobSettleCapMs: 6_000 },
    });
    const before = hits.length;
    const page = await render(`${base}/shared-worker`, { via: mapped }).finally(() => mapped.close());
    await sleep(1_000); // a worker that did start would have fetched by now
    const seen = since(before);
    expect(seen.filter((h) => /linkedin/.test(h))).toEqual([]);
    expect(seen.filter((h) => h.includes('/shared.js'))).toEqual([]);
    expect(page.text).toContain('SharedWorker unavailable undefined');
    expect(page.text).toContain('blank frame has none');
  }, 30_000);

  it.skipIf(!installed)('careers pages that feature-detect service or shared workers still render their job list (rereview-2 M2)', async () => {
    const shapes = ['inline-sw-register', 'cra-unregister', 'sw-before-render', 'onload-register', 'optional-chain', 'sharedworker-typeof', 'sharedworker-in', 'sw-controller'];
    const before = hits.length;
    for (const shape of shapes) {
      const page = await render(`${base}/worker-shape/${shape}`);
      expect(page.text, shape).toContain('WORKER-SHAPE-OK');
    }
    await sleep(300);
    // service workers stay blocked by the context and shared workers stay removed: neither script is ever fetched
    expect(since(before).filter((h) => /\/(sw|noop)\.js$/.test(h))).toEqual([]);
  }, 60_000);

  it.skipIf(!installed)('SharedWorker is absent from window, not just undefined (rereview-2 M2)', async () => {
    const page = await render(`${base}/worker-probe`);
    expect(page.text).toContain('in-window:false');
  }, 30_000);

  it.skipIf(!installed)('survives window.open: pop-ups load nothing and the render completes', async () => {
    const before = hits.length;
    const page = await render(`${base}/popup`);
    expect(page.html).toContain('Popup page');
    await sleep(300);
    expect(since(before)).toEqual(['GET 127.0.0.1/popup']);
  }, 30_000);

  it.skipIf(!installed)('refuses a page that submits a form: G-READONLY, and no POST reaches the server', async () => {
    const before = hits.length;
    await expect(render(`${base}/autosubmit`)).rejects.toMatchObject({ code: 'policy_denied', message: expect.stringMatching(/G-READONLY/) });
    expect(since(before)).toEqual(['GET 127.0.0.1/autosubmit']);
  }, 30_000);

  it.skipIf(!installed)('waits for a list a timer adds 3 s after load (product timing)', async () => {
    const page = await render(`${base}/timer-listing`, { expand: true, via: slowProvider });
    expect(page.settled).toBe(true);
    expect(page.html).toContain('href="/jobs/backend-engineer"');
  }, 60_000);

  it.skipIf(!installed)('waits for a list whose API answers after 25 s (product timing)', async () => {
    const page = await render(`${base}/slow-listing`, { expand: true, via: slowProvider });
    expect(page.settled).toBe(true);
    expect(page.html).toContain('href="/jobs/data-engineer"');
  }, 90_000);

  it.skipIf(!installed)('reports a listing still growing at the settle cap as not settled', async () => {
    const page = await render(`${base}/growing`, { expand: true });
    expect(page.settled).toBe(false);
  }, 30_000);

  it.skipIf(!installed)('clicks "load more" until it is gone, never a button in a form, and reports script-only pagers', async () => {
    const more = await render(`${base}/load-more`, { expand: true });
    expect(more.expansion).toEqual({ clicks: 2, scrolls: 0, capReached: false, unfollowedControls: [] });
    expect(more.html).toContain('href="/jobs/p2"');
    const inForm = await render(`${base}/more-in-form`, { expand: true });
    expect(inForm.expansion?.clicks).toBe(0);
    expect(inForm.expansion?.unfollowedControls).toEqual([expect.stringContaining('Load more')]);
    const jsNext = await render(`${base}/js-next`, { expand: true });
    expect(jsNext.expansion?.unfollowedControls).toEqual([expect.stringContaining('aria-label="next"'), expect.stringContaining('>2<')]);
    await expect(render(`${base}/dead-more`, { expand: true })).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/load-more did not add jobs \("Show more"\)/) });
  }, 60_000);

  it.skipIf(!installed)('clicks only safe controls: never one tied to a form, a submit button or a cookie banner; reports them instead', async () => {
    for (const path of ['/form-attr-get', '/form-attr-post', '/in-form-opportunities', '/submit-type']) {
      const before = hits.length;
      const page = await render(`${base}${path}`, { expand: true });
      expect(page.expansion?.clicks, path).toBe(0);
      expect(page.expansion?.unfollowedControls, path).toHaveLength(1);
      expect(since(before), path).toEqual([`GET 127.0.0.1${path}`]);
    }
    const before = hits.length;
    const banner = await render(`${base}/cookie-banner`, { expand: true });
    expect(banner.expansion).toEqual({ clicks: 0, scrolls: 0, capReached: false, unfollowedControls: [] });
    expect(since(before)).toEqual(['GET 127.0.0.1/cookie-banner']);
  }, 60_000);

  it.skipIf(!installed)('clicks a typeless button with no form owner, and a "Show all" that reveals hidden links', async () => {
    const typeless = await render(`${base}/typeless-more`, { expand: true, linkPattern: '^/jobs/' });
    expect(typeless.expansion).toMatchObject({ clicks: 1, unfollowedControls: [] });
    expect(typeless.html).toContain('href="/jobs/c"');
    // Typeless and adding nothing: clicked, then loud.
    await expect(render(`${base}/show20-untyped`, { expand: true, linkPattern: '^/jobs/' })).rejects.toMatchObject({ message: expect.stringMatching(/load-more did not add jobs \("Show 20 more"\)/) });
    const reveal = await render(`${base}/reveal-all`, { expand: true, linkPattern: '^/jobs/' });
    expect(reveal.expansion).toMatchObject({ clicks: 1, capReached: false, unfollowedControls: [] });
  }, 60_000);

  it.skipIf(!installed)('a click whose script submits a POST form fails with G-READONLY, and no POST reaches the server', async () => {
    const before = hits.length;
    await expect(render(`${base}/click-post`, { expand: true, linkPattern: '^/jobs/' })).rejects.toMatchObject({ code: 'policy_denied', message: expect.stringMatching(/G-READONLY/) });
    expect(since(before)).toEqual(['GET 127.0.0.1/click-post']);
  }, 30_000);

  it.skipIf(!installed)('a clicked control that adds no jobs fails loudly (the XHR POST it makes is the page\'s own)', async () => {
    const before = hits.length;
    await expect(render(`${base}/div-post`, { expand: true, linkPattern: '^/jobs/' })).rejects.toMatchObject({ message: expect.stringMatching(/load-more did not add jobs \("Show all"\)/) });
    expect(since(before)).toEqual(['GET 127.0.0.1/div-post', 'POST 127.0.0.1/api/state-change']);
  }, 30_000);

  it.skipIf(!installed)('clicks "Show 20 more", and scrolls an infinite list until it stops growing', async () => {
    const more = await render(`${base}/show20`, { expand: true, linkPattern: '^/jobs/' });
    expect(more.expansion).toMatchObject({ clicks: 1, capReached: false, unfollowedControls: [] });
    expect(more.html).toContain('href="/jobs/c"');
    const scroll = await render(`${base}/infinite`, { expand: true, linkPattern: '^/jobs/' });
    expect(scroll.expansion).toMatchObject({ clicks: 0, scrolls: 2, capReached: false });
    expect(scroll.html).toContain('href="/jobs/s2"');
  }, 60_000);

  it.skipIf(!installed)('the agent fails loudly on "Load more opportunities" inside a form', async () => {
    await expect(runReal(agentCtx(`${base}/in-form-opportunities`))).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/unsupported pagination .*Load more opportunities/) });
  }, 30_000);

  it.skipIf(!installed)('waits for a job description that arrives after 25 s (product timing), and fails loudly at a short cap', async () => {
    const page = await render(`${base}/slow-job`, { via: slowProvider });
    expect(page.settled).toBe(true);
    expect(page.html).toContain('Real Title');
    await expect(runReal(agentCtx(`${base}/slow-job-list`))).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/job page still loading: .*\/jobs\/slow/) });
  }, 90_000);

  it.skipIf(!installed)('stops expanding at the click cap', async () => {
    const { PlaywrightBrowserProvider } = await import('../../src/app/browser/playwright-provider.js');
    const capped = new PlaywrightBrowserProvider({ allowInsecureLocalhostForTests: true, timing: { pollMs: 150, minSettleMs: 450, settleCapMs: 5_000, maxClicks: 3 } });
    try {
      const page = await render(`${base}/load-more-forever`, { expand: true, via: capped });
      expect(page.expansion).toMatchObject({ clicks: 3, capReached: true });
    } finally {
      await capped.close();
    }
  }, 60_000);

  it.skipIf(!installed)('runs the whole agent: listing, then both job pages, JSON-LD and fallback', async () => {
    const postings = await runReal(agentCtx(`${base}/listing.html`));
    expect(postings).toHaveLength(2);
    const byTitle = Object.fromEntries(postings.map((p) => [(p.raw as { title: string }).title, p]));
    expect(byTitle['Senior Backend Engineer']?.raw).toMatchObject({ url: `${base}/jobs/backend-engineer`, jsonLd: expect.objectContaining({ jobLocationType: 'TELECOMMUTE' }) });
    expect(byTitle['Data & Platform Engineer']?.raw).toMatchObject({ url: `${base}/jobs/data-engineer?utm_source=list`, jsonLd: null });
    expect(byTitle['Data & Platform Engineer']?.sourceId).toBe(sha16(`${base}/jobs/data-engineer`));
  }, 60_000);

  it.skipIf(!installed)('the agent fails loudly on a listing with no job links', async () => {
    await expect(runReal(agentCtx(`${base}/empty-listing`))).rejects.toMatchObject({ code: 'invalid_output', message: expect.stringMatching(/no job links found/) });
  }, 30_000);
});
