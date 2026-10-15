import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { issueContext, type HostPacer } from '../../src/kernel/broker.js';
import type { Contract } from '../../src/kernel/contract.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import type { FetchLike } from '../../src/kernel/providers.js';
import type { GigRequest, RawGig } from '../../src/app/freelance/types.js';

const FIX = join(import.meta.dirname, '../fixtures/sx');

/** A recorded fixture under tests/fixtures/sx, as text. */
export const fxText = (name: string): string => readFileSync(join(FIX, name), 'utf8');
export const fx = (name: string): string => fxText(name);

/**
 * A fake api.github.com: serves exact URLs with exact bodies (status 200), anything else a 404, and logs every call.
 * `status` answers every URL with that status instead (a rate limit, say).
 */
export function githubHost(contract: Contract<GigRequest, RawGig>, routes: Record<string, string>, o: { status?: number; body?: string } = {}) {
  const calls: string[] = [];
  const waits: number[] = [];
  const fetch: FetchLike = async (url: string) => {
    calls.push(url);
    if (o.status !== undefined) return { status: o.status, text: async () => o.body ?? '{"message":"API rate limit exceeded"}' };
    const body = routes[url];
    return body === undefined ? { status: 404, text: async () => '{"message":"Not Found"}' } : { status: 200, text: async () => body };
  };
  const hostPacer: HostPacer = { wait: async (_h, ms) => void waits.push(ms ?? 0) };
  const ctx = issueContext({ contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock: fixedClock('2026-10-15T09:00:00Z'), signal: new AbortController().signal, hostPacer });
  return { ctx, calls, waits, get skipped(): readonly string[] { return ctx.skips(); } };
}
