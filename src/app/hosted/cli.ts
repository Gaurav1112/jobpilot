import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { digestFileName, digestJson, digestRun, runOn, type Digest } from './digest.js';
import { realish } from './home-guard.js';

const repoRoot = join(import.meta.dirname, '../../..');

/** Injectable pieces of the command group (tests pass fakes; the real ones print and run git). */
export interface ShadowDeps {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** The code revision to stamp when --code-sha is not given: `git -C <repo root> rev-parse HEAD`, or null. */
  readonly git: (root: string) => string | null;
}

const realDeps: ShadowDeps = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  git: (root) => {
    const r = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const sha = r.status === 0 ? r.stdout.trim() : '';
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  },
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: string): string => {
  if (!DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw new InvalidArgumentError('expected a date as YYYY-MM-DD');
  return v;
};
const count = (v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 400) throw new InvalidArgumentError('expected a whole number from 1 to 400');
  return n;
};
const envOf = (v: string): 'local' | 'hosted' => {
  if (v !== 'local' && v !== 'hosted') throw new InvalidArgumentError('expected local or hosted');
  return v;
};
const sha = (v: string): string => {
  if (!/^[0-9a-f]{40}$/.test(v)) throw new InvalidArgumentError('expected 40 lowercase hex characters');
  return v;
};
const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const inside = (parent: string, child: string): boolean => {
  const rel = relative(realish(parent), realish(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

interface DigestOpts {
  home: string;
  run?: string;
  from?: string;
  days?: number;
  env: 'local' | 'hosted';
  out: string;
  codeSha?: string;
}

/** `jobpilot shadow …` (H1: `digest`; H2 adds `compare`). */
export function registerShadow(program: Command, deps: ShadowDeps = realDeps): void {
  const shadow = program.command('shadow').description('Shadow-week tools: compare what the hosted runner saw with what this machine saw');
  shadow
    .command('digest')
    .description('Write a read-only digest (keys and codes only) of a run, or of each day in a range, to a folder outside the home')
    .requiredOption('--home <dir>', 'the jobpilot home whose database is read (never written)')
    .option('--run <runId>', 'one run, e.g. daily-2026-11-02 or freelance-2026-11-02-am')
    .option('--from <YYYY-MM-DD>', 'the first IST date of a range', day)
    .option('--days <n>', 'how many days from --from', count)
    .requiredOption('--env <env>', 'local or hosted: where the run happened', envOf)
    .requiredOption('--out <dir>', 'folder for <date>-<pipeline>.json files (must be outside the home)')
    .option('--code-sha <sha>', 'the code revision, 40 hex (default: git rev-parse HEAD of this checkout)', sha)
    .action((o: DigestOpts) => {
      try {
        if ((o.run === undefined) === (o.from === undefined)) throw new Error('give --run <runId>, or --from <date> with --days <n>');
        if (o.run === undefined && o.days === undefined) throw new Error('--from needs --days');
        if (o.run !== undefined && (o.days !== undefined)) throw new Error('--days goes with --from');
        const home = resolve(o.home);
        const out = resolve(o.out);
        if (inside(home, out)) throw new Error(`refusing --out ${out}: it is inside the home ${home}`);
        const db = join(home, 'jobpilot.db');
        const codeSha = o.codeSha ?? deps.git(repoRoot);
        const make = (runId: string): Digest => digestRun(db, runId, { env: o.env, codeSha });
        const written: Digest[] = [];
        const missing: string[] = [];
        if (o.run !== undefined) {
          written.push(make(o.run));
        } else {
          for (let i = 0; i < (o.days as number); i++) {
            const date = addDays(o.from as string, i);
            for (const pipeline of ['daily', 'freelance'] as const) {
              const id = runOn(db, pipeline, date);
              if (id === null) missing.push(`${date} ${pipeline}`);
              else written.push(make(id));
            }
          }
        }
        mkdirSync(out, { recursive: true });
        for (const d of written) {
          const file = digestFileName(d);
          writeFileSync(join(out, file), digestJson(d));
          const postings = Object.values(d.sources).reduce((n, s) => n + s.postings.length, 0);
          const gigs = Object.values(d.gigs).reduce((n, g) => n + g.length, 0);
          deps.out(d.pipeline === 'daily' ? `${file}: ${postings} postings, ${d.eligible.length} eligible` : `${file}: ${gigs} gigs, ${postings} postings`);
        }
        for (const m of missing) deps.out(`no run: ${m}`);
      } catch (err) {
        deps.err(`shadow digest: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
