import { chromium, type Browser, type BrowserContext, type Page, type Request, type Route } from 'playwright';
import { HTTP_HEADERS } from '../../kernel/broker.js';
import { challengeReason } from '../../kernel/challenge.js';
import { KernelError } from '../../kernel/errors.js';
import { hostMatches, hostMatchesBrand, normalizeHost } from '../../kernel/policy.js';
import type { BrowserExpansion, BrowserPage, BrowserProvider, BrowserRenderRequest } from '../../kernel/providers.js';

/** Resource types a read-only scan never needs; they are aborted before they leave the machine. */
const BLOCKED_TYPES = new Set(['image', 'font', 'media']);

/** Requests whose completion a listing waits for before it counts as settled. */
const DATA_TYPES = new Set(['xhr', 'fetch', 'document']);

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Redirect hops one render follows before giving up. */
const MAX_REDIRECTS = 10;

/** Button `type`s that act on a form; such a button is never clicked. */
const FORM_BUTTON_TYPES = ['submit', 'image', 'reset'];

/**
 * How long rendering waits. The defaults are the product values; tests shorten them. None of these changes what
 * the browser sends or how it presents itself.
 */
export interface RenderTiming {
  /** Loading the document (every redirect hop included). */
  readonly navigationMs: number;
  /** A job page: waiting for network idle before checking that its text has stopped changing. */
  readonly idleMs: number;
  /** A listing: how often the same-host link count is sampled. */
  readonly pollMs: number;
  /** A listing: the least time it is watched before it may count as settled. */
  readonly minSettleMs: number;
  /** A listing: equal consecutive link counts (with no data request in flight) that make it settled. */
  readonly stableSamples: number;
  /** A listing: the most time it is watched; still changing at this point means not settled. */
  readonly settleCapMs: number;
  /** A listing: "load more" clicks before the expansion counts as capped. */
  readonly maxClicks: number;
}

export const DEFAULT_TIMING: RenderTiming = {
  navigationMs: 20_000,
  idleMs: 20_000,
  pollMs: 1_000,
  minSettleMs: 5_000,
  stableSamples: 3,
  settleCapMs: 45_000,
  maxClicks: 50,
};

export interface PlaywrightProviderOptions {
  /**
   * Test-only: lets top-level navigations use plain http, and a port, on a loopback host, so a local `node:http`
   * fixture server can be rendered. It does not exist on the capability or the contract, and the broker never
   * renders http or a port, so a production pipeline cannot reach it. Never set it outside tests.
   */
  readonly allowInsecureLocalhostForTests?: boolean;
  readonly timing?: Partial<RenderTiming>;
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
  /** When document loading must be done (navigationMs from the start of the render). */
  deadline: number;
  readonly requested: Set<string>;
  readonly inflight: Set<Request>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
 *   or brands are aborted. Other subresources load, so script-built pages render (see spec §5).
 * - Job pages wait for network idle and stable text; listings (`expand`) wait until the link count is stable,
 *   then click same-page "load more" buttons (never inside a form, never a form button) and report pagination
 *   controls that only a script could follow.
 * - Every handler is guarded: an error inside one fails the render with a KernelError, never the process.
 */
export class PlaywrightBrowserProvider implements BrowserProvider {
  private browser: Promise<Browser> | undefined;
  private readonly timing: RenderTiming;

  constructor(private readonly opts: PlaywrightProviderOptions = {}) {
    this.timing = { ...DEFAULT_TIMING, ...(opts.timing ?? {}) };
  }

