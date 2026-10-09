import type { Clock } from './clock.js';
import type { AnyContract } from './contract.js';
import type { DataClass } from './data-class.js';
import type { Cost } from './envelope.js';
import { KernelError } from './errors.js';
import { egressAllowed, normalizeHost, type Policy } from './policy.js';
import { challengeReason } from './challenge.js';
import type { BrowserPage, FetchResponse, LlmResponse, Providers } from './providers.js';

export interface HttpTool {
  getText(url: string): Promise<{ status: number; body: string }>;
  /**
   * Like getText, then parses the body; a body that is not JSON is `invalid_output`.
   * A status of 400 or more is not parsed: the result is `{ status, json: null }` and the caller maps it.
   */
  getJson(url: string): Promise<{ status: number; json: unknown }>;
}

/** Fixed request headers. The user-agent is honest and never configurable (G-NO-EVASION). */
export const HTTP_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  accept: 'application/json, text/plain;q=0.8, */*;q=0.1',
  'user-agent': 'jobpilot/0.1 (+local)',
});

/** Spaces requests to one host by at least `minIntervalMs`; one instance is shared by every context of a supervisor. */
export interface HostPacer {
  wait(host: string): Promise<void>;
}

/**
 * Each request to a host is scheduled at max(now, previous slot + interval) and waits until its slot.
 * The slot is claimed before sleeping, so concurrent waits on one host are spaced, never collapsed.
 * Time comes from the injected clock and sleep, so tests are deterministic.
 */
export function createHostPacer(minIntervalMs: number, clock: Clock, sleep: (ms: number) => Promise<void>): HostPacer {
  const lastRequestAt = new Map<string, number>();
  return {
    async wait(host) {
      const h = normalizeHost(host);
      const now = Date.parse(clock.now());
      const last = lastRequestAt.get(h);
      const slot = last === undefined ? now : Math.max(now, last + minIntervalMs);
      lastRequestAt.set(h, slot);
      if (slot > now) await sleep(slot - now);
    },
  };
}

/** Reads a response body, refusing it once it passes `maxBytes`. A stream is cancelled at the cap, not read to the end. */
async function readCapped(res: FetchResponse, maxBytes: number): Promise<string> {
  const tooBig = (): KernelError => new KernelError('invalid_output', `response exceeds ${maxBytes} bytes`);
  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooBig();
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw tooBig();
  return text;
}

/** Read-only page rendering. The agent names the URL and whether it is a listing; the broker fixes everything else. */
export interface BrowserTool {
  render(url: string, opts?: { readonly expand?: boolean; readonly linkPattern?: string }): Promise<BrowserPage>;
}

export interface LlmTool {
  complete(req: { system: string; prompt: string }): Promise<LlmResponse>;
}

/**
 * Everything an agent may touch. Tools exist only when the contract grants
 * them. There is deliberately no proxy, user-agent, fingerprint or CAPTCHA
 * capability: those are absent, not disabled (G-NO-EVASION).
 */
export interface AgentContext {
  readonly clock: Clock;
  readonly signal: AbortSignal;
  readonly http?: HttpTool;
  readonly llm?: LlmTool;
  /** Present only when the contract declares `capabilities.browser`. */
  readonly browser?: BrowserTool;
  /** The user's pack, deep-frozen; present only when the contract declares `capabilities.pack`. */
  readonly pack?: Readonly<unknown>;
  spent(): Cost;
  /** The largest single model call paid in this context. */
  maxCall(): number;
  /** Every policy denial the broker raised in this context, in order, whether or not the agent caught it. */
  denials(): readonly string[];
}

export interface IssueArgs {
  readonly contract: AnyContract;
  readonly policy: Policy;
  readonly inputClass: DataClass;
  readonly providers: Providers;
  readonly clock: Clock;
  readonly signal: AbortSignal;
  /** What the run had already paid before this context was issued: by this agent, and in total. */
  readonly priorSpend?: { readonly agentUsd: number; readonly runUsd: number; readonly maxCallUsd?: number };
  /** The pack this contract may read (public or full), already frozen by `freezePack`; ignored unless the contract declares capabilities.pack. */
  readonly pack?: unknown;
  /** Shared per-host pacing; without one, requests are not paced (unit tests, evals). */
  readonly hostPacer?: HostPacer;
  /** Shared per-host pacing of browser renders (`policy.minBrowserIntervalMs`), applied before `hostPacer`. */
  readonly browserPacer?: HostPacer;
}

