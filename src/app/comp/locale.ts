import type { Posting } from '../types.js';
import { homeCurrencyOf, isCurrencyCode, type CurrencyCode, type PayLocale } from './currencies.js';

/**
 * Pay stated in a description, read in the profile's locale (profiles Task 18, Decision 9). Eligibility uses it only
 * for a profile with a `payLocale` or a home currency outside INR/USD/EUR/GBP, and only when the normalizer found no
 * comp: the default profile's path never reaches this file (`effectiveComp`).
 *
 * A figure is pay only when it follows a salary label ("Gehalt:", "Salary range", "| Salary |", "Our salary for this
 * role is"): a currency beside a number is not enough ("Hardware im Wert von 3.000 €", "a $5k bounty", "Competitive
 * salary, learning budget, up to €2,000"), and a wrong figure could reject a job below the floor.
 *
 * Recall limit, by design: only labelled pay is read (about 60% of genuine pay in a blind holdout). Not read: prose
 * ranges with no label ("zwischen … und", "mellan … och"), shorthand ("tys.", "tkr", "mil", "55k" without a
 * currency), hourly pay, and Portuguese outside a locale that groups with dots. Each fails safe as "pay not disclosed".
 * A figure with no stated period takes its currency's convention (`MONTHLY_PAID`) and is flagged `periodGuessed`:
 * eligibility never rejects on it.
 *
 * Linear time on any input: one regex scan finds the labels (at most `MAX_LABELS`), only the line after each is
 * tokenised (at most `MAX_NUMBERS` figures per description), and every other regex runs on a window of at most a few
 * hundred characters (no nested quantifiers on the text).
 *
 * Pure: it imports the posting type and the currency table, nothing else.
 */

export { PAY_LOCALES, type PayLocale } from './currencies.js';

/** A comp read from the text: like `Posting.comp`, but in any currency. It lives only inside eligibility. */
export interface LocalComp {
  min: number | null;
  max: number | null;
  currency: CurrencyCode;
  period: 'year';
  basis: 'base' | 'unknown';
  /**
   * Present (true) when a figure's period was not stated and the currency's default (`MONTHLY_PAID`) was assumed:
   * eligibility then never rejects it below the floor, it asks for review.
   */
  periodGuessed?: true;
}

interface Fx {
  readonly toINR: Readonly<Record<string, number>>;
}

