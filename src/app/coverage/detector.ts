import { defineAgent, type AgentContext } from '../../kernel/agent.js';
import type { EgressSets } from '../../kernel/broker.js';
import { defineContract } from '../../kernel/contract.js';
import { PRODUCT_POLICY_V1 } from '../../kernel/policy.js';
import { asHttps, BudgetExhausted, budgetReason, gateOf, HOST_DISABLED, limitsOf, MAX_HOPS, refuseSiblingDependent, stepFetcher, type Fetched, type GateSource, type RunGate, type StepLimits } from './gate.js';
import { locatorHosts } from './locator.js';
import { platformForHost } from './platform-hosts.js';
import { registrableDomain } from './seed.js';
import { eightfoldBoard, MARKERS, matchUrl, rmkBoard, teamtailorBoard, TELEMETRY_HOSTS, type SignatureRow } from './signatures.js';
import { CareersSite, PlatformGuess } from './types.js';

/**
 * The platform detector (spec §3): for one located careers URL, fetch the page and name the ATS behind it, with the
 * board's slug and the URL its adapter reads. Deterministic, no language model.
 *
 * Fetching (through the run's shared gate, `gate.ts`: robots.txt, disabled hosts, challenge pages, manual redirects,
 * a request budget, exactly as the careers locator): ONE page fetch of the careers URL, its redirects followed. If that
 * page carries no back-end ATS signal, AT MOST one more page fetch: the first `<a href>` in document order whose text or
 * href says jobs, openings or positions and that stays on the page's registrable domain (first match only, its
 * redirects followed the same way). A redirect to an unplanned host on the company's domain or a platform host is not
 * followed: its Location is read as a URL signature, unfetched.
 *
 * Signals (the signature table, `signatures.ts`): the careers URL and the final or redirect URL; every `<a href>`,
 * `<link href>`, `<script src>`, `<iframe src>` and `<form action>`; absolute URLs inside inline scripts (JSON-escaped
 * ones too); JobPosting JSON-LD; the page markers (Phenom, `gh_jid=`, Teamtailor and SuccessFactors assets on the
 * company's host, an Eightfold script on a `/careers?domain=` page). Only the first MAX_SCAN_CHARS of a page are read.
 *
 * Decision, after removing the front-end-only signals (Phenom always; JobPosting JSON-LD when any ATS is present):
 * - two or more ATS platforms -> `platform: null`, all of them in the evidence (it becomes Proposed);
 * - one ATS with two or more board slugs -> null, every slug in the evidence; with no slug at all -> null;
 * - one ATS with one slug -> that platform; `routedFrom` is `phenom` on a Phenom page, else `jsonld` when a company page
 *   (not a platform host) carried JobPosting JSON-LD (the Okta case), else null;
 * - no ATS: JobPosting JSON-LD -> `jsonld-sitemap` on the page's host; Phenom alone -> null; nothing -> null.
 * A page that will not load (a miss, a 4xx/5xx, robots.txt), a refusal (challenge, 401, 403, 429) or a soft-404 is
 * `platform: null` with the reason; a URL signature it carried stays in the evidence only. A board URL redirected to a page of
 * the same platform that names no board (Workable's `/oops`) is the vendor's not-found page: null, unavailable.
 *
 * Memo safety (as the locator): a step that met a host disabled by another step fails with `input_rejected`
 * (`host-disabled:<why>`); a disable this step causes is persisted before it returns.
 */

/** The most of a page the detector reads (the broker's response cap, so a page is never cut short twice). */
export const MAX_SCAN_CHARS = PRODUCT_POLICY_V1.maxResponseBytes;
/** Requests one step may make: two page fetches with their redirect hops (robots.txt is counted, never refused). */
export const DETECTOR_MAX_REQUESTS = 2 * (MAX_HOPS + 1);
/** Text or href of a link to the job list, for the second fetch. */
const JOBS_LINK = /\b(?:jobs|openings|positions)\b/i;
const SOFT_404 = /\b(?:404|not found|cannot be found|can't be found|does not exist|doesn't exist|no longer available)\b/i;
const PHENOM = /phenompeople|\bphApp\.ddo\b/i;
const MAX_EVIDENCE = 24;

