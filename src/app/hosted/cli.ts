import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { canonicalJson } from '../../kernel/canonical.js';
import { runEnv } from '../run-env.js';
import { secretsFor, type Secrets } from '../secrets.js';
import { cliClock } from '../test-clock.js';
import { ledgerPath, parseLedger } from './budget.js';
import { loadHostedConfig, parseCodeLock, type HostedConfig } from './config.js';
import { digestFileName, digestJson, digestRun, runOn, type Digest } from './digest.js';
import { verifyGeneration, type VerifyRecord } from './generations.js';
import { dirGitHub } from './github-dir.js';
import { ghCliClient, realGhRunner, type GhRunner, type GitHubClient } from './github.js';
import { realish, refuseDefaultHome } from './home-guard.js';
import { keysNew, packPush, PACK_KEY_SECRET, secretsSync, STATE_KEY_SECRET, storedKey } from './keys.js';
import { seedAndPublish } from './seed.js';
import { spawnPipeline } from './spawn.js';
import { rollbackTo } from './state.js';
import { laptopHolder, pullHome, pushHome, type PublishOutcome } from './sync.js';
import { lintWorkflow } from './workflow-lint.js';
import { runHosted } from './wrapper.js';

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

// ---- `jobpilot hosted …` (Task 15) -----------------------------------------------------------------------------------

/** Used by `seed` and `push` when no `--data` (and so no hosted.yaml) is given: the thresholds only set the size flags. */
const DEFAULT_STATE: HostedConfig['state'] = { keepGenerations: 5, keepWeekly: 2, archiveDays: 30, warnCompressedMB: 100, hardCompressedMB: 200 };
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const repoArg = (v: string): string => {
  if (!REPO.test(v)) throw new InvalidArgumentError('expected <owner>/<name>');
  return v;
};
const underTest = (env: NodeJS.ProcessEnv): boolean => env['NODE_ENV'] === 'test' || (env['VITEST'] !== undefined && env['VITEST'] !== '');
/** The default home the `hosted` commands refuse. `JOBPILOT_HOSTED_DEFAULT_HOME` stands in for it, under test only. */
const defaultHomeOf = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const v = env['JOBPILOT_HOSTED_DEFAULT_HOME'];
  return v !== undefined && v !== '' && underTest(env) ? v : undefined;
};

export interface GitOut {
  readonly status: number;
  readonly stdout: string;
}
export type GitRun = (args: readonly string[], cwd: string) => GitOut;
export const realGit: GitRun = (args, cwd) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 120_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
};

