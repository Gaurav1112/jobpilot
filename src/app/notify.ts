import { execFile } from 'node:child_process';
import { assertNoForbidden, ForbiddenTermError } from './pack/rules.js';
import type { Naming } from './pack/schema.js';

/** Posts one notification. The run uses `osascriptNotifier`; tests inject a fake. */
export type Notifier = (text: string) => Promise<void>;

export interface NewMatch {
  readonly score: number | null;
  readonly company: string;
  readonly title: string;
}

const scoreText = (s: number): string => (Number.isInteger(s) ? String(s) : s.toFixed(1));

/**
 * The notification text (spec §1): `<N> new matches · top: <score> <company> — <title>` for the highest score among
 * `matches` (first seen today with ready documents; ties keep the given order), or `No new matches today`. The text
 * never carries a forbidden term: if the top match's company or title holds one, only the count is shown.
 */
export function notificationFor(matches: readonly NewMatch[], naming: Pick<Naming, 'forbiddenTerms'>): string {
  if (matches.length === 0) return 'No new matches today';
  const top = matches.reduce((best, m) => ((m.score ?? -Infinity) > (best.score ?? -Infinity) ? m : best));
  const count = `${matches.length} new matches`;
  const full = `${count} · top: ${top.score === null ? '?' : scoreText(top.score)} ${top.company} — ${top.title}`;
  try {
    assertNoForbidden(full, naming);
    return full;
  } catch (e) {
    if (!(e instanceof ForbiddenTermError)) throw e;
    assertNoForbidden(count, naming);
    return count;
  }
}

/** `s` as an AppleScript string literal: backslash and double quote escaped, line breaks folded to spaces. */
export function appleScriptString(s: string): string {
  return `"${s.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The real notifier: `osascript -e 'display notification "<text>" with title "jobpilot"'`, no shell involved. */
export const osascriptNotifier: Notifier = (text) =>
  new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', `display notification ${appleScriptString(text)} with title "jobpilot"`], { timeout: 10_000 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
