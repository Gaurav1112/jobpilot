export interface FetchResponse {
  readonly status: number;
  /** When present the broker reads this stream and stops at the size cap; otherwise it measures text(). */
  readonly body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; redirect: 'manual'; headers: Readonly<Record<string, string>> },
) => Promise<FetchResponse>;

export interface LlmRequest {
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxTokens: number;
}

export interface LlmResponse {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
}

export interface LlmProvider {
  /** Host the provider talks to; checked against contract egress and data-class policy. */
  readonly host: string;
  complete(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
}

/** One fully rendered page, as the browser saw it after scripts ran. */
export interface BrowserPage {
  readonly status: number;
  /** Where the page ended up after redirects; the broker checks its host against egress. */
  readonly finalUrl: string;
  /** The serialized DOM after rendering. */
  readonly html: string;
  /** The visible text of the page's main content. */
  readonly text: string;
  /** Every `application/ld+json` block that parsed, in document order. */
  readonly jsonLd: readonly unknown[];
}

/**
 * What the broker hands a browser provider for one render. The broker fixes every field; an agent
 * only names the URL. There is no header, user-agent, proxy, stealth or fingerprint field (G-NO-EVASION).
 */
export interface BrowserRenderRequest {
  readonly url: string;
  /** Exact hosts a top-level navigation (the URL itself or a redirect) may reach; the provider aborts any other. */
  readonly navigationHosts: readonly string[];
  /** Hosts, and their subdomains, that no request from the page may reach. */
  readonly deniedHosts: readonly string[];
  readonly signal: AbortSignal;
}

/**
 * Renders one page read-only: a fresh browser context, the honest user-agent, no stored cookies, no form
 * filling, no clicks. Tests use `fakeBrowser`; production uses `PlaywrightBrowserProvider` (src/app/browser).
 */
export interface BrowserProvider {
  render(req: BrowserRenderRequest): Promise<BrowserPage>;
}

/** The only doors to the outside world. Agents never see these directly, only broker tools. */
export interface Providers {
  readonly fetch: FetchLike;
  readonly llm?: LlmProvider;
  readonly browser?: BrowserProvider;
}

export const nodeFetch: FetchLike = (url, init) => fetch(url, { signal: init.signal, redirect: init.redirect, headers: { ...init.headers } });
