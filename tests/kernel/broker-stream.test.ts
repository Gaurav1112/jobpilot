import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { issueContext, STREAM_MAX_BYTES } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { defineContract } from '../../src/kernel/contract.js';
import type { FetchLike, FetchResponse } from '../../src/kernel/providers.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import { defineType } from '../../src/kernel/types.js';

/**
 * Task 8: the broker's `getStream`, for a feed larger than the policy's response cap (SuccessFactors' `sitemal.xml`).
 * The text is handed to the caller chunk by chunk and never held whole; the caller names its own byte cap, and a cap
 * above the policy's `maxResponseBytes` needs `capabilities.httpStream` (and never more than STREAM_MAX_BYTES).
 */

const T = defineType('Blob', 1, z.object({ s: z.string() }).strict());
const base = {
  version: '1.0.0',
  skills: ['testing'],
  team: 'demo',
  consumes: T,
  produces: T,
  kind: 'io' as const,
  dataClasses: { in: ['P0' as const], out: ['P0' as const] },
  timeoutMs: 1000,
  egress: ['careers.example.com'],
  budget: { usdPerCall: 0, usdPerRun: 0 },
};
const reader = defineContract({ ...base, id: 'reader', description: 'Reads one feed from one host', capabilities: { http: true } });
const streamer = defineContract({ ...base, id: 'streamer', description: 'Streams one large feed from one host', capabilities: { http: true, httpStream: true } });

const enc = new TextEncoder();
/** A response whose body arrives in the given chunks (bytes); `length` sets a content-length header. */
function streamed(status: number, chunks: readonly Uint8Array[], headers: Record<string, string> = {}): FetchResponse & { pulled: () => number; cancelled: () => boolean } {
  let i = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      const next = chunks[i++];
      if (next === undefined) c.close();
      else c.enqueue(next);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { status, body, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => '', pulled: () => i, cancelled: () => cancelled };
}

const ctxOf = (contract: typeof reader, fetch: FetchLike) =>
  issueContext({ contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock: fixedClock('2026-10-14T00:00:00Z'), signal: new AbortController().signal });

