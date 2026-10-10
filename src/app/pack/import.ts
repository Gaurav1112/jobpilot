import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { sanitisePostingText, unsafePostingText } from '../agents/writing/templates.js';
import { type ProcessProbe, systemProbe, withLock } from '../lock.js';
import { ALL_REMOTE_SLUGS, DEFAULT_ELIGIBILITY, DEFAULT_FEEDS, DEFAULT_FILTERS, DEFAULT_FX, DEFAULT_LEXICON, DEFAULT_TARGETS } from './defaults.js';
import { loadPack, ongoingRoleTitles } from './load.js';
import { citeable, squashChars } from './rules.js';
import { forbiddenTermIn, glyphProblems, packTextProblems } from './scan.js';
import { FactStatus, FxSchema, WatchEntrySchema, type Answers, type Contact, type Fact, type Fx, type Role, type WatchEntry } from './schema.js';

/**
 * `jobpilot pack import` (Task 12, spec §3): builds the user pack once from
 * - career-ops `profile/facts.yaml` (claims verbatim, statuses copied, employers mapped through `--employer-display`,
 *   ids rewritten so none carries a forbidden term),
 * - the resume experience text (role headers `Title | Employer | City, Country | Mon YYYY - Mon YYYY|Present`),
 * - an optional `--education-text` file (`qualification | institution | period`, one per line, status user-stated),
 * - the Application Desk export (`settings/answers.json` and the board urls of `jobs/*.json`),
 * - flags for contact, naming, asOf, notice and availability, floor, fx and extra watchlist entries,
 * - the generic v2 defaults (`defaults.ts`) for lexicon, targets, filters, eligibility and feeds.
 *
 * Forbidden terms are checked two ways everywhere (`forbiddenTermIn`): word-bounded with homoglyph and stand-in
 * folding, and strictly, glued inside any token ("InitechPay", a URL path). A hit in user text is a hard error; ids
 * are rewritten instead (they are slugs).
 *
 * Every check runs before anything is written; all problems are reported together (`ImportError`). Under the daily
 * run's process lock, the files are written to a private staging directory (`<out>.staging-<ts>`, 0700, files 0600),
 * loaded with `loadPack` and scanned again (every file but naming.yaml); only a clean pack is moved into place (an old
 * one first moved to `<out>.bak-<ts>` under `force`, and moved back if the move-in fails). Any failure deletes the
 * staging directory, so a failed import leaves no output and never loses an existing pack.
 *
 * Privacy: no message or report line carries a claim, an answer value, a contact value, a forbidden term or an
 * undrawable character (terms by 1-based position, characters by code point, ids holding a term withheld).
 */

export class ImportError extends Error {
  override readonly name = 'ImportError';
  constructor(readonly problems: readonly string[]) {
    super(problems.length === 1 ? (problems[0] as string) : `pack import failed:\n  - ${problems.join('\n  - ')}`);
  }
}

export interface ImportOptions {
  /** The career-ops repo root; facts are read from `<careerOps>/profile/facts.yaml`. */
  readonly careerOps: string;
  readonly resumeText: string;
  /** The Application Desk export: `settings/answers.json` and `jobs/*.json`. */
  readonly desk: string;
  /** The pack directory to create. */
  readonly out: string;
  readonly forbid: readonly string[];
  /** `"<raw>=<display>"` entries. */
  readonly employerDisplay: readonly string[];
  readonly contact: Contact;
  /** YYYY-MM, written to experience.yaml (the daily run overrides it with the current month). */
  readonly asOf: string;
  readonly availableFrom: string;
  readonly noticePeriod: string;
  /** The base salary floor in INR a year. */
  readonly floorInr: number;
  readonly educationText?: string | undefined;
  readonly claimableTitles?: readonly string[] | undefined;
  readonly extraWatchlist?: string | undefined;
  readonly fxFile?: string | undefined;
  readonly force?: boolean | undefined;
  /** Proceed when citeable facts are unplaced because of an employer mismatch (normally a hard error). */
  readonly allowUnplaced?: boolean | undefined;
  /** The current time (ISO): the staging and backup names, and the age of stale staging directories. */
  readonly now: string;
  /** Where the process lock lives (the daily run's JOBPILOT_HOME); default: the output's parent directory. */
  readonly lockHome?: string | undefined;
}

/** Seams for tests: the rename used to swap the pack in, the lock's process probe, and a hook on the files to write. */
export interface ImportDeps {
  readonly rename?: (from: string, to: string) => void;
  readonly probe?: ProcessProbe;
  /** Called with the built files just before they are written (tests use it to reach the final scan). */
  readonly beforeWrite?: (files: Record<string, string>) => void;
}

export interface ImportReport {
  readonly out: string;
  readonly backup?: string;
  /** Stale staging directories removed before the import. */
  readonly staleRemoved: number;
  readonly facts: { readonly total: number; readonly byStatus: Record<string, number>; readonly byKind: Record<string, number> };
  readonly roles: number;
  /** Experience and project fact ids no resume role at their employer holds: they never become bullets. */
  readonly unplaced: string[];
  readonly unplacedByReason: { readonly employerMismatch: number; readonly outsideEveryRole: number };
  /** Fact ids whose claim writes "(RAG)" next to colour words (red/amber/green is clearer in a document). */
  readonly ragFacts: string[];
  readonly answers: { readonly written: number; readonly removedForbidden: string[]; readonly dropped: string[] };
  readonly watchlist: { readonly total: number; readonly fromDesk: number; readonly extra: number; readonly careers: number; readonly droppedForbidden: number };
  readonly warnings: string[];
}

