import { defineAgent, type Agent, type AgentContext } from '../../../../kernel/agent.js';
import { defineContract } from '../../../../kernel/contract.js';
import { KernelError } from '../../../../kernel/errors.js';
import { isChallenge } from '../../../challenge.js';
import { decodeEntities } from '../../../text/html.js';
import { countriesIn } from '../../../text/norm.js';
import { DiscoveryRequest, knownAts, RawPosting } from '../../../types.js';
import { finish } from '../common.js';
import { memoryPageState, PAGE_MAX_FETCHES, PAGE_MAX_HOPS, PAGE_MIN_INTERVAL_MS, prefilter, readJobPages, type ListedJob } from './pages.js';
import { hostRequest, refusal, titlePackOf, type HttpTool, type PlatformHosts } from './shared.js';
import type { SrcPageOptions } from './icims.js';

/**
 * SAP SuccessFactors Career Site Builder (career-sites spec §4, Task 8): the daily adapter for every verified registry
 * company on an RMK careers site (HCLTech's `careers.hcltech.com`), and the code the verifier's client shares.
 *
 * A board is the site's host (the ref, the slug the platform detector names for an RMK site; its board URL
 * `https://<host>/sitemal.xml`). The legacy `career<N>.successfactors.*` boards (`<host>/<company>`) have no reader
 * here: their registry rows are left out of the daily run (`registryBoards`), as any unreadable board is.
 *
 * **Listing: `sitemal.xml`**, an undocumented full-catalogue RSS with Google Base tags (`title`, `description`, `link`,
 * `g:id`, `g:location` (a country code, or a place), `g:employer`; no posted date, no remote flag). Robots.txt allows it
 * (HCLTech disallows `/services/`, never read). It is STREAMED (`http.getStream`, `capabilities.httpStream`) and parsed
 * linearly, item by item (`sitemalParser`), never held whole, under SF_SITEMAL_MAX_BYTES (50 MB, the brief's cap): a
 * feed over it (or a `content-length` over it) is refused loudly (`listing-cap <company>: sitemal.xml passed its N-byte
 * cap; nothing read, never truncated`, `input_rejected`). Seen live 2026-10-14: HCLTech's feed is 78.9 MB (14,576
 * items) and took 209 s, so HCLTech hits this cap every day until the cap is decided otherwise. A body that is not an
 * RSS feed is refused by name; items without a title or a link are counted (`malformed-entries`); a feed of nothing else
 * is refused. 404/410 is `gone`; the strict page rule of `pages.ts` governs the request (robots.txt, refusals).
 *
 * **Postings:** the title pre-filter runs on the feed's titles; items whose `g:location` names a country other than
 * India are not read (`not-india <company>: N listed jobs located outside India not read`; by design, as Workday's and
 * Oracle's scopes). An item WITH a location is a posting straight from the feed (title, description HTML, location;
 * `postedAt` null): no page fetch, no page budget (decision 6: the page fetch is required only when the listing has no
 * location). An item WITHOUT a location is read from its job page (`link`), JobPosting JSON-LD, under the page budget,
 * rotation and keep-alive of `pages.ts`, redirects followed on the host (`/job/<title>/<id>/` moves to
 * `/job/<title>/<n>-en_US/`, seen live). Seen live: HCLTech's job pages carry microdata, not JSON-LD, so such an item
 * would be named `no-jobposting`, never guessed (every HCLTech item has a location).
 *
 * `raw` (normalizer mapper `successfactors`): `{ title, url, id, location, employer, description, jsonLd }`, `jsonLd`
 * null for a feed posting (then `description` is the item's HTML and `location` its `g:location`), or the kept
 * JobPosting for a page posting (then the careers JSON-LD mapping applies and `description`/`location` are null).
 */

export const SF_EGRESS = 'registry:successfactors-hosts';
/** The brief's cap on `sitemal.xml` (decoded bytes): over it the read fails loudly. */
export const SF_SITEMAL_MAX_BYTES = 50 * 1024 * 1024;
/** The feed request's own timeout (HCLTech's 79 MB took 209 s live). */
export const SF_STREAM_TIMEOUT_MS = 420_000;
export const SF_TIMEOUT_MS = 900_000;
/** robots.txt, the feed, and every job page with its redirects. */
export const SF_MAX_REQUESTS = 2 + PAGE_MAX_FETCHES * (1 + PAGE_MAX_HOPS);

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

