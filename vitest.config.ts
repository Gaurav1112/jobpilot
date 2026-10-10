import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The suite runs real Chromium, pdftotext and CLI subprocesses (about 140 s in all); a slow machine must not fail
    // a test on the 5 s default. Run `node --run verify` with a tool timeout above 180 s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
