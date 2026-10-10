/**
 * Pure pack rules shared by the loader, the writing agents and the app guardrails: which facts may be cited, the
 * forbidden-term check, and the display name of an employer. No imports and no I/O, so agent code may import it (the
 * containment scan reads this file like agent code).
 */

/** Only verified and user-stated facts may be cited in a document. */
export function citeable(f: { readonly status: string }): boolean {
  return f.status === 'verified' || f.status === 'user-stated';
}

/** The naming rules (`naming.yaml`), structurally, so this module needs no schema import. */
export interface NamingRules {
  readonly employerDisplay: Readonly<Record<string, string>>;
  readonly forbiddenTerms: readonly string[];
}

export class ForbiddenTermError extends Error {
  override readonly name = 'ForbiddenTermError';
  constructor(readonly term: string) {
    super(`forbidden term found: ${term}`);
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Letters that look like Latin ones, mapped to the Latin letter, so a homoglyph spelling of a forbidden term still
 * matches: a skeleton fold in the spirit of UTS #39 for the scripts a look-alike spelling realistically uses (Cyrillic,
 * Greek, Armenian, the Latin small capitals and IPA letters). For the forbidden-term check only. Over-folding is safe
 * here: it can only make the check stricter, and a false hit needs foreign text that folds to the exact term.
 * Task 9 added Greek ε (e) and τ (t), and Cyrillic т (t) and н (h; in many fonts a small capital H, and with the text
 * case-folded it reads as h). Greek η is deliberately not mapped to n. Final I8 added Armenian, the small capitals,
 * Cyrillic һ ԁ ԛ ԝ ӏ к в and Greek α υ ϲ.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic lower and upper case
  а: 'a', в: 'b', е: 'e', к: 'k', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', т: 't', н: 'h',
  һ: 'h', ԁ: 'd', ԛ: 'q', ԝ: 'w', ӏ: 'l', ү: 'y',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S',
  Һ: 'H', Ԁ: 'D', Ԛ: 'Q', Ԝ: 'W', Ӏ: 'I',
  // Greek upper case, and the lower case letters that read as Latin
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Χ: 'X', Υ: 'Y', Ϲ: 'C',
  ο: 'o', ι: 'i', κ: 'k', ρ: 'p', ν: 'v', ε: 'e', τ: 't', α: 'a', υ: 'u', ϲ: 'c',
  // Armenian lower and upper case
  ա: 'w', գ: 'q', զ: 'q', հ: 'h', ո: 'n', ս: 'u', ց: 'g', օ: 'o', լ: 'l',
  Լ: 'L', Ս: 'U', Տ: 'S', Օ: 'O',
  // Latin small capitals and IPA letters
  ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ꜰ: 'f', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm', ɴ: 'n',
  ᴏ: 'o', ᴘ: 'p', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z', ɑ: 'a', ɡ: 'g', ɩ: 'i', ȷ: 'j',
  // Turkish dotless i (dotted İ decomposes to I plus a combining dot, removed with the other marks)
  ı: 'i',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'gu');

/**
 * Folds text for matching: NFKD, combining marks and invisible format characters (zero-width etc.) removed, Cyrillic
 * Greek, Armenian and small-capital homoglyphs and the dotless i mapped to Latin, case-folded, ß as ss, then NFKC. So `İnitech`, `Іnitech`
 * (Cyrillic І) and `Café` fold like `initech` and `cafe`.
 */
function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c)
    .toLowerCase()
    .replaceAll('ß', 'ss')
    .normalize('NFKC');
}

/** @internal For the R6 equivalence test only. */
export const foldForTests = (s: string): string => fold(s);

