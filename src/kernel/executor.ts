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
import { type AwakeClock, systemAwake } from './awake.js';
import { type EgressSets, type HostPacer, issueContext } from './broker.js';
import type { Clock } from './clock.js';
import { contractHash } from './contract.js';
import { maxClass } from './data-class.js';
import { type Cost, type Envelope, type GuardrailVerdict, makeEnvelopeId, nextObligations, ZERO_COST } from './envelope.js';
import { classify, type ErrorCode, KernelError } from './errors.js';
import { commitPending, createFiles, discardPending, fsFailure, hasPending, openPending } from './files.js';
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
  /** Fingerprint of the agents' implementation (review I4); in every step key. Default 'none'. */
  readonly codeHash?: string;
  /** Per-host request pacing shared by every step of one supervisor. */
  readonly hostPacer?: HostPacer;
  /** Per-host browser render pacing (policy.minBrowserIntervalMs) shared by every step of one supervisor. */
  readonly browserPacer?: HostPacer;
  /** The hosts behind symbolic egress entries (`pack:careers-hosts`), resolved by the broker at call time. */
  readonly egressSets?: EgressSets;
  /**
   * Test hook: runs after a writing step is recorded done, before its staged files are committed. Throwing here
   * simulates a crash at that point: the step stays done and its files stay staged until a replay or a recovery.
   */
  readonly beforeCommit?: (agentId: string, stepKey: string) => void;
  /**
   * The awake-time clock of step and request timeouts (a sleeping Mac must not time a frozen step out); default the
   * process's `systemAwake`. Tests inject one on `manualTimers`.
   */
  readonly awake?: AwakeClock;
}

/** Where a writing contract's files are staged and committed; undefined for an agent that writes nothing. */
interface Staging {
  readonly root: string;
  readonly maxBytes: number;
}

export type StepOutcome =
  | { readonly kind: 'done'; readonly stepKey: string; readonly outputs: readonly Envelope[]; readonly replayed: boolean }
  | { readonly kind: 'quarantined'; readonly stepKey: string; readonly verdicts: readonly GuardrailVerdict[] }
  | { readonly kind: 'failed'; readonly stepKey: string; readonly error: ErrorCode; readonly detail: string }
  | { readonly kind: 'skipped'; readonly stepKey: string; readonly reason: 'budget' };

/** Rejects when the signal aborts, even if the agent ignores the signal. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined); // the agent's own late failure is not an unhandled rejection
    return Promise.reject(signal.reason);
  }
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

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Review I1: the files a stored output references. A reference is any object, at any depth of a payload, with a string
 * `path` and a 64-hex `sha256`: the shape `ctx.files.write` returns, which a writing agent records in its output.
 */
export function fileRefsOf(payloads: readonly unknown[]): { readonly path: string; readonly sha256: string }[] {
  const out = new Map<string, string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    if (typeof o['path'] === 'string' && typeof o['sha256'] === 'string' && SHA256.test(o['sha256'])) out.set(`${o['path']}\u0000${o['sha256']}`, o['path']);
    for (const x of Object.values(o)) walk(x);
  };
  for (const p of payloads) walk(p);
  return [...out.entries()].map(([k, path]) => ({ path, sha256: k.slice(path.length + 1) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.sha256 < b.sha256 ? -1 : 1));
}

/** The referenced files that are not under the root with their recorded sha256 (absent, changed, or refused by G-FILES). */
async function brokenFileRefs(staging: Staging, outputs: readonly Envelope[]): Promise<string[]> {
  const { tool } = createFiles({ root: staging.root, rootName: 'out', maxBytes: staging.maxBytes, deny: (m) => new KernelError('policy_denied', m) }, 'read');
  const broken = new Set<string>();
  for (const ref of fileRefsOf(outputs.map((o) => o.payload))) {
    try {
      if ((await tool.read(ref.path)).sha256 !== ref.sha256) broken.add(ref.path);
    } catch {
      broken.add(ref.path);
    }
  }
  return [...broken].sort();
}

/**
 * Spec §6.1: the same thirteen steps for every agent. Never throws: anything
 * unexpected becomes a failed step, so the supervisor always gets an outcome.
 */
