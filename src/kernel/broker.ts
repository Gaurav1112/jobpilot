import type { Clock } from './clock.js';
import type { AnyContract } from './contract.js';
import type { DataClass } from './data-class.js';
import type { Cost } from './envelope.js';
import { KernelError } from './errors.js';
import { egressAllowed, type Policy } from './policy.js';
import type { LlmResponse, Providers } from './providers.js';

export interface HttpTool {
  getText(url: string): Promise<{ status: number; body: string }>;
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

  if (a.contract.capabilities.http) {
    ctx.http = {
      async getText(url) {
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
        if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new requests');
        let res;
        let body;
        try {
          res = await a.providers.fetch(u.href, { signal: a.signal, redirect: 'manual' });
          if (res.status >= 300 && res.status < 400) {
            throw deny(`G-EGRESS: redirect from ${u.hostname} refused`);
          }
          if (res.status === 429) throw new KernelError('rate_limit', `429 from ${u.hostname}`);
          if (res.status >= 500) throw new KernelError('overloaded', `${res.status} from ${u.hostname}`);
          body = await res.text();
        } catch (e) {
          throw mapProviderError(e);
        }
        return { status: res.status, body };
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
          const reserve = Math.max(a.contract.budget.usdPerCall, prior.maxCallUsd ?? 0);
          if (exceeds(usd + reserve, a.contract.budget.usdPerRun)) {
            throw new KernelError('budget_exceeded', 'G-BUDGET: usdPerRun reached in this step');
          }
          if (exceeds(prior.agentUsd + usd + reserve, a.contract.budget.usdPerRun) || exceeds(prior.runUsd + usd + reserve, a.policy.maxUsdPerRun)) {
            throw new KernelError('budget_exceeded', 'G-BUDGET: run budget reached');
          }
          let res;
          try {
            res = await provider.complete({ ...req, model: llmCap.model, maxTokens: llmCap.maxTokens }, a.signal);
          } catch (e) {
            // A failed provider call reports no usage, so spend is left unchanged.
            throw mapProviderError(e);
          }
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
