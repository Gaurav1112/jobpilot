import { z } from 'zod';
import { defineAgent, type Agent, type AgentContext, type BrowserPage } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import { isMoreLabel } from '../../browser/labels.js';
import { compileSafePattern } from '../../pack/regex.js';
import { CareerLink, DiscoveryRequest, knownAts, RawPosting } from '../../types.js';
import { isRecord } from './common.js';
import { sha256Hex } from './sha256.js';

/**
 * The career-site source, for employers without a public job API, read with a real browser so JavaScript-built
 * listings are seen in full. Two agents, one step per page kind:
 *
 *   DiscoveryRequest@1 (ats careers) -> src-careers-list -> CareerLink@1 (one per job) -> src-careers-job -> RawPosting@1
 *
 * - `src-careers-list` renders the watchlist entry's `listUrl` as a listing (`expand`: the browser waits until the
 *   list stops growing, clicks safe "load more" buttons and scrolls), follows next, "show all" and numbered page
 *   links (at most CAREERS_LIST_MAX_PAGES listing pages), and emits one CareerLink per job link matching the entry's
 *   `linkPattern`, deduplicated and sorted (at most CAREERS_MAX_LINKS).
 * - `src-careers-job` renders one job page and emits one RawPosting. A CareerLink carries no date, so an unchanged
 *   link replays from the store on later days without a new render; a gone job fails its own step, loudly, and
 *   no other.
 *
 * Wiring for Task 11: build both with `makeSrcCareersList(hosts)` / `makeSrcCareersJob(hosts)` where
 * `hosts = careersHosts(pack.watchlist)` (exact hosts, sorted, deduplicated), and route DiscoveryRequest@1 to
 * src-careers-list and CareerLink@1 to src-careers-job. The broker's pacing is per supervisor, so the 10 s between
 * renders of one host holds across the two agents' steps. Adding a careers entry changes both contracts' egress
 * (and hashes) on the next compile. Neither agent fills or submits anything.
 *
 * Completeness: every limit fails loudly (`invalid_output`) rather than returning a partial list: a listing still
 * loading at its settle cap, no job links, a load-more or scroll still adding jobs at its cap, pagination the browser
 * cannot follow, more listing pages or job links than the caps, an ItemList announcing more items than it lists, two
 * job links that only a query string tells apart, and per job: a gone page, a page still loading, an unparsable page.
 */

/** The fallback (and JSON-LD description) text kept per posting, in UTF-8 bytes. */
export const CAREERS_TEXT_MAX_BYTES = 50 * 1024;
/** PRODUCT_POLICY_V1.minBrowserIntervalMs; agent code may not import the policy, so a test pins the two together. */
export const CAREERS_RENDER_INTERVAL_MS = 10_000;

/**
 * Worst-case wall time of one render, from the provider's DEFAULT_TIMING (a test pins them together):
 * - a job page: the browser interval 10 s + navigation 20 s + job settle cap 45 s = 75 s;
 * - a listing page: 10 s + 20 s + listing settle cap 45 s + expansion. The expansion runs clicks and scrolls until
 *   its 150 s budget is spent, and the step that crosses the budget may still take a 5 s click plus a 45 s settle:
 *   150 + 5 + 45 = 200 s. So a listing page is 10 + 20 + 45 + 200 = 275 s.
 */
export const CAREERS_JOB_PAGE_WORST_MS = 10_000 + 20_000 + 45_000;
export const CAREERS_LISTING_PAGE_WORST_MS = 10_000 + 20_000 + 45_000 + 150_000 + 5_000 + 45_000;

/** Listing pages one src-careers-list step reads: 6 x 275 s = 1,650 s, under the 30-minute step cap. */
export const CAREERS_LIST_MAX_PAGES = 6;
/** Job links one listing step may emit. */
export const CAREERS_MAX_LINKS = 5000;
/** src-careers-job: one page at its worst (75 s) plus 15 s for the host pacer and starting a browser context. */
export const CAREERS_JOB_TIMEOUT_MS = CAREERS_JOB_PAGE_WORST_MS + 15_000;

/** The exact hosts of the watchlist's careers entries, lower-cased, sorted and deduplicated: the careers agents' egress. */
export function careersHosts(watchlist: readonly { readonly ats: string; readonly listUrl?: string | undefined }[]): string[] {
  const hosts = new Set<string>();
  for (const w of watchlist) {
    if (w.ats === 'careers' && w.listUrl !== undefined) hosts.add(new URL(w.listUrl).hostname.toLowerCase().replace(/\.+$/, ''));
  }
  return [...hosts].sort();
}