export type ImportPlan = Omit<ImportReport, 'out' | 'backup' | 'staleRemoved'>;

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const PERIOD = /^(\d{4}-(?:0[1-9]|1[0-2]))\.\.(\d{4}-(?:0[1-9]|1[0-2])|present)$/;
const MAX_CONTACT_TOKEN = 60;
const STALE_STAGING_MS = 60 * 60 * 1000;
/** Keys that would be lost or dangerous as plain object keys; refused as employer names and dropped as answer keys. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const hasControl = (s: string): boolean => /\p{Cc}/u.test(s);

// ---------------------------------------------------------------------------------------------------------------
// Naming

/**
 * Words that may not be a forbidden term on their own (or make up every word of one): a forbidden term must be a
 * distinctive name, since every generated document is refused when it contains one. The lexicon's terms count too.
 */
const COMMON_WORDS: ReadonlySet<string> = new Set([
  ...'the and for with from that this into over under about after before than then them they their there what when where which while will would could should have been were your more most some such only also very much many'.split(' '),
  ...'company companies corp corporation group holding holdings inc incorporated limited ltd llc llp plc private pvt gmbh labs lab studio studios partners ventures capital'.split(' '),
  ...'tech technology technologies software systems system solutions solution services service global international digital data cloud network networks engineering consulting consultants analytics platform platforms product products enterprise enterprises industries works'.split(' '),
  ...'india indian japan bank finance financial health care retail commerce media energy mobile online web apps app team teams people work office remote hybrid'.split(' '),
  ...'engineer developer manager senior staff lead principal backend frontend fullstack code cert certified project projects client customer user users'.split(' '),
  ...[...DEFAULT_LEXICON.strong, ...DEFAULT_LEXICON.medium, ...DEFAULT_LEXICON.gap].flatMap((g) => [g.key, ...g.synonyms]),
]);

function checkForbidTerms(terms: readonly string[], problems: string[]): string[] {
  if (terms.length === 0) problems.push('at least one --forbid term is required (the client name that must never appear in any output)');
  const out: string[] = [];
  terms.forEach((raw, i) => {
    if (hasControl(raw)) {
      problems.push(`--forbid term #${i + 1} contains a control character (a line break or tab)`);
      return;
    }
    const t = raw.trim().replace(/\s+/gu, ' ');
    const letters = t.replace(/[^\p{L}\p{N}]/gu, '');
    if ([...letters].length < 4) {
      problems.push(`--forbid term #${i + 1} must have at least 4 characters (a short term would match ordinary words)`);
      return;
    }
    const words = t.toLowerCase().split(/[\s-]+/u).filter((w) => w !== '');
    if (words.every((w) => COMMON_WORDS.has(w))) {
      problems.push(`--forbid term #${i + 1} is a common word; use the distinctive name (it would refuse ordinary documents)`);
      return;
    }
    if (!out.includes(t)) out.push(t);
  });
  return out;
}

/** Parses `"<raw>=<display>"` entries (split at the first "="), into a prototype-free map. */
function parseEmployerDisplay(entries: readonly string[], problems: string[]): Record<string, string> {
  const map = Object.create(null) as Record<string, string>;
  entries.forEach((e, i) => {
    const at = e.indexOf('=');
    const raw = at < 0 ? '' : e.slice(0, at).trim();
    const display = at < 0 ? '' : e.slice(at + 1).trim();
    if (raw === '' || display === '') {
      problems.push(`--employer-display entry ${i + 1} must look like "<raw employer>=<display name>"`);
      return;
    }
    if (hasControl(e)) {
      problems.push(`--employer-display entry ${i + 1} contains a control character (a line break or tab)`);
      return;
    }
    if (RESERVED_KEYS.has(raw)) {
      problems.push(`--employer-display entry ${i + 1} uses a reserved name as the raw employer`);
      return;
    }
    if (Object.hasOwn(map, raw) && map[raw] !== display) problems.push(`--employer-display entry ${i + 1} maps an employer already mapped to another name`);
    map[raw] = display;
  });
  return map;
}

/** A kebab slug: accents dropped, lower case, every other run of characters a hyphen. */
export function slugOf(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `id` with every forbidden term inside it (strictly: folded, glued or not) replaced by `to`, hyphen-separated from
 * the letters around it, then repeated hyphens collapsed. `initechorders-01` → `<to>-orders-01`,
 * `northwindInitechOrders` → `northwind-<to>-Orders`.
 */
export function rewriteId(id: string, terms: readonly string[], to: string): string {
  let out = id;
  for (let guard = 0; guard < 50; guard++) {
    const { text, at } = squashChars(out);
    let span: { s: number; e: number } | undefined;
    for (const term of terms) {
      const want = squashChars(term).text;
      const k = want === '' ? -1 : text.indexOf(want);
      if (k < 0) continue;
      const last = at[k + want.length - 1] as number;
      span = { s: at[k] as number, e: last + ((out.codePointAt(last) ?? 0) > 0xffff ? 2 : 1) };
      break;
    }
    if (span === undefined) break;
    const before = out.slice(0, span.s);
    const after = out.slice(span.e);
    out = `${before}${/[\p{L}\p{N}]$/u.test(before) ? '-' : ''}${to}${/^[\p{L}\p{N}]/u.test(after) ? '-' : ''}${after}`;
  }
  return out.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------------------------------------------
// Resume roles

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FULL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "Dec 2025", "December 2025" or "Sept 2025" as "2025-12"; null otherwise. */
function monthYear(s: string): string | null {
  const m = /^([A-Za-z]+)\.?\s+(\d{4})$/.exec(s.trim());
  if (m === null) return null;
  const word = (m[1] as string).toLowerCase();
  const i = MONTHS.indexOf(word.slice(0, 3));
  if (i < 0) return null;
  if (word !== MONTHS[i] && word !== FULL_MONTHS[i] && !(i === 8 && word === 'sept')) return null;
  return `${m[2] as string}-${String(i + 1).padStart(2, '0')}`;
}

/** "Mon YYYY - Mon YYYY" or "Mon YYYY - Present" (hyphen, en or em dash, or "to"). */
function dateRange(s: string): { start: string; end: string } | null {
  const parts = s.trim().split(/\s*[-–—]\s*|\s+to\s+/iu);
  if (parts.length !== 2) return null;
  const start = monthYear(parts[0] as string);
  const endRaw = (parts[1] as string).trim();
  const end = /^(present|current|now)$/i.test(endRaw) ? 'present' : monthYear(endRaw);
  return start === null || end === null ? null : { start, end };
}

export interface ResumeRole {
  readonly title: string;
  readonly employer: string;
  readonly location: string;
  readonly start: string;
  readonly end: string;
  /** 1-based line number in the resume text. */
  readonly line: number;
}

/**
 * The role headers of the resume experience text: lines of exactly four `|`-separated fields,
 * `Title | Employer | City, Country | Mon YYYY - Mon YYYY|Present`. Titles are kept verbatim (also "Associate X,
 * promoted to Y"). Other lines are role body text and are ignored. Four-field lines whose dates do not read are
 * collected and thrown together (`ImportError`).
 */
export function parseResumeRoles(text: string): ResumeRole[] {
  const roles: ResumeRole[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const fields = raw.split('|').map((f) => f.trim().replace(/\s+/gu, ' '));
    if (fields.length !== 4) return;
    const [title, employer, location, dates] = fields as [string, string, string, string];
    const range = dateRange(dates);
    if (range === null || title === '' || employer === '') {
      problems.push(`resume line ${i + 1}: a role header must read "Title | Employer | City, Country | Mon YYYY - Mon YYYY" (or "- Present"); its dates or fields could not be read`);
      return;
    }
    roles.push({ title, employer, location, ...range, line: i + 1 });
  });
  if (problems.length > 0) throw new ImportError(problems);
  return roles;
}

// ---------------------------------------------------------------------------------------------------------------
// Facts

/** A career-ops fact (its src/facts/schema.ts), reading only the fields the pack needs; `kind` is optional. */
const CareerOpsFact = z.object({
  id: z.string().min(1),
  claim: z.string().min(1),
  tech: z.array(z.string().min(1)).default([]),
  employer: z.string().min(1),
  period: z.string().regex(PERIOD, 'expected YYYY-MM..YYYY-MM or YYYY-MM..present'),
  kind: z.enum(['experience', 'project', 'cert', 'education']).optional(),
  provenance: z.object({ status: FactStatus }),
});
const CareerOpsStore = z.object({ facts: z.array(CareerOpsFact) });

function readFile(path: string, what: string, problems: string[]): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    problems.push(`${what}: cannot read ${path}`);
    return undefined;
  }
}