/** Freezes every object reachable from `v`, in place. Cycles are safe. Typed arrays and DataViews cannot be frozen, so they are skipped. */
function deepFreeze<T>(v: T, seen = new WeakSet<object>()): T {
  if (v !== null && typeof v === 'object' && !seen.has(v) && !ArrayBuffer.isView(v)) {
    seen.add(v);
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child, seen);
  }
  return v;
}

/**
 * A deep-frozen deep copy of a pack: the caller's object is never frozen. The Supervisor calls it once
 * per pack; every context then shares the same read-only view. Typed arrays inside stay mutable.
 */
export function freezePack<T>(pack: T): Readonly<T> {
  return deepFreeze(structuredClone(pack));
}

function mapProviderError(e: unknown): unknown {
  if (e instanceof KernelError) return e;
  const o = typeof e === 'object' && e !== null ? (e as { name?: unknown; status?: unknown; message?: unknown }) : {};
  if (o.name === 'TimeoutError') return e;
  if (typeof o.status === 'number') {
    if (o.status === 429) return new KernelError('rate_limit', `provider returned ${o.status}`);
    if (o.status >= 500) return new KernelError('overloaded', `provider returned ${o.status}`);
  }
  if (o.name === 'AbortError') return new KernelError('unknown', 'request aborted');
  return new KernelError('network', typeof o.message === 'string' ? o.message : 'provider call failed');
}

/** Sums of decimal dollar amounts drift (0.1 + 0.2 > 0.3); a cap is only exceeded beyond that noise. */
const exceeds = (total: number, cap: number): boolean => total > cap + 1e-9;

