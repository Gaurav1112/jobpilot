/**
 * Awake time: deadlines that a sleeping Mac cannot trip.
 *
 * Node's timers (and `AbortSignal.timeout`) count wall time, so time spent asleep counts too. With the lid closed on
 * battery, macOS suspends the process; during a DarkWake (one or two seconds awake) every timer that fell due while
 * asleep fires, and a step that was frozen mid-way fails with `timeout` though it ran for milliseconds (2026-10-14:
 * the renderer, three times). An `AwakeClock` reads a monotonic clock at least every AWAKE_TICK_MS while someone
 * holds it. A gap between two reads up to SLEEP_GAP_MS is awake time. A larger gap is either a suspension or a
 * synchronous block of the event loop; the process's CPU time tells them apart:
 * - Node's monotonic clock (`process.hrtime`, `performance.now`) is libuv's `uv_hrtime`, which on macOS is
 *   `mach_continuous_time`: it advances during sleep, like the wall clock (checked 2026-10-15 on Node 24.15 / libuv
 *   1.51 by disassembly), so it cannot tell sleep from a block;
 * - CPU time (`process.cpuUsage`) does not advance while the process is suspended, and advances about as fast as the
 *   clock during a busy block (measured: a 1.5 s busy loop used 1.5 s of CPU, a 2 s SIGSTOP 0 ms).
 * So a long gap in which the process used under SUSPENDED_CPU_FRACTION of it in CPU time was a suspension: the gap less
 * that CPU time was asleep, and a wake is reported when that is itself over SLEEP_GAP_MS. A long gap with more CPU
 * time was a synchronous block: all awake time. A busy block longer than a timeout therefore still times the step out once it
 * yields, and opens no wake window. Known limit: a block that waits without using CPU (a synchronous disk wait, a
 * machine swapping) for over SLEEP_GAP_MS reads as sleep. The clock is monotonic, so a wall-clock step (NTP) has no
 * effect.
 */

/** How often a held clock reads the wall clock. */
export const AWAKE_TICK_MS = 1_000;
/** A gap between two reads larger than this was a suspension (sleep), not awake time, unless CPU time says otherwise. */
export const SLEEP_GAP_MS = 5_000;
/**
 * A long gap in which the process used less CPU time than this fraction of it was a suspension; more, and it was a
 * synchronous block (awake time). A busy block on a loaded machine still gets a real share of a core; a suspended
 * process gets none (a 2 s SIGSTOP: 0 ms).
 */
export const SUSPENDED_CPU_FRACTION = 0.1;

