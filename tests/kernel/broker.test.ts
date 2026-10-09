import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHostPacer, issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { defineContract } from '../../src/kernel/contract.js';
import { KernelError } from '../../src/kernel/errors.js';
import { fakeFetch, fakeLlm } from '../../src/kernel/fakes.js';
import type { FetchLike, LlmProvider } from '../../src/kernel/providers.js';
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
  describe('hardening', () => {
    const H = 'https://boards-api.greenhouse.io';
    const thrown = (p: Promise<unknown>) => p.catch((e: unknown) => e);
    const stubLlm = (fail: unknown, usd = 0.001): LlmProvider & { n: number } => {
      const p = {
        host: 'api.anthropic.com',
        n: 0,
        async complete() {
          p.n++;
          if (fail !== undefined) throw fail;
          return { text: 'x', inputTokens: 1, outputTokens: 1, usd };
        },
      };
      return p;
    };
    const capped = defineContract({
      ...common,
      id: 'capped',
      description: 'Asks the model under a run cap',
      kind: 'llm',
      capabilities: { llm: { model: 'claude-sonnet-5-5', maxTokens: 100 } },
      egress: ['api.anthropic.com'],
      budget: { usdPerCall: 0.002, usdPerRun: 0.003 },
    });

    it.each([301, 302])('refuses a %i redirect and never follows it', async (status) => {
      const f = fakeFetch({ [`${H}/r`]: { status, body: '' } });
      const err = await thrown(issue(fetcher, 'P0', { fetch: f }).http!.getText(`${H}/r`));
      expect(err).toMatchObject({ code: 'policy_denied' });
      expect((err as Error).message).toMatch(/redirect/);
      expect(f.calls).toHaveLength(1);
    });

    it('always passes redirect: manual to fetch', async () => {
      const inits: unknown[] = [];
      const f: FetchLike = async (_u, init) => {
        inits.push(init);
        return { status: 200, text: async () => 'ok' };
      };
      await issue(fetcher, 'P0', { fetch: f }).http!.getText(`${H}/x`);
      expect(inits[0]).toMatchObject({ redirect: 'manual' });
    });

    it('rejects explicit ports and unparseable URLs', async () => {
      const f = fakeFetch({});
      const ctx = issue(fetcher, 'P0', { fetch: f });
      await expect(ctx.http!.getText(`${H}:8443/x`)).rejects.toMatchObject({ code: 'policy_denied', message: expect.stringMatching(/port/) });
      await expect(ctx.http!.getText('not a url')).rejects.toMatchObject({ code: 'policy_denied', message: expect.stringMatching(/invalid URL/) });
      expect(f.calls).toHaveLength(0);
    });

    it('judges the real host, and URL parsing lowercases it', async () => {
      const f = fakeFetch({ [`${H}/x`]: { body: 'ok' } });
      const ctx = issue(fetcher, 'P0', { fetch: f });
      await expect(ctx.http!.getText('https://BOARDS-API.greenhouse.io/x')).resolves.toMatchObject({ status: 200 });
      await expect(ctx.http!.getText('https://boards-api.greenhouse.io@evil.example/x')).rejects.toThrow(/G-EGRESS/);
    });

    it('refuses credentials in URLs before any fetch', async () => {
      const f = fakeFetch({});
      const ctx = issue(fetcher, 'P0', { fetch: f });
      for (const url of ['https://evil.example@boards-api.greenhouse.io/x', 'https://u:p@boards-api.greenhouse.io/x', 'https://:p@boards-api.greenhouse.io/x']) {
        await expect(ctx.http!.getText(url)).rejects.toMatchObject({ code: 'policy_denied', message: 'G-EGRESS: credentials in URLs are not allowed' });
      }
      expect(f.calls).toHaveLength(0);
    });

    it('maps an external abort to unknown and a body read failure to network', async () => {
      const aborted: FetchLike = async () => {
        throw { name: 'AbortError' };
      };
      const badBody: FetchLike = async () => ({
        status: 200,
        text: async () => {
          throw new Error('socket hang up');
        },
      });
      expect(await thrown(issue(fetcher, 'P0', { fetch: aborted }).http!.getText(`${H}/x`))).toMatchObject({ code: 'unknown' });
      expect(await thrown(issue(fetcher, 'P0', { fetch: badBody }).http!.getText(`${H}/x`))).toMatchObject({ code: 'network' });
    });

    it('maps provider status failures to retryable codes', async () => {
      const a = issue(thinker, 'P0', { fetch: fakeFetch({}), llm: stubLlm({ status: 429 }) });
      const b = issue(thinker, 'P0', { fetch: fakeFetch({}), llm: stubLlm({ status: 529 }) });
      expect(await thrown(a.llm!.complete({ system: 's', prompt: 'p' }))).toMatchObject({ code: 'rate_limit' });
      expect(await thrown(b.llm!.complete({ system: 's', prompt: 'p' }))).toMatchObject({ code: 'overloaded' });
    });

    it('blocks every call after one exceeded usdPerCall, without calling the provider', async () => {
      const llm = stubLlm(undefined, 0.5);
      const ctx = issue(thinker, 'P0', { fetch: fakeFetch({}), llm });
      await expect(ctx.llm!.complete({ system: 's', prompt: 'p' })).rejects.toMatchObject({ code: 'budget_exceeded' });
      await expect(ctx.llm!.complete({ system: 's', prompt: 'p' })).rejects.toThrow(/previous call exceeded usdPerCall/);
      expect(llm.n).toBe(1);
    });

    it('refuses a call once cumulative usd plus a reserved usdPerCall would pass usdPerRun', async () => {
      const llm = stubLlm(undefined, 0.002);
      const ctx = issue(capped, 'P0', { fetch: fakeFetch({}), llm });
      await ctx.llm!.complete({ system: 's', prompt: 'p' });
      expect(ctx.spent().usd).toBeCloseTo(0.002);
      await expect(ctx.llm!.complete({ system: 's', prompt: 'p' })).rejects.toThrow(/usdPerRun reached/);
      expect(llm.n).toBe(1);
    });

    it('allows one model call in flight per step', async () => {
      let n = 0;
      const slow: LlmProvider = {
        host: 'api.anthropic.com',
        async complete() {
          n++;
          await new Promise((r) => setTimeout(r, 5));
          return { text: 'x', inputTokens: 1, outputTokens: 1, usd: 0.001 };
        },
      };
      const ctx = issue(thinker, 'P0', { fetch: fakeFetch({}), llm: slow });
      const rs = await Promise.allSettled([1, 2, 3].map(() => ctx.llm!.complete({ system: 's', prompt: 'p' })));
      expect(n).toBe(1);
      expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(2);
      for (const r of rejected) expect(r.reason).toMatchObject({ code: 'policy_denied', message: 'G-BUDGET: one model call at a time per step' });
      await expect(ctx.llm!.complete({ system: 's', prompt: 'p' })).resolves.toBeDefined();
    });

    it('does not echo the raw URL in the port error', async () => {
      const err = await thrown(issue(fetcher, 'P0', { fetch: fakeFetch({}) }).http!.getText('https://u:secret@boards-api.greenhouse.io:8443/x'));
      expect((err as Error).message).toMatch(/port/);
      expect((err as Error).message).not.toMatch(/secret/);
    });

    it('refuses new model calls once the signal has aborted, and keeps refusing', async () => {
      const llm = fakeLlm(() => 'ok');
      const ac = new AbortController();
      const ctx = issueContext({ contract: thinker, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: fakeFetch({}), llm }, clock: fixedClock('2026-10-08T00:00:00Z'), signal: ac.signal });
      ac.abort();
      await expect(ctx.llm!.complete({ system: 's', prompt: 'p' })).rejects.toMatchObject({ code: 'timeout' });
      await expect(ctx.llm!.complete({ system: 's', prompt: 'p' })).rejects.toMatchObject({ code: 'timeout' });
      expect(llm.calls).toHaveLength(0);
    });

    it('refuses new requests once the signal has aborted', async () => {
      const f = fakeFetch({ 'https://boards-api.greenhouse.io/x': { body: '{}' } });
      const ac = new AbortController();
      const ctx = issueContext({ contract: fetcher, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: f }, clock: fixedClock('2026-10-08T00:00:00Z'), signal: ac.signal });
      ac.abort();
      await expect(ctx.http!.getText('https://boards-api.greenhouse.io/x')).rejects.toMatchObject({ code: 'timeout' });
      expect(f.calls).toHaveLength(0);
    });

    it('fails with policy_denied when no LLM provider is configured', async () => {
      const ctx = issue(thinker, 'P0', { fetch: fakeFetch({}) });
      expect(ctx.llm).toBeDefined();
      await expect(ctx.llm!.complete({ system: 's', prompt: 'p' })).rejects.toMatchObject({ code: 'policy_denied' });
    });
  });
});