function zodProblems(prefix: string, issues: z.ZodError['issues']): string[] {
  return issues.map((i) => `${prefix}: ${i.path.length > 0 ? i.path.map(String).join('.') : '(root)'}: ${i.message}`);
}

const monthIndex = (ym: string): number => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
function span(start: string, end: string, asOf: string): { s: number; e: number } {
  return { s: monthIndex(start), e: monthIndex(end === 'present' ? asOf : end) };
}

/** "(RAG)" with red, amber or green close by: the acronym is ambiguous in a document (retrieval-augmented generation). */
function writesRagColours(claim: string): boolean {
  for (const m of claim.matchAll(/\(\s*RAG\s*\)/g)) {
    const i = m.index;
    const near = claim.slice(Math.max(0, i - 60), i + m[0].length + 60);
    if (/\b(red|amber|green)\b/i.test(near)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Watchlist

/** The ATS board a Desk job url belongs to, or null for any other site (or an API url). */
export function boardOf(url: string): { ats: 'greenhouse' | 'lever' | 'ashby'; slug: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter((s) => s !== '').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const ok = (s: string | undefined | null): s is string => s !== undefined && s !== null && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s);
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    // boards-api.greenhouse.io/v1/boards/<slug>/...
    const slug = host.startsWith('boards-api.') ? (segs[0] === 'v1' && segs[1] === 'boards' ? segs[2] : undefined) : segs[0] === 'embed' ? u.searchParams.get('for') : segs[0];
    return ok(slug) ? { ats: 'greenhouse', slug: slug.toLowerCase() } : null;
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') return ok(segs[0]) ? { ats: 'lever', slug: segs[0].toLowerCase() } : null;
  if (host === 'jobs.ashbyhq.com') return ok(segs[0]) ? { ats: 'ashby', slug: segs[0] } : null;
  return null;
}

const watchKey = (w: { ats: string; slug: string }): string => `${w.ats}:${w.slug.toLowerCase()}`;
const ExtraWatchlist = z.union([z.strictObject({ watchlist: z.array(z.unknown()) }), z.array(z.unknown())]);

// ---------------------------------------------------------------------------------------------------------------
// Answers

/** A Desk answer key about pay (P2: compensation never enters the pack). */
const COMP_KEY = /ctc|salary|compensation|pay|package|lpa|stipend|bonus|rsu|equity|esop/i;
/** A value that looks like money: a currency symbol or code with digits, or LPA, lakh or crore. */
const MONEY_VALUE = /[₹$€£¥]\s*\d|\b(?:inr|usd|eur|gbp|rs)\.?\s*\d|\d[\d,.]*\s*(?:inr|usd|eur|gbp|lpa|lakhs?|lacs?|crores?|cr)\b|\blpa\b|\blakhs?\b|\bcrores?\b/i;

// ---------------------------------------------------------------------------------------------------------------
// The import

interface Built {
  readonly files: Record<string, string>;
  readonly naming: { readonly employerDisplay: Readonly<Record<string, string>>; readonly forbiddenTerms: readonly string[] };
  readonly report: ImportPlan;
}

const yamlOf = (header: string, value: unknown): string => `${header === '' ? '' : `${header.split('\n').map((l) => `# ${l}`).join('\n')}\n`}${stringify(value, { lineWidth: 0 })}`;

/** Reads every input and builds the pack files in memory; throws `ImportError` with every problem found. */
function build(o: ImportOptions): Built {
  const problems: string[] = [];
  const warnings: string[] = [];

  // Naming and flags.
  const forbiddenTerms = checkForbidTerms(o.forbid, problems);
  const map = parseEmployerDisplay(o.employerDisplay, problems);
  const naming = { employerDisplay: map, forbiddenTerms };
  if (problems.length > 0) throw new ImportError(problems);
  const termIn = (text: string): number | undefined => forbiddenTermIn(text, naming);
  Object.values(map).forEach((display, i) => {
    const n = termIn(display);
    if (n !== undefined) problems.push(`--employer-display entry ${i + 1} maps to a name that still holds forbidden term #${n}`);
    else if (slugOf(display) === '') problems.push(`--employer-display entry ${i + 1} maps to a name with no letters or digits`);
  });
  if (!YEAR_MONTH.test(o.asOf)) problems.push('--as-of must be a month, YYYY-MM');
  if (!Number.isSafeInteger(o.floorInr) || o.floorInr <= 0) problems.push('--floor-inr must be a positive whole number of rupees a year (e.g. 1200000)');
  if (problems.length > 0) throw new ImportError(problems);
  /** The display name of a raw employer: its mapping, else the raw name; undefined when that holds a term. */
  const display = (raw: string): string | undefined => {
    const shown = Object.hasOwn(map, raw) ? (map[raw] as string) : raw;
    return termIn(shown) === undefined ? shown : undefined;
  };

  // Roles.
  const resume = readFile(o.resumeText, '--resume-text', problems);
  let resumeRoles: ResumeRole[] = [];
  if (resume !== undefined) {
    try {
      resumeRoles = parseResumeRoles(resume);
    } catch (e) {
      if (!(e instanceof ImportError)) throw e;
      problems.push(...e.problems);
    }
    if (resumeRoles.length === 0 && problems.length === 0) problems.push('--resume-text: no role header found ("Title | Employer | City, Country | Mon YYYY - Mon YYYY")');
  }
  const roles: Role[] = [];
  for (const [i, r] of resumeRoles.entries()) {
    const where = `role ${i + 1} (resume line ${r.line})`;
    const employer = display(r.employer);
    if (employer === undefined) {
      problems.push(`${where}: the employer holds a forbidden term and has no --employer-display mapping`);
      continue;
    }
    for (const [field, value] of [['title', r.title], ['location', r.location]] as const) {
      const n = termIn(value);
      if (n !== undefined) problems.push(`${where}: the ${field} holds forbidden term #${n}`);
      problems.push(...glyphProblems(value, `${where} ${field}`));
    }
    problems.push(...glyphProblems(employer, `${where} employer`));
    if (r.end !== 'present' && r.end < r.start) problems.push(`${where}: ends before it starts`);
    roles.push({ employer, title: r.title, location: r.location, start: r.start, end: r.end });
  }

  // Facts from career-ops.
  const factsText = readFile(join(o.careerOps, 'profile', 'facts.yaml'), 'career-ops profile/facts.yaml', problems);
  let rawFacts: z.infer<typeof CareerOpsFact>[] = [];
  if (factsText !== undefined) {
    let doc: unknown;
    try {
      doc = parse(factsText);
    } catch {
      problems.push('career-ops profile/facts.yaml: invalid YAML');
    }
    const r = CareerOpsStore.safeParse(doc);
    if (r.success) rawFacts = r.data.facts;
    else if (doc !== undefined) problems.push(...zodProblems('career-ops profile/facts.yaml', r.error.issues));
  }
  const labelOf = (id: string, i: number): string => (termIn(id) === undefined ? `fact #${i + 1} (${id})` : `fact #${i + 1} (id withheld: it holds a forbidden term)`);
  // Source ids must be unique, ignoring case (m4); only collisions the rewriting creates get a suffix.
  const firstAt = new Map<string, number>();
  const dupSource = new Set<number>();
  rawFacts.forEach((f, i) => {
    const k = f.id.toLowerCase();
    const j = firstAt.get(k);
    if (j === undefined) firstAt.set(k, i);
    else {
      dupSource.add(i);
      problems.push(`${labelOf(f.id, i)}: duplicate id (the same as fact #${j + 1}, ignoring case)`);
    }
  });
  const keep = new Set(rawFacts.filter((f) => termIn(f.id) === undefined).map((f) => f.id.toLowerCase()));
  const taken = new Set<string>(keep);
  const facts: Fact[] = [];
  /** The raw career-ops employer of each written fact id (for the employer-mismatch suggestion). */
  const rawEmployerOf = new Map<string, string>();
  rawFacts.forEach((f, i) => {
    if (dupSource.has(i)) return;
    const label = labelOf(f.id, i);
    if (hasControl(f.employer)) problems.push(`${label}: the employer contains a control character`);
    const employer = display(f.employer);
    if (employer === undefined) {
      problems.push(`${label}: the employer holds a forbidden term and has no --employer-display mapping`);
      return;
    }
    let id = f.id;
    if (!keep.has(f.id.toLowerCase())) {
      id = rewriteId(f.id, forbiddenTerms, slugOf(employer));
      const still = termIn(id);
      if (id === '' || still !== undefined) {
        problems.push(`fact #${i + 1}: the id still holds forbidden term #${still ?? '?'} after rewriting; rename it in career-ops`);
        return;
      }
      const base = id;
      for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${base}-${n}`;
    }
    taken.add(id.toLowerCase());
    const [start, end] = f.period.split('..') as [string, string];
    if (end !== 'present' && end < start) problems.push(`fact ${id}: the period ends before it starts`);
    const kind: Fact['kind'] = f.id.startsWith('cert-') ? 'cert' : (f.kind ?? 'experience');
    const nClaim = termIn(f.claim);
    if (nClaim !== undefined) problems.push(`fact ${id}: the claim holds forbidden term #${nClaim}; edit the claim in career-ops (claims are the user's words and are never rewritten)`);
    f.tech.forEach((t, j) => {
      const n = termIn(t);
      if (n !== undefined) problems.push(`fact ${id}: tech entry ${j + 1} holds forbidden term #${n}`);
      if (hasControl(t)) problems.push(`fact ${id}: tech entry ${j + 1} contains a control character`);
      problems.push(...glyphProblems(t, `fact ${id} tech`));
    });
    problems.push(...glyphProblems(f.claim, `fact ${id}`));
    problems.push(...glyphProblems(employer, `fact ${id} employer`));
    facts.push({ id, claim: f.claim, tech: [...f.tech], employer, period: f.period, kind, status: f.provenance.status });
    rawEmployerOf.set(id, f.employer);
  });

  // Education facts.
  if (o.educationText !== undefined) {
    const text = readFile(o.educationText, '--education-text', problems);
    let n = 0;
    (text ?? '').split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) return;
      const where = `education line ${i + 1}`;
      const fields = line.split('|').map((x) => x.trim().replace(/\s+/gu, ' '));
      const [qual, inst, when] = fields as [string, string, string];
      const period = fields.length !== 3 ? null : PERIOD.test(when) ? when : ((r) => (r === null ? null : `${r.start}..${r.end}`))(dateRange(when));
      if (fields.length !== 3 || qual === '' || inst === '' || period === null) {
        problems.push(`${where}: expected "qualification | institution | YYYY-MM..YYYY-MM" (or "Mon YYYY - Mon YYYY")`);
        return;
      }
      if (hasControl(line)) problems.push(`${where}: contains a control character`);
      const employer = display(inst);
      if (employer === undefined) {
        problems.push(`${where}: the institution holds a forbidden term and has no --employer-display mapping`);
        return;
      }
      n++;
      let id = `edu-${String(n).padStart(2, '0')}`;
      for (let k = 2; taken.has(id); k++) id = `edu-${String(n).padStart(2, '0')}-${k}`;
      taken.add(id);
      const claim = `${qual}, ${employer}`;
      const hit = termIn(qual);
      if (hit !== undefined) problems.push(`${where}: the qualification holds forbidden term #${hit}`);
      problems.push(...glyphProblems(claim, `education fact ${id}`));
      facts.push({ id, claim, tech: [], employer, period, kind: 'education', status: 'user-stated' });
    });
  }

  // Role placement: a fact's role is the resume role at its display employer whose dates hold its whole period
  // (the newest when several do). An unplaced experience or project fact never becomes a bullet.
  // I5: when a citeable unplaced fact's display employer is no resume role's employer, yet exactly one role holds its
  // period by date, the two raw employer strings almost surely name the same place: a hard error suggesting the
  // mapping (unless --allow-unplaced). Any other unplaced fact (its period is outside every role at its employer) is
  // a warning.
  const newestFirst = [...roles].sort((a, b) => cmp(b.start, a.start));
  const roleEmployers = new Set(roles.map((r) => r.employer));
  const unplaced: string[] = [];
  const mismatch = new Map<string, { role: string; ids: string[] }[]>();
  let outsideEveryRole = 0;
  let employerMismatch = 0;
  for (const f of facts) {
    if (f.kind !== 'experience' && f.kind !== 'project') continue;
    const [start, end] = f.period.split('..') as [string, string];
    const fs = span(start, end, o.asOf);
    const holds = (r: Role): boolean => {
      const rs = span(r.start, r.end, o.asOf);
      return rs.s <= fs.s && fs.e <= rs.e;
    };
    const role = newestFirst.find((r) => r.employer === f.employer && holds(r));
    if (role !== undefined) {
      f.role = role.title;
      continue;
    }
    unplaced.push(f.id);
    const byDate = roles.filter(holds);
    const only = byDate[0];
    if (citeable(f) && !roleEmployers.has(f.employer) && byDate.length === 1 && only !== undefined) {
      employerMismatch++;
      const raw = rawEmployerOf.get(f.id) ?? f.employer;
      const groups = mismatch.get(raw) ?? [];
      const g = groups.find((x) => x.role === only.employer);
      if (g === undefined) groups.push({ role: only.employer, ids: [f.id] });
      else g.ids.push(f.id);
      mismatch.set(raw, groups);
    } else outsideEveryRole++;
  }
  unplaced.sort(cmp);
  if (mismatch.size > 0) {
    const lines = [...mismatch].flatMap(([raw, groups]) =>
      groups.map((g) => {
        const shownRaw = termIn(raw) === undefined && !raw.includes('"') ? raw : `<raw employer from career-ops fact ids ${g.ids.join(', ')}>`;
        return `${g.ids.length} citeable fact(s) (${g.ids.join(', ')}) sit under an employer no resume role names, yet fit exactly one resume role by date; map it: --employer-display "${shownRaw}=${g.role}"`;
      }),
    );
    if (o.allowUnplaced === true) warnings.push(...lines.map((l) => `employer mismatch (allowed by --allow-unplaced): ${l}`));
    else problems.push(...lines.map((l) => `${l} (or pass --allow-unplaced)`));
  }
  if (unplaced.length > 0) warnings.push(`unplaced facts (no resume role at their employer holds their whole period, so they never become bullets): ${unplaced.join(', ')}`);
  const ragFacts = facts.filter((f) => writesRagColours(f.claim)).map((f) => f.id);
  if (ragFacts.length > 0) warnings.push(`facts writing "(RAG)" next to colour words (write red/amber/green; RAG reads as retrieval-augmented generation): ${ragFacts.join(', ')}`);

  // Contact.
  const contact: Contact = { name: o.contact.name.trim(), email: o.contact.email.trim(), phone: o.contact.phone.trim(), city: o.contact.city.trim(), links: o.contact.links.map((l) => l.trim()) };
  const contactFields: [string, string][] = [
    ['name', contact.name],
    ['email', contact.email],
    ['phone', contact.phone],
    ['city', contact.city],
    ...contact.links.map((l, i): [string, string] => [`links[${i}]`, l]),
  ];
  for (const [field, value] of contactFields) {
    if (value === '') problems.push(`contact.${field} is empty`);
    if (hasControl(value)) problems.push(`contact.${field} contains a control character (a line break or tab); it must be one line`);
    if (value.split(/\s+/u).some((t) => [...t].length > MAX_CONTACT_TOKEN)) problems.push(`contact.${field} has a token longer than ${MAX_CONTACT_TOKEN} characters (it would overflow the document line)`);
    const n = termIn(value);
    if (n !== undefined) problems.push(`contact.${field} holds forbidden term #${n}`);
    problems.push(...glyphProblems(value, `contact.${field}`));
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) problems.push('contact.email is not an email address');
  if (contact.links.length === 0) problems.push('at least one --link is required');
  contact.links.forEach((l, i) => {
    try {
      const u = new URL(l);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    } catch {
      problems.push(`contact.links[${i}] is not an http(s) URL`);
    }
  });

  // Answers.
  const answers = Object.create(null) as Record<string, Answers[string]>;
  const removedForbidden: string[] = [];
  const dropped: string[] = [];
  const answersText = readFile(join(o.desk, 'settings', 'answers.json'), 'Desk settings/answers.json', problems);
  if (answersText !== undefined) {
    let doc: unknown;
    try {
      doc = JSON.parse(answersText);
    } catch {
      problems.push('Desk settings/answers.json: not valid JSON');
    }
    const data = isObj(doc) && isObj(doc['data']) ? doc['data'] : doc;
    if (doc !== undefined && !isObj(data)) problems.push('Desk settings/answers.json: expected an object of answers (or {data: {...}})');
    if (isObj(data)) {
      Object.entries(data).forEach(([key, value], i) => {
        if (key.startsWith('_')) return;
        const keyHit = termIn(key) !== undefined;
        const name = keyHit ? `answer #${i + 1}` : key;
        if (keyHit || (typeof value === 'string' && termIn(value) !== undefined)) {
          removedForbidden.push(name);
          return;
        }
        // P2 (I3): any pay-like key or money-like value is dropped, whatever the key is called.
        const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
        if (RESERVED_KEYS.has(key) || COMP_KEY.test(key) || !scalar || (typeof value === 'string' && MONEY_VALUE.test(value))) {
          dropped.push(name);
          return;
        }
        answers[key] = value;
      });
    }
  }
  for (const [key, flag, value] of [['available_from', '--available-from', o.availableFrom], ['notice_period', '--notice-period', o.noticePeriod]] as const) {
    const v = value.trim();
    if (v === '') problems.push(`${flag} is empty`);
    if (hasControl(v)) problems.push(`${flag} contains a control character (a line break or tab); it must be one line`);
    const n = termIn(v);
    if (n !== undefined) problems.push(`${flag} holds forbidden term #${n}`);
    problems.push(...glyphProblems(v, `answers.${key}`));
    answers[key] = v;
  }
  if (dropped.length > 0) warnings.push(`answers dropped (pay or money-like, or not a single value): ${dropped.join(', ')}`);
  if (removedForbidden.length > 0) warnings.push(`answers removed because they hold a forbidden term: ${removedForbidden.join(', ')}`);

  // Watchlist: the Desk's board urls, then the extra entries (an extra entry replaces a Desk one for the same board).
  const board = new Map<string, WatchEntry>();
  let badJobs = 0;
  let droppedForbidden = 0;
  const jobsDir = join(o.desk, 'jobs');
  if (!existsSync(jobsDir)) warnings.push('the Desk export has no jobs directory; the watchlist holds only the extra entries');
  else {
    const companies = new Map<string, Map<string, number>>();
    const firstSlug = new Map<string, { ats: WatchEntry['ats']; slug: string }>();
    for (const file of readdirSync(jobsDir).filter((f) => f.endsWith('.json')).sort(cmp)) {
      let job: unknown;
      try {
        job = JSON.parse(readFileSync(join(jobsDir, file), 'utf8'));
      } catch {
        badJobs++;
        continue;
      }
      const row = isObj(job) && isObj(job['data']) ? job['data'] : job;
      if (!isObj(row) || typeof row['url'] !== 'string') continue;
      const b = boardOf(row['url']);
      if (b === null) continue;
      const key = watchKey(b);
      if (!firstSlug.has(key)) firstSlug.set(key, b);
      const company = typeof row['company'] === 'string' && row['company'].trim() !== '' ? row['company'].trim().replace(/\s+/gu, ' ') : b.slug;
      const counts = companies.get(key) ?? new Map<string, number>();
      counts.set(company, (counts.get(company) ?? 0) + 1);
      companies.set(key, counts);
    }
    for (const [key, b] of firstSlug) {
      // the most frequent company spelling, ties to the first in sort order
      const company = [...(companies.get(key) ?? new Map<string, number>())].sort((x, y) => y[1] - x[1] || cmp(x[0], y[0]))[0]?.[0] ?? b.slug;
      if (termIn(company) !== undefined || termIn(b.slug) !== undefined) {
        droppedForbidden++;
        continue;
      }
      board.set(key, { company, ats: b.ats, slug: b.slug, hiresInIndia: true, allRemote: ALL_REMOTE_SLUGS.includes(b.slug.toLowerCase()) });
    }
  }
  const fromDesk = board.size;
  if (badJobs > 0) warnings.push(`${badJobs} Desk job ${badJobs === 1 ? 'file is' : 'files are'} not valid JSON and ${badJobs === 1 ? 'was' : 'were'} skipped`);
  if (droppedForbidden > 0) warnings.push(`${droppedForbidden} Desk ${droppedForbidden === 1 ? 'board was' : 'boards were'} left out of the watchlist: the company or slug holds a forbidden term`);
  let extra = 0;
  if (o.extraWatchlist !== undefined) {
    const text = readFile(o.extraWatchlist, '--extra-watchlist', problems);
    if (text !== undefined) {
      let doc: unknown;
      try {
        doc = parse(text);
      } catch {
        problems.push('--extra-watchlist: invalid YAML');
      }
      const r = ExtraWatchlist.safeParse(doc);
      if (!r.success) problems.push('--extra-watchlist: expected {watchlist: [entries]} or a list of entries');
      else {
        (Array.isArray(r.data) ? r.data : r.data.watchlist).forEach((e, i) => {
          const w = WatchEntrySchema.safeParse(e);
          if (!w.success) {
            problems.push(...zodProblems(`--extra-watchlist entry ${i + 1}`, w.error.issues));
            return;
          }
          const n = termIn([w.data.company, w.data.slug, w.data.listUrl ?? '', w.data.linkPattern ?? ''].join('\n'));
          if (n !== undefined) {
            problems.push(`--extra-watchlist entry ${i + 1} holds forbidden term #${n}`);
            return;
          }
          board.set(watchKey(w.data), w.data);
          extra++;
        });
      }
    }
  }
  const watchlist = [...board.values()].sort((a, b) => cmp(a.ats, b.ats) || cmp(a.slug.toLowerCase(), b.slug.toLowerCase()) || cmp(a.slug, b.slug));

  // fx.
  let fx: Fx = DEFAULT_FX;
  if (o.fxFile !== undefined) {
    const text = readFile(o.fxFile, '--fx-file', problems);
    if (text !== undefined) {
      let doc: unknown;
      try {
        doc = parse(text);
      } catch {
        problems.push('--fx-file: invalid YAML');
      }
      const r = FxSchema.safeParse(doc);
      if (r.success) fx = r.data;
      else problems.push(...zodProblems('--fx-file', r.error.issues));
    }
  } else {
    warnings.push(`fx.yaml: the pinned default rates are written with asOf ${DEFAULT_FX.asOf}, so the dashboard warns they are stale; write today's rates (edit fx.yaml, or re-import with --fx-file)`);
  }

  // Claimable titles: the ongoing roles' titles (the loader's default), then the extra flags, each a safe slot.
  let claimableTitles: string[] | undefined;
  if (o.claimableTitles !== undefined && o.claimableTitles.length > 0) {
    const titles = ongoingRoleTitles(roles);
    o.claimableTitles.forEach((t, i) => {
      const clean = sanitisePostingText(t);
      const why = unsafePostingText(clean);
      if (why !== null) {
        problems.push(`--claimable-title ${i + 1} is not a safe title (${why})`);
        return;
      }
      const n = termIn(clean);
      if (n !== undefined) problems.push(`--claimable-title ${i + 1} holds forbidden term #${n}`);
      problems.push(...glyphProblems(clean, `--claimable-title ${i + 1}`));
      if (!titles.includes(clean)) titles.push(clean);
    });
    claimableTitles = titles;
  }

  if (problems.length > 0) throw new ImportError(problems);

  const count = (xs: readonly string[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const x of [...xs].sort(cmp)) out[x] = (out[x] ?? 0) + 1;
    return out;
  };
  const files: Record<string, string> = {
    'contact.yaml': yamlOf('Contact details (P1): read only by the renderer. From the pack import flags.', contact),
    'facts.yaml': yamlOf(
      [
        'Facts (P0). Built by jobpilot pack import from career-ops profile/facts.yaml: claims verbatim, statuses copied,',
        'employers shown by their display name. Education facts (edu-*) come from --education-text, status user-stated.',
        `Only verified and user-stated facts are citeable (${facts.filter(citeable).length} of ${facts.length}); verify the rest on the dashboard.`,
      ].join('\n'),
      { facts },
    ),
    'roles.yaml': yamlOf('Employment history (P0), from the resume role headers, newest first as written there.', { roles }),
    'experience.yaml': yamlOf('The month years of experience are measured to. The daily run injects the current month instead.', { asOf: o.asOf }),
    'eligibility.yaml': yamlOf('', DEFAULT_ELIGIBILITY),
    'lexicon.yaml': yamlOf('v2 discovery rules §6 skill groups; display is how documents show the term.', DEFAULT_LEXICON),
    'targets.yaml': yamlOf(
      'v2 discovery rules §6 title scoring. claimableTitles, when absent, defaults to the ongoing roles\' titles.',
      claimableTitles === undefined ? DEFAULT_TARGETS : { ...DEFAULT_TARGETS, claimableTitles },
    ),
    'filters.yaml': yamlOf(
      'v2 discovery rules §5 hard excludes. employmentDeny: words that reject only when they label the job title\n("(Contract)", "... - 6 months", "Contract Java Developer"); descriptions are checked with fixed phrases.',
      DEFAULT_FILTERS,
    ),
    'naming.yaml': yamlOf('Never commit or share this file: it names the forbidden terms.', { employerDisplay: { ...map }, forbiddenTerms }),
    'offers.yaml': yamlOf('The floor is base salary only; equity, RSUs, bonus and total compensation never count.', {
      floor: { amount: o.floorInr, currency: 'INR', period: 'year', basis: 'base' },
    }),
    'fx.yaml': yamlOf('Rates to INR; the dashboard warns when asOf is more than 30 days old.', fx),
    'answers.yaml': yamlOf('Screening answers (P1), from the Desk settings. Only notice_period may appear in a document.', { ...answers }),
    'watchlist.yaml': yamlOf('Boards to watch: the Desk job boards (all found as remote-India), plus the extra verified entries.', { watchlist }),
    'feeds.yaml': yamlOf('', DEFAULT_FEEDS),
    'policy.user.yaml': yamlOf('Tightening-only policy overrides (kernel mergePolicy).', {}),
  };
  return {
    files,
    naming,
    report: {
      facts: { total: facts.length, byStatus: count(facts.map((f) => f.status)), byKind: count(facts.map((f) => f.kind)) },
      roles: roles.length,
      unplaced,
      unplacedByReason: { employerMismatch, outsideEveryRole },
      ragFacts,
      answers: { written: Object.keys(answers).length, removedForbidden, dropped },
      watchlist: { total: watchlist.length, fromDesk, extra, careers: watchlist.filter((w) => w.ats === 'careers').length, droppedForbidden },
      warnings,
    },
  };
}

