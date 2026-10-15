import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../../kernel/clock.js';
import { loadRunPack } from '../kernel.js';
import { istDate, istMonth } from '../run.js';
import type { RunSummaryJson } from '../run-summary.js';
import { storeCompactCommand } from '../store/compact-command.js';
import { envSecrets } from '../secrets.js';
import { raiseAlert, type ALERTS } from './alerts.js';
import { billedMinutes, cycleMonth, govern, ledgerPath, LedgerEntry, levelRose, parseLedger, type Decision } from './budget.js';
import { checkState, openInto, StateError } from './bundle.js';
import { loadHostedConfig, parseCodeLock, type HostedConfig } from './config.js';
import { digestFileName, digestJson, digestRun, runOn, type Digest } from './digest.js';
import { fetchGeneration, prunePlan } from './generations.js';
import type { GitHubClient, StateHead } from './github.js';
import { refuseDefaultHome } from './home-guard.js';
import { auditLog, type AuditResult } from './log-audit.js';
import { codesOf, createGateway, PROBLEM_CODES, type FAILURES, type REFUSALS, type TemplateId } from './log-gateway.js';
import { maskCommands, maskValues } from './mask.js';
import { decodeKey, JpstError } from './jpst.js';
import type { LastDone } from './pointer.js';
import { acquireLease, appendStateFiles, releaseLease, StateBusy, StateConflict, type Holder } from './state.js';
import { GMAIL_ENV_NAMES, childEnv, type spawnPipeline, type PipelineRun } from './spawn.js';
import { publishHome } from './sync.js';

export type WrapperStep =
  | 'config' | 'cheap-check' | 'lease' | 'download' | 'integrity' | 'disk' | 'pack' | 'audit' | 'daily' | 'freelance'
  | 'compact' | 'digest' | 'bundle' | 'upload' | 'commit' | 'prune' | 'ledger';

export interface HostedRunOptions {
  readonly pipeline: 'daily' | 'coverage';
  /** Data repo checkout: hosted.yaml, code.lock, pack/pack.jpst. */
  readonly dataDir: string;
  /** The public code checkout. */
  readonly codeDir: string;
  /** Home and temp files (the roomier of $RUNNER_TEMP and /mnt). */
  readonly workDir: string;
  /** Validated: primary | catch-up | dispatch. */
  readonly trigger: string;
  readonly runId: string;
  readonly jobTimeoutMinutes: number;
  /** 'origin/main'; check-only override for dry runs. */
  readonly ancestorRef: string;
  /** True; false only in dry runs. */
  readonly fetchMain: boolean;
  /** Check-only. */
  readonly offlineFixtures?: string;
}

export interface HostedDeps {
  readonly gh: GitHubClient;
  readonly clock: Clock;
  readonly env: NodeJS.ProcessEnv;
  readonly out: (line: string) => void;
  readonly summaryFile?: string;
  readonly git: (args: readonly string[], cwd: string) => { readonly status: number; readonly stdout: string };
  readonly spawn: typeof spawnPipeline;
  readonly freeBytes: (dir: string) => number;
  /** [process.execPath, '--import', 'tsx', '<codeDir>/src/bin.ts'] */
  readonly cli: readonly string[];
  readonly fault?: (step: WrapperStep) => void;
}

type Refusal = (typeof REFUSALS)[number];
type Failure = (typeof FAILURES)[number];
type Outcome = LedgerEntry['outcome'];

const MB = 1_048_576;
const GIB = 1_073_741_824;
const MINUTE = 60_000;
const IST_MS = 19_800_000;
const DEADLINE_MARGIN_MINUTES = 15;
const GRACE_SECONDS = 60;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TRIGGERS = ['primary', 'catch-up', 'dispatch'];
const COMPACT_ARCHIVE = 'archive';

class Refused extends Error {
  constructor(readonly reason: Refusal) {
    super(`refused: ${reason}`);
  }
}
class StepFailure extends Error {
  constructor(readonly code: Failure, message?: string) {
    super(message ?? `failed: ${code}`);
  }
}
/** A pipeline child was still running after the grace period and was SIGKILLed. */
class Killed extends Error {}
/** An orderly early end (nothing owed, busy, ...): the outcome and exit code are already set. */
class Finished extends Error {}

