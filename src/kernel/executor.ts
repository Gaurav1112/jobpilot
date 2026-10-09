/**
 * Known bounds of the budget accounting (inherent, not bugs):
 * - A call that returns in time and costs more than usdPerCall is charged in full and stops that agent for the rest
 *   of the run, so a run can exceed `policy.maxUsdPerRun` by at most (actual - usdPerCall) once per LLM agent.
 * - A call still in flight when the step times out is recorded at its reservation (the max of usdPerCall and the
 *   largest call seen). What the provider actually bills for it is not visible to the kernel and is bounded only
 *   per call, by the provider's pricing for maxTokens.
 * - Spend of a call in flight when the process itself dies is not recorded; the step re-runs on resume.
 *   Spend of a finished attempt is recorded before the retry sleep, so a crash between attempts loses none.
 */
import type { AnyAgent } from './agent.js';
import { type HostPacer, issueContext } from './broker.js';
import type { Clock } from './clock.js';
import { contractHash } from './contract.js';
import { maxClass } from './data-class.js';
import { type Cost, type Envelope, type GuardrailVerdict, makeEnvelopeId, nextObligations, ZERO_COST } from './envelope.js';
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
  /** The public pack, for contracts with `capabilities.pack: true` (and for guardrails). Must already be frozen (`freezePack`); the Supervisor does this. */
  readonly pack?: unknown;
  /** Hash of `pack`; part of the step key of pack agents only. Default 'none'. */
  readonly packHash?: string;
  /** The full pack (with P1 contact details), for contracts with `capabilities.pack: 'full'`. Must already be frozen (`freezePack`). */
  readonly fullPack?: unknown;
  /** Hash of `fullPack`; part of the step key of 'full' pack agents only. Default 'none'. */
  readonly fullPackHash?: string;
  /** Per-host request pacing shared by every step of one supervisor. */
  readonly hostPacer?: HostPacer;
  /** Per-host browser render pacing (policy.minBrowserIntervalMs) shared by every step of one supervisor. */
  readonly browserPacer?: HostPacer;
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

