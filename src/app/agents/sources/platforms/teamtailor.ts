import { z } from 'zod';
import { childText, children, parseXml, XmlError, type XmlNode } from '../../../text/xml-lite.js';
import type { RawPosting } from '../../../types.js';
import { feedBoard, feedProblem, plainHttps, httpsUrl, sortedNames, textOf, type FeedPage } from './feed-board.js';

/**
 * Teamtailor (career-sites spec §4, Task 9): the board's RSS feed, `GET https://<host>/jobs.rss` with `Accept:
 * application/rss+xml` (the broker's one alternative Accept; without it Teamtailor answered 400, seen live). A board is
 * its host (`<slug>.teamtailor.com` or the company's own domain, the ref and the DiscoveryRequest slug, as the platform
 * detector names it). One request returns every job (no paging). Teamtailor's official API needs a key, so the RSS
 * feed is the public path; it is not documented as an API, so the strict page rule applies: robots.txt once per host
 * per run (seen live: it disallows `/app/ /messages/ /jobs/internal/` and one bot; the feed is allowed).
 *
 * The feed is read with the linear XML reader (`text/xml-lite.ts`). A document that is not RSS (no `<rss>`/`<channel>`)
 * is a page-level problem. An `<item>` needs a title, a link and a guid, else it is skipped with a note. `raw`
 * (normalizer mapper `teamtailor`): `{ guid, title, url, pubDate, remoteStatus, locations: [{ name, city, country }],
 * department, role, description }`; `pubDate` is ISO (RFC 822 converted), the office street address and zip are
 * dropped, `description` is the escaped HTML decoded once. `sourceId` = the guid. The channel `<title>` is the company
 * name the verifier compares.
 */

export const TEAMTAILOR_EGRESS = 'registry:teamtailor-hosts';
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){1,6}$/u;

export function parseTeamtailorRef(ref: string): string | null {
  if (!HOST.test(ref) || ref.startsWith('www.') || /^\d+(?:\.\d+){3}$/u.test(ref)) return null;
  return ref;
}
export const teamtailorUrl = (host: string): string => `https://${host}/jobs.rss`;

export function teamtailorBoardOfUrl(boardUrl: string): string | null {
  const u = plainHttps(boardUrl);
  return u !== null && u.pathname === '/jobs.rss' ? parseTeamtailorRef(u.hostname.toLowerCase()) : null;
}

const Item = z.object({
  guid: z.string().min(1, 'no guid'),
  title: z.string().refine((t) => t.trim() !== '', 'blank title'),
  link: z.string().refine((l) => httpsUrl(l) !== null, 'no link'),
});

const iso = (v: string | null): string | null => {
  if (v === null) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export function parseTeamtailor(body: string, host: string, req: { company: string; slug: string }): FeedPage {
  const what = `teamtailor ${host}`;
  let rss: XmlNode;
  try {
    rss = parseXml(body);
  } catch (e) {
    if (e instanceof XmlError) throw feedProblem(what, `the response is not an XML feed (${e.message})`);
    throw e;
  }
  const channel = rss.name === 'rss' ? children(rss, 'channel')[0] : undefined;
  if (channel === undefined) throw feedProblem(what, 'the response is not an RSS feed (no <rss><channel>)');
  const items = children(channel, 'item');
  const postings: RawPosting[] = [];
  const malformed: string[] = [];
  items.forEach((it, i) => {
    const r = Item.safeParse({ guid: childText(it, 'guid') ?? '', title: childText(it, 'title') ?? '', link: childText(it, 'link') ?? '' });
    if (!r.success) return void malformed.push(`entry ${i}: ${r.error.issues[0]?.message ?? 'invalid'}`);
    const locs = children(children(it, 'tt:locations')[0] ?? { name: '', text: '', children: [] }, 'tt:location');
    const raw = {
      guid: r.data.guid,
      title: r.data.title.trim(),
      url: httpsUrl(r.data.link),
      pubDate: iso(childText(it, 'pubDate')),
      remoteStatus: textOf(childText(it, 'remoteStatus')),
      locations: locs.map((l) => ({ name: textOf(childText(l, 'tt:name')), city: textOf(childText(l, 'tt:city')), country: textOf(childText(l, 'tt:country')) })),
      department: textOf(childText(it, 'tt:department')),
      role: textOf(childText(it, 'tt:role')),
      description: textOf(childText(it, 'description')),
    };
    postings.push({ source: 'teamtailor', sourceId: r.data.guid, company: req.company, slug: req.slug, raw });
  });
  return { postings, malformed, listed: items.length, names: sortedNames([textOf(childText(channel, 'title'))]), total: null };
}

export const teamtailor = feedBoard<string>({
  platform: 'teamtailor',
  label: 'Teamtailor',
  team: 'sourcing-teamtailor',
  egress: TEAMTAILOR_EGRESS,
  documented: false,
  fixedHost: null,
  parseRef: parseTeamtailorRef,
  refOf: (s) => s,
  hostOf: (s) => s,
  urlOf: teamtailorUrl,
  boardOfUrl: teamtailorBoardOfUrl,
  accept: 'application/rss+xml',
  parse: (body, host, req) => parseTeamtailor(body, host, req),
});
export const srcTeamtailorContract = teamtailor.contract;
export const makeSrcTeamtailor = teamtailor.make;
