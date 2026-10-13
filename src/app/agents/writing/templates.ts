/**
 * The only prose in jobpilot's documents that is not a verbatim fact claim (spec §5.4, Task 9 brief). Every slot is
 * computed from the pack and the posting, and G-GROUND re-renders these templates from recomputed slots and compares.
 * Pure: no imports.
 */

/**
 * Summary. Fewer than four covered terms drop the missing slots; none drops the "Core skills" sentence. The years and
 * the terms are separate sentences: "N+ years building X" read as N years *of X*, which overstated any skill newer than
 * the whole career (a 1-year Go fact under 10+ years).
 */
export const SUMMARY_TEMPLATE = '{title} with {years}+ years of experience. Core skills: {top1}, {top2}, {top3} and {top4}. Currently at {employer}.';

// ---- cover letter v2 ----
// Every cover sentence is one of these templates filled with computed slots, or a citeable claim verbatim (its first
// letter lower-cased only after "I", when its first word is a past-tense verb). The letter says "I'm", never "I am".

/** p1, sentence 1. `{title}` and `{company}` are sanitised posting text (`sanitisePostingText`); unsafe text blocks the job. */
export const COVER_OPENING = "I'm applying for the {title} role at {company}.";
/** p1, sentence 2, when some role is ongoing: `{targetTitle}` is the headline, a `targets.claimableTitles` entry. */
export const COVER_TITLE_NOW = "I'm {article} {targetTitle} with {years}+ years of experience.";
/** p1, sentence 2, when no role is ongoing (fix round 2, I-R1): the most recent role's title, in the past tense. */
export const COVER_TITLE_PAST = 'I most recently worked as {article} {targetTitle} and have {years}+ years of experience.';
/**
 * p1, sentence 3: up to three covered JD terms that a citeable *experience* fact placed in a role backs (the summary's
 * terms), so "I've used" is true. `{quantifier}` is `TERMS_QUANTIFIER` by count. Dropped when no term qualifies.
 */
export const COVER_TERMS = "The role asks for {coveredList}, and I've used {quantifier} in my work.";
/** "it", "both", "all three", by the number of listed terms. */
export const TERMS_QUANTIFIER: Readonly<Record<number, string>> = { 1: 'it', 2: 'both', 3: 'all three' };
/** p1, last sentence, by the number of evidence sentences that follow; dropped when there are none. */
export const COVER_EXAMPLES: Readonly<Record<number, string>> = { 1: 'One example follows.', 2: 'Two examples follow.', 3: 'Three examples follow.' };

/** p2 and p3: one sentence per cited fact, anchored to its role's display employer. `{claim}` ends with its full stop. */
export const EVIDENCE_AT = 'At {employer}, I {claim}';
/** The first mention of an employer whose role (the one the fact is placed in) is ongoing. */
export const EVIDENCE_AT_NOW = 'At {employer}, where I work now, I {claim}';
/** A claim whose first word is not a past-tense verb: verbatim after a colon. */
export const EVIDENCE_AT_COLON = 'At {employer}: {claim}';
/** The same employer as the sentence just before it, in the same paragraph (verb claims). */
export const EVIDENCE_THERE = 'There I also {claim}';
/** An employer already named earlier in the letter, but not in the sentence just before (or a colon claim right after it). */
export const EVIDENCE_ALSO_AT = 'Also at {employer}, I {claim}';
export const EVIDENCE_ALSO_AT_COLON = 'Also at {employer}: {claim}';

/**
 * The signature sentence (writing.signatureFacts): one lead phrase, chosen from the jobKey (`signatureLead`), then
 * - when the claim starts with a role noun phrase (`ROLE_NOUN_CLAIM`: "Sole engineer who ...", "Lead developer of
 *   ..."): "<lead>, at {employer} I am the " (role ongoing) or "I was the " (role ended), then the claim with only its
 *   first character lower-cased;
 * - otherwise: "<lead>, at {employer}: " and the claim verbatim.
 * `{employer}` is the display employer of the role the fact is placed in.
 */
