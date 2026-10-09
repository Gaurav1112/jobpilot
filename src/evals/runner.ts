import { readFileSync } from 'node:fs';
import type { AnyAgent } from '../kernel/agent.js';
import { issueContext } from '../kernel/broker.js';
import { canonicalJson } from '../kernel/canonical.js';
import { fixedClock } from '../kernel/clock.js';
import { classify, KernelError } from '../kernel/errors.js';
import type { Policy } from '../kernel/policy.js';
import type { BrowserProvider, FetchLike, Providers } from '../kernel/providers.js';
import { exactMatch } from './metrics.js';

export interface EvalCase {
  readonly id: string;
  readonly input: unknown;
  readonly expected: unknown;
}

export interface EvalSpec {
  readonly agent: AnyAgent;
  readonly cases: readonly EvalCase[];
  /** Maps the agent's outputs to what the dataset's `expected` describes. */
  readonly project: (outputs: readonly unknown[]) => unknown;
  readonly metric: 'exactMatch';
  readonly min: number;
}

export interface EvalReport {
  readonly agentId: string;
  readonly version: string;
  readonly metric: 'exactMatch';
  readonly n: number;
  readonly score: number;
  readonly min: number;
  readonly pass: boolean;
  readonly failures: readonly { readonly id: string; readonly expected: unknown; readonly actual: unknown }[];
}

export function loadJsonl(path: string): EvalCase[] {
  const seen = new Set<string>();
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((text, i) => ({ text, line: i + 1 }))
    .filter((l) => l.text.trim() !== '')
    .map(({ text, line }) => {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new TypeError(`${path}:${line}: invalid JSON`);
      }
      const c = raw as Partial<EvalCase> | null;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || typeof c?.id !== 'string' || !('input' in c) || !('expected' in c)) {
        throw new TypeError(`${path}:${line}: needs id, input, expected`);
      }
      if (seen.has(c.id)) throw new TypeError(`${path}:${line}: duplicate id ${c.id}`);
      seen.add(c.id);
      return c as EvalCase;
    });
}

/** Rejects with the signal's reason as soon as it aborts, even if the work never settles. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Evals never touch the network: whatever fetch the caller passes, agents get this one. */
const offlineFetch: FetchLike = async () => {
  throw new KernelError('policy_denied', 'evals are offline');
};

/** Evals never open a browser either: whatever provider the caller passes, agents get this one. */
const offlineBrowser: BrowserProvider = {
  async render() {
    throw new KernelError('policy_denied', 'evals are offline');
  },
};

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/**
 * Runs each case through the agent with the same broker it gets in production; schema failures count as wrong.
 * Evals are forced offline: `env.providers.fetch` and `env.providers.browser` are ignored, and every HTTP request
 * or browser render fails with `policy_denied`.
 */
export async function runEval(spec: EvalSpec, env: { providers: Providers; policy: Policy }): Promise<EvalReport> {
  const c = spec.agent.contract;
  const providers: Providers = { ...env.providers, fetch: offlineFetch, browser: offlineBrowser };
  if (spec.cases.length === 0) throw new Error(`eval ${c.id}: no cases`);
  if (!(spec.min > 0 && spec.min <= 1)) throw new Error(`eval ${c.id}: min must be in (0, 1]`);
  const pairs: { id: string; expected: unknown; actual: unknown }[] = [];
  for (const k of spec.cases) {
    let actual: unknown;
    const input = c.consumes.schema.safeParse(k.input);
    if (!input.success) {
      actual = { error: 'input does not match the consumed schema' };
    } else if (!same(input.data, k.input)) {
      actual = { error: 'input would be coerced by the consumed schema' };
    } else {
      try {
        const signal = AbortSignal.timeout(c.timeoutMs);
        const ctx = issueContext({ contract: c, policy: env.policy, inputClass: 'P0', providers, clock: fixedClock('2026-01-01T00:00:00Z'), signal });
        const outs = await raceAbort(spec.agent.run(k.input, ctx), signal);
        const parsed = outs.map((o) => ({ o, r: c.produces.schema.safeParse(o) }));
        if (parsed.some((p) => !p.r.success)) actual = { error: 'output does not match the produced schema' };
        else if (parsed.some((p) => !same((p.r as { data: unknown }).data, p.o))) actual = { error: 'output would be coerced by the produced schema' };
        else actual = spec.project(outs);
      } catch (e) {
        actual = { error: classify(e) === 'timeout' ? 'timeout' : (e as Error).message };
      }
    }
    pairs.push({ id: k.id, expected: k.expected, actual });
  }
  const score = exactMatch(pairs);
  return {
    agentId: c.id,
    version: c.version,
    metric: spec.metric,
    n: pairs.length,
    score,
    min: spec.min,
    pass: score >= spec.min,
    failures: pairs.filter((p) => !same(p.expected, p.actual)),
  };
}

export function failedGates(reports: readonly EvalReport[]): string[] {
  return reports.filter((r) => !r.pass).map((r) => `${r.agentId}@${r.version}: ${r.metric} ${r.score.toFixed(3)} < ${r.min}`);
}
