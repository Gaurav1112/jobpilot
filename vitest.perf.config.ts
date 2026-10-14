import { defineConfig } from 'vitest/config';

/**
 * dashboard-perf: the performance budget gate (`node --run perf`, the last step of `node --run verify`). One file, alone
 * (no other test competes for the CPU while it times routes), on a large synthetic DB it builds in a temp dir.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/perf/**/*.perf.ts'],
    fileParallelism: false,
    // the measured numbers are printed (`perf <route> <what>: <n> (budget <b>)`), passing or not
    silent: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