export const SIGNATURE_LEADS: readonly string[] = ['Beyond the stack this role lists', 'Alongside that', 'One more part of my work'];
/** A claim that names the candidate's role: it reads after "I am the" / "I was the". */
export const ROLE_NOUN_CLAIM = /^(Sole|Founding|Lead|Senior|Principal|Staff)\b[^.]{0,40}?\b(engineer|developer|architect)\b/;
/** A deterministic index for a jobKey: its last four hex digits (any other key: its UTF-16 code sum), modulo `n`. */
function keyIndex(jobKey: string, n: number): number {
  const tail = jobKey.slice(-4);
  const v = /^[0-9a-f]{4}$/i.test(tail) ? Number.parseInt(tail, 16) : [...jobKey].reduce((a, c) => a + c.charCodeAt(0), 0);
  return v % n;
}
export const signatureLead = (jobKey: string): string => SIGNATURE_LEADS[keyIndex(jobKey, SIGNATURE_LEADS.length)] as string;
export function signatureSentence(jobKey: string, employer: string, claim: string, ongoing: boolean): string {
  const lead = signatureLead(jobKey);
  const c = asSentence(claim);
  if (!ROLE_NOUN_CLAIM.test(claim)) return `${lead}, at ${employer}: ${c}`;
  return `${lead}, at ${employer} ${ongoing ? 'I am the' : 'I was the'} ${c.charAt(0).toLowerCase()}${c.slice(1)}`;
}
/**
 * p1's last sentence when a signature sentence follows the evidence: the count would be wrong, so it is count-free,
 * chosen from the jobKey. Without a signature sentence p1 keeps `COVER_EXAMPLES`.
 */
export const COUNT_FREE_EXAMPLES: readonly string[] = ['Some examples follow.', 'Here is what that looked like.', 'A few examples follow.'];
export const countFreeExamples = (jobKey: string): string => COUNT_FREE_EXAMPLES[keyIndex(jobKey, COUNT_FREE_EXAMPLES.length)] as string;

/** Irregular past-tense verbs a claim may start with (and so read "I built ..."); any other verb must end in -ed. */
export const IRREGULAR_PAST: ReadonlySet<string> = new Set([
  'built', 'led', 'ran', 'wrote', 'drove', 'made', 'set', 'cut', 'grew', 'took', 'began', 'won', 'shipped', 'brought', 'taught', 'sold',
  'bought', 'held', 'kept', 'met', 'found', 'gave', 'spent', 'oversaw', 'undertook', 'broke', 'chose', 'got', 'paid', 'put', 'rebuilt',
  'rewrote', 'rode', 'rose', 'shut', 'split', 'spun', 'stood', 'struck', 'swept', 'thought', 'threw', 'understood', 'upheld', 'wound',
  'sent', 'lent', 'lost', 'laid', 'flew', 'drew', 'fed', 'hid', 'saw', 'told', 'sped', 'shot', 'bore', 'forged', 'became',
]);
/** Words ending in -ed that are not past-tense verbs at the start of a claim (adjectives, nouns). */
export const NOT_PAST_VERBS: ReadonlySet<string> = new Set([
  'need', 'seed', 'speed', 'feed', 'breed', 'deed', 'weed', 'steed', 'greed', 'creed', 'shed', 'sled', 'embedded', 'distributed',
  'advanced', 'dedicated', 'experienced', 'skilled', 'certified', 'unified', 'federated', 'detailed', 'based', 'related', 'limited',
  'united', 'varied', 'mixed', 'hundred', 'kindred', 'sacred', 'naked', 'wicked', 'rugged', 'ragged', 'crooked', 'beloved', 'interested',
  'talented', 'sophisticated', 'complicated', 'accredited',
]);

/**
 * Whether a claim starts with a past-tense verb, so it may follow "I": its first word is in sentence case (one capital,
 * then lower case; hyphenated parts lower case: "Re-architected", "Co-led") and, with any prefix before its last hyphen
 * ignored, is in `IRREGULAR_PAST`, or ends in "-ed" with at least four letters and is not in `NOT_PAST_VERBS`
 * ("Distributed tracing ...", "Embedded systems ...", "Need", "Speed" read as adjectives or nouns, so they are refused:
 * a wrong guess would change the claim's meaning, the colon form never does). An all-capital or mixed-case word is
 * never one, so an acronym is never re-cased.
 */
export function startsWithPastVerb(claim: string): boolean {
  const m = /^([A-Z][a-z]*(?:-[a-z]+)*)(?=[\s,;:.]|$)/.exec(claim);
  if (m === null) return false;
  const word = (m[1] as string).toLowerCase();
  const last = word.split('-').pop() as string;
  if (NOT_PAST_VERBS.has(word) || NOT_PAST_VERBS.has(last)) return false;
  if (IRREGULAR_PAST.has(word) || IRREGULAR_PAST.has(last)) return true;
  return last.length >= 4 && last.endsWith('ed');
}

