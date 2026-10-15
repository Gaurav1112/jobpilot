import { refuseRealNetwork } from '../../kernel/no-network.js';
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Route } from 'playwright';
import { type AwakeClock, type AwakeStopwatch, systemAwake } from '../../kernel/awake.js';
import { HTTP_HEADERS } from '../../kernel/broker.js';
import { challengeReason } from '../../kernel/challenge.js';
import { KernelError } from '../../kernel/errors.js';
import { hostMatches, hostMatchesBrand, normalizeHost } from '../../kernel/policy.js';
import type { BrowserExpansion, BrowserPage, BrowserProvider, BrowserRenderRequest } from '../../kernel/providers.js';
import { compileSafePattern } from '../pack/regex.js';
import { LOAD_MORE_LABEL, NEXT_LABEL, SHOW_ALL_LABEL } from './labels.js';

/** Resource types a read-only scan never needs; they are aborted before they leave the machine. */
const BLOCKED_TYPES = new Set(['image', 'font', 'media']);

/** Requests whose completion a listing waits for before it counts as settled. */
const DATA_TYPES = new Set(['xhr', 'fetch', 'document']);

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Redirect hops one render follows before giving up. */
const MAX_REDIRECTS = 10;

/** Redirect hops a subresource, fetch or subframe may take; each one is checked against the denied hosts and brands. */
const MAX_SUB_REDIRECTS = 5;


/**
 * How long rendering waits, and how far a listing is expanded. The defaults are the product values; tests shorten
 * them. None of these changes what the browser sends or how it presents itself.
 */
export interface RenderTiming {
  /** Loading the document (every redirect hop included). */
  readonly navigationMs: number;
  /** How often a page is sampled while it settles. */
  readonly pollMs: number;
  /** Equal consecutive samples (with no data request in flight) that make a page settled. */
  readonly stableSamples: number;
  /** A job page: the least time it is watched before it may count as settled. */
  readonly jobMinSettleMs: number;
  /** A job page: the most time it is watched; still changing (or still fetching) here means not settled. */
  readonly jobSettleCapMs: number;
  /** A listing: the least time it is watched before it may count as settled. */
  readonly minSettleMs: number;
  /** A listing: the most time one settle may take; still changing here means not settled. */
  readonly settleCapMs: number;
  /** A listing: load-more clicks before the expansion counts as capped. */
  readonly maxClicks: number;
  /** A listing: scrolls to the bottom (infinite scroll) before the expansion counts as capped. */
  readonly maxScrolls: number;
  /** A listing: wall time for all clicks and scrolls, their settles included, before the expansion counts as capped. */
  readonly expandBudgetMs: number;
}

export const DEFAULT_TIMING: RenderTiming = {
  navigationMs: 20_000,
  pollMs: 1_000,
  stableSamples: 3,
  jobMinSettleMs: 2_000,
  jobSettleCapMs: 45_000,
  minSettleMs: 5_000,
  settleCapMs: 45_000,
  maxClicks: 50,
  maxScrolls: 50,
  expandBudgetMs: 150_000,
};

export interface PlaywrightProviderOptions {
  /**
   * Test-only: lets top-level navigations use plain http, and a port, on a loopback host, so a local `node:http`
   * fixture server can be rendered. It does not exist on the capability or the contract, and the broker never
   * renders http or a port, so a production pipeline cannot reach it. Never set it outside tests.
   */
  readonly allowInsecureLocalhostForTests?: boolean;
  /**
   * Test-only: host names Chromium resolves to 127.0.0.1 (`--host-resolver-rules`), so a test can serve a name that
   * looks like a denied board and prove no hop ever reaches it. Never set it outside tests.
   */
  readonly resolveToLoopbackForTests?: readonly string[];
  readonly timing?: Partial<RenderTiming>;
  /** The awake-time clock every render budget is measured on (a sleeping Mac uses none of it); default `systemAwake`. */
  readonly awake?: AwakeClock;
}

