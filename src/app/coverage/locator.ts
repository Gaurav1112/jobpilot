import { defineAgent, type AgentContext } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import type { EgressSets } from '../../kernel/broker.js';
import { asHttps, BudgetExhausted, budgetReason, failTransient, gateOf, limitsOf, refuseSiblingDependent, stepFetcher, transientOf, type Fetched, type GateSource, type RunGate, type StepLimits, type TransientCode } from './gate.js';
import { platformForHost } from './platform-hosts.js';
import { registrableDomain } from './seed.js';
import { sitemapLocs } from '../text/sitemap.js';
import { CareersSite, CompanyCandidate } from './types.js';

export { sitemapLocs } from '../text/sitemap.js';

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
 * Politeness (the shared run gate, `gate.ts`): the host state is per RUN (shared by every candidate of a run): each host's robots.txt is
 * fetched once, and every probe honours it. robots.txt: 404/410 allows all; 401/403 disallows the host
 * (`robots-forbidden`); any other 3xx/4xx disallows it (`robots-unavailable`, RFC 9309's conservative choice); a name
 * DNS does not know (online) is `no-such-host`; a network error, a timeout or a 5xx is `robots-transient` (C1: off for
 * an hour, then asked again); 429 disables the host. A host that answers a probe with a challenge page, 401, 403 or 429 is
 * DISABLED for the rest of the run (no retry, no more probes by any candidate; later candidates get the reason
 * `host-disabled:<why>`). Candidates must be processed in a fixed order for the run to be deterministic. The honest
 * user agent and the 2 s per-host spacing are the broker's (HTTP_HEADERS, the supervisor's host pacer). A 4xx on the
 * homepage ends the search. Each candidate has a request budget (`maxRequests`); beyond it the answer is `none` with
 * the reason `budget-exhausted`. A `none` that rests on a transient miss (a network error, a timeout, a 5xx, a
 * `robots-transient` host of this step) is not an answer: the step FAILS with that transport code (C1), so it is
 * never memoised as "not located", the breaker sees an outage, and the coverage run asks again later.
 *
 * Redirects are followed by hand, at most 5 hops, and only by fetching hosts this module planned for (see
 * `locatorHosts`, which the app turns into the egress set); a redirect to any other host of the company's registrable
 * domain, or to a known platform host, ends the probe as a hit on that Location, unfetched. Any other redirect is a miss.
 */

/** Requests one candidate may make (robots.txt, redirect hops and probes together). */
export const MAX_REQUESTS = 16;
export const CAREERS_PATHS = ['/careers', '/jobs', '/company/careers', '/about/careers'] as const;
export const CAREERS_SUBDOMAINS = ['careers', 'jobs'] as const;

/** Text or href of a link that suggests a careers page. */
export const CAREERS_LINK = /\b(careers?|jobs|join (?:us|our team)|work with us|open positions)\b/i;
const SITEMAP_LOC = /\/careers|\/jobs/i;

export { HOST_DISABLED, isChallenge, MAX_HOPS, type HostState, type HostStateStore } from './gate.js';

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
  return { 'coverage:candidate-hosts': [...new Set(candidates.flatMap(locatorHosts))].sort() };
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

export const careersLocatorContract = defineContract({
  id: 'careers-locator',
  version: '1.0.0',
  description: 'Finds a candidate company\'s careers URL by fixed probes that honour robots.txt; a refused host is recorded in the run\'s coverage_host_state',
  skills: ['careers-locator'],
  team: 'coverage-locator',
  kind: 'io',
  consumes: CompanyCandidate,
  produces: CareersSite,
  capabilities: { http: true },
  egress: ['coverage:candidate-hosts'],
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 120_000,
  retry: { max: 0, on: [], backoffMs: [] },
});

/**
 * The careers-locator agent for ONE coverage run. Build it inside each run, with that run's key (the run id the
 * supervisor resumes under, e.g. `coverage-2026-10-13`); never keep one in a long-lived process such as the dashboard,
 * whose host state would outlive its run. Give it the run's `gate` (`makeRunGate`) to share the host state with the
 * platform detector of the same run; without one it builds its own from `runKey` and `store` (both required, so a
 * resumed run always finds the hosts disabled before a crash).
 *
 * Host state and memoisation (a step is one candidate, and its step key knows nothing of its siblings):
 * - A host that is disabled (challenge, 401, 403, 429, a robots.txt refusal) is written to `store` under `runKey`
 *   BEFORE the candidate that caused it returns, and loaded again when a locator is built for the same key, so a
 *   resumed run still knows every host disabled before the crash. This write (`coverage_host_state`, through the
 *   app's `AppStore`) is the agent's one side channel outside its output: run-scoped politeness state, never data.
 * - A result that carries any `host-disabled:*` reason depends on a sibling's request, not on its own input, so it is
 *   never returned as a finished result: the step fails with `input_rejected` (a failed step is not replayed, it
 *   trips no breaker, and its detail names the reason). It is re-evaluated in every later run. A candidate whose OWN
 *   request was refused returns an ordinary result (its disable is already persisted).
 * - robots.txt verdicts are not persisted: after a crash each host's robots.txt is fetched once more on resume.
 * - The shared robots.txt fetch runs under the abort signal of whichever candidate asks first; if that candidate's
 *   step times out mid-fetch, the host is `robots-transient` (C1, final review N5): off for TRANSIENT_DISABLE_MS, then
 *   asked again; that candidate's step fails `timeout` and is re-queued.
 */
