import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { sanitisePostingText, unsafePostingText } from '../agents/writing/templates.js';
import { uncoveredGlyph } from '../render/pdf.js';
import { ALL_REMOTE_SLUGS, DEFAULT_ELIGIBILITY, DEFAULT_FEEDS, DEFAULT_FILTERS, DEFAULT_FX, DEFAULT_LEXICON, DEFAULT_TARGETS } from './defaults.js';
import { loadPack, ongoingRoleTitles } from './load.js';
import { assertNoForbidden, citeable, employerDisplay, EmployerNameError, ForbiddenTermError, type NamingRules } from './rules.js';
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
 * Every check runs before anything is written; all problems are reported together (`ImportError`). The files are then
 * written to a staging directory next to the output, loaded with `loadPack` and scanned for forbidden terms (every file
 * but naming.yaml); only a clean pack is moved into place (an old one first moved to `<out>.bak-<timestamp>` under
 * `force`). Any failure deletes the staging directory, so a failed import leaves no output and never touches an
 * existing pack.
 *
 * Privacy: no message or report line carries a claim, an answer value, a contact value or a forbidden term (terms are
 * named by their 1-based position, ids holding one are withheld).
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
  /** The current time (ISO), for the backup directory name only. */
  readonly now: string;
}

export interface ImportReport {
  readonly out: string;
  readonly backup?: string;
  readonly facts: { readonly total: number; readonly byStatus: Record<string, number>; readonly byKind: Record<string, number> };
  readonly roles: number;
  /** Experience and project fact ids no resume role at their employer covers: they never become bullets. */
  readonly unplaced: string[];
  /** Fact ids whose claim writes "(RAG)" next to colour words (red/amber/green is clearer in a document). */
  readonly ragFacts: string[];
  readonly answers: { readonly written: number; readonly removedForbidden: string[]; readonly dropped: string[] };
  readonly watchlist: { readonly total: number; readonly fromDesk: number; readonly extra: number; readonly careers: number; readonly droppedForbidden: number };
  readonly warnings: string[];
}

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const PERIOD = /^(\d{4}-(?:0[1-9]|1[0-2]))\.\.(\d{4}-(?:0[1-9]|1[0-2])|present)$/;
const MAX_CONTACT_TOKEN = 60;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

/** Parses `"<raw>=<display>"` entries (split at the first "="). */
function parseEmployerDisplay(entries: readonly string[], problems: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  entries.forEach((e, i) => {
    const at = e.indexOf('=');
    const raw = at < 0 ? '' : e.slice(0, at).trim();
    const display = at < 0 ? '' : e.slice(at + 1).trim();
    if (raw === '' || display === '') {
      problems.push(`--employer-display entry ${i + 1} must look like "<raw employer>=<display name>"`);
      return;
    }
    if (Object.hasOwn(map, raw) && map[raw] !== display) problems.push(`--employer-display entry ${i + 1} maps an employer already mapped to another name`);
    map[raw] = display;
  });
  return map;
}