export const platformDetectorContract = defineContract({
  id: 'platform-detector',
  version: '1.0.0',
  description: 'Identifies the ATS behind a careers page from its link, script or JSON-LD signatures; a refused host is recorded in the run\'s coverage_host_state',
  skills: ['platform-detector'],
  team: 'coverage-detector',
  kind: 'io',
  consumes: CareersSite,
  produces: PlatformGuess,
  capabilities: { http: true },
  egress: ['coverage:candidate-hosts'],
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 120_000,
  retry: { max: 0, on: [], backoffMs: [] },
});

/** Every host the detector may contact for a site: the careers URL's host plus the candidate's own site hosts (`locatorHosts`). */
export function detectorHosts(site: CareersSite): string[] {
  const out = new Set(locatorHosts(site.candidate));
  const u = site.careersUrl === null ? null : asHttps(site.careersUrl);
  if (u !== null && u.port === '') out.add(u.hostname.toLowerCase());
  return [...out].sort();
}

/** The egress set for the detector's sites: the union of `detectorHosts`. */
export function detectorEgressSets(sites: readonly CareersSite[]): EgressSets {
  return { 'coverage:candidate-hosts': [...new Set(sites.flatMap(detectorHosts))].sort() };
}

// ---------------------------------------------------------------------------------------------------------------
// Page parsing: linear scans only (indexOf, and regexes without nested quantifiers over bounded slices).

export type Where = 'url' | 'a' | 'link' | 'script' | 'iframe' | 'form' | 'inline' | 'marker';

export interface Signal {
  readonly platform: SignatureRow['platform'];
  readonly slug: string | null;
  readonly boardUrl: string | null;
  readonly where: Where;
  readonly url: string;
}

export interface PageSignals {
  readonly url: string;
  readonly ats: readonly Signal[];
  readonly phenom: boolean;
  readonly jobPosting: boolean;
}

const decodeEntities = (s: string): string =>
  s.replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&#39;|&apos;|&#x27;/gi, "'").replace(/&#x2F;|&#47;/gi, '/').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;|&#38;/gi, '&');
/** Text of an HTML fragment. Callers cut the fragment to a bound first; `[^<>]` keeps the tag regex linear. */
const stripTags = (s: string): string => decodeEntities(s.replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** One linear matcher per attribute the detector reads (fixed names, never page content). */
const ATTR_RE: Readonly<Record<'href' | 'src' | 'action' | 'type', RegExp>> = {
  href: /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
  src: /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
  action: /(?:^|\s)action\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
  type: /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
};

function attr(attrs: string, name: keyof typeof ATTR_RE): string | null {
  const m = ATTR_RE[name].exec(attrs);
  return m === null ? null : decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim());
}

function resolveUrl(raw: string, base: URL): URL | null {
  if (raw === '' || raw.startsWith('#') || /^(?:mailto|tel|javascript|data):/i.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.protocol = 'https:';
  u.hash = '';
  return u;
}

interface Tag {
  readonly name: string;
  readonly attrs: string;
  /** For `<script>` and `<a>`: the content up to the closing tag (bounded), else ''. */
  readonly content: string;
}

/**
 * The tags of `html` in document order, `<script>` and `<a>` with their content. Linear: each `<` is visited once, a
 * missing `>` ends the scan (no later tag can close), and the search for a closing tag is reused until passed.
 */
function scanTags(html: string, wanted: ReadonlySet<string>): Tag[] {
  const out: Tag[] = [];
  const close: Record<string, { re: RegExp; at: number; end: number } | null> = {};
  const closeAfter = (name: string, from: number): { at: number; end: number } | null => {
    const c = close[name];
    if (c === null) return null;
    if (c !== undefined && c.at >= from) return c;
    const re = c?.re ?? new RegExp(`</${name}\\s*>`, 'gi'); // a fixed tag name, never page content
    re.lastIndex = from;
    const m = re.exec(html);
    if (m === null) {
      close[name] = null;
      return null;
    }
    const found = { re, at: m.index, end: m.index + m[0].length };
    close[name] = found;
    return found;
  };
  let i = 0;
  for (;;) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    const gt0 = html.indexOf('>', lt + 1);
    if (gt0 < 0) break;
    // a '<' with another '<' before its '>' is text, not a tag: start from the last '<' before the '>' (linear: the scan then moves past the '>')
    const gt = gt0;
    const start = html.lastIndexOf('<', gt);
    let n = start + 1;
    while (n < gt && /[A-Za-z0-9]/.test(html[n] as string)) n++;
    const name = html.slice(start + 1, n).toLowerCase();
    i = gt + 1;
    if (!wanted.has(name) || n === start + 1) continue;
    const attrs = html.slice(n, gt);
    let content = '';
    if (name === 'script' || name === 'a' || name === 'title') {
      const c = closeAfter(name, gt + 1);
      if (c !== null) {
        content = html.slice(gt + 1, c.at);
        if (name === 'script') i = c.end; // nothing inside a script is a tag
      }
    }
    out.push({ name, attrs, content });
  }
  return out;
}

