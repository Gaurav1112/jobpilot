import { systemClock, type Clock } from '../kernel/clock.js';

const underTest = (env: NodeJS.ProcessEnv): boolean => env['NODE_ENV'] === 'test' || (env['VITEST'] !== undefined && env['VITEST'] !== '');

/**
 * `JOBPILOT_TEST_NOW` (an ISO time) under test only (`VITEST` or `NODE_ENV=test`, the `JOBPILOT_CODE_HASH` rule): a clock
 * that starts at that instant and advances with real time. Anywhere else the variable is ignored: the system clock.
 */
export function cliClock(env: NodeJS.ProcessEnv = process.env): Clock {
  const raw = env['JOBPILOT_TEST_NOW'];
  if (raw === undefined || raw === '' || !underTest(env)) return systemClock;
  const start = Date.parse(raw);
  if (Number.isNaN(start)) throw new Error('JOBPILOT_TEST_NOW is not an ISO time');
  const t0 = Date.now();
  return { now: () => new Date(start + (Date.now() - t0)).toISOString() };
}