/** The 1-based index of the forbidden term in `text`, or undefined. */
function forbiddenIn(text: string, naming: NamingRules): number | undefined {
  try {
    assertNoForbidden(text, naming);
    return undefined;
  } catch (e) {
    if (e instanceof ForbiddenTermError) return naming.forbiddenTerms.indexOf(e.term) + 1;
    throw e;
  }
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

// ---------------------------------------------------------------------------------------------------------------
// Glyphs

/** What to write instead of a character Noto Sans cannot draw. */
const GLYPH_HINTS: Readonly<Record<number, string>> = {
  0x2192: "replace with 'to'",
  0x2190: "replace with 'from'",
  0x2194: "replace with 'and'",
  0x21d2: "replace with 'so'",
  0x2265: "replace with 'at least'",
  0x2264: "replace with 'at most'",
  0x2248: "replace with 'about'",
  0x2260: "replace with 'not'",
  0x2713: 'remove it',
  0x2714: 'remove it',
  0x2717: 'remove it',
  0x2605: 'remove it',
  0x09: 'replace with a space',
};

/** One problem per distinct character in `text` the embedded fonts cannot draw. */
function glyphProblems(text: string, where: string, problems: string[]): void {
  const seen = new Set<string>();
  for (const ch of text) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    const bad = uncoveredGlyph([ch]);
    if (bad === null) continue;
    const cp = ch.codePointAt(0) ?? 0;
    const shown = /[\p{L}\p{N}\p{P}\p{S}]/u.test(ch) ? `${ch} ` : '';
    problems.push(`${shown}${bad} in ${where}: ${GLYPH_HINTS[cp] ?? 'replace or remove it'} (the embedded font cannot draw it)`);
  }
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
 * promoted to Y"). Other lines are role body text and are ignored. A four-field line whose dates do not read throws.
 */
export function parseResumeRoles(text: string): ResumeRole[] {
  const roles: ResumeRole[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const fields = raw.split('|').map((f) => f.trim().replace(/\s+/gu, ' '));
    if (fields.length !== 4) return;
    const [title, employer, location, dates] = fields as [string, string, string, string];
    const range = dateRange(dates);
    if (range === null || title === '' || employer === '') {
      throw new ImportError([`resume line ${i + 1}: a role header must read "Title | Employer | City, Country | Mon YYYY - Mon YYYY" (or "- Present"); its dates or fields could not be read`]);
    }
    roles.push({ title, employer, location, ...range, line: i + 1 });
  });
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

/** The ATS board a Desk job url belongs to, or null for any other site. */
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
    const slug = segs[0] === 'embed' ? u.searchParams.get('for') : segs[0];
    return ok(slug) ? { ats: 'greenhouse', slug: slug.toLowerCase() } : null;
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') return ok(segs[0]) ? { ats: 'lever', slug: segs[0].toLowerCase() } : null;
  if (host === 'jobs.ashbyhq.com') return ok(segs[0]) ? { ats: 'ashby', slug: segs[0] } : null;
  return null;
}

const watchKey = (w: { ats: string; slug: string }): string => `${w.ats}:${w.slug.toLowerCase()}`;
const ExtraWatchlist = z.union([z.strictObject({ watchlist: z.array(z.unknown()) }), z.array(z.unknown())]);

// ---------------------------------------------------------------------------------------------------------------
// The import

/** Desk answers that never enter the pack (P2: compensation is never shown in a document). */
const DROPPED_ANSWERS: readonly string[] = ['current_ctc', 'expected_ctc'];

interface Built {
  readonly files: Record<string, string>;
  readonly naming: NamingRules;
  readonly report: Omit<ImportReport, 'out' | 'backup'>;
}

const yamlOf = (header: string, value: unknown): string => `${header === '' ? '' : `${header.split('\n').map((l) => `# ${l}`).join('\n')}\n`}${stringify(value, { lineWidth: 0 })}`;

