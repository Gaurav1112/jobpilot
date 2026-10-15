import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineAgent } from '../../src/kernel/agent.js';
import { AwakeClock, systemAwake, systemTimers } from '../../src/kernel/awake.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { contractHash, defineContract } from '../../src/kernel/contract.js';
import { type Envelope, ZERO_COST } from '../../src/kernel/envelope.js';
import { executeStep, type ExecutorDeps } from '../../src/kernel/executor.js';
import { manualTimers } from '../../src/kernel/fakes.js';
import { builtinGuardrails } from '../../src/kernel/guardrails/builtin.js';
import { PRODUCT_POLICY_V1, policyHash } from '../../src/kernel/policy.js';
import { Store } from '../../src/kernel/store/store.js';
import { demoSourceContract } from '../../src/demo/agents.js';

/**
 * The review's adversarial cases for awake time (sleep-safe review I2 and minors): a busy event loop is awake time,
 * only a real suspension is not; nothing lingers; a wall-clock step back changes nothing.
 */
const pHash = policyHash(PRODUCT_POLICY_V1);
const TEN_MINUTES = 10 * 60_000;
const seedEnv = (): Envelope => ({
  envelopeId: 'seed', stepKey: 'seed-step', index: 0, type: 'DemoRequest@1',
  producer: { agentId: 'supervisor', version: '1.0.0', contractHash: 'seed-hash' },
  parents: [], payload: { count: 1, prefix: 'demo' },
  handoff: { guarantees: ['request.count-positive'], dataClass: 'P0', obligations: [], pins: { policyHash: pHash } },
  guardrails: [], cost: ZERO_COST,
});
const mk = (timeoutMs: number, run: () => Promise<unknown[]>) =>
  defineAgent(defineContract({ ...demoSourceContract, id: 'adv', description: 'Answers the adversarial request when done', timeoutMs, obligations: { adds: [], discharges: [] } }), run as never);
const deps = (store: Store, awake: AwakeClock, hash: string): ExecutorDeps => ({
  store, policy: PRODUCT_POLICY_V1, policyHash: pHash, providers: { fetch: async () => ({ status: 404, text: async () => '' }) },
  clock: fixedClock('2026-10-08T00:00:00Z'), guardrails: builtinGuardrails(),
  contractHashOf: (id) => (id === 'supervisor' ? 'seed-hash' : hash), sleep: async () => {}, awake,
});
const spin = (ms: number): void => {
  const e = performance.now() + ms;
  while (performance.now() < e) {
    // a synchronous busy block
  }
};

afterEach(() => vi.restoreAllMocks());