export interface PayOptions {
  readonly locale: PayLocale;
  readonly home: CurrencyCode;
  readonly fx: Fx;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const SPACES = [' ', '\u00a0', '\u202f', '\u2009'];
const APOSTROPHES = ["'", '’'];
interface Grouping {
  readonly group: ReadonlySet<string>;
  readonly decimal: ',' | '.';
  readonly spaces: boolean;
}
const DOT_GROUPS: Grouping = { group: new Set(['.', ...APOSTROPHES]), decimal: ',', spaces: false };
const SPACE_GROUPS: Grouping = { group: new Set([...SPACES, ...APOSTROPHES]), decimal: ',', spaces: true };
/**
 * How each locale writes a number: `en` groups with `,` and has a decimal point; de, nl, es and it group with `.` and
 * have a decimal comma; fr, pl and sv group with a space (or a no-break or narrow no-break space) and have a decimal
 * comma. An apostrophe groups in every locale (`CHF 120'000`): it is never a decimal mark.
 */
const GROUPING: Readonly<Record<PayLocale, Grouping>> = {
  en: { group: new Set([',', ...APOSTROPHES]), decimal: '.', spaces: false },
  de: DOT_GROUPS,
  nl: DOT_GROUPS,
  es: DOT_GROUPS,
  it: DOT_GROUPS,
  fr: SPACE_GROUPS,
  pl: SPACE_GROUPS,
  sv: SPACE_GROUPS,
};
/** A figure longer than this is not pay (a phone number, an id, a run of digits). */
const MAX_TOKEN = 24;
const MAX_DIGITS = 12;

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/**
 * "60.000,50" (de) → 60000.5; "60,000.50" (en) → 60000.5; "60k" → 60000; "1.2M" → 1200000; null when not a number in
 * this locale.
 * Groups after the first are exactly three digits and all use one separator; a decimal part is one or two digits
 * after the locale's decimal mark; a leading zero (`0800`) is not a figure.
 */
export function localNumber(token: string, locale: PayLocale): number | null {
  let t = token.trim();
  if (t.length === 0 || t.length > MAX_TOKEN) return null;
  let k = 1;
  const last = t[t.length - 1];
  if (last === 'k' || last === 'K') {
    k = 1000;
    t = t.slice(0, -1);
  } else if (last === 'M') {
    k = 1_000_000;
    t = t.slice(0, -1);
  }
  const runs: string[] = [];
  const seps: string[] = [];
  let run = '';
  for (const c of t) {
    if (isDigit(c)) run += c;
    else {
      if (run === '') return null;
      runs.push(run);
      seps.push(c);
      run = '';
    }
  }
  if (run === '') return null;
  runs.push(run);
  const first = runs[0] as string;
  if (first.length > 1 && first.startsWith('0')) return null;
  const { group, decimal } = GROUPING[locale];
  let n = runs.length;
  let fraction = '';
  if (n > 1 && (runs[n - 1] as string).length <= 2) {
    if (seps[n - 2] !== decimal) return null;
    fraction = runs[n - 1] as string;
    n -= 1;
  }
  if (n > 1) {
    const g = seps[0] as string;
    if (!group.has(g) || seps.slice(0, n - 1).some((s) => s !== g)) return null;
    if (first.length > 3 || runs.slice(1, n).some((r) => r.length !== 3)) return null;
  }
  const whole = runs.slice(0, n).join('');
  if (whole.length > MAX_DIGITS) return null;
  const v = (Number(whole) + (fraction === '' ? 0 : Number(`0.${fraction}`))) * k;
  return Number.isFinite(v) ? v : null;
}

/** The figure in the profile's locale, else in `en` (`$110,000` on a German profile), else not a figure. */
const readNumber = (raw: string, locale: PayLocale): number | null => localNumber(raw, locale) ?? (locale === 'en' ? null : localNumber(raw, 'en'));

// ---------------------------------------------------------------------------
// Currencies
// ---------------------------------------------------------------------------

/** Homes for which a bare `$` is the home dollar; anywhere else it is USD. */
const DOLLAR_HOMES: ReadonlySet<CurrencyCode> = new Set(['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD']);
const KRONE_HOMES: ReadonlySet<CurrencyCode> = new Set(['SEK', 'NOK', 'DKK']);
/** `<prefix>$`: the dollar it names. Any other prefix (`NT$`) is a currency without a rate here. */
const DOLLAR_PREFIX: Readonly<Record<string, CurrencyCode>> = {
  US: 'USD', CA: 'CAD', C: 'CAD', A: 'AUD', AU: 'AUD', NZ: 'NZD', S: 'SGD', SG: 'SGD', HK: 'HKD', MX: 'MXN', R: 'BRL',
};
const SYMBOLS: Readonly<Record<string, CurrencyCode>> = { '€': 'EUR', '£': 'GBP', '₹': 'INR', '¥': 'JPY', '₪': 'ILS' };
/** Currency signs jobpilot does not convert: a figure beside one is never pay in another currency. */
const OTHER_SYMBOLS = new Set(['₩', '₱', '฿', '₺', '₦', '₫', '₴', '₽', '元', '₡', '₲', '₸']);
/** ISO codes outside `CURRENCIES` that still mark a figure as money (so it is never read as another currency). */
const OTHER_CODES = new Set([
  'CNY', 'RMB', 'KRW', 'TWD', 'HUF', 'RON', 'BGN', 'ARS', 'CLP', 'COP', 'PEN', 'PHP', 'IDR', 'MYR', 'THB', 'VND', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR',
  'TRY', 'NGN', 'KES', 'EGP', 'UAH', 'RUB', 'PKR', 'BDT', 'LKR', 'NPR', 'ISK', 'GHS', 'MAD',
]);

/** A letter word as a currency: its code, null for a currency without a rate here, undefined when it is not one. */
function wordCurrency(word: string, home: CurrencyCode): CurrencyCode | null | undefined {
  if (/^[A-Z]{3}$/.test(word)) return isCurrencyCode(word) ? word : OTHER_CODES.has(word) ? null : undefined;
  // "usd per year": a lower-case code of a currency jobpilot converts (none of them is a word in these languages)
  if (/^[a-z]{3}$/.test(word)) {
    const up = word.toUpperCase();
    return isCurrencyCode(up) ? up : undefined;
  }
  const w = word.toLowerCase();
  if (w === 'euro' || w === 'euros') return 'EUR';
  if (w === 'zł' || w === 'pln') return 'PLN';
  if (word === 'Kč') return 'CZK';
  if (word === 'Rs') return 'INR';
  if (w === 'kr') return KRONE_HOMES.has(home) ? home : null;
  if (word === 'R' && home === 'ZAR') return 'ZAR';
  return undefined;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type Tok =
  | { kind: 'num'; start: number; end: number; raw: string; k: boolean; bad: boolean }
  /** `bare`: a `$` with no letters before it, whose dollar is a guess (the home dollar, else USD). */
  | { kind: 'cur'; start: number; end: number; code: CurrencyCode | null; bare: boolean }
  | { kind: 'conn'; start: number; end: number; word: string }
  | { kind: 'word'; start: number; end: number; word: string }
  | { kind: 'other'; start: number; end: number };

/** Words that join the two bounds of a range ("60.000 bis 75.000 €", "55 000 € à 65 000 €"). */
const RANGE_WORDS = new Set(['to', 'bis', 'à', 'a', 'tot', 'till', 'hasta', 'al', 'do', 'até']);
/** "and" joins bounds only after "between": "zwischen 60.000 und 75.000 €". */
const AND_WORDS = new Set(['and', 'und', 'et', 'en', 'y', 'e', 'i', 'och', 'og']);
const BETWEEN_WORDS = new Set(['between', 'zwischen', 'entre', 'tussen', 'tra', 'fra', 'między', 'mellan', 'mellem']);
const DASHES = new Set(['-', '–', '—', '‒']);

/** At most this many figures are tokenised per description: a description with more is adversarial, not a job. */
const MAX_NUMBERS = 2000;

const code0 = (s: string, i: number): number => (i < s.length ? s.charCodeAt(i) : -1);
const digitAt = (s: string, i: number): boolean => {
  const c = code0(s, i);
  return c >= 48 && c <= 57;
};
const letterAt = (s: string, i: number): boolean => {
  const c = code0(s, i);
  if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) return true;
  return c > 127 && /\p{L}/u.test(s[i] as string);
};
const spaceAt = (s: string, i: number): boolean => {
  const c = code0(s, i);
  if (c === 32 || c === 10 || c === 9 || c === 13) return true;
  return (c > 127 || (c >= 0 && c < 32)) && /\s/u.test(s[i] as string);
};
/** `.` `,` `'` `’`: marks that may group or end the whole part of a figure. */
const markAt = (s: string, i: number): boolean => {
  const c = code0(s, i);
  return c === 46 || c === 44 || c === 39 || c === 0x2019;
};
const SPACE_CODES = new Set([32, 0xa0, 0x202f, 0x2009]);
const SIGN_AFTER_K = new Set(['€', '$', '£']);

/**
 * One pass over `s[from, to)`: figures, currencies, range words, other words and other characters (a run of these is
 * one token). `budget.numbers` counts down the figures left for the description; at zero the pass stops.
 */
function tokenise(s: string, from: number, to: number, home: CurrencyCode, spaces: boolean, budget: { numbers: number }): Tok[] {
  const toks: Tok[] = [];
  let i = from;
  while (i < to) {
    if (spaceAt(s, i)) {
      i++;
    } else if (digitAt(s, i)) {
      if (budget.numbers-- <= 0) break;
      let j = i;
      for (;;) {
        if (digitAt(s, j)) j++;
        else if (markAt(s, j) && digitAt(s, j + 1)) j++;
        // a space groups only before exactly three digits: "2026 55 000" is 2026, then 55,000
        else if (spaces && SPACE_CODES.has(code0(s, j)) && digitAt(s, j + 1) && digitAt(s, j + 2) && digitAt(s, j + 3) && !digitAt(s, j + 4)) j++;
        else break;
      }
      let k = false;
      let mega = false;
      if ((s[j] === 'k' || s[j] === 'K') && !letterAt(s, j + 1)) {
        k = true;
        j++;
      } else if (s[j] === 'M' && !letterAt(s, j + 1)) {
        // "$1.2M": millions, upper-case M only ("5m" is metres or minutes)
        mega = true;
        j++;
      }
      let raw = s.slice(i, j);
      // French "45 k€": a spaced k right before a currency sign
      if (!k && !mega && SPACE_CODES.has(code0(s, j)) && (s[j + 1] === 'k' || s[j + 1] === 'K') && SIGN_AFTER_K.has(s[j + 2] as string)) {
        k = true;
        raw = `${raw}k`;
        j += 2;
      }
      // "60.000,- €", "CHF 120'000.–": a dash after the mark means no cents
      if ((s[j] === ',' || s[j] === '.') && (s[j + 1] === '-' || s[j + 1] === '–') && !digitAt(s, j + 2)) j += s[j + 2] === '-' ? 3 : 2;
      const prev = toks[toks.length - 1];
      // "v60000", "H1": a figure glued to a word is not a figure
      const gluedLeft = prev !== undefined && prev.end === i && (prev.kind === 'word' || (prev.kind === 'conn' && prev.word !== '-'));
      toks.push({ kind: 'num', start: i, end: j, raw, k, bad: gluedLeft });
      i = j;
    } else if (letterAt(s, i)) {
      let j = i;
      while (letterAt(s, j)) j++;
      const word = s.slice(i, j);
      const prev = toks[toks.length - 1];
      if (s[j] === '$') {
        toks.push({ kind: 'cur', start: i, end: j + 1, code: word.length <= 3 ? DOLLAR_PREFIX[word.toUpperCase()] ?? null : null, bare: false });
        j++;
      } else {
        const code = wordCurrency(word, home);
        const lower = word.toLowerCase();
        if (code !== undefined) toks.push({ kind: 'cur', start: i, end: j, code, bare: false });
        else if (RANGE_WORDS.has(lower) || AND_WORDS.has(lower)) toks.push({ kind: 'conn', start: i, end: j, word: lower });
        else toks.push({ kind: 'word', start: i, end: j, word: lower });
        // "60000kg", "3rd": a figure glued to a word that is not a currency is not a figure
        if (prev?.kind === 'num' && prev.end === i && code === undefined) prev.bad = true;
      }
      i = j;
    } else {
      const c = s[i] as string;
      const prev = toks[toks.length - 1];
      if (c === '$') toks.push({ kind: 'cur', start: i, end: i + 1, code: DOLLAR_HOMES.has(home) ? home : 'USD', bare: true });
      else if (SYMBOLS[c] !== undefined) toks.push({ kind: 'cur', start: i, end: i + 1, code: SYMBOLS[c] as CurrencyCode, bare: false });
      else if (OTHER_SYMBOLS.has(c)) toks.push({ kind: 'cur', start: i, end: i + 1, code: null, bare: false });
      else if (DASHES.has(c)) toks.push({ kind: 'conn', start: i, end: i + 1, word: '-' });
      else if (prev?.kind === 'other' && prev.end === i) prev.end = i + 1;
      else toks.push({ kind: 'other', start: i, end: i + 1 });
      i++;
    }
  }
  return toks;
}

interface Piece {
  first: number;
  last: number;
  value: number | null;
  k: boolean;
  code: CurrencyCode | null | undefined;
  bare: boolean;
}

interface Figure {
  start: number;
  end: number;
  min: number;
  max: number;
  code: CurrencyCode | null;
  /** The currency is a bare `$`'s guess, with no code beside the figure. */
  guessed: boolean;
}

/**
 * The currency code written beside a figure whose sign is a bare `$` (I2: "$90,000 - $110,000 USD", "USD $95,000"):
 * the code wins; two codes ("CAD/USD") leave no currency; none keeps the sign's guess.
 */
function explicitCode(s: string, toks: readonly Tok[], first: number, last: number, guess: CurrencyCode | null): { code: CurrencyCode | null; guessed: boolean } {
  const isCode = (t: Tok | undefined): t is Extract<Tok, { kind: 'cur' }> => t?.kind === 'cur' && !t.bare && t.code !== null;
  const after = toks[last + 1];
  const lastTok = toks[last] as Tok;
  if (isCode(after) && after.start - lastTok.end <= 2) {
    const slash = toks[last + 2];
    if (slash?.kind === 'other' && s.slice(slash.start, slash.end) === '/' && toks[last + 3]?.kind === 'cur') return { code: null, guessed: false };
    return { code: after.code, guessed: false };
  }
  const before = toks[first - 1];
  const firstTok = toks[first] as Tok;
  if (isCode(before) && firstTok.start - before.end <= 2) return { code: before.code, guessed: false };
  return { code: guess, guessed: true };
}

/**
 * The figures of tokens `toks` of `s`: single amounts and ranges, each with its currency (null when it has no rate
 * here). `between`: the text before the first token says "between", so "60.000 und 75.000" is a range.
 */
function figuresOf(s: string, toks: readonly Tok[], locale: PayLocale, between: boolean): Figure[] {
  const pieces: Piece[] = [];
  const used = new Set<number>();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok;
    if (t.kind !== 'num') continue;
    const before = toks[i - 1];
    const after = toks[i + 1];
    const prefix = before?.kind === 'cur' && !used.has(i - 1) && t.start - before.end <= 2 ? before : undefined;
    const suffix = prefix === undefined && after?.kind === 'cur' && after.start - t.end <= 2 ? after : undefined;
    if (suffix !== undefined) used.add(i + 1);
    const value = t.bad ? null : readNumber(t.raw, locale);
    const sign = prefix ?? suffix;
    pieces.push({ first: prefix === undefined ? i : i - 1, last: suffix === undefined ? i : i + 1, value, k: t.k, code: sign?.code, bare: sign?.bare === true });
  }
  const out: Figure[] = [];
  const push = (a: Piece, b: Piece, min: number, max: number, code: CurrencyCode | null): void => {
    const c = a.bare || b.bare ? explicitCode(s, toks, a.first, b.last, code) : { code, guessed: false };
    out.push({ start: (toks[a.first] as Tok).start, end: (toks[b.last] as Tok).end, min, max, code: c.code, guessed: c.guessed });
  };
  for (let p = 0; p < pieces.length; p++) {
    const a = pieces[p] as Piece;
    const b = pieces[p + 1];
    const between2 = b !== undefined && b.first === a.last + 2 ? toks[a.last + 1] : undefined;
    const lead = toks[a.first - 1];
    const afterBetween = (lead?.kind === 'word' && BETWEEN_WORDS.has(lead.word)) || (a.first === 0 && between);
    const joins = between2?.kind === 'conn' && (between2.word === '-' || RANGE_WORDS.has(between2.word) || (AND_WORDS.has(between2.word) && afterBetween));
    if (b !== undefined && joins) {
      p++;
      if (a.value === null || b.value === null) continue;
      if (a.code !== undefined && b.code !== undefined && a.code !== b.code) continue;
      const code = a.code !== undefined ? a.code : b.code;
      if (code === undefined) continue;
      // "€60-75k": the k of one bound applies to a bare bound below a thousand
      const lo = b.k && !a.k && a.value < 1000 ? a.value * 1000 : a.value;
      const hi = a.k && !b.k && b.value < 1000 ? b.value * 1000 : b.value;
      // an inverted range is not read at all
      if (lo > hi) continue;
      push(a, b, lo, hi, code);
    } else if (a.value !== null && a.code !== undefined) {
      push(a, a, a.value, a.value, a.code);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Salary labels
// ---------------------------------------------------------------------------

interface LabelKind {
  /** The label names pay per month ("Monatsgehalt", "monthly salary"). */
  readonly month?: true;
  /** The label names pay per year ("Jahresgehalt", "annual salary", "RAL"): the period is stated. */
  readonly year?: true;
  /** The label names total pay (OTE, total compensation, Zielgehalt): never base. */
  readonly total?: true;
}

/**
 * Salary labels: nouns that name pay, per language, matched as whole words (Unicode-aware). A figure is pay only when
 * it follows one of them (`parsePay`). No bare "pay", "base", "brutto", "brut", "fixe" or "beloning": those only
 * qualify a figure ("pay" counts only in "pay range" or as a heading, "Pay:", see `LABEL_FINDER`; "base" only after a
 * figure, see `POSTFIX`).
 */
const LABELS: Readonly<Record<string, Readonly<Record<string, LabelKind>>>> = {
  en: {
    salary: {}, 'base salary': {}, 'annual salary': { year: true }, 'yearly salary': { year: true }, 'monthly salary': { month: true }, 'salary range': {}, 'base salary range': {},
    'pay range': {}, 'base pay': {}, compensation: {}, 'annual compensation': { year: true }, 'total compensation': { total: true }, remuneration: {},
    ote: { total: true }, 'target earnings': { total: true }, ctc: {},
  },
  de: {
    gehalt: {}, jahresgehalt: { year: true }, bruttojahresgehalt: { year: true }, bruttogehalt: {}, grundgehalt: {}, fixgehalt: {}, festgehalt: {}, zielgehalt: { total: true },
    zieleinkommen: { total: true }, gehaltsband: {}, gehaltsspanne: {}, gehaltsrahmen: {}, monatsgehalt: { month: true }, bruttomonatsgehalt: { month: true },
    vergütung: {}, jahresvergütung: { year: true }, salär: {}, lohn: {}, jahreslohn: { year: true }, monatslohn: { month: true }, bruttolohn: {},
  },
  fr: {
    salaire: {}, 'salaire annuel': { year: true }, 'salaire brut': {}, 'salaire mensuel': { month: true }, rémunération: {}, 'rémunération annuelle': { year: true },
    'rémunération totale': { total: true }, 'fourchette salariale': {}, 'fourchette de salaire': {},
  },
  nl: {
    salaris: {}, salarisindicatie: {}, salarisrange: {}, salarisschaal: {}, jaarsalaris: { year: true }, 'bruto jaarsalaris': { year: true }, maandsalaris: { month: true },
    'bruto maandsalaris': { month: true },
  },
  es: { salario: {}, 'salario bruto anual': { year: true }, sueldo: {}, 'banda salarial': {}, 'rango salarial': {}, remuneración: {}, retribución: {}, 'retribución total': { total: true } },
  pt: { salário: {}, remuneração: {}, 'faixa salarial': {} },
  it: { stipendio: {}, retribuzione: {}, 'retribuzione annua lorda': { year: true }, ral: { year: true } },
  pl: { wynagrodzenie: {}, widełki: {}, 'widełki płacowe': {}, pensja: {} },
  sv: { lön: {}, månadslön: { month: true }, årslön: { year: true }, grundlön: {} },
  da: { løn: {}, månedsløn: { month: true }, årsløn: { year: true } },
  no: { lønn: {}, månedslønn: { month: true }, årslønn: { year: true } },
};
const LABEL_KIND = new Map<string, LabelKind>(Object.values(LABELS).flatMap((l) => Object.entries(l)));
const escape = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
/** Labels after a figure that name it as salary ("$170k to $230k Base", "€50,000 (base salary)"). */
const POSTFIX = ['base salary', 'base pay', 'base', 'salary', 'gehalt', 'grundgehalt', 'jahresgehalt', 'salaire', 'salario', 'sueldo', 'stipendio', 'salaris', 'lön', 'ral'];
/**
 * A finder for whole phrases: one plain literal alternation, longest first, with no `u` flag (a Unicode property
 * class scans non-ASCII text two orders of magnitude slower). `phrasesIn` checks the word boundaries of each hit.
 */
const finder = (phrases: readonly string[], extra: readonly string[] = []): RegExp =>
  new RegExp([...[...phrases].sort((a, b) => b.length - a.length).map(escape), ...extra].join('|'), 'gi');
/** Every label; "pay" only in "pay range" or as a heading ("Pay: $5k/month"). */
const LABEL_FINDER = finder([...LABEL_KIND.keys(), 'pay range'], ['pay(?=[ \\t]*:)']);
const POSTFIX_FINDER = finder(POSTFIX);

/** Every whole-word hit of `re` in `text`, at most `max`. */
function* phrasesIn(text: string, re: RegExp, max: number): Generator<{ index: number; text: string }> {
  re.lastIndex = 0;
  let n = 0;
  for (let m = re.exec(text); m !== null && n < max; m = re.exec(text)) {
    const end = m.index + m[0].length;
    if (letterAt(text, m.index - 1) || digitAt(text, m.index - 1) || letterAt(text, end) || digitAt(text, end)) {
      re.lastIndex = m.index + 1;
      continue;
    }
    n++;
    yield { index: m.index, text: m[0] };
  }
}

/** A word right before a label that makes it name something else ("on-call compensation", "13. Monatsgehalt"). */
const PRE_VETO = new Set([
  'on-call', 'oncall', 'overtime', 'workers', "worker's", 'worker', 'deferred', 'equity', 'bonus', 'variable', 'relocation', 'severance', 'referral',
  'sign-on', 'signing', 'holiday', 'vacation', 'sick', 'travel', 'unemployment', 'pension', 'retirement', 'extra', 'additional', 'christmas',
]);

/** Words allowed between a label and its figure: qualifiers of the label ("Salary range", "Gehalt (brutto)"). */
const QUALIFIERS = new Set([
  'range', 'band', 'bracket', 'indication', 'indicatie', 'scale', 'gross', 'brutto', 'brut', 'bruts', 'brute', 'bruto', 'brutos', 'lordo', 'lorda', 'lordi',
  'annual', 'annually', 'annuel', 'annuelle', 'yearly', 'jährlich', 'monthly', 'monatlich', 'mensuel', 'mensuelle', 'base', 'starting', 'expected',
  'for', 'this', 'the', 'role', 'position', 'job', 'p.a.', 'pa', 'per', 'year', 'annum', 'month', 'jahr', 'monat', 'junior', 'senior', 'mid', 'lead',
  'principal', 'staff', 'range:', 'fixe', 'fixed', 'fix',
]);
/** Words that link a label to its figure inline: "Our salary for this role is €60,000", "Das Gehalt beträgt 60.000 €". */
const LINKING = new Set([
  'is', 'are', 'will', 'be', 'of', 'von', 'de', 'du', 'van', 'di', 'del', 'ist', 'beträgt', 'liegt', 'est', 'sera', 'bedraagt', 'ligt', 'es', 'será',
  'è', 'sarà', 'wynosi', 'är', 'er', 'ranges',
]);
/** Words that introduce the figure: bounds and approximations ("up to", "ab", "zwischen", "ca."). */
const INTROS = new Set([
  'up', 'to', 'upto', 'from', 'between', 'starting', 'at', 'least', 'ab', 'bis', 'zu', 'zwischen', 'à', 'partir', "jusqu'à", 'jusqu’à', 'entre', 'vanaf', 'tot',
  'tussen', 'desde', 'hasta', 'fino', 'a', 'tra', 'da', 'partire', 'od', 'do', 'między', 'från', 'upp', 'till', 'mellan', 'ca', 'ca.', 'circa', 'approx',
  'approx.', 'approximately', 'around', 'rund', 'etwa', 'ungefähr', 'environ', 'ongeveer', 'alrededor', 'około', 'cirka', 'max', 'max.', 'maximal',
  'maximaal', 'min', 'min.', 'mindestens', 'minimum', 'maximum', 'minimaal', 'von', 'de',
]);
const LINK_PUNCT = new Set([':', '|', '=']);
const GAP_WORDS = new Set([...QUALIFIERS, ...LINKING, ...INTROS, 'bei']);
const MARKUP = new Set(['*', '#', '•', '·', '>', '_', '-', '–', '—']);
/** "14 Gehälter à 3.500 €", "13 x 4.000 €", "14 pagas de 2.500 €": N payments of the figure a year (N 12 to 16). */
const MULTI_BEFORE = /^(1[2-6])\s*(?:[x×]|gehälter|monatsgehälter|monatslöhne|pagas|mensilità|mensualités|salaires|maandsalarissen|months|mois|monate)\s*(?:à|a|de|of|von|zu|x|×|@|:)?\s*/iu;
/** "€ 3.500 brutto x 14", "(14x)" after a monthly figure. */
const MULTI_AFTER = /^[^\n(]{0,30}?(?:[x×]\s*(1[2-6])(?!\d)|\(\s*(1[2-6])\s*[x×]\s*\)|\(\s*[x×]\s*(1[2-6])\s*\))/iu;

interface Gap {
  /** Where the figure (its currency sign, code or first digit) starts. */
  readonly start: number;
  /** The text between label and figure: its words may state the period, the basis or a bound. */
  readonly text: string;
  readonly between: boolean;
  /** N payments a year of the figure ("14 Gehälter à 3.500 €"), else 1. */
  readonly payments: number;
}

/**
 * The gap after a label, up to its figure, or null when the label states no figure. The gap may hold markup
 * (`**`, `#`, bullets, `|`), a link (":", "–", "is", "beträgt", "of" …), up to seven qualifier, link or bound words
 * and one parenthetical without digits ("Gehalt (brutto, jährlich):"); it may run to the first figure on the next
 * non-empty line, at most two lines down, when the label's line states nothing else. Inline (not at the start of a
 * line, bullet, cell or sentence), the label needs a link ("Our salary for this role is €60,000").
 */
function gapAfter(text: string, from: number, atStart: boolean, home: CurrencyCode): Gap | null {
  let i = from;
  let words = 0;
  let linked = false;
  let newlines = 0;
  let between = false;
  let payments = 1;
  const limit = Math.min(text.length, from + 200);
  while (i < limit) {
    const c = text[i] as string;
    if (c === '\n') {
      if (++newlines > 3) return null;
      linked = true;
      i++;
    } else if (spaceAt(text, i)) {
      i++;
    } else if (LINK_PUNCT.has(c)) {
      linked = true;
      i++;
    } else if (MARKUP.has(c)) {
      // a dash links a heading to its figure ("Salary – €60k"), and is a bullet on the next line
      if (DASHES.has(c) && atStart) linked = true;
      i++;
    } else if (c === '(') {
      const near = text.slice(i, i + 42).indexOf(')');
      const close = near < 0 ? -1 : i + near;
      if (close < 0 || close - i > 40 || /[\d\n]/.test(text.slice(i, close))) return null;
      i = close + 1;
    } else if (digitAt(text, i)) {
      const m = MULTI_BEFORE.exec(text.slice(i, i + 40));
      if (m !== null && payments === 1 && (digitAt(text, i + m[0].length) || !letterAt(text, i + m[0].length))) {
        payments = Number(m[1]);
        i += m[0].length;
        continue;
      }
      break;
    } else if (letterAt(text, i)) {
      // a word, with inner dots and apostrophes ("p.a", "jusqu'à") and one trailing dot when it is an abbreviation
      let j = i;
      for (;;) {
        while (letterAt(text, j)) j++;
        if ((text[j] === '.' || text[j] === "'" || text[j] === '’') && letterAt(text, j + 1)) j++;
        else break;
      }
      let w = text.slice(i, j).toLowerCase();
      if (text[j] === '.' && GAP_WORDS.has(`${w}.`)) {
        w = `${w}.`;
        j++;
      }
      if (text[j] === '$' || wordCurrency(text.slice(i, j), home) !== undefined) break;
      if (!GAP_WORDS.has(w)) return null;
      if (LINKING.has(w)) linked = true;
      if (BETWEEN_WORDS.has(w)) between = true;
      if (++words > 7) return null;
      i = j;
    } else if (c === '$' || SYMBOLS[c] !== undefined || OTHER_SYMBOLS.has(c)) {
      break;
    } else {
      return null;
    }
  }
  if (i >= limit || !(atStart || linked)) return null;
  return { start: i, text: text.slice(from, i), between, payments };
}

/** Where a label starts its line, bullet, table cell or sentence (after markup), so it needs no link to its figure. */
function atLineStart(text: string, at: number): boolean {
  let j = at;
  let skipped = 0;
  while (j > 0 && skipped < 16) {
    const c = text[j - 1] as string;
    if (c === '\n') return true;
    if (c === '|') return true;
    if (spaceAt(text, j - 1) || MARKUP.has(c)) {
      j--;
      skipped++;
      continue;
    }
    // a sentence end before it ("remote role. base salary: …")
    return (c === '.' || c === '!' || c === '?' || c === ';') && skipped > 0;
  }
  return j === 0;
}

/** The word right before `at` on its line, lower-cased, without surrounding punctuation ("On-call", "13.", "Senior-"). */
function wordBefore(text: string, at: number): string {
  let j = at;
  while (j > 0 && (text[j - 1] === ' ' || text[j - 1] === '\t')) j--;
  let k = j;
  while (k > 0 && j - k < 24 && !spaceAt(text, k - 1)) k--;
  return text.slice(k, j).toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '').replace(/[-'’*"(:]+$/u, '');
}

// ---------------------------------------------------------------------------
// The figure's clause: period, vetoes, add-ons
// ---------------------------------------------------------------------------

/** Period words, by kind: hour, day and week cannot be annualised honestly; month is twelve; year is one. */
const PERIOD = new RegExp(
  // a word form may not start inside a word; a "/" form may follow anything ("brutto/Monat", "USD/month")
  `(?:(?<![\\p{L}])|(?=/))(?:${[
    // hour
    '(?<hour>per hour|an hour|/\\s*h(?:ou)?r?|hourly|stündlich|pro stunde|die stunde|/\\s*std\\.?|\\p{L}*stunden(?:lohn|satz)\\p{L}*|par heure|de l[\'’]heure|/\\s*heure|per uur|/\\s*uur|uurloon|por hora|/\\s*hora|all[\'’]ora|orari[ao]|za godzinę|/\\s*godz\\.?|na godzinę|per timme|/\\s*tim|i timmen|timlön|i timen|pr\\.? time)',
    // day
    '(?<day>per day|a day|/\\s*day|daily|day rate|pro tag|/\\s*tag|am tag|\\p{L}*tages(?:satz|honorar)\\p{L}*|par jour|/\\s*jour|journalier|tjm|per dag|/\\s*dag|dagtarief|por día|/\\s*día|al giorno|giornalier[ao]|dziennie|za dzień|/\\s*dzień|dagpris)',
    // week
    '(?<week>per week|a week|/\\s*w(?:ee)?k|weekly|pro woche|/\\s*woche|wöchentlich|par semaine|/\\s*semaine|hebdomadaire|por semana|/\\s*semana|a settimana|settimanal[ei]|tygodniowo|/\\s*tydz\\.?|i veckan|per vecka|om ugen)',
    // month
    '(?<month>per month|a month|/\\s*mo(?:nth)?|/\\s*mth|monthly|p\\.\\s?m\\.|pro monat|/\\s*monat|monatlich|im monat|\\p{L}*monats(?:gehalt|gehält|lohn|brutto)\\p{L}*|par mois|/\\s*mois|mensu\\p{L}*|per maand|/\\s*maand|maandelijks|maandsalaris|bruto per maand|por mes|/\\s*mes|al mes|mensual\\p{L}*|al mese|/\\s*mese|mensil\\p{L}*|miesięcznie|/\\s*mies\\.?|na miesiąc|/\\s*miesiąc|per miesiąc|per månad|/\\s*månad|/\\s*mån|i månaden|månadslön|om måneden|pr\\.? måned|per måned|i måneden|/\\s*md|por mês|/\\s*mês|mensal|mensais)',
    // year
    '(?<year>per year|a year|/\\s*y(?:ea)?r|annual\\p{L}*|yearly|p\\.\\s?a\\.|per annum|pro jahr|/\\s*jahr|jährlich|im jahr|\\p{L}*jahres(?:gehalt|lohn|brutto)\\p{L}*|par an|/\\s*an|annuel\\p{L}*|per jaar|/\\s*jaar|jaarlijks|jaarsalaris|por año|/\\s*año|al año|anual\\p{L}*|all[\'’]anno|/\\s*anno|annu[ioa]|lordi annui|rocznie|/\\s*rok|na rok|per år|/\\s*år|om året|årlig\\p{L}*|årslön|por ano|/\\s*ano|anuais)',
  ].join('|')})(?![\\p{L}])`,
  'giu',
);
type Period = 'hour' | 'day' | 'week' | 'month' | 'year';
const periodOf = (m: RegExpExecArray): Period => {
  const g = m.groups ?? {};
  return g.hour !== undefined ? 'hour' : g.day !== undefined ? 'day' : g.week !== undefined ? 'week' : g.month !== undefined ? 'month' : 'year';
};
/** The first period word in `s`, or null. */
function periodIn(s: string): Period | null {
  PERIOD.lastIndex = 0;
  const m = PERIOD.exec(s);
  return m === null ? null : periodOf(m);
}

const UP_TO = /(?<![\p{L}])(?:up ?to|upto|max(?:imum)?\.?(?: of)?|as high as|not exceeding|no more than|bis(?: zu)?|maximal|höchstens|jusqu['’]à|au maximum|tot(?: maximaal)?|maximaal|hasta|fino a|massimo|do|maksymalnie|upp till|högst|até)[\s:]*$/iu;
const FROM = /(?<![\p{L}])(?:from|starting(?: at| from)?|starts at|at least|min(?:imum)?\.?(?: of)?|no less than|ab|mindestens|à partir de|dès|au moins|vanaf|minimaal|desde|a partir de|da|a partire da|almeno|od|från|minst)[\s:]*$/iu;
/** "€60k+", "60.000 € oder mehr". A "+" before anything ("+ bonus", "+ €10,000 bonus", "+ 13. Monatsgehalt") is an add-on. */
const OR_MORE = /^\s*(?:\+(?=\s*(?:$|[;,.)|]))|or more|and above|or higher|onwards|oder mehr|und mehr|et plus|of meer|o más|e oltre|lub więcej|eller mer|eller mere)/iu;
/**
 * Where a figure's clause ends: ";", "|", "·", "•", "(", ")", a line end, a "," or "+" before a non-digit, a "." before a
 * capital or the end, or an add-on word ("plus", "zzgl.", "inkl.", "and", "in addition to" …): what follows is
 * another payment, not this figure.
 */
const CLAUSE_PUNCT = /[;|()\n·•]|[,+](?!\d)|\.(?=\s+\p{Lu}|\s*$)/u;
const CLAUSE_WORD = /(?<![\p{L}])(?:plus|zzgl\.?|zuzüglich|inkl\.?|inklusive|einschließlich|incl\.?|including|inclusive of|excl\.?|excluding|and|und|sowie|et|y|e|en|och|og|oraz|in addition to|on top of|with|mit|avec|con|met|med|hors|más|più|oltre)(?![\p{L}])/iu;
/** The first clause end in `s` (punctuation is case-sensitive: a "." ends a clause only before a capital). */
function clauseEnd(s: string): RegExpExecArray | null {
  const p = CLAUSE_PUNCT.exec(s);
  const w = CLAUSE_WORD.exec(s);
  return p === null ? w : w === null || p.index <= w.index ? p : w;
}
/** An add-on that says the figure includes it ("inkl.", "including"): variable pay in it makes the basis unknown. */
const INCLUDES = /^(?:inkl\.?|inklusive|einschließlich|incl\.?|including|inclusive of)$/iu;
/** Pay that is not salary: a figure whose own clause names one is that payment, not the salary. */
const VETO = new RegExp(
  `(?<![\\p{L}])(?:${[
    'bonus\\p{L}*', 'signing', 'sign[- ]on', 'joining', 'budget', 'stipend', 'allowance', 'equity', 'rsus?', 'stocks?', 'options', 'shares', 'insurance',
    'overtime', 'sacrifice', '\\p{L}*umwandlung', 'commissions?', 'provision', 'prämie\\p{L}*', 'weihnachtsgeld', 'urlaubsgeld', '13th', '1[34]\\.\\s*monatsgehalt',
    'relocation', 'referral', 'reimburse\\p{L}*', 'per seat', 'prime', 'primes', 'premio', 'premi', 'prima', 'primas', 'beloning', 'belöning', 'premia',
    'cost', 'costs', 'budget\\p{L}*', 'learning', 'training', 'laptop', 'hardware',
  ].join('|')})(?![\\p{L}])`,
  'iu',
);
/** Variable or total pay: never base. */
const NOT_BASE_WORD = /(?<![\p{L}])(?:ote|on[- ]target|total|target|tc|variable|bonus\p{L}*|commissions?|provision|prämie\p{L}*|gesamt\p{L}*|totale|package|paket|equity|stock|rsus?)(?![\p{L}])/iu;

/** Characters read after a figure for its clause. */
const CLAUSE_MAX = 120;
/** At most this many labels are read per description, and this many plausible figures kept. */
const MAX_LABELS = 256;
const MAX_FIGURES = 64;
/** The normalizer's INR bounds of a yearly salary. */
const INR_MIN = 100_000;
const INR_MAX = 100_000_000;

interface Read {
  min: number | null;
  max: number | null;
  currency: CurrencyCode;
  base: boolean;
  periodGuessed: boolean;
}

/**
 * The period assumed for a figure that states none, per currency (local convention): salaries in Poland, Brazil,
 * Sweden, Norway, Denmark, the Czech Republic, Hungary and Romania are quoted per month; elsewhere per year. HUF and
 * RON are listed for completeness: they have no rate here, so their figures are never read. A guessed period never
 * rejects a job (`periodGuessed`).
 */
const MONTHLY_PAID: ReadonlySet<string> = new Set(['PLN', 'BRL', 'SEK', 'NOK', 'DKK', 'CZK', 'HUF', 'RON']);

/** A labelled figure read in full: its yearly bounds, currency and basis, or null when it is not salary. */
function readFigure(text: string, g: Figure, gap: Gap, kind: LabelKind, o: PayOptions): Read | null {
  let code = g.code;
  // the clause: from the figure to its end
  const rest = text.slice(g.end, Math.min(text.length, g.end + CLAUSE_MAX));
  const endMatch = clauseEnd(rest);
  const clause = endMatch === null ? rest : rest.slice(0, endMatch.index + (endMatch[0] === '.' ? 1 : 0));
  // "Salary: $95,000 (USD)": a code in the parenthetical right after the figure beats a bare $
  const paren = endMatch?.[0] === '(' ? /^\(\s*([A-Za-z]{3})\s*\)/.exec(rest.slice(endMatch.index)) : null;
  if (g.guessed && paren !== null) {
    const c = wordCurrency(paren[1] as string, o.home);
    if (c !== undefined) code = c;
  }
  if (code === null) return null;
  const rate = o.fx.toINR[code];
  if (rate === undefined) return null;
  if (VETO.test(clause)) return null;
  // the period: in the figure's clause, else in the label's words, else a year
  // stated: in the figure's clause, in the label's words, by the label itself, or as N payments a year; else guessed
  const stated = periodIn(clause) ?? periodIn(gap.text) ?? (kind.month === true ? 'month' : kind.year === true || gap.payments > 1 ? 'year' : null);
  const period = stated ?? (MONTHLY_PAID.has(code) ? 'month' : 'year');
  if (period !== 'year' && period !== 'month') return null;
  let factor = period === 'month' ? 12 : 1;
  if (gap.payments > 1) factor = gap.payments;
  else {
    const after = MULTI_AFTER.exec(rest);
    if (after !== null && period === 'month') factor = Number(after[1] ?? after[2] ?? after[3]);
  }
  let min: number | null = g.min * factor;
  let max: number | null = g.max * factor;
  if (![min, max].every((v) => v * rate >= INR_MIN && v * rate <= INR_MAX)) return null;
  if (g.min === g.max) {
    const up = UP_TO.test(gap.text);
    const from = FROM.test(gap.text) || OR_MORE.test(rest);
    if (up && from) return null;
    if (up) min = null;
    if (from) max = null;
  }
  const addOn = endMatch !== null && INCLUDES.test(endMatch[0].trim()) ? rest.slice(endMatch.index, endMatch.index + 60) : '';
  const base = kind.total !== true && !NOT_BASE_WORD.test(clause) && !NOT_BASE_WORD.test(gap.text.replace(/\((?:excl|exkl|zzgl|ohne|hors|sin)[^)]*\)/giu, '')) && !NOT_BASE_WORD.test(addOn.replace(/1[34]\.\s*monatsgehalt|weihnachtsgeld|urlaubsgeld/giu, ''));
  return { min, max, currency: code, base, periodGuessed: stated === null };
}

/** Labels after a figure that name it as salary ("$170k to $230k Base", "€50,000 (base salary)"), at a line, bullet or cell start. */
/** A sibling figure after a labelled one: ", and 224,000 USD - 356,500 USD for Level 5". */
const SIBLING = /^\s*,?\s*(?:and|or|und|oder|et|ou|y|o|e|en|och|og)\s+(?=[\p{Sc}\d]|[A-Z]{3}\s?\d)/u;

/**
 * The yearly pay stated in `text`, read in `o.locale`, or null. A figure is pay ONLY when it follows a salary label
 * (`LABELS`): at the start of a line, bullet, table cell or sentence ("Gehalt: 60.000 €", "| Salary | €50k |",
 * "Vergütung\n\n60.000 €") or inline with a link ("Our salary for this role is €60,000"), with nothing between label and
 * figure but markup, qualifiers ("Salary range", "Gehalt (brutto, jährlich)"), links and bound words ("up to", "ab"). A
 * figure at the start of a line followed by "base"/"salary" counts too ("$170k to $230k Base").
 *
 * The figure's own clause (up to ";", "|", "(", a "," or "+" before a non-digit, a sentence end, or an add-on word such
 * as "plus", "zzgl.", "inkl.", "and") decides the rest: its period ("/Monat", "p.a."; else the label's words, else a
 * year; hour, day and week are never read), its vetoes (bonus, budget, equity, insurance, overtime … : that figure is
 * that payment) and its basis. What follows the clause is an add-on and is ignored ("+ €10,000 bonus", "zzgl. 13.
 * Monatsgehalt"), except that included variable pay ("inkl. Bonus") makes the basis unknown. "14 Gehälter à 3.500 €"
 * is 14 × 3.500 € a year. An explicit code beats a bare "$" ("$95,000 (USD)"). Every bound must lie within ₹1 lakh
 * to ₹10 crore a year at the pack's rate. Several figures: base ones win, then the home currency's, and the rest must
 * share one currency; their union is the comp, as the normalizer's.
 */
export function parsePay(text: string, o: PayOptions): LocalComp | null {
  const { spaces } = GROUPING[o.locale];
  const reads: Read[] = [];
  const budget = { numbers: MAX_NUMBERS };
  /** The figures from `at` to the end of its line, the first of which must start at `at`. */
  const figuresAt = (at: number, between: boolean): Figure[] => {
    // bounded: a search to the next line end could cross the whole text for every label
    const nl = text.slice(at, at + 200).indexOf('\n');
    const end = nl < 0 ? Math.min(text.length, at + 200) : at + nl;
    return figuresOf(text, tokenise(text, at, end, o.home, spaces, budget), o.locale, between);
  };
  const keep = (r: Read | null): void => {
    if (r !== null && reads.length < MAX_FIGURES) reads.push(r);
  };
  for (const m of phrasesIn(text, LABEL_FINDER, MAX_LABELS)) {
    if (budget.numbers <= 0) break;
    const label = m.text.toLowerCase().replace(/\s+/gu, ' ');
    const kind = LABEL_KIND.get(label) ?? {};
    const before = wordBefore(text, m.index);
    if (PRE_VETO.has(before) || /\d/.test(before)) continue;
    const gap = gapAfter(text, m.index + m.text.length, atLineStart(text, m.index), o.home);
    if (gap === null) continue;
    const figures = figuresAt(gap.start, gap.between);
    const first = figures[0];
    // the figure must come first: only currency codes or signs may sit between the gap and its first digit
    if (first === undefined || /[^\s\p{Sc}A-Za-z]/u.test(text.slice(gap.start, first.start)) || /[a-z]/.test(text.slice(gap.start, first.start))) continue;
    keep(readFigure(text, first, gap, kind, o));
    // siblings: ", and 224,000 USD - 356,500 USD for Level 5"
    let last = first;
    for (let s = 1; s < 4; s++) {
      const after = text.slice(last.end, Math.min(text.length, last.end + CLAUSE_MAX));
      const end = clauseEnd(after);
      const from = last.end + (end === null ? after.length : end.index);
      const sib = SIBLING.exec(text.slice(from, from + 12));
      if (sib === null) break;
      const next = figuresAt(from + sib[0].length, false)[0];
      if (next === undefined || next.start - (from + sib[0].length) > 4) break;
      keep(readFigure(text, next, { ...gap, payments: 1 }, kind, o));
      last = next;
    }
  }
  // postfix labels: a figure at the start of a line, bullet or cell, then "base" / "salary"
  for (const m of phrasesIn(text, POSTFIX_FINDER, MAX_LABELS)) {
    if (budget.numbers <= 0) break;
    let lineStart = m.index;
    while (lineStart > 0 && text[lineStart - 1] !== '\n' && text[lineStart - 1] !== '|' && m.index - lineStart < 120) lineStart--;
    let at = lineStart;
    while (at < m.index && (spaceAt(text, at) || MARKUP.has(text[at] as string))) at++;
    const figures = figuresAt(at, false);
    const first = figures[0];
    if (first === undefined || first.start !== at) continue;
    // only gross words, a currency code or "(" between the figure and the label
    if (!/^[\s(]*(?:(?:brutto|gross|brut|bruto|lordo)\s*)?(?:\(\s*)?$/iu.test(text.slice(first.end, m.index))) continue;
    const g = { ...first, end: m.index + m.text.length };
    keep(readFigure(text, g, { start: at, text: '', between: false, payments: 1 }, {}, o));
  }
  const base = reads.filter((r) => r.base);
  const pick = base.length > 0 ? base : reads;
  const home = pick.filter((r) => r.currency === o.home);
  const use = home.length > 0 ? home : pick;
  const currency = use[0]?.currency;
  if (currency === undefined || use.some((r) => r.currency !== currency)) return null;
  const min = use.some((r) => r.min === null) ? null : Math.min(...use.map((r) => r.min as number));
  const max = use.some((r) => r.max === null) ? null : Math.max(...use.map((r) => r.max as number));
  if (min === null && max === null) return null;
  const comp: LocalComp = { min, max, currency, period: 'year', basis: use.every((r) => r.base) ? 'base' : 'unknown' };
  if (use.some((r) => r.periodGuessed)) comp.periodGuessed = true;
  return comp;
}

/** The currencies the normalizer reads: a profile in one of them with no `payLocale` keeps the posting's comp as is. */
const NORMALIZER_CURRENCIES: ReadonlySet<string> = new Set(['INR', 'USD', 'EUR', 'GBP']);

/** The parts of the pack `effectiveComp` reads (eligibility's pack view fits it). */
export interface PayPack {
  readonly offers: { readonly floor: { readonly currency: string } | null; readonly payLocale?: PayLocale | undefined };
  readonly fx: Fx;
}

/**
 * The comp eligibility judges. The posting's own comp, unchanged, when the profile has no `payLocale` and its home
 * currency is INR, USD, EUR or GBP (the owner's path is untouched); otherwise the posting's comp when it has one, else
 * the pay read from its description in `payLocale` (default `en`), which may be null.
 */
export function effectiveComp(p: Posting, pack: PayPack): LocalComp | Posting['comp'] {
  const home = homeCurrencyOf(pack);
  const locale = pack.offers.payLocale;
  if (locale === undefined && NORMALIZER_CURRENCIES.has(home)) return p.comp;
  if (p.comp !== null) return p.comp;
  return parsePay(p.descriptionText, { locale: locale ?? 'en', home, fx: pack.fx });
}
