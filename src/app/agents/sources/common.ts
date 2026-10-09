import type { AgentContext } from '../../../kernel/agent.js';
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

/** `timeoutMs` bounds the whole step, every page included; size it to the adapter's page cap. */
export function sourceContract(id: string, host: string, description: string, timeoutMs = SOURCE_TIMEOUT_MS): Contract<DiscoveryRequest, RawPosting> {
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
    timeoutMs,
    retry: { max: SOURCE_RETRY.max, on: [...SOURCE_RETRY.on], backoffMs: [...SOURCE_RETRY.backoffMs] },
  });
}

/** What one response yields: the postings, plus a note per job that was skipped as malformed. */
export interface Parsed {
  readonly postings: RawPosting[];
  readonly skipped: string[];
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A non-blank string (trimmed), or a finite number rendered as a string; anything else is not an id. */
export function idOf(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
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
 * A response with jobs in it where every job failed to parse is schema drift, not an empty board:
 * fail the step (`invalid_output`, not retryable) rather than report "no jobs today".
 * A partial skip stays silent for now: the agent can only return postings.
 */
export function checkParsed(source: string, total: number, parsed: Parsed): Parsed {
  if (total > 0 && parsed.skipped.length === total) {
    throw new KernelError('invalid_output', `${source}: all ${total} jobs failed to parse`);
  }
  return parsed;
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

/**
 * Records a page's ids in `seen` and reports whether the page brought nothing new: every id on it
 * was already seen on an earlier page. That catches an API that ignores `skip`, `page` or `cursor`,
 * whether it repeats the previous page or cycles (A, B, A). A page with no ids is never a repeat.
 */
export function onlySeenBefore(seen: Set<string>, ids: readonly string[]): boolean {
  const repeat = ids.length > 0 && ids.every((id) => seen.has(id));
  for (const id of ids) seen.add(id);
  return repeat;
}

/** No silent truncation: a paged source that runs out of pages before the API's natural end fails loudly. */
export const capReached = (what: string, unit: 'page' | 'request', postings: number): KernelError =>
  new KernelError('invalid_output', `${what}: ${unit} cap reached at ${postings} postings`);

export const repeatedPage = (what: string, page: number): KernelError =>
  new KernelError('invalid_output', `${what}: page ${page} repeats earlier postings`);

const byId = (a: RawPosting, b: RawPosting): number => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);

/** Sorted by sourceId; the first posting seen for an id wins. */
export function finish(postings: readonly RawPosting[]): RawPosting[] {
  const seen = new Map<string, RawPosting>();
  for (const p of postings) if (!seen.has(p.sourceId)) seen.set(p.sourceId, p);
  return [...seen.values()].sort(byId);
}
