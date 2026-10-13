import { defineAgent, type AgentContext } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { KernelError } from '../../kernel/errors.js';
import type { EgressSets } from '../../kernel/broker.js';
import { platformForHost } from './platform-hosts.js';
import { parseRobots, robotsDenial, type RobotsVerdict } from './robots.js';
import { registrableDomain } from './seed.js';
import { CareersSite, CompanyCandidate } from './types.js';

/**
 * The careers locator (spec §3): for one candidate company, find its careers URL by fixed probes, first hit wins:
 *   1. the candidate's own `careersUrl`, if it answers 2xx                          -> `listed`
 *   2. the homepage's first matching `<a>` (document order) on the company's domain or a known platform host
 *      (the link is taken as found, not fetched)                                    -> `homepage-link`
 *   3. `/careers`, `/jobs`, `/company/careers`, `/about/careers` on the website host -> `path`
 *   4. `https://careers.<domain>/`, `https://jobs.<domain>/`                         -> `subdomain`
 *   5. `/sitemap.xml`, then the sitemaps named in robots.txt: the first `<loc>` whose path has `/careers` or `/jobs` -> `sitemap`
 *   6. otherwise `none`, `careersUrl: null`, with the reason of every miss.
 *
 * Politeness: each host's robots.txt is fetched once per candidate (all hosts of a candidate share its registrable
 * domain, and a candidate is one step), and every probe honours it. A missing robots.txt (4xx) allows all; 5xx or
 * unreachable disallows all for the run (RFC 9309). The honest user agent and the 2 s per-host spacing are the
 * broker's (HTTP_HEADERS, the supervisor's host pacer). A challenge page (or a 429) is a stop for that host: no
 * retry, no more probes. A 4xx on the homepage ends the search.
 *
 * Redirects are followed by hand, at most 5 hops, and only by fetching hosts this module planned for (see
 * `locatorHosts`, which the app turns into the egress set); a redirect to any other host of the company's registrable
 * domain, or to a known platform host, ends the probe as a hit on that Location, unfetched. Any other redirect is a miss.
 */

export const MAX_HOPS = 5;
export const CAREERS_PATHS = ['/careers', '/jobs', '/company/careers', '/about/careers'] as const;
export const CAREERS_SUBDOMAINS = ['careers', 'jobs'] as const;

/** Text or href of a link that suggests a careers page. */
export const CAREERS_LINK = /\b(careers?|jobs|join (?:us|our team)|work with us|open positions)\b/i;
const SITEMAP_LOC = /\/careers|\/jobs/i;

/** Status codes that may carry a bot wall; with a marker in the body they are a challenge (a closed list, never extended at run time). */
const CHALLENGE_STATUS: ReadonlySet<number> = new Set([403, 429, 503]);
const CHALLENGE_MARKERS = /cf-chl|challenge-platform|captcha|Attention Required|px-captcha/i;

/** A challenge page: 403/429/503 with a known marker in the body. */
export function isChallenge(status: number, body: string): boolean {
  return CHALLENGE_STATUS.has(status) && CHALLENGE_MARKERS.test(body);
}

const hostOf = (u: string): string | null => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/\.+$/u, '');
  } catch {
    return null;
  }
};

/** `https://host/...` for an http(s) URL string; null otherwise. A bare scheme-less value is not guessed. */
function asHttps(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.protocol = 'https:';
  u.hash = '';
  return u;
}

/** Every host the locator may contact for a candidate: the website, its apex and www, careers./jobs. subdomains, and the listed careersUrl's. */
export function locatorHosts(c: CompanyCandidate): string[] {
  const out = new Set<string>();
  const web = asHttps(c.website);
  const listed = c.careersUrl === null ? null : asHttps(c.careersUrl);
  if (web !== null && web.port === '') {
    const key = registrableDomain(web.hostname);
    out.add(web.hostname.toLowerCase());
    if (key !== null) for (const h of [key, `www.${key}`, ...CAREERS_SUBDOMAINS.map((s) => `${s}.${key}`)]) out.add(h);
  }
  if (listed !== null && listed.port === '') out.add(listed.hostname.toLowerCase());
  return [...out].sort();
}

/** The egress set for a run: the union of `locatorHosts` over the candidates. */
export function locatorEgressSets(candidates: readonly CompanyCandidate[]): EgressSets {
  return { 'pack:careers-hosts': [...new Set(candidates.flatMap(locatorHosts))].sort() };
}

const decodeEntities = (s: string): string => s.replace(/&amp;/gi, '&').replace(/&#38;/g, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export interface FoundLink {
  readonly url: string;
  readonly text: string;
}

/**
 * The first `<a href>` (document order) whose text or href matches CAREERS_LINK and that resolves, against `base`, to
 * an http(s) URL accepted by `accept`. `mailto:`, `tel:`, `javascript:` and `#` links are skipped.
 */