/** The clocks and timers an `AwakeClock` runs on; injectable for tests (`manualTimers`). */
export interface AwakeTimers {
  /** A monotonic clock in ms (it may advance during sleep; it never steps back). */
  now(): number;
  /** The process's CPU time in ms (user plus system); it does not advance while the process is suspended. */
  cpuMs(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real time. Every timer is unref'd: an awake clock never keeps the process alive. */
export const systemTimers: AwakeTimers = {
  now: () => performance.now(),
  cpuMs: () => {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1000;
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** The reason `AbortSignal.timeout` aborts with: callers classify a `TimeoutError` as `timeout`. */
export const timeoutReason = (): DOMException => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

export interface AwakeTimeout {
  readonly signal: AbortSignal;
  /** Stops the timer (idempotent); the signal is left as it is. */
  clear(): void;
}

export interface AwakeStopwatch {
  /** Awake ms since the stopwatch started. */
  elapsed(): number;
  /** Stops it (idempotent). */
  stop(): void;
}

export type WakeListener = (atMs: number, sleptMs: number) => void;

export class AwakeClock {
  private last: number;
  private lastCpu: number;
  private slept = 0;
  private holds = 0;
  private ticker: unknown;
  private readonly listeners = new Set<WakeListener>();

  constructor(
    private readonly timers: AwakeTimers = systemTimers,
    readonly tickMs: number = AWAKE_TICK_MS,
    readonly sleepGapMs: number = SLEEP_GAP_MS,
  ) {
    this.last = timers.now();
    this.lastCpu = timers.cpuMs();
  }

  /** The monotonic clock, in ms. */
  now(): number {
    return this.timers.now();
  }

  /**
   * Reads the clocks and returns the total suspended ms detected so far. While the clock is held, a gap since the
   * previous read larger than `sleepGapMs` with under SUSPENDED_CPU_FRACTION of it in CPU time is a suspension: the gap
   * less that CPU time, when over `sleepGapMs`, is added, and the wake listeners hear of it. While it is not held, nothing is detected (an idle
   * gap is not a sleep).
   */
  sleptMs(): number {
    const t = this.timers.now();
    const cpu = this.timers.cpuMs();
    const gap = t - this.last;
    const cpuGap = Math.max(0, cpu - this.lastCpu);
    this.last = Math.max(this.last, t);
    this.lastCpu = Math.max(this.lastCpu, cpu);
    if (this.holds > 0 && gap > this.sleepGapMs && cpuGap < gap * SUSPENDED_CPU_FRACTION) {
      const asleep = gap - cpuGap;
      if (asleep > this.sleepGapMs) {
        this.slept += asleep;
        for (const f of [...this.listeners]) f(t, asleep);
      }
    }
    return this.slept;
  }

  /** Keeps the clock reading every `tickMs` until the returned release is called (ref-counted, idempotent release). */
  hold(): () => void {
    if (this.holds++ === 0) {
      this.last = this.timers.now();
      this.lastCpu = this.timers.cpuMs();
      this.schedule();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.holds === 0 && this.ticker !== undefined) {
        this.timers.clearTimeout(this.ticker);
        this.ticker = undefined;
      }
    };
  }

  private schedule(): void {
    this.ticker = this.timers.setTimeout(() => {
      this.ticker = undefined;
      if (this.holds === 0) return;
      this.sleptMs();
      this.schedule();
    }, this.tickMs);
  }

  /** Called with the monotonic time (`now`) of each detected wake and the ms slept before it; returns the unsubscribe. */
  onWake(f: WakeListener): () => void {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  }

  /** Awake ms from now on, until stopped. */
  stopwatch(): AwakeStopwatch {
    const release = this.hold();
    const start = this.timers.now();
    const slept0 = this.sleptMs();
    let stopped: number | undefined;
    const elapsed = (): number => {
      if (stopped !== undefined) return stopped;
      const slept = this.sleptMs();
      return Math.max(0, this.timers.now() - start - (slept - slept0));
    };
    return {
      elapsed,
      stop: () => {
        if (stopped !== undefined) return;
        stopped = elapsed();
        release();
      },
    };
  }

  /**
   * `AbortSignal.timeout(ms)` on awake time: the signal aborts with `reason()` (by default the `TimeoutError`
   * `AbortSignal.timeout` uses) once `ms` of awake time have passed. Checked at least every `tickMs`.
   */
  timeout(ms: number, reason: () => unknown = timeoutReason): AwakeTimeout {
    const c = new AbortController();
    const sw = this.stopwatch();
    let timer: unknown;
    let done = false;
    const clear = (): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) this.timers.clearTimeout(timer);
      timer = undefined;
      sw.stop();
    };
    const check = (): void => {
      timer = undefined;
      if (done) return;
      const used = sw.elapsed();
      if (used >= ms) {
        clear();
        c.abort(reason());
        return;
      }
      timer = this.timers.setTimeout(check, Math.min(this.tickMs, ms - used));
    };
    timer = this.timers.setTimeout(check, Math.min(this.tickMs, Math.max(0, ms)));
    return { signal: c.signal, clear };
  }
}

/** The process's awake clock: one ticker, held only while some deadline or run needs it. */
export const systemAwake = new AwakeClock();
