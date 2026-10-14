import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAgent } from '../../../src/kernel/agent.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { defineContract } from '../../../src/kernel/contract.js';
import { builtinGuardrails } from '../../../src/kernel/guardrails/builtin.js';
import { mergePolicy, policyHash, PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import type { FetchLike } from '../../../src/kernel/providers.js';
import { Registry } from '../../../src/kernel/registry.js';
import { Supervisor } from '../../../src/kernel/supervisor.js';
import { defineType } from '../../../src/kernel/types.js';
import { compileWiring, type Pipeline } from '../../../src/kernel/wiring.js';
import { issueContext } from '../../../src/kernel/broker.js';
import { makeCareersLocator, careersLocatorContract, locatorEgressSets } from '../../../src/app/coverage/locator.js';
import { CareersSite, CompanyCandidate } from '../../../src/app/coverage/types.js';
import { AppStore } from '../../../src/app/store/app-store.js';

const RUN = '2026-10-13';
const AT = '2026-10-13T01:00:00.000Z';
const cand = (slug: string): CompanyCandidate => ({
  companyKey: `${slug}.test`,
  name: slug,
  website: `https://www.${slug}.test`,
  careersUrl: `https://boards.greenhouse.io/${slug}`,
  source: 'pick',
  runDate: RUN,
});
const ALL = [cand('alpha'), cand('beta'), cand('gamma')];
const HTML = '<html><body><a href="/product">Product</a></body></html>';

/** Every URL is 404 except `routes`; the greenhouse host answers `ghStatus` to board URLs. */
function net(ghStatus: () => number) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const gh = url.startsWith('https://boards.greenhouse.io/') && !url.endsWith('/robots.txt');
    if (gh) {
      const status = ghStatus();
      return { status, text: async () => (status === 200 ? 'board' : 'slow down') };
    }
    if (/^https:\/\/www\.[a-z]+\.test\/$/.test(url)) return { status: 200, text: async () => HTML };
    return { status: 404, text: async () => 'Not Found' };
  };
  return { fetch, calls };
}

async function run(agent: ReturnType<typeof makeCareersLocator>, c: CompanyCandidate, fetch: FetchLike) {
  const ctx = issueContext({
    contract: careersLocatorContract,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: { fetch },
    clock: fixedClock(AT),
    signal: new AbortController().signal,
    egressSets: locatorEgressSets(ALL),
  });
  return agent.run(c, ctx);
}

describe('run-scoped host state is persisted per run key', () => {
  it('a resumed run (new locator, same runKey and store) still knows the host is disabled', async () => {
    const app = AppStore.on((await import('../../../src/kernel/store/store.js')).Store.open(':memory:'));
    const n = net(() => 429);
    await run(makeCareersLocator({ runKey: 'run-1', store: app }), ALL[0] as CompanyCandidate, n.fetch); // A: 429, disables the host
    expect([...app.coverageHostState('run-1')]).toEqual([['boards.greenhouse.io', 'http-429']]);
    const before = n.calls.length;
    // crash: the first locator is gone
    const resumed = makeCareersLocator({ runKey: 'run-1', store: app });
    await expect(run(resumed, ALL[2] as CompanyCandidate, n.fetch)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringContaining('host-disabled:http-429') });
    expect(n.calls.slice(before).filter((u) => u.includes('boards.greenhouse.io'))).toEqual([]);
  });

  it('a new runKey on the same store requests the host again', async () => {
    const app = AppStore.on((await import('../../../src/kernel/store/store.js')).Store.open(':memory:'));
    const n = net(() => 429);
    await run(makeCareersLocator({ runKey: 'run-1', store: app }), ALL[0] as CompanyCandidate, n.fetch);
    const ok = net(() => 200);
    const out = await run(makeCareersLocator({ runKey: 'run-2', store: app }), ALL[2] as CompanyCandidate, ok.fetch);
    expect(ok.calls.filter((u) => u === 'https://boards.greenhouse.io/gamma')).toHaveLength(1);
    expect(out[0]).toMatchObject({ method: 'listed' });
  });

  it('a robots.txt fetch that throws (timeout) is robots-transient (C1): the step fails, the host is off for an hour only, never cached', async () => {
    const app = AppStore.on((await import('../../../src/kernel/store/store.js')).Store.open(':memory:'));
    const fetch: FetchLike = async (url) => {
      if (url === 'https://boards.greenhouse.io/robots.txt') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      return { status: 404, text: async () => 'Not Found' };
    };
    const agent = makeCareersLocator({ runKey: 'run-1', store: app });
    await expect(run(agent, ALL[0] as CompanyCandidate, fetch)).rejects.toMatchObject({ code: 'timeout', message: expect.stringMatching(/robots-transient/) });
    expect([...app.coverageHostState('run-1')]).toEqual([['boards.greenhouse.io', 'robots-transient']]);
    // a sibling meeting the host within the hour is deferred (re-queued by the coverage run once the hour is over)
    await expect(run(agent, ALL[1] as CompanyCandidate, fetch)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/host-disabled:robots-transient on boards\.greenhouse\.io/) });
  });
});

describe('through the supervisor: a sibling-dependent outcome is not memoised', () => {
  const Seed = CompanyCandidate;
  const pipeline: Pipeline = {
    id: 'loc',
    version: '1.0.0',
    seed: { type: Seed, guarantees: [] },
    teams: [{ id: 'coverage-locator', lead: 'coverage-locator-lead', members: ['careers-locator'], exitGuarantees: [], breaker: { consecutiveFailures: 3 } }],
    edges: [{ type: 'CompanyCandidate@1', to: 'careers-locator' }],
  };
  const build = (app: AppStore, runKey: string, fetch: FetchLike, invoked: string[]) => {
    const registry = new Registry();
    registry.register(makeCareersLocator({ runKey, store: app }));
    const guardrails = builtinGuardrails();
    const policy = mergePolicy(PRODUCT_POLICY_V1, {});
    return new Supervisor({
      store: app.kernel,
      registry,
      compiled: compileWiring(registry, pipeline, guardrails),
      guardrails,
      policy,
      policyHash: policyHash(policy),
      providers: { fetch },
      clock: fixedClock(AT),
      sleep: async () => {},
      egressSets: locatorEgressSets(ALL),
      trackers: [],
      onInvoke: (_agent, stepKey) => invoked.push(stepKey),
    });
  };

  it('the second candidate fails as input_rejected (host-disabled) in run 1 and is re-evaluated, not replayed, in run 2', async () => {
    const { Store } = await import('../../../src/kernel/store/store.js');
    const app = AppStore.on(Store.open(':memory:'));
    const inv1: string[] = [];
    const r1 = await build(app, 'run-1', net(() => 429).fetch, inv1).start('run-1', [ALL[0], ALL[1]]);
    expect(r1.queue).toMatchObject({ done: 1, failed: 1 });
    expect(r1.inputRejected).toBe(1);
    const failed = app.kernel.events('run-1').filter((e) => e.kind === 'step_failed').map((e) => JSON.parse(e.data) as { error: string; detail: string });
    expect(failed).toEqual([expect.objectContaining({ error: 'input_rejected', detail: expect.stringContaining('host-disabled:http-429') })]);

    // Next week the host is fine: the finished candidate is replayed, the refused one runs again and finds its listed URL.
    const inv2: string[] = [];
    const r2 = await build(app, 'run-2', net(() => 200).fetch, inv2).start('run-2', [ALL[0], ALL[1]]);
    expect(inv2).toHaveLength(1);
    expect(r2.replayed).toBe(1);
    expect(r2.queue).toMatchObject({ done: 2, failed: 0 });
  });
});
