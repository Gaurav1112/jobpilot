import type { AnyAgent } from './agent.js';
import { issueContext } from './broker.js';
import type { Clock } from './clock.js';
import { contractHash } from './contract.js';
import { maxClass } from './data-class.js';
import { type Envelope, type GuardrailVerdict, makeEnvelopeId, nextObligations, ZERO_COST } from './envelope.js';
import { classify, type ErrorCode, KernelError } from './errors.js';
import type { GuardrailRegistry } from './guardrails/index.js';
import { backoffDelay, computeStepKey } from './memo.js';
import type { Policy } from './policy.js';
import type { Providers } from './providers.js';
import type { Store } from './store/store.js';

export interface ExecutorDeps {
  readonly store: Store;
  readonly policy: Policy;
  readonly policyHash: string;
  readonly providers: Providers;
  readonly clock: Clock;
  readonly guardrails: GuardrailRegistry;
  readonly contractHashOf: (agentId: string, version: string) => string | undefined;
  readonly sleep: (ms: number) => Promise<void>;
  /** Called right before agent.run; tests count real invocations with it. */
  readonly onInvoke?: (agentId: string, stepKey: string) => void;
}

export type StepOutcome =
  | { readonly kind: 'done'; readonly stepKey: string; readonly outputs: readonly Envelope[]; readonly replayed: boolean }
  | { readonly kind: 'quarantined'; readonly stepKey: string; readonly verdicts: readonly GuardrailVerdict[] }
  | { readonly kind: 'failed'; readonly stepKey: string; readonly error: ErrorCode; readonly detail: string }
  | { readonly kind: 'skipped'; readonly stepKey: string; readonly reason: 'budget' };

/** Rejects when the signal aborts, even if the agent ignores the signal. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Spec §6.1: the same thirteen steps for every agent. */
export async function executeStep(deps: ExecutorDeps, runId: string, agent: AnyAgent, input: Envelope): Promise<StepOutcome> {
  const c = agent.contract; // 1 contract lookup (registry.get already threw if unknown)
  const stepKey = computeStepKey(c, input, deps.policyHash); // 5
  const event = (kind: string, data: Record<string, unknown>) => deps.store.appendEvent(runId, deps.clock.now(), kind, { agent: c.id, stepKey, ...data }, deps.policyHash);

  // 6 replay: a finished step is never executed again
  const prior = deps.store.getStep(stepKey);
  if (prior?.status === 'done') return { kind: 'done', stepKey, outputs: deps.store.envelopesOfStep(stepKey), replayed: true };
  if (prior?.status === 'quarantined') {
    return { kind: 'quarantined', stepKey, verdicts: JSON.parse(prior.detail ?? '[]') as GuardrailVerdict[] };
  }

  const gctx = { contract: c, policy: deps.policy, policyHash: deps.policyHash, contractHashOf: deps.contractHashOf, input };
  const hash = contractHash(c);
  const running = { stepKey, agentId: c.id, version: c.version, contractHash: hash, inputEnvelopeId: input.envelopeId };

  // 2-4 lineage, preconditions and input guardrails
  const gin = deps.guardrails.run('in', { ...gctx, side: 'in' });
  if (gin.tripped) {
    deps.store.markRunning(running);
    deps.store.finishStep({ runId, stepKey, agentId: c.id, status: 'quarantined', envelopes: [], cost: ZERO_COST, detail: JSON.stringify(gin.verdicts) });
    event('step_quarantined', { side: 'in', verdict: gin.verdicts.at(-1) });
    return { kind: 'quarantined', stepKey, verdicts: gin.verdicts };
  }

  // 7 run budget (per agent and per run)
  if (c.budget.usdPerRun > 0 || c.kind === 'llm') {
    if (deps.store.runCost(runId, c.id) >= c.budget.usdPerRun || deps.store.runCost(runId) >= deps.policy.maxUsdPerRun) {
      event('step_skipped', { reason: 'budget' });
      return { kind: 'skipped', stepKey, reason: 'budget' };
    }
  }

  // 8-9 capability-scoped context, timeout, bounded retries
  for (let attempt = 0; ; attempt++) {
    deps.store.markRunning(running);
    const signal = AbortSignal.timeout(c.timeoutMs);
    const ctx = issueContext({ contract: c, policy: deps.policy, inputClass: input.handoff.dataClass, providers: deps.providers, clock: deps.clock, signal });
    let items: readonly unknown[];
    try {
      deps.onInvoke?.(c.id, stepKey);
      items = await untilAborted(agent.run(input.payload, ctx), signal);
      if (!Array.isArray(items)) throw new KernelError('invalid_output', 'agent.run must return an array');
    } catch (err) {
      const code = classify(err);
      const detail = err instanceof Error ? err.message : String(err);
      if (c.retry.on.includes(code) && attempt < c.retry.max) {
        event('step_retry', { attempt: attempt + 1, error: code });
        await deps.sleep(backoffDelay(stepKey, attempt, c.retry.backoffMs));
        continue;
      }
      deps.store.finishStep({ runId, stepKey, agentId: c.id, status: 'failed', envelopes: [], cost: ctx.spent(), errorCode: code, detail });
      event('step_failed', { error: code, detail });
      return { kind: 'failed', stepKey, error: code, detail };
    }

    // 10-11 schema, data class, postconditions on every output
    // Taint: outputs inherit the input's class. Only a declared redactor sets its own (G-DATACLASS checks it).
    const dataClass = c.redactor ? maxClass(c.dataClasses.out) : input.handoff.dataClass;
    const outputs: Envelope[] = [];
    for (const [i, payload] of items.entries()) {
      const gout = deps.guardrails.run('out', { ...gctx, side: 'out', output: { payload, dataClass } });
      if (gout.tripped) {
        deps.store.finishStep({ runId, stepKey, agentId: c.id, status: 'quarantined', envelopes: [], cost: ctx.spent(), detail: JSON.stringify(gout.verdicts) });
        event('step_quarantined', { side: 'out', index: i, verdict: gout.verdicts.at(-1) });
        return { kind: 'quarantined', stepKey, verdicts: gout.verdicts };
      }
      outputs.push({
        envelopeId: makeEnvelopeId(stepKey, i),
        stepKey,
        index: i,
        type: c.produces.id,
        producer: { agentId: c.id, version: c.version, contractHash: hash },
        parents: [input.envelopeId],
        payload,
        handoff: {
          guarantees: c.guarantees.map((g) => g.id).sort(),
          dataClass,
          obligations: nextObligations(input.handoff.obligations, c),
          pins: { policyHash: deps.policyHash },
        },
        guardrails: [...gin.verdicts, ...gout.verdicts],
        cost: i === 0 ? ctx.spent() : ZERO_COST,
      });
    }

    // 12 one transaction: envelopes, step status, cost; then the hash-chained event
    deps.store.finishStep({ runId, stepKey, agentId: c.id, status: 'done', envelopes: outputs, cost: ctx.spent() });
    event('step_done', { outputs: outputs.length, usd: ctx.spent().usd });
    return { kind: 'done', stepKey, outputs, replayed: false };
  }
}
