import { isTemplateLine } from './log-gateway.js';

/** The wrapper step's name in the workflow; only its lines are template-checked (setup steps are GitHub's own text). */
export const WRAPPER_STEP = 'jobpilot hosted run';
/** Runner-made lines inside the wrapper step: the group markers and the step's header block. */
export const RUNNER_LINES: readonly RegExp[] = [/^##\[(?:group|endgroup)\]/, /^shell: \/usr\/bin\/bash -e \{0\}$/, /^env:$/, /^ {2}[A-Z][A-Z0-9_]*: /, /^node --run jobpilot -- hosted run (?:daily|coverage)$/];
export interface AuditResult {
  readonly hits: number;
  readonly nonTemplateLines: number;
}

const forms = (v: string): string[] => {
  const b = Buffer.from(v, 'utf8');
  const strip = (s: string): string => s.replace(/=+$/, '');
  return [...new Set([v, strip(b.toString('base64')), strip(b.toString('base64url')), encodeURIComponent(v)])];
};

function countIn(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Counts mask values found in the whole log (raw, base64, base64url, URL-encoded) and non-template lines of the wrapper step. Never returns or prints a value. */
export function auditLog(log: string, values: readonly string[]): AuditResult {
  let hits = 0;
  for (const v of new Set(values)) {
    if (v.length === 0) continue;
    for (const f of forms(v)) hits += countIn(log, f);
  }
  let nonTemplateLines = 0;
  for (const raw of log.split('\n')) {
    const parts = raw.replace(/\r$/, '').split('\t');
    if (parts.length < 3 || parts[1] !== WRAPPER_STEP) continue;
    const text = parts
      .slice(2)
      .join('\t')
      .replace(/^﻿/, '')
      .replace(/^\S+ ?/, '');
    if (text.length === 0) continue;
    if (isTemplateLine(text) || RUNNER_LINES.some((r) => r.test(text))) continue;
    nonTemplateLines++;
  }
  return { hits, nonTemplateLines };
}