/** What one render learned from its route handler. */
interface RenderState {
  current: Page | undefined;
  blockedNavigation: string | undefined;
  redirectTo: string | undefined;
  repeated: string | undefined;
  readOnly: string | undefined;
  tooBig: boolean;
  handlerError: unknown;
  early: BrowserPage | undefined;
  headers: Record<string, string>;
  /** Awake time since the render started: document loading must be done within navigationMs of it. */
  readonly nav: AwakeStopwatch;
  readonly requested: Set<string>;
  readonly inflight: Set<Request>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * What is left of a navigation budget after `sw`'s awake time (at least 1 ms, Playwright's smallest timeout). Awake
 * time, not wall time: a render frozen by a sleeping Mac starts its next hop with the budget it had.
 */
export const budgetLeft = (sw: AwakeStopwatch, budgetMs: number): number => Math.max(1, budgetMs - sw.elapsed());

/**
 * The real `BrowserProvider`: headless Chromium (the headless shell) via Playwright.
 *
 * - One browser process, launched on first use; a fresh context per render, so no cookie, storage or cache
 *   survives from one page to the next.
 * - The honest user-agent and the broker's `accept` header on the document; nothing is disguised.
 * - Every top-level document is fetched here first (redirects one hop at a time) and checked before the page may
 *   run: a hop outside `navigationHosts` is aborted and reported as `finalUrl` (the broker denies it); a CAPTCHA or
 *   bot wall (`challengeReason`) is returned unrendered, so no challenge script runs or re-requests the page; a
 *   document is never requested twice in one render (no reloads); a non-GET navigation (a form submission) is
 *   aborted and fails the render with G-READONLY.
 * - Pop-ups are closed and their requests aborted; WebSockets are closed; images, fonts, media and denied hosts
 *   or brands are aborted. Other subresources load, so script-built pages render (see spec §5); they, fetches and
 *   subframes are fetched here one redirect hop at a time, and a chain is aborted at the first denied hop (I10).
 * - Job pages wait for network idle and stable text; listings (`expand`) wait until the link count is stable,
 *   then click same-page "load more" buttons (never inside a form, never a form button) and report pagination
 *   controls that only a script could follow.
 * - Every handler is guarded: an error inside one fails the render with a KernelError, never the process.
 */
/**
 * Runs in every frame before its scripts (rereview R4): deletes `SharedWorker`, whose traffic Playwright's context
 * routing does not see. Deleted, not redefined, so `'SharedWorker' in window` is false and a page that feature-detects
 * it skips it (rereview-2 M2). `navigator.serviceWorker` is left alone: the context's `serviceWorkers: 'block'`
 * already refuses registration, and hiding it broke pages that detect it with `in` and then call it.
 * Plain source text, so no bundler or closure is involved.
 */
const NO_UNROUTED_WORKERS = `(() => {
  try { delete globalThis.SharedWorker; } catch {}
})();`;

export class PlaywrightBrowserProvider implements BrowserProvider {
  private browser: Promise<Browser> | undefined;
  private readonly timing: RenderTiming;
  private readonly awake: AwakeClock;

  constructor(private readonly opts: PlaywrightProviderOptions = {}) {
    this.timing = { ...DEFAULT_TIMING, ...(opts.timing ?? {}) };
    this.awake = opts.awake ?? systemAwake;
  }

  private launch(): Promise<Browser> {
    const map = this.opts.resolveToLoopbackForTests ?? [];
    // A page fulfilled from route.fetch counts as public address space, so Chromium's local-network checks would
    // refuse every loopback hop the test needs to observe; they are off in that test-only mode as well.
    const testArgs = [`--host-resolver-rules=${map.map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`, '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'];
    this.browser ??= chromium.launch({ headless: true, ...(map.length > 0 ? { args: testArgs } : {}) });
    return this.browser;
  }

  /** Closes the browser process. The pipeline calls it once at the end of a run. */
  async close(): Promise<void> {
    const b = this.browser;
    this.browser = undefined;
    if (b) await (await b).close();
  }

  private navigationAllowed(url: URL, hosts: readonly string[]): boolean {
    const host = normalizeHost(url.hostname);
    if (!hosts.some((h) => normalizeHost(h) === host) || url.username !== '' || url.password !== '') return false;
    if (url.protocol === 'https:') return url.port === '';
    return this.opts.allowInsecureLocalhostForTests === true && url.protocol === 'http:' && LOOPBACK.has(host);
  }

