/**
 * The only prose in jobpilot's documents that is not a verbatim fact claim (spec §5.4, Task 9 brief). Every slot is
 * computed from the pack and the posting, and G-GROUND re-renders these templates from recomputed slots and compares.
 * Pure: no imports.
 */

/** Summary. Fewer than four covered terms drop the missing slots; none drops the "building" clause. */
export const SUMMARY_TEMPLATE = '{title} with {years}+ years building {top1}, {top2}, {top3} and {top4} systems. Currently at {employer}.';
/**
 * Cover paragraph 1 (fix round 1). The brief's "and I work fully remote from India" could be untrue, so the last
 * sentence says only what the pack's eligibility rules guarantee; "of backend experience" became "of experience",
 * since the years count every role, backend or not. `{title}` and `{company}` are sanitised posting text
 * (`sanitisePostingText`), and a slot that fails `unsafePostingText` blocks the job's documents.
 */
export const COVER_P1 = 'I am applying for the {title} role at {company}. I am a {targetTitle} with {years}+ years of experience. I am based in India and am looking for a fully remote role.';
/** Cover paragraph 2: this lead-in, then the two top-ranked facts verbatim, each its own sentence. */
export const COVER_P2_LEAD = 'Relevant work:';
/** Cover paragraph 3: the third fact verbatim, then this sentence (two or more listed terms). */
export const COVER_P3_TAIL = 'The role asks for {coveredList}; each appears in the work above.';
/** The same sentence for exactly one listed term. */
export const COVER_P3_TAIL_ONE = 'The role asks for {coveredList}; it appears in the work above.';
/**
 * Cover paragraph 4. The cover-writer reads only the public pack, and `answers.yaml` (P1/P2) is not in it, so it
 * leaves `{availableFrom}` and `{notice}` as literal placeholders. The renderer (Task 10, full pack) fills them from
 * `answers.yaml` keys `available_from` and `notice_period`; when either key is missing it omits the first sentence
 * ("I am available ... {notice}.") and keeps "Thank you for your time." G-GROUND checks the placeholders are intact.
 */
export const COVER_P4 = 'I am available from {availableFrom}, with a notice period of {notice}. Thank you for your time.';

/** The words of `COVER_P4` the renderer fills, as they appear in the plan. */
export const RENDER_PLACEHOLDERS = ['{availableFrom}', '{notice}'] as const;

/** "a", "a and b", "a, b and c": items joined with ", " and a final " and ". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`;
}

/** Replaces each `{name}` with its slot; a slot that is not given is an error (templates never render half-filled). */
export function fill(template: string, slots: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([A-Za-z0-9]+)\}/g, (_m, name: string) => {
    if (!Object.hasOwn(slots, name)) throw new Error(`template slot {${name}} has no value`);
    return String(slots[name]);
  });
}

/** The summary slots: `top1`..`top4` hold up to four covered terms in order; `employer` only when a role is ongoing. */
export interface SummarySlots {
  readonly title: string;
  readonly years: number;
  readonly top1?: string;
  readonly top2?: string;
  readonly top3?: string;
  readonly top4?: string;
  readonly employer?: string;
}

/**
 * Renders `SUMMARY_TEMPLATE`. With fewer than four terms the missing slots are dropped and the rest joined with ", "
 * and " and " (one term: "building java systems"); with none the clause " building ... systems" is dropped. Without
 * an `employer` slot (no ongoing role) the sentence " Currently at ..." is dropped, since it would be untrue.
 */
export function renderSummary(s: Readonly<SummarySlots>): string {
  const terms = [s.top1, s.top2, s.top3, s.top4].filter((t): t is string => t !== undefined);
  const building = terms.length > 0 ? ` building ${joinList(terms)} systems` : '';
  const current = s.employer !== undefined ? ` ${fill('Currently at {employer}.', { employer: s.employer })}` : '';
  return `${fill('{title} with {years}+ years', { title: s.title, years: s.years })}${building}.${current}`;
}

