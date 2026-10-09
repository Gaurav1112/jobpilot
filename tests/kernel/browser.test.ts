import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAgent } from '../../src/kernel/agent.js';
import { CHALLENGE_PATTERN, createHostPacer, issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { contractHash, defineContract } from '../../src/kernel/contract.js';
import { type Envelope, ZERO_COST } from '../../src/kernel/envelope.js';
import { ERROR_CODES, KernelError, RETRYABLE } from '../../src/kernel/errors.js';
import { executeStep } from '../../src/kernel/executor.js';
import { fakeBrowser } from '../../src/kernel/fakes.js';
import { builtinGuardrails } from '../../src/kernel/guardrails/builtin.js';
import { PRODUCT_POLICY_V1, mergePolicy, policyHash } from '../../src/kernel/policy.js';
import type { BrowserProvider, BrowserRenderRequest } from '../../src/kernel/providers.js';
import { Store } from '../../src/kernel/store/store.js';
import { defineType } from '../../src/kernel/types.js';
import { runEval } from '../../src/evals/runner.js';

const root = join(import.meta.dirname, '..', '..');
const T = defineType('Page', 1, z.object({ s: z.string() }).strict());
const HOST = 'careers.example.com';
const H = `https://${HOST}`;
const spec = {
  id: 'reader',
  version: '1.0.0',
  description: 'Renders career pages of one host',
  skills: ['testing'],
  team: 'sourcing',
  kind: 'io' as const,
  consumes: T,
  produces: T,
  capabilities: { browser: { maxPages: 3 } },
  egress: [HOST, 'jobs.example.org'],
  dataClasses: { in: ['P0' as const], out: ['P0' as const] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 1000,
};
const reader = defineContract(spec);
const at = fixedClock('2026-10-09T00:00:00Z');
type Issue = Parameters<typeof issueContext>[0];
const issue = (browser: BrowserProvider | undefined, extra: Partial<Issue> = {}) =>
  issueContext({
    contract: reader,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: { fetch: async () => ({ status: 404, text: async () => '' }), ...(browser ? { browser } : {}) },
    clock: at,
    signal: new AbortController().signal,
    ...extra,
  });
const page = (html: string, extra: { status?: number; finalUrl?: string } = {}) => ({ html, text: 'text', jsonLd: [], ...extra });

describe('contract: capabilities.browser', () => {
  it('accepts { maxPages } on an io agent with egress, and keeps it in the contract shape', () => {
    expect(reader.capabilities.browser).toEqual({ maxPages: 3 });
    expect(contractHash(reader)).not.toBe(contractHash(defineContract({ ...spec, capabilities: { browser: { maxPages: 4 } } })));
  });

  it('rejects a browser capability without egress, on a deterministic agent, or with a bad page count', () => {
    expect(() => defineContract({ ...spec, egress: [] })).toThrow(/browser requires at least one egress host/);
    expect(() => defineContract({ ...spec, kind: 'deterministic', egress: [] })).toThrow(/may not request capabilities.browser/);
    expect(() => defineContract({ ...spec, kind: 'effect' })).toThrow(/may not request capabilities.browser/);
    expect(() => defineContract({ ...spec, capabilities: { browser: { maxPages: 0 } } })).toThrow(/maxPages/);
    expect(() => defineContract({ ...spec, capabilities: { browser: { maxPages: 1.5 } } })).toThrow(/maxPages/);
  });

  it('has no stealth, proxy, user-agent, header or fingerprint option: unknown keys are rejected', () => {
    for (const k of ['stealth', 'proxy', 'userAgent', 'headers', 'fingerprint', 'cookies', 'locale', 'viewport', 'headless']) {
      expect(() => defineContract({ ...spec, capabilities: { browser: { maxPages: 3, [k]: true } } } as never), k).toThrow(/browser/);
    }
  });
});

describe('errors and policy for the browser', () => {
  it('challenged is an error code, and it is not retryable, so no contract may retry it', () => {
    expect(ERROR_CODES).toContain('challenged');
    expect(RETRYABLE.has('challenged')).toBe(false);
    expect(() => defineContract({ ...spec, retry: { max: 1, on: ['challenged'], backoffMs: [1] } })).toThrow(/retryable/);
  });

  it('the product policy denies job boards that forbid crawling, and paces the browser at 10 s per host', () => {
    expect(PRODUCT_POLICY_V1.deniedEgressHosts).toEqual(expect.arrayContaining(['linkedin.com', 'naukri.com', 'indeed.com', 'glassdoor.com']));
    expect(PRODUCT_POLICY_V1.minBrowserIntervalMs).toBe(10_000);
  });

  it('minBrowserIntervalMs may only be raised by the user', () => {
    expect(mergePolicy(PRODUCT_POLICY_V1, { minBrowserIntervalMs: 20_000 }).minBrowserIntervalMs).toBe(20_000);
    expect(mergePolicy(PRODUCT_POLICY_V1, {}).minBrowserIntervalMs).toBe(10_000);
    expect(() => mergePolicy(PRODUCT_POLICY_V1, { minBrowserIntervalMs: 5_000 })).toThrow(/minBrowserIntervalMs may only be raised/);
  });
});

describe('capability broker: ctx.browser', () => {
  it('is absent unless the contract declares capabilities.browser', () => {
    const http = defineContract({ ...spec, id: 'fetcher', capabilities: { http: true } });
    expect(issueContext({ contract: http, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => ({ status: 404, text: async () => '' }), browser: fakeBrowser({}) }, clock: at, signal: new AbortController().signal }).browser).toBeUndefined();
    expect(issue(fakeBrowser({})).browser).toBeDefined();
  });

  it('renders an allowed https page and passes the exact navigation hosts and the deny list to the provider', async () => {
    const b = fakeBrowser({ [`${H}/jobs`]: page('<h1>Jobs</h1>') });
    const ctx = issue(b);
    await expect(ctx.browser!.render(`${H}/jobs`)).resolves.toEqual({ status: 200, finalUrl: `${H}/jobs`, html: '<h1>Jobs</h1>', text: 'text', jsonLd: [] });
    expect(b.calls).toHaveLength(1);
    const req = b.calls[0] as BrowserRenderRequest;
    expect(req.url).toBe(`${H}/jobs`);
    expect(req.navigationHosts).toEqual([HOST, 'jobs.example.org']);
    expect(req.deniedHosts).toEqual(expect.arrayContaining(['linkedin.com', 'glassdoor.com']));
  });

  it('denies hosts outside egress, plain http, explicit ports and credentials, before the provider is called (G-EGRESS)', async () => {
    const b = fakeBrowser({});
    const ctx = issue(b);
    await expect(ctx.browser!.render('https://evil.example/jobs')).rejects.toMatchObject({ code: 'policy_denied', message: expect.stringMatching(/G-EGRESS/) });
    await expect(ctx.browser!.render(`http://${HOST}/jobs`)).rejects.toThrow(/only https/);
    await expect(ctx.browser!.render(`https://${HOST}:8443/jobs`)).rejects.toThrow(/explicit ports/);
    await expect(ctx.browser!.render(`https://u:p@${HOST}/jobs`)).rejects.toThrow(/credentials/);
    await expect(ctx.browser!.render('not a url')).rejects.toThrow(/invalid URL/);
    expect(b.calls).toHaveLength(0);
    expect(ctx.denials()).toHaveLength(5);
  });

  it('denies a policy-denied host even when the contract lists it', async () => {
    const li = defineContract({ ...spec, id: 'li', egress: ['www.linkedin.com'] });
    const b = fakeBrowser({ 'https://www.linkedin.com/jobs': page('x') });
    const ctx = issueContext({ contract: li, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => ({ status: 404, text: async () => '' }), browser: b }, clock: at, signal: new AbortController().signal });
    await expect(ctx.browser!.render('https://www.linkedin.com/jobs')).rejects.toMatchObject({ code: 'policy_denied' });
    expect(b.calls).toHaveLength(0);
    // Nor may a redirect from an allowed host navigate there: the provider is never told it may.
    const mixed = defineContract({ ...spec, id: 'mixed', egress: [HOST, 'www.linkedin.com'] });
    const m = fakeBrowser({ [`${H}/x`]: page('x', { finalUrl: 'https://www.linkedin.com/jobs' }) });
    const mctx = issueContext({ contract: mixed, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => ({ status: 404, text: async () => '' }), browser: m }, clock: at, signal: new AbortController().signal });
    await expect(mctx.browser!.render(`${H}/x`)).rejects.toMatchObject({ code: 'policy_denied' });
    expect(m.calls[0]?.navigationHosts).toEqual([HOST]);
  });

  it('denies a redirect that lands on another host, and a redirect down to http', async () => {
    const b = fakeBrowser({
      [`${H}/a`]: page('<h1>elsewhere</h1>', { finalUrl: 'https://tracker.example/landing' }),
      [`${H}/b`]: page('<h1>plain</h1>', { finalUrl: `http://${HOST}/b` }),
      [`${H}/c`]: page('<h1>ok</h1>', { finalUrl: 'https://jobs.example.org/c' }),
    });
    const ctx = issue(b);
    await expect(ctx.browser!.render(`${H}/a`)).rejects.toMatchObject({ code: 'policy_denied', message: expect.stringMatching(/redirect from careers.example.com to tracker.example refused/) });
    await expect(ctx.browser!.render(`${H}/b`)).rejects.toMatchObject({ code: 'policy_denied', message: expect.stringMatching(/only https/) });
    await expect(ctx.browser!.render(`${H}/c`)).resolves.toMatchObject({ finalUrl: 'https://jobs.example.org/c' });
    expect(ctx.denials()).toHaveLength(2);
  });

  it('stops at a challenge: 403, 429 or a bot-wall page is challenged, never retried by the broker', async () => {
    const b = fakeBrowser({
      [`${H}/403`]: page('<h1>hello</h1>', { status: 403 }),
      [`${H}/429`]: page('<h1>slow down</h1>', { status: 429 }),
      [`${H}/captcha`]: page('<div class="g-recaptcha">Please solve the CAPTCHA</div>'),
    });
    const ctx = issue(b);
    for (const p of ['403', '429', 'captcha']) {
      await expect(ctx.browser!.render(`${H}/${p}`)).rejects.toMatchObject({ code: 'challenged', message: expect.stringMatching(/G-CHALLENGE/) });
    }
    expect(b.calls).toHaveLength(3);
    for (const s of ['cf-challenge', 'Are you a robot?', 'Access Denied', 'captcha']) expect(CHALLENGE_PATTERN.test(s), s).toBe(true);
    expect(CHALLENGE_PATTERN.test('<h1>Senior Engineer</h1>')).toBe(false);
  });

  it('maps a 5xx to overloaded and passes a 404 through to the agent', async () => {
    const ctx = issue(fakeBrowser({ [`${H}/down`]: page('oops', { status: 503 }) }));
    await expect(ctx.browser!.render(`${H}/down`)).rejects.toMatchObject({ code: 'overloaded' });
    await expect(ctx.browser!.render(`${H}/missing`)).resolves.toMatchObject({ status: 404 });
  });

  it('enforces the page budget per step: maxPages renders, then budget_exceeded', async () => {
    const ctx = issue(fakeBrowser({}));
    for (let i = 0; i < 3; i++) await ctx.browser!.render(`${H}/p${i}`);
    await expect(ctx.browser!.render(`${H}/p3`)).rejects.toMatchObject({ code: 'budget_exceeded', message: expect.stringMatching(/page budget of 3/) });
    // A fresh step has a fresh budget.
    await expect(issue(fakeBrowser({})).browser!.render(`${H}/p3`)).resolves.toMatchObject({ status: 404 });
  });

  it('applies the response size cap to the rendered html, in bytes', async () => {
    const policy = { ...PRODUCT_POLICY_V1, maxResponseBytes: 5 };
    const ctx = issue(fakeBrowser({ [`${H}/big`]: page('ééé'), [`${H}/ok`]: page('éé') }), { policy });
    await expect(ctx.browser!.render(`${H}/big`)).rejects.toMatchObject({ code: 'invalid_output', message: 'response exceeds 5 bytes' });
    await expect(ctx.browser!.render(`${H}/ok`)).resolves.toMatchObject({ html: 'éé' });
  });

  it('paces renders by minBrowserIntervalMs and shares the http host pacer', async () => {
    const order: string[] = [];
    const browserPacer = { wait: async (h: string) => void order.push(`browser:${h}`) };
    const hostPacer = { wait: async (h: string) => void order.push(`host:${h}`) };
    const b = fakeBrowser({});
    const ctx = issue(b, { browserPacer, hostPacer });
    await ctx.browser!.render(`${H}/a`);
    expect(order).toEqual([`browser:${HOST}`, `host:${HOST}`]);

    const slept: number[] = [];
    const real = createHostPacer(10_000, at, async (ms) => void slept.push(ms));
    const paced = issue(fakeBrowser({}), { browserPacer: real });
    await paced.browser!.render(`${H}/a`);
    await paced.browser!.render(`${H}/b`);
    expect(slept).toEqual([10_000]);
  });

  it('refuses a new render once the step is aborted, and fails closed without a provider', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(issue(fakeBrowser({}), { signal: ac.signal }).browser!.render(`${H}/a`)).rejects.toMatchObject({ code: 'timeout' });
    const none = issue(undefined);
    await expect(none.browser!.render(`${H}/a`)).rejects.toMatchObject({ code: 'policy_denied', message: expect.stringMatching(/no browser provider/) });
  });

  it('exposes only render(url): no option for stealth, proxy, user agent, headers or fingerprint', async () => {
    const ctx = issue(fakeBrowser({}));
    expect(Object.keys(ctx.browser!)).toEqual(['render']);
    expect(ctx.browser!.render.length).toBe(1);
    const b = fakeBrowser({});
    await issue(b).browser!.render(`${H}/a`);
    expect(Object.keys(b.calls[0] as object).sort()).toEqual(['deniedHosts', 'navigationHosts', 'signal', 'url']);
    // The kernel types and the real provider name none of these options anywhere in code (comments may explain why).
    const code = (f: string) => ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile(f, readFileSync(join(root, f), 'utf8'), ts.ScriptTarget.Latest));
    const banned = /stealth|proxy|fingerprint|setUserAgent|userAgent\s*\?|extraHTTPHeaders|ignoreHTTPSErrors|bypassCSP|--disable-blink-features|webdriver/i;
    for (const f of ['src/kernel/providers.ts', 'src/kernel/broker.ts', 'src/app/browser/playwright-provider.ts']) {
      expect(code(f).match(banned), f).toBeNull();
    }
  });
});