  async render(req: BrowserRenderRequest): Promise<BrowserPage> {
    if (req.signal.aborted) throw req.signal.reason;
    // JOBPILOT_NO_NETWORK=1 (the test suite): only a loopback page, or a host the test maps to loopback, is rendered
    if (!(this.opts.resolveToLoopbackForTests ?? []).includes(new URL(req.url).hostname)) refuseRealNetwork(req.url);
    const browser = await this.launch();
    const context = await browser.newContext({
      userAgent: HTTP_HEADERS['user-agent'] as string,
      acceptDownloads: false,
      serviceWorkers: 'block',
      javaScriptEnabled: true,
    });
    const onAbort = (): void => void context.close().catch(() => undefined);
    req.signal.addEventListener('abort', onAbort, { once: true });
    const state: RenderState = {
      current: undefined, blockedNavigation: undefined, redirectTo: undefined, repeated: undefined, readOnly: undefined,
      tooBig: false, handlerError: undefined, early: undefined, headers: {}, nav: this.awake.stopwatch(), requested: new Set(), inflight: new Set(),
    };
    try {
      await this.guard(context, req, state);
      return await this.load(context, req, state);
    } finally {
      state.nav.stop();
      req.signal.removeEventListener('abort', onAbort);
      await context.close().catch(() => undefined);
    }
  }

  /** Installs the route, socket and event handlers. Each one catches its own errors into `state.handlerError`. */
  private async guard(context: BrowserContext, req: BrowserRenderRequest, state: RenderState): Promise<void> {
    const denied = (host: string): boolean => req.deniedHosts.some((d) => hostMatches(host, d)) || req.deniedBrands.some((b) => hostMatchesBrand(host, b));
    const fail = (e: unknown): void => {
      state.handlerError ??= e;
    };
    // Rereview R4: a SharedWorker's requests never pass through context.route, so the API is removed before any page
    // or subframe script runs (init scripts apply to every frame). Service workers are blocked by the context option,
    // so neither kind of worker can fetch past the route handler.
    await context.addInitScript(NO_UNROUTED_WORKERS);
    await context.routeWebSocket(/.*/, (ws) => {
      try {
        void ws.close().catch(() => undefined);
      } catch (e) {
        fail(e);
      }
    });
    context.on('page', (p) => {
      // A pop-up: its navigations are aborted below; close it as well.
      p.opener()
        .then((o) => (o !== null ? p.close() : undefined))
        .catch(() => undefined);
    });
    const track = (r: Request, add: boolean): void => {
      try {
        if (!DATA_TYPES.has(r.resourceType())) return;
        if (add) state.inflight.add(r);
        else state.inflight.delete(r);
      } catch (e) {
        fail(e);
      }
    };
    context.on('request', (r) => track(r, true));
    context.on('requestfinished', (r) => track(r, false));
    context.on('requestfailed', (r) => track(r, false));

    await context.route('**/*', async (route: Route) => {
      try {
        await this.route(route, req, state, denied);
      } catch (e) {
        fail(e);
        await route.abort('blockedbyclient').catch(() => undefined);
      }
    });
  }

  private async route(route: Route, req: BrowserRenderRequest, state: RenderState, denied: (host: string) => boolean): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    if (request.isNavigationRequest()) {
      // Fail closed: a navigation whose frame cannot be read is treated as a top-level one that is not ours.
      let topLevel = true;
      let ours = false;
      try {
        const frame = request.frame();
        topLevel = frame.parentFrame() === null;
        ours = frame.page() === state.current;
      } catch {
        // A pop-up's first navigation has no frame yet: it is not ours, so it is aborted below.
      }
      if (request.method() !== 'GET') {
        state.readOnly ??= `${request.method()} ${url.href}`;
        return route.abort('blockedbyclient');
      }
      if (topLevel && !ours) return route.abort('blockedbyclient');
      if (topLevel) return this.document(route, req, state, url);
      // A subframe falls through to the subresource rules.
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return route.continue();
    if (BLOCKED_TYPES.has(request.resourceType())) return route.abort('blockedbyclient');
    if (denied(url.hostname)) return route.abort('blockedbyclient');
    return this.subresource(route, req, url, denied);
  }

