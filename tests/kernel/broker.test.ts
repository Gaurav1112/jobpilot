import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { defineContract } from '../../src/kernel/contract.js';
import { KernelError } from '../../src/kernel/errors.js';
import { fakeFetch, fakeLlm } from '../../src/kernel/fakes.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import { defineType } from '../../src/kernel/types.js';

const T = defineType('Blob', 1, z.object({ s: z.string() }).strict());
const common = {
  version: '1.0.0',
  skills: ['testing'],
  team: 'demo',
  consumes: T,
  produces: T,
  dataClasses: { in: ['P0' as const, 'P1' as const], out: ['P0' as const, 'P1' as const] },
  timeoutMs: 1000,
};
const fetcher = defineContract({
  ...common,
  id: 'fetcher',
  description: 'Fetches a page from one host',
  kind: 'io',
  capabilities: { http: true },
  egress: ['boards-api.greenhouse.io'],
  budget: { usdPerCall: 0, usdPerRun: 0 },
});
const thinker = defineContract({
  ...common,
  id: 'thinker',
  description: 'Asks the model one question',
  kind: 'llm',
  capabilities: { llm: { model: 'claude-sonnet-5-5', maxTokens: 100 } },
  egress: ['api.anthropic.com'],
  budget: { usdPerCall: 0.01, usdPerRun: 1 },
});
const plain = defineContract({ ...common, id: 'plain', description: 'Pure transformation only', kind: 'deterministic', budget: { usdPerCall: 0, usdPerRun: 0 } });

const issue = (contract: typeof fetcher, inputClass: 'P0' | 'P1', providers: Parameters<typeof issueContext>[0]['providers']) =>
  issueContext({ contract, policy: PRODUCT_POLICY_V1, inputClass, providers, clock: fixedClock('2026-10-08T00:00:00Z'), signal: new AbortController().signal });

describe('capability broker', () => {
  it('gives a deterministic agent no tools at all', () => {
    const ctx = issue(plain, 'P0', { fetch: fakeFetch({}) });
    expect(ctx.http).toBeUndefined();
    expect(ctx.llm).toBeUndefined();
  });

  it('lets an io agent reach only its declared hosts (G-EGRESS)', async () => {
    const f = fakeFetch({ 'https://boards-api.greenhouse.io/v1/boards/x/jobs': { body: '{}' } });
    const ctx = issue(fetcher, 'P0', { fetch: f });
    await expect(ctx.http!.getText('https://boards-api.greenhouse.io/v1/boards/x/jobs')).resolves.toEqual({ status: 200, body: '{}' });
    await expect(ctx.http!.getText('https://evil.example/x')).rejects.toThrow(/G-EGRESS/);
    await expect(ctx.http!.getText('http://boards-api.greenhouse.io/x')).rejects.toThrow(/only https/);
    expect(f.calls).toHaveLength(1);
  });

  it('maps 429 and 5xx to retryable codes', async () => {
    const f = fakeFetch({
      'https://boards-api.greenhouse.io/a': { status: 429, body: '' },
      'https://boards-api.greenhouse.io/b': { status: 503, body: '' },
    });
    const ctx = issue(fetcher, 'P0', { fetch: f });
    await expect(ctx.http!.getText('https://boards-api.greenhouse.io/a')).rejects.toMatchObject({ code: 'rate_limit' });
    await expect(ctx.http!.getText('https://boards-api.greenhouse.io/b')).rejects.toMatchObject({ code: 'overloaded' });
  });

  it('refuses to send P1 data to the model provider (G-PII-EGRESS)', async () => {
    const llm = fakeLlm(() => 'ok');
    const ctx = issue(thinker, 'P1', { fetch: fakeFetch({}), llm });
    await expect(ctx.llm!.complete({ system: 's', prompt: 'p' })).rejects.toThrow(/G-PII-EGRESS/);
    expect(llm.calls).toHaveLength(0);
  });

  it('meters spend and enforces the per-call budget (G-BUDGET)', async () => {
    const ctx = issue(thinker, 'P0', { fetch: fakeFetch({}), llm: fakeLlm(() => 'yes', { usdPerCall: 0.002 }) });
    await ctx.llm!.complete({ system: 's', prompt: 'hello' });
    expect(ctx.spent()).toEqual({ usd: 0.002, inputTokens: 5, outputTokens: 3 });

    const pricey = issue(thinker, 'P0', { fetch: fakeFetch({}), llm: fakeLlm(() => 'yes', { usdPerCall: 0.5 }) });
    const err = await pricey.llm!.complete({ system: 's', prompt: 'p' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KernelError);
    expect((err as KernelError).code).toBe('budget_exceeded');
    expect(pricey.spent().usd).toBe(0.5);
  });

  it('passes the contract model and token cap, not the agent choice', async () => {
    const llm = fakeLlm(() => 'ok');
    const ctx = issue(thinker, 'P0', { fetch: fakeFetch({}), llm });
    await ctx.llm!.complete({ system: 's', prompt: 'p' });
    expect(llm.calls[0]).toMatchObject({ model: 'claude-sonnet-5-5', maxTokens: 100 });
  });
});
