import { appendFileSync } from 'node:fs';
import { ERROR_CODES } from '../../kernel/errors.js';

/**
 * The Actions log and the job summary carry only these lines (spec S9). Each `{name:kind}` slot accepts only its
 * alphabet; there is no slot for a company, board, title, person or URL. Anything else goes to logs/ inside the
 * encrypted state. `line` throws (naming the template and the slot, never the value) instead of printing a bad value.
 */
export const PIPELINES = ['daily', 'freelance', 'coverage'] as const;
export const PROBLEM_CODES = [
  ...new Set<string>([...ERROR_CODES, 'failed', 'gone', 'input_rejected', 'deferred', 'quarantined', 'skipped', 'commit-failed', 'docs-blocked', 'docs-stale', 'source-dead', 'mail-quarantined', 'audit-broken']),
].sort();
export const REFUSALS = ['repo-public', 'code-not-ancestor', 'code-lock-mismatch', 'bad-trigger', 'budget-l4', 'size-hard', 'coverage-not-in-this-build', 'state-missing', 'config', 'keys'] as const;
export const FAILURES = ['download', 'sha256', 'size', 'wrong-key', 'decrypt', 'quick-check', 'audit', 'bundle', 'upload', 'verify', 'cas', 'deadline-kill', 'pipeline-crash', 'internal'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const oneOf = (xs: readonly string[]) => new RegExp(`^(?:${xs.map((x) => x.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')})$`);
const INT = '(?:0|[1-9]\\d{0,2}(?:,\\d{3})*)';
const CODE = `(?:${PROBLEM_CODES.join('|')})`;
export const SLOTS: Readonly<Record<string, RegExp>> = {
  int: /^(?:0|[1-9]\d{0,2}(?:,\d{3})*)$/,
  mb: /^(?:0|[1-9]\d{0,5})\.\d$/,
  sha12: /^[0-9a-f]{12}$/,
  holder: /^(?:actions:\d{1,20}|laptop:[0-9a-f]{8})$/,
  ist: /^(?:[01]\d|2[0-3]):[0-5]\d IST$/,
  dm: new RegExp(`^(?:[1-9]|[12]\\d|3[01]) (?:${MONTHS.join('|')})$`),
  month: /^\d{4}-(?:0[1-9]|1[0-2])$/,
  runid: /^\d{1,20}$/,
  level: /^L[0-4]$/,
  pipeline: oneOf(PIPELINES),
  trigger: oneOf(['primary', 'catch-up', 'dispatch']),
  outcome: oneOf(['done', 'paused', 'failed', 'could not run', 'not owed']),
  refusal: oneOf(REFUSALS),
  failure: oneOf(FAILURES),
  step: oneOf(['triage', 'snapshot', 'deploy']),
  phase: oneOf(['H3', 'H4']),
  sizelevel: oneOf(['warning', 'hard limit']),
  codes: new RegExp(`^(?:| \\(${INT} ${CODE}(?:, ${INT} ${CODE})*\\))$`),
};

export const TEMPLATES = {
  start: 'hosted run {pipeline:pipeline}: trigger {trigger:trigger}, generation {gen:int}, code {code:sha12}',
  nothingOwed: 'hosted run {pipeline:pipeline}: nothing owed today (generation {gen:int})',
  catchUpOff: 'hosted run {pipeline:pipeline}: catch-up check off: minutes budget',
  busy: 'hosted run {pipeline:pipeline}: state is in use by {holder:holder} until {until:ist}',
  refused: 'hosted run {pipeline:pipeline}: refused: {reason:refusal}',
  pulled: 'state: generation {gen:int} pulled and verified ({mb:mb} MB)',
  daily: 'daily: {outcome:outcome} in {minutes:int} min · {postings:int} postings · {toDecide:int} to decide · {problems:int} problems{codes:codes}',
  freelance: 'freelance: {outcome:outcome} in {minutes:int} min · {gigs:int} gigs · {problems:int} problems{codes:codes}',
  freelanceCut: 'freelance: paused until {until:dm}: minutes budget',
  skippedSources: 'skipped on the hosted runner: {n:int} sources (home network only)',
  killed: '{pipeline:pipeline}: killed {seconds:int} s after the deadline stop; nothing is uploaded',
  compacted: 'compaction: {mb:mb} MB archived',
  compactNone: 'compaction: nothing to archive',
  committed: 'state: generation {gen:int} committed ({mb:mb} MB compressed)',
  notCommitted: 'state: not committed ({reason:failure}); generation {gen:int} stays',
  pruned: 'state: {n:int} old releases pruned',
  budget: 'budget: {used:int} of {total:int} minutes used in {month:month} · level {level:level}',
  audit: 'log audit of run {runId:runid}: {hits:int} hits, {lines:int} non-template lines',
  notInBuild: '{step:step}: not in this build ({phase:phase})',
  size: 'state: asset {mb:mb} MB compressed is over the {limit:int} MB {level:sizelevel}',
  error: 'hosted run: stopped by an internal error ({reason:failure})',
} as const;
export type TemplateId = keyof typeof TEMPLATES;
export class TemplateError extends Error {}

const PLACEHOLDER = /\{([a-zA-Z]+):([a-z0-9]+)\}/g;
const fmtInt = (n: number): string => {
  if (!Number.isSafeInteger(n) || n < 0) throw new TemplateError('not a non-negative integer');
  return n.toLocaleString('en-US');
};

export function line(id: TemplateId, values: Readonly<Record<string, string | number>>): string {
  const t = TEMPLATES[id];
  const used = new Set<string>();
  const out = t.replace(PLACEHOLDER, (_m, name: string, kind: string) => {
    used.add(name);
    const v = values[name];
    if (v === undefined) throw new TemplateError(`template ${id}: slot ${name} missing`);
    let s: string;
    try {
      s = typeof v === 'number' ? (kind === 'mb' ? v.toFixed(1) : fmtInt(v)) : v;
    } catch {
      throw new TemplateError(`template ${id}: slot ${name} rejected`);
    }
    if (typeof s !== 'string' || !(SLOTS[kind] as RegExp).test(s)) throw new TemplateError(`template ${id}: slot ${name} rejected`);
    return s;
  });
  for (const k of Object.keys(values)) if (!used.has(k)) throw new TemplateError(`template ${id}: unknown slot`);
  return out;
}

/** `codes` slot from a problem tally: ` (2 challenged, 1 timeout)`, sorted by count desc then code; '' when none. */
export function codesOf(tally: Readonly<Record<string, number>>): string {
  const parts = Object.entries(tally)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([code, n]) => `${fmtInt(n)} ${code}`);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let regexes: readonly RegExp[] | undefined;
/** The regex of each template, for the log audit. */
export function templateRegexes(): readonly RegExp[] {
  regexes ??= Object.values(TEMPLATES).map((t) => {
    let src = '';
    let last = 0;
    for (const m of t.matchAll(PLACEHOLDER)) {
      src += escapeRe(t.slice(last, m.index));
      const slot = (SLOTS[m[2] as string] as RegExp).source;
      src += `(?:${slot.replace(/^\^/, '').replace(/\$$/, '')})`;
      last = (m.index ?? 0) + m[0].length;
    }
    return new RegExp(`^${src}${escapeRe(t.slice(last))}$`);
  });
  return regexes;
}
export const isTemplateLine = (text: string): boolean => templateRegexes().some((r) => r.test(text));

/** Writes each line to `out` (stdout) and appends it to the job summary file when there is one. */
export function createGateway(o: { readonly out: (l: string) => void; readonly summaryFile?: string }): { emit(id: TemplateId, values: Readonly<Record<string, string | number>>): string } {
  return {
    emit(id, values) {
      const l = line(id, values);
      o.out(l);
      if (o.summaryFile) appendFileSync(o.summaryFile, `${l}\n`);
      return l;
    },
  };
}
