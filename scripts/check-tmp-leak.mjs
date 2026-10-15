/**
 * `node --run check:tmp-leak`: proves a vitest run leaves nothing behind in the os tmpdir it was started with. The run gets
 * a private, empty "outer" TMPDIR (so other programs writing to the machine's /var/folders tmp cannot confuse the count),
 * runs a few files known to create temp dirs, and the check fails unless that outer dir is empty again afterwards, i.e.
 * the per-run root of tests/support/tmp-global-setup.ts was created (exactly once) and removed, and nothing escaped it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAMPLE = ['tests/kernel/files.test.ts', 'tests/kernel/contracts-export.test.ts', 'tests/app/code-hash.test.ts', 'tests/evals/evals.test.ts', 'tests/support/tmp-root.test.ts'];
const sandbox = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'jobpilot-leakcheck-')));
const outer = join(sandbox, 'outer');
const log = join(sandbox, 'roots.txt');
spawnSync('mkdir', [outer]);
const r = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...SAMPLE], { stdio: 'inherit', env: { ...process.env, TMPDIR: outer, JOBPILOT_TEST_TMP_LOG: log } });
const roots = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
const left = readdirSync(outer);
const rootsLeft = roots.filter(existsSync);
rmSync(sandbox, { recursive: true, force: true });
console.log(`tmp-leak: ${roots.length} per-run root(s) created, ${rootsLeft.length} left, ${left.length} entries left in the run's tmpdir`);
if (r.status !== 0) { console.error('tmp-leak: the sample vitest run failed'); process.exit(1); }
if (roots.length !== 1) { console.error('tmp-leak: expected exactly one per-run temp root'); process.exit(1); }
if (left.length > 0 || rootsLeft.length > 0) { console.error(`tmp-leak: LEAKED ${left.slice(0, 10).join(', ')}`); process.exit(1); }
console.log('tmp-leak: ok');