/** The site host of a ref; null when it is not a bare host (a legacy `<host>/<company>` board). */
export function parseSuccessFactorsRef(ref: string): string | null {
  return HOST.test(ref) ? ref : null;
}

/** The site of a stored board URL: `https://<host>/sitemal.xml` only. */
export function successFactorsBoardOfUrl(boardUrl: string): string | null {
  try {
    const u = new URL(boardUrl);
    return u.protocol === 'https:' && u.port === '' && u.pathname === '/sitemal.xml' ? parseSuccessFactorsRef(u.hostname.toLowerCase()) : null;
  } catch {
    return null;
  }
}

export const sitemalUrl = (host: string): string => `https://${host}/sitemal.xml`;

export interface SitemalItem {
  readonly title: string;
  readonly link: string;
  readonly id: string;
  /** `g:location` (a country code, or a place); null when absent. */
  readonly location: string | null;
  readonly employer: string | null;
  /** The description HTML (often escaped once more, as HCLTech's is); empty when absent. */
  readonly description: string;
}

export interface SitemalResult {
  readonly items: readonly SitemalItem[];
  /** Items without a title or an https link. */
  readonly malformed: number;
  /** Whether the document opened as an RSS feed (`<rss` or `<channel` in its first 4 KB). */
  readonly sawFeed: boolean;
}

const unwrap = (v: string): string => {
  const t = v.trim();
  return t.startsWith('<![CDATA[') && t.endsWith(']]>') ? t.slice('<![CDATA['.length, -']]>'.length) : decodeEntities(t);
};

/** The text of the first `<name>…</name>` in `t` (forward searches only); null when absent. */
function tag(t: string, name: string): string | null {
  const a = t.indexOf(`<${name}>`);
  if (a < 0) return null;
  const b = t.indexOf(`</${name}>`, a);
  return b < 0 ? null : unwrap(t.slice(a + name.length + 2, b));
}

function parseItem(t: string): SitemalItem | null {
  // the description first, so nothing inside it is read as another field
  const d0 = t.indexOf('<description>');
  const d1 = d0 < 0 ? -1 : t.indexOf('</description>', d0);
  const description = d0 >= 0 && d1 >= 0 ? unwrap(t.slice(d0 + '<description>'.length, d1)) : '';
  const rest = d0 >= 0 && d1 >= 0 ? t.slice(0, d0) + t.slice(d1 + '</description>'.length) : t;
  const title = tag(rest, 'title')?.replace(/\s+/g, ' ').trim() ?? '';
  const link = tag(rest, 'link')?.trim() ?? '';
  if (title === '' || !link.startsWith('https://')) return null;
  const gid = tag(rest, 'g:id')?.trim() ?? '';
  const id = /^[A-Za-z0-9_-]{1,40}$/u.test(gid) ? gid : (/(\d{3,})\/?$/u.exec(link)?.[1] ?? '');
  if (id === '') return null;
  const location = tag(rest, 'g:location')?.trim() || null;
  const employer = tag(rest, 'g:employer')?.trim() || null;
  return { title, link, id, location, employer, description };
}

/**
 * The streaming parser of a sitemal feed: `feed` each decoded chunk as it arrives, `result` at the end. Linear: the
 * buffer holds at most one unfinished item; `<item>` and `</item>` are found by forward searches that resume where the
 * last one stopped; each finished item is parsed once and dropped from the buffer.
 */
export function sitemalParser(): { feed(text: string): void; result(): SitemalResult; count(): number } {
  let buf = '';
  let scanFrom = 0;
  let head = '';
  const items: SitemalItem[] = [];
  let malformed = 0;
  const drain = (): void => {
    for (;;) {
      const s = buf.indexOf('<item>');
      if (s < 0) {
        buf = buf.slice(Math.max(0, buf.length - 5));
        scanFrom = 0;
        return;
      }
      const e = buf.indexOf('</item>', Math.max(s + 6, scanFrom));
      if (e < 0) {
        buf = buf.slice(s);
        scanFrom = Math.max(6, buf.length - 6);
        return;
      }
      const item = parseItem(buf.slice(s + 6, e));
      if (item === null) malformed++;
      else items.push(item);
      buf = buf.slice(e + 7);
      scanFrom = 0;
    }
  };
  return {
    feed(text) {
      if (head.length < 4096) head += text.slice(0, 4096 - head.length);
      buf += text;
      drain();
    },
    result: () => ({ items: [...items], malformed, sawFeed: /<rss[\s>]|<channel[\s>]/iu.test(head) }),
    count: () => items.length,
  };
}

