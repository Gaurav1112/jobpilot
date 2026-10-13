import { defineConfig } from 'vitest/config';

/**
 * The test files that drive a real Chromium. Under the load of the rest of the suite their shortened settle timings
 * flaked (final review), so they run in their own project, after every other file has finished (`groupOrder`), one
 * file at a time (`fileParallelism: false`).
 */
const REAL_BROWSER = ['tests/app/careers.test.ts', 'tests/app/web-browser.test.ts', 'tests/app/web-freelance-browser.test.ts'];

export default defineConfig({
  test: {
    environment: 'node',
    // The suite runs real Chromium, pdftotext and CLI subprocesses (about 140 s in all); a slow machine must not fail
    // a test on the 5 s default. Run `node --run verify` with a tool timeout above 180 s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/**/*.test.ts'], exclude: REAL_BROWSER, sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: 'real-browser', include: REAL_BROWSER, fileParallelism: false, sequence: { groupOrder: 1 } } },
    ],
  },
});
