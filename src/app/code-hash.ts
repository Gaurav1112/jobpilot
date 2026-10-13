import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root: `src/app/code-hash.ts` is two levels below it. */
export const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir: string, keep: (rel: string) => boolean, root: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return;
    throw e;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, keep, root, out);
    else if (e.isFile()) {
      const rel = relative(root, abs).split(sep).join('/');
      if (keep(rel)) out.push(rel);
    }
  }
}

/**
 * Review I4: the fingerprint of the code behind every app agent, put into every step key (`SupervisorDeps.codeHash`).
 * sha256 over every `src/**\/*.ts` file and every `assets/fonts/*` file, in sorted path order (each as its path, a NUL,
 * its length and its bytes), first 16 hex characters. Any change to the code or the fonts gives a new hash, so the next
 * run re-runs every step once (spec §2) instead of presenting what old code stored as current.
 */
export function codeHashOf(root: string): string {
  const files: string[] = [];
  walk(join(root, 'src'), (rel) => rel.endsWith('.ts'), root, files);
  walk(join(root, 'assets', 'fonts'), () => true, root, files);
  files.sort();
  const h = createHash('sha256');
  for (const rel of files) {
    const bytes = readFileSync(join(root, rel));
    h.update(`${rel}\u0000${bytes.length}\u0000`);
    h.update(bytes);
  }
  return h.digest('hex').slice(0, 16);
}

let cached: string | undefined;

/**
 * The test seam's variable: under test only, a fixed code hash shared by a test and the CLI subprocesses it spawns.
 * Without it, each subprocess hashes src/** for itself, so a test that spawns two runs saw different hashes (and no
 * replay) whenever another test or an editor wrote src/ between them (the cli-daily flake).
 */
export const CODE_HASH_ENV = 'JOBPILOT_CODE_HASH';

/** Whether this process is a test run: vitest sets VITEST, and NODE_ENV=test is the usual flag. */
const underTest = (env: NodeJS.ProcessEnv): boolean => env['NODE_ENV'] === 'test' || (env['VITEST'] !== undefined && env['VITEST'] !== '');

/**
 * `codeHashOf(CODE_ROOT)`, computed once per process (at the first run or rebuild). TEST SEAM: when the process runs
 * under test (`NODE_ENV=test` or `VITEST` set) and `JOBPILOT_CODE_HASH` is set, that value is the code hash instead.
 * Outside a test the variable is ignored, so a real run always fingerprints the real code.
 */
export function codeHash(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env[CODE_HASH_ENV];
  if (pinned !== undefined && pinned !== '' && underTest(env)) return pinned;
  cached ??= codeHashOf(CODE_ROOT);
  return cached;
}