describe('capability broker: prior run spend (G-BUDGET)', () => {
  const issueWith = (priorSpend: { agentUsd: number; runUsd: number; maxCallUsd?: number }) => {
    const llm = fakeLlm(() => 'yes', { usdPerCall: 0.001 });
    const ctx = issueContext({
      contract: thinker, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: fakeFetch({}), llm },
      clock: fixedClock('2026-10-08T00:00:00Z'), signal: new AbortController().signal, priorSpend,
    });
    return { ctx, llm };
  };

  it('refuses a call once the agent has spent its usdPerRun earlier in the run', async () => {
    const { ctx, llm } = issueWith({ agentUsd: 1, runUsd: 1 });
    await expect(ctx.llm!.complete({ system: 's', prompt: 'p' })).rejects.toMatchObject({ code: 'budget_exceeded', message: 'G-BUDGET: run budget reached' });
    expect(llm.calls).toHaveLength(0);
  });

  it('refuses a call once the run has reached the policy cap', async () => {
    const { ctx, llm } = issueWith({ agentUsd: 0, runUsd: PRODUCT_POLICY_V1.maxUsdPerRun });
    await expect(ctx.llm!.complete({ system: 's', prompt: 'p' })).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(llm.calls).toHaveLength(0);
  });

  it('reserves usdPerCall: refuses a call that could carry the agent past usdPerRun', async () => {
    const { ctx, llm } = issueWith({ agentUsd: 1 - 0.005, runUsd: 0 });
    await expect(ctx.llm!.complete({ system: 's', prompt: 'p' })).rejects.toMatchObject({ code: 'budget_exceeded', message: 'G-BUDGET: run budget reached' });
    expect(llm.calls).toHaveLength(0);
  });

  it('reserves usdPerCall: refuses a call that could carry the run past the policy cap', async () => {
    const { ctx, llm } = issueWith({ agentUsd: 0, runUsd: PRODUCT_POLICY_V1.maxUsdPerRun - 0.005 });
    await expect(ctx.llm!.complete({ system: 's', prompt: 'p' })).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(llm.calls).toHaveLength(0);
  });

  it('allows a call whose reservation fits exactly', async () => {
    const { ctx, llm } = issueWith({ agentUsd: 1 - 0.01, runUsd: 0 });
    await expect(ctx.llm!.complete({ system: 's', prompt: 'p' })).resolves.toBeDefined();
    expect(llm.calls).toHaveLength(1);
  });

  it('reserves the largest call already charged in the run when it is above usdPerCall', async () => {
    const { ctx, llm } = issueWith({ agentUsd: 0.7, runUsd: 0, maxCallUsd: 0.4 });
    await expect(ctx.llm!.complete({ system: 's', prompt: 'p' })).rejects.toMatchObject({ code: 'budget_exceeded', message: 'G-BUDGET: run budget reached' });
    expect(llm.calls).toHaveLength(0);
  });

  it('reports the largest single call it paid', async () => {
    const { ctx } = issueWith({ agentUsd: 0, runUsd: 0 });
    expect(ctx.maxCall()).toBe(0);
    await ctx.llm!.complete({ system: 's', prompt: 'p' });
    expect(ctx.maxCall()).toBeCloseTo(0.001, 10);
  });
});

