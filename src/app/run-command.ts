import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Clock } from '../kernel/clock.js';
import { nodeFetch } from '../kernel/providers.js';
import type { PlaywrightBrowserProvider } from './browser/playwright-provider.js';
import type { Notifier } from './notify.js';
import { offlineProviders } from './offline.js';
import { homePaths } from './pack/paths.js';
import { NamingSchema } from './pack/schema.js';
import { failureNotification, formatSummary, runDaily } from './run.js';

export interface RunCommandOptions {
  readonly offlineFixtures?: string;
  readonly refresh?: boolean;
  /** False for `--no-notify`: nothing is posted and nothing is marked announced. */
  readonly notify: boolean;
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
}

/** The pack's forbidden terms, if naming.yaml can be read at all (for a failure notification); else undefined. */
function forbiddenTermsAt(packDir: string): readonly string[] | undefined {
  try {
    return NamingSchema.parse(parseYaml(readFileSync(join(packDir, 'naming.yaml'), 'utf8'))).forbiddenTerms;
  } catch {
    return undefined;
  }
}

/**
 * `jobpilot run` as a function returning the exit code: 0 clean; 1 when a step failed (other than gone or
 * input-rejected) or was quarantined; 2 when the run could not run (pack, pacing, lock, pdftotext, fixtures), in which
 * case `jobpilot run failed: <reason>` is posted (unless `--no-notify`).
 */
export async function runCommand(o: RunCommandOptions, d: RunCommandDeps): Promise<0 | 1 | 2> {
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
    });
    d.out(formatSummary(summary));
    return summary.exitCode;
  } catch (e) {
    d.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    if (o.notify) {
      await d.notifier(failureNotification(e, forbiddenTermsAt(homePaths(d.home).pack))).catch((n: unknown) =>
        d.err(`error: the failure notification could not be posted: ${n instanceof Error ? n.message : String(n)}`),
      );
    }
    return 2;
  } finally {
    await live?.close();
  }
}
