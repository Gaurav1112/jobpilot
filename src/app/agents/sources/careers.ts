import { z } from 'zod';
import { defineAgent, type Agent, type AgentContext, type BrowserPage } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import { isMoreLabel } from '../../browser/labels.js';
import { compileSafePattern } from '../../pack/regex.js';
import { DiscoveryRequest, knownAts, RawPosting } from '../../types.js';
import { checkParsed, finish, isRecord } from './common.js';
import { sha256Hex } from './sha256.js';

/**
 * `src-careers`: a career site without a public job API, read with a real browser so JavaScript-built listings
 * are seen in full. Read-only: it renders the watchlist entry's `listUrl` as a listing (`expand`: the browser waits
 * until the list stops growing and clicks same-page "load more" buttons), follows every same-host next, "show all"
 * and numbered page link, collects the job links matching the entry's `linkPattern`, renders each job page and emits
 * a RawPosting per job. It never fills or submits anything.
 *
 * Egress is exact-host and comes from the pack: `makeSrcCareers(careersHosts(pack.watchlist))` builds the contract
 * when the pipeline is compiled (Task 11), so the contract lists exactly the watchlist's careers hosts. Adding a
 * careers entry therefore changes the contract's egress (and its hash) on the next compile.
 *
 * Completeness: every limit fails the step loudly (`invalid_output`) rather than returning a partial list: a listing
 * still loading at the settle cap, a listing with no job links, a load-more still present after the click cap,
 * pagination the browser cannot follow, pagination past the page budget or in a loop, an ItemList that announces
 * more items than it lists, more job links than the page budget, a job page that never settles, or two job links
 * that only a query string tells apart (their ids would collide).
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

/**
 * Page budget per step, sized so the worst case fits the kernel's 30-minute step cap:
 * 2 listing pages x 275 s + 16 job pages x 75 s = 550 + 1,200 = 1,750 s (29 min 10 s) <= 1,800 s.
 * So one step reads at most 2 listing pages and 18 pages in all (17 jobs from a single-page listing, 16 from a
 * two-page one); a larger site fails loudly rather than being cut short.
 */
export const CAREERS_MAX_PAGES = 18;
export const CAREERS_MAX_LISTING_PAGES = 2;

/** The step timeout for a page budget: every listing page and every other page at its worst case. */
export const careersTimeoutMs = (maxPages: number, maxListingPages: number): number =>
  maxListingPages * CAREERS_LISTING_PAGE_WORST_MS + (maxPages - maxListingPages) * CAREERS_JOB_PAGE_WORST_MS;

/** The exact hosts of the watchlist's careers entries, lower-cased, sorted and deduplicated: src-careers's egress. */
export function careersHosts(watchlist: readonly { readonly ats: string; readonly listUrl?: string | undefined }[]): string[] {
  const hosts = new Set<string>();
  for (const w of watchlist) {
    if (w.ats === 'careers' && w.listUrl !== undefined) hosts.add(new URL(w.listUrl).hostname.toLowerCase().replace(/\.+$/, ''));
  }
  return [...hosts].sort();
}

/** Builds `src-careers` for the given careers hosts (see `careersHosts`). */
export function makeSrcCareers(
  hosts: readonly string[],
  opts: { readonly maxPages?: number; readonly maxListingPages?: number } = {},
): Agent<DiscoveryRequest, RawPosting> {
  const egress = [...new Set(hosts.map((h) => h.toLowerCase()))].sort();
  if (egress.length === 0) throw new TypeError('src-careers needs at least one careers host');
  const maxPages = opts.maxPages ?? CAREERS_MAX_PAGES;
  const maxListingPages = Math.min(opts.maxListingPages ?? CAREERS_MAX_LISTING_PAGES, maxPages);
  const contract = defineContract({
    id: 'src-careers',
    version: '1.0.0',
    description: 'Renders one career site to collect its job postings',
    skills: ['job-sourcing'],
    team: 'sourcing',
    kind: 'io',
    consumes: DiscoveryRequest,
    produces: RawPosting,
    requires: [knownAts],
    capabilities: { browser: { maxPages }, pack: true },
    egress,
    dataClasses: { in: ['P0'], out: ['P0'] },
    budget: { usdPerCall: 0, usdPerRun: 0 },
    // Worst case of every page (see CAREERS_MAX_PAGES); a budget that does not fit 30 minutes fails here, loudly.
    timeoutMs: careersTimeoutMs(maxPages, maxListingPages),
    // A timeout is not retried: a second pass would take as long again.
    retry: { max: 2, on: ['overloaded', 'network'], backoffMs: [2000, 8000] },
  });
  return defineAgent(contract, (req, ctx) => (req.ats === 'careers' ? scan(req, ctx, maxPages, maxListingPages) : Promise.resolve([])));
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

/** The provider's listing settle cap (src/app/browser): a listing still changing after it fails the step. */
export const LISTING_SETTLE_CAP_S = 45;

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

async function scan(req: DiscoveryRequest, ctx: AgentContext, maxPages: number, maxListingPages: number): Promise<RawPosting[]> {
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
    if (!page.settled) throw loud(`listing still loading at ${LISTING_SETTLE_CAP_S} s (${url})`);
    const ex = page.expansion;
    if (ex?.capReached) throw loud(`"load more" still present after ${ex.clicks} clicks on ${url}`);
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
  if (links.length > maxPages - renders) throw loud(`${links.length} job links exceed page budget`);

  // 3. Each job page.
  const postings: RawPosting[] = [];
  const skipped: string[] = [];
  for (const link of links) {
    const page = await browser.render(link);
    if (page.status >= 400) {
      skipped.push(`careers ${req.slug}: ${link} returned ${page.status}`);
      continue;
    }
    if (!page.settled) throw loud(`job page still loading: ${link}`);
    if (listingCanonical.has(canonicalJobUrl(page.finalUrl))) {
      skipped.push(`careers ${req.slug}: ${link} redirected to the listing`);
      continue;
    }
    const jobPosting = findJobPosting(page.jsonLd);
    const ldTitle = jobPosting && typeof jobPosting.title === 'string' ? htmlToText(jobPosting.title).replace(/\s+/g, ' ').trim() : '';
    const title = ldTitle !== '' ? ldTitle : pageTitleOf(page.html);
    if (title === undefined) {
      skipped.push(`careers ${req.slug}: ${link} has no JobPosting title, h1, og:title or title`);
      continue;
    }
    const text = capText(jobPosting ? htmlToText(typeof jobPosting.description === 'string' ? jobPosting.description : '') : page.text);
    if (UNRENDERED.test(title) || LOADING.test(text.trim())) {
      skipped.push(`careers ${req.slug}: ${link} looks unrendered (title "${title.slice(0, 40)}")`);
      continue;
    }
    postings.push({
      source: 'careers',
      sourceId: careersSourceId(link),
      company: req.company,
      slug: req.slug,
      raw: { url: link, jsonLd: jobPosting, title, text },
    });
  }
  return finish(checkParsed('careers', links.length, { postings, skipped }).postings);
}
