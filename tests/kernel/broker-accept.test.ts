import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HTTP_HEADERS, issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { defineContract } from '../../src/kernel/contract.js';
import type { FetchLike } from '../../src/kernel/providers.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import { defineType } from '../../src/kernel/types.js';

/**
 * Task 9: `getPage` may name ONE alternative Accept value, `application/rss+xml` (Teamtailor answers 400 to the JSON
 * Accept, seen live). Everything else about the request stays the broker's: the egress, https, pacing, the honest
 * user agent, the size cap, no redirect following. Any other value is a policy denial, never sent.
 */
const T = defineType('Blob', 1, z.object({ s: z.string() }).strict());
const feeder = defineContract({
  id: 'feeder', version: '1.0.0', description: 'Reads one feed from one host', skills: ['testing'], team: 'demo', consumes: T, produces: T, kind: 'io',
  dataClasses: { in: ['P0'], out: ['P0'] }, timeoutMs: 1000, egress: ['career.example.com'], budget: { usdPerCall: 0, usdPerRun: 0 }, capabilities: { http: true },
});

function run(fetch: FetchLike) {
  return issueContext({ contract: feeder, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock: fixedClock('2026-10-14T00:00:00Z'), signal: new AbortController().signal });
}

describe('getPage accept option', () => {
  it('sends application/rss+xml as the accept, with the honest user agent and nothing else changed', async () => {
    const inits: Parameters<FetchLike>[1][] = [];
    const ctx = run(async (_u, init) => {
      inits.push(init);
      return { status: 200, text: async () => '<rss/>' };
    });
    await expect(ctx.http!.getPage('https://career.example.com/jobs.rss', { accept: 'application/rss+xml' })).resolves.toMatchObject({ status: 200, body: '<rss/>' });
    expect(inits[0]?.headers).toEqual({ accept: 'application/rss+xml', 'user-agent': 'jobpilot/0.1 (+local)' });
    expect(inits[0]?.redirect).toBe('manual');
    expect(Object.keys(inits[0]?.headers ?? {}).sort()).toEqual(['accept', 'user-agent']);
  });

  it('without the option the fixed headers are unchanged', async () => {
    const inits: Parameters<FetchLike>[1][] = [];
    const ctx = run(async (_u, init) => {
      inits.push(init);
      return { status: 200, text: async () => '' };
    });
    await ctx.http!.getPage('https://career.example.com/a');
    expect(inits[0]?.headers).toEqual(HTTP_HEADERS);
  });

  it('refuses any other accept value, nothing is sent; egress and https still apply', async () => {
    let sent = 0;
    const ctx = run(async () => {
      sent++;
      return { status: 200, text: async () => '' };
    });
    await expect(ctx.http!.getPage('https://career.example.com/a', { accept: 'text/html' as never })).rejects.toThrow(/G-NO-EVASION/);
    await expect(ctx.http!.getPage('https://evil.example/a', { accept: 'application/rss+xml' })).rejects.toThrow(/G-EGRESS/);
    await expect(ctx.http!.getPage('http://career.example.com/a', { accept: 'application/rss+xml' })).rejects.toThrow(/only https/);
    expect(sent).toBe(0);
  });
});