const egressOf = (id: string, hosts: readonly string[]): string[] => {
  const egress = [...new Set(hosts.map((h) => h.toLowerCase()))].sort();
  if (egress.length === 0) throw new TypeError(`${id} needs at least one careers host`);
  return egress;
};

/** Builds `src-careers-list` for the given careers hosts (see `careersHosts`). */
export function makeSrcCareersList(
  hosts: readonly string[],
  opts: { readonly maxListingPages?: number; readonly maxLinks?: number } = {},
): Agent<DiscoveryRequest, CareerLink> {
  const maxListingPages = opts.maxListingPages ?? CAREERS_LIST_MAX_PAGES;
  const maxLinks = opts.maxLinks ?? CAREERS_MAX_LINKS;
  const contract = defineContract({
    id: 'src-careers-list',
    version: '1.0.0',
    description: 'Collects the job links of one career site',
    skills: ['job-sourcing'],
    team: 'sourcing',
    kind: 'io',
    consumes: DiscoveryRequest,
    produces: CareerLink,
    requires: [knownAts],
    capabilities: { browser: { maxPages: maxListingPages }, pack: true },
    egress: egressOf('src-careers-list', hosts),
    dataClasses: { in: ['P0'], out: ['P0'] },
    budget: { usdPerCall: 0, usdPerRun: 0 },
    // Every listing page at its worst; a page count that does not fit 30 minutes fails here, loudly.
    timeoutMs: maxListingPages * CAREERS_LISTING_PAGE_WORST_MS,
    // A timeout is not retried: a second pass would take as long again.
    retry: { max: 2, on: ['overloaded', 'network'], backoffMs: [2000, 8000] },
  });
  return defineAgent(contract, (req, ctx) => (req.ats === 'careers' ? listLinks(req, ctx, maxListingPages, maxLinks) : Promise.resolve([])));
}

/** Builds `src-careers-job` for the given careers hosts (see `careersHosts`). */
export function makeSrcCareersJob(hosts: readonly string[]): Agent<CareerLink, RawPosting> {
  const contract = defineContract({
    id: 'src-careers-job',
    version: '1.0.0',
    description: 'Renders one career-site job page into a posting',
    skills: ['job-sourcing'],
    team: 'sourcing',
    kind: 'io',
    consumes: CareerLink,
    produces: RawPosting,
    capabilities: { browser: { maxPages: 1 } },
    egress: egressOf('src-careers-job', hosts),
    dataClasses: { in: ['P0'], out: ['P0'] },
    budget: { usdPerCall: 0, usdPerRun: 0 },
    timeoutMs: CAREERS_JOB_TIMEOUT_MS,
    retry: { max: 2, on: ['network', 'timeout'], backoffMs: [2000, 8000] },
    // One gone job is that job's failure; a run of them (a site that is down) opens the breaker.
    breaker: { consecutiveFailures: 10 },
  });
  return defineAgent(contract, (link, ctx) => renderJob(link, ctx));
}

// ---- URLs ----

/** A job URL without query string or fragment: the identity of a posting. */
export function canonicalJobUrl(url: string): string {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
}

export const careersSourceId = (url: string): string => sha256Hex(canonicalJobUrl(url)).slice(0, 16);

const withoutFragment = (u: URL): string => {
  const c = new URL(u.href);
  c.hash = '';
  return c.href;
};

// ---- HTML ----

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Visible text of an HTML fragment: block ends become newlines, tags go, entities are decoded, blank runs collapse. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section|article|header|footer)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t\r\f\v\u00A0]+/g, ' ').trim())
    .filter((l) => l !== '')
    .join('\n');
}

/** Keeps at most CAREERS_TEXT_MAX_BYTES of UTF-8, cut on a character boundary. */
function capText(s: string): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= CAREERS_TEXT_MAX_BYTES) return s;
  return new TextDecoder().decode(bytes.subarray(0, CAREERS_TEXT_MAX_BYTES)).replace(/\uFFFD+$/, '');
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  if (!m) return undefined;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

interface Anchor {
  /** A `<link>` in the head: used only as a rel=next pointer, never as a job link. */
  readonly head: boolean;
  readonly href: string | undefined;
  readonly rel: string;
  /** The visible text, else aria-label, else title. */
  readonly label: string;
}