const addCost = (a: Cost, b: Cost): Cost => ({
  usd: a.usd + b.usd,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

/** Decimal dollar amounts carry float noise; a cap is only exceeded beyond it (same rule as the broker). */
const exceedsCap = (value: number, cap: number): boolean => value > cap + 1e-9;

const messageOf = (err: unknown): string => {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return 'unprintable error';
  }
};

/**
 * Spec §6.1: the same thirteen steps for every agent. Never throws: anything
 * unexpected becomes a failed step, so the supervisor always gets an outcome.
 */
export async function executeStep(deps: ExecutorDeps, runId: string, agent: AnyAgent, input: Envelope): Promise<StepOutcome> {
  const c = agent.contract; // 1 contract lookup (registry.get already threw if unknown)
  const full = c.capabilities.pack === 'full';
  const agentPack = full ? deps.fullPack : deps.pack;
  const stepKey = computeStepKey(c, input, deps.policyHash, (full ? deps.fullPackHash : deps.packHash) ?? 'none'); // 5
  /** Every cent paid in this step, summed over all attempts. */
  let stepSpent: Cost = ZERO_COST;
  /** The part of stepSpent not yet in the cost ledger: earlier attempts are recorded before their retry sleep. */
  let unrecorded: Cost = ZERO_COST;
  /** The largest single model call paid in this step, over all attempts. */
  let stepMaxCall = 0;
  const eventOf = (kind: string, data: Record<string, unknown>) => ({ at: deps.clock.now(), kind, data: { agent: c.id, stepKey, ...data }, policyHash: deps.policyHash });
  /** A standalone event, for outcomes that write no step row. */
  const event = (kind: string, data: Record<string, unknown>): void => {
    const e = eventOf(kind, data);
    deps.store.appendEvent(runId, e.at, e.kind, e.data, e.policyHash);
  };
  /** Step row, envelopes, cost and the hash-chained event in one transaction. */
  const finish = (
    status: 'done' | 'failed' | 'quarantined',
    envelopes: readonly Envelope[],
    ev: ReturnType<typeof eventOf>,
    more: { errorCode?: ErrorCode; detail?: string } = {},
  ): void => deps.store.finishStep({ runId, stepKey, agentId: c.id, status, envelopes, cost: unrecorded, maxCallUsd: stepMaxCall, ...more, event: ev });
  const fail = (error: ErrorCode, detail: string): StepOutcome => {
    finish('failed', [], eventOf('step_failed', { error, detail }), { errorCode: error, detail });
    return { kind: 'failed', stepKey, error, detail };
  };

  try {
    const gctx = {
      contract: c,
      policy: deps.policy,
      policyHash: deps.policyHash,
      contractHashOf: deps.contractHashOf,
      input,
      ...(deps.pack !== undefined && deps.pack !== null ? { pack: deps.pack } : {}),
    };
    const hash = contractHash(c);
    const running = { stepKey, agentId: c.id, version: c.version, contractHash: hash, inputEnvelopeId: input.envelopeId };

    // 2-4 lineage, preconditions and input guardrails. A trip is a property of
    // this envelope, not of the work, so it writes no step row and is never replayed.
    const gin = deps.guardrails.run('in', { ...gctx, side: 'in' });
    if (gin.tripped) {
      event('step_quarantined', { side: 'in', verdict: gin.verdicts.at(-1) });
      return { kind: 'quarantined', stepKey, verdicts: gin.verdicts };
    }

    // 6 replay: a finished step is never executed again
    const prior = deps.store.getStep(stepKey);
    if (prior?.status === 'done') {
      event('step_replayed', { status: 'done' });
      return { kind: 'done', stepKey, outputs: deps.store.envelopesOfStep(stepKey), replayed: true };
    }
    if (prior?.status === 'quarantined') {
      event('step_replayed', { status: 'quarantined' });
      return { kind: 'quarantined', stepKey, verdicts: JSON.parse(prior.detail ?? '[]') as GuardrailVerdict[] };
    }

    // 7 run budget (per agent and per run), counting what this step has already paid.
    // Bounds (see the top of this file): one over-priced call per LLM agent per run can pass the cap by
    // (actual - usdPerCall); a call in flight when the process dies is not recorded and the step re-runs on resume.
    const overBudget = (): boolean =>
      (c.budget.usdPerRun > 0 || c.kind === 'llm') &&
      (deps.store.runCost(runId, c.id) + unrecorded.usd >= c.budget.usdPerRun ||
        deps.store.runCost(runId) + unrecorded.usd >= deps.policy.maxUsdPerRun);
    /** The largest call this agent has been charged in the run, this step included. */
    const maxCallSoFar = (): number => Math.max(deps.store.maxCallCost(runId, c.id), stepMaxCall);
    /** An earlier over-priced call means the agent's per-call price cannot be trusted for the rest of the run. */
    const overCall = (): boolean => exceedsCap(maxCallSoFar(), c.budget.usdPerCall);
    const overCallDetail = `G-BUDGET: ${c.id} made a call above usdPerCall earlier in this run`;
    if (overCall()) {
      event('step_skipped', { reason: 'budget', detail: overCallDetail });
      return { kind: 'skipped', stepKey, reason: 'budget' };
    }
    if (overBudget()) {
      event('step_skipped', { reason: 'budget' });
      return { kind: 'skipped', stepKey, reason: 'budget' };
    }

    // 8-9 capability-scoped context, timeout, bounded retries
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0 && overCall()) return fail('budget_exceeded', overCallDetail);
      if (attempt > 0 && overBudget()) return fail('budget_exceeded', 'G-BUDGET: retry would exceed the run budget');
      deps.store.markRunning(running);
      const signal = AbortSignal.timeout(c.timeoutMs);
      const priorSpend = {
        agentUsd: deps.store.runCost(runId, c.id) + unrecorded.usd,
        runUsd: deps.store.runCost(runId) + unrecorded.usd,
        maxCallUsd: maxCallSoFar(),
      };
      const ctx = issueContext({
        contract: c,
        policy: deps.policy,
        inputClass: input.handoff.dataClass,
        providers: deps.providers,
        clock: deps.clock,
        signal,
        priorSpend,
        ...(agentPack !== undefined ? { pack: agentPack } : {}),
        ...(deps.hostPacer ? { hostPacer: deps.hostPacer } : {}),
        ...(deps.browserPacer ? { browserPacer: deps.browserPacer } : {}),
      });
      let result: { ok: true; items: readonly unknown[] } | { ok: false; err: unknown };
      try {
        deps.onInvoke?.(c.id, stepKey);
        const items: unknown = await untilAborted(agent.run(input.payload, ctx), signal);
        if (!Array.isArray(items)) throw new KernelError('invalid_output', 'agent.run must return an array');
        result = { ok: true, items };
      } catch (err) {
        result = { ok: false, err };
      }
      // Read after the abort too: a model call in flight at the timeout has already been charged its reservation.
      const attemptSpent = ctx.spent();
      stepSpent = addCost(stepSpent, attemptSpent);
      unrecorded = addCost(unrecorded, attemptSpent);
      stepMaxCall = Math.max(stepMaxCall, ctx.maxCall());

      // A denial is final even if the agent caught it and carried on: the attempt tried to break policy.
      const denials = ctx.denials();
      const firstDenial = denials[0];
      if (firstDenial !== undefined) {
        finish('failed', [], eventOf('step_failed', { error: 'policy_denied', detail: firstDenial, denials }), { errorCode: 'policy_denied', detail: firstDenial });
        return { kind: 'failed', stepKey, error: 'policy_denied', detail: firstDenial };
      }

      if (!result.ok) {
        const code = classify(result.err);
        if (c.retry.on.includes(code) && attempt < c.retry.max) {
          // Record what this attempt paid before sleeping: a crash during the backoff must not lose it.
          const ev = eventOf('step_retry', { attempt: attempt + 1, error: code, usd: attemptSpent.usd });
          deps.store.recordAttemptSpend({ runId, stepKey, agentId: c.id, cost: unrecorded, maxCallUsd: stepMaxCall, event: ev });
          unrecorded = ZERO_COST;
          await deps.sleep(backoffDelay(stepKey, attempt, c.retry.backoffMs));
          continue;
        }
        return fail(code, messageOf(result.err));
      }

      // 10-11 schema, data class, postconditions on every output
      // Taint only rises: outputs carry the input's class or the contract's `emits`, whichever is higher.
      // Only a redactor the policy allows may set its own (G-DATACLASS checks it).
      const dataClass = c.redactor ? maxClass(c.dataClasses.out) : maxClass([input.handoff.dataClass, c.emits ?? 'P0']);
      const outputs: Envelope[] = [];
      for (const [i, payload] of result.items.entries()) {
        const gout = deps.guardrails.run('out', { ...gctx, side: 'out', output: { payload, dataClass } });
        if (gout.tripped) {
          finish('quarantined', [], eventOf('step_quarantined', { side: 'out', index: i, verdict: gout.verdicts.at(-1) }), { detail: JSON.stringify(gout.verdicts) });
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
          cost: i === 0 ? stepSpent : ZERO_COST,
        });
      }

      // 12-13 one transaction: envelopes, step status, cost and the hash-chained event
      finish('done', outputs, eventOf('step_done', { outputs: outputs.length, usd: stepSpent.usd }));
      return { kind: 'done', stepKey, outputs, replayed: false };
    }
  } catch (err) {
    // Unexpected: a store error, a rejecting sleep, a refused finish. Record what we can, then report.
    const detail = messageOf(err);
    let recorded = false;
    try {
      if (deps.store.getStep(stepKey)?.status === 'running') {
        fail('unknown', detail);
        recorded = true;
      }
    } catch {
      // best effort: the store itself may be what failed
    }
    if (!recorded) {
      try {
        event('step_failed', { error: 'unknown', detail });
      } catch {
        // best effort
      }
    }
    return { kind: 'failed', stepKey, error: 'unknown', detail };
  }
}
