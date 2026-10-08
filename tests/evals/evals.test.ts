import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineAgent } from '../../src/kernel/agent.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import { exactMatch, precisionRecall, spearman } from '../../src/evals/metrics.js';
import { failedGates, runEval } from '../../src/evals/runner.js';
import { demoSource } from '../../src/demo/agents.js';
import { demoEvalSpecs } from '../../src/demo/evals.js';

const env = { providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, policy: PRODUCT_POLICY_V1 };

describe('metrics', () => {
  it('exactMatch compares canonical JSON, so key order does not matter', () => {
    expect(exactMatch([{ expected: { a: 1, b: 2 }, actual: { b: 2, a: 1 } }, { expected: 1, actual: 2 }])).toBe(0.5);
  });

  it('precisionRecall counts a rule firing as positive', () => {
    expect(precisionRecall([
      { expected: true, actual: true }, { expected: true, actual: false }, { expected: false, actual: true }, { expected: false, actual: false },
    ])).toEqual({ precision: 0.5, recall: 0.5 });
  });

  it('spearman is 1 for the same order, -1 for reversed, and handles ties', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 1, 2, 3], [1, 1, 2, 3])).toBeCloseTo(1);
  });
});

describe('runEval', () => {
  it('passes the demo-source golden set at its gate of 1.0', async () => {
    const [spec] = demoEvalSpecs(join(import.meta.dirname, '../../evals/datasets'));
    const r = await runEval(spec!, env);
    expect(r).toMatchObject({ agentId: 'demo-source', n: 3, score: 1, pass: true, failures: [] });
  });

  it('reports which cases a regression broke, and fails the gate', async () => {
    const [spec] = demoEvalSpecs(join(import.meta.dirname, '../../evals/datasets'));
    const broken = defineAgent(demoSource.contract, async (req) => [{ id: `${req.prefix}-1`, text: 'unpadded' }]);
    const r = await runEval({ ...spec!, agent: broken }, env);
    expect(r.pass).toBe(false);
    expect(r.failures.map((f) => f.id)).toEqual(['one', 'three', 'padding']);
    expect(failedGates([r])).toEqual(['demo-source@1.0.0: exactMatch 0.000 < 1']);
  });

  it('counts an output that breaks the produced schema as wrong', async () => {
    const [spec] = demoEvalSpecs(join(import.meta.dirname, '../../evals/datasets'));
    const sloppy = defineAgent(demoSource.contract, async () => [{ id: 'x', text: 't', extra: 1 } as never]);
    const r = await runEval({ ...spec!, agent: sloppy }, env);
    expect(r.failures[0]?.actual).toEqual({ error: 'output does not match the produced schema' });
  });
});
