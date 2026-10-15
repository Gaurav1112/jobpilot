/**
 * Vitest globalSetup (vitest.config.ts, vitest.perf.config.ts): every run gets its own temp root, removed when the run ends.
 * It creates `<real os tmpdir>/jobpilot-vitest-<pid>-<random>` and points TMPDIR at it BEFORE vitest starts any worker, so
 * `os.tmpdir()` in every worker, and in every CLI/Chromium process a test spawns, lands inside it. Teardown removes it
 * recursively, so a test that forgets its own cleanup cannot leak. JOBPILOT_TEST_TMP_LOG (optional) appends the root path to
 * that file, so tests/support/tmp-leak-check.mjs can prove the dir is gone.
 */
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_TMP_PREFIX = 'jobpilot-vitest-';

export default function setup(): () => void {
  const outer = process.env.TMPDIR;
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `${TEST_TMP_PREFIX}${process.pid}-`)));
  process.env.TMPDIR = root;
  process.env.JOBPILOT_TEST_TMP_ROOT = root;
  if (process.env.JOBPILOT_TEST_TMP_LOG) appendFileSync(process.env.JOBPILOT_TEST_TMP_LOG, `${root}\n`);
  return () => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (outer === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = outer;
  };
}