function anchorsOf(html: string): Anchor[] {
  const out: Anchor[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attrs = m[1] ?? '';
    const text = htmlToText(m[2] ?? '').replace(/\s+/g, ' ').trim();
    const label = text !== '' ? text : (attr(attrs, 'aria-label') ?? attr(attrs, 'title') ?? '').trim();
    out.push({ head: false, href: attr(attrs, 'href'), rel: (attr(attrs, 'rel') ?? '').toLowerCase(), label });
  }
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1] ?? '';
    out.push({ head: true, href: attr(attrs, 'href'), rel: (attr(attrs, 'rel') ?? '').toLowerCase(), label: '' });
  }
  return out;
}

function baseOf(html: string, pageUrl: string): string {
  const m = /<base\b([^>]*)>/i.exec(html);
  const href = m ? attr(m[1] ?? '', 'href') : undefined;
  if (href === undefined) return pageUrl;
  try {
    return new URL(href, pageUrl).href;
  } catch {
    return pageUrl;
  }
}

const resolveUrl = (href: string, base: string): URL | null => {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
};

/** An anchor label that means "more of this list" (the shared rule in src/app/browser/labels.ts), counts allowed. */
export function isNextLabel(label: string): boolean {
  return isMoreLabel(label);
}

/** Query parameters that number the pages of a listing; a sibling URL differs from a listing page only in these. */
const PAGING = ['page', 'start', 'offset'] as const;
const FIRST: Readonly<Record<string, string>> = { page: '1', start: '0', offset: '0' };

/**
 * The page-position key of a listing URL: origin, path and non-paging query, plus the paging parameters with the
 * first-page values (page=1, start=0, offset=0) dropped, so `/jobs` and `/jobs?page=1` are one page.
 */
function pagingKey(u: URL): { base: string; key: string; paged: boolean } {
  const other = new URLSearchParams();
  const paging: string[] = [];
  let paged = false;
  for (const [k, v] of [...u.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if ((PAGING as readonly string[]).includes(k.toLowerCase()) && /^\d+$/.test(v)) {
      paged = true;
      if (FIRST[k.toLowerCase()] !== v) paging.push(`${k.toLowerCase()}=${v}`);
    } else other.append(k, v);
  }
  const base = `${u.origin}${u.pathname}?${other.toString()}`;
  return { base, key: `${base}|${paging.join('&')}`, paged };
}

const oneLine = (s: string | undefined): string | undefined => {
  const t = s === undefined ? '' : htmlToText(s).replace(/\s+/g, ' ').trim();
  return t === '' ? undefined : t;
};

/**
 * The page's own title for a job without JSON-LD: the first `<h1>`; failing that `og:title`, then `<title>`
 * (career sites built on page builders often carry the job title only in an h2 and the page metadata).
 */
function pageTitleOf(rawHtml: string): string | undefined {
  // Script and template text is not the page's title, even when it holds an <h1> string.
  const html = rawHtml.replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const h1 = oneLine(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1]);
  if (h1 !== undefined) return h1;
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = m[1] ?? '';
    if ((attr(attrs, 'property') ?? attr(attrs, 'name'))?.toLowerCase() === 'og:title') {
      const og = oneLine(attr(attrs, 'content'));
      if (og !== undefined) return og;
    }
  }
  return oneLine(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1]);
}

// ---- JSON-LD ----

const hasType = (o: Record<string, unknown>, t: string): boolean =>
  o['@type'] === t || (Array.isArray(o['@type']) && o['@type'].includes(t));

/** Every JSON-LD node, depth first in document order: arrays, `@graph` and nested objects are walked. */
function* nodes(v: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 20) return;
  if (Array.isArray(v)) {
    for (const x of v) yield* nodes(x, depth + 1);
  } else if (isRecord(v)) {
    yield v;
    for (const x of Object.values(v)) if (typeof x === 'object' && x !== null) yield* nodes(x, depth + 1);
  }
}

export function findJobPosting(jsonLd: readonly unknown[]): Record<string, unknown> | null {
  for (const n of nodes(jsonLd)) if (hasType(n, 'JobPosting')) return n;
  return null;
}

function itemListUrls(jsonLd: readonly unknown[]): string[] {
  const urls: string[] = [];
  for (const n of nodes(jsonLd)) {
    if (!hasType(n, 'ItemList') || !Array.isArray(n.itemListElement)) continue;
    for (const el of n.itemListElement) {
      if (typeof el === 'string') urls.push(el);
      else if (isRecord(el)) {
        const item = el.item;
        const u = typeof el.url === 'string' ? el.url : typeof item === 'string' ? item : isRecord(item) ? (typeof item.url === 'string' ? item.url : item['@id']) : undefined;
        if (typeof u === 'string') urls.push(u);
      }
    }
  }
  return urls;
}

// ---- the scan ----