export const parseSitemal = (xml: string): SitemalResult => {
  const p = sitemalParser();
  p.feed(xml);
  return p.result();
};

export interface ReadSitemalOptions {
  readonly maxBytes: number;
  /** Stop once this many items are parsed (the verifier reads the first one only). */
  readonly stopAfter?: number;
  readonly timeoutMs?: number;
}

/** The site's feed, streamed under the host rules (robots.txt, refusals) and the byte cap. */
export async function readSitemal(http: HttpTool, hosts: PlatformHosts, host: string, company: string, o: ReadSitemalOptions): Promise<SitemalResult> {
  const url = sitemalUrl(host);
  const parser = sitemalParser();
  const onText = (t: string): boolean => {
    parser.feed(t);
    return o.stopAfter === undefined || parser.count() < o.stopAfter;
  };
  const r = await hostRequest(http, hosts, host, url, () => http.getStream(url, onText, { maxBytes: o.maxBytes, minIntervalMs: PAGE_MIN_INTERVAL_MS, ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }) }));
  if (isChallenge(r.status, r.body ?? '')) {
    hosts.disable(host, 'challenge');
    throw new KernelError('challenged', `${host} answered sitemal.xml with a challenge page (${r.status}): the host is disabled for this run, never retried around`);
  }
  if (r.status === 429) {
    hosts.disable(host, 'http-429');
    throw new KernelError('rate_limit', `429 from ${host}: the host is disabled for this run, never retried around`);
  }
  if (r.status >= 500) throw new KernelError('overloaded', `${r.status} from ${host}`);
  if (r.status === 404 || r.status === 410) throw new KernelError('gone', `successfactors ${host}: sitemal.xml answered ${r.status}`);
  if (r.status < 200 || r.status >= 300) throw new KernelError('input_rejected', `successfactors ${company}: sitemal.xml answered ${r.status}${r.location === null ? '' : ` (to ${r.location.slice(0, 80)})`}; nothing read`);
  if (r.capped) throw new KernelError('input_rejected', `listing-cap ${company}: sitemal.xml passed its ${o.maxBytes}-byte cap; nothing read, never truncated`);
  const res = parser.result();
  if (!res.sawFeed && res.items.length === 0) throw new KernelError('input_rejected', `successfactors ${company}: sitemal.xml is not a sitemal feed (no <rss> or <channel>); nothing read`);
  if (res.items.length === 0 && res.malformed > 0 && !r.stopped) throw new KernelError('input_rejected', `successfactors ${company}: all ${res.malformed} sitemal items lack a title or a link; nothing read`);
  return res;
}

/** Whether a `g:location` names India (`IN`, or an Indian place), another country, or nothing known. */
export function sitemalCountry(location: string | null): 'india' | 'other' | 'unknown' {
  if (location === null || location.trim() === '') return 'unknown';
  const last = location.split(',').map((p) => p.trim()).pop() ?? '';
  if (/^[A-Z]{2}$/u.test(last)) return last === 'IN' ? 'india' : 'other';
  const named = countriesIn(location);
  return named.includes('india') ? 'india' : named.length > 0 ? 'other' : 'unknown';
}

export interface SuccessFactorsRaw {
  readonly title: string;
  readonly url: string;
  readonly id: string;
  readonly location: string | null;
  readonly employer: string | null;
  readonly description: string | null;
  readonly jsonLd: Record<string, unknown> | null;
}

export const srcSuccessFactorsContract = defineContract({
  id: 'src-successfactors',
  version: '1.0.0',
  description: 'Reads one verified SuccessFactors careers site\'s sitemal feed, streamed under a fifty megabyte cap, with job pages only for items without a location',
  skills: ['job-sourcing'],
  team: 'sourcing-successfactors',
  kind: 'io',
  consumes: DiscoveryRequest,
  produces: RawPosting,
  requires: [knownAts],
  capabilities: { http: true, httpStream: true, pack: true },
  egress: [SF_EGRESS],
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: SF_TIMEOUT_MS,
  retry: { max: 1, on: ['overloaded', 'network'], backoffMs: [8000] },
});