export function makeCareersLocator(opts: GateSource & Partial<StepLimits>) {
  const gate = gateOf(opts);
  const limits = limitsOf(opts, MAX_REQUESTS);
  return defineAgent(careersLocatorContract, async (c, ctx) => [await locate(c, ctx, gate, limits)]);
}

async function locate(c: CompanyCandidate, ctx: AgentContext, gate: RunGate, limits: StepLimits): Promise<CareersSite> {
  const reasons: string[] = [];
  const transient: TransientCode[] = [];
  let site: CareersSite;
  try {
    site = await probe(c, ctx, gate, limits, reasons, transient);
  } catch (e) {
    if (!(e instanceof BudgetExhausted)) throw e;
    reasons.push(budgetReason(e));
    site = { candidate: c, careersUrl: null, method: 'none', evidence: null, reasons };
  }
  refuseSiblingDependent(site.reasons ?? [], site.careersUrl);
  // C1: "not located" resting on a failure that may pass is not an answer; a site found anyway is
  if (site.careersUrl === null) failTransient(transient, site.reasons ?? []);
  return site;
}

async function probe(c: CompanyCandidate, ctx: AgentContext, gate: RunGate, limits: StepLimits, reasons: string[], transient: TransientCode[]): Promise<CareersSite> {
  const state = gate.state;
  const planned = new Set(locatorHosts(c));

  const web = asHttps(c.website);
  const siteKey = web === null ? null : registrableDomain(web.hostname);
  const onCompanyDomain = (u: URL): boolean => (siteKey !== null && registrableDomain(u.hostname) === siteKey) || platformForHost(u.hostname) !== null;
  const gated = stepFetcher({ ctx, gate, planned, acceptMoved: onCompanyDomain, ...limits });
  const fetchUrl = async (url: string, checkRobots: boolean): Promise<Fetched> => {
    const r = await gated.fetchUrl(url, checkRobots);
    const code = transientOf(r);
    if (code !== null) transient.push(code);
    return r;
  };
  const robotsFor = async (host: string) => {
    const v = await gated.robotsFor(host);
    if (v.kind === 'disallow-all' && v.transient !== undefined) transient.push(v.transient);
    return v;
  };

  const found = (method: CareersSite['method'], careersUrl: string, evidence: string): CareersSite => ({ candidate: c, careersUrl, method, evidence, ...(reasons.length > 0 ? { reasons } : {}) });
  const none = (): CareersSite => ({ candidate: c, careersUrl: null, method: 'none', evidence: null, reasons: reasons.length > 0 ? reasons : ['no probe applied'] });

  const miss = (what: string, r: Fetched): void => {
    if (r.kind === 'miss' || r.kind === 'challenge') reasons.push(`${what}: ${r.reason}`);
    else if (r.kind === 'ok') reasons.push(`${what}: ${r.status}`);
  };
  const hit = (r: Fetched): string | null => (r.kind === 'ok' && r.status >= 200 && r.status < 300 ? r.url : r.kind === 'moved' ? r.url : null);

  // 1. listed
  if (c.careersUrl !== null && c.careersUrl.trim() !== '') {
    const r = await fetchUrl(c.careersUrl, true);
    const url = hit(r);
    if (url !== null) return found('listed', url, `listed careersUrl ${r.kind === 'ok' ? `answered ${r.status}` : 'redirected (target unfetched)'}`);
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
  if (home.kind === 'miss' && state.disabled.has(web.hostname.toLowerCase())) {
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
    if (url !== null) return found('path', url, `GET ${p} ${r.kind === 'ok' ? r.status : 'redirected (target unfetched)'}`);
    miss(p, r);
    if (state.disabled.has(web.hostname.toLowerCase())) break;
  }

  // 4. subdomains
  for (const s of CAREERS_SUBDOMAINS) {
    const host = `${s}.${siteKey}`;
    const r = await fetchUrl(`https://${host}/`, true);
    const url = hit(r);
    if (url !== null) return found('subdomain', url, `GET ${host}/ ${r.kind === 'ok' ? r.status : 'redirected (target unfetched)'}`);
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
        return found('sitemap', u.href, `first careers <loc> in ${new URL(sm).pathname}`);
      }
      reasons.push(`sitemap ${new URL(sm).pathname}: no careers or jobs <loc>`);
    } else miss(`sitemap ${new URL(sm).pathname}`, r);
  }

  return none();
}
