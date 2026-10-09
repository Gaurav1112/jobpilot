import { z } from 'zod';
import { defineAgent, type Agent, type AgentContext, type BrowserPage } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import { compileSafePattern } from '../../pack/regex.js';
import { DiscoveryRequest, knownAts, RawPosting } from '../../types.js';
import { checkParsed, finish, isRecord } from './common.js';
import { sha256Hex } from './sha256.js';

/**
 * `src-careers`: a career site without a public job API, read with a real browser so JavaScript-built listings
 * are seen in full. Read-only: it renders the watchlist entry's `listUrl` (following rel=next and same-host
 * "load more" links), collects the job links, renders each one and emits a RawPosting per job. It never clicks,
 * fills or submits anything; the only pages it opens are the URLs it passes to `ctx.browser.render`.
 *
 * Egress is exact-host and comes from the pack: `makeSrcCareers(careersHosts(pack.watchlist))` builds the contract
 * when the pipeline is compiled (Task 11), so the contract lists exactly the watchlist's careers hosts. Adding a
 * careers entry therefore changes the contract's egress (and its hash) on the next compile.
 *
 * Completeness: every limit fails the step loudly (`invalid_output`) rather than returning a partial list: more
 * job links than the page budget, listing pagination past the budget or in a loop, a "load more" control that only
 * a click could follow, or two job links that only a query string tells apart (their ids would collide).
 */

/** Page budget per step: the listing page(s) plus every job page. */
export const CAREERS_MAX_PAGES = 60;
/** The fallback (and JSON-LD description) text kept per posting, in UTF-8 bytes. */
export const CAREERS_TEXT_MAX_BYTES = 50 * 1024;
/** The provider's cap on waiting for one page to settle. */
const RENDER_WAIT_MS = 20_000;
/** PRODUCT_POLICY_V1.minBrowserIntervalMs; agent code may not import the policy, so a test pins the two together. */
export const CAREERS_RENDER_INTERVAL_MS = 10_000;

/** The exact hosts of the watchlist's careers entries, lower-cased, sorted and deduplicated: src-careers's egress. */
export function careersHosts(watchlist: readonly { readonly ats: string; readonly listUrl?: string | undefined }[]): string[] {
  const hosts = new Set<string>();
  for (const w of watchlist) {
    if (w.ats === 'careers' && w.listUrl !== undefined) hosts.add(new URL(w.listUrl).hostname.toLowerCase().replace(/\.+$/, ''));
  }
  return [...hosts].sort();
}

/** Builds `src-careers` for the given careers hosts (see `careersHosts`). */
export function makeSrcCareers(hosts: readonly string[], opts: { readonly maxPages?: number } = {}): Agent<DiscoveryRequest, RawPosting> {
  const egress = [...new Set(hosts.map((h) => h.toLowerCase()))].sort();
  if (egress.length === 0) throw new TypeError('src-careers needs at least one careers host');
  const maxPages = opts.maxPages ?? CAREERS_MAX_PAGES;
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
    // Worst case: every page waits out the browser interval and the full render cap.
    timeoutMs: maxPages * (CAREERS_RENDER_INTERVAL_MS + RENDER_WAIT_MS),
    // A timeout is not retried: a second pass would take as long again.
    retry: { max: 2, on: ['overloaded', 'network'], backoffMs: [2000, 8000] },
  });
  return defineAgent(contract, (req, ctx) => (req.ats === 'careers' ? scan(req, ctx, maxPages) : Promise.resolve([])));
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

/** The default job-link rule, used when the entry has no linkPattern. */
const looksLikeJob = (u: URL): boolean => {
  const p = u.pathname.toLowerCase();
  return p.includes('/job') || p.includes('/jobs/') || p.includes('/careers/') || p.includes('/position');
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
  readonly text: string;
}

function anchorsOf(html: string): Anchor[] {
  const out: Anchor[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attrs = m[1] ?? '';
    out.push({ head: false, href: attr(attrs, 'href'), rel: (attr(attrs, 'rel') ?? '').toLowerCase(), text: htmlToText(m[2] ?? '').replace(/\s+/g, ' ') });
  }
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1] ?? '';
    out.push({ head: true, href: attr(attrs, 'href'), rel: (attr(attrs, 'rel') ?? '').toLowerCase(), text: '' });
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

const LOAD_MORE = /^(load|show|view|see) more( (jobs|positions|roles|openings|results|vacancies))?$/i;