/**
 * Every input check of the import, writing nothing: the report the import would print, or `ImportError`. The checks
 * that need written files (`loadPack`, the final scan) run only in `importPack`.
 */
export function planImport(o: ImportOptions): ImportPlan {
  return build(o).report;
}

/** "2026-10-09T08:30:00.000Z" as "20261009T083000Z". */
const stamp = (iso: string): string => iso.replace(/\.\d+(?=Z$)/, '').replace(/[-:]/g, '');

/** `base`, or `base-2`, `base-3`, ... : the first that does not exist yet. */
function freePath(base: string): string {
  let p = base;
  for (let n = 2; existsSync(p); n++) p = `${base}-${n}`;
  return p;
}

/**
 * Removes `<out>.staging-*` siblings older than an hour. They are left by a crashed import and may hold P1 data. The
 * import holds the process lock while it runs, so no live import owns one; the hour spares a directory whose import
 * lost the lock race in some unforeseen way.
 */
function removeStaleStaging(out: string, now: string): number {
  const dir = dirname(out);
  if (!existsSync(dir)) return 0;
  const prefix = `${basename(out)}.staging-`;
  const nowMs = Date.parse(now);
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).mtimeMs < nowMs - STALE_STAGING_MS) {
        rmSync(p, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // vanished meanwhile
    }
  }
  return removed;
}

