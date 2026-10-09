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
 * - `src-careers-job` renders one job page and emits one RawPosting. A CareerLink carries no date, only a staggered
 *   refresh epoch (see `refreshEpoch`) and a normalised title key (see `titleKeyOf`), so an unchanged link replays
 *   from the store on most days and re-renders once a week, or the day after it is retitled. A gone job (404, 410,
 *   or a redirect from the job page to the listing or the site root) fails its own step with `gone`, which never
 *   trips a breaker, so no other job or employer is affected. Any other off-pattern redirect (a login wall,
 *   maintenance, a locale move) is `invalid_output`, which does count towards the breaker.
 *   Task 8: a re-rendered link re-emits a RawPosting with the same sourceId; the projector must treat it as a newer
 *   version of that posting (upsert), not a duplicate.
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

/** Days between two renders of an unchanged job link (the staggered refresh period). */
export const CAREERS_REFRESH_DAYS = 7;

/** Days since 1970-01-01 of a YYYY-MM-DD run date (the IST calendar date the run is for). */
export function dayNumber(runDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(runDate);
  if (!m) throw new KernelError('invalid_output', `run date ${runDate} is not YYYY-MM-DD`);
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

/**
 * The refresh epoch of a job link on a run date: `floor((dayNumber + bucket) / 7)`, where the bucket (0-6) comes
 * from the URL's hash. It advances exactly once in any 7 consecutive days, and different links advance on
 * different days, so re-renders spread evenly over the week.
 */
export function refreshEpoch(url: string, runDate: string): number {
  const bucket = Number.parseInt(sha256Hex(url).slice(0, 8), 16) % CAREERS_REFRESH_DAYS;
  return Math.floor((dayNumber(runDate) + bucket) / CAREERS_REFRESH_DAYS);
}

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
    // A gone job (`gone`) never counts; other failures in a row (a site that is down) open the breaker.
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
  /** The anchor's inner HTML. */
  readonly inner: string;
}

function anchorsOf(html: string): Anchor[] {
  const out: Anchor[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attrs = m[1] ?? '';
    const text = htmlToText(m[2] ?? '').replace(/\s+/g, ' ').trim();
    const label = text !== '' ? text : (attr(attrs, 'aria-label') ?? attr(attrs, 'title') ?? '').trim();
    out.push({ head: false, href: attr(attrs, 'href'), rel: (attr(attrs, 'rel') ?? '').toLowerCase(), label, inner: m[2] ?? '' });
  }
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1] ?? '';
    out.push({ head: true, href: attr(attrs, 'href'), rel: (attr(attrs, 'rel') ?? '').toLowerCase(), label: '', inner: '' });
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

/** Relative-time and badge words that change from day to day without the job changing. "remote" is kept. */
const BADGE_WORDS = new Set([
  'posted', 'updated', 'reposted', 'promoted', 'ago', 'new', 'hot', 'today', 'yesterday', 'just', 'now', 'day', 'days',
  'hour', 'hours', 'week', 'weeks', 'month', 'months', 'minute', 'minutes', 'featured', 'urgent', 'actively', 'closing', 'soon',
]);

/** The first title element inside an anchor's HTML: an h1-h6, or an element whose class contains "title" or itemprop is title. */
function titleElementText(inner: string): string | undefined {
  const found: { at: number; html: string }[] = [];
  const h = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(inner);
  if (h) found.push({ at: h.index, html: h[2] ?? '' });
  for (const m of inner.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const attrs = m[2] ?? '';
    if (!/title/i.test(attr(attrs, 'class') ?? '') && (attr(attrs, 'itemprop') ?? '').toLowerCase() !== 'title') continue;
    const close = new RegExp(`</${m[1]}\\s*>`, 'i').exec(inner.slice((m.index ?? 0) + m[0].length));
    if (close) found.push({ at: m.index ?? 0, html: inner.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + close.index) });
    break;
  }
  found.sort((x, y) => x.at - y.at);
  const t = found[0] ? htmlToText(found[0].html).trim() : '';
  return t === '' ? undefined : t;
}

/**
 * A stable key for a job link's title, used only to notice a retitle (never shown). The title element inside the
 * anchor when there is one, else the anchor text; then NFKC, lower-case, digits and punctuation dropped, the
 * relative-time and badge words dropped, whitespace collapsed, at most 200 characters. Its only failure mode is a
 * missed retitle, which the weekly refresh catches.
 */
export function titleKeyOf(innerHtml: string): string {
  const text = (titleElementText(innerHtml) ?? htmlToText(innerHtml)).normalize('NFKC').toLowerCase();
  return text
    .replace(/[^\p{L}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '' && !BADGE_WORDS.has(w))
    .join(' ')
    .slice(0, 200);
}

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
  const titleKeys = new Map<string, string>(); // job link -> the titleKey of its first anchor with one, in document order
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
      else if (!a.head) {
        candidates.add(here);
        const key = titleKeyOf(a.inner) || titleKeyOf(a.label);
        if (key !== '' && !titleKeys.has(here)) titleKeys.set(here, key);
      }
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
  return links.map((url) => ({
    company: req.company,
    slug: req.slug,
    listUrl: entry.listUrl,
    url,
    linkPattern: entry.linkPattern,
    titleKey: titleKeys.get(url) ?? '',
    refresh: refreshEpoch(url, req.runDate),
  }));
}

/** Two URL paths are the same page, ignoring case and a trailing slash. */
const samePath = (a: string, b: string): boolean => {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p).toLowerCase() || '/';
  return norm(a) === norm(b);
};

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
  const gone = (why: string) => new KernelError('gone', `careers ${link.slug}: ${why}`);
  if (page.status === 404 || page.status === 410) throw gone(`job page ${link.url} returned ${page.status}`);
  if (page.status >= 400) throw loud(`job page ${link.url} returned ${page.status}`);
  // A redirect that leaves the job pages is a closed job only when it lands on the listing (any query: a listing
  // page, an "expired" flag) or the site root. Anything else (a login wall, maintenance, a locale move) is not proof
  // the job closed, so it is invalid_output and counts towards the breaker.
  const final = new URL(page.finalUrl);
  const target = `${final.pathname}${final.search}`;
  if (withoutFragment(final) !== withoutFragment(u) && !compileSafePattern(link.linkPattern).test(target)) {
    if (samePath(final.pathname, list.pathname)) throw gone(`job page ${link.url} redirected to the listing (${target}): the job closed`);
    if (samePath(final.pathname, '/')) throw gone(`job page ${link.url} redirected to the site root (${target}): the job closed`);
    throw loud(`job page ${link.url} redirected to ${target}, outside linkPattern ${link.linkPattern}; if the site moved its job pages (a locale prefix, for example), widen linkPattern`);
  }
  if (!page.settled) throw loud(`job page still loading: ${link.url}`);
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