/** "at 45 s" when the provider reports its cap, else "at its settle cap". */
const capOf = (page: BrowserPage): string => (page.settleCapMs !== undefined ? `at ${Math.round(page.settleCapMs / 1000)} s` : 'at its settle cap');

interface CareersEntry {
  readonly slug: string;
  readonly listUrl: string;
  readonly linkPattern: string;
}

const PackView = z.object({ watchlist: z.array(z.unknown()) });
const EntryView = z.object({ ats: z.literal('careers'), slug: z.string(), listUrl: z.string(), linkPattern: z.string() });

function entryOf(pack: unknown, slug: string): CareersEntry {
  const fail = (why: string) => new KernelError('invalid_output', `careers ${slug}: ${why}`);
  const view = PackView.safeParse(pack);
  if (!view.success) throw fail('no watchlist in the pack');
  const matches = view.data.watchlist.flatMap((w) => {
    const e = EntryView.safeParse(w);
    return e.success && e.data.slug === slug ? [e.data] : [];
  });
  if (matches.length === 0) throw fail('no careers entry in the watchlist');
  if (matches.length > 1) throw fail('more than one careers entry has this slug');
  return matches[0] as CareersEntry;
}

/** ItemLists that announce more items (`numberOfItems`) than they list. */
function shortItemLists(jsonLd: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const n of nodes(jsonLd)) {
    if (!hasType(n, 'ItemList')) continue;
    const listed = Array.isArray(n.itemListElement) ? n.itemListElement.length : 0;
    const total = typeof n.numberOfItems === 'number' ? n.numberOfItems : typeof n.numberOfItems === 'string' ? Number(n.numberOfItems) : Number.NaN;
    if (Number.isFinite(total) && total > listed) out.push(`${listed} of ${total}`);
  }
  return out;
}