/** Where an evidence sentence's employer was named before: never, in the sentence just before (same paragraph), or earlier. */
export type EvidenceAfter = 'first' | 'adjacent' | 'again';
export interface EvidenceSlots {
  /** The display employer of the role the fact is placed in (`naming.employerDisplay`). */
  readonly employer: string;
  /** The fact's claim, verbatim. */
  readonly claim: string;
  /** Whether that role is ongoing (end 'present'). */
  readonly ongoing: boolean;
  readonly after: EvidenceAfter;
}

/**
 * One evidence sentence. A claim starting with a past-tense verb (`startsWithPastVerb`) has its first letter
 * lower-cased and follows "I" (`EVIDENCE_AT`, `EVIDENCE_AT_NOW` on the first mention of an ongoing role's employer,
 * `EVIDENCE_THERE` right after a sentence about the same employer, `EVIDENCE_ALSO_AT` later); any other claim is
 * verbatim after a colon (`EVIDENCE_AT_COLON`, or `EVIDENCE_ALSO_AT_COLON` once the employer was named). The claim
 * gets a full stop only when it has no closing punctuation (`asSentence`).
 */
export function evidenceSentence(s: Readonly<EvidenceSlots>): string {
  const verb = startsWithPastVerb(s.claim);
  const claim = asSentence(verb ? `${s.claim.charAt(0).toLowerCase()}${s.claim.slice(1)}` : s.claim);
  if (!verb) return fill(s.after === 'first' ? EVIDENCE_AT_COLON : EVIDENCE_ALSO_AT_COLON, { employer: s.employer, claim });
  if (s.after === 'adjacent') return fill(EVIDENCE_THERE, { claim });
  if (s.after === 'again') return fill(EVIDENCE_ALSO_AT, { employer: s.employer, claim });
  return fill(s.ongoing ? EVIDENCE_AT_NOW : EVIDENCE_AT, { employer: s.employer, claim });
}

/** The slots of p1. `terms` are display names (at most three are used); `examples` is the number of evidence sentences. */
export interface OpeningSlots {
  readonly title: string;
  readonly company: string;
  readonly targetTitle: string;
  readonly years: number;
  readonly past: boolean;
  readonly terms: readonly string[];
  readonly examples: number;
  /** Set (to the jobKey) when a signature sentence follows the evidence: the examples sentence is `countFreeExamples`. */
  readonly countFreeKey?: string;
}

/** The opening sentence of the letter alone (the dashboard's short cover note starts with it). */
export const openingSentence = (s: Pick<OpeningSlots, 'title' | 'company'>): string => fill(COVER_OPENING, { title: s.title, company: s.company });

/** p1: `COVER_OPENING`, the title sentence, `COVER_TERMS` (when a term qualifies) and `COVER_EXAMPLES` (when a fact follows). */
export function renderOpening(s: Readonly<OpeningSlots>): string {
  const terms = s.terms.slice(0, 3);
  const examples = Math.min(3, s.examples);
  return [
    openingSentence(s),
    fill(s.past ? COVER_TITLE_PAST : COVER_TITLE_NOW, { article: articleFor(s.targetTitle), targetTitle: s.targetTitle, years: s.years }),
    ...(terms.length > 0 ? [fill(COVER_TERMS, { coveredList: joinList(terms), quantifier: TERMS_QUANTIFIER[terms.length] as string })] : []),
    ...(s.countFreeKey !== undefined ? [countFreeExamples(s.countFreeKey)] : examples > 0 ? [COVER_EXAMPLES[examples] as string] : []),
  ].join(' ');
}

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
/**
 * p4 as the cover-writer leaves it. The cover-writer reads only the public pack, and `contact.yaml` and `answers.yaml`
 * (P1) are not in it, so it leaves `{city}` and `{notice}` as literal placeholders; the renderer (full pack) replaces
 * the whole paragraph with `renderP4` from `contact.city` and `answers.yaml` `notice_period`. `available_from` never
 * reaches a document: a calendar date goes stale and becomes untrue. G-GROUND checks the placeholders are intact.
 */
export const COVER_P4_THANKS = 'Thank you for considering my application.';
export const COVER_P4_CITY_NOTICE = "I'm based in {city}, looking for a fully remote role, and available after {notice}.";
export const COVER_P4_CITY = "I'm based in {city} and looking for a fully remote role.";
export const COVER_P4_NOTICE = "I'm looking for a fully remote role and available after {notice}.";
export const COVER_P4_NONE = "I'm looking for a fully remote role.";
export const COVER_P4 = `${COVER_P4_CITY_NOTICE} ${COVER_P4_THANKS}`;
/** When the home city is the only office city: named once. */
export const COVER_P4_HOME_OFFICE_NOTICE = "I'm based in {city} and open to remote, office or hybrid roles, and available after {notice}.";
export const COVER_P4_HOME_OFFICE = "I'm based in {city} and open to remote, office or hybrid roles.";