export async function executeStep(deps: ExecutorDeps, runId: string, agent: AnyAgent, input: Envelope): Promise<StepOutcome> {
  const c = agent.contract;
  // m9: a pack agent's step key must carry the pack hash, or a pack edit would replay a stale step.
  if (c.capabilities.pack === 'full' && deps.fullPackHash === undefined) {
    throw new TypeError(`executeStep: ${c.id} reads the full pack but no fullPackHash was supplied`);
  }
  if (c.capabilities.pack === true && deps.pack !== undefined && deps.packHash === undefined) {
    throw new TypeError(`executeStep: ${c.id} reads the pack but no packHash was supplied`);
  }
  const files = c.capabilities.files;
  const root = files?.access === 'read-write' ? deps.providers.fileRoots?.[files.root] : undefined;
  const staging: Staging | undefined = root === undefined ? undefined : { root, maxBytes: deps.policy.maxResponseBytes };
  const outcome = await runStep(deps, runId, agent, input, staging);
  if (staging === undefined) return outcome;
  const event = (kind: string, data: Record<string, unknown>): void =>
    deps.store.appendEvent(runId, deps.clock.now(), kind, { agent: c.id, stepKey: outcome.stepKey, envelopeId: input.envelopeId, ...data }, deps.policyHash);
  if (outcome.kind === 'done') {
    // A fresh step, or a replayed one whose commit a crash interrupted: the stage is committed only now, after the
    // out guardrails passed and the step was recorded done. Throwing from the hook (tests) leaves it staged.
    if (await hasPending(staging.root, outcome.stepKey)) {
      deps.beforeCommit?.(c.id, outcome.stepKey);
      try {
        const committed = await commitPending(staging.root, outcome.stepKey, staging.maxBytes);
        event('files_committed', { files: committed });
      } catch (e) {
        // Review I3: the files its outputs reference are not on disk, so nothing may be routed on (a QA step would
        // check the old files and its verdict would be memoised). The step row stays done: on the next run its replay
        // finds the referenced files absent or changed and runs it again (I1, `replay-healed`).
        const message = messageOf(fsFailure(e, staging.root, files?.root ?? 'files'));
        event('files_commit_failed', { message });
        await discardPending(staging.root, outcome.stepKey).catch(() => undefined);
        return { kind: 'failed', stepKey: outcome.stepKey, error: 'invalid_output', detail: `files_commit_failed: ${message}` };
      }
    }
  } else if (outcome.kind === 'failed' || outcome.kind === 'quarantined') {
    await discardPending(staging.root, outcome.stepKey).catch(() => undefined);
  }
  return outcome;
}

/** At most this many skip notes are kept per step, each cut to SKIP_NOTE_MAX characters; the count is always exact. */
export const SKIP_NOTES_KEPT = 20;
const SKIP_NOTE_MAX = 200;

/** The event fields for a step's skipped input items: none when nothing was skipped. */
function skipData(notes: readonly string[]): { skipped?: number; skippedNotes?: string[] } {
  if (notes.length === 0) return {};
  return { skipped: notes.length, skippedNotes: notes.slice(0, SKIP_NOTES_KEPT).map((n) => (n.length > SKIP_NOTE_MAX ? `${n.slice(0, SKIP_NOTE_MAX - 1)}…` : n)) };
}

/** The skip fields a done step stored in its row detail (none for a step without skips or an older row). */
function skipsOf(detail: string | null | undefined): { skipped?: number; skippedNotes?: string[] } {
  if (!detail) return {};
  try {
    const d = JSON.parse(detail) as { skipped?: unknown; skippedNotes?: unknown };
    if (typeof d.skipped !== 'number' || !Number.isSafeInteger(d.skipped) || d.skipped < 1) return {};
    const notes = Array.isArray(d.skippedNotes) ? d.skippedNotes.filter((n): n is string => typeof n === 'string') : [];
    return { skipped: d.skipped, skippedNotes: notes };
  } catch {
    return {};
  }
}