/** Reads every input and builds the pack files in memory; throws `ImportError` with every problem found. */
function build(o: ImportOptions): Built {
  const problems: string[] = [];
  const warnings: string[] = [];

  // Naming and flags.
  const forbiddenTerms = checkForbidTerms(o.forbid, problems);
  const map = parseEmployerDisplay(o.employerDisplay, problems);
  const naming: NamingRules = { employerDisplay: map, forbiddenTerms };
  if (problems.length > 0) throw new ImportError(problems);
  Object.values(map).forEach((display, i) => {
    const n = forbiddenIn(display, naming);
    if (n !== undefined) problems.push(`--employer-display entry ${i + 1} maps to a name that still holds forbidden term #${n}`);
  });
  if (!YEAR_MONTH.test(o.asOf)) problems.push('--as-of must be a month, YYYY-MM');
  if (!Number.isSafeInteger(o.floorInr) || o.floorInr <= 0) problems.push('--floor-inr must be a positive whole number of rupees a year (e.g. 1200000)');
  if (problems.length > 0) throw new ImportError(problems);
  const display = (raw: string): string | undefined => {
    try {
      return employerDisplay(raw, naming);
    } catch (e) {
      if (e instanceof EmployerNameError) return undefined;
      throw e;
    }
  };

  // Roles.
  const resume = readFile(o.resumeText, '--resume-text', problems);
  const resumeRoles = resume === undefined ? [] : parseResumeRoles(resume);
  if (resume !== undefined && resumeRoles.length === 0) problems.push('--resume-text: no role header found ("Title | Employer | City, Country | Mon YYYY - Mon YYYY")');
  const roles: Role[] = [];
  for (const [i, r] of resumeRoles.entries()) {
    const where = `role ${i + 1} (resume line ${r.line})`;
    const employer = display(r.employer);
    if (employer === undefined) {
      problems.push(`${where}: the employer holds a forbidden term and has no --employer-display mapping`);
      continue;
    }
    for (const [field, value] of [['title', r.title], ['location', r.location]] as const) {
      const n = forbiddenIn(value, naming);
      if (n !== undefined) problems.push(`${where}: the ${field} holds forbidden term #${n}`);
      glyphProblems(value, `${where} ${field}`, problems);
    }
    glyphProblems(employer, `${where} employer`, problems);
    if (r.end !== 'present' && r.end < r.start) problems.push(`${where}: ends before it starts`);
    roles.push({ employer, title: r.title, location: r.location, start: r.start, end: r.end });
  }

  // Facts from career-ops.
  const factsPath = join(o.careerOps, 'profile', 'facts.yaml');
  const factsText = readFile(factsPath, 'career-ops profile/facts.yaml', problems);
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
  // Ids: a forbidden term inside an id becomes the display employer's slug; rewritten ids never collide.
  const keep = new Set(rawFacts.filter((f) => forbiddenIn(f.id, naming) === undefined).map((f) => f.id));
  const taken = new Set<string>(keep);
  const facts: Fact[] = [];
  rawFacts.forEach((f, i) => {
    const idClean = keep.has(f.id);
    const label = `fact #${i + 1} (${idClean ? f.id : 'id withheld: it holds a forbidden term'})`;
    const employer = display(f.employer);
    if (employer === undefined) {
      problems.push(`${label}: the employer holds a forbidden term and has no --employer-display mapping`);
      return;
    }
    let id = f.id;
    if (!idClean) {
      const to = slugOf(employer);
      for (const term of forbiddenTerms) {
        const from = slugOf(term);
        if (from !== '') id = id.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), to);
      }
      id = id.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
      const still = forbiddenIn(id, naming);
      if (id === '' || still !== undefined) {
        problems.push(`fact #${i + 1}: the id still holds forbidden term #${still ?? '?'} after rewriting; rename it in career-ops`);
        return;
      }
      const base = id;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    } else if (facts.some((x) => x.id === id)) {
      problems.push(`fact #${i + 1}: duplicate id ${id}`);
      return;
    }
    taken.add(id);
    const [start, end] = f.period.split('..') as [string, string];
    if (end !== 'present' && end < start) problems.push(`fact ${id}: the period ends before it starts`);
    const kind: Fact['kind'] = f.id.startsWith('cert-') ? 'cert' : (f.kind ?? 'experience');
    const nClaim = forbiddenIn(f.claim, naming);
    if (nClaim !== undefined) problems.push(`fact ${id}: the claim holds forbidden term #${nClaim}; edit the claim in career-ops (claims are the user's words and are never rewritten)`);
    f.tech.forEach((t, j) => {
      const n = forbiddenIn(t, naming);
      if (n !== undefined) problems.push(`fact ${id}: tech entry ${j + 1} holds forbidden term #${n}`);
      glyphProblems(t, `fact ${id} tech`, problems);
    });
    glyphProblems(f.claim, `fact ${id}`, problems);
    glyphProblems(employer, `fact ${id} employer`, problems);
    facts.push({ id, claim: f.claim, tech: [...f.tech], employer, period: f.period, kind, status: f.provenance.status });
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
      const hit = forbiddenIn(qual, naming);
      if (hit !== undefined) problems.push(`${where}: the qualification holds forbidden term #${hit}`);
      glyphProblems(claim, `education fact ${id}`, problems);
      facts.push({ id, claim, tech: [], employer, period, kind: 'education', status: 'user-stated' });
    });
  }

  // Role placement: a fact's role is the resume role at its display employer whose dates hold its whole period
  // (the newest when several do). Experience and project facts no role holds are reported: they never become bullets.
  const newestFirst = [...roles].sort((a, b) => cmp(b.start, a.start));
  const unplaced: string[] = [];
  if (YEAR_MONTH.test(o.asOf)) {
    for (const f of facts) {
      if (f.kind !== 'experience' && f.kind !== 'project') continue;
      const [start, end] = f.period.split('..') as [string, string];
      const fs = span(start, end, o.asOf);
      const role = newestFirst.find((r) => {
        const rs = span(r.start, r.end, o.asOf);
        return r.employer === f.employer && rs.s <= fs.s && fs.e <= rs.e;
      });
      if (role !== undefined) f.role = role.title;
      else unplaced.push(f.id);
    }
  }
  unplaced.sort(cmp);
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
    if (value.split(/\s+/u).some((t) => [...t].length > MAX_CONTACT_TOKEN)) problems.push(`contact.${field} has a token longer than ${MAX_CONTACT_TOKEN} characters (it would overflow the document line)`);
    const n = forbiddenIn(value, naming);
    if (n !== undefined) problems.push(`contact.${field} holds forbidden term #${n}`);
    glyphProblems(value, `contact.${field}`, problems);
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
  const answers: Record<string, Answers[string]> = {};
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
        if (DROPPED_ANSWERS.includes(key)) {
          dropped.push(key);
          return;
        }
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          if (forbiddenIn(key, naming) === undefined) dropped.push(key);
          else dropped.push(`answer #${i + 1}`);
          return;
        }
        const keyHit = forbiddenIn(key, naming) !== undefined;
        if (keyHit || forbiddenIn(String(value), naming) !== undefined) {
          removedForbidden.push(keyHit ? `answer #${i + 1}` : key);
          return;
        }
        answers[key] = value;
      });
    }
  }
  for (const [key, flag, value] of [['available_from', '--available-from', o.availableFrom], ['notice_period', '--notice-period', o.noticePeriod]] as const) {
    const v = value.trim();
    if (v === '') problems.push(`${flag} is empty`);
    const n = forbiddenIn(v, naming);
    if (n !== undefined) problems.push(`${flag} holds forbidden term #${n}`);
    glyphProblems(v, `answers.${key}`, problems);
    answers[key] = v;
  }
  if (dropped.length > 0) warnings.push(`answers dropped (compensation, or not a single value): ${dropped.join(', ')}`);
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
      if (forbiddenIn(company, naming) !== undefined || forbiddenIn(b.slug, naming) !== undefined) {
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
    claimableTitles = ongoingRoleTitles(roles);
    o.claimableTitles.forEach((t, i) => {
      const clean = sanitisePostingText(t);
      const why = unsafePostingText(clean);
      if (why !== null) {
        problems.push(`--claimable-title ${i + 1} is not a safe title (${why})`);
        return;
      }
      const n = forbiddenIn(clean, naming);
      if (n !== undefined) problems.push(`--claimable-title ${i + 1} holds forbidden term #${n}`);
      glyphProblems(clean, `--claimable-title ${i + 1}`, problems);
      if (!claimableTitles?.includes(clean)) claimableTitles?.push(clean);
    });
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
      'v2 discovery rules §5 hard excludes. employmentDeny: words that reject only when they label the job title\n("(Contract)", "... - Freelance", "Contract Java Developer"); descriptions are checked with fixed phrases.',
      DEFAULT_FILTERS,
    ),
    'naming.yaml': yamlOf('Never commit or share this file: it names the forbidden terms.', { employerDisplay: map, forbiddenTerms }),
    'offers.yaml': yamlOf('The floor is base salary only; equity, RSUs, bonus and total compensation never count.', {
      floor: { amount: o.floorInr, currency: 'INR', period: 'year', basis: 'base' },
    }),
    'fx.yaml': yamlOf('Rates to INR; the dashboard warns when asOf is more than 30 days old.', fx),
    'answers.yaml': yamlOf(
      'Screening answers (P1), from the Desk settings. Only available_from and notice_period may appear in a document.',
      answers,
    ),
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
      ragFacts,
      answers: { written: Object.keys(answers).length, removedForbidden, dropped },
      watchlist: { total: watchlist.length, fromDesk, extra, careers: watchlist.filter((w) => w.ats === 'careers').length, droppedForbidden },
      warnings,
    },
  };
}

