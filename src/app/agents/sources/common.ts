import type { AgentContext } from '../../../kernel/broker.js';
import { defineContract, type Contract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import { DiscoveryRequest, knownAts, RawPosting } from '../../types.js';

/**
 * Shared shape of every source adapter. Each adapter is an `io` agent that turns one
 * DiscoveryRequest@1 into RawPosting@1 values, reaching exactly one host through ctx.http.
 */

export const SOURCE_TIMEOUT_MS = 30_000;
export const SOURCE_RETRY = {
  max: 2,
  on: ['rate_limit', 'overloaded', 'network', 'timeout'] as const,
  backoffMs: [2000, 8000],
};

export function sourceContract(id: string, host: string, description: string): Contract<DiscoveryRequest, RawPosting> {
  return defineContract({
    id,
    version: '1.0.0',
    description,
    skills: ['job-sourcing'],
    team: 'sourcing',
    kind: 'io',
    consumes: DiscoveryRequest,
    produces: RawPosting,
    requires: [knownAts],
    capabilities: { http: true },
    egress: [host],
    dataClasses: { in: ['P0'], out: ['P0'] },
    budget: { usdPerCall: 0, usdPerRun: 0 },
    timeoutMs: SOURCE_TIMEOUT_MS,
    retry: { max: SOURCE_RETRY.max, on: [...SOURCE_RETRY.on], backoffMs: [...SOURCE_RETRY.backoffMs] },
  });
}

/** What one response yields: the postings, plus a note per job that was skipped as malformed. */
export interface Parsed {
  readonly postings: RawPosting[];
  readonly skipped: string[];
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A non-empty string, or a finite number rendered as a string; anything else is not an id. */
export function idOf(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** A shallow copy of `job` without the named keys. */
export function omit(job: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(job)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/**
 * GETs JSON from a board. A 404 means a wrong or retired slug and is not retryable; any other
 * status of 400 or more is also `invalid_output` (429 and 5xx never get here: the broker maps them
 * to retryable codes).
 */
export async function getBoard(ctx: AgentContext, url: string, slug: string): Promise<unknown> {
  if (!ctx.http) throw new KernelError('policy_denied', 'no http capability issued');
  const { status, json } = await ctx.http.getJson(url);
  if (status === 404) throw new KernelError('invalid_output', `board not found: ${slug}`);
  if (status >= 400) throw new KernelError('invalid_output', `${new URL(url).hostname} returned ${status} for ${slug}`);
  return json;
}

const byId = (a: RawPosting, b: RawPosting): number => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);

/** Sorted by sourceId; the first posting seen for an id wins. */
export function finish(postings: readonly RawPosting[]): RawPosting[] {
  const seen = new Map<string, RawPosting>();
  for (const p of postings) if (!seen.has(p.sourceId)) seen.set(p.sourceId, p);
  return [...seen.values()].sort(byId);
}
