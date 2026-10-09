import type { BrowserPage, BrowserProvider, BrowserRenderRequest, FetchLike, LlmProvider, LlmRequest } from './providers.js';

export function fakeFetch(routes: Record<string, { status?: number; body: string }>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return { status: 404, text: async () => 'not found' };
    return { status: r.status ?? 200, text: async () => r.body };
  };
  return Object.assign(f, { calls });
}

/** A deterministic stand-in for a model: same request, same answer, fixed cost. */
export function fakeLlm(
  respond: (req: LlmRequest) => string,
  opts: { usdPerCall?: number; host?: string } = {},
): LlmProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    host: opts.host ?? 'api.anthropic.com',
    calls,
    async complete(req) {
      calls.push(req);
      const text = respond(req);
      return { text, inputTokens: req.prompt.length, outputTokens: text.length, usd: opts.usdPerCall ?? 0.001 };
    },
  };
}

/** A browser that serves canned pages by URL; an unknown URL is a 404. Defaults: status 200, finalUrl the URL, settled, no headers. */
export function fakeBrowser(
  routes: Record<string, Partial<BrowserPage> & { readonly html: string }>,
): BrowserProvider & { calls: BrowserRenderRequest[] } {
  const calls: BrowserRenderRequest[] = [];
  return {
    calls,
    async render(req) {
      calls.push(req);
      const r = routes[req.url];
      const expansion = req.expand ? { expansion: r?.expansion ?? { clicks: 0, scrolls: 0, capReached: false, unfollowedControls: [] } } : {};
      if (!r) return { status: 404, finalUrl: req.url, html: '<h1>Not found</h1>', text: 'Not found', jsonLd: [], headers: {}, settled: true, ...expansion };
      return { status: r.status ?? 200, finalUrl: r.finalUrl ?? req.url, html: r.html, text: r.text ?? '', jsonLd: r.jsonLd ?? [], headers: r.headers ?? {}, settled: r.settled ?? true, ...expansion };
    },
  };
}
