import { fixedClock, type Clock } from '../kernel/clock.js';
import { builtinGuardrails } from '../kernel/guardrails/builtin.js';
import { mergePolicy, policyHash, PRODUCT_POLICY_V1 } from '../kernel/policy.js';
import type { LlmProvider } from '../kernel/providers.js';
import { Registry } from '../kernel/registry.js';
import { Store } from '../kernel/store/store.js';
import { Supervisor, type SupervisorDeps } from '../kernel/supervisor.js';
import { compileWiring } from '../kernel/wiring.js';
import { demoAgents, demoLlm, demoPipeline, demoTracker } from './pipeline.js';

export interface DemoKernelOptions {
  readonly dbPath?: string;
  readonly store?: Store;
  readonly llm?: LlmProvider;
  readonly userPolicy?: unknown;
  readonly clock?: Clock;
  readonly onInvoke?: SupervisorDeps['onInvoke'];
  readonly afterStep?: SupervisorDeps['afterStep'];
}

/** Wires the demo pipeline end to end; the CLI and the kernel tests both use it. */
export function demoKernel(o: DemoKernelOptions = {}) {
  const store = o.store ?? Store.open(o.dbPath ?? ':memory:');
  const registry = new Registry();
  for (const a of demoAgents) registry.register(a);
  const guardrails = builtinGuardrails();
  const compiled = compileWiring(registry, demoPipeline, guardrails);
  const policy = mergePolicy(PRODUCT_POLICY_V1, o.userPolicy ?? {});
  const pHash = policyHash(policy);
  const supervisor = new Supervisor({
    store,
    registry,
    compiled,
    guardrails,
    policy,
    policyHash: pHash,
    providers: { fetch: async () => ({ status: 404, text: async () => '' }), llm: o.llm ?? demoLlm() },
    clock: o.clock ?? fixedClock('2026-10-08T07:00:00.000Z'),
    sleep: async () => {},
    trackers: [demoTracker],
    ...(o.onInvoke ? { onInvoke: o.onInvoke } : {}),
    ...(o.afterStep ? { afterStep: o.afterStep } : {}),
  });
  return { store, registry, compiled, supervisor, policy, policyHash: pHash };
}