describe('awake time: adversarial cases', () => {
  it('A1 a never-resolving step on the real clocks times out at timeoutMs', async () => {
    const a = mk(1_500, () => new Promise(() => {}));
    const keep = setInterval(() => {}, 1_000);
    const t0 = Date.now();
    const out = await executeStep(deps(Store.open(':memory:'), systemAwake, contractHash(a.contract)), 'r', a, seedEnv());
    clearInterval(keep);
    expect(out).toMatchObject({ kind: 'failed', error: 'timeout' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_450);
    expect(Date.now() - t0).toBeLessThan(2_500);
  }, 10_000);

  it('A3 repeated synchronous blocks longer than the sleep gap are awake time: the step times out, with no wake', async () => {
    const clock = new AwakeClock(systemTimers, 100, 500); // scaled: 100 ms tick, 500 ms gap
    const a = mk(1_500, async () => {
      for (let i = 0; i < 8; i++) {
        spin(600);
        await new Promise((r) => setTimeout(r, 5));
      }
      return [{ id: 'demo-1', text: 'one' }];
    });
    let wakes = 0;
    clock.onWake(() => wakes++);
    const out = await executeStep(deps(Store.open(':memory:'), clock, contractHash(a.contract)), 'r', a, seedEnv());
    expect(out).toMatchObject({ kind: 'failed', error: 'timeout' });
    expect(wakes).toBe(0);
  }, 20_000);

  it('A4 one synchronous block longer than the timeout times the step out once it yields', async () => {
    const clock = new AwakeClock(systemTimers, 100, 500);
    const a = mk(500, async () => {
      spin(900);
      await new Promise((r) => setTimeout(r, 5));
      return [{ id: 'demo-1', text: 'one' }];
    });
    const out = await executeStep(deps(Store.open(':memory:'), clock, contractHash(a.contract)), 'r', a, seedEnv());
    expect(out).toMatchObject({ kind: 'failed', error: 'timeout' });
  }, 10_000);

  it('A5 10,000 timeouts created and cleared leave nothing scheduled and no hold', () => {
    const t = manualTimers();
    const c = new AwakeClock(t);
    for (let i = 0; i < 10_000; i++) {
      const x = c.timeout(120_000);
      t.advance(3);
      x.clear();
    }
    expect(t.pending()).toBe(0);
    expect((c as unknown as { holds: number }).holds).toBe(0);
  });

  it('A6 10,000 real timeouts cleared: the active Timeout resources do not grow', async () => {
    const count = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = count();
    const c = new AwakeClock();
    for (let i = 0; i < 10_000; i++) c.timeout(120_000).clear();
    await new Promise((r) => setImmediate(r));
    expect(count() - before).toBeLessThanOrEqual(0);
  });

  it('A7 the wall clock stepped back an hour mid-timeout changes nothing (the clock is monotonic)', async () => {
    const c = new AwakeClock(systemTimers, 50, 500);
    const x = c.timeout(1_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(x.signal.aborted).toBe(false);
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() - 3_600_000);
    await new Promise((r) => setTimeout(r, 1_400));
    expect(x.signal.aborted).toBe(true);
  });

  it('a busy block (CPU time passes) counts and is no wake; a suspension (no CPU time) does not count and is a wake', () => {
    const t = manualTimers();
    const c = new AwakeClock(t);
    const wakes: number[] = [];
    c.onWake((_at, slept) => wakes.push(slept));
    const busy = c.timeout(120_000);
    t.block(TEN_MINUTES);
    t.advance(0);
    expect(busy.signal.aborted).toBe(true); // it yields once, after the block: timed out
    expect(wakes).toEqual([]);
    const asleep = c.timeout(120_000);
    t.suspend(TEN_MINUTES);
    t.advance(1_000);
    expect(asleep.signal.aborted).toBe(false);
    expect(wakes).toHaveLength(1);
    asleep.clear();
  });

  it('a busy block on a loaded machine (30% of a core) is awake time; a sleep with a few seconds of CPU around it is a sleep', () => {
    const t = manualTimers();
    const c = new AwakeClock(t);
    const wakes: number[] = [];
    c.onWake((_at, slept) => wakes.push(slept));
    const loaded = c.timeout(60_000);
    t.block(TEN_MINUTES, 0.3 * TEN_MINUTES);
    t.advance(0);
    expect(loaded.signal.aborted).toBe(true);
    expect(wakes).toEqual([]);
    const asleep = c.timeout(60_000);
    t.block(TEN_MINUTES, 3_000); // 3 s of work, then asleep
    t.advance(0);
    expect(asleep.signal.aborted).toBe(false);
    expect(wakes).toEqual([TEN_MINUTES - 3_000]);
    asleep.clear();
  });

  it('a real suspension (SIGSTOP, no CPU time) is not counted and is one wake; a real busy block times out with no wake', async () => {
    const child = (mode: string, onReady?: (pid: number) => void) =>
      new Promise<{ firedAfterMs: number; wakes: number }>((resolve, reject) => {
        const p = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, '../support/awake-child.ts'), mode], { stdio: ['ignore', 'pipe', 'inherit'] });
        const kill = setTimeout(() => p.kill('SIGKILL'), 20_000);
        let buf = '';
        p.stdout.on('data', (d: Buffer) => {
          buf += d.toString();
          for (const line of buf.split('\n').slice(0, -1)) {
            const j = JSON.parse(line) as { ready?: boolean; firedAfterMs: number; wakes: number };
            if (j.ready === true) onReady?.(p.pid as number);
            else {
              clearTimeout(kill);
              resolve(j);
            }
          }
          buf = buf.slice(buf.lastIndexOf('\n') + 1);
        });
        p.on('error', reject);
      });
    const stopped = await child('stop', (pid) => {
      setTimeout(() => process.kill(pid, 'SIGSTOP'), 300);
      setTimeout(() => process.kill(pid, 'SIGCONT'), 2_300);
    });
    expect(stopped.wakes).toBe(1);
    expect(stopped.firedAfterMs).toBeGreaterThanOrEqual(1_500 + 1_500); // the 2 s stop (less a tick) was not counted
    const blocked = await child('block');
    expect(blocked.wakes).toBe(0);
    expect(blocked.firedAfterMs).toBeLessThan(2_800); // fired right after the 2 s block yielded
  }, 30_000);
});