/** `hosted bump`: writes code.lock after `merge-base --is-ancestor <sha> origin/main` (the ref as last fetched). */
export function bumpCode(o: { data: string; sha?: string; root: string; git: GitRun }): string {
  let sha = o.sha;
  if (sha === undefined) {
    const r = o.git(['rev-parse', 'origin/main'], o.root);
    sha = r.stdout.trim();
    if (r.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('cannot resolve origin/main in this checkout; fetch it or pass --sha');
  }
  if (o.git(['merge-base', '--is-ancestor', sha, 'origin/main'], o.root).status !== 0) {
    throw new Error(`${sha.slice(0, 12)} is not an ancestor of origin/main; code.lock not written`);
  }
  mkdirSync(o.data, { recursive: true });
  const tmp = join(o.data, `.code.lock.tmp-${process.pid}`);
  writeFileSync(tmp, `${sha}\n`);
  renameSync(tmp, join(o.data, 'code.lock'));
  return sha;
}

/** `hosted doctor`: PASS / WARN / FAIL lines (names only); `failed` is true when any line is a FAIL. */
export async function doctor(o: { gh: GitHubClient; data: string; root: string; git: GitRun }): Promise<{ lines: string[]; failed: boolean }> {
  const lines: string[] = [];
  let failed = false;
  const check = (ok: boolean, name: string, why: string, level: 'FAIL' | 'WARN' = 'FAIL'): void => {
    if (ok) lines.push(`PASS ${name}`);
    else {
      lines.push(`${level} ${name}: ${why}`);
      if (level === 'FAIL') failed = true;
    }
  };
  let facts: Awaited<ReturnType<GitHubClient['repoFacts']>> | null = null;
  try {
    facts = await o.gh.repoFacts();
  } catch {
    check(false, 'repository', 'could not read the repository settings');
  }
  if (facts !== null) {
    check(facts.private, 'repository is private', 'the data repository must be private');
    check(facts.defaultWorkflowPermissions === 'read', 'default workflow permissions are read', `they are ${facts.defaultWorkflowPermissions ?? 'unknown'}`);
    for (const n of ['STATE_KEY', 'PACK_KEY']) check(facts.secretNames.includes(n), `secret ${n}`, 'not set in the repository');
    for (const n of ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH']) check(facts.secretNames.includes(n), `secret ${n}`, 'not set (the Gmail source stays off)', 'WARN');
  }
  try {
    loadHostedConfig(join(o.data, 'hosted.yaml'));
    check(true, 'hosted.yaml is valid', '');
  } catch (e) {
    check(false, 'hosted.yaml is valid', e instanceof Error ? e.message : 'unreadable');
  }
  try {
    const sha = parseCodeLock(readFileSync(join(o.data, 'code.lock'), 'utf8'));
    check(true, 'code.lock is valid', '');
    check(o.git(['merge-base', '--is-ancestor', sha, 'origin/main'], o.root).status === 0, 'code.lock is an ancestor of origin/main', `${sha.slice(0, 12)} is not (fetch origin, or run: hosted bump)`);
  } catch (e) {
    check(false, 'code.lock is valid', e instanceof Error ? e.message : 'unreadable');
  }
  try {
    const problems = lintWorkflow(readFileSync(join(o.data, '.github', 'workflows', 'daily.yml'), 'utf8'));
    if (problems.length === 0) check(true, 'workflow lint', '');
    else for (const p of problems) check(false, 'workflow lint', p);
  } catch {
    check(false, 'workflow lint', 'cannot read .github/workflows/daily.yml in the data repo (copy examples/hosted/daily.yml)');
  }
  lines.push('REMINDER by hand: Settings > Actions > General: run workflows from fork pull requests is off');
  lines.push('REMINDER by hand: Billing: no payment method on the account, or a $0 spending limit');
  return { lines, failed };
}

const freeBytesOf = (dir: string): number => {
  let cur = resolve(dir);
  while (!existsSync(cur) && resolve(cur, '..') !== cur) cur = resolve(cur, '..');
  const s = statfsSync(cur);
  return Number(s.bavail) * Number(s.bsize);
};
/** The roomier of $RUNNER_TEMP and /mnt (whichever exist). */
function defaultWork(env: NodeJS.ProcessEnv): string {
  const cands = [env['RUNNER_TEMP'], '/mnt'].filter((d): d is string => d !== undefined && d !== '' && existsSync(d));
  const best = cands.sort((a, b) => freeBytesOf(b) - freeBytesOf(a))[0];
  if (best === undefined) throw new Error('no work folder: pass --work <dir>');
  return join(best, 'jobpilot-hosted');
}

const prevMonth = (m: string): string => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};

interface Common {
  repo: string;
  githubDir?: string;
}

/** `jobpilot hosted …`: run, seed, pull, push, status, verify, rollback, bump, doctor, keys, secrets sync, pack push. */
export function registerHosted(program: Command, deps: ShadowDeps = realDeps, gitRun: GitRun = realGit, ghRunner: GhRunner = realGhRunner): void {
  const hosted = program.command('hosted').description('Hosted mode: run the daily pipeline on GitHub Actions against encrypted state in a private data repo');
  const fail = (name: string, err: unknown): void => {
    deps.err(`hosted ${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  };
  const act = (name: string, fn: () => Promise<void> | void): Promise<void> =>
    Promise.resolve()
      .then(fn)
      .catch((e: unknown) => fail(name, e));
  const GH_DIR = ['--github-dir <dir>', 'check-only: use a folder as the GitHub backend (refused on GitHub Actions)'] as const;
  const github = (o: Common, clock = cliClock()): GitHubClient => {
    if (o.githubDir !== undefined) {
      if (process.env['GITHUB_ACTIONS'] === 'true') throw new Error('--github-dir is a check-only flag; it is refused on GitHub Actions');
      return dirGitHub(resolve(o.githubDir), { now: () => clock.now() });
    }
    return ghCliClient(o.repo, ghRunner);
  };
  const stateKey = (secrets: Secrets): Buffer => storedKey(secrets, STATE_KEY_SECRET, 'STATE_KEY');
  const stateOf = (data: string | undefined): HostedConfig['state'] => (data === undefined ? DEFAULT_STATE : loadHostedConfig(join(resolve(data), 'hosted.yaml')).state);
  const codeShaOf = (data: string | undefined): string => {
    if (data !== undefined) return parseCodeLock(readFileSync(join(resolve(data), 'code.lock'), 'utf8'));
    const sha = deps.git(repoRoot);
    if (sha === null) throw new Error('cannot read this checkout\'s revision; pass --data <data repo> (its code.lock)');
    return sha;
  };
  const scratch = (): string => mkdtempSync(join(tmpdir(), 'jp-hosted-'));
  const printPublish = (out: PublishOutcome): void => {
    if (!out.ok) throw new Error(`not published (${out.reason})`);
    deps.out(`generation ${out.head.pointer.gen} published`);
    deps.out(`sha256 ${out.sealed.sha256}`);
    deps.out(`size ${(out.sealed.bytes / 1_048_576).toFixed(1)} MB (${out.sizeLevel})`);
  };

  hosted
    .command('run')
    .description('Run one hosted pipeline job (on GitHub Actions; needs the hosted run environment)')
    .argument('<pipeline>', 'daily or coverage')
    .option('--data <dir>', 'the data repo checkout (default: $GITHUB_WORKSPACE)')
    .option('--work <dir>', 'home and temp files (default: the roomier of $RUNNER_TEMP and /mnt)')
    .option(...GH_DIR)
    .option('--offline-fixtures <dir>', 'check-only: serve sources from fixtures (refused on GitHub Actions)')
    .option('--ancestor-ref <ref>', 'check-only: the ref code.lock must be an ancestor of (refused on GitHub Actions)')
    .option('--no-fetch', 'check-only: do not fetch origin/main (refused on GitHub Actions)')
    .action((pipeline: string, o: { data?: string; work?: string; githubDir?: string; offlineFixtures?: string; ancestorRef?: string; fetch: boolean }) =>
      act('run', async () => {
        if (pipeline !== 'daily' && pipeline !== 'coverage') throw new Error('the pipeline is daily or coverage');
        const env = process.env;
        if (env['GITHUB_ACTIONS'] === 'true') {
          const given = [o.githubDir !== undefined ? '--github-dir' : '', o.offlineFixtures !== undefined ? '--offline-fixtures' : '', o.ancestorRef !== undefined ? '--ancestor-ref' : '', !o.fetch ? '--no-fetch' : ''].filter((f) => f !== '');
          if (given.length > 0) throw new Error(`${given[0] as string} is a check-only flag; it is refused on GitHub Actions`);
        }
        if (runEnv() !== 'hosted') throw new Error('refused: the run environment must be hosted (this command runs on the Actions runner)');
        const repo = env['GITHUB_REPOSITORY'] ?? '';
        if (o.githubDir === undefined && !REPO.test(repo)) throw new Error('GITHUB_REPOSITORY is not set to <owner>/<name>');
        const minutes = Number(env['JOBPILOT_JOB_TIMEOUT_MINUTES']);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('JOBPILOT_JOB_TIMEOUT_MINUTES must be a whole number of minutes');
        const dataDir = o.data ?? env['GITHUB_WORKSPACE'];
        if (dataDir === undefined || dataDir === '') throw new Error('no data folder: pass --data <dir> (or set GITHUB_WORKSPACE)');
        const clock = cliClock();
        const gh = github({ repo, ...(o.githubDir !== undefined ? { githubDir: o.githubDir } : {}) }, clock);
        const summary = env['GITHUB_STEP_SUMMARY'];
        const code = await runHosted(
          {
            pipeline,
            dataDir: resolve(dataDir),
            codeDir: repoRoot,
            workDir: resolve(o.work ?? defaultWork(env)),
            trigger: env['JOBPILOT_TRIGGER'] ?? '',
            runId: env['GITHUB_RUN_ID'] ?? '',
            jobTimeoutMinutes: minutes,
            ancestorRef: o.ancestorRef ?? 'origin/main',
            fetchMain: o.fetch,
            ...(o.offlineFixtures !== undefined ? { offlineFixtures: resolve(o.offlineFixtures) } : {}),
          },
          {
            gh,
            clock,
            env,
            out: deps.out,
            ...(summary !== undefined && summary !== '' ? { summaryFile: summary } : {}),
            git: gitRun,
            spawn: spawnPipeline,
            freeBytes: freeBytesOf,
            cli: [process.execPath, '--import', 'tsx', join(repoRoot, 'src/bin.ts')],
          },
        );
        process.exitCode = code;
      }),
    );

  hosted
    .command('seed')
    .description('Publish a copy of a home (read-only) as generation 1 of a new hosted state')
    .requiredOption('--from <home>', 'the home to copy (never written)')
    .requiredOption('--repo <owner/name>', 'the private data repo', repoArg)
    .option('--work <dir>', 'scratch folder for the copy (default: a new temp folder)')
    .option('--data <dir>', 'the data repo checkout: its hosted.yaml sets the size thresholds and its code.lock the code revision')
    .option(...GH_DIR)
    .action((o: Common & { from: string; work?: string; data?: string }) =>
      act('seed', async () => {
        const clock = cliClock();
        const work = resolve(o.work ?? scratch());
        try {
          refuseDefaultHome(work, 'seed', defaultHomeOf());
          const out = await seedAndPublish({ gh: github(o, clock), key: stateKey(secretsFor(runEnv())), from: resolve(o.from), work, now: clock.now(), codeSha: codeShaOf(o.data), state: stateOf(o.data) });
          printPublish(out);
        } finally {
          if (o.work === undefined) rmSync(work, { recursive: true, force: true }); // our own temp copy of the state
        }
      }),
    );

  hosted
    .command('pull')
    .description('Download and verify the current state into a new folder')
    .requiredOption('--to <home>', 'a new or empty folder (never the default home)')
    .requiredOption('--repo <owner/name>', 'the private data repo', repoArg)
    .option(...GH_DIR)
    .action((o: Common & { to: string }) =>
      act('pull', async () => {
        const tmp = scratch();
        try {
          const r = await pullHome({ gh: github(o), key: stateKey(secretsFor(runEnv())), to: resolve(o.to), tmpDir: tmp, ...(defaultHomeOf() !== undefined ? { defaultHome: defaultHomeOf() as string } : {}) });
          deps.out(`generation ${r.gen} pulled into ${resolve(o.to)}`);
          deps.out(`next: copy your pack into ${join(resolve(o.to), 'pack')} before running serve`);
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      }),
    );

  hosted
    .command('push')
    .description('Publish a home as the next generation (takes the lease; refused while a run holds it)')
    .requiredOption('--from <home>', 'the home to publish (never the default home)')
    .requiredOption('--repo <owner/name>', 'the private data repo', repoArg)
    .option('--data <dir>', 'the data repo checkout: its hosted.yaml sets the size thresholds and its code.lock the code revision')
    .option(...GH_DIR)
    .action((o: Common & { from: string; data?: string }) =>
      act('push', async () => {
        const clock = cliClock();
        const tmp = scratch();
        try {
          const out = await pushHome({ gh: github(o, clock), key: stateKey(secretsFor(runEnv())), from: resolve(o.from), tmpDir: tmp, now: clock.now(), codeSha: codeShaOf(o.data), state: stateOf(o.data), holder: laptopHolder(), ...(defaultHomeOf() !== undefined ? { defaultHome: defaultHomeOf() as string } : {}) });
          printPublish(out);
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      }),
    );

  hosted
    .command('status')
    .description('Show the state generation, last runs, lease, budget level, size flag and the last ledger lines')
    .requiredOption('--repo <owner/name>', 'the private data repo', repoArg)
    .option(...GH_DIR)
    .action((o: Common) =>
      act('status', async () => {
        const clock = cliClock();
        const gh = github(o, clock);
        const head = await gh.readState();
        if (head === null) throw new Error('there is no state branch yet (run hosted seed)');
        const p = head.pointer;
        const ld = p.current?.lastDone;
        deps.out(`gen ${p.gen}${p.current !== null ? ` (${p.current.tag}, ${(p.current.bytes / 1_048_576).toFixed(1)} MB)` : ''}`);
        deps.out(`last done: daily ${ld?.daily ?? 'never'}, freelance ${ld?.freelance ?? 'never'}, coverage ${ld?.coverage ?? 'never'}`);
        deps.out(`lease: ${p.lease === null ? 'none' : `${p.lease.holder} until ${p.lease.until}`}`);
        deps.out(`budget: ${p.budget === null ? 'none yet' : `${p.budget.month} level ${p.budget.level}`}`);
        deps.out(`size flag: ${p.sizeHard ? 'hard limit' : 'ok'}`);
        const month = p.budget?.month ?? clock.now().slice(0, 7);
        const lines: string[] = [];
        for (const m of [prevMonth(month), month]) {
          const text = await gh.readStateFile(ledgerPath(m));
          if (text === null) continue;
          try {
            for (const e of parseLedger(text)) lines.push(`${e.startedAt} ${e.workflow} ${e.outcome} ${e.billedMinutes} min run ${e.runId}`);
          } catch {
            lines.push(`(ledger ${m} is unreadable)`);
          }
        }
        deps.out('ledger (last 5):');
        for (const l of lines.slice(-5)) deps.out(`  ${l}`);
        if (lines.length === 0) deps.out('  (empty)');
      }),
    );

  hosted
    .command('verify')
    .description('Download, decrypt and check one or every retained generation')
    .requiredOption('--repo <owner/name>', 'the private data repo', repoArg)
    .option('--gen <n>', 'one generation', (v: string) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('expected a generation number');
      return n;
    })
    .option('--all', 'every generation in the pointer history')
    .option('--json', 'print the records as JSON')
    .option('--out <dir>', 'write verify-g<NNNNNN>.json per generation here')
    .option(...GH_DIR)
    .action((o: Common & { gen?: number; all?: boolean; json?: boolean; out?: string }) =>
      act('verify', async () => {
        if ((o.gen === undefined) === (o.all !== true)) throw new Error('give --gen <n> or --all');
        const clock = cliClock();
        const gh = github(o, clock);
        const head = await gh.readState();
        if (head === null || head.pointer.gen === 0) throw new Error('there is no generation yet');
        const recs = o.all === true ? head.pointer.history : head.pointer.history.filter((r) => r.gen === o.gen);
        if (recs.length === 0) throw new Error(o.all === true ? 'the history is empty' : `generation ${o.gen} is not in the history`);
        const key = stateKey(secretsFor(runEnv()));
        const tmp = scratch();
        const results: VerifyRecord[] = [];
        try {
          for (const r of recs) results.push(await verifyGeneration(gh, r, key, tmp, clock.now()));
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
        if (o.out !== undefined) {
          mkdirSync(resolve(o.out), { recursive: true });
          for (const r of results) writeFileSync(join(resolve(o.out), `verify-g${String(r.gen).padStart(6, '0')}.json`), `${canonicalJson(r)}\n`);
        }
        if (o.json === true) deps.out(canonicalJson(results));
        else for (const r of results) deps.out(`gen ${r.gen}: ${r.ok ? 'ok' : `FAIL (${r.code ?? 'unknown'})`}`);
        if (results.some((r) => !r.ok)) process.exitCode = 1;
      }),
    );

  hosted
    .command('rollback')
    .description('Point the state at an earlier retained generation (refused while a run holds the lease)')
    .requiredOption('--repo <owner/name>', 'the private data repo', repoArg)
    .requiredOption('--to <n>', 'the generation to return to', (v: string) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('expected a generation number');
      return n;
    })
    .option('--with-code <sha>', 'the code revision that wrote that generation (needed below the current schema)', sha)
    .option(...GH_DIR)
    .action((o: Common & { to: number; withCode?: string }) =>
      act('rollback', async () => {
        const clock = cliClock();
        const gh = github(o, clock);
        const head = await gh.readState();
        const target = head?.pointer.history.find((h) => h.gen === o.to);
        if (target !== undefined && (await gh.release(target.tag)) === null) throw new Error(`generation ${o.to} is in the history but its release is gone`);
        const r = await rollbackTo(gh, o.to, clock.now(), o.withCode !== undefined ? { withCode: o.withCode } : {});
        deps.out(`rolled back: the state is now generation ${r.pointer.gen}`);
        if (o.withCode !== undefined) deps.out(`next: jobpilot hosted bump --data <data repo checkout> --sha ${o.withCode}`);
      }),
    );

  hosted
    .command('bump')
    .description('Write code.lock: the code revision hosted runs use (must be an ancestor of origin/main)')
    .requiredOption('--data <dir>', 'the data repo checkout')
    .option('--sha <sha>', 'the revision, 40 hex (default: origin/main of this checkout)', sha)
    .action((o: { data: string; sha?: string }) =>
      act('bump', () => {
        const s = bumpCode({ data: resolve(o.data), ...(o.sha !== undefined ? { sha: o.sha } : {}), root: repoRoot, git: gitRun });
        deps.out(`code.lock = ${s}`);
        deps.out('commit and push the data repo yourself');
      }),
    );

  hosted
    .command('doctor')
    .description('Check the data repo setup: PASS / WARN / FAIL lines, exit 1 on a FAIL')
    .requiredOption('--repo <owner/name>', 'the private data repo', repoArg)
    .requiredOption('--data <dir>', 'the data repo checkout')
    .option(...GH_DIR)
    .action((o: Common & { data: string }) =>
      act('doctor', async () => {
        const r = await doctor({ gh: github(o), data: resolve(o.data), root: repoRoot, git: gitRun });
        for (const l of r.lines) deps.out(l);
        if (r.failed) process.exitCode = 1;
      }),
    );

  const keys = hosted.command('keys').description('Hosted keys');
  keys
    .command('new')
    .description('Create the state and pack keys in the keychain and print the recovery sheet once')
    .action(() => act('keys new', () => keysNew(secretsFor(runEnv()), deps.out)));

  const secrets = hosted.command('secrets').description('Actions secrets');
  secrets
    .command('sync')
    .description('Copy the keys and Gmail values from the keychain into the repo\'s Actions secrets (values go to gh on stdin)')
    .requiredOption('--repo <owner/name>', 'the private data repo', repoArg)
    .action((o: { repo: string }) => act('secrets sync', () => secretsSync(secretsFor(runEnv()), o.repo, ghRunner, deps.out)));

  const pack = hosted.command('pack').description('The encrypted pack in the data repo');
  pack
    .command('push')
    .description('Validate a pack, seal it with the pack key and write <data>/pack/pack.jpst')
    .requiredOption('--pack <dir>', 'the pack folder (read only)')
    .requiredOption('--data <dir>', 'the data repo checkout')
    .action((o: { pack: string; data: string }) =>
      act('pack push', async () => {
        const key = storedKey(secretsFor(runEnv()), PACK_KEY_SECRET, 'PACK_KEY');
        const r = await packPush({ pack: resolve(o.pack), data: resolve(o.data), key, now: cliClock().now() });
        deps.out(`sealed ${r.file}`);
        deps.out(`key id ${r.keyId}`);
        deps.out(`sha256 ${r.sha256}`);
        deps.out(`size ${r.bytes} bytes`);
        deps.out('commit and push the data repo yourself');
      }),
    );
}
