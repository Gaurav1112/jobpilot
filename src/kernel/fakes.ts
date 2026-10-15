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
      return { status: r.status ?? 200, finalUrl: r.finalUrl ?? req.url, html: r.html, text: r.text ?? '', jsonLd: r.jsonLd ?? [], headers: r.headers ?? {}, settled: r.settled ?? true, ...(r.settleCapMs !== undefined ? { settleCapMs: r.settleCapMs } : {}), ...expansion };
    },
  };
}

/**
 * Timers driven by hand (`AwakeTimers`): `advance` runs what falls due, in order; `suspend` moves the clock on and runs
 * nothing, like a Mac asleep (no CPU time passes); `block` moves the clock and the CPU time on and runs nothing, like a
 * synchronous busy block of the event loop.
 */
export interface ManualTimers {
  now(): number;
  cpuMs(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Moves the clock `ms` on, running every timer due by then in order (an overdue one runs at the current time). */
  advance(ms: number): void;
  /** Moves the clock `ms` on and runs nothing: the process was suspended. The overdue timers run at the next `advance`. */
  suspend(ms: number): void;
  /**
   * Moves the clock `ms` and the CPU time `cpuMs` (default `ms`) on and runs nothing: a busy block (on a loaded machine,
   * less CPU time than clock time). The overdue timers run at the next `advance`.
   */
  block(ms: number, cpuMs?: number): void;
  /** Timers still scheduled. */
  pending(): number;
}

export function manualTimers(start = 0): ManualTimers {
  let now = start;
  let cpu = 0;
  let seq = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const nextDue = (target: number): number | undefined => {
    let best: number | undefined;
    for (const [id, e] of queue) {
      if (e.at > target) continue;
      const b = best === undefined ? undefined : queue.get(best);
      if (b === undefined || e.at < b.at) best = id;
    }
    return best;
  };
  return {
    now: () => now,
    cpuMs: () => cpu,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      queue.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (handle) => void queue.delete(handle as number),
    advance(ms) {
      const target = now + ms;
      for (let id = nextDue(target); id !== undefined; id = nextDue(target)) {
        const e = queue.get(id) as { at: number; fn: () => void };
        queue.delete(id);
        now = Math.max(now, e.at);
        e.fn();
      }
      now = target;
    },
    suspend(ms) {
      now += ms;
    },
    block(ms, cpuMs = ms) {
      now += ms;
      cpu += cpuMs;
    },
    pending: () => queue.size,
  };
}