describe('getStream', () => {
  it('hands the text over chunk by chunk, multi-byte characters split across chunks intact', async () => {
    const bytes = enc.encode('<rss><item>Bengaluru – ₹ 30 LPA</item></rss>');
    const chunks = [bytes.slice(0, 20), bytes.slice(20, 23), bytes.slice(23)];
    const r = streamed(200, chunks);
    const got: string[] = [];
    const ctx = ctxOf(reader, async () => r);
    const out = await ctx.http!.getStream('https://careers.example.com/sitemal.xml', (t) => void got.push(t), { maxBytes: 1024 });
    expect(got.join('')).toBe('<rss><item>Bengaluru – ₹ 30 LPA</item></rss>');
    expect(got.length).toBeGreaterThan(1);
    expect(out).toMatchObject({ status: 200, capped: false, stopped: false, bytes: bytes.byteLength });
  });

  it('stops at the cap, cancels the stream and says so (never a silent truncation)', async () => {
    const r = streamed(200, [enc.encode('a'.repeat(600)), enc.encode('b'.repeat(600)), enc.encode('c'.repeat(600))]);
    const got: string[] = [];
    const ctx = ctxOf(reader, async () => r);
    const out = await ctx.http!.getStream('https://careers.example.com/f', (t) => void got.push(t), { maxBytes: 1000 });
    expect(out).toMatchObject({ status: 200, capped: true });
    expect(r.cancelled()).toBe(true);
    expect(r.pulled()).toBeLessThan(4);
    expect(got.join('').length).toBeLessThanOrEqual(1000);
  });

  it('refuses at once, reading nothing, when content-length is over the cap', async () => {
    const r = streamed(200, [enc.encode('x'.repeat(10))], { 'content-length': '5000' });
    const got: string[] = [];
    const out = await ctxOf(reader, async () => r).http!.getStream('https://careers.example.com/f', (t) => void got.push(t), { maxBytes: 1000 });
    expect(out).toMatchObject({ capped: true, bytes: 0 });
    expect(got).toEqual([]);
    expect(r.cancelled()).toBe(true);
  });

  it('stops early when the caller returns false (a verifier reading the first item)', async () => {
    const r = streamed(200, [enc.encode('one'), enc.encode('two'), enc.encode('three')]);
    const got: string[] = [];
    const out = await ctxOf(reader, async () => r).http!.getStream('https://careers.example.com/f', (t) => (got.push(t), false), { maxBytes: 1000 });
    expect(out).toMatchObject({ stopped: true, capped: false });
    expect(got).toEqual(['one']);
    expect(r.cancelled()).toBe(true);
  });

  it('returns a non-2xx answer with a short body (for bot-wall checks) and its Location, never streaming it', async () => {
    const wall = streamed(503, [enc.encode('<title>Just a moment...</title>'), enc.encode('y'.repeat(200_000))]);
    const got: string[] = [];
    const out = await ctxOf(reader, async () => wall).http!.getStream('https://careers.example.com/f', (t) => void got.push(t), { maxBytes: 1000 });
    expect(out.status).toBe(503);
    expect(out.body).toContain('Just a moment');
    expect(out.body!.length).toBeLessThanOrEqual(64 * 1024);
    expect(got).toEqual([]);
    const moved = streamed(302, [], { location: '/elsewhere' });
    const m = await ctxOf(reader, async () => moved).http!.getStream('https://careers.example.com/f', () => undefined, { maxBytes: 1000 });
    expect(m).toMatchObject({ status: 302, location: '/elsewhere' });
  });

  it('a cap above the policy response cap needs capabilities.httpStream, and never passes STREAM_MAX_BYTES', async () => {
    const big = PRODUCT_POLICY_V1.maxResponseBytes + 1;
    const f: FetchLike = async () => streamed(200, [enc.encode('ok')]);
    await expect(ctxOf(reader, f).http!.getStream('https://careers.example.com/f', () => undefined, { maxBytes: big })).rejects.toMatchObject({ code: 'policy_denied', message: expect.stringMatching(/httpStream/) });
    await expect(ctxOf(streamer, f).http!.getStream('https://careers.example.com/f', () => undefined, { maxBytes: big })).resolves.toMatchObject({ status: 200 });
    await expect(ctxOf(streamer, f).http!.getStream('https://careers.example.com/f', () => undefined, { maxBytes: STREAM_MAX_BYTES + 1 })).rejects.toMatchObject({ code: 'policy_denied' });
    expect(STREAM_MAX_BYTES).toBeGreaterThanOrEqual(50 * 1024 * 1024);
  });

  it('keeps the egress, https-only and honest-header rules of every request', async () => {
    const seen: Record<string, string>[] = [];
    const f: FetchLike = async (_u, init) => (seen.push({ ...init.headers }), streamed(200, [enc.encode('ok')]));
    const ctx = ctxOf(reader, f);
    await expect(ctx.http!.getStream('https://evil.example/f', () => undefined, { maxBytes: 10 })).rejects.toThrow(/G-EGRESS/);
    await expect(ctx.http!.getStream('http://careers.example.com/f', () => undefined, { maxBytes: 10 })).rejects.toThrow(/only https/);
    await ctx.http!.getStream('https://careers.example.com/f', () => undefined, { maxBytes: 10 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!['user-agent']).toBe('jobpilot/0.1 (+local)');
  });

  it('the contract refuses httpStream without http', () => {
    expect(() => defineContract({ ...base, id: 'bad', description: 'Streams without plain http', egress: [], kind: 'io', capabilities: { httpStream: true } } as never)).toThrow(/capabilities.httpStream requires capabilities.http/);
  });
});
