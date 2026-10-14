import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Clock } from '../kernel/clock.js';
import { nodeFetch } from '../kernel/providers.js';
import type { PlaywrightBrowserProvider } from './browser/playwright-provider.js';
import { attemptsFor, COVERAGE_DUE, DAILY_DUE, due, FREELANCE_DUE, otherRunOwed, type DueSpec } from './due.js';
import { GMAIL_OFF, type GmailRunAccess } from './freelance/mail/oauth.js';
import { formatCoverageSummary, runCoverage } from './coverage/run.js';
import { formatFreelanceSummary, runFreelance } from './freelance/run.js';
import { LockError } from './lock.js';
import type { Notifier } from './notify.js';
import { checkOutage } from './check-outage.js';
import { httpsOnline, PROBE_HOSTS } from './net.js';
import { offlineProviders } from './offline.js';
import { homePaths } from './pack/paths.js';
import { redactText } from './pack/rules.js';
import { failureNotification, formatSummary, runDaily } from './run.js';

export interface RunCommandOptions {
  readonly offlineFixtures?: string;
  readonly refresh?: boolean;
  /** False for `--no-notify`: nothing is posted and nothing is marked announced. */
  readonly notify: boolean;
  /**
   * `--if-due` (the scheduled start): run only when today's run is owed (`dailyDue`), say why not otherwise and exit
   * 0; another jobpilot holding the lock is also a quiet 0. A run that could not run is recorded for the retry rule.
   */
  readonly ifDue?: boolean;
}

export interface RunCommandDeps {
  readonly home: string;
  readonly clock: Clock;
  /** `osascriptNotifier` in the CLI; tests inject a fake. */
  readonly notifier: Notifier;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly pdftotext?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  /** `--if-due` asks this before a live run (and the coverage run when a slice meets errors); default `httpsOnline` (R1: HTTPS must work, not only DNS). */
  readonly online?: () => Promise<boolean>;
  /**
   * The freelance run's Gmail access (`gmailRunAccess` over the Keychain in the CLI), asked only when a live run
   * starts. Absent, or an offline run: Gmail is not read.
   */
  readonly gmail?: () => GmailRunAccess;
}

/** An offline run never reads Gmail (the fixtures have no mailbox). */
const GMAIL_OFFLINE: GmailRunAccess = { ...GMAIL_OFF, reason: 'Gmail is not read in an offline run' };

export { dnsOnline } from './net.js';

/**
 * The pack's forbidden terms, if naming.yaml can be read at all (for the failure notification and the stderr
 * redactor); else undefined. Read leniently (final I9): a naming.yaml whose employerDisplay is invalid still yields
 * its forbiddenTerms, so the error about it is redacted too.
 */