function hasUnfollowableMore(html: string, anchors: readonly Anchor[]): boolean {
  for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button\s*>/gi)) {
    if (LOAD_MORE.test(htmlToText(m[1] ?? '').replace(/\s+/g, ' '))) return true;
  }
  return anchors.some((a) => !a.head && LOAD_MORE.test(a.text) && (a.href === undefined || /^\s*(#|javascript:)/i.test(a.href)));
}

const oneLine = (s: string | undefined): string | undefined => {
  const t = s === undefined ? '' : htmlToText(s).replace(/\s+/g, ' ').trim();
  return t === '' ? undefined : t;
};

/**
 * The page's own title for a job without JSON-LD: the first `<h1>`; failing that `og:title`, then `<title>`
 * (career sites built on page builders often carry the job title only in an h2 and the page metadata).
 */
function pageTitleOf(html: string): string | undefined {
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

interface CareersEntry {
  readonly slug: string;
  readonly listUrl: string;
  readonly linkPattern?: string | undefined;
}

const PackView = z.object({ watchlist: z.array(z.unknown()) });
const EntryView = z.object({ ats: z.literal('careers'), slug: z.string(), listUrl: z.string(), linkPattern: z.string().optional() });

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

async function scan(req: DiscoveryRequest, ctx: AgentContext, maxPages: number): Promise<RawPosting[]> {
  const browser = ctx.browser;
  if (!browser) throw new KernelError('policy_denied', 'no browser capability issued');
  const loud = (why: string) => new KernelError('invalid_output', `careers ${req.slug}: ${why}`);
  const entry = entryOf(ctx.pack, req.slug);
  const pattern = entry.linkPattern !== undefined ? compileSafePattern(entry.linkPattern) : null;
  const list = new URL(entry.listUrl);
  const sameSite = (u: URL): boolean => u.protocol === list.protocol && u.host === list.host;
  const isJob = (u: URL): boolean => (pattern ? pattern.test(u.pathname + u.search) : looksLikeJob(u));

  // 1. The listing, page by page.
  const listingPages = new Set<string>();
  const listingCanonical = new Set<string>();
  const candidates = new Set<string>();
  let next: string | undefined = withoutFragment(list);
  let rendered = 0;
  while (next !== undefined) {
    if (rendered >= maxPages) throw loud(`listing pagination exceeds page budget of ${maxPages}`);
    listingPages.add(next);
    listingCanonical.add(canonicalJobUrl(next));
    const page: BrowserPage = await browser.render(next);
    rendered += 1;
    if (page.status >= 400) throw loud(`listing ${next} returned ${page.status}`);
    const finalUrl = new URL(page.finalUrl);
    listingPages.add(withoutFragment(finalUrl));
    listingCanonical.add(canonicalJobUrl(finalUrl.href));

    const base = baseOf(page.html, page.finalUrl);
    const anchors = anchorsOf(page.html);
    if (hasUnfollowableMore(page.html, anchors)) {
      throw loud('the listing has a "load more" control that only a click could follow; point listUrl at a page that lists every job');
    }
    const nexts = new Set<string>();
    for (const a of anchors) {
      if (a.href === undefined) continue;
      const u = resolveUrl(a.href, base);
      if (!u || !sameSite(u)) continue;
      if (a.rel.split(/\s+/).includes('next') || LOAD_MORE.test(a.text)) nexts.add(withoutFragment(u));
      else if (!a.head) candidates.add(withoutFragment(u));
    }
    for (const href of itemListUrls(page.jsonLd)) {
      const u = resolveUrl(href, base);
      if (u && sameSite(u)) candidates.add(withoutFragment(u));
    }
    if (nexts.size > 1) throw loud(`the listing names ${nexts.size} different next pages: ${[...nexts].sort().join(', ')}`);
    next = [...nexts][0];
    if (next !== undefined && listingPages.has(next)) throw loud(`listing pagination repeats ${next}`);
  }

  // 2. Job links: same host, matching the rule, not a listing page; one URL per canonical job URL.
  const byCanonical = new Map<string, string[]>();
  for (const c of candidates) {
    const u = new URL(c);
    const canon = canonicalJobUrl(c);
    if (listingPages.has(c) || listingCanonical.has(canon) || !isJob(u)) continue;
    byCanonical.set(canon, [...(byCanonical.get(canon) ?? []), c]);
  }
  const clashing = [...byCanonical].filter(([, v]) => v.length > 1).map(([k]) => k).sort();
  if (clashing.length > 0) throw loud(`job links differ only by query string: ${clashing.join(', ')}`);
  const links = [...byCanonical.keys()].sort().map((k) => (byCanonical.get(k) as string[])[0] as string);
  if (links.length > maxPages - rendered) throw loud(`${links.length} job links exceed page budget`);

  // 3. Each job page.
  const postings: RawPosting[] = [];
  const skipped: string[] = [];
  for (const link of links) {
    const page = await browser.render(link);
    if (page.status >= 400) {
      skipped.push(`careers ${req.slug}: ${link} returned ${page.status}`);
      continue;
    }
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