  /**
   * I10: Playwright routes only the first URL of a redirect chain, and Chromium follows the later hops itself. So an
   * allowed subresource, fetch or subframe is fetched here one hop at a time (`maxRedirects: 0`); every hop's scheme
   * and host is checked against the denied hosts and brands, and the chain is aborted at the first denied hop, before
   * anything is sent to it. The final response is handed to the page. At most MAX_SUB_REDIRECTS hops are followed.
   */
  private async subresource(route: Route, req: BrowserRenderRequest, first: URL, denied: (host: string) => boolean): Promise<void> {
    const request = route.request();
    let url = first;
    let method = request.method();
    let postData = request.postDataBuffer() ?? undefined;
    // A slow API may answer late in a settle; the render's own caps (and closing its context) bound the wait.
    const subTimeout = Math.max(this.timing.navigationMs, this.timing.settleCapMs, this.timing.jobSettleCapMs);
    for (let hop = 0; ; hop++) {
      let res;
      try {
        res = await route.fetch({ url: url.href, method, maxRedirects: 0, timeout: subTimeout, ...(postData !== undefined ? { postData } : {}) });
      } catch {
        return route.abort('failed');
      }
      const location = res.headers()['location'];
      if (res.status() < 300 || res.status() >= 400 || location === undefined) {
        if (Number(res.headers()['content-length'] ?? '0') > req.maxBytes) return route.abort('blockedbyclient');
        return route.fulfill({ response: res });
      }
      if (hop >= MAX_SUB_REDIRECTS) return route.abort('blockedbyclient');
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return route.abort('failed');
      }
      if ((next.protocol !== 'http:' && next.protocol !== 'https:') || denied(next.hostname)) return route.abort('blockedbyclient');
      // As browsers do: 303, and a 301/302 answering a POST, continue as a GET without a body.
      if (res.status() === 303 || ((res.status() === 301 || res.status() === 302) && method === 'POST')) {
        method = 'GET';
        postData = undefined;
      }
      url = next;
    }
  }

  /** Fetches one top-level document hop, checks it, then hands it to the page or aborts. */
  private async document(route: Route, req: BrowserRenderRequest, state: RenderState, url: URL): Promise<void> {
    if (!this.navigationAllowed(url, req.navigationHosts)) {
      state.blockedNavigation ??= url.href;
      return route.abort('blockedbyclient');
    }
    if (state.requested.has(url.href)) {
      // A reload or a redirect loop: a read never needs the same document twice.
      state.repeated ??= url.href;
      return route.abort('blockedbyclient');
    }
    state.requested.add(url.href);
    let res;
    try {
      res = await route.fetch({ maxRedirects: 0, timeout: budgetLeft(state.nav, this.timing.navigationMs), headers: { ...route.request().headers(), accept: HTTP_HEADERS['accept'] as string } });
    } catch {
      // The navigation then fails in page.goto with a network error, which the broker maps.
      return route.abort('failed');
    }
    const headers = res.headers();
    const location = headers['location'];
    if (res.status() >= 300 && res.status() < 400 && location !== undefined) {
      const target = new URL(location, url);
      if (this.navigationAllowed(target, req.navigationHosts)) state.redirectTo ??= target.href;
      else state.blockedNavigation ??= target.href;
      return route.abort('blockedbyclient');
    }
    const declared = Number(headers['content-length'] ?? '0');
    if (declared > req.maxBytes) {
      state.tooBig = true;
      return route.abort('blockedbyclient');
    }
    const body = await res.body();
    if (body.byteLength > req.maxBytes) {
      state.tooBig = true;
      return route.abort('blockedbyclient');
    }
    const html = body.toString('utf8');
    if (challengeReason({ status: res.status(), headers, html }) !== null) {
      // Never let a wall run: return it unrendered and let the broker stop the step.
      state.early ??= { status: res.status(), finalUrl: url.href, html, text: '', jsonLd: [], headers, settled: true };
      return route.abort('blockedbyclient');
    }
    state.headers = headers;
    return route.fulfill({ response: res, body });
  }

  /** Raises whatever the handlers recorded, in order of severity; returns a page to report instead, if any. */
  private verdict(state: RenderState): BrowserPage | undefined {
    if (state.handlerError !== undefined) {
      const msg = state.handlerError instanceof Error ? state.handlerError.message : String(state.handlerError);
      throw new KernelError('invalid_output', `browser handler failed: ${msg.split('\n')[0]}`);
    }
    if (state.readOnly !== undefined) throw new KernelError('policy_denied', `G-READONLY: the page tried to submit (${state.readOnly}); refused`);
    if (state.tooBig) throw new KernelError('invalid_output', 'document exceeds the response size cap');
    if (state.early !== undefined) return state.early;
    if (state.blockedNavigation !== undefined) return { status: 0, finalUrl: state.blockedNavigation, html: '', text: '', jsonLd: [], headers: {}, settled: true };
    return undefined;
  }

  private async load(context: BrowserContext, req: BrowserRenderRequest, state: RenderState): Promise<BrowserPage> {
    let response;
    let page: Page | undefined;
    for (let target = req.url, hops = 0; ; hops++) {
      if (hops > MAX_REDIRECTS) throw new KernelError('invalid_output', `more than ${MAX_REDIRECTS} redirects from ${req.url}`);
      // Each hop starts on a fresh page: an aborted hop leaves its page on an error document.
      if (page) await page.close();
      page = await context.newPage();
      state.current = page;
      state.redirectTo = undefined;
      try {
        response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: budgetLeft(state.nav, this.timing.navigationMs) });
      } catch (e) {
        const stop = this.verdict(state);
        if (stop) return stop;
        if (state.redirectTo === undefined) {
          if (state.repeated !== undefined) throw new KernelError('invalid_output', `redirect loop at ${state.repeated}`);
          throw e;
        }
      }
      const stop = this.verdict(state);
      if (stop) return stop;
      if (state.redirectTo === undefined) break;
      target = state.redirectTo;
    }
    const p = page as Page;

    let settled: boolean;
    let expansion: BrowserExpansion | undefined;
    const links: LinkRule = { source: '', flags: 'iu' };
    if (req.linkPattern !== undefined) {
      try {
        links.source = compileSafePattern(req.linkPattern).source;
      } catch (e) {
        throw new KernelError('invalid_output', `unsafe linkPattern: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (req.expand) {
      settled = await this.settleListing(p, state, links);
      expansion = { clicks: 0, scrolls: 0, capReached: false, unfollowedControls: [] };
      if (settled) {
        const ex = await this.expand(p, state, links, req.url);
        settled = ex.settled;
        expansion = { clicks: ex.clicks, scrolls: ex.scrolls, capReached: ex.capReached, unfollowedControls: settled ? await unfollowedControls(p) : [] };
      }
    } else {
      settled = await this.settleJob(p, state);
    }
    const stop = this.verdict(state);
    if (stop) return stop;

    const html = await p.content();
    const { text, ld } = await p.evaluate(() => {
      const main = document.querySelector('main, [role="main"]') ?? document.body;
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'), (s) => s.textContent ?? '');
      return { text: main instanceof HTMLElement ? main.innerText : (main?.textContent ?? ''), ld: scripts };
    });
    const jsonLd: unknown[] = [];
    for (const s of ld) {
      try {
        jsonLd.push(JSON.parse(s));
      } catch {
        // A malformed block is not structured data; the agent falls back to the page's title and text.
      }
    }
    return {
      status: response?.status() ?? 0,
      finalUrl: p.url(),
      html,
      text,
      jsonLd,
      headers: state.headers,
      settled,
      settleCapMs: req.expand ? this.timing.settleCapMs : this.timing.jobSettleCapMs,
      ...(expansion ? { expansion } : {}),
    };
  }

  /**
   * A job page: sample the main text length every pollMs; settled once at least jobMinSettleMs have passed and the
   * last `stableSamples` lengths are equal with no document, xhr or fetch request in flight. Not by jobSettleCapMs:
   * not settled, so a description still arriving is never read as "Loading…".
   */
  private async settleJob(page: Page, state: RenderState): Promise<boolean> {
    const t = this.timing;
    return this.settle(t.jobMinSettleMs, t.jobSettleCapMs, state, () => textLength(page));
  }

  /**
   * A listing: sample the same-host job-link count every pollMs; settled once at least minSettleMs have passed and
   * the last `stableSamples` counts are equal with no data request in flight. Still changing at settleCapMs: not settled.
   */
  private async settleListing(page: Page, state: RenderState, links: LinkRule): Promise<boolean> {
    const t = this.timing;
    return this.settle(t.minSettleMs, t.settleCapMs, state, () => jobLinks(page, links));
  }

  private async settle(minMs: number, capMs: number, state: RenderState, sample: () => Promise<number>): Promise<boolean> {
    const t = this.timing;
    // awake time: a page watched across a sleeping Mac is not "still changing at the cap" when it wakes
    const sw = this.awake.stopwatch();
    try {
      const values: number[] = [];
      for (;;) {
        await sleep(t.pollMs);
        values.push(await sample());
        const last = values.slice(-t.stableSamples);
        const stable = last.length === t.stableSamples && last.every((n) => n === last[0] && n >= 0) && state.inflight.size === 0;
        const elapsed = sw.elapsed();
        if (stable && elapsed >= minMs) return true;
        if (elapsed >= capMs) return false;
      }
    } finally {
      sw.stop();
    }
  }

  /**
   * Expands a settled listing, read-only: clicks safe load-more controls one at a time (each click must add job
   * links, or the render fails), then scrolls to the bottom while that adds job links (infinite scroll). Clicks and
   * scrolls are capped by count and by expandBudgetMs; still adding jobs at a cap is `capReached`.
   */
  private async expand(page: Page, state: RenderState, links: LinkRule, url: string): Promise<{ clicks: number; scrolls: number; capReached: boolean; settled: boolean }> {
    const t = this.timing;
    // awake time, like every render budget
    const sw = this.awake.stopwatch();
    try {
      return await this.expandWithin(page, state, links, url, () => sw.elapsed() >= t.expandBudgetMs);
    } finally {
      sw.stop();
    }
  }

  private async expandWithin(page: Page, state: RenderState, links: LinkRule, url: string, spent: () => boolean): Promise<{ clicks: number; scrolls: number; capReached: boolean; settled: boolean }> {
    const t = this.timing;
    const labels = { loadMore: LOAD_MORE_LABEL.source, showAll: SHOW_ALL_LABEL.source };
    let clicks = 0;
    for (;;) {
      const target = await page.evaluate(nextExpandable, labels);
      if (target === null) break;
      if (clicks >= t.maxClicks || spent()) return { clicks, scrolls: 0, capReached: true, settled: true };
      const before = await jobLinks(page, links, true);
      try {
        await page.click(`[data-jobpilot-expand="${target.id}"]`, { timeout: 5_000 });
      } catch (e) {
        throw new KernelError('invalid_output', `load-more could not be clicked ("${target.label}") on ${url}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
      clicks += 1;
      const settled = await this.settleListing(page, state, links);
      // A click that made the page submit a form fails as G-READONLY (recorded by the broker), whatever it added.
      if (state.readOnly !== undefined) this.verdict(state);
      if (!settled) return { clicks, scrolls: 0, capReached: false, settled: false };
      if ((await jobLinks(page, links, true)) <= before) throw new KernelError('invalid_output', `load-more did not add jobs ("${target.label}") on ${url}`);
    }
    let scrolls = 0;
    for (;;) {
      const before = await jobLinks(page, links, true);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const settled = await this.settleListing(page, state, links);
      if (state.readOnly !== undefined) this.verdict(state);
      if (!settled) return { clicks, scrolls, capReached: false, settled: false };
      if ((await jobLinks(page, links, true)) <= before) break;
      scrolls += 1;
      if (scrolls >= t.maxScrolls || spent()) return { clicks, scrolls, capReached: true, settled: true };
    }
    return { clicks, scrolls, capReached: false, settled: true };
  }
}