export function findCareersLink(html: string, base: string, accept: (u: URL) => boolean): FoundLink | null {
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (const m of html.matchAll(anchor)) {
    const attrs = m[1] ?? '';
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
    const raw = decodeEntities((href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim());
    if (raw === '' || raw.startsWith('#') || /^(mailto|tel|javascript):/i.test(raw)) continue;
    const text = stripTags(m[2] ?? '');
    if (!CAREERS_LINK.test(text) && !CAREERS_LINK.test(raw)) continue;
    let u: URL;
    try {
      u = new URL(raw, base);
    } catch {
      continue;
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !accept(u)) continue;
    u.hash = '';
    return { url: u.href, text: text.slice(0, 60) };
  }
  return null;
}

/** The `<loc>` values of a sitemap, in document order. */
export function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeEntities(m[1] ?? ''));
}

type Fetched =
  | { readonly kind: 'ok'; readonly status: number; readonly body: string; readonly url: string }
  | { readonly kind: 'moved'; readonly url: string }
  | { readonly kind: 'miss'; readonly reason: string }
  | { readonly kind: 'challenge'; readonly reason: string };

export const careersLocatorContract = defineContract({
  id: 'careers-locator',
  version: '1.0.0',
  description: 'Finds a candidate company\'s careers URL by fixed probes that honour robots.txt',
  skills: ['careers-locator'],
  team: 'coverage',
  kind: 'io',
  consumes: CompanyCandidate,
  produces: CareersSite,
  capabilities: { http: true },
  egress: ['pack:careers-hosts'],
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 120_000,
  retry: { max: 0, on: [], backoffMs: [] },
});

export const careersLocator = defineAgent(careersLocatorContract, async (c, ctx) => [await locate(c, ctx)]);