  private launch(): Promise<Browser> {
    this.browser ??= chromium.launch({ headless: true });
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
      tooBig: false, handlerError: undefined, early: undefined, headers: {}, deadline: Date.now() + this.timing.navigationMs, requested: new Set(), inflight: new Set(),
    };
    try {
      await this.guard(context, req, state);
      return await this.load(context, req, state);
    } finally {
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
    return route.continue();
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
      res = await route.fetch({ maxRedirects: 0, timeout: Math.max(1, state.deadline - Date.now()), headers: { ...route.request().headers(), accept: HTTP_HEADERS['accept'] as string } });
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
    const deadline = state.deadline;
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
        response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()) });
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
    if (req.expand) {
      settled = await this.settleListing(p, state);
      if (settled) {
        const ex = await this.expand(p, state);
        settled = ex.settled;
        expansion = { clicks: ex.clicks, capReached: ex.capReached, unfollowedControls: settled ? await unfollowedControls(p) : [] };
      } else expansion = { clicks: 0, capReached: false, unfollowedControls: [] };
    } else {
      settled = await this.settleJob(p);
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
      ...(expansion ? { expansion } : {}),
    };
  }

  /** A job page: network idle, then its text length unchanged over `stableSamples` polls. */
  private async settleJob(page: Page): Promise<boolean> {
    const t = this.timing;
    await page.waitForLoadState('networkidle', { timeout: t.idleMs }).catch((e: unknown) => {
      if ((e as { name?: unknown }).name !== 'TimeoutError') throw e;
    });
    const samples: number[] = [];
    for (let i = 0; i < t.stableSamples; i++) {
      if (i > 0) await sleep(t.pollMs);
      samples.push(await textLength(page));
    }
    return samples.every((n) => n === samples[0] && n >= 0);
  }

  /**
   * A listing: sample the same-host link count every pollMs; settled once at least minSettleMs have passed and the
   * last `stableSamples` counts are equal with no data request in flight. Still changing at settleCapMs: not settled.
   */
  private async settleListing(page: Page, state: RenderState): Promise<boolean> {
    const t = this.timing;
    const start = Date.now();
    const counts: number[] = [];
    for (;;) {
      await sleep(t.pollMs);
      counts.push(await sameHostLinks(page));
      const last = counts.slice(-t.stableSamples);
      const stable = last.length === t.stableSamples && last.every((n) => n === last[0] && n >= 0) && state.inflight.size === 0;
      const elapsed = Date.now() - start;
      if (stable && elapsed >= t.minSettleMs) return true;
      if (elapsed >= t.settleCapMs) return false;
    }
  }

  /** Clicks same-page "load more" buttons one at a time, re-settling after each, up to maxClicks. */
  private async expand(page: Page, state: RenderState): Promise<{ clicks: number; capReached: boolean; settled: boolean }> {
    let clicks = 0;
    for (;;) {
      const id = await page.evaluate(nextExpandable, FORM_BUTTON_TYPES);
      if (id === null) return { clicks, capReached: false, settled: true };
      if (clicks >= this.timing.maxClicks) return { clicks, capReached: true, settled: true };
      const before = await sameHostLinks(page);
      try {
        await page.click(`[data-jobpilot-expand="${id}"]`, { timeout: 5_000 });
      } catch {
        await page.evaluate(markControl, { id, as: 'failed' }).catch(() => undefined);
        continue;
      }
      clicks += 1;
      if (!(await this.settleListing(page, state))) return { clicks, capReached: false, settled: false };
      if ((await sameHostLinks(page)) === before) await page.evaluate(markControl, { id, as: 'exhausted' }).catch(() => undefined);
    }
  }
}

/** Same-host `a[href]` count; -1 while the document is being replaced. */
async function sameHostLinks(page: Page): Promise<number> {
  return page
    .evaluate(() => {
      let n = 0;
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        try {
          if (new URL((a as HTMLAnchorElement).href, location.href).host === location.host) n += 1;
        } catch {
          // An unparsable href is not a link.
        }
      }
      return n;
    })
    .catch(() => -1);
}

async function textLength(page: Page): Promise<number> {
  return page.evaluate(() => document.body?.innerText.length ?? 0).catch(() => -1);
}

/** In the page: the next visible "load more" control to click, marked with a fresh id, or null. */
function nextExpandable(formButtonTypes: string[]): string | null {
  const re = /load more|show more|more jobs|show all/i;
  for (const el of Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"]'))) {
    if (!(el instanceof HTMLElement) || el.hasAttribute('data-jobpilot-done')) continue;
    const label = ((el instanceof HTMLInputElement ? el.value : el.innerText) || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    if (!re.test(label)) continue;
    const href = el.tagName === 'A' ? el.getAttribute('href') : null;
    if (href !== null && !/^\s*(#|javascript:)/i.test(href)) continue; // a real link: the agent follows it
    if (el.closest('form') !== null) continue;
    if (formButtonTypes.includes((el.getAttribute('type') ?? '').toLowerCase())) continue;
    if ((el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true') continue;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
    const n = Number(document.documentElement.getAttribute('data-jobpilot-n') ?? '0') + 1;
    document.documentElement.setAttribute('data-jobpilot-n', String(n));
    el.setAttribute('data-jobpilot-expand', String(n));
    return String(n);
  }
  return null;
}

/** In the page: marks a clicked control as exhausted (it added nothing) or failed (it could not be clicked). */
function markControl(a: { id: string; as: string }): void {
  document.querySelector(`[data-jobpilot-expand="${a.id}"]`)?.setAttribute('data-jobpilot-done', a.as);
}

/**
 * Controls that look like pagination but have no link to follow: script-only next or numbered buttons, a load-more
 * the expansion could not click (inside a form, failed). Real links are the agent's to follow.
 */
async function unfollowedControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const words = /^(next( page)?|more jobs|(show|view|see) all( jobs| positions| openings| roles)?|(load|show|view|see) more( jobs| positions| openings| roles| results)?)$/i;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"]'))) {
      if (!(el instanceof HTMLElement) || el.getAttribute('data-jobpilot-done') === 'exhausted') continue;
      const href = el.tagName === 'A' ? el.getAttribute('href') : null;
      if (href !== null && !/^\s*(#|javascript:)/i.test(href)) continue;
      if ((el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true') continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const raw = ((el instanceof HTMLInputElement ? el.value : el.innerText) || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      const t = raw.replace(/\(\s*\d+\s*\)/g, '').replace(/\s+/g, ' ').trim();
      const pager = el.closest('nav, [role="navigation"], [class*="pag" i], [aria-label*="pag" i]') !== null;
      const looks = /^[›»>]+$/.test(t) || words.test(t.replace(/\s*[›»>]+$/, '').trim()) || (pager && /^\d+$/.test(t));
      if (looks) out.push(el.outerHTML.replace(/\s+/g, ' ').slice(0, 160));
    }
    return out.slice(0, 10);
  });
}