/** The job-link rule counted in the page: same-host links whose path plus query match `source` (all, when empty). */
interface LinkRule {
  source: string;
  flags: string;
}

/**
 * Same-host job-link count; -1 while the document is being replaced. `visible` counts only links a reader can see
 * (a box, not display:none or visibility:hidden, not aria-hidden): that is what a load-more click or a scroll must
 * grow. Settling and collection count every job link in the DOM.
 */
async function jobLinks(page: Page, rule: LinkRule, visible = false): Promise<number> {
  return page
    .evaluate(({ r, visible: v }) => {
      const re = r.source === '' ? null : new RegExp(r.source, r.flags);
      let n = 0;
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        try {
          const u = new URL((a as HTMLAnchorElement).href, location.href);
          if (u.host !== location.host || (re !== null && !re.test(u.pathname + u.search))) continue;
          if (v) {
            const box = a.getBoundingClientRect();
            const style = getComputedStyle(a);
            if (box.width === 0 || box.height === 0 || style.display === 'none' || style.visibility === 'hidden' || a.closest('[aria-hidden="true"]') !== null) continue;
          }
          n += 1;
        } catch {
          // An unparsable href is not a link.
        }
      }
      return n;
    }, { r: rule, visible })
    .catch(() => -1);
}

/** Main text length; -1 while the document is being replaced. */
async function textLength(page: Page): Promise<number> {
  return page
    .evaluate(() => {
      const main = document.querySelector('main, [role="main"]') ?? document.body;
      return main instanceof HTMLElement ? main.innerText.length : (main?.textContent?.length ?? 0);
    })
    .catch(() => -1);
}