async function runStep(deps: ExecutorDeps, runId: string, agent: AnyAgent, input: Envelope, staging: Staging | undefined): Promise<StepOutcome> {
  const c = agent.contract; // 1 contract lookup (registry.get already threw if unknown)
  const full = c.capabilities.pack === 'full';
  const agentPack = full ? deps.fullPack : deps.pack;
  /** Final minor: a raw fs error under the files root is reported as invalid_output with a root-relative path. */
  const filesRoot = c.capabilities.files ? deps.providers.fileRoots?.[c.capabilities.files.root] : undefined;
  const mapFs = (e: unknown): unknown => (filesRoot === undefined || !c.capabilities.files ? e : fsFailure(e, filesRoot, c.capabilities.files.root));
  const stepKey = computeStepKey(c, input, deps.policyHash, (full ? deps.fullPackHash : deps.packHash) ?? 'none', deps.codeHash ?? 'none'); // 5
  /** Every cent paid in this step, summed over all attempts. */
  let stepSpent: Cost = ZERO_COST;
  /** The part of stepSpent not yet in the cost ledger: earlier attempts are recorded before their retry sleep. */
  let unrecorded: Cost = ZERO_COST;
  /** The largest single model call paid in this step, over all attempts. */
  let stepMaxCall = 0;
  const eventOf = (kind: string, data: Record<string, unknown>) => ({ at: deps.clock.now(), kind, data: { agent: c.id, stepKey, envelopeId: input.envelopeId, ...data }, policyHash: deps.policyHash });
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
      ...(full && deps.fullPack !== undefined && deps.fullPack !== null ? { fullPack: deps.fullPack } : {}),
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

    // 6 replay: a finished step is never executed again, unless (review I1) it writes files and a file its stored
    // output references is no longer in place with its recorded sha256 (an A -> B -> A pack history overwrote it, a
    // commit failed, a user deleted it). Then this step alone bypasses the memo and runs again (`replay-healed`). A
    // stage still pending (a crash between done and commit) is committed by the caller, so it is not checked here.
    const prior = deps.store.getStep(stepKey);
    if (prior?.status === 'done') {
      const outputs = deps.store.envelopesOfStep(stepKey);
      const broken = staging === undefined || (await hasPending(staging.root, stepKey)) ? [] : await brokenFileRefs(staging, outputs);
      if (broken.length === 0) {
        event('step_replayed', { status: 'done', ...skipsOf(prior.detail) });
        return { kind: 'done', stepKey, outputs, replayed: true };
      }
      const e = eventOf('replay-healed', { files: broken });
      deps.store.forgetDoneStep(runId, stepKey, e);
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
      // Each attempt stages into its own directory, sealed when the attempt ends; only the final one is committed.
      const pendingFiles = staging === undefined ? undefined : openPending(staging.root, stepKey, attempt);
      const priorSpend = {
        agentUsd: deps.store.runCost(runId, c.id) + unrecorded.usd,
        runUsd: deps.store.runCost(runId) + unrecorded.usd,
        maxCallUsd: maxCallSoFar(),
      };
      // Awake time, not wall time: a step frozen by a sleeping Mac is not timed out when it wakes (2026-10-14). Started
      // only now, after everything that can throw before the agent runs, and cleared if issuing the context throws.
      const awake = deps.awake ?? systemAwake;
      const timeout = awake.timeout(c.timeoutMs);
      const signal = timeout.signal;
      const slept0 = awake.sleptMs();
      let ctx: ReturnType<typeof issueContext>;
      try {
        ctx = issueContext({
          contract: c,
          policy: deps.policy,
          inputClass: input.handoff.dataClass,
          providers: deps.providers,
          clock: deps.clock,
          signal,
          awake,
          sleptMs: () => awake.sleptMs() - slept0,
          priorSpend,
          ...(agentPack !== undefined ? { pack: agentPack } : {}),
          ...(deps.hostPacer ? { hostPacer: deps.hostPacer } : {}),
          ...(deps.browserPacer ? { browserPacer: deps.browserPacer } : {}),
          ...(deps.egressSets ? { egressSets: deps.egressSets } : {}),
          ...(pendingFiles ? { pendingFiles } : {}),
        });
      } catch (e) {
        timeout.clear();
        throw e;
      }
      let result: { ok: true; items: readonly unknown[] } | { ok: false; err: unknown };
      try {
        deps.onInvoke?.(c.id, stepKey);
        const items: unknown = await untilAborted(agent.run(input.payload, ctx), signal);
        if (!Array.isArray(items)) throw new KernelError('invalid_output', 'agent.run must return an array');
        result = { ok: true, items };
      } catch (err) {
        result = { ok: false, err: mapFs(err) };
      } finally {
        // never left running: a finished attempt's timer must not keep the event loop alive
        timeout.clear();
      }
      pendingFiles?.seal();
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
      // Only a redactor the policy allows may set its own (G-DATACLASS checks it). A 'full' pack agent read contact
      // details, so its outputs are at least P1 whatever it returns or declares (M7; defineContract also requires it).
      const dataClass = c.redactor ? maxClass(c.dataClasses.out) : maxClass([input.handoff.dataClass, c.emits ?? 'P0', full ? 'P1' : 'P0']);
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

      // This attempt's stage is the one to commit, named before the step is recorded done (so a crash after the
      // done record still knows which stage to commit, and a crash before it leaves nothing that will be).
      await pendingFiles?.markFinal();
      // 12-13 one transaction: envelopes, step status, cost and the hash-chained event
      // A partial skip is never silent: its count and first notes go in the event, and in the step row for replays.
      const skips = skipData(ctx.skips());
      finish('done', outputs, eventOf('step_done', { outputs: outputs.length, usd: stepSpent.usd, ...skips }), skips.skipped === undefined ? {} : { detail: JSON.stringify(skips) });
      return { kind: 'done', stepKey, outputs, replayed: false };
    }
  } catch (err) {
    // Unexpected: a store error, a rejecting sleep, a refused finish, a staging fs error. Record what we can, then report.
    const mapped = mapFs(err);
    const code: ErrorCode = mapped !== err && mapped instanceof KernelError ? mapped.code : 'unknown';
    const detail = messageOf(mapped);
    let recorded = false;
    try {
      if (deps.store.getStep(stepKey)?.status === 'running') {
        fail(code, detail);
        recorded = true;
      }
    } catch {
      // best effort: the store itself may be what failed
    }
    if (!recorded) {
      try {
        event('step_failed', { error: code, detail });
      } catch {
        // best effort
      }
    }
    return { kind: 'failed', stepKey, error: code, detail };
  }
}
