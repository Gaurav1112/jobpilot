import { describe, expect, it } from 'vitest';
import { AWAKE_TICK_MS, AwakeClock, SLEEP_GAP_MS } from '../../src/kernel/awake.js';
import { manualTimers } from '../../src/kernel/fakes.js';

const TEN_MINUTES = 10 * 60_000;

describe('AwakeClock: time counts only while the process is awake', () => {
  it('the named constants: a tick about every second, a gap over 5 s is a suspension', () => {
    expect(AWAKE_TICK_MS).toBe(1_000);
    expect(SLEEP_GAP_MS).toBe(5_000);
  });

  it('an awake timeout fires once its awake time is used up, with the AbortSignal.timeout reason shape', () => {
    const t = manualTimers();
    const clock = new AwakeClock(t);
    const to = clock.timeout(3_000);
    t.advance(2_999);
    expect(to.signal.aborted).toBe(false);
    t.advance(1);
    expect(to.signal.aborted).toBe(true);
    const reason = to.signal.reason as DOMException;
    expect(reason.name).toBe('TimeoutError');
    expect(reason.message).toBe(new DOMException('The operation was aborted due to timeout', 'TimeoutError').message);
    expect(t.pending()).toBe(0); // fired and released: nothing left scheduled
  });

  it('a 10-minute suspension mid-timeout is not counted', () => {
    const t = manualTimers();
    const clock = new AwakeClock(t);
    const to = clock.timeout(120_000);
    t.advance(60_000);
    t.suspend(TEN_MINUTES);
    t.advance(1_000); // the overdue timers run at wake: the gap is not counted
    expect(to.signal.aborted).toBe(false);
    t.advance(58_000);
    expect(to.signal.aborted).toBe(false);
    t.advance(1_000);
    expect(to.signal.aborted).toBe(true);
  });

  it('gaps up to the sleep threshold count (a slow event loop is still awake time)', () => {
    const t = manualTimers();
    const clock = new AwakeClock(t);
    const to = clock.timeout(10_000);
    t.suspend(SLEEP_GAP_MS); // exactly at the threshold: awake
    t.advance(0);
    t.advance(SLEEP_GAP_MS);
    expect(to.signal.aborted).toBe(true);
  });

  it('clear() stops the timer: nothing stays scheduled, so the event loop is never kept alive', () => {
    const t = manualTimers();
    const clock = new AwakeClock(t);
    const to = clock.timeout(120_000);
    expect(t.pending()).toBeGreaterThan(0);
    to.clear();
    expect(t.pending()).toBe(0);
    t.advance(200_000);
    expect(to.signal.aborted).toBe(false);
  });

  it('a custom reason is used for the abort', () => {
    const t = manualTimers();
    const to = new AwakeClock(t).timeout(10, () => new DOMException('request timeout', 'TimeoutError'));
    t.advance(10);
    expect((to.signal.reason as DOMException).message).toBe('request timeout');
  });

  it('a stopwatch leaves the suspension out; the wake listeners hear of it once', () => {
    const t = manualTimers();
    const clock = new AwakeClock(t);
    const wakes: number[] = [];
    const off = clock.onWake((_at, gap) => wakes.push(gap));
    const sw = clock.stopwatch();
    t.advance(4_000);
    t.suspend(TEN_MINUTES);
    t.advance(1_000);
    expect(sw.elapsed()).toBe(5_000);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toBeGreaterThanOrEqual(TEN_MINUTES);
    sw.stop();
    off();
    expect(t.pending()).toBe(0);
  });

  it('nothing is detected while the clock is not held (an idle gap is not a sleep)', () => {
    const t = manualTimers();
    const clock = new AwakeClock(t);
    const wakes: number[] = [];
    clock.onWake((_at, gap) => wakes.push(gap));
    t.suspend(TEN_MINUTES);
    expect(clock.sleptMs()).toBe(0);
    const release = clock.hold();
    t.advance(2_000);
    expect(clock.sleptMs()).toBe(0);
    expect(wakes).toEqual([]);
    release();
  });
});