async function locate(c: CompanyCandidate, ctx: AgentContext): Promise<CareersSite> {
  if (!ctx.http) throw new KernelError('policy_denied', 'no http capability issued');
  const http = ctx.http;
  const planned = new Set(locatorHosts(c));
  const reasons: string[] = [];
  const robots = new Map<string, RobotsVerdict>();

  const web = asHttps(c.website);
  const siteKey = web === null ? null : registrableDomain(web.hostname);
  const onCompanyDomain = (u: URL): boolean => (siteKey !== null && registrableDomain(u.hostname) === siteKey) || platformForHost(u.hostname) !== null;

  const found = (method: CareersSite['method'], careersUrl: string, evidence: string): CareersSite => ({ candidate: c, careersUrl, method, evidence, ...(reasons.length > 0 ? { reasons } : {}) });
  const none = (): CareersSite => ({ candidate: c, careersUrl: null, method: 'none', evidence: null, reasons: reasons.length > 0 ? reasons : ['no probe applied'] });

  /** One request with up to MAX_HOPS manual redirects. `checkRobots` is off only for robots.txt itself. */
  async function fetchUrl(start: string, checkRobots: boolean): Promise<Fetched> {
    let url = start;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const u = asHttps(url);
      if (u === null) return { kind: 'miss', reason: `not an http(s) URL: ${url.slice(0, 80)}` };
      if (u.port !== '' || u.username !== '' || u.password !== '') return { kind: 'miss', reason: `port or credentials in URL: ${u.hostname}` };
      const host = u.hostname.toLowerCase();
      if (!planned.has(host)) {
        if (hop > 0 && onCompanyDomain(u)) return { kind: 'moved', url: u.href };
        return { kind: 'miss', reason: hop > 0 ? `redirect to ${host} (off-domain)` : `${host} is not a planned host` };
      }
      if (checkRobots) {
        const verdict = await robotsFor(host);
        const denial = robotsDenial(verdict, u);
        if (denial !== null) return denial === 'challenge' ? { kind: 'challenge', reason: `challenge on ${host}` } : { kind: 'miss', reason: `${denial} (${host})` };
      }
      let page;
      try {
        page = await http.getPage(u.href);
      } catch (e) {
        if (e instanceof KernelError) return { kind: 'miss', reason: `${e.code}: ${u.hostname}${u.pathname}` };
        throw e;
      }
      if (isChallenge(page.status, page.body) || page.status === 429) {
        robots.set(host, { kind: 'challenge', why: `status ${page.status}` });
        return { kind: 'challenge', reason: page.status === 429 && !isChallenge(page.status, page.body) ? `rate-limited (429) on ${host}` : `challenge (${page.status}) on ${host}` };
      }
      if (page.status >= 300 && page.status < 400) {
        if (page.location === null) return { kind: 'miss', reason: `${page.status} without Location (${host}${u.pathname})` };
        try {
          url = new URL(page.location, u).href;
        } catch {
          return { kind: 'miss', reason: `bad redirect Location (${host}${u.pathname})` };
        }
        continue;
      }
      return { kind: 'ok', status: page.status, body: page.body, url: u.href };
    }
    return { kind: 'miss', reason: `more than ${MAX_HOPS} redirects from ${start.slice(0, 80)}` };
  }

  async function robotsFor(host: string): Promise<RobotsVerdict> {
    const cached = robots.get(host);
    if (cached !== undefined) return cached;
    const r = await fetchUrl(`https://${host}/robots.txt`, false);
    let verdict: RobotsVerdict;
    if (r.kind === 'challenge') verdict = { kind: 'challenge', why: r.reason };
    else if (r.kind === 'miss' || r.kind === 'moved') verdict = { kind: 'disallow-all', why: r.kind === 'miss' ? r.reason : 'robots.txt moved off the planned hosts' };
    else if (r.status >= 500) verdict = { kind: 'disallow-all', why: `robots.txt ${r.status}` };
    else if (r.status >= 400) verdict = { kind: 'allow-all', why: `robots.txt ${r.status}` };
    else verdict = { kind: 'rules', robots: parseRobots(r.body) };
    // A challenge in robots.txt was already stored by fetchUrl; every other verdict is cached here.
    if (!robots.has(host)) robots.set(host, verdict);
    return robots.get(host) as RobotsVerdict;
  }

  const miss = (what: string, r: Fetched): void => {
    if (r.kind === 'miss' || r.kind === 'challenge') reasons.push(`${what}: ${r.reason}`);
    else if (r.kind === 'ok') reasons.push(`${what}: ${r.status}`);
  };
  const hit = (r: Fetched): string | null => (r.kind === 'ok' && r.status >= 200 && r.status < 300 ? r.url : r.kind === 'moved' ? r.url : null);

  // 1. listed
  if (c.careersUrl !== null && c.careersUrl.trim() !== '') {
    const r = await fetchUrl(c.careersUrl, true);
    const url = hit(r);
    if (url !== null) return found('listed', url, `listed careersUrl answered${r.kind === 'ok' ? ` ${r.status}` : ' (moved)'}`);
    miss('listed', r);
  }

  if (web === null || siteKey === null || web.port !== '') {
    reasons.push(web === null ? 'no usable website' : siteKey === null ? `website host has no registrable domain: ${web.hostname}` : 'website has an explicit port');
    return none();
  }

  // 2. homepage link
  const home = await fetchUrl(`${web.origin}/`, true);
  if (home.kind === 'challenge') {
    reasons.push(`homepage: ${home.reason}`);
    return none();
  }
  if (home.kind === 'ok' && home.status >= 400 && home.status < 500) {
    reasons.push(`homepage: ${home.status}`);
    return none();
  }
  if (home.kind === 'ok' && home.status < 300) {
    const link = findCareersLink(home.body, home.url, onCompanyDomain);
    if (link !== null) return found('homepage-link', link.url, `homepage link "${link.text}"`);
    reasons.push('homepage: no careers link');
  } else miss('homepage', home);

  // 3. paths
  for (const p of CAREERS_PATHS) {
    const r = await fetchUrl(`${web.origin}${p}`, true);
    const url = hit(r);
    if (url !== null) return found('path', url, `GET ${p}${r.kind === 'ok' ? ` ${r.status}` : ' (moved)'}`);
    miss(p, r);
  }

  // 4. subdomains
  for (const s of CAREERS_SUBDOMAINS) {
    const host = `${s}.${siteKey}`;
    const r = await fetchUrl(`https://${host}/`, true);
    const url = hit(r);
    if (url !== null) return found('subdomain', url, `GET ${host}/${r.kind === 'ok' ? ` ${r.status}` : ' (moved)'}`);
    miss(host, r);
  }

  // 5. sitemaps: /sitemap.xml, then those named in robots.txt on a planned host
  const sitemapUrls = [`${web.origin}/sitemap.xml`];
  const rv = await robotsFor(web.hostname.toLowerCase());
  if (rv.kind === 'rules') {
    for (const s of rv.robots.sitemaps) {
      const u = asHttps(s);
      if (u !== null && planned.has(u.hostname.toLowerCase()) && !sitemapUrls.includes(u.href)) sitemapUrls.push(u.href);
    }
  }
  for (const sm of sitemapUrls.slice(0, 3)) {
    const r = await fetchUrl(sm, true);
    if (r.kind === 'ok' && r.status >= 200 && r.status < 300) {
      for (const loc of sitemapLocs(r.body)) {
        const u = asHttps(loc);
        if (u === null || !onCompanyDomain(u) || !SITEMAP_LOC.test(u.pathname)) continue;
        return found('sitemap', loc, `first careers <loc> in ${new URL(sm).pathname}`);
      }
      reasons.push(`sitemap ${new URL(sm).pathname}: no careers or jobs <loc>`);
    } else miss(`sitemap ${new URL(sm).pathname}`, r);
  }

  return none();
}
