import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Clock } from '../kernel/clock.js';
import { nodeFetch } from '../kernel/providers.js';
import type { PlaywrightBrowserProvider } from './browser/playwright-provider.js';
import { lookup } from 'node:dns/promises';
import { alerted, dailyDue, finishAttempt, markAlerted, startAttempt } from './due.js';
import { LockError } from './lock.js';
import type { Notifier } from './notify.js';
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
  /** `--if-due` asks this before a live run; default `dnsOnline`. */
  readonly online?: () => Promise<boolean>;
}

/** Hosts every pack's sources depend on; one resolving means the network is up (Wi-Fi is often still down at wake). */
const PROBE_HOSTS = ['boards-api.greenhouse.io', 'api.lever.co', 'api.ashbyhq.com'];
export async function dnsOnline(): Promise<boolean> {
  const one = (h: string) => Promise.race([lookup(h).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5_000).unref())]).catch(() => false);
  return (await Promise.all(PROBE_HOSTS.map(one))).some(Boolean);
}

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

/**
 * `jobpilot run` as a function returning the exit code: 0 clean; 1 when a step failed (other than gone or
 * input-rejected) or was quarantined; 2 when the run could not run (pack, pacing, lock, pdftotext, fixtures), in which
 * case `jobpilot run failed: <reason>` is posted (unless `--no-notify`).
 */
export async function runCommand(o: RunCommandOptions, d: RunCommandDeps): Promise<0 | 1 | 2> {
  let live: PlaywrightBrowserProvider | undefined;
  const startedAt = d.clock.now();
  let attempt: number | undefined;
  try {
    if (o.ifDue === true) {
      const due = dailyDue(d.home, startedAt);
      if (!due.due) {
        d.out(`not due: ${due.reason}`);
        if (due.capped === true && o.notify && !alerted(d.home, startedAt)) {
          // Once a day: the scheduled run has given up until tomorrow or a manual run.
          await d.notifier(`jobpilot gave up on today's run: ${due.reason}`).then(() => markAlerted(d.home, startedAt), () => {});
        }
        return 0;
      }
      // A run with every fetch failing would complete, count as today's and block the day (rereview of 8b49294):
      // wait for the network instead, quietly; the next half-hourly start tries again.
      if (o.offlineFixtures === undefined && !(await (d.online ?? dnsOnline)())) {
        d.out('not due: the network is down (no source host resolves); the next start tries again');
        return 0;
      }
    }
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
      ...(o.ifDue === true ? { onLocked: () => void (attempt = startAttempt(d.home, startedAt)) } : {}),
    });
    if (o.ifDue === true) finishAttempt(d.home, startedAt, 'done', attempt);
    d.out(formatSummary(summary));
    return summary.exitCode;
  } catch (e) {
    if (o.ifDue === true && e instanceof LockError && /^another jobpilot process \(pid /.test(e.message)) {
      d.out(`not due: ${e.message}`);
      return 0;
    }
    const terms = forbiddenTermsAt(homePaths(d.home).pack);
    d.err(`error: ${redactedError(e, terms)}`);
    if (o.notify) {
      await d.notifier(failureNotification(e, terms)).catch((n: unknown) => d.err(`error: the failure notification could not be posted: ${redactedError(n, terms)}`));
    }
    if (o.ifDue === true) {
      try {
        finishAttempt(d.home, startedAt, 'failed', attempt);
      } catch (r) {
        d.err(`error: the failed attempt could not be recorded, so the next start retries at once: ${redactedError(r, terms)}`);
      }
    }
    return 2;
  } finally {
    await live?.close();
  }
}