/** Absolute http(s) URLs inside script text, JSON-escaped (`https:\/\/…`) ones unescaped. Linear: the scan resumes after each URL. */
export function inlineUrls(text: string): string[] {
  const out: string[] = [];
  const stop = new Set(['"', "'", '`', '<', '>', ' ', '\n', '\r', '\t', '(', ')', '{', '}', '[', ']']);
  let k = text.indexOf('http');
  while (k >= 0) {
    let j = k + 4;
    if (text[j] === 's') j++;
    let url = '';
    let ok = text[j] === ':';
    if (ok) {
      url = text.slice(k, j + 1);
      j++;
      for (let len = 0; j < text.length && len < 2048; len++) {
        const ch = text[j] as string;
        if (stop.has(ch)) break;
        if (ch === '\\') {
          if (text[j + 1] === '/') {
            url += '/';
            j += 2;
            continue;
          }
          if (text.slice(j + 1, j + 6).toLowerCase() === 'u002f') {
            url += '/';
            j += 6;
            continue;
          }
          break;
        }
        url += ch;
        j++;
      }
      ok = url.startsWith('https://') || url.startsWith('http://');
    }
    if (ok && url.length > 'https://'.length) out.push(url);
    k = text.indexOf('http', Math.max(j, k + 4));
  }
  return out;
}

function hasJobPosting(node: unknown, depth = 0): boolean {
  if (depth > 8 || node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.slice(0, 500).some((n) => hasJobPosting(n, depth + 1));
  const o = node as Record<string, unknown>;
  const t = o['@type'];
  if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) return true;
  return hasJobPosting(o['@graph'], depth + 1) || hasJobPosting(o['itemListElement'], depth + 1) || hasJobPosting(o['item'], depth + 1);
}

const endsWithHost = (host: string, suffixes: readonly string[]): boolean => suffixes.some((s) => host === s || host.endsWith(`.${s}`));

const WHERE_OF: Readonly<Record<string, Where>> = { a: 'a', link: 'link', script: 'script', iframe: 'iframe', form: 'form' };
const ATTR_OF: Readonly<Record<string, keyof typeof ATTR_RE>> = { a: 'href', link: 'href', script: 'src', iframe: 'src', form: 'action' };
const TAGS: ReadonlySet<string> = new Set(['a', 'link', 'script', 'iframe', 'form']);

/** The URL signal of one URL: a board, a slugless platform signal, or none. */
export function urlSignal(u: URL, where: Where): Signal | null {
  const m = matchUrl(u);
  if (m !== null) return m.board === 'slugless' ? { platform: m.platform, slug: null, boardUrl: null, where, url: u.href } : { platform: m.platform, slug: m.board.slug, boardUrl: m.board.boardUrl, where, url: u.href };
  if (u.searchParams.has('gh_jid')) return { platform: 'greenhouse', slug: null, boardUrl: null, where: 'marker', url: u.href };
  return null;
}

