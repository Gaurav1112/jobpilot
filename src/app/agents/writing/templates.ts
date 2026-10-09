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
export const COVER_P1 = 'I am applying for the {title} role at {company}. I am {article} {targetTitle} with {years}+ years of experience. I am based in India and am looking for a fully remote role.';
/**
 * Cover paragraph 1 when no role is ongoing (fix round 2, I-R1): the most recent role's title, in the past tense, so a
 * past title is never stated as the current one.
 */
export const COVER_P1_PAST = 'I am applying for the {title} role at {company}. I most recently worked as {article} {targetTitle}, with {years}+ years of experience. I am based in India and am looking for a fully remote role.';

/** Words that start with a vowel letter but a consonant sound ("a unit", "a European", "a one-off"). */
const A_BEFORE = ['uni', 'use', 'usu', 'uti', 'ure', 'ubi', 'uk', 'eu', 'one', 'once'];
/** Words that start with a silent h ("an hour", "an honest", "an heir"). */
const AN_BEFORE = ['hour', 'honest', 'honor', 'honour', 'heir'];
/** Acronyms read as a word, not letter by letter, with the article their spoken word takes (a NASA, a FAANG). */
const WORD_ACRONYMS: Readonly<Record<string, 'a' | 'an'>> = { NASA: 'a', FAANG: 'a', SAAS: 'a', PAAS: 'a', NATO: 'a', UNICEF: 'a', SCADA: 'a', OPEC: 'an', IKEA: 'an' };
/** Letters whose spoken name starts with a vowel sound (an SDE, an MLE, an HR ...); U ("you") is not one. */
const VOWEL_SOUND_LETTERS = 'AEFHILMNORSX';

/**
 * "a" or "an" for a title, by the sound of its first word:
 * - an acronym read as a word (WORD_ACRONYMS: NASA, FAANG, SaaS, NATO, ...) takes its word's article (a NASA, a FAANG);
 * - any other all-capital initialism, or a single capital letter, is read letter by letter: "an" when its first
 *   letter's name starts with a vowel sound (A E F H I L M N O R S X), else "a" (an SDE, an AWS, an X-ray, a UX);
 * - a number: "an" for 8, 11, 18 and 80-89 ... (eight, eleven, eighteen), else "a";
 * - a word: "an" before a silent h (hour, honest, honor, heir); "a" before a vowel letter that sounds like a consonant
 *   (uni-, use-, usu-, uti-, ure-, ubi-, uk-, eu-, one, once); otherwise "an" before a vowel letter and "a" before a consonant.
 */
export function articleFor(title: string): 'a' | 'an' {
  const word = title.trim().split(/[\s-]+/)[0] ?? '';
  const asWord = WORD_ACRONYMS[word.toUpperCase()];
  if (asWord !== undefined && (/^[A-Z0-9]+$/.test(word) || /^[A-Z][a-z]+[A-Z]$/.test(word))) return asWord;
  // an initialism, or a single capital letter ("X-ray"), is read letter by letter
  if (/^[A-Z][A-Z0-9]*$/.test(word)) return VOWEL_SOUND_LETTERS.includes(word[0] as string) ? 'an' : 'a';
  if (/^\d/.test(word)) return /^(8|11|18)(\D|$)|^8\d/.test(word) ? 'an' : 'a';
  const w = word.toLowerCase();
  if (AN_BEFORE.some((p) => w.startsWith(p))) return 'an';
  if (A_BEFORE.some((p) => w.startsWith(p))) return 'a';
  return /^[aeiou]/.test(w) ? 'an' : 'a';
}
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
export const COVER_P4_AVAILABILITY = 'I am available from {availableFrom}, with a notice period of {notice}.';
/** The sentence of `COVER_P4` that stays when an answer is missing. */
export const COVER_P4_THANKS = 'Thank you for your time.';
export const COVER_P4 = `${COVER_P4_AVAILABILITY} ${COVER_P4_THANKS}`;

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
 * NFKC, curly single quotes as `'`, whitespace collapsed. It never truncates: a slot longer than `POSTING_SLOT_MAX`
 * characters is unsafe (`unsafePostingText`), so a document never misquotes a cut-off title.
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
  return clean;
}

