import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('per-run temp root (tests/support/tmp-global-setup.ts)', () => {
  it('points os.tmpdir() of the worker at the run-private root', () => {
    const root = process.env.JOBPILOT_TEST_TMP_ROOT ?? '';
    expect(root).toMatch(/jobpilot-vitest-\d+-/u);
    expect(realpathSync(tmpdir())).toBe(root);
    expect(realpathSync(mkdtempSync(join(tmpdir(), 'probe-'))).startsWith(root + sep)).toBe(true);
  });
  it('is inherited by spawned child processes', () => {
    const r = spawnSync(process.execPath, ['-e', "process.stdout.write(require('os').tmpdir())"], { encoding: 'utf8' });
    expect(realpathSync(r.stdout)).toBe(process.env.JOBPILOT_TEST_TMP_ROOT);
  });
});