/** What one page's HTML says (the page's own URL is not read here; see `urlSignal`). */
export function pageSignals(html: string, pageUrl: string): PageSignals {
  const text = html.length > MAX_SCAN_CHARS ? html.slice(0, MAX_SCAN_CHARS) : html;
  const base = asHttps(pageUrl) ?? new URL('https://invalid.invalid/');
  const pageHost = base.hostname.toLowerCase();
  const pageIsPlatform = platformForHost(pageHost) !== null;
  const ats: Signal[] = [];
  let jobPosting = false;
  let eightfoldDomain: string | undefined;
  const add = (s: Signal | null): void => {
    if (s !== null) ats.push(s);
  };
  for (const t of scanTags(text, TAGS)) {
    const where = WHERE_OF[t.name] as Where;
    if (t.name === 'script' && attr(t.attrs, 'src') === null) {
      if ((attr(t.attrs, 'type') ?? '').toLowerCase() === 'application/ld+json') {
        try {
          if (hasJobPosting(JSON.parse(t.content) as unknown)) jobPosting = true;
        } catch {
          // malformed JSON-LD is no signal
        }
      } else {
        for (const raw of inlineUrls(t.content)) {
          const u = resolveUrl(raw, base);
          if (u !== null) add(urlSignal(u, 'inline'));
        }
      }
      continue;
    }
    const raw = attr(t.attrs, ATTR_OF[t.name] as keyof typeof ATTR_RE);
    if (raw === null) continue;
    const u = resolveUrl(raw, base);
    if (u === null) continue;
    const host = u.hostname;
    if (TELEMETRY_HOSTS.has(host)) continue;
    const asset = t.name === 'script' || t.name === 'link';
    if (asset && !pageIsPlatform && endsWithHost(host, MARKERS.teamtailorAssetHosts)) {
      add({ platform: 'teamtailor', ...teamtailorBoard(pageHost), where, url: u.href });
      continue;
    }
    if (asset && !pageIsPlatform && endsWithHost(host, MARKERS.rmkAssetHosts)) {
      add({ platform: 'successfactors', ...rmkBoard(pageHost), where, url: u.href });
      continue;
    }
    if (t.name === 'script' && endsWithHost(host, MARKERS.eightfoldScriptHosts) && matchUrl(u) === null) {
      eightfoldDomain ??= (base.searchParams.get('domain') ?? '').trim().toLowerCase() || eightfoldConfigDomain(text) || '';
      const d = eightfoldDomain;
      const named = base.pathname.startsWith('/careers') && DOMAIN.test(d);
      add(named ? { platform: 'eightfold', ...eightfoldBoard(pageHost, d), where, url: u.href } : { platform: 'eightfold', slug: null, boardUrl: null, where, url: u.href });
      continue;
    }
    add(urlSignal(u, where));
  }
  return { url: base.href, ats, phenom: PHENOM.test(text), jobPosting };
}

const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u;

/**
 * The `domain` of an Eightfold career site's embedded configuration: the JSON (HTML-escaped) inside the element with
 * id `pcsx-data` or `smartApplyData` that Eightfold pages carry. Null when absent, malformed or not a host name.
 */
export function eightfoldConfigDomain(html: string): string | null {
  for (const id of MARKERS.eightfoldConfigIds) {
    const at = html.indexOf(`id="${id}"`);
    if (at < 0) continue;
    const gt = html.indexOf('>', at);
    const lt = gt < 0 ? -1 : html.indexOf('<', gt);
    if (lt < 0) continue;
    try {
      const d = (JSON.parse(decodeEntities(html.slice(gt + 1, lt))) as { domain?: unknown }).domain;
      if (typeof d === 'string' && DOMAIN.test(d.toLowerCase())) return d.toLowerCase();
    } catch {
      // malformed configuration is no signal
    }
  }
  return null;
}

/** A 200 page whose `<title>` says it is not there. */
export function isSoft404(html: string): boolean {
  const title = scanTags(html.length > MAX_SCAN_CHARS ? html.slice(0, MAX_SCAN_CHARS) : html, new Set(['title']))[0];
  return title !== undefined && SOFT_404.test(stripTags(title.content.slice(0, 1000)).slice(0, 300));
}

