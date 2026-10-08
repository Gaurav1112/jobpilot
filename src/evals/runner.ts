import { readFileSync } from 'node:fs';
import type { AnyAgent } from '../kernel/agent.js';
import { issueContext } from '../kernel/broker.js';
import { canonicalJson } from '../kernel/canonical.js';
import { fixedClock } from '../kernel/clock.js';
import type { Policy } from '../kernel/policy.js';
import type { Providers } from '../kernel/providers.js';
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
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l, i) => {
      const c = JSON.parse(l) as Partial<EvalCase>;
      if (typeof c.id !== 'string' || !('input' in c) || !('expected' in c)) throw new TypeError(`${path}:${i + 1}: needs id, input, expected`);
      return c as EvalCase;
    });
}

/** Runs each case through the agent with the same broker it gets in production; schema failures count as wrong. */
export async function runEval(spec: EvalSpec, env: { providers: Providers; policy: Policy }): Promise<EvalReport> {
  const c = spec.agent.contract;
  const pairs: { id: string; expected: unknown; actual: unknown }[] = [];
  for (const k of spec.cases) {
    let actual: unknown;
    const input = c.consumes.schema.safeParse(k.input);
    if (!input.success) {
      actual = { error: 'input does not match the consumed schema' };
    } else {
      try {
        const ctx = issueContext({ contract: c, policy: env.policy, inputClass: 'P0', providers: env.providers, clock: fixedClock('2026-01-01T00:00:00Z'), signal: AbortSignal.timeout(c.timeoutMs) });
        const outs = await spec.agent.run(k.input, ctx);
        const bad = outs.find((o) => !c.produces.schema.safeParse(o).success);
        actual = bad === undefined ? spec.project(outs) : { error: 'output does not match the produced schema' };
      } catch (e) {
        actual = { error: (e as Error).message };
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
    failures: pairs.filter((p) => canonicalJson(p.expected) !== canonicalJson(p.actual)),
  };
}

export function failedGates(reports: readonly EvalReport[]): string[] {
  return reports.filter((r) => !r.pass).map((r) => `${r.agentId}@${r.version}: ${r.metric} ${r.score.toFixed(3)} < ${r.min}`);
}