/** A claim as its own sentence: verbatim, with a full stop added only when it has no closing punctuation. */
export const asSentence = (claim: string): string => (/[.!?]["')\]]?$/.test(claim) ? claim : `${claim}.`);

// ---- posting text used in templates (fix round 1, I1) ----

/** The longest posting title or company a template takes, in characters, after sanitising. */
export const POSTING_SLOT_MAX = 120;
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: "'", lsquo: "'" };

/**
 * Sanitises a posting title or company for a template slot: markup tags removed, HTML entities decoded (so an
 * encoded `<` still fails the character rule), format (zero-width, bidi) and private-use characters removed, control
 * characters made spaces,
 * NFKC, curly single quotes as `'`, whitespace collapsed, then capped at `POSTING_SLOT_MAX` characters.
 */
export function sanitisePostingText(raw: string): string {
  const decoded = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  const clean = decoded
    // format characters (zero-width, bidi) vanish, so they cannot split a word apart; control characters are spaces
    .replace(/[\p{Cf}\p{Co}\p{Cs}]/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/gu, ' ')
    .trim();
  const chars = [...clean];
  return chars.length > POSTING_SLOT_MAX ? chars.slice(0, POSTING_SLOT_MAX).join('').trim() : clean;
}

/** Abbreviations whose full stop does not end a sentence ("Sr. Backend Engineer", "Acme Inc. India"). */
const ABBREVIATIONS = new Set(['sr', 'jr', 'inc', 'co', 'ltd', 'corp', 'llc', 'plc', 'st', 'dr', 'no', 'vs', 'intl', 'dept', 'mgr', 'eng', 'sw', 'jun', 'sen']);
/** Allowed characters: letters, marks, digits, whitespace and & , . / ( ) - + # ' : ; | – —. */
const DISALLOWED = /[^\p{L}\p{M}\p{N}\s&,./()\-+#':;|–—]/u;
/** "I" is the pronoun (not a level, as in "Software Engineer I" or "SDE I") only before a verb-like word or as I'm, I've. */
const PRONOUN_I = /(?<![\p{L}\p{N}'])i(?:'m|'ve|\s+(?:am|have|hold|will|was|can|worked|led|built|own|bring|believe))(?![\p{L}\p{N}'])/iu;
/** we and our in any case; me and my only in lower or sentence case, never all caps (ME is the Middle East). */
const PRONOUN_WORD = /(?<![\p{L}\p{N}'])(?:[wW][eE]|[oO][uU][rR]|[mM][ey])(?![\p{L}\p{N}'])/u;
const URL_OR_EMAIL = /(?:https?:\/\/|www\.)|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+\.\p{L}{2,}/iu;

/**
 * Why a sanitised posting slot may not go into a template, or null when it may. It is unsafe when it:
 * - is empty;
 * - holds a first-person pronoun: "I" before a verb-like word (am, have, hold, will, was, can, worked, led, built,
 *   own, bring, believe) or as I'm / I've, so a level ("Software Engineer I", "SDE I") is not one; "we" and "our" in
 *   any case; "me" and "my" in lower or sentence case only, never all caps ("ME" is the Middle East);
 * - has more than 14 words;
 * - has a sentence end (. ! ?) followed by more text; a full stop after an abbreviation (Sr., Inc., ...) or a single
 *   letter is not a sentence end;
 * - holds a URL or an email address;
 * - holds a character outside letters, marks, digits, whitespace and `& , . / ( ) - + # ' : ; | – —`.
 */
export function unsafePostingText(s: string): string | null {
  if (s === '') return 'is empty';
  const bad = DISALLOWED.exec(s);
  if (bad !== null) return `has a character outside the allowed set (U+${(bad[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')})`;
  if (URL_OR_EMAIL.test(s)) return 'has a URL or email address';
  if (PRONOUN_I.test(s)) return 'has a first-person pronoun';
  if (PRONOUN_WORD.test(s)) return 'has a first-person pronoun';
  if (s.split(/\s+/u).filter((w) => w !== '').length > 14) return 'has more than 14 words';
  for (const m of s.matchAll(/[.!?](?=\s+\S)/gu)) {
    const before = /([\p{L}]+)$/u.exec(s.slice(0, m.index ?? 0))?.[1] ?? '';
    if (m[0] === '.' && (before.length === 1 || ABBREVIATIONS.has(before.toLowerCase()))) continue;
    return 'has a sentence end followed by more text';
  }
  return null;
}
