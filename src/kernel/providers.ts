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
  /** Response headers of the top-level document, lower-cased names. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Whether the page finished rendering. A job page: network idle reached, or its text stopped changing. A listing
   * (`expand`): the same-host link count was stable over three polls with no request in flight, within the cap.
   */
  readonly settled: boolean;
  /** Listing pages only (`expand: true`): what expanding the list did and what it could not follow. */
  readonly expansion?: BrowserExpansion;
}

export interface BrowserExpansion {
  /** "Load more"-style buttons clicked. */
  readonly clicks: number;
  /** Scrolls to the bottom that loaded more jobs (infinite scroll). */
  readonly scrolls: number;
  /** True when clicking or scrolling was still adding jobs at its cap (count or time). */
  readonly capReached: boolean;
  /** Controls that look like pagination but have no link to follow (for example a script-only "Next" button). */
  readonly unfollowedControls: readonly string[];
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
  /** Brand labels (`policy.deniedEgressBrands`) no request from the page may reach under any suffix. */
  readonly deniedBrands: readonly string[];
  /** The document size cap (policy.maxResponseBytes); a larger document fails the render. */
  readonly maxBytes: number;
  /**
   * A listing page: wait until the list stops growing, then click same-page "load more" buttons (never inside a
   * form, never a form button) until none is left, and report pagination controls that cannot be followed.
   */
  readonly expand: boolean;
  /**
   * The agent's job-link pattern (a regex source, tested on path plus query of same-host links). The provider counts
   * matching links to decide that a listing has settled and that each load-more click added jobs.
   */
  readonly linkPattern?: string;
  readonly signal: AbortSignal;
}

/**
 * Renders one page read-only: a fresh browser context, the honest user-agent, no stored cookies, no form
 * filling, no clicks except "load more" buttons on a listing (`expand`). Tests use `fakeBrowser`; production uses `PlaywrightBrowserProvider` (src/app/browser).
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
