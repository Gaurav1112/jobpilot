import { describe, expect, it } from 'vitest';
import { defineAgent } from '../../src/kernel/agent.js';
import { AwakeClock } from '../../src/kernel/awake.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { contractHash, defineContract } from '../../src/kernel/contract.js';
import { type Envelope, ZERO_COST } from '../../src/kernel/envelope.js';
import { executeStep, type ExecutorDeps } from '../../src/kernel/executor.js';
import type { AgentContext } from '../../src/kernel/broker.js';
import { manualTimers } from '../../src/kernel/fakes.js';
import { builtinGuardrails } from '../../src/kernel/guardrails/builtin.js';
import { PRODUCT_POLICY_V1, policyHash } from '../../src/kernel/policy.js';
import { Store } from '../../src/kernel/store/store.js';
import { demoSourceContract } from '../../src/demo/agents.js';

/**
 * Step timeouts count awake time only (2026-10-14: the renderer, frozen by a closed lid, failed `timeout` three times
 * when its wall-clock timer fired during DarkWakes). The clock and timers are injected: `suspend` is a Mac asleep.
 */
const pHash = policyHash(PRODUCT_POLICY_V1);
const TEN_MINUTES = 10 * 60_000;
const item = { id: 'demo-1', text: 'one' };

const seedEnv = (): Envelope => ({
  envelopeId: 'seed', stepKey: 'seed-step', index: 0, type: 'DemoRequest@1',
  producer: { agentId: 'supervisor', version: '1.0.0', contractHash: 'seed-hash' },
  parents: [], payload: { count: 1, prefix: 'demo' },
  handoff: { guarantees: ['request.count-positive'], dataClass: 'P0', obligations: [], pins: { policyHash: pHash } },
  guardrails: [], cost: ZERO_COST,
});

/** An agent that waits until the test releases it; it records its context. */
function heldAgent(timeoutMs: number) {
  const h: { release?: (items: (typeof item)[]) => void; ctx?: AgentContext } = {};
  const agent = defineAgent(
    defineContract({ ...demoSourceContract, id: 'held-source', description: 'Answers when released', timeoutMs, obligations: { adds: [], discharges: [] } }),
    (_input, ctx) => {
      h.ctx = ctx;
      return new Promise<(typeof item)[]>((r) => (h.release = r));
    },
  );
  return { agent, h };
}

const deps = (store: Store, awake: AwakeClock, hash: string): ExecutorDeps => ({
  store, policy: PRODUCT_POLICY_V1, policyHash: pHash, providers: { fetch: async () => ({ status: 404, text: async () => '' }) },
  clock: fixedClock('2026-10-08T00:00:00Z'), guardrails: builtinGuardrails(),
  contractHashOf: (id) => (id === 'supervisor' ? 'seed-hash' : hash),
  sleep: async () => {}, awake,
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

describe('executeStep: the step timeout counts awake time only', () => {
  it('a 10-minute suspension mid-step fires no timeout; the step completes on resume', async () => {
    const t = manualTimers();
    const { agent, h } = heldAgent(120_000);
    const store = Store.open(':memory:');
    const p = executeStep(deps(store, new AwakeClock(t), contractHash(agent.contract)), 'r', agent, seedEnv());
    await flush();
    expect(h.release).toBeDefined();
    t.advance(60_000);
    t.suspend(TEN_MINUTES);
    t.advance(1_000); // a DarkWake: the overdue timers run now
    await flush();
    expect(h.ctx?.signal.aborted).toBe(false);
    expect(h.ctx?.sleptMs?.()).toBeGreaterThanOrEqual(TEN_MINUTES);
    h.release?.([item]);
    const out = await p;
    expect(out.kind).toBe('done');
    expect(t.pending()).toBe(0); // the timer was cleared at the end of the step
  });

  it('a genuinely slow step (awake time over the limit) still times out, with the same error', async () => {
    const t = manualTimers();
    const { agent, h } = heldAgent(120_000);
    const store = Store.open(':memory:');
    const p = executeStep(deps(store, new AwakeClock(t), contractHash(agent.contract)), 'r', agent, seedEnv());
    await flush();
    t.advance(60_000);
    t.suspend(TEN_MINUTES);
    t.advance(60_000);
    const out = await p;
    expect(out).toMatchObject({ kind: 'failed', error: 'timeout' });
    expect((h.ctx?.signal.reason as DOMException).name).toBe('TimeoutError');
    expect(store.getStep(out.stepKey)?.error_code).toBe('timeout');
    expect(t.pending()).toBe(0);
  });

  it('the timer is cleared when a step fails for another reason', async () => {
    const t = manualTimers();
    const { agent } = heldAgent(120_000);
    const failing = defineAgent(agent.contract, async () => {
      throw new Error('boom');
    });
    const store = Store.open(':memory:');
    const out = await executeStep(deps(store, new AwakeClock(t), contractHash(agent.contract)), 'r', failing, seedEnv());
    expect(out.kind).toBe('failed');
    expect(t.pending()).toBe(0);
  });
});
