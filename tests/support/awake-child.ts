/**
 * Child process for the real-suspension test (tests/kernel/awake-adversarial.test.ts): an awake timeout of 1.5 s on
 * the real clocks, with the thresholds scaled down (100 ms tick, 500 ms gap). The parent SIGSTOPs this process (a
 * real suspension: no CPU time passes) and later busy-blocks are run here on demand. Prints one JSON line.
 */
import { AwakeClock, systemTimers } from '../../src/kernel/awake.js';

const mode = process.argv[2] ?? 'stop';
const clock = new AwakeClock(systemTimers, 100, 500);
let wakes = 0;
clock.onWake(() => wakes++);
const t0 = performance.now();
const to = clock.timeout(1_500);
const keep = setInterval(() => {}, 50);
to.signal.addEventListener('abort', () => {
  clearInterval(keep);
  console.log(JSON.stringify({ mode, firedAfterMs: Math.round(performance.now() - t0), wakes }));
});
if (mode === 'block') {
  // one synchronous busy block longer than the timeout: it must time out once it yields, with no wake
  setTimeout(() => {
    const end = performance.now() + 2_000;
    while (performance.now() < end) {
      // busy
    }
  }, 200);
} else {
  console.log(JSON.stringify({ ready: true }));
}
