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
}

export interface IssueArgs {
  readonly contract: AnyContract;
  readonly policy: Policy;
  readonly inputClass: DataClass;
  readonly providers: Providers;
  readonly clock: Clock;
  readonly signal: AbortSignal;
}

export function issueContext(a: IssueArgs): AgentContext {
  let usd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const checkHost = (host: string): void => {
    if (!a.contract.egress.includes(host)) {
      throw new KernelError('policy_denied', `G-EGRESS: ${a.contract.id} may not contact ${host}`);
    }
    if (!egressAllowed(a.policy, host, a.inputClass)) {
      throw new KernelError('policy_denied', `G-PII-EGRESS: ${a.inputClass} data may not be sent to ${host}`);
    }
  };

  const ctx: { -readonly [K in keyof AgentContext]: AgentContext[K] } = {
    clock: a.clock,
    signal: a.signal,
    spent: () => ({ usd, inputTokens, outputTokens }),
  };

  if (a.contract.capabilities.http) {
    ctx.http = {
      async getText(url) {
        const u = new URL(url);
        if (u.protocol !== 'https:') throw new KernelError('policy_denied', `G-EGRESS: only https is allowed (${url})`);
        checkHost(u.hostname);
        let res;
        try {
          res = await a.providers.fetch(url, { signal: a.signal });
        } catch (e) {
          if ((e as { name?: string }).name === 'TimeoutError') throw e;
          throw new KernelError('network', `fetch failed for ${url}`);
        }
        if (res.status === 429) throw new KernelError('rate_limit', `429 from ${u.hostname}`);
        if (res.status >= 500) throw new KernelError('overloaded', `${res.status} from ${u.hostname}`);
        return { status: res.status, body: await res.text() };
      },
    };
  }

  const llmCap = a.contract.capabilities.llm;
  const provider = a.providers.llm;
  if (llmCap && provider) {
    ctx.llm = {
      async complete(req) {
        checkHost(provider.host);
        const res = await provider.complete({ ...req, model: llmCap.model, maxTokens: llmCap.maxTokens }, a.signal);
        usd += res.usd;
        inputTokens += res.inputTokens;
        outputTokens += res.outputTokens;
        if (res.usd > a.contract.budget.usdPerCall) {
          throw new KernelError('budget_exceeded', `G-BUDGET: call cost ${res.usd} > usdPerCall ${a.contract.budget.usdPerCall}`);
        }
        return res;
      },
    };
  }
  return ctx;
}