describe('capability broker: denials are recorded', () => {
  const H = 'https://boards-api.greenhouse.io';
  const swallow = (p: Promise<unknown>) => p.catch(() => undefined);

  it('records every policy denial, even when the agent catches it', async () => {
    const f = fakeFetch({ [`${H}/r`]: { status: 302, body: '' } });
    const ctx = issue(fetcher, 'P0', { fetch: f });
    expect(ctx.denials()).toEqual([]);
    await swallow(ctx.http!.getText('https://evil.example/x'));
    await swallow(ctx.http!.getText('http://boards-api.greenhouse.io/x'));
    await swallow(ctx.http!.getText(`https://boards-api.greenhouse.io:8443/x`));
    await swallow(ctx.http!.getText('https://u:p@boards-api.greenhouse.io/x'));
    await swallow(ctx.http!.getText('not a url'));
    await swallow(ctx.http!.getText(`${H}/r`));
    expect(ctx.denials()).toHaveLength(6);
    expect(ctx.denials()[0]).toMatch(/^G-EGRESS: fetcher may not contact evil\.example/);
    expect(ctx.denials()[5]).toMatch(/redirect/);
  });

  it('records PII egress and a missing provider', async () => {
    const pii = issue(thinker, 'P1', { fetch: fakeFetch({}), llm: fakeLlm(() => 'ok') });
    await swallow(pii.llm!.complete({ system: 's', prompt: 'p' }));
    expect(pii.denials()).toEqual([expect.stringMatching(/^G-PII-EGRESS/)]);
    const none = issue(thinker, 'P0', { fetch: fakeFetch({}) });
    await swallow(none.llm!.complete({ system: 's', prompt: 'p' }));
    expect(none.denials()).toEqual(['no LLM provider is configured']);
  });

  it('does not record ordinary failures', async () => {
    const f = fakeFetch({ [`${H}/a`]: { status: 503, body: '' } });
    const ctx = issue(fetcher, 'P0', { fetch: f });
    await swallow(ctx.http!.getText(`${H}/a`));
    expect(ctx.denials()).toEqual([]);
  });
});

