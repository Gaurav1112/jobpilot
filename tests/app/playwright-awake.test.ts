import { describe, expect, it } from 'vitest';
import { budgetLeft, PlaywrightBrowserProvider } from '../../src/app/browser/playwright-provider.js';
import { AwakeClock } from '../../src/kernel/awake.js';
import { manualTimers } from '../../src/kernel/fakes.js';

/**
 * The browser's render budgets (navigation, settle, expansion) count awake time: a render frozen by a sleeping Mac
 * keeps the budget it had. No Chromium is launched here: the provider launches on the first render only.
 */
const TEN_MINUTES = 10 * 60_000;

describe('PlaywrightBrowserProvider budgets count awake time', () => {
  it('the navigation budget left after a 10-minute sleep is what it was before it', () => {
    const t = manualTimers();
    const sw = new AwakeClock(t).stopwatch();
    t.advance(5_000);
    expect(budgetLeft(sw, 20_000)).toBe(15_000);
    t.suspend(TEN_MINUTES);
    t.advance(1_000);
    expect(budgetLeft(sw, 20_000)).toBe(14_000);
    t.advance(20_000);
    expect(budgetLeft(sw, 20_000)).toBe(1); // used up: Playwright's smallest timeout
    sw.stop();
  });

  it('a page settling across a 10-minute sleep is not cut off at the settle cap', async () => {
    const t = manualTimers();
    const provider = new PlaywrightBrowserProvider({ awake: new AwakeClock(t), timing: { pollMs: 1, stableSamples: 3, minSettleMs: 5_000, settleCapMs: 45_000 } });
    let i = 0;
    // each sample is a second of awake time; the second one sleeps 10 minutes first; the page grows, then is stable
    const sample = async (): Promise<number> => {
      if (i === 1) t.suspend(TEN_MINUTES);
      t.advance(1_000);
      i++;
      return Math.min(i, 5);
    };
    const settle = (provider as unknown as { settle(min: number, cap: number, state: { inflight: Set<unknown> }, s: () => Promise<number>): Promise<boolean> }).settle.bind(provider);
    await expect(settle(5_000, 45_000, { inflight: new Set() }, sample)).resolves.toBe(true);
    expect(t.pending()).toBe(0); // its stopwatch was stopped
  });

  it('a page still changing after the cap of awake time is still not settled', async () => {
    const t = manualTimers();
    const provider = new PlaywrightBrowserProvider({ awake: new AwakeClock(t), timing: { pollMs: 1, stableSamples: 3 } });
    let i = 0;
    const sample = async (): Promise<number> => {
      t.advance(1_000);
      return ++i;
    };
    const settle = (provider as unknown as { settle(min: number, cap: number, state: { inflight: Set<unknown> }, s: () => Promise<number>): Promise<boolean> }).settle.bind(provider);
    await expect(settle(5_000, 10_000, { inflight: new Set() }, sample)).resolves.toBe(false);
    expect(i).toBe(10);
  });
});