/** Abbreviations whose full stop does not end a sentence ("Sr. Backend Engineer", "Acme Inc. India"). */
const ABBREVIATIONS = new Set(['sr', 'jr', 'inc', 'co', 'ltd', 'corp', 'llc', 'plc', 'st', 'dr', 'no', 'vs', 'intl', 'dept', 'mgr', 'eng', 'sw', 'jun', 'sen']);
/**
 * Allowed characters: letters, marks, digits, whitespace and & , . / ( ) - + # ' : ; | – —, plus (final fix L3, real
 * titles such as "Senior Full Stack Developer [Java, Angular]", "Principal Software Engineer_Fullstack", "(100% Remote)")
 * [ ] _ % − ‐ " ! ? @ * = ~. Markup and template characters (< > { } ` \) and control characters stay out; URLs,
 * emails, pronouns, sentence ends and length have their own rules below.
 */
const DISALLOWED = /[^\p{L}\p{M}\p{N}\s&,./()\-+#':;|–—[\]_%−‐"!?@*=~]/u;
/** "I" is the pronoun (not a level, as in "Software Engineer I" or "SDE I") only before a verb-like word or as I'm, I've, I'll, I'd. */
const PRONOUN_I =
  /(?<![\p{L}\p{N}'])i(?:'m|'ve|'ll|'d|\s+(?:am|have|hold|will|was|can|worked|led|built|own|bring|believe|know|designed|developed|managed|love|enjoy))(?![\p{L}\p{N}'])/iu;
/** Greek and Cyrillic letters that read as I (Ι ι І і Ӏ ӏ), folded to I for the pronoun check only. */
const I_LOOKALIKES = /[ΙιІіӀӏ]/gu;
/** we and our in any case; me and my only in lower or sentence case, never all caps (ME is the Middle East). */
const PRONOUN_WORD = /(?<![\p{L}\p{N}'])(?:[wW][eE]|[oO][uU][rR]|[mM][ey])(?![\p{L}\p{N}'])/u;
const URL_OR_EMAIL = /(?:https?:\/\/|www\.)|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+\.\p{L}{2,}/iu;

/**
 * Why a sanitised posting slot may not go into a template, or null when it may. It is unsafe when it:
 * - is empty, or longer than `POSTING_SLOT_MAX` (120) characters;
 * - holds a first-person pronoun: "I" (or a Greek or Cyrillic lookalike of it) before a verb-like word (am, have,
 *   hold, will, was, can, worked, led, built, own, bring, believe, know, designed, developed, managed, love, enjoy) or
 *   as I'm / I've / I'll / I'd, so a level ("Software Engineer I", "SDE I") is not one; "we" and "our" in any case;
 *   "me" and "my" in lower or sentence case only, never all caps ("ME" is the Middle East);
 * - has more than 14 words, or a word longer than 40 characters;
 * - has a sentence end (. ! ?) followed by more text; a full stop after an abbreviation (Sr., Inc., ...) or a single
 *   letter is not a sentence end;
 * - holds a URL or an email address;
 * - holds a character outside letters, marks, digits, whitespace and `& , . / ( ) - + # ' : ; | – — [ ] _ % − ‐ " ! ? @
 *   * = ~` (so `< > { } \` and a backtick never pass).
 */
export function unsafePostingText(s: string): string | null {
  if (s === '') return 'is empty';
  if ([...s].length > POSTING_SLOT_MAX) return `is longer than ${POSTING_SLOT_MAX} characters`;
  const bad = DISALLOWED.exec(s);
  if (bad !== null) return `has a character outside the allowed set (U+${(bad[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')})`;
  if (URL_OR_EMAIL.test(s)) return 'has a URL or email address';
  if (PRONOUN_I.test(s.replace(I_LOOKALIKES, 'I'))) return 'has a first-person pronoun';
  if (PRONOUN_WORD.test(s)) return 'has a first-person pronoun';
  const words = s.split(/\s+/u).filter((w) => w !== '');
  if (words.length > 14) return 'has more than 14 words';
  if (words.some((w) => [...w].length > 40)) return 'has a word longer than 40 characters';
  for (const m of s.matchAll(/[.!?](?=\s+\S)/gu)) {
    const before = /([\p{L}]+)$/u.exec(s.slice(0, m.index ?? 0))?.[1] ?? '';
    if (m[0] === '.' && (before.length === 1 || ABBREVIATIONS.has(before.toLowerCase()))) continue;
    return 'has a sentence end followed by more text';
  }
  return null;
}
