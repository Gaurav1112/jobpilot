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
/** One line: control characters dropped, whitespace runs (line breaks included) folded to one space. */
const oneLine = (s: string): string => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The notification text (spec §1): `<N> new matches · top: <score> <company> — <title>` (`1 new match`) for the
 * highest score among `matches` (first seen today with ready documents; ties keep the given order), or
 * `No new matches today`; then ` · <k> problems` when the run had any (failed, gone, input-rejected, skipped or
 * quarantined steps). The text is one line and never carries a forbidden term: if the top match holds one, only the
 * count is shown, and if even the fixed words would, it is `jobpilot run finished`.
 */
export function notificationFor(matches: readonly NewMatch[], naming: Pick<Naming, 'forbiddenTerms'>, problems = 0): string {
  const tail = problems > 0 ? ` · ${plural(problems, 'problem', 'problems')}` : '';
  const clean = (s: string): string | undefined => {
    try {
      assertNoForbidden(s, naming);
      return s;
    } catch (e) {
      if (e instanceof ForbiddenTermError) return undefined;
      throw e;
    }
  };
  if (matches.length === 0) return clean(`No new matches today${tail}`) ?? 'jobpilot run finished';
  const top = matches.reduce((best, m) => ((m.score ?? -Infinity) > (best.score ?? -Infinity) ? m : best));
  const count = plural(matches.length, 'new match', 'new matches');
  const full = oneLine(`${count} · top: ${top.score === null ? '?' : scoreText(top.score)} ${top.company} — ${top.title}${tail}`);
  return clean(full) ?? clean(`${count}${tail}`) ?? 'jobpilot run finished';
}

/** `s` as an AppleScript string literal: control characters dropped, line breaks folded, backslash and quote escaped. */
export function appleScriptString(s: string): string {
  return `"${oneLine(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The real notifier: `osascript -e 'display notification "<text>" with title "jobpilot"'`, no shell involved. */
export const osascriptNotifier: Notifier = (text) =>
  new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', `display notification ${appleScriptString(text)} with title "jobpilot"`], { timeout: 10_000 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