describe('executor: a challenge fails the step once, with no retry', () => {
  const Req = defineType('Req', 1, z.object({ n: z.number() }).strict());
  const contract = defineContract({ ...spec, id: 'challenged-reader', consumes: Req, produces: T, retry: { max: 2, on: ['network', 'overloaded'], backoffMs: [1, 1] } });
  const agent = defineAgent(contract, async (_req, ctx) => {
    await ctx.browser!.render(`${H}/wall`);
    return [];
  });
  const pHash = policyHash(PRODUCT_POLICY_V1);
  const seed: Envelope = {
    envelopeId: 'seed', stepKey: 'seed-step', index: 0, type: 'Req@1',
    producer: { agentId: 'supervisor', version: '1.0.0', contractHash: 'seed-hash' },
    parents: [], payload: { n: 1 },
    handoff: { guarantees: [], dataClass: 'P0', obligations: [], pins: { policyHash: pHash } },
    guardrails: [], cost: ZERO_COST,
  };

  it('records challenged after one attempt even though the contract retries network errors', async () => {
    const store = Store.open(':memory:');
    const b = fakeBrowser({ [`${H}/wall`]: page('<p>Are you a robot?</p>') });
    const out = await executeStep(
      {
        store, policy: PRODUCT_POLICY_V1, policyHash: pHash,
        providers: { fetch: async () => ({ status: 404, text: async () => '' }), browser: b },
        clock: at, guardrails: builtinGuardrails(),
        contractHashOf: (id) => (id === 'supervisor' ? 'seed-hash' : contractHash(contract)),
        sleep: async () => undefined,
      },
      'r', agent, seed,
    );
    expect(out).toMatchObject({ kind: 'failed', error: 'challenged' });
    expect(store.getStep(out.stepKey)?.attempts).toBe(1);
    expect(b.calls).toHaveLength(1);
  });
});

describe('evals stay offline for the browser too', () => {
  it('ignores a passed browser provider', async () => {
    const b = fakeBrowser({ [`${H}/a`]: page('<h1>x</h1>') });
    const agent = defineAgent(reader, async (_i, ctx) => {
      try {
        await ctx.browser!.render(`${H}/a`);
        return [{ s: 'online' }];
      } catch (e) {
        return [{ s: e instanceof KernelError ? e.code : 'other' }];
      }
    });
    const cases = [{ id: 'c', input: { s: 'x' }, expected: [{ s: 'policy_denied' }] }];
    const report = await runEval({ agent, cases, project: (o) => o, metric: 'exactMatch', min: 1 }, { providers: { fetch: async () => ({ status: 404, text: async () => '' }), browser: b }, policy: PRODUCT_POLICY_V1 });
    expect(b.calls).toHaveLength(0);
    expect(report).toMatchObject({ pass: true });
  });
});