const failureCode = (e: unknown, step: WrapperStep): Failure => {
  if (e instanceof StepFailure) return e.code;
  if (e instanceof StateConflict) return 'cas';
  if (e instanceof StateError) return e.code === 'sha256' || e.code === 'size' || e.code === 'quick-check' || e.code === 'audit' ? e.code : 'internal';
  if (e instanceof JpstError) return e.code === 'wrong-key' ? 'wrong-key' : 'decrypt';
  return step === 'download' ? 'download' : 'internal';
};

const istClock = (iso: string): string => new Date(Date.parse(iso) + IST_MS).toISOString().slice(11, 16);
/** "D Mon" of the next cycle's first day (the cycle labelled `month` = YYYY-MM ends before it). */
const nextCycleDm = (month: string, startDay: number): string => `${startDay} ${MONTHS[Number(month.slice(5, 7)) % 12]}`;
const previousMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};

function readSummary(file: string): RunSummaryJson | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<RunSummaryJson>;
    if (j.v !== 1 || (j.pipeline !== 'daily' && j.pipeline !== 'freelance') || (j.status !== 'completed' && j.status !== 'paused')) return null;
    if (typeof j.items !== 'number' || typeof j.problems !== 'object' || j.problems === null) return null;
    return j as RunSummaryJson;
  } catch {
    return null;
  }
}

interface PipelineResult {
  readonly run: PipelineRun;
  readonly summary: RunSummaryJson | null;
  readonly line: string;
}

class HostedRun {
  private readonly gw: ReturnType<typeof createGateway>;
  private readonly home: string;
  private readonly tmp: string;
  private step: WrapperStep = 'config';
  private readonly processStart: string;
  private jobStart: string;
  private cfg: HostedConfig | undefined;
  private lock = '';
  private stateKey: Buffer | undefined;
  private packKey: Buffer | undefined;
  private head: StateHead | undefined;
  private holder: Holder | undefined;
  private leaseHeld = false;
  private decision: Decision | undefined;
  private month = '';
  private maskList: string[] = [];
  private today = '';
  private outcome: Outcome = 'failed';
  private exit: 0 | 1 = 1;
  private committedGen: number | undefined;
  private committedAt: string | undefined;
  private readonly pipelines: { daily: number | null; freelance: number | null } = { daily: null, freelance: null };
  private audit: { runId: string; hits: number; nonTemplateLines: number } | undefined;
  private daily: PipelineResult | undefined;
  private freelance: PipelineResult | undefined;
  private readonly summaries = new Map<string, number>();
  private newSegments: string[] = [];
  private killedLine = '';
  /** The release tags this run created (the only ones a failure may delete). */
  private readonly created: string[] = [];

  constructor(private readonly o: HostedRunOptions, private readonly d: HostedDeps) {
    this.gw = createGateway({ out: d.out, ...(d.summaryFile !== undefined ? { summaryFile: d.summaryFile } : {}) });
    this.home = join(o.workDir, 'home');
    this.tmp = join(o.workDir, 'tmp');
    this.processStart = d.clock.now();
    this.jobStart = this.processStart;
  }