describe('capability broker: error messages', () => {
  it('the only-https denial names the scheme and host, never the path, query or credentials', async () => {
    const ctx = issue(fetcher, 'P0', { fetch: fakeFetch({}) });
    const err = (await ctx.http!.getText('http://boards-api.greenhouse.io/v1/secret-path?token=abc123').catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('G-EGRESS: only https is allowed (http://boards-api.greenhouse.io)');
    expect(ctx.denials()).toEqual([err.message]);
  });
});

describe('v1 kernel extensions: broker', () => {
  const H = 'https://boards-api.greenhouse.io';
  const at = fixedClock('2026-10-08T00:00:00Z');
  const issueWith = (contract: typeof fetcher, providers: Parameters<typeof issueContext>[0]['providers'], extra: Partial<Parameters<typeof issueContext>[0]> = {}) =>
    issueContext({ contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers, clock: at, signal: new AbortController().signal, ...extra });
  const packer = defineContract({ ...common, id: 'packer', description: 'Reads the user pack only', kind: 'deterministic', capabilities: { pack: true }, budget: { usdPerCall: 0, usdPerRun: 0 } });

  it('gives ctx.pack only to a contract that declares capabilities.pack, deep-frozen', () => {
    const pack = { profile: { name: 'Asha Rao', skills: ['go'] } };
    expect(issueWith(plain, { fetch: fakeFetch({}) }, { pack }).pack).toBeUndefined();
    const ctx = issueWith(packer, { fetch: fakeFetch({}) }, { pack });
    expect(ctx.pack).toEqual(pack);
    const p = ctx.pack as { profile: { name: string; skills: string[] } };
    expect(() => {
      p.profile.name = 'x';
    }).toThrow(TypeError);
    expect(() => p.profile.skills.push('rust')).toThrow(TypeError);
  });

  it('getJson parses JSON', async () => {
    const ctx = issueWith(fetcher, { fetch: fakeFetch({ [`${H}/j`]: { body: '{"jobs":[1,2]}' } }) });
    await expect(ctx.http!.getJson(`${H}/j`)).resolves.toEqual({ status: 200, json: { jobs: [1, 2] } });
  });

  it('getJson rejects invalid JSON with invalid_output', async () => {
    const ctx = issueWith(fetcher, { fetch: fakeFetch({ [`${H}/j`]: { body: '{nope' } }) });
    await expect(ctx.http!.getJson(`${H}/j`)).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('refuses a body over policy.maxResponseBytes with invalid_output, for getText and getJson', async () => {
    const policy = { ...PRODUCT_POLICY_V1, maxResponseBytes: 8 };
    const f = fakeFetch({ [`${H}/big`]: { body: '"0123456789"' }, [`${H}/ok`]: { body: '"1234"' } });
    const ctx = issueWith(fetcher, { fetch: f }, { policy });
    await expect(ctx.http!.getText(`${H}/big`)).rejects.toMatchObject({ code: 'invalid_output', message: 'response exceeds 8 bytes' });
    await expect(ctx.http!.getJson(`${H}/big`)).rejects.toMatchObject({ code: 'invalid_output', message: 'response exceeds 8 bytes' });
    await expect(ctx.http!.getJson(`${H}/ok`)).resolves.toEqual({ status: 200, json: '1234' });
  });

  it('counts the cap in bytes, not characters, and stops reading a streamed body past it', async () => {
    const policy = { ...PRODUCT_POLICY_V1, maxResponseBytes: 5 };
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new TextEncoder().encode('ééé'));
      },
    });
    const f: FetchLike = async () => ({ status: 200, body: stream, text: async () => { throw new Error('text() must not be used when a body stream exists'); } });
    const ctx = issueWith(fetcher, { fetch: f }, { policy });
    await expect(ctx.http!.getText(`${H}/s`)).rejects.toMatchObject({ code: 'invalid_output', message: 'response exceeds 5 bytes' });
    expect(pulled).toBeLessThan(5);
    const small: FetchLike = async () => ({ status: 200, body: new Response('ééé').body, text: async () => '' });
    await expect(issueWith(fetcher, { fetch: small }, { policy: { ...PRODUCT_POLICY_V1, maxResponseBytes: 6 } }).http!.getText(`${H}/s`)).resolves.toEqual({ status: 200, body: 'ééé' });
  });

  it('sends the fixed accept and honest user-agent headers', async () => {
    const inits: unknown[] = [];
    const f: FetchLike = async (_u, init) => {
      inits.push(init);
      return { status: 200, text: async () => '{}' };
    };
    const ctx = issueWith(fetcher, { fetch: f });
    await ctx.http!.getText(`${H}/a`);
    await ctx.http!.getJson(`${H}/b`);
    for (const init of inits) {
      expect(init).toMatchObject({
        redirect: 'manual',
        headers: { accept: 'application/json, text/plain;q=0.8, */*;q=0.1', 'user-agent': 'jobpilot/0.1 (+local)' },
      });
    }
  });

  it('paces requests per host through the shared host pacer', async () => {
    const slept: number[] = [];
    const pacer = createHostPacer(1000, at, async (ms) => {
      slept.push(ms);
    });
    const f = fakeFetch({ [`${H}/a`]: { body: '{}' }, [`${H}/b`]: { body: '{}' } });
    const first = issueWith(fetcher, { fetch: f }, { hostPacer: pacer });
    const second = issueWith(fetcher, { fetch: f }, { hostPacer: pacer });
    await first.http!.getJson(`${H}/a`);
    expect(slept).toEqual([]);
    await second.http!.getJson(`${H}/b`);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThanOrEqual(1000);
    expect(f.calls).toHaveLength(2);
  });

  it('host pacer: waits only the remainder of the interval, and hosts are independent', async () => {
    let now = Date.parse('2026-10-08T00:00:00Z');
    const clock = { now: () => new Date(now).toISOString() };
    const slept: number[] = [];
    const pacer = createHostPacer(1000, clock, async (ms) => {
      slept.push(ms);
      now += ms;
    });
    await pacer.wait('a.example');
    await pacer.wait('b.example');
    expect(slept).toEqual([]);
    now += 400;
    await pacer.wait('a.example');
    expect(slept).toEqual([600]);
    now += 5000;
    await pacer.wait('A.example.');
    expect(slept).toEqual([600]);
  });

  it('host pacer: concurrent waits on one host are spaced, not collapsed', async () => {
    const slept: number[] = [];
    const pacer = createHostPacer(1000, at, async (ms) => {
      slept.push(ms);
    });
    await Promise.all([pacer.wait('a.example'), pacer.wait('a.example'), pacer.wait('a.example')]);
    expect(slept).toEqual([1000, 2000]);
  });
});