/** Digits and symbols that stand in for letters, and l for I, for the squashed token check only. */
const STAND_INS: Readonly<Record<string, string>> = { '1': 'i', '!': 'i', '|': 'i', l: 'i', '3': 'e', '0': 'o', '4': 'a', '5': 's', '7': 't', $: 's', '@': 'a' };
/** @internal For the R6 equivalence test only. */
export const STAND_INS_FOR_TESTS = STAND_INS;
/** A token with its stand-ins mapped and everything but letters and digits (hyphens, dots, apostrophes) removed. */
const squash = (tok: string): string => {
  // Rereview R6: one pass, code point by code point, with an ASCII range check before the Unicode class test; the
  // same result as mapping the stand-ins and then removing every non-letter, non-digit code point.
  let out = '';
  for (const c of tok.replace(/['’]s$/u, '')) {
    const m = STAND_INS[c] ?? c;
    const code = m.charCodeAt(0);
    if (code < 0x80 ? (m >= 'a' && m <= 'z') || (m >= 'A' && m <= 'Z') || (m >= '0' && m <= '9') : LETTER_OR_DIGIT.test(m)) out += m;
  }
  return out;
};
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
/** The squashed tokens of folded text, and each run of two or more one-letter tokens joined ("I n i t e c h"). */
function squashedTokens(folded: string): { toks: string[]; runs: string[] } {
  const toks = folded.split(/[\s,;:/()[\]{}"<>?*+=~^&#%\\]+/u).map(squash).filter((t) => t !== '');
  const runs: string[] = [];
  let run: string[] = [];
  for (const t of [...toks, '']) {
    if (t.length === 1) run.push(t);
    else {
      if (run.length >= 2) runs.push(run.join(''));
      run = [];
    }
  }
  return { toks, runs };
}

/** The word-bounded pattern of a folded term's words, compiled once per term (rereview R6). */
const TERM_RE = new Map<string, RegExp>();
function boundedTermRe(words: readonly string[]): RegExp {
  const key = words.join(' ');
  let re = TERM_RE.get(key);
  if (re === undefined) {
    re = new RegExp(`(?<![\\p{L}\\p{N}])${words.map(escapeRe).join('\\s+')}(?![\\p{L}\\p{N}])`, 'u');
    if (TERM_RE.size > 256) TERM_RE.clear();
    TERM_RE.set(key, re);
  }
  return re;
}

/**
 * Throws `ForbiddenTermError` if `text` contains any forbidden term. Both sides are folded (see `fold`).
 * 1. Whitespace runs inside a term match any whitespace (including NBSP and newlines), and boundaries are Unicode
 *    letter/digit lookarounds.
 * 2. (Task 9 review M3) Token by token, on squashed tokens: hyphens, dots and apostrophes inside a token are dropped,
 *    digit and symbol stand-ins are mapped (1 ! | l to i, 3 to e, 0 to o, ...), a run of one-letter tokens is joined,
 *    and a trailing plural s or es or a possessive is allowed; inside a run of spelled-out letters the term may sit anywhere. So `Ini-tech`, `In1tech`, `lnitech`, `I n i t e c h` and
 *    `Initechs` match `Initech`, while `reinitechnology` (a longer word) does not.
 */
export function assertNoForbidden(text: string, naming: Pick<NamingRules, 'forbiddenTerms'>): void {
  const hay = fold(text);
  let tokens: { toks: string[]; runs: string[] } | undefined;
  for (const term of naming.forbiddenTerms) {
    const words = fold(term).split(/\s+/u).filter((w) => w !== '');
    if (words.length === 0) continue;
    if (boundedTermRe(words).test(hay)) throw new ForbiddenTermError(term);
    const want = words.map(squash).filter((w) => w !== '');
    if (want.length === 0) continue;
    tokens ??= squashedTokens(hay);
    const { toks, runs } = tokens;
    for (let i = 0; i + want.length <= toks.length; i++) {
      const hit = want.every((w, j) => {
        const t = toks[i + j];
        return t === w || (j === want.length - 1 && (t === `${w}s` || t === `${w}es`));
      });
      if (hit) throw new ForbiddenTermError(term);
    }
    // A run of spelled-out letters is never an ordinary word, so the term may sit anywhere inside it.
    if (runs.some((r) => r.includes(want.join('')))) throw new ForbiddenTermError(term);
  }
}

/**
 * Text squashed for the strict substring check (Task 12 fix I1): each character folded (`fold`), stand-ins mapped
 * (`STAND_INS`), and everything but letters and digits dropped; `at[i]` is the index in `s` of the character that
 * produced `text[i]`.
 */
export function squashChars(s: string): { text: string; at: number[] } {
  let text = '';
  const at: number[] = [];
  let i = 0;
  for (const ch of s) {
    // Rereview R6: an ASCII character folds to its lower case alone (NFKD and NFKC leave it, it is no mark, format
    // character or look-alike), so it skips `fold`; the result is the same character for character (tested).
    const code = ch.charCodeAt(0);
    if (code < 0x80) {
      const lower = code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 32) : ch;
      const m = STAND_INS[lower] ?? lower;
      if ((m >= 'a' && m <= 'z') || (m >= '0' && m <= '9')) {
        text += m;
        at.push(i);
      }
      i += 1;
      continue;
    }
    for (const c of fold(ch)) {
      const m = STAND_INS[c] ?? c;
      if (/[\p{L}\p{N}]/u.test(m)) {
        text += m;
        at.push(i);
      }
    }
    i += ch.length;
  }
  return { text, at };
}

/**
 * The strict check (Task 12 fix I1): the first forbidden term found glued inside any whitespace-separated token
 * ("InitechPay", "northwindInitechOrders", a URL path), on squashed text, or undefined. `assertNoForbidden` needs word
 * boundaries so ordinary prose never false-hits; this one is for one-shot gates on vetted, distinctive terms (the
 * pack import and `pack check`), where a rare false hit costs the user one edit. Multi-word terms match with their
 * words joined.
 */
export function forbiddenSubstring(text: string, naming: Pick<NamingRules, 'forbiddenTerms'>): string | undefined {
  const tokens = text.split(/\s+/u).map((t) => squashChars(t).text).filter((t) => t !== '');
  for (const term of naming.forbiddenTerms) {
    const want = squashChars(term).text;
    if (want !== '' && tokens.some((t) => t.includes(want))) return term;
  }
  return undefined;
}

/**
 * The one strict forbidden-term check (final I8) for every string that is not the source posting: G-NAMING, the
 * renderer, qa.naming, the pack scan at load and at import, and the error redactor. The first forbidden term found, or
 * undefined. A term matches when it is
 * - word-bounded, as `assertNoForbidden` finds it (spelled-out letters, stand-ins, a plural or possessive);
 * - glued inside a token (`InitechPay`, `MyInitech`, a domain or a URL path), on squashed text (`squashChars`: folded,
 *   look-alikes and stand-ins mapped, punctuation, soft hyphens and zero-width characters dropped), so `Ini/tech` and
 *   a plural (`Initeches`) are a token holding the term;
 * - split across whole tokens (`Ini tech`, `Ini-` and a newline then `tech`), the joined tokens being exactly the term,
 *   or the term plus a plural s or es. Whole tokens only, so prose that merely runs into the term across a space
 *   (`unit tech`, `I am in tech`) does not hit.
 */
export function forbiddenTermStrict(text: string, naming: Pick<NamingRules, 'forbiddenTerms'>): string | undefined {
  try {
    assertNoForbidden(text, naming);
  } catch (e) {
    if (e instanceof ForbiddenTermError) return e.term;
    throw e;
  }
  let toks: string[] | undefined;
  for (const term of naming.forbiddenTerms) {
    const want = squashChars(term).text;
    if (want === '') continue;
    toks ??= text.split(/\s+/u).map((t) => squashChars(t).text).filter((t) => t !== '');
    for (let i = 0; i < toks.length; i++) {
      let joined = toks[i] as string;
      if (joined.includes(want)) return term;
      for (let j = i + 1; j < toks.length && joined.length < want.length; j++) {
        joined += toks[j] as string;
        if (joined === want || joined === `${want}s` || joined === `${want}es`) return term;
      }
    }
  }
  return undefined;
}

/** `forbiddenTermStrict` as an assertion: throws `ForbiddenTermError` naming the term found. */
export function assertNoForbiddenStrict(text: string, naming: Pick<NamingRules, 'forbiddenTerms'>): void {
  const term = forbiddenTermStrict(text, naming);
  if (term !== undefined) throw new ForbiddenTermError(term);
}

/** What `redactText` puts in place of a token, and of a line, that names a forbidden term. */
export const HIDDEN_TOKEN = '[hidden]';
export const HIDDEN_LINE = '[a line naming a forbidden term is hidden]';

/**
 * The one redactor for error text (final I9): pack-load errors on /facts, the dashboard's error page, the run's stderr
 * (which launchd writes to daily.log) and the failure notification. Line by line, with the strict check
 * (`forbiddenTermStrict`): a clean line is kept; in a line that names a term, each whitespace-separated token that
 * names one is replaced by `[hidden]`, and if the line still names one (a term split across tokens) the whole line is.
 */
export function redactText(text: string, naming: Pick<NamingRules, 'forbiddenTerms'>): string {
  if (naming.forbiddenTerms.length === 0) return text;
  return text
    .split('\n')
    .map((line) => {
      if (forbiddenTermStrict(line, naming) === undefined) return line;
      const tokens = line.replace(/\S+/gu, (t) => (forbiddenTermStrict(t, naming) === undefined ? t : HIDDEN_TOKEN));
      return forbiddenTermStrict(tokens, naming) === undefined ? tokens : HIDDEN_LINE;
    })
    .join('\n');
}

export class EmployerNameError extends Error {
  override readonly name = 'EmployerNameError';
}

/**
 * The name a document shows for a raw employer string (from facts.yaml or roles.yaml): its `employerDisplay` entry
 * (an exact key match), else the raw string itself. Either way the result is checked for forbidden terms, so a raw
 * employer that names a forbidden term and has no mapping, or a mapping that still names one, is a hard error
 * (`EmployerNameError`), never a silent pass-through. The message never echoes the term.
 */
export function employerDisplay(raw: string, naming: NamingRules): string {
  const mapped = Object.hasOwn(naming.employerDisplay, raw) ? (naming.employerDisplay[raw] as string) : undefined;
  const shown = mapped ?? raw;
  try {
    assertNoForbidden(shown, naming);
  } catch (e) {
    if (!(e instanceof ForbiddenTermError)) throw e;
    throw new EmployerNameError(
      mapped === undefined
        ? 'an employer in the pack names a forbidden term and has no naming.employerDisplay entry'
        : 'a naming.employerDisplay entry maps an employer to a name that still holds a forbidden term',
    );
  }
  return shown;
}