  private at(step: WrapperStep): void {
    this.step = step;
    this.d.fault?.(step);
  }
  private now(): string {
    return this.d.clock.now();
  }
  private emit(id: TemplateId, values: Readonly<Record<string, string | number>>): string {
    return this.gw.emit(id, values);
  }
  /** Detailed text goes to the home log (encrypted with the state), never to stdout. */
  private log(text: string): void {
    try {
      if (!existsSync(this.home)) return;
      mkdirSync(join(this.home, 'logs'), { recursive: true, mode: 0o700 });
      appendFileSync(join(this.home, 'logs', `hosted-${this.o.runId}.log`), `${this.now()} ${text}\n`, { mode: 0o600 });
    } catch {
      // the log is a convenience
    }
  }
  private async alert(kind: keyof typeof ALERTS, lines: readonly string[]): Promise<void> {
    try {
      await raiseAlert(this.d.gh, kind, lines);
    } catch (e) {
      this.log(`alert ${kind} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  private finish(outcome: Outcome, exit: 0 | 1): never {
    this.outcome = outcome;
    this.exit = exit;
    throw new Finished();
  }
  private gen(): number {
    return this.head?.pointer.gen ?? 0;
  }

  async run(): Promise<0 | 1> {
    try {
      this.config();
      await this.cheapCheck();
      await this.takeLease();
      await this.pullState();
      await this.openPack();
      await this.auditPrevious();
      await this.runDaily();
      await this.runFreelance();
      await this.gaveUp();
      await this.compact();
      const files = this.digests();
      await this.publish(files);
      await this.prune();
      this.outcome = 'committed';
      this.exit = 0;
    } catch (e) {
      if (!(e instanceof Finished)) await this.fail(e);
    } finally {
      await this.writeLedger();
    }
    return this.exit;
  }

  /** The refusal / failure handler: every path leaves the pointer at G with our lease released. */
  private async fail(e: unknown): Promise<void> {
    this.exit = 1;
    if (e instanceof Refused) {
      this.outcome = 'refused';
      const l = this.emit('refused', { pipeline: this.o.pipeline, reason: e.reason });
      await this.alert('refused', [l]);
      return;
    }
    const code = failureCode(e, this.step);
    this.log(`step ${this.step} failed (${code}): ${e instanceof Error ? e.message : String(e)}`);
    if (this.leaseHeld && this.holder !== undefined) {
      await this.cleanupUnpublished();
      await releaseLease(this.d.gh, this.holder).catch(() => undefined);
      this.leaseHeld = false;
    }
    this.outcome = 'failed';
    if (e instanceof Killed) {
      this.outcome = 'killed';
      await this.alert('killed', [this.killedLine]);
      return;
    }
    const l = this.head === undefined ? this.emit('error', { reason: code }) : this.emit('notCommitted', { reason: code, gen: this.gen() });
    await this.alert(code === 'cas' ? 'conflict' : 'state-failure', [l]);
  }

  /**
   * After an unexpected exception in the publish step: the releases THIS run created go, unless the pointer names one
   * (the commit landed). A release this run did not create (another writer's, an abandoned line's) is never touched.
   */
  private async cleanupUnpublished(): Promise<void> {
    if (this.head === undefined || this.step === 'ledger' || this.created.length === 0) return;
    try {
      const now = await this.d.gh.readState();
      if (now === null) return;
      const named = new Set([...now.pointer.history, ...(now.pointer.current ? [now.pointer.current] : [])].map((h) => h.tag));
      const committed = this.created.some((t) => named.has(t));
      if (committed) return;
      for (const t of this.created) await this.d.gh.deleteRelease(t);
    } catch (e) {
      this.log(`cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- step 0: config -------------------------------------------------------------------------------------------
  private config(): void {
    this.at('config');
    const { o, d } = this;
    if (!/^\d{1,20}$/.test(o.runId)) throw new Refused('config');
    let cfg: HostedConfig;
    try {
      cfg = loadHostedConfig(join(o.dataDir, 'hosted.yaml'));
      this.lock = parseCodeLock(readFileSync(join(o.dataDir, 'code.lock'), 'utf8'));
    } catch {
      throw new Refused('config');
    }
    this.cfg = cfg;
    this.today = istDate(this.now());
    if (!TRIGGERS.includes(o.trigger)) throw new Refused('bad-trigger');
    if (o.pipeline === 'coverage') throw new Refused('coverage-not-in-this-build');
    try {
      refuseDefaultHome(this.home, 'run');
    } catch {
      throw new Refused('config');
    }
    const secrets = envSecrets(d.env);
    try {
      this.stateKey = decodeKey(secrets.get('hosted.state_key') ?? '', 'STATE_KEY');
      this.packKey = decodeKey(secrets.get('hosted.pack_key') ?? '', 'PACK_KEY');
    } catch {
      throw new Refused('keys');
    }
  }

  private async configRepoAndCode(): Promise<void> {
    const { o, d } = this;
    // `.private` of repos/R only: a secret listing is refused to GITHUB_TOKEN (403). A failure still refuses.
    if (!(await d.gh.repoPrivate().then((p) => p, () => false))) throw new Refused('repo-public');
    const head = d.git(['rev-parse', 'HEAD'], o.codeDir);
    if (head.status !== 0 || head.stdout.trim() !== this.lock) throw new Refused('code-lock-mismatch');
    if (o.fetchMain && d.git(['fetch', '--quiet', 'origin', 'main'], o.codeDir).status !== 0) throw new Refused('code-not-ancestor');
    if (d.git(['merge-base', '--is-ancestor', this.lock, o.ancestorRef], o.codeDir).status !== 0) throw new Refused('code-not-ancestor');
  }

  // ---- step 0: cheap check --------------------------------------------------------------------------------------
  private async cheapCheck(): Promise<void> {
    const { o, d } = this;
    const cfg = this.cfg as HostedConfig;
    // the order of refusals: the ones that need no state first
    await this.configRepoAndCode();
    this.at('cheap-check');
    const started = await d.gh.jobStartedAt(o.runId).catch(() => null);
    if (started !== null && !Number.isNaN(Date.parse(started))) this.jobStart = new Date(started).toISOString();
    const head = await d.gh.readState();
    if (head === null || head.pointer.current === null) throw new Refused('state-missing');
    this.head = head;
    if (head.pointer.sizeHard) throw new Refused('size-hard');
    this.emit('start', { pipeline: o.pipeline, trigger: o.trigger, gen: head.pointer.gen, code: this.lock.slice(0, 12) });

    const now = this.now();
    this.month = cycleMonth(now, cfg.budget.cycleStartDay);
    const entries: LedgerEntry[] = [];
    for (const m of [previousMonth(this.month), this.month]) {
      const text = await d.gh.readStateFile(ledgerPath(m));
      if (text !== null) entries.push(...parseLedger(text));
    }
    const decision = govern({ now, entries, budget: cfg.budget });
    this.decision = decision;
    const budgetLine = this.emit('budget', { used: decision.used, total: cfg.budget.monthlyMinutes, month: this.month, level: decision.level });
    if (levelRose(head.pointer.budget, this.month, decision.level)) await this.alert('budget', [budgetLine]);
    if (decision.level === 'L4') throw new Refused('budget-l4');

    const done = head.pointer.current.lastDone;
    const beforeSeven = new Date(Date.parse(now) + IST_MS).getUTCHours() < 7;
    const freelanceOwed = cfg.freelance.windows.includes('am') && done.freelance !== this.today;
    const freelanceRuns = freelanceOwed && decision.freelanceAllowed;
    if (beforeSeven || (done.daily === this.today && !freelanceRuns)) {
      this.emit('nothingOwed', { pipeline: o.pipeline, gen: head.pointer.gen });
      this.finish('nothing-owed', 0);
    }
    if (o.trigger === 'catch-up' && !decision.catchUpAllowed) {
      this.emit('catchUpOff', { pipeline: o.pipeline });
      this.finish('catch-up-off', 0);
    }
  }

  // ---- step 1: lease --------------------------------------------------------------------------------------------
  private async takeLease(): Promise<void> {
    const { o, d } = this;
    this.at('lease');
    const holder: Holder = `actions:${o.runId}`;
    const until = new Date(Date.parse(this.jobStart) + o.jobTimeoutMinutes * MINUTE).toISOString();
    try {
      this.head = await acquireLease(d.gh, holder, this.now(), until);
    } catch (e) {
      if (e instanceof StateBusy) {
        this.emit('busy', { pipeline: o.pipeline, holder: e.holder, until: `${istClock(e.until)} IST` });
        this.finish('busy', 0);
      }
      throw e;
    }
    this.holder = holder;
    this.leaseHeld = true;
  }

  // ---- step 2: download, integrity, disk ------------------------------------------------------------------------
  private async pullState(): Promise<void> {
    const { d } = this;
    const head = this.head as StateHead;
    const rec = head.pointer.current;
    if (rec === null) throw new StepFailure('internal');
    mkdirSync(this.tmp, { recursive: true, mode: 0o700 });
    this.at('download');
    await fetchGeneration(d.gh, rec, this.stateKey as Buffer, this.tmp, this.home);
    this.at('integrity');
    const r = checkState(this.home, this.now());
    if (!r.ok) throw new StateError(r.code, `the pulled state failed its check: ${r.detail}`);
    this.emit('pulled', { gen: rec.gen, mb: rec.bytes / MB });
    this.at('disk');
    const dbBytes = statSync(join(this.home, 'jobpilot.db')).size;
    if (d.freeBytes(this.o.workDir) < 3 * dbBytes + 2 * GIB) throw new StepFailure('internal', 'not enough free disk');
  }

  // ---- step 3: pack ---------------------------------------------------------------------------------------------
  private async openPack(): Promise<void> {
    this.at('pack');
    await openInto(join(this.o.dataDir, 'pack', 'pack.jpst'), this.packKey as Buffer, join(this.home, 'pack'));
    const asOf = istMonth(this.now());
    const loaded = loadRunPack(join(this.home, 'pack'), {}, asOf, undefined, 'daily');
    loadRunPack(join(this.home, 'pack'), {}, asOf, undefined, 'freelance');
    this.maskList = maskValues(loaded.pack);
    for (const l of maskCommands(this.maskList)) this.d.out(l);
  }

  // ---- step 3b: previous run's log audit ------------------------------------------------------------------------
  private async auditPrevious(): Promise<void> {
    this.at('audit');
    try {
      const prev = await this.d.gh.previousRunId('daily.yml', this.o.runId);
      if (prev === null) return;
      const log = await this.d.gh.runLog(prev);
      if (log === null) return;
      const r: AuditResult = auditLog(log, this.maskList);
      this.audit = { runId: prev, hits: r.hits, nonTemplateLines: r.nonTemplateLines };
      const l = this.emit('audit', { runId: prev, hits: r.hits, lines: r.nonTemplateLines });
      if (r.hits > 0 || r.nonTemplateLines > 0) await this.alert('leak', [l]);
    } catch (e) {
      this.log(`audit skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- steps 5 and 6: the pipelines -----------------------------------------------------------------------------
  private deadline(): number {
    return Date.parse(this.jobStart) + (this.o.jobTimeoutMinutes - DEADLINE_MARGIN_MINUTES) * MINUTE;
  }

  private async child(name: 'daily' | 'freelance', argv: readonly string[], env: Record<string, string>): Promise<{ run: PipelineRun; summary: RunSummaryJson | null }> {
    const summaryFile = join(this.tmp, `summary-${name}.json`);
    rmSync(summaryFile, { force: true });
    const full = [...this.d.cli, ...argv, '--summary-json', summaryFile];
    const run = await this.d.spawn({ argv: full, env, cwd: this.o.codeDir, logFile: join(this.home, 'logs', `${name}-${this.o.runId}.log`), deadlineAt: this.deadline(), graceMs: GRACE_SECONDS * 1000 });
    if (run.killed) {
      this.killedLine = this.emit('killed', { pipeline: name, seconds: GRACE_SECONDS });
      throw new Killed();
    }
    // the deadline SIGTERM reached a child before it installed its handler (one started at the deadline): a stop, not a crash
    const stoppedEarly = run.exit === null && run.stopped && (run.signal ?? 'SIGTERM') === 'SIGTERM';
    // the ledger's schema takes only the exit codes a pipeline can end with (0-2)
    this.pipelines[name] = run.exit !== null && run.exit >= 0 && run.exit <= 2 ? run.exit : null;
    if (stoppedEarly) return { run, summary: null };
    if (run.exit === null || run.exit > 2) throw new StepFailure('pipeline-crash');
    return { run, summary: readSummary(summaryFile) };
  }

  private tally(summary: RunSummaryJson | null): { problems: number; codes: string } {
    const known = new Set<string>(PROBLEM_CODES);
    const out: Record<string, number> = {};
    for (const [code, n] of Object.entries(summary?.problems ?? {})) {
      const k = known.has(code) ? code : 'failed';
      out[k] = (out[k] ?? 0) + n;
    }
    return { problems: Object.values(out).reduce((a, b) => a + b, 0), codes: codesOf(out) };
  }
  private outcomeOf(run: PipelineRun, summary: RunSummaryJson | null): 'done' | 'paused' | 'failed' | 'could not run' | 'not owed' {
    if (summary === null) return run.stopped ? 'paused' : run.exit === 0 ? 'not owed' : 'could not run';
    if (summary.status === 'paused') return 'paused';
    return summary.exitCode === 0 ? 'done' : 'failed';
  }
  private noteSkipped(summary: RunSummaryJson | null): void {
    if (summary !== null) this.summaries.set(summary.pipeline, summary.skippedSources);
  }
  private toDecide(): number {
    try {
      const db = join(this.home, 'jobpilot.db');
      const id = runOn(db, 'daily', this.today);
      return id === null ? 0 : digestRun(db, id, { env: 'hosted', codeSha: this.lock }).toDecide.length;
    } catch {
      return 0;
    }
  }

  private async runDaily(): Promise<void> {
    const { o, d } = this;
    const cfg = this.cfg as HostedConfig;
    const done = (this.head as StateHead).pointer.current?.lastDone;
    if (done?.daily === this.today) return;
    this.at('daily');
    const argv = ['run', '--if-due'];
    for (const s of cfg.skipSources.filter((x) => !x.startsWith('freelance:'))) argv.push('--skip-source', s);
    if (o.offlineFixtures !== undefined) argv.push('--offline-fixtures', o.offlineFixtures);
    const { run, summary } = await this.child('daily', argv, childEnv(d.env, this.home));
    this.noteSkipped(summary);
    const t = this.tally(summary);
    const line = this.emit('daily', {
      outcome: this.outcomeOf(run, summary),
      minutes: Math.round(run.ms / MINUTE),
      postings: summary?.items ?? 0,
      toDecide: this.toDecide(),
      problems: t.problems,
      codes: t.codes,
    });
    this.daily = { run, summary, line };
  }

  private async runFreelance(): Promise<void> {
    const { o, d } = this;
    const cfg = this.cfg as HostedConfig;
    const decision = this.decision as Decision;
    const done = (this.head as StateHead).pointer.current?.lastDone;
    if (!cfg.freelance.windows.includes('am') || done?.freelance === this.today) return;
    if (!decision.freelanceAllowed) {
      this.emit('freelanceCut', { until: nextCycleDm(this.month, cfg.budget.cycleStartDay) });
      return;
    }
    if (Date.parse(this.now()) >= this.deadline()) {
      // the deadline already passed (the daily ran into it): a child started now would only be stopped at once
      this.emit('freelance', { outcome: 'paused', minutes: 0, gigs: 0, problems: 0, codes: '' });
      return;
    }
    this.at('freelance');
    const argv = ['run-freelance', '--if-due', '--windows', 'am'];
    for (const s of cfg.skipSources) argv.push('--skip-source', s);
    if (o.offlineFixtures !== undefined) argv.push('--offline-fixtures', o.offlineFixtures);
    const extra: Record<string, string> = {};
    for (const n of GMAIL_ENV_NAMES) {
      const v = d.env[n];
      if (v !== undefined && v !== '') extra[n] = v;
    }
    const { run, summary } = await this.child('freelance', argv, childEnv(d.env, this.home, extra));
    this.noteSkipped(summary);
    const t = this.tally(summary);
    const line = this.emit('freelance', {
      outcome: this.outcomeOf(run, summary),
      minutes: Math.round(run.ms / MINUTE),
      gigs: summary?.items ?? 0,
      problems: t.problems,
      codes: t.codes,
    });
    this.freelance = { run, summary, line };
    if (summary?.gmail === 'failed') await this.alert('gmail', [line]);
  }

  /** Step 6b: a `jobpilot gave up` notification this run wrote. */
  private async gaveUp(): Promise<void> {
    const n = [...this.summaries.values()].reduce((a, b) => a + b, 0);
    if (n > 0) this.emit('skippedSources', { n });
    const file = join(this.home, 'logs', 'notifications.jsonl');
    if (!existsSync(file)) return;
    const since = Date.parse(this.jobStart);
    let gaveUp = false;
    for (const l of readFileSync(file, 'utf8').split('\n')) {
      if (l.trim() === '') continue;
      try {
        const e = JSON.parse(l) as { at?: unknown; text?: unknown };
        if (typeof e.text === 'string' && e.text.startsWith('jobpilot gave up') && typeof e.at === 'string' && Date.parse(e.at) >= since) gaveUp = true;
      } catch {
        // a damaged line is not a notification
      }
    }
    if (gaveUp) await this.alert('gave-up', [this.daily?.line, this.freelance?.line].filter((x): x is string => x !== undefined));
  }

  // ---- step 7: compact ------------------------------------------------------------------------------------------
  private async compact(): Promise<void> {
    this.at('compact');
    const archive = join(this.home, COMPACT_ARCHIVE);
    const before = new Set(existsSync(archive) ? readdirSync(archive) : []);
    const lines: string[] = [];
    const code = await storeCompactCommand({ home: this.home, clock: this.d.clock, out: (l) => lines.push(l), err: (l) => lines.push(l), apply: true, includeIncomplete: true, vacuum: true });
    this.log(`store compact:\n${lines.join('\n')}`);
    if (code !== 0) throw new StepFailure('internal', 'store compact failed');
    this.newSegments = (existsSync(archive) ? readdirSync(archive) : []).filter((f) => !before.has(f)).sort();
    if (this.newSegments.length === 0) this.emit('compactNone', {});
    else this.emit('compacted', { mb: this.newSegments.reduce((n, f) => n + statSync(join(archive, f)).size, 0) / MB });
  }

  // ---- step 8: digests ------------------------------------------------------------------------------------------
  private digests(): Record<string, string> {
    this.at('digest');
    const db = join(this.home, 'jobpilot.db');
    const files: Record<string, string> = {};
    for (const pipeline of ['daily', 'freelance'] as const) {
      const ran = pipeline === 'daily' ? this.daily : this.freelance;
      if (ran === undefined) continue;
      const id = runOn(db, pipeline, this.today);
      if (id === null) continue;
      const dg: Digest = digestRun(db, id, { env: 'hosted', codeSha: this.lock, billedMinutes: Math.round(ran.run.ms / MINUTE) });
      files[`shadow/hosted/${digestFileName(dg)}`] = digestJson(dg);
    }
    return files;
  }

  // ---- step 10: bundle, upload, commit --------------------------------------------------------------------------
  private async publish(files: Record<string, string>): Promise<void> {
    const { d } = this;
    const cfg = this.cfg as HostedConfig;
    const base = this.head as StateHead;
    const last: LastDone = base.pointer.current?.lastDone ?? { daily: null, freelance: null, coverage: null };
    const lastDone: LastDone = {
      ...last,
      daily: this.daily?.summary?.status === 'completed' ? this.today : last.daily,
      freelance: this.freelance?.summary?.status === 'completed' ? this.today : last.freelance,
    };
    // the fault hooks of the upload and the CAS fire inside the shared publish
    const gh: GitHubClient = {
      ...d.gh,
      createRelease: async (tag) => {
        await d.gh.createRelease(tag);
        this.created.push(tag);
      },
      uploadAsset: async (tag, file, name) => {
        this.at('upload');
        return d.gh.uploadAsset(tag, file, name);
      },
      casState: async (parent, f, message) => {
        if (message.startsWith('generation ')) this.at('commit');
        return d.gh.casState(parent, f, message);
      },
    };
    this.at('bundle');
    const out = await publishHome({
      gh,
      key: this.stateKey as Buffer,
      home: this.home,
      tmpDir: this.tmp,
      base,
      holder: this.holder as Holder,
      now: this.now(),
      codeSha: this.lock,
      lastDone,
      files,
      state: cfg.state,
      budget: { month: this.month, level: (this.decision as Decision).level },
      archiveSegments: this.newSegments,
    });
    if (!out.ok) {
      if (out.reason === 'cas') this.leaseHeld = false;
      throw new StepFailure(out.reason);
    }
    this.head = out.head;
    this.leaseHeld = false;
    this.committedGen = out.head.pointer.gen;
    this.committedAt = out.head.pointer.current?.at;
    this.emit('committed', { gen: out.head.pointer.gen, mb: out.sealed.bytes / MB });
    if (out.sizeLevel !== 'ok') {
      const l = this.emit('size', {
        mb: out.sealed.bytes / MB,
        limit: out.sizeLevel === 'warning' ? cfg.state.warnCompressedMB : cfg.state.hardCompressedMB,
        level: out.sizeLevel,
      });
      await this.alert('size', [l]);
    }
  }

  // ---- step 12: prune -------------------------------------------------------------------------------------------
  private async prune(): Promise<void> {
    try {
      this.at('prune');
      const cfg = this.cfg as HostedConfig;
      const plan = prunePlan(await this.d.gh.listReleases(), (this.head as StateHead).pointer, this.now(), {
        generations: cfg.state.keepGenerations,
        weekly: cfg.state.keepWeekly,
        archiveDays: cfg.state.archiveDays,
      });
      for (const tag of plan) await this.d.gh.deleteRelease(tag);
      this.emit('pruned', { n: plan.length });
    } catch (e) {
      this.log(`prune failed (the state is committed): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- step 13: ledger (always) ---------------------------------------------------------------------------------
  private async writeLedger(): Promise<void> {
    const cfg = this.cfg;
    const refused = this.outcome === 'refused';
    try {
      this.at('ledger');
      const now = this.now();
      const month = cfg === undefined ? cycleMonth(now, 1) : cycleMonth(now, cfg.budget.cycleStartDay);
      const entry: LedgerEntry = {
        runId: this.o.runId,
        workflow: this.o.pipeline,
        startedAt: this.jobStart,
        billedMinutes: Math.min(400, billedMinutes(this.jobStart, now)),
        outcome: this.outcome,
        date: this.today === '' ? istDate(now) : this.today,
        ...(this.committedGen !== undefined ? { gen: this.committedGen } : {}),
        ...(this.committedAt !== undefined ? { committedAt: this.committedAt } : {}),
        pipelines: { daily: this.pipelines.daily, freelance: this.pipelines.freelance },
        ...(this.audit !== undefined ? { audit: this.audit } : {}),
        ...(this.decision !== undefined ? { level: this.decision.level } : {}),
      };
      // a line that fails its own schema would wedge every later run at the cheap check: never append one
      const valid = LedgerEntry.safeParse(entry);
      if (!valid.success) {
        this.log(`ledger line not written (it fails the ledger schema): ${valid.error.issues.map((x) => x.path.join('.') || '(root)').join(', ')}`);
        if (refused) return;
        throw new Error('ledger entry fails its schema');
      }
      await appendStateFiles(
        this.d.gh,
        async (_head, read) => {
          const existing = (await read(ledgerPath(month))) ?? '';
          return { [ledgerPath(month)]: `${existing}${JSON.stringify(valid.data)}\n` };
        },
        `ledger ${this.o.runId}`,
      );
    } catch (e) {
      this.log(`ledger failed: ${e instanceof Error ? e.message : String(e)}`);
      this.exit = 1;
      if (!refused) {
        const l = this.emit('error', { reason: 'internal' });
        await this.alert('state-failure', [l]);
      }
    }
  }
}

/** `jobpilot hosted run daily` (spec §3.5): the steps in the plan's table; returns the process exit code. */
export function runHosted(o: HostedRunOptions, d: HostedDeps): Promise<0 | 1> {
  return new HostedRun(o, d).run();
}
