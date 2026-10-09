import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { defineAgent, type AnyAgent } from '../../src/kernel/agent.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import { exactMatch, precisionRecall, spearman } from '../../src/evals/metrics.js';
import { defineContract } from '../../src/kernel/contract.js';
import { defineType } from '../../src/kernel/types.js';
import { KernelError } from '../../src/kernel/errors.js';
import { failedGates, loadJsonl, runEval } from '../../src/evals/runner.js';
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

  it('refuses vacuous gates', async () => {
    const [spec] = demoEvalSpecs(join(import.meta.dirname, '../../evals/datasets'));
    await expect(runEval({ ...spec!, cases: [] }, env)).rejects.toThrow(/no cases/);
    await expect(runEval({ ...spec!, min: 0 }, env)).rejects.toThrow(/min must be in/);
  });

  const Padded = defineType('Padded', 1, z.object({ id: z.string(), tag: z.string().default('x') }).strict());
  const mini = (timeoutMs: number) => defineContract({
    id: 'mini', version: '1.0.0', description: 'Emits one padded item', skills: ['x'], team: 'sourcing', kind: 'deterministic',
    consumes: Padded, produces: Padded, dataClasses: { in: ['P0'], out: ['P0'] }, budget: { usdPerCall: 0, usdPerRun: 0 }, timeoutMs,
  });
  const miniSpec = (a: unknown) => ({
    agent: a as AnyAgent, cases: [{ id: 'c', input: { id: 'a', tag: 'x' }, expected: 1 }], project: () => 1, metric: 'exactMatch' as const, min: 1,
  });

  it('applies production no-coercion to outputs', async () => {
    const agent = defineAgent(mini(1_000), async () => [{ id: 'a' } as never]);
    const r = await runEval(miniSpec(agent), env);
    expect(r.failures[0]?.actual).toEqual({ error: 'output would be coerced by the produced schema' });
  });

  it('applies production no-coercion to inputs', async () => {
    const agent = defineAgent(mini(1_000), async () => []);
    const spec = { ...miniSpec(agent), cases: [{ id: 'c', input: { id: 'a' }, expected: 1 }] };
    const r = await runEval(spec, env);
    expect(r.failures[0]?.actual).toEqual({ error: 'input would be coerced by the consumed schema' });
  });

  it('forces evals offline: an agent attempting HTTP gets policy_denied, whatever fetch is passed in', async () => {
    const calls: string[] = [];
    const liveEnv = { ...env, providers: { fetch: async (url: string) => (calls.push(url), { status: 200, text: async () => '{}' }) } };
    const fetcher = defineAgent(
      defineContract({
        id: 'mini-fetcher', version: '1.0.0', description: 'Fetches one page for the item', skills: ['x'], team: 'sourcing', kind: 'io',
        consumes: Padded, produces: Padded, capabilities: { http: true }, egress: ['boards-api.greenhouse.io'],
        dataClasses: { in: ['P0'], out: ['P0'] }, budget: { usdPerCall: 0, usdPerRun: 0 }, timeoutMs: 1_000,
      }),
      async (_item, ctx) => {
        try {
          await ctx.http!.getJson('https://boards-api.greenhouse.io/v1/boards/x/jobs');
          return [{ id: 'reached', tag: 'x' }];
        } catch (e) {
          return [{ id: e instanceof KernelError ? e.code : 'other', tag: (e as Error).message }];
        }
      },
    );
    const r = await runEval({ ...miniSpec(fetcher), project: (outs) => outs, cases: [{ id: 'c', input: { id: 'a', tag: 'x' }, expected: [{ id: 'policy_denied', tag: 'evals are offline' }] }] }, liveEnv);
    expect(r.failures).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('enforces the timeout even when the agent ignores its signal', async () => {
    const agent = defineAgent(mini(20), () => new Promise<never>(() => {}));
    const r = await runEval(miniSpec(agent), env);
    expect(r.failures[0]?.actual).toEqual({ error: 'timeout' });
    expect(r.pass).toBe(false);
  });
});

describe('loadJsonl', () => {
  const write = (body: string) => {
    const p = join(mkdtempSync(join(tmpdir(), 'jp-evals-')), 'd.jsonl');
    writeFileSync(p, body);
    return p;
  };
  const ok = '{"id":"a","input":1,"expected":2}';

  it('rejects a line that is not JSON', () => {
    expect(() => loadJsonl(write(`${ok}\nnot json\n`))).toThrow(/:2: invalid JSON/);
  });
  it('rejects a line that is not an object with id, input, expected', () => {
    expect(() => loadJsonl(write('5\n'))).toThrow(/needs id, input, expected/);
    expect(() => loadJsonl(write('{"id":"a","input":1}\n'))).toThrow(/needs id, input, expected/);
  });
  it('rejects a repeated id', () => {
    expect(() => loadJsonl(write(`${ok}\n${ok}\n`))).toThrow(/duplicate id/);
  });
});