export function issueContext(a: IssueArgs): AgentContext {
  let usd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let maxCallUsd = 0;
  const prior = a.priorSpend ?? { agentUsd: 0, runUsd: 0 };
  const denied: string[] = [];
  /** A policy denial is recorded before it is thrown, so an agent cannot hide it by catching. */
  const deny = (message: string): KernelError => {
    denied.push(message);
    return new KernelError('policy_denied', message);
  };

  const checkHost = (host: string): void => {
    if (!a.contract.egress.includes(host)) {
      throw deny(`G-EGRESS: ${a.contract.id} may not contact ${host}`);
    }
    if (!egressAllowed(a.policy, host, a.inputClass)) {
      throw deny(`G-PII-EGRESS: ${a.inputClass} data may not be sent to ${host}`);
    }
  };

  const ctx: { -readonly [K in keyof AgentContext]: AgentContext[K] } = {
    clock: a.clock,
    signal: a.signal,
    spent: () => ({ usd, inputTokens, outputTokens }),
    maxCall: () => maxCallUsd,
    denials: () => [...denied],
  };

  if (a.contract.capabilities.pack && a.pack !== undefined && a.pack !== null) ctx.pack = a.pack;

  /** https only, no explicit port, no credentials, and an egress host the policy allows. */
  const checkUrl = (url: string): URL => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw deny('G-EGRESS: invalid URL');
    }
    if (u.protocol !== 'https:') throw deny(`G-EGRESS: only https is allowed (${u.protocol}//${u.hostname})`);
    if (u.port !== '') throw deny(`G-EGRESS: explicit ports are not allowed (${u.hostname})`);
    if (u.username !== '' || u.password !== '') throw deny('G-EGRESS: credentials in URLs are not allowed');
    checkHost(u.hostname);
    return u;
  };

  if (a.contract.capabilities.http) {
    const getText = async (url: string): Promise<{ status: number; body: string }> => {
      const u = checkUrl(url);
      if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new requests');
      await a.hostPacer?.wait(u.hostname);
      if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new requests');
      let res;
      let body;
      try {
        res = await a.providers.fetch(u.href, { signal: a.signal, redirect: 'manual', headers: HTTP_HEADERS });
        if (res.status >= 300 && res.status < 400) {
          throw deny(`G-EGRESS: redirect from ${u.hostname} refused`);
        }
        if (res.status === 429) throw new KernelError('rate_limit', `429 from ${u.hostname}`);
        if (res.status >= 500) throw new KernelError('overloaded', `${res.status} from ${u.hostname}`);
        body = await readCapped(res, a.policy.maxResponseBytes);
      } catch (e) {
        throw mapProviderError(e);
      }
      return { status: res.status, body };
    };
    ctx.http = {
      getText,
      async getJson(url) {
        const { status, body } = await getText(url);
        if (status >= 400) return { status, json: null };
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          throw new KernelError('invalid_output', `response from ${new URL(url).hostname} is not valid JSON`);
        }
        return { status, json };
      },
    };
  }

  const browserCap = a.contract.capabilities.browser;
  if (browserCap) {
    let pages = 0;
    ctx.browser = {
      async render(url, opts) {
        // The only options are `expand` and `linkPattern`; anything else (a header, a user agent, a proxy) is refused, not ignored.
        if (
          opts !== undefined &&
          (typeof opts !== 'object' ||
            opts === null ||
            Object.keys(opts).some((k) => k !== 'expand' && k !== 'linkPattern') ||
            (opts.expand !== undefined && typeof opts.expand !== 'boolean') ||
            (opts.linkPattern !== undefined && (typeof opts.linkPattern !== 'string' || opts.linkPattern.length > 200)))
        ) {
          throw deny('G-NO-EVASION: render accepts only { expand: boolean, linkPattern: string }');
        }
        const u = checkUrl(url);
        if (pages >= browserCap.maxPages) {
          throw new KernelError('budget_exceeded', `G-BUDGET: page budget of ${browserCap.maxPages} pages reached in this step`);
        }
        const provider = a.providers.browser;
        if (!provider) throw deny('no browser provider is configured');
        if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new renders');
        pages += 1;
        await a.browserPacer?.wait(u.hostname);
        await a.hostPacer?.wait(u.hostname);
        if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new renders');
        let page: BrowserPage;
        try {
          // A redirect may only land on an egress host the policy also allows for this data class.
          const navigationHosts = a.contract.egress.filter((h) => egressAllowed(a.policy, h, a.inputClass));
          page = await provider.render({
            url: u.href,
            navigationHosts,
            deniedHosts: [...a.policy.deniedEgressHosts],
            deniedBrands: [...a.policy.deniedEgressBrands],
            maxBytes: a.policy.maxResponseBytes,
            expand: opts?.expand === true,
            ...(opts?.linkPattern !== undefined ? { linkPattern: opts.linkPattern } : {}),
            signal: a.signal,
          });
        } catch (e) {
          // The provider refuses what the page itself tried (a form POST): that is a denial of this step too.
          if (e instanceof KernelError && e.code === 'policy_denied') denied.push(e.message);
          throw mapProviderError(e);
        }
        // The landing page is checked like the request: a redirect may not leave egress or drop to http.
        let final: URL;
        try {
          final = new URL(page.finalUrl);
        } catch {
          throw deny(`G-EGRESS: render of ${u.hostname} ended on an invalid URL`);
        }
        if (final.protocol !== 'https:') throw deny(`G-EGRESS: only https is allowed (redirect to ${final.protocol}//${final.hostname})`);
        if (normalizeHost(final.hostname) !== normalizeHost(u.hostname) && !a.contract.egress.includes(final.hostname)) {
          throw deny(`G-EGRESS: redirect from ${u.hostname} to ${final.hostname} refused`);
        }
        checkUrl(final.href);
        if (Buffer.byteLength(page.html, 'utf8') > a.policy.maxResponseBytes) {
          throw new KernelError('invalid_output', `response exceeds ${a.policy.maxResponseBytes} bytes`);
        }
        const challenge = challengeReason(page);
        if (challenge !== null) {
          throw new KernelError('challenged', `G-CHALLENGE: ${final.hostname} answered with a bot wall or CAPTCHA (${challenge}); stopping without retry`);
        }
        if (page.status >= 500) throw new KernelError('overloaded', `${page.status} from ${final.hostname}`);
        return {
          status: page.status,
          finalUrl: page.finalUrl,
          html: page.html,
          text: page.text,
          jsonLd: [...page.jsonLd],
          headers: { ...page.headers },
          settled: page.settled,
          ...(page.settleCapMs !== undefined ? { settleCapMs: page.settleCapMs } : {}),
          ...(page.expansion ? { expansion: { ...page.expansion, unfollowedControls: [...page.expansion.unfollowedControls] } } : {}),
        };
      },
    };
  }

  const llmCap = a.contract.capabilities.llm;
  const provider = a.providers.llm;
  if (llmCap) {
    let overCall = false;
    let inFlight = false;
    ctx.llm = {
      async complete(req) {
        if (!provider) throw deny('no LLM provider is configured');
        checkHost(provider.host);
        if (inFlight) throw deny('G-BUDGET: one model call at a time per step');
        if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new model calls');
        inFlight = true;
        try {
          if (overCall) throw new KernelError('budget_exceeded', 'G-BUDGET: a previous call exceeded usdPerCall');
          // Every call reserves a full usdPerCall (or the largest call this agent has already
          // been charged in the run, if that was more) before it is made, so the caps are hard:
          // a call that costs more than usdPerCall is latched above, everything else fits.
          // Bounds, stated exactly: (a) a call that returns in time and costs more than usdPerCall is charged
          // in full and stops this agent for the rest of the run, so a run can exceed policy.maxUsdPerRun by at
          // most (actual - usdPerCall) once per LLM agent; (b) a call still in flight when the step times out
          // is recorded at its reservation (max of usdPerCall and the largest call seen); what the provider
          // actually bills for it is not visible to the kernel and is bounded only per call by the provider's
          // pricing for maxTokens; (c) spend of a call in flight when the process itself dies is not recorded
          // and the step re-runs on resume.
          const reserve = Math.max(a.contract.budget.usdPerCall, prior.maxCallUsd ?? 0);
          if (exceeds(usd + reserve, a.contract.budget.usdPerRun)) {
            throw new KernelError('budget_exceeded', 'G-BUDGET: usdPerRun reached in this step');
          }
          if (exceeds(prior.agentUsd + usd + reserve, a.contract.budget.usdPerRun) || exceeds(prior.runUsd + usd + reserve, a.policy.maxUsdPerRun)) {
            throw new KernelError('budget_exceeded', 'G-BUDGET: run budget reached');
          }
          // A call still in flight when the step times out is charged its reservation at once, so the
          // executor (which reads spent() right after the abort) records it. Whatever the provider answers
          // later is discarded, never added a second time. Bound (b) above: accounting for a timed-out call is the
          // reservation, never zero, even though the provider may bill more for it.
          let chargedOnAbort = false;
          const chargeOnAbort = (): void => {
            chargedOnAbort = true;
            usd += reserve;
            maxCallUsd = Math.max(maxCallUsd, reserve);
          };
          a.signal.addEventListener('abort', chargeOnAbort, { once: true });
          let res;
          try {
            res = await provider.complete({ ...req, model: llmCap.model, maxTokens: llmCap.maxTokens }, a.signal);
          } catch (e) {
            // A failed provider call reports no usage, so spend is left unchanged (unless it was charged on abort).
            throw mapProviderError(e);
          } finally {
            a.signal.removeEventListener('abort', chargeOnAbort);
          }
          if (chargedOnAbort) throw new KernelError('timeout', 'step timed out; the late model answer is discarded');
          usd += res.usd;
          inputTokens += res.inputTokens;
          outputTokens += res.outputTokens;
          maxCallUsd = Math.max(maxCallUsd, res.usd);
          if (res.usd > a.contract.budget.usdPerCall) {
            overCall = true;
            throw new KernelError('budget_exceeded', `G-BUDGET: call cost ${res.usd} > usdPerCall ${a.contract.budget.usdPerCall}`);
          }
          return res;
        } finally {
          inFlight = false;
        }
      },
    };
  }
  return ctx;
}