/**
 * In the page: the next control the provider may click, marked with a fresh id, or null. Only a `<button
 * type=button>` (or a typeless `<button>` with no form owner), a `[role=button]` or an `<a>` with no navigating href; never one tied to a form (inside it, a
 * `form` attribute, a submit or reset type), never one inside a dialog or a cookie or consent banner; visible,
 * enabled, and labelled by the shared load-more or show-all rule.
 */
function nextExpandable(labels: { loadMore: string; showAll: string }): { id: string; label: string } | null {
  const loadMore = new RegExp(labels.loadMore, 'i');
  const showAll = new RegExp(labels.showAll, 'i');
  const banner = '[role="dialog"], [aria-modal], dialog, [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [id*="onetrust" i], [class*="onetrust" i]';
  for (const el of Array.from(document.querySelectorAll('button, [role="button"], a'))) {
    if (!(el instanceof HTMLElement) || el.hasAttribute('data-jobpilot-clicked-out')) continue;
    const kind = el.tagName === 'BUTTON' ? 'button' : el.tagName === 'A' ? 'a' : 'role';
    // A <button> is clicked when it is type=button, or has no type and no form owner (then a click cannot submit).
    const type = el.getAttribute('type');
    if (kind === 'button' && !(type !== null ? type.toLowerCase() === 'button' : (el as HTMLButtonElement).form === null)) continue;
    if (kind === 'a') {
      const href = el.getAttribute('href');
      if (href !== null && !/^\s*(#|javascript:)/i.test(href)) continue; // a real link: the agent follows it
    }
    if (el.closest('form') !== null || el.hasAttribute('form') || (el as HTMLButtonElement).form) continue;
    if (el.closest(banner) !== null) continue;
    if ((el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true') continue;
    const label = (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!loadMore.test(label) && !showAll.test(label)) continue;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
    const n = Number(document.documentElement.getAttribute('data-jobpilot-n') ?? '0') + 1;
    document.documentElement.setAttribute('data-jobpilot-n', String(n));
    el.setAttribute('data-jobpilot-expand', String(n));
    return { id: String(n), label };
  }
  return null;
}

/**
 * Controls that look like more of the list (the shared load-more, show-all and next rules, or a number in a pager)
 * but have no link to follow and were not clicked: script-only next or numbered buttons, a load-more tied to a form,
 * a submit button. Real links are the agent's to follow; dialogs and cookie banners are not the listing.
 */
async function unfollowedControls(page: Page): Promise<string[]> {
  const labels = { loadMore: LOAD_MORE_LABEL.source, showAll: SHOW_ALL_LABEL.source, next: NEXT_LABEL.source };
  return page.evaluate((l) => {
    const rules = [new RegExp(l.loadMore, 'i'), new RegExp(l.showAll, 'i'), new RegExp(l.next, 'i')];
    const banner = '[role="dialog"], [aria-modal], dialog, [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [id*="onetrust" i], [class*="onetrust" i]';
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('button, [role="button"], a, input'))) {
      if (!(el instanceof HTMLElement)) continue;
      const href = el.tagName === 'A' ? el.getAttribute('href') : null;
      if (href !== null && !/^\s*(#|javascript:)/i.test(href)) continue;
      if ((el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.closest(banner) !== null) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const label = ((el instanceof HTMLInputElement ? el.value : el.innerText) || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      const pager = el.closest('nav, [role="navigation"], [class*="pag" i], [aria-label*="pag" i]') !== null;
      if (rules.some((re) => re.test(label)) || (pager && /^\d+$/.test(label))) out.push(el.outerHTML.replace(/\s+/g, ' ').slice(0, 160));
    }
    return out.slice(0, 10);
  }, labels);
}
