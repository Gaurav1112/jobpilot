import { decodeEntities, htmlToText } from '../../../text/html.js';
import { LISTING_MAX_PAGES, listingPagesBoard, type ScopedJob } from './listing-pages.js';

/**
 * Freshteam (sources-expansion plan, Task 2): the daily adapter for every verified registry company on
 * `<slug>.freshteam.com`, and the listing parser the verifier's Freshteam client shares. The reference is freehire
 * `internal/ingest/sources/freshteam.go` at commit 3957f7b (MIT, Copyright (c) 2026 freehire contributors), read, not
 * ported.
 *
 * - **Listing:** `GET https://<slug>.freshteam.com/jobs` (and `?page=<n>` while the page links the next one). robots.txt
 *   seen live 2026-10-15: `Allow: /jobs`, `Disallow: /` (job pages are under `/jobs/`, allowed).
 * - **Job pages:** `/jobs/<id12>/<slug>`, the page with the JobPosting JSON-LD, read by `readJobPages`.
 * - `raw` (normalizer mapper `freshteam`, the careers JSON-LD mapping): `{ url, title, jsonLd }`.
 */

export const FRESHTEAM_EGRESS = 'registry:freshteam-hosts';
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ID = /^[A-Za-z0-9_-]{12}$/u;

export const parseFreshteamRef = (ref: string): string | null => (LABEL.test(ref) && !['www', 'app', 'assets', 'cdn'].includes(ref) ? ref : null);
export const freshteamHost = (slug: string): string => `${slug}.freshteam.com`;
export const freshteamListingUrl = (slug: string, n: number): string => (n === 1 ? `https://${slug}.freshteam.com/jobs` : `https://${slug}.freshteam.com/jobs?page=${n}`);

/** The board of a stored board URL: `https://<slug>.freshteam.com/jobs` (any path on the host) → slug. */
export function freshteamBoardOfUrl(boardUrl: string): string | null {
  try {
    const u = new URL(boardUrl);
    if (u.protocol !== 'https:' || u.port !== '') return null;
    const host = u.hostname.toLowerCase();
    return host.endsWith('.freshteam.com') ? parseFreshteamRef(host.slice(0, -'.freshteam.com'.length)) : null;
  } catch {
    return null;
  }
}

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/iu;
const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'iu').exec(tag);
  return m === null ? null : (m[1] ?? m[2] ?? m[3] ?? '');
};
const collapse = (s: string): string => s.replace(/\s+/gu, ' ').trim();

/** `/jobs/<id12>/<slug>` (relative or on `host`): the id and the path, else null. */
function jobPath(href: string, host: string): { id: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(href, `https://${host}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== host) return null;
  // ['', 'jobs', '<id12>', '<slug>']
  const p = u.pathname.split('/');
  if (p.length !== 4 || p[1] !== 'jobs' || !ID.test(p[2] ?? '') || (p[3] ?? '') === '') return null;
  return { id: p[2] as string, path: u.pathname };
}

/**
 * The /jobs listing: each `<a href="/jobs/<id12>/<slug>" … data-portal-location="…" data-portal-remote-location=…>` is
 * one job (title = the `<div class="job-title">` text after it; location = the attribute, entities decoded; remote =
 * the attribute `true`/`false`, else null). `next` = the page links `/jobs?page=<n+1>`. Linear scan over `<a ` tags:
 * each tag's end is one forward `indexOf`, and a card's title is searched only up to its own `</a>` or the next `<a ` tag.
 */
export function parseFreshteamListing(html: string, slug: string, n = 1): { jobs: ScopedJob[]; next: boolean } {
  const host = freshteamHost(slug);
  const jobs: ScopedJob[] = [];
  let next = false;
  const open = /<a\s/giu;
  let o = open.exec(html);
  while (o !== null) {
    const gt = html.indexOf('>', open.lastIndex);
    if (gt < 0) break;
    const tag = html.slice(o.index, gt + 1);
    const m = HREF.exec(tag);
    const href = m === null ? null : decodeEntities((m[1] ?? m[2] ?? '').trim());
    if (href !== null) {
      const path = jobPath(href, host);
      if (path !== null) {
        // The card ends at its `</a>` or at the next `<a ` tag, whichever comes first: segments never overlap.
        open.lastIndex = gt + 1;
        const after = open.exec(html);
        const limit = after === null ? html.length : after.index;
        const seg = html.slice(gt + 1, limit);
        const close = seg.indexOf('</a>');
        const body = close < 0 ? seg : seg.slice(0, close);
        const at = body.indexOf('job-title');
        let title: string | null = null;
        if (at >= 0) {
          const from = body.indexOf('>', at);
          const to = from < 0 ? -1 : body.indexOf('</div>', from);
          if (from >= 0) {
            const t = collapse(htmlToText(body.slice(from + 1, to < 0 ? body.length : to)));
            title = t === '' ? null : t;
          }
        }
        const loc = attr(tag, 'data-portal-location');
        const flag = attr(tag, 'data-portal-remote-location');
        const location = loc === null ? null : collapse(decodeEntities(loc));
        const url = `https://${host}${path.path}`;
        jobs.push({ url, fetchUrl: url, sourceId: path.id, title, location: location === '' ? null : location, remote: flag === 'true' ? true : flag === 'false' ? false : null });
      } else if (href.includes('page=')) {
        try {
          const u = new URL(href, `https://${host}`);
          if (u.hostname.toLowerCase() === host && u.pathname === '/jobs' && u.searchParams.get('page') === String(n + 1)) next = true;
        } catch {
          // not a URL: not a next link
        }
      }
    }
    open.lastIndex = gt + 1;
    o = open.exec(html);
  }
  return { jobs, next };
}

export const freshteam = listingPagesBoard({
  platform: 'freshteam',
  label: 'Freshteam',
  team: 'sourcing-freshteam',
  egress: FRESHTEAM_EGRESS,
  parseRef: parseFreshteamRef,
  hostOf: freshteamHost,
  boardOfUrl: freshteamBoardOfUrl,
  listingUrl: freshteamListingUrl,
  marker: 'data-portal-location',
  parseListing: parseFreshteamListing,
  maxListingPages: LISTING_MAX_PAGES,
});