export interface SrcSuccessFactorsOptions extends SrcPageOptions {
  /** The feed's byte cap (tests); never above SF_SITEMAL_MAX_BYTES. */
  readonly maxBytes?: number;
}

async function runCompany(req: DiscoveryRequest, ctx: AgentContext, o: Required<SrcSuccessFactorsOptions>): Promise<RawPosting[]> {
  const http = ctx.http;
  if (!http) throw new KernelError('policy_denied', 'no http capability issued');
  const host = parseSuccessFactorsRef(req.slug);
  if (host === null) throw new KernelError('invalid_output', `successfactors: ${req.slug} is not a Career Site Builder host`);
  const pack = titlePackOf(ctx.pack, 'src-successfactors');
  try {
    const feed = await readSitemal(http, o.hosts, host, req.company, { maxBytes: o.maxBytes, timeoutMs: SF_STREAM_TIMEOUT_MS });
    if (feed.malformed > 0) ctx.skipped([`malformed-entries ${req.company}: ${feed.malformed} sitemal items without a title or a link`]);
    const byId = new Map<string, SitemalItem>();
    let outside = 0;
    for (const i of feed.items) {
      if (sitemalCountry(i.location) === 'other') outside++;
      else if (!byId.has(i.id)) byId.set(i.id, i);
    }
    const listed: ListedJob[] = [...byId.values()].map((i) => ({ url: i.link, title: i.title, sourceId: i.id, fetchUrl: i.link }));
    const passing = prefilter(listed, pack, req.company, ctx);
    if (outside > 0) ctx.skipped([`not-india ${req.company}: ${outside} listed jobs located outside India not read`]);
    const fromFeed: RawPosting[] = [];
    const needPage: ListedJob[] = [];
    for (const j of passing) {
      const i = byId.get(j.sourceId) as SitemalItem;
      if (i.location === null) {
        needPage.push(j);
        continue;
      }
      const raw: SuccessFactorsRaw = { title: i.title, url: i.link, id: i.id, location: i.location, employer: i.employer, description: i.description, jsonLd: null };
      fromFeed.push({ source: 'successfactors', sourceId: i.id, company: req.company, slug: req.slug, raw });
    }
    const fromPages = await readJobPages({
      http,
      hosts: o.hosts,
      ctx,
      company: req.company,
      board: `successfactors ${host}`,
      runDate: req.runDate,
      jobs: needPage,
      listed: new Set(needPage.map((j) => j.url)),
      state: o.state,
      max: o.maxPages,
      source: 'successfactors',
      slug: req.slug,
      follow: (u) => u.hostname.toLowerCase() === host,
      toRaw: (j, jsonLd): SuccessFactorsRaw => ({ title: typeof jsonLd.title === 'string' ? jsonLd.title.trim() : j.title ?? '', url: j.url, id: j.sourceId, location: null, employer: byId.get(j.sourceId)?.employer ?? null, description: null, jsonLd }),
    });
    return finish([...fromFeed, ...fromPages]);
  } catch (e) {
    refusal(e, req.company, ctx);
    return [];
  }
}

/** Builds `src-successfactors` for one run, on the run's host state and the page state. */
export function makeSrcSuccessFactors(o: SrcSuccessFactorsOptions): Agent<DiscoveryRequest, RawPosting> {
  const opts: Required<SrcSuccessFactorsOptions> = {
    hosts: o.hosts,
    state: o.state ?? memoryPageState(),
    maxPages: Math.min(o.maxPages ?? PAGE_MAX_FETCHES, PAGE_MAX_FETCHES),
    maxBytes: Math.min(o.maxBytes ?? SF_SITEMAL_MAX_BYTES, SF_SITEMAL_MAX_BYTES),
  };
  return defineAgent(srcSuccessFactorsContract, (req, ctx) => (req.ats === 'successfactors' ? runCompany(req, ctx, opts) : Promise.resolve([])));
}
