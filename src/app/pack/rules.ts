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
 * Cyrillic and Greek letters that look like Latin ones, mapped to the Latin letter, so a homoglyph spelling of a
 * forbidden term still matches. For the forbidden-term check only. Over-folding is safe here: it can only make the
 * check stricter, and a false hit needs foreign text that folds to the exact term between word boundaries.
 * Task 9 adds the lower-case lookalikes Greek ε (e) and τ (t), and Cyrillic т (t) and н (h; in many fonts it is a
 * small capital H, and with the text case-folded it reads as h). Greek η is deliberately not mapped to n.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic lower and upper case
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', т: 't', н: 'h',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S',
  // Greek upper case, and the lower case letters that read as Latin
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Χ: 'X', Υ: 'Y',
  ο: 'o', ι: 'i', κ: 'k', ρ: 'p', ν: 'v', ε: 'e', τ: 't',
  // Turkish dotless i (dotted İ decomposes to I plus a combining dot, removed with the other marks)
  ı: 'i',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'gu');

/**
 * Folds text for matching: NFKD, combining marks and invisible format characters (zero-width etc.) removed, Cyrillic
 * and Greek homoglyphs and the dotless i mapped to Latin, case-folded, ß as ss, then NFKC. So `İnitech`, `Іnitech`
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

/** Digits and symbols that stand in for letters, and l for I, for the squashed token check only. */
const STAND_INS: Readonly<Record<string, string>> = { '1': 'i', '!': 'i', '|': 'i', l: 'i', '3': 'e', '0': 'o', '4': 'a', '5': 's', '7': 't', $: 's', '@': 'a' };
/** A token with its stand-ins mapped and everything but letters and digits (hyphens, dots, apostrophes) removed. */
const squash = (tok: string): string =>
  [...tok.replace(/['’]s$/u, '')]
    .map((c) => STAND_INS[c] ?? c)
    .join('')
    .replace(/[^\p{L}\p{N}]/gu, '');
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

/**
 * Throws `ForbiddenTermError` if `text` contains any forbidden term. Both sides are folded (see `fold`).
 * 1. Whitespace runs inside a term match any whitespace (including NBSP and newlines), and boundaries are Unicode
 *    letter/digit lookarounds.
 * 2. (Task 9 review M3) Token by token, on squashed tokens: hyphens, dots and apostrophes inside a token are dropped,
 *    digit and symbol stand-ins are mapped (1 ! | l to i, 3 to e, 0 to o, ...), a run of one-letter tokens is joined,
 *    and a trailing plural s or possessive is allowed; inside a run of spelled-out letters the term may sit anywhere. So `Ini-tech`, `In1tech`, `lnitech`, `I n i t e c h` and
 *    `Initechs` match `Initech`, while `reinitechnology` (a longer word) does not.
 */
export function assertNoForbidden(text: string, naming: Pick<NamingRules, 'forbiddenTerms'>): void {
  const hay = fold(text);
  let tokens: { toks: string[]; runs: string[] } | undefined;
  for (const term of naming.forbiddenTerms) {
    const words = fold(term).split(/\s+/u).filter((w) => w !== '');
    if (words.length === 0) continue;
    const body = words.map(escapeRe).join('\\s+');
    if (new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'u').test(hay)) throw new ForbiddenTermError(term);
    const want = words.map(squash).filter((w) => w !== '');
    if (want.length === 0) continue;
    tokens ??= squashedTokens(hay);
    const { toks, runs } = tokens;
    for (let i = 0; i + want.length <= toks.length; i++) {
      const hit = want.every((w, j) => {
        const t = toks[i + j];
        return t === w || (j === want.length - 1 && t === `${w}s`);
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
