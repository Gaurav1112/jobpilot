import type { AgentContext } from '../../../kernel/agent.js';
import { defineContract, type Contract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import { SOURCE_RETRY, SOURCE_TIMEOUT_MS } from '../../agents/sources/common.js';
import { GigRequest, RawGig } from '../types.js';

export { getBoard, idOf, isRecord } from '../../agents/sources/common.js';

/**
 * Shared shape of every gig source adapter. Each `io` adapter turns one GigRequest@1 into RawGig@1 values, reaching
 * exactly one host through ctx.http. It mirrors the daily `sourceContract`: same retry, same timeout default, P0 data,
 * no model call, no effect.
 */
export function gigSourceContract(id: string, host: string, description: string, timeoutMs = SOURCE_TIMEOUT_MS): Contract<GigRequest, RawGig> {
  return defineContract({
    id,
    version: '1.0.0',
    description,
    skills: ['gig-sourcing'],
    team: 'sourcing',
    kind: 'io',
    consumes: GigRequest,
    produces: RawGig,
    capabilities: { http: true },
    egress: [host],
    dataClasses: { in: ['P0'], out: ['P0'] },
    budget: { usdPerCall: 0, usdPerRun: 0 },
    timeoutMs,
    retry: { max: SOURCE_RETRY.max, on: [...SOURCE_RETRY.on], backoffMs: [...SOURCE_RETRY.backoffMs] },
  });
}

const byId = (a: RawGig, b: RawGig): number => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);

/** Sorted by sourceId; the first gig seen for an id wins. */
export function finishGigs(gigs: readonly RawGig[]): RawGig[] {
  const seen = new Map<string, RawGig>();
  for (const g of gigs) if (!seen.has(g.sourceId)) seen.set(g.sourceId, g);
  return [...seen.values()].sort(byId);
}

/**
 * Merges the outputs of several requests (say one Freelancer.com query each, in query order) into one list: one gig per
 * sourceId, the earliest batch wins, sorted by sourceId. One request carries one query, so this cross-query dedupe is
 * the caller's step, not the agent's.
 */
export function mergeGigs(batches: readonly (readonly RawGig[])[]): RawGig[] {
  return finishGigs(batches.flat());
}

/**
 * A response with items in it where every item failed to parse is schema drift, not an empty result: fail the step
 * (`invalid_output`, not retryable). A partial skip goes to `ctx.skipped`, never dropped silently.
 */
export function checkGigs(ctx: AgentContext, source: string, noun: string, total: number, skipped: readonly string[]): void {
  if (total > 0 && skipped.length === total) throw new KernelError('invalid_output', `${source}: all ${total} ${noun} failed to parse`);
  if (skipped.length > 0) ctx.skipped(skipped);
}
