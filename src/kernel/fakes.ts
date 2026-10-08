import type { FetchLike, LlmProvider, LlmRequest } from './providers.js';

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
