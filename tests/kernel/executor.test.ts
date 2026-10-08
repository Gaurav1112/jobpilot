import { describe, expect, it } from 'vitest';
import { defineAgent } from '../../src/kernel/agent.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { contractHash, defineContract } from '../../src/kernel/contract.js';
import { type Envelope, ZERO_COST } from '../../src/kernel/envelope.js';
import { executeStep, type ExecutorDeps } from '../../src/kernel/executor.js';
import { builtinGuardrails } from '../../src/kernel/guardrails/builtin.js';
import { backoffDelay } from '../../src/kernel/memo.js';
import { PRODUCT_POLICY_V1, policyHash } from '../../src/kernel/policy.js';
import { Store } from '../../src/kernel/store/store.js';
import { demoSourceContract } from '../../src/demo/agents.js';
import { DemoItem } from '../../src/demo/types.js';

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