export function forbiddenTermsAt(packDir: string): readonly string[] | undefined {
  try {
    const terms = (parseYaml(readFileSync(join(packDir, 'naming.yaml'), 'utf8')) as { forbiddenTerms?: unknown } | null)?.forbiddenTerms;
    return Array.isArray(terms) && terms.every((t) => typeof t === 'string') ? terms : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Error text for stderr (which launchd writes to daily.log), redacted by `redactText` (final I9). When the forbidden
 * terms cannot be read the message is kept: pack errors name files, fields, ids and positions only, never source text.
 */
export function redactedError(e: unknown, terms: readonly string[] | undefined): string {
  const message = e instanceof Error ? e.message : String(e);
  return terms === undefined ? message : redactText(message, { forbiddenTerms: terms });
}

/** What a pipeline's run callback reports: the printed summary and the run's exit code. */
export interface DueRunResult {
  readonly text: string;
  readonly exitCode: 0 | 1;
  /** The run stopped between steps on purpose (a coverage slice that yielded or hit its limit): the attempt is `paused`, never a failure. */
  readonly paused?: boolean;
}

/** Hosts each pipeline's sources depend on; one resolving means the network is up. */
const PROBE_HOSTS_OF: Readonly<Record<DueSpec['pipeline'], readonly string[]>> = {
  daily: PROBE_HOSTS,
  freelance: ['www.freelancer.com', 'remotive.com', 'hn.algolia.com'],
  coverage: PROBE_HOSTS,
};

/**
 * The part of `jobpilot run` and `jobpilot run-freelance` that is the same for both (no behaviour change for daily):
 * with `--if-due`, run only when `spec`'s window is owed (`due`), say why not and exit 0 otherwise, post the give-up
 * notice once per window when the failures are capped, and wait quietly while the network is down; another jobpilot
 * holding the lock is a quiet 0. The attempt is recorded when the lock is held (`onLocked`) and finished as done or
 * failed. A run that could not run (it threw) prints the redacted error, posts `jobpilot <command> failed: <reason>`
 * (unless `--no-notify`) and returns 2.
 */
export async function runWithDue(
  spec: DueSpec,
  o: Pick<RunCommandOptions, 'ifDue' | 'notify' | 'offlineFixtures'>,
  d: RunCommandDeps,
  run: (hooks: { readonly onLocked?: () => void }) => Promise<DueRunResult>,
): Promise<0 | 1 | 2> {
  const attempts = attemptsFor(spec);
  const startedAt = d.clock.now();
  let attempt: number | undefined;
  try {
    if (o.ifDue === true) {
      const owed = due(spec, d.home, startedAt);
      if (!owed.due) {
        d.out(`not due: ${owed.reason}`);
        if (owed.capped === true && o.notify && !attempts.alerted(d.home, startedAt)) {
          // Once a window: the scheduled run has given up until the next window or a manual run.
          await d.notifier(giveUpText(spec, owed.window, owed.reason)).then(() => attempts.markAlerted(d.home, startedAt), () => {});
        }
        return 0;
      }
      // A run with every fetch failing would complete, count as the window's and block it (rereview of 8b49294):
      // wait for the network instead, quietly; the next half-hourly start tries again.
      if (o.offlineFixtures === undefined && !(await (d.online ?? (() => httpsOnline(nodeFetch, PROBE_HOSTS_OF[spec.pipeline])))())) {
        d.out('not due: the network is down (no source host answers over HTTPS); the next start tries again');
        return 0;
      }
    }
    const result = await run(o.ifDue === true ? { onLocked: () => void (attempt = attempts.start(d.home, startedAt)) } : {});
    if (o.ifDue === true) attempts.finish(d.home, startedAt, result.paused === true ? 'paused' : 'done', attempt);
    d.out(result.text);
    return result.exitCode;
  } catch (e) {
    if (o.ifDue === true && e instanceof LockError && /^another jobpilot process \(pid /.test(e.message)) {
      d.out(`not due: ${e.message}`);
      return 0;
    }
    const terms = forbiddenTermsAt(homePaths(d.home).pack);
    d.err(`error: ${redactedError(e, terms)}`);
    if (o.notify) {
      await d.notifier(failureNotification(e, terms, spec.command)).catch((n: unknown) => d.err(`error: the failure notification could not be posted: ${redactedError(n, terms)}`));
    }
    if (o.ifDue === true) {
      try {
        attempts.finish(d.home, startedAt, 'failed', attempt);
      } catch (r) {
        d.err(`error: the failed attempt could not be recorded, so the next start retries at once: ${redactedError(r, terms)}`);
      }
    }
    return 2;
  }
}

/** The give-up notice: daily keeps its v1 text; a windowed pipeline names its window. */
const giveUpText = (spec: DueSpec, window: string, reason: string): string =>
  spec.pipeline === 'daily' ? `jobpilot gave up on today's run: ${reason}`
  : spec.pipeline === 'coverage' ? `jobpilot gave up on this week's coverage run: ${reason}`
  : `jobpilot gave up on the ${window} window's ${spec.pipeline} run: ${reason}`;

/**
 * `jobpilot run` as a function returning the exit code: 0 clean; 1 when a step failed (other than gone or
 * input-rejected) or was quarantined; 2 when the run could not run (pack, pacing, lock, pdftotext, fixtures), in which
 * case `jobpilot run failed: <reason>` is posted (unless `--no-notify`).
 */
export async function runCommand(o: RunCommandOptions, d: RunCommandDeps): Promise<0 | 1 | 2> {
  return runWithDue(DAILY_DUE, o, d, async (hooks) => {
    let live: PlaywrightBrowserProvider | undefined;
    try {
      const offline = o.offlineFixtures === undefined ? undefined : offlineProviders(o.offlineFixtures);
      // Loaded only for a live run: the browser library is large, and an offline run never renders a live page.
      live = offline === undefined ? new (await import('./browser/playwright-provider.js')).PlaywrightBrowserProvider() : undefined;
      const summary = await runDaily({
        home: d.home,
        clock: d.clock,
        fetch: offline?.fetch ?? nodeFetch,
        browser: offline?.browser ?? (live as PlaywrightBrowserProvider),
        ...(o.notify ? { notifier: d.notifier } : {}),
        ...(o.refresh ? { refresh: true } : {}),
        ...(d.pdftotext !== undefined ? { pdftotext: d.pdftotext } : {}),
        ...(d.sleep !== undefined ? { sleep: d.sleep } : {}),
        ...hooks,
      });
      return { text: formatSummary(summary), exitCode: summary.exitCode };
    } finally {
      await live?.close();
    }
  });
}

/**
 * `jobpilot run-freelance [--if-due] [--offline-fixtures <dir>] [--no-notify]`, with the exit codes of `run`: 0 clean;
 * 1 when a step failed (other than gone or input-rejected) or was quarantined; 2 when the run could not run, in which
 * case `jobpilot run-freelance failed: <reason>` is posted (unless `--no-notify`). `--if-due` follows `FREELANCE_DUE`
 * (from 07:30 and 19:30 IST, `freelance-attempts.json`). No browser: no freelance source renders a page.
 */
export async function runFreelanceCommand(o: Omit<RunCommandOptions, 'refresh'>, d: RunCommandDeps): Promise<0 | 1 | 2> {
  return runWithDue(FREELANCE_DUE, o, d, async (hooks) => {
    const offline = o.offlineFixtures === undefined ? undefined : offlineProviders(o.offlineFixtures);
    // Asked only by the run, and only when gmail is enabled: a Keychain problem never stops the other sources.
    const gmail = offline !== undefined ? () => GMAIL_OFFLINE : d.gmail;
    const summary = await runFreelance({
      home: d.home,
      clock: d.clock,
      fetch: offline?.fetch ?? nodeFetch,
      ...(gmail !== undefined ? { gmail } : {}),
      ...(o.notify ? { notifier: d.notifier } : {}),
      ...(d.pdftotext !== undefined ? { pdftotext: d.pdftotext } : {}),
      ...(d.sleep !== undefined ? { sleep: d.sleep } : {}),
      ...hooks,
    });
    return { text: formatFreelanceSummary(summary), exitCode: summary.exitCode };
  });
}

/**
 * `jobpilot run-coverage [--if-due] [--offline-fixtures <dir>] [--no-notify] [--limit <n>]`, with the exit codes of
 * `run`: 0 clean; 1 when a step failed (other than gone, input-rejected or a host-disabled deferral) or was
 * quarantined; 2 when the run could not run. `--if-due` follows `COVERAGE_DUE` (owed from Sunday 06:00 IST through
 * Saturday, `coverage-attempts.json`). `--limit <n>` is for checks: every pick plus the first n other candidates.
 */
export async function runCoverageCommand(
  o: Omit<RunCommandOptions, 'refresh'> & { readonly limit?: number; readonly sliceMs?: number },
  d: RunCommandDeps & { readonly yieldCheck?: (now: string) => string | null },
): Promise<0 | 1 | 2> {
  // A scheduled start never takes the lock while the daily or freelance run is owed: they get it first.
  if (o.ifDue === true) {
    const owed = (d.yieldCheck ?? scheduledYieldCheck(d.home))(d.clock.now());
    if (owed !== null) {
      d.out(`not due: ${owed} (owed now or within 5 minutes); the next start continues the coverage run`);
      return 0;
    }
  }
  return runWithDue(COVERAGE_DUE, o, d, async (hooks) => {
    const offline = o.offlineFixtures === undefined ? undefined : offlineProviders(o.offlineFixtures);
    // the live re-check's outage simulation (check-only; inert unless JOBPILOT_CHECK_OUTAGE is set)
    const outage = checkOutage();
    if (outage !== null) d.err(`warning: ${outage.describe}`);
    const fetch = outage === null ? (offline?.fetch ?? nodeFetch) : outage.fetch(offline?.fetch ?? nodeFetch);
    // the run's own online check goes through its per-host pacer (re-check m5): only a fixtures run or a caller's check is passed in
    const online = offline !== undefined ? async () => true : d.online;
    const summary = await runCoverage({
      home: d.home,
      clock: d.clock,
      fetch,
      ...(online !== undefined ? { online: outage === null ? online : outage.online(online) } : {}),
      ...(o.notify ? { notifier: d.notifier } : {}),
      ...(d.sleep !== undefined ? { sleep: d.sleep } : {}),
      ...(o.limit !== undefined ? { limit: o.limit } : {}),
      ...(o.sliceMs !== undefined ? { sliceMs: o.sliceMs } : {}),
      ...(d.yieldCheck !== undefined ? { yieldCheck: d.yieldCheck } : {}),
      ...hooks,
    });
    return { text: formatCoverageSummary(summary), exitCode: summary.exitCode, ...(summary.status === 'paused' ? { paused: true } : {}) };
  });
}

/** The yield check of a scheduled coverage start: the daily or freelance run is owed on this home now or soon (`otherRunOwed`). */
export const scheduledYieldCheck =
  (home: string) =>
  (now: string): string | null =>
    otherRunOwed(home, now);