/**
 * Builds the pack and writes it to `o.out`, holding the daily run's process lock (`o.lockHome`). Throws `ImportError`
 * (nothing written, an existing pack kept) on any problem: bad input, a forbidden term, an undrawable character, a
 * pack `loadPack` refuses, or a forbidden term (word-bounded or glued) in any written file but naming.yaml.
 */
export async function importPack(o: ImportOptions, deps: ImportDeps = {}): Promise<ImportReport> {
  return withLock(o.lockHome ?? dirname(o.out), 'pack import', async () => importLocked(o, deps), deps.probe ?? systemProbe);
}

function importLocked(o: ImportOptions, deps: ImportDeps): ImportReport {
  const rename = deps.rename ?? renameSync;
  const staleRemoved = removeStaleStaging(o.out, o.now);
  if (existsSync(o.out) && o.force !== true) throw new ImportError([`${o.out} already exists; pass --force to move it to ${basename(o.out)}.bak-<timestamp> and import again`]);
  const built = build(o);
  deps.beforeWrite?.(built.files);
  const ts = stamp(o.now);
  mkdirSync(dirname(o.out), { recursive: true, mode: 0o700 });
  const staging = freePath(`${o.out}.staging-${ts}`);
  try {
    mkdirSync(staging, { mode: 0o700 });
    for (const [name, text] of Object.entries(built.files)) writeFileSync(join(staging, name), text, { mode: 0o600 });
    let loaded: ReturnType<typeof loadPack>;
    try {
      loaded = loadPack(staging, {}, { asOf: o.asOf });
    } catch (e) {
      throw new ImportError([`the written pack does not load: ${e instanceof Error ? e.message : String(e)}`]);
    }
    const hits = Object.keys(built.files)
      .filter((name) => name !== 'naming.yaml')
      .sort(cmp)
      .flatMap((name) => {
        const n = forbiddenTermIn(readFileSync(join(staging, name), 'utf8'), built.naming);
        return n === undefined ? [] : [`${name} holds forbidden term #${n}; nothing was written`];
      });
    hits.push(...packTextProblems(loaded.pack));
    if (hits.length > 0) throw new ImportError(hits);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  let backup: string | undefined;
  if (existsSync(o.out)) {
    backup = freePath(join(dirname(o.out), `${basename(o.out)}.bak-${ts}`));
    try {
      rename(o.out, backup);
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw new ImportError([`could not move the existing pack ${o.out} aside (${e instanceof Error ? e.message : String(e)}); nothing changed`]);
    }
  }
  try {
    rename(staging, o.out);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (backup === undefined) {
      rmSync(staging, { recursive: true, force: true });
      throw new ImportError([`could not move the new pack into ${o.out} (${why}); nothing was written`]);
    }
    try {
      rename(backup, o.out);
    } catch (e2) {
      throw new ImportError([
        `could not move the new pack into ${o.out} (${why}), nor restore the old one (${e2 instanceof Error ? e2.message : String(e2)}): the old pack is at ${backup} and the validated new pack at ${staging}; move one of them to ${o.out}`,
      ]);
    }
    rmSync(staging, { recursive: true, force: true });
    throw new ImportError([`could not move the new pack into ${o.out} (${why}); the old pack was moved back from ${backup} to ${o.out}`]);
  }
  return { out: o.out, ...(backup !== undefined ? { backup } : {}), staleRemoved, ...built.report };
}

/** The report as printable lines: counts, ids and answer keys only. */
export function formatImportReport(r: ImportPlan & { out?: string; backup?: string; staleRemoved?: number }): string[] {
  const kv = (m: Record<string, number>): string =>
    Object.entries(m)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
  return [
    r.out !== undefined ? `pack written: ${r.out}` : 'dry run: every input check passed; nothing was written',
    ...(r.backup !== undefined ? [`previous pack moved to ${r.backup}`] : []),
    ...(r.staleRemoved !== undefined && r.staleRemoved > 0 ? [`stale staging directories removed: ${r.staleRemoved}`] : []),
    `facts ${r.facts.total} (by status: ${kv(r.facts.byStatus)}; by kind: ${kv(r.facts.byKind)})`,
    `roles ${r.roles}`,
    `unplaced facts ${r.unplaced.length} (employer mismatch ${r.unplacedByReason.employerMismatch}, outside every role ${r.unplacedByReason.outsideEveryRole})`,
    `answers ${r.answers.written} written, ${r.answers.dropped.length} dropped, ${r.answers.removedForbidden.length} removed for a forbidden term`,
    `watchlist ${r.watchlist.total} entries (${r.watchlist.fromDesk} from the Desk, ${r.watchlist.extra} extra, ${r.watchlist.careers} careers; ${r.watchlist.droppedForbidden} left out for a forbidden term)`,
    `warnings ${r.warnings.length}`,
    ...r.warnings.map((w) => `  - ${w}`),
  ];
}