/**
 * Every input check of the import, writing nothing: the report the import would print, or `ImportError`. The checks
 * that need written files (`loadPack`, the final forbidden-term scan) run only in `importPack`.
 */
export function planImport(o: ImportOptions): Omit<ImportReport, 'out' | 'backup'> {
  return build(o).report;
}

/** "2026-10-09T08:30:00.000Z" as "20261009T083000Z". */
const stamp = (iso: string): string => iso.replace(/\.\d+(?=Z$)/, '').replace(/[-:]/g, '');

/** A path next to `base` with `suffix` that does not exist yet. */
function freePath(base: string): string {
  let p = base;
  for (let n = 2; existsSync(p); n++) p = `${base}-${n}`;
  return p;
}

/**
 * Builds the pack and writes it to `o.out`. Throws `ImportError` (nothing written, an existing pack untouched) on any
 * problem: bad input, a forbidden term, an undrawable character, a pack `loadPack` refuses, or a forbidden term in any
 * written file but naming.yaml.
 */
export function importPack(o: ImportOptions): ImportReport {
  if (existsSync(o.out) && o.force !== true) throw new ImportError([`${o.out} already exists; pass --force to move it to ${basename(o.out)}.bak-<timestamp> and import again`]);
  const built = build(o);
  const ts = stamp(o.now);
  mkdirSync(dirname(o.out), { recursive: true });
  const staging = freePath(`${o.out}.import-${ts}`);
  try {
    mkdirSync(staging);
    for (const [name, text] of Object.entries(built.files)) writeFileSync(join(staging, name), text);
    try {
      loadPack(staging, {}, { asOf: o.asOf });
    } catch (e) {
      throw new ImportError([`the written pack does not load: ${e instanceof Error ? e.message : String(e)}`]);
    }
    const hits = Object.keys(built.files)
      .filter((name) => name !== 'naming.yaml')
      .sort(cmp)
      .flatMap((name) => {
        const n = forbiddenIn(readFileSync(join(staging, name), 'utf8'), built.naming);
        return n === undefined ? [] : [`${name} holds forbidden term #${n}; nothing was written`];
      });
    if (hits.length > 0) throw new ImportError(hits);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  let backup: string | undefined;
  if (existsSync(o.out)) {
    backup = freePath(join(dirname(o.out), `${basename(o.out)}.bak-${ts}`));
    renameSync(o.out, backup);
  }
  renameSync(staging, o.out);
  return { out: o.out, ...(backup !== undefined ? { backup } : {}), ...built.report };
}

/** The report as printable lines: counts, ids and answer keys only. */
export function formatImportReport(r: ImportReport): string[] {
  const kv = (m: Record<string, number>): string =>
    Object.entries(m)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
  const lines = [
    `pack written: ${r.out}`,
    ...(r.backup !== undefined ? [`previous pack moved to ${r.backup}`] : []),
    `facts ${r.facts.total} (by status: ${kv(r.facts.byStatus)}; by kind: ${kv(r.facts.byKind)})`,
    `roles ${r.roles}`,
    `unplaced facts ${r.unplaced.length}`,
    `answers ${r.answers.written} written, ${r.answers.dropped.length} dropped, ${r.answers.removedForbidden.length} removed for a forbidden term`,
    `watchlist ${r.watchlist.total} entries (${r.watchlist.fromDesk} from the Desk, ${r.watchlist.extra} extra, ${r.watchlist.careers} careers; ${r.watchlist.droppedForbidden} left out for a forbidden term)`,
    `warnings ${r.warnings.length}`,
    ...r.warnings.map((w) => `  - ${w}`),
  ];
  return lines;
}