/** The second fetch's target: the first `<a href>` (document order) saying jobs/openings/positions on the page's registrable domain, not the page itself. */
export function jobsLink(html: string, pageUrl: string): string | null {
  const base = asHttps(pageUrl);
  if (base === null) return null;
  const key = registrableDomain(base.hostname);
  if (key === null) return null;
  for (const t of scanTags(html.length > MAX_SCAN_CHARS ? html.slice(0, MAX_SCAN_CHARS) : html, new Set(['a']))) {
    const raw = attr(t.attrs, 'href');
    if (raw === null) continue;
    const u = resolveUrl(raw, base);
    // not the page itself (the same path with another query or fragment is the same page)
    if (u === null || registrableDomain(u.hostname) !== key || (u.origin === base.origin && u.pathname === base.pathname)) continue;
    if (JOBS_LINK.test(stripTags(t.content.slice(0, 2000))) || JOBS_LINK.test(raw)) return u.href;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Decision

interface Collected {
  readonly signals: Signal[];
  phenom: boolean;
  /** The first page with JobPosting JSON-LD, and whether it is a platform host's page. */
  jsonld: { readonly url: string; readonly host: string; readonly onPlatform: boolean } | null;
}

const short = (u: string): string => (u.length > 120 ? `${u.slice(0, 117)}...` : u);

function signalLines(c: Collected): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const s of c.signals) {
    const line = `${s.platform} ${s.slug ?? '(no slug)'} via ${s.where} ${short(s.url)}`;
    const key = `${s.platform} ${s.slug ?? ''} ${s.where}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  if (c.phenom) lines.push('phenom front-end');
  if (c.jsonld !== null) lines.push(`JobPosting JSON-LD on ${short(c.jsonld.url)}`);
  return lines;
}

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

type Decision = Pick<PlatformGuess, 'platform' | 'slug' | 'boardUrl' | 'signature' | 'routedFrom'> & { readonly verdict: string };

function decide(c: Collected): Decision {
  const none = (verdict: string): Decision => ({ platform: null, slug: null, boardUrl: null, signature: null, routedFrom: null, verdict });
  // A slugless signal counts as a platform here, so a stray slugless signal from another vendor makes the page
  // several-platforms (conservative: uncertain -> null). The Okta rule is narrow on purpose: JobPosting JSON-LD with a
  // gh_jid= link but no Greenhouse board slug anywhere is null no-board-slug, never greenhouse without a slug.
  const platforms = uniq(c.signals.map((s) => s.platform)).sort();
  if (platforms.length > 1) return none(`several-platforms: ${platforms.join(', ')}`);
  if (platforms.length === 1) {
    const p = platforms[0] as SignatureRow['platform'];
    const slugged = c.signals.filter((s) => s.slug !== null);
    // one board in two letter cases (case-sensitive platforms keep the case seen) is still one board; the first-seen case wins
    const slugs = uniq(slugged.map((s) => (s.slug as string).toLowerCase())).sort();
    if (slugs.length > 1) return none(`several-boards: ${p} ${uniq(slugged.map((s) => s.slug as string)).sort().join(', ')}`);
    const first = slugged[0];
    if (first === undefined) return none(`no-board-slug: ${p}`);
    const routedFrom = c.phenom ? 'phenom' : c.jsonld !== null && !c.jsonld.onPlatform ? 'jsonld' : null;
    return { platform: p, slug: first.slug, boardUrl: first.boardUrl, signature: `${p}:${first.where}`, routedFrom, verdict: `detected: ${p} ${first.slug}` };
  }
  if (c.jsonld !== null) {
    const b = { slug: c.jsonld.host, boardUrl: `https://${c.jsonld.host}/sitemap.xml` };
    return { platform: 'jsonld-sitemap', ...b, signature: 'jsonld-sitemap:jsonld', routedFrom: c.phenom ? 'phenom' : null, verdict: `detected: jsonld-sitemap ${b.slug}` };
  }
  if (c.phenom) return none('front-end-only: phenom');
  return none('no-signature');
}

// ---------------------------------------------------------------------------------------------------------------
// The agent

/**
 * The platform-detector agent for ONE coverage run. Give it the run's `gate` (`makeRunGate`, the one the careers
 * locator of the same run uses) so both obey one host state; without one it builds its own from `runKey` and `store`
 * (both required). A host this agent disables is written to the store (`coverage_host_state`) before the step returns:
 * its one side channel outside its output, run-scoped politeness state, never data.
 */
export function makePlatformDetector(opts: GateSource & Partial<StepLimits>) {
  const gate = gateOf(opts);
  const limits = limitsOf(opts, DETECTOR_MAX_REQUESTS);
  return defineAgent(platformDetectorContract, async (site, ctx) => [await detect(site, ctx, gate, limits)]);
}

