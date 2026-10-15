import { decodeEntities, htmlToText } from '../../../text/html.js';
import { anchorHrefs } from './pages.js';
import { listingPagesBoard, type ScopedJob } from './listing-pages.js';

/**
 * JazzHR (sources-expansion plan, Task 2): the daily adapter for every verified registry company on
 * `<slug>.applytojob.com`, and the listing parser the verifier's JazzHR client shares. The reference is freehire
 * `internal/ingest/sources/jazzhr.go` at commit 3957f7b (MIT, Copyright (c) 2026 freehire contributors), read, not ported.
 *
 * - **Listing:** `GET https://<slug>.applytojob.com/apply` (robots.txt seen live 2026-10-15: `Disallow: /cb` only). One
 *   page names every job; each `<li class="list-group-item">` is one job card with its title anchor and location.
 * - **Job pages:** `/apply/<token>/<slug>`, the page with the JobPosting JSON-LD, read by `readJobPages`
 *   (`listing-pages.ts`, `pages.ts`): the strict page rule, at most forty pages per company per IST day.
 * - `raw` (normalizer mapper `jazzhr`, the careers JSON-LD mapping): `{ url, title, jsonLd }`.
 */

export const JAZZHR_EGRESS = 'registry:jazzhr-hosts';
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const TOKEN = /^[A-Za-z0-9]{6,16}$/u;

export const parseJazzhrRef = (ref: string): string | null => (LABEL.test(ref) && ref !== 'www' && ref !== 'app' ? ref : null);
export const jazzhrHost = (slug: string): string => `${slug}.applytojob.com`;
export const jazzhrListingUrl = (slug: string): string => `https://${slug}.applytojob.com/apply`;

/** The board of a stored board URL: `https://<slug>.applytojob.com/apply` (any path on the host) → slug. */
export function jazzhrBoardOfUrl(boardUrl: string): string | null {
  try {
    const u = new URL(boardUrl);
    if (u.protocol !== 'https:' || u.port !== '') return null;
    const host = u.hostname.toLowerCase();
    return host.endsWith('.applytojob.com') ? parseJazzhrRef(host.slice(0, -'.applytojob.com'.length)) : null;
  } catch {
    return null;
  }
}

const collapse = (s: string): string => s.replace(/\s+/gu, ' ').trim();

/** `/apply/<token>/<slug>` on `host` (absolute or relative), else null. */
function jobPath(href: string, host: string): { token: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(href, `https://${host}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== host) return null;
  // ['', 'apply', '<token>', '<slug>']
  const p = u.pathname.split('/');
  if (p.length !== 4 || p[1] !== 'apply' || !TOKEN.test(p[2] ?? '') || (p[3] ?? '') === '') return null;
  return { token: p[2] as string, path: u.pathname };
}

/**
 * The text of the first `<a …>` whose href is `href` (entities decoded in the attribute before the comparison),
 * entities decoded, whitespace collapsed; null when blank. Forward scans only.
 */
export function anchorText(html: string, href: string): string | null {
  const open = /<a\s/giu;
  let o = open.exec(html);
  while (o !== null) {
    const gt = html.indexOf('>', open.lastIndex);
    if (gt < 0) return null;
    const mine = anchorHrefs(html.slice(o.index, gt + 1))[0];
    if (mine !== undefined && decodeEntities(mine) === href) {
      const close = html.indexOf('</a>', gt + 1);
      const t = collapse(htmlToText(html.slice(gt + 1, close < 0 ? html.length : close)));
      return t === '' ? null : t;
    }
    open.lastIndex = gt + 1;
    o = open.exec(html);
  }
  return null;
}

/**
 * The /apply listing: each `<li class="list-group-item">` holds one job: the first anchor whose path is
 * `/apply/<token>/<slug>` on the board's host (title = its text) and the text after `fa-map-marker` up to the closing
 * `</li>` (location). Linear: forward `indexOf` from one card marker to the next. One page names every job
 * (`next: false`). sourceId = the token; url = fetchUrl = `https://<host>/apply/<token>/<slug>`.
 */
export function parseJazzhrListing(html: string, slug: string): { jobs: ScopedJob[]; next: boolean } {
  const host = jazzhrHost(slug);
  const jobs: ScopedJob[] = [];
  const CARD = 'class="list-group-item"';
  let at = html.indexOf(CARD);
  while (at >= 0) {
    const nextCard = html.indexOf(CARD, at + CARD.length);
    const card = html.slice(at, nextCard < 0 ? html.length : nextCard);
    const href = anchorHrefs(card).map((h) => decodeEntities(h)).find((h) => jobPath(h, host) !== null);
    const path = href === undefined ? null : jobPath(href, host);
    if (path !== null) {
      const title = anchorText(card, href as string);
      const mk = card.indexOf('fa-map-marker');
      let loc: string | null = null;
      if (mk >= 0) {
        const from = card.indexOf('</i>', mk);
        if (from >= 0) {
          const to = card.indexOf('</li>', from);
          const t = collapse(htmlToText(card.slice(from + 4, to < 0 ? card.length : to)));
          loc = t === '' ? null : t;
        }
      }
      const url = `https://${host}${path.path}`;
      jobs.push({ url, fetchUrl: url, sourceId: path.token, title, location: loc, remote: null });
    }
    at = nextCard;
  }
  return { jobs, next: false };
}

export const jazzhr = listingPagesBoard({
  platform: 'jazzhr',
  label: 'JazzHR',
  team: 'sourcing-jazzhr',
  egress: JAZZHR_EGRESS,
  parseRef: parseJazzhrRef,
  hostOf: jazzhrHost,
  boardOfUrl: jazzhrBoardOfUrl,
  listingUrl: (slug) => jazzhrListingUrl(slug),
  marker: 'class="list-group-item"',
  parseListing: (html, slug) => parseJazzhrListing(html, slug),
  maxListingPages: 1,
});