/** Template syntax left in a title: the page never rendered it. */
const UNRENDERED = /\{\{|"\+|\$\{|<%/;
/** A body that is only a loading placeholder. */
const LOADING = /^loading(…|\.{3})?$/i;

async function listLinks(req: DiscoveryRequest, ctx: AgentContext, maxListingPages: number, maxLinks: number): Promise<CareerLink[]> {
  const browser = ctx.browser;
  if (!browser) throw new KernelError('policy_denied', 'no browser capability issued');
  const loud = (why: string) => new KernelError('invalid_output', `careers ${req.slug}: ${why}`);
  const entry = entryOf(ctx.pack, req.slug);
  const pattern = compileSafePattern(entry.linkPattern);
  const list = new URL(entry.listUrl);
  const sameSite = (u: URL): boolean => u.protocol === list.protocol && u.host === list.host;

  // 1. The listing, page by page: next/"show all" links and numbered siblings, breadth first.
  const rendered = new Set<string>(); // listing URLs rendered or landed on (no fragment)
  const listingCanonical = new Set<string>();
  const positions = new Set<string>(); // pagingKey().key of every listing page rendered or queued
  const listingBases = new Set<string>(); // pagingKey().base of every listing page
  const candidates = new Set<string>();
  const queue: string[] = [withoutFragment(list)];
  positions.add(pagingKey(list).key);
  listingBases.add(pagingKey(list).base);
  let renders = 0;
  while (queue.length > 0) {
    const url = queue.shift() as string;
    if (renders >= maxListingPages) throw loud(`listing pagination exceeds ${maxListingPages} listing pages`);
    rendered.add(url);
    listingCanonical.add(canonicalJobUrl(url));
    const page: BrowserPage = await browser.render(url, { expand: true, linkPattern: entry.linkPattern });
    renders += 1;
    if (page.status >= 400) throw loud(`listing ${url} returned ${page.status}`);
    if (!page.settled) throw loud(`listing still loading ${capOf(page)} (${url})`);
    const ex = page.expansion;
    if (ex?.capReached) throw loud(`"load more" still adding jobs after ${ex.clicks} clicks and ${ex.scrolls} scrolls on ${url}`);
    if (ex && ex.unfollowedControls.length > 0) throw loud(`unsupported pagination on ${url}: ${ex.unfollowedControls.slice(0, 3).join(' | ')}`);
    const short = shortItemLists(page.jsonLd);
    if (short.length > 0) throw loud(`the listing's ItemList shows only ${short.join(', ')} items`);
    const finalUrl = new URL(page.finalUrl);
    rendered.add(withoutFragment(finalUrl));
    listingCanonical.add(canonicalJobUrl(finalUrl.href));
    positions.add(pagingKey(finalUrl).key);
    listingBases.add(pagingKey(finalUrl).base);

    const base = baseOf(page.html, page.finalUrl);
    const enqueue = (u: URL): void => {
      const k = pagingKey(u).key;
      if (positions.has(k)) return;
      positions.add(k);
      listingBases.add(pagingKey(u).base);
      queue.push(withoutFragment(u));
    };
    for (const a of anchorsOf(page.html)) {
      if (a.href === undefined) continue;
      const u = resolveUrl(a.href, base);
      if (!u || !sameSite(u)) continue;
      const here = withoutFragment(u);
      const isRelNext = a.rel.split(/\s+/).includes('next');
      if (isRelNext && rendered.has(here) && here !== url && here !== withoutFragment(finalUrl)) throw loud(`listing pagination repeats ${here}`);
      const pk = pagingKey(u);
      if (isRelNext || (!a.head && isNextLabel(a.label))) enqueue(u);
      else if (pk.paged && listingBases.has(pk.base)) enqueue(u); // a numbered sibling: ?page=N, ?start=N, ?offset=N
      else if (!a.head) candidates.add(here);
    }
    for (const href of itemListUrls(page.jsonLd)) {
      const u = resolveUrl(href, base);
      if (u && sameSite(u)) candidates.add(withoutFragment(u));
    }
  }

  // 2. Job links: same host, matching linkPattern, not a listing page; one URL per canonical job URL.
  const byCanonical = new Map<string, string[]>();
  for (const c of candidates) {
    const u = new URL(c);
    const canon = canonicalJobUrl(c);
    if (rendered.has(c) || positions.has(pagingKey(u).key) || listingCanonical.has(canon) || !pattern.test(u.pathname + u.search)) continue;
    byCanonical.set(canon, [...(byCanonical.get(canon) ?? []), c]);
  }
  const clashing = [...byCanonical].filter(([, v]) => v.length > 1).map(([k]) => k).sort();
  if (clashing.length > 0) throw loud(`job links differ only by query string: ${clashing.join(', ')}`);
  const links = [...byCanonical.keys()].sort().map((k) => (byCanonical.get(k) as string[])[0] as string);
  if (links.length === 0) throw loud(`no job links found on ${entry.listUrl} (linkPattern ${entry.linkPattern})`);
  if (links.length > maxLinks) throw loud(`${links.length} job links exceed the cap of ${maxLinks}`);
  return links.map((url) => ({ company: req.company, slug: req.slug, listUrl: entry.listUrl, url, linkPattern: entry.linkPattern }));
}

/** Renders one job page. Anything that keeps it from being a complete posting fails this job's step, loudly. */
async function renderJob(link: CareerLink, ctx: AgentContext): Promise<RawPosting[]> {
  const browser = ctx.browser;
  if (!browser) throw new KernelError('policy_denied', 'no browser capability issued');
  const loud = (why: string) => new KernelError('invalid_output', `careers ${link.slug}: ${why}`);
  const u = new URL(link.url);
  const list = new URL(link.listUrl);
  if (u.protocol !== list.protocol || u.host !== list.host) throw loud(`job link ${link.url} is not on the listing's host`);
  if (!compileSafePattern(link.linkPattern).test(u.pathname + u.search)) throw loud(`job link ${link.url} does not match linkPattern ${link.linkPattern}`);

  const page = await browser.render(link.url);
  if (page.status >= 400) throw loud(`job page ${link.url} returned ${page.status} (gone?)`);
  if (!page.settled) throw loud(`job page still loading: ${link.url}`);
  if (canonicalJobUrl(page.finalUrl) === canonicalJobUrl(link.listUrl)) throw loud(`job page ${link.url} redirected to the listing (closed?)`);
  const jobPosting = findJobPosting(page.jsonLd);
  const ldTitle = jobPosting && typeof jobPosting.title === 'string' ? htmlToText(jobPosting.title).replace(/\s+/g, ' ').trim() : '';
  const title = ldTitle !== '' ? ldTitle : pageTitleOf(page.html);
  if (title === undefined) throw loud(`job page ${link.url} has no JobPosting title, h1, og:title or title`);
  const text = capText(jobPosting ? htmlToText(typeof jobPosting.description === 'string' ? jobPosting.description : '') : page.text);
  if (UNRENDERED.test(title) || LOADING.test(text.trim())) throw loud(`job page ${link.url} looks unrendered (title "${title.slice(0, 40)}")`);
  return [
    {
      source: 'careers',
      sourceId: careersSourceId(link.url),
      company: link.company,
      slug: link.slug,
      raw: { url: link.url, jsonLd: jobPosting, title, text },
    },
  ];
}