async function detect(site: CareersSite, ctx: AgentContext, gate: RunGate, limits: StepLimits): Promise<PlatformGuess> {
  const guess = (d: Decision, lines: readonly string[]): PlatformGuess => {
    const { verdict, ...rest } = d;
    return { site, ...rest, evidence: [verdict, ...lines].slice(0, MAX_EVIDENCE) };
  };
  const nullWith = (verdict: string, lines: readonly string[] = []): PlatformGuess => guess({ platform: null, slug: null, boardUrl: null, signature: null, routedFrom: null, verdict }, lines);
  if (site.careersUrl === null || site.careersUrl.trim() === '') return nullWith('no-careers-url');
  const start = asHttps(site.careersUrl);
  if (start === null) return nullWith(`unavailable: not an http(s) URL: ${short(site.careersUrl)}`);

  const web = asHttps(site.candidate.website);
  const key = web === null ? null : registrableDomain(web.hostname);
  const acceptMoved = (u: URL): boolean => (key !== null && registrableDomain(u.hostname) === key) || platformForHost(u.hostname) !== null;
  const { fetchUrl } = stepFetcher({ ctx, gate, planned: new Set(detectorHosts(site)), acceptMoved, ...limits });

  const c: Collected = { signals: [], phenom: false, jsonld: null };
  const notes: string[] = [];
  /** Every miss reason, for the sibling-dependence check. */
  const reasons: string[] = [];
  const addUrl = (u: URL): void => {
    const s = urlSignal(u, 'url');
    if (s !== null && !c.signals.some((x) => x.where === 'url' && x.url === s.url)) c.signals.push(s);
  };
  const addPage = (url: string, body: string): void => {
    const p = pageSignals(body, url);
    c.signals.push(...p.ats);
    c.phenom ||= p.phenom;
    if (p.jobPosting && c.jsonld === null) {
      const host = new URL(p.url).hostname;
      c.jsonld = { url: p.url, host, onPlatform: platformForHost(host) !== null };
    }
  };
  const fetchSafe = async (url: string): Promise<Fetched> => {
    try {
      return await fetchUrl(url, true);
    } catch (e) {
      if (e instanceof BudgetExhausted) return { kind: 'miss', reason: budgetReason(e) };
      throw e;
    }
  };
  const finish = (g: PlatformGuess): PlatformGuess => {
    refuseSiblingDependent(reasons, null);
    return g;
  };

  addUrl(start);
  const r1 = await fetchSafe(start.href);
  if (r1.kind === 'miss') {
    reasons.push(r1.reason);
    return finish(nullWith(`unavailable: ${r1.reason}`, signalLines(c)));
  }
  if (r1.kind === 'challenge') return finish(nullWith(`refused: ${r1.reason}`, signalLines(c)));
  if (r1.kind === 'moved') {
    const moved = new URL(r1.url);
    addUrl(moved);
    notes.push(`redirected to ${short(r1.url)} (target unfetched)`);
    const d = decide(c);
    if (d.platform === null && c.signals.length === 0) return finish(nullWith(`unfetched: redirected to ${short(r1.url)}`, notes));
    return finish(guess(d, [...notes, ...signalLines(c)]));
  }
  if (r1.status < 200 || r1.status >= 300) return finish(nullWith(`unavailable: ${r1.status}`, signalLines(c)));
  if (isSoft404(r1.body)) return finish(nullWith(`soft-404: ${short(r1.url)}`, signalLines(c)));
  if (r1.url !== start.href) {
    // the board URL was redirected to a page of the same platform that names no board: the vendor's not-found page
    const was = urlSignal(start, 'url');
    const now = urlSignal(new URL(r1.url), 'url');
    if (was !== null && was.slug !== null && now !== null && now.platform === was.platform && now.slug === null) {
      return finish(nullWith(`unavailable: board redirected to ${short(r1.url)}`, signalLines(c)));
    }
    addUrl(new URL(r1.url));
  }
  notes.push(`fetched ${short(r1.url)} (${r1.status})`);
  addPage(r1.url, r1.body);

  if (c.signals.length === 0) {
    const link = jobsLink(r1.body, r1.url);
    if (link !== null) {
      const r2 = await fetchSafe(link);
      if (r2.kind === 'ok' && r2.status >= 200 && r2.status < 300 && !isSoft404(r2.body)) {
        notes.push(`second page ${short(r2.url)} (${r2.status})`);
        if (r2.url !== link) addUrl(new URL(r2.url));
        addUrl(new URL(link));
        addPage(r2.url, r2.body);
      } else if (r2.kind === 'moved') {
        notes.push(`second page ${short(link)} redirected to ${short(r2.url)} (target unfetched)`);
        addUrl(new URL(r2.url));
      } else {
        const why = r2.kind === 'ok' ? (r2.status >= 200 && r2.status < 300 ? 'soft-404' : String(r2.status)) : r2.reason;
        if (r2.kind === 'miss' && r2.reason.includes(HOST_DISABLED)) reasons.push(r2.reason);
        notes.push(`second page ${short(link)}: ${why}`);
      }
    }
  }
  return finish(guess(decide(c), [...notes, ...signalLines(c)]));
}
