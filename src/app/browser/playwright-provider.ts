import { chromium, type Browser, type Route } from 'playwright';
import { HTTP_HEADERS } from '../../kernel/broker.js';
import { hostMatches, normalizeHost } from '../../kernel/policy.js';
import type { BrowserPage, BrowserProvider, BrowserRenderRequest } from '../../kernel/providers.js';

/** The longest one render waits for the page to settle (network idle) after it starts loading. */
export const RENDER_WAIT_MS = 20_000;

/** Resource types a read-only scan never needs; they are aborted before they leave the machine. */
const BLOCKED_TYPES = new Set(['image', 'font', 'media']);

/** Redirect hops one render follows before giving up. */
const MAX_REDIRECTS = 10;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface PlaywrightProviderOptions {
  /**
   * Test-only: lets top-level navigations use plain http on a loopback host, so a local `node:http` fixture server
   * can be rendered. It does not exist on the capability or the contract, and the broker never renders http, so a
   * production pipeline cannot reach it. Never set it outside tests.
   */
  readonly allowInsecureLocalhostForTests?: boolean;
}

/**
 * The real `BrowserProvider`: headless Chromium (the headless shell) via Playwright.
 *
 * - One browser process, launched on first use; a fresh context per render, so no cookie, storage or cache
 *   survives from one page to the next (stricter than one context per step).
 * - The honest user-agent and the broker's `accept` header on the page's own navigation; nothing is disguised.
 * - Top-level navigations (the URL and any redirect) may reach only `navigationHosts`; any other is aborted
 *   and reported as the `finalUrl`, which the broker then denies. Requests to a denied host (or its
 *   subdomains), and images, fonts and media, are aborted.
 * - It waits for network idle, capped at RENDER_WAIT_MS; a page still busy at the cap is read as it stands.
 * - It never clicks, types, fills or submits anything, accepts no downloads, and blocks service workers.
 */
export class PlaywrightBrowserProvider implements BrowserProvider {
  private browser: Promise<Browser> | undefined;

  constructor(private readonly opts: PlaywrightProviderOptions = {}) {}

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
    if (url.protocol === 'https:') return hosts.some((h) => normalizeHost(h) === host);
    return this.opts.allowInsecureLocalhostForTests === true && url.protocol === 'http:' && LOOPBACK.has(host) && hosts.some((h) => normalizeHost(h) === host);
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
    try {
      let blockedNavigation: string | undefined;
      let redirectTo: string | undefined;
      await context.route('**/*', async (route: Route) => {
        const request = route.request();
        let url: URL;
        try {
          url = new URL(request.url());
        } catch {
          return route.abort('blockedbyclient');
        }
        if (request.isNavigationRequest() && request.frame().parentFrame() === null) {
          if (!this.navigationAllowed(url, req.navigationHosts)) {
            blockedNavigation ??= url.href;
            return route.abort('blockedbyclient');
          }
          // Chromium does not route redirect hops, so the document is fetched here without following redirects.
          // A redirect to an allowed host becomes a fresh navigation (which comes back through this handler);
          // any other is aborted before a request reaches it.
          let res;
          try {
            res = await route.fetch({ maxRedirects: 0, timeout: RENDER_WAIT_MS, headers: { ...request.headers(), accept: HTTP_HEADERS['accept'] as string } });
          } catch {
            // The navigation then fails in page.goto with a network error, which the broker maps.
            return route.abort('failed');
          }
          const location = res.headers()['location'];
          if (res.status() >= 300 && res.status() < 400 && location !== undefined) {
            const target = new URL(location, url);
            if (this.navigationAllowed(target, req.navigationHosts)) redirectTo ??= target.href;
            else blockedNavigation ??= target.href;
            return route.abort('blockedbyclient');
          }
          return route.fulfill({ response: res });
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return route.continue();
        if (BLOCKED_TYPES.has(request.resourceType())) return route.abort('blockedbyclient');
        if (req.deniedHosts.some((d) => hostMatches(url.hostname, d))) return route.abort('blockedbyclient');
        return route.continue();
      });

      const deadline = Date.now() + RENDER_WAIT_MS;
      const blocked = (): BrowserPage => ({ status: 0, finalUrl: blockedNavigation as string, html: '', text: '', jsonLd: [] });
      let response;
      let page = await context.newPage();
      for (let target = req.url, hops = 0; ; hops++) {
        if (hops > MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects from ${req.url}`);
        if (hops > 0) {
          // The aborted hop leaves its page on an error document; the next hop starts on a fresh page.
          await page.close();
          page = await context.newPage();
        }
        redirectTo = undefined;
        try {
          response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()) });
        } catch (e) {
          if (blockedNavigation === undefined && redirectTo === undefined) throw e;
        }
        if (blockedNavigation !== undefined) return blocked();
        if (redirectTo === undefined) break;
        target = redirectTo;
      }
      await page.waitForLoadState('networkidle', { timeout: Math.max(1, deadline - Date.now()) }).catch((e: unknown) => {
        // Past the cap the page is read as it stands; anything other than the cap is a real failure.
        if ((e as { name?: unknown }).name !== 'TimeoutError') throw e;
      });
      if (blockedNavigation !== undefined) return blocked();

      const html = await page.content();
      const { text, ld } = await page.evaluate(() => {
        const main = document.querySelector('main, [role="main"]') ?? document.body;
        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'), (s) => s.textContent ?? '');
        return { text: main instanceof HTMLElement ? main.innerText : (main?.textContent ?? ''), ld: scripts };
      });
      const jsonLd: unknown[] = [];
      for (const s of ld) {
        try {
          jsonLd.push(JSON.parse(s));
        } catch {
          // A malformed block is not structured data; the agent falls back to the page's h1 and text.
        }
      }
      return { status: response?.status() ?? 0, finalUrl: page.url(), html, text, jsonLd };
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      await context.close().catch(() => undefined);
    }
  }
}