/** The words of `COVER_P4` the renderer fills, as they appear in the plan. */
export const RENDER_PLACEHOLDERS = ['{city}', '{notice}'] as const;

/** "N day|week|month[s]" (also "Nday", "N-day"), any case: the shape `noticePhrase` shortens. */
const NOTICE_SHAPE = /^(\d{1,3})[\s-]*(day|week|month)s?$/i;
/** The notice as a noun phrase: "30 days" -> "a 30-day notice period"; any other shape -> "a notice period of {notice}". */
export function noticePhrase(notice: string): string {
  const m = NOTICE_SHAPE.exec(notice);
  return m ? `a ${m[1] as string}-${(m[2] as string).toLowerCase()} notice period` : `a notice period of ${notice}`;
}

/** A notice that means no notice at all: it reads "available to start immediately". */
const IMMEDIATE_NOTICE = /^(?:immediately|immediate|none|0|0 days?|nil|n\/a)$/i;
export const isImmediateNotice = (notice: string): boolean => IMMEDIATE_NOTICE.test(notice.trim());
const AVAILABLE_AFTER = 'available after {notice}';
export const COVER_P4_IMMEDIATE = 'available to start immediately';
const FULLY_REMOTE = 'a fully remote role';

/** "A", "A or B", "A, B or C". */
export const joinOr = (items: readonly string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1] as string}`;

/**
 * The filled p4: the city clause only with a city, the notice clause only with a notice, then `COVER_P4_THANKS`. An
 * immediate notice (`isImmediateNotice`) reads "available to start immediately". With office cities (display names,
 * from `eligibility.officeCities`) the role reads "a remote role, or an office or hybrid role in A, B or C"; with none
 * the paragraph is exactly the template. `homeIsOffice` (the home city is the only office city) names the city once:
 * "I'm based in {city} and open to remote, office or hybrid roles".
 */
export function renderP4(city: string | undefined, notice: string | undefined, officeCities: readonly string[] = [], homeIsOffice = false): string {
  const immediate = notice !== undefined && isImmediateNotice(notice);
  const n = notice === undefined ? undefined : noticePhrase(notice);
  if (homeIsOffice && city !== undefined && officeCities.length === 1) {
    const first = n === undefined ? fill(COVER_P4_HOME_OFFICE, { city }) : fill(immediate ? COVER_P4_HOME_OFFICE_NOTICE.replace(AVAILABLE_AFTER, COVER_P4_IMMEDIATE) : COVER_P4_HOME_OFFICE_NOTICE, { city, notice: n });
    return `${first} ${COVER_P4_THANKS}`;
  }
  const shape = (t: string): string => {
    const timed = immediate ? t.replace(AVAILABLE_AFTER, COVER_P4_IMMEDIATE) : t;
    if (officeCities.length === 0) return timed;
    const role = `a remote role, or an office or hybrid role in ${joinOr(officeCities)}`;
    // "… role and available …" gains a comma once the role clause has one of its own.
    return timed.replace(`${FULLY_REMOTE} and `, `${role}, and `).replace(FULLY_REMOTE, role);
  };
  const first =
    city !== undefined && n !== undefined
      ? fill(shape(COVER_P4_CITY_NOTICE), { city, notice: n })
      : city !== undefined
        ? fill(shape(COVER_P4_CITY), { city })
        : n !== undefined
          ? fill(shape(COVER_P4_NOTICE), { notice: n })
          : shape(COVER_P4_NONE);
  return `${first} ${COVER_P4_THANKS}`;
}

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
 * and " and " (one term: "Core skills: java."); with none the sentence " Core skills: ..." is dropped. Without
 * an `employer` slot (no ongoing role) the sentence " Currently at ..." is dropped, since it would be untrue.
 */
export function renderSummary(s: Readonly<SummarySlots>): string {
  const terms = [s.top1, s.top2, s.top3, s.top4].filter((t): t is string => t !== undefined);
  const skills = terms.length > 0 ? ` ${fill('Core skills: {terms}.', { terms: joinList(terms) })}` : '';
  const current = s.employer !== undefined ? ` ${fill('Currently at {employer}.', { employer: s.employer })}` : '';
  return `${fill('{title} with {years}+ years of experience.', { title: s.title, years: s.years })}${skills}${current}`;
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
