import { isPerk, NOT_BASE, NOT_PAY, OTHER_PAY, SALARY_WORD, TOTAL_PAY } from '../agents/normalizer.js';
import type { Posting } from '../types.js';
import { homeCurrencyOf, isCurrencyCode, type CurrencyCode } from './currencies.js';

/**
 * Pay stated in a description, read in the profile's locale (profiles Task 18, Decision 9). Eligibility uses it only
 * for a profile with a `payLocale` or a home currency outside INR/USD/EUR/GBP, and only when the normalizer found no
 * comp: the default profile's path never reaches this file (`effectiveComp`).
 *
 * Linear time on any input: sentences are split by one pass over the text, each sentence is tokenised by one pass
 * over its characters, and every regex runs on a window of at most a few hundred characters around one figure (there
 * are no nested quantifiers on the text). At most `MAX_FIGURES` plausible figures are read per description.
 *
 * Pure: it imports the normalizer's pay wording, the posting type and the currency table, nothing else.
 */

export const PAY_LOCALES = ['en', 'de', 'fr', 'nl', 'es', 'it', 'pl', 'sv'] as const;
export type PayLocale = (typeof PAY_LOCALES)[number];

/** A comp read from the text: like `Posting.comp`, but in any currency. It lives only inside eligibility. */
export interface LocalComp {
  min: number | null;
  max: number | null;
  currency: CurrencyCode;
  period: 'year';
  basis: 'base' | 'unknown';
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
 * "60.000,50" (de) → 60000.5; "60,000.50" (en) → 60000.5; "60k" → 60000; null when not a number in this locale.
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
// Sentences and tokens
// ---------------------------------------------------------------------------

/** Abbreviations whose dot never ends a sentence (lower-cased, without the dot). */
const ABBREVIATIONS = new Set(['ca', 'max', 'min', 'inkl', 'zzgl', 'bzw', 'approx', 'incl', 'env', 'mtl', 'brt', 'mio', 'tsd', 'nr', 'no', 'eg', 'ie', 'zb', 'ua', 'ggf', 'vs', 'etc', 'pr', 'resp', 'evtl', 'mind']);
const isLetter = (c: string | undefined): boolean => {
  if (c === undefined) return false;
  if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) return true;
  return c > '\u007f' && /\p{L}/u.test(c);
};
const isUpper = (c: string | undefined): boolean => c !== undefined && /\p{Lu}/u.test(c);
const isSpace = (c: string | undefined): boolean => {
  if (c === undefined) return false;
  if (c === ' ' || c === '\n' || c === '\t' || c === '\r') return true;
  return (c < '!' || c > '\u007f') && /\s/u.test(c);
};

/**
 * Sentence ranges `[start, end)`: a line break, `;`, `!`, `?` or a bullet ends one, and so does a `.` followed by
 * white space and a capital letter, unless the word before it is an abbreviation (`ca.`, `max.`, `inkl.`, `z.B.`).
 */
function sentences(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n' || c === ';' || c === '!' || c === '?' || c === '•') {
      out.push([start, i]);
      start = i + 1;
    } else if (c === '.' && isSpace(text[i + 1])) {
      let j = i + 1;
      while (isSpace(text[j])) j++;
      if (!isUpper(text[j])) continue;
      let b = i;
      while (b > start && i - b < 8 && (isLetter(text[b - 1]) || text[b - 1] === '.')) b--;
      if (ABBREVIATIONS.has(text.slice(b, i).replaceAll('.', '').toLowerCase())) continue;
      out.push([start, i + 1]);
      start = i + 1;
    }
  }
  out.push([start, text.length]);
  return out;
}

type Tok =
  | { kind: 'num'; start: number; end: number; raw: string; k: boolean; bad: boolean }
  | { kind: 'cur'; start: number; end: number; code: CurrencyCode | null }
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

/**
 * One pass over a sentence: figures, currencies, range words, other words and other characters (a run of these is
 * one token). `budget.numbers` counts down the figures left for the description; at zero the pass stops.
 */
function tokenise(s: string, home: CurrencyCode, spaces: boolean, budget: { numbers: number }): Tok[] {
  const toks: Tok[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
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
      if ((s[j] === 'k' || s[j] === 'K') && !letterAt(s, j + 1)) {
        k = true;
        j++;
      }
      const raw = s.slice(i, j);
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
        toks.push({ kind: 'cur', start: i, end: j + 1, code: word.length <= 3 ? DOLLAR_PREFIX[word.toUpperCase()] ?? null : null });
        j++;
      } else {
        const code = wordCurrency(word, home);
        const lower = word.toLowerCase();
        if (code !== undefined) toks.push({ kind: 'cur', start: i, end: j, code });
        else if (RANGE_WORDS.has(lower) || AND_WORDS.has(lower)) toks.push({ kind: 'conn', start: i, end: j, word: lower });
        else toks.push({ kind: 'word', start: i, end: j, word: lower });
        // "60000kg", "3rd": a figure glued to a word that is not a currency is not a figure
        if (prev?.kind === 'num' && prev.end === i && code === undefined) prev.bad = true;
      }
      i = j;
    } else {
      const c = s[i] as string;
      const prev = toks[toks.length - 1];
      if (c === '$') toks.push({ kind: 'cur', start: i, end: i + 1, code: DOLLAR_HOMES.has(home) ? home : 'USD' });
      else if (SYMBOLS[c] !== undefined) toks.push({ kind: 'cur', start: i, end: i + 1, code: SYMBOLS[c] as CurrencyCode });
      else if (OTHER_SYMBOLS.has(c)) toks.push({ kind: 'cur', start: i, end: i + 1, code: null });
      else if (DASHES.has(c)) toks.push({ kind: 'conn', start: i, end: i + 1, word: '-' });
      else if (prev?.kind === 'other' && prev.end === i) prev.end = i + 1;
      else toks.push({ kind: 'other', start: i, end: i + 1 });
      i++;
    }
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Wording (on a bounded window around one figure)
// ---------------------------------------------------------------------------

const word = (alts: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}])`, 'iu');
const sub = (alts: string): RegExp => new RegExp(`(?:${alts})`, 'iu');

/** Salary words beyond the normalizer's English ones: a sentence with one states salary even beside a component. */
const LOCAL_SALARY = sub('gehalt|gehält|lohn|löhne|salaire|salario|salarios|sueldo|retribuci[oó]n|stipendio|retribuzione|salaris|wynagrodzeni|pensja|lön|løn|lønn|remunera');
const LOCAL_SALARY_WORD = word('ral|ctc');
/** Pay components that are not salary (the normalizer's `OTHER_PAY` in the profile languages). */
const LOCAL_OTHER = sub('prämie|praemie|urlaubsgeld|weihnachtsgeld|provision|tantieme|aktien|mitarbeiterbeteiligung|zulage|intéressement|commissione|comisi[oó]n|prowizj|premia|provisie|aandelen|optionen|bonusy|bonussen');
const LOCAL_OTHER_WORD = word('primes?|primas?|premi|premio|13e mois|14\\. gehalt');
/**
 * The normalizer's `OTHER_PAY` without its Indian short forms (HRA, PF, EPF, ESIC, DA, LTA, gratuity, flexi): outside
 * `en` they are ordinary words ("da 38.000 €" is Italian for "from").
 */
const OTHER_PAY_INTL = word('equity|rsus?|stocks?|options|esops?|shares|bonus(?:es)?|commissions?|joining|sign[- ]on|relocation|stipend|allowances?|referral|reimburse\\p{L}*|perks?|insurance|meal|variable|incentives?');
/** Total-type pay: never base, so the basis is unknown. */
const LOCAL_TOTAL = sub('zielgehalt|zieleinkommen|gesamtvergütung|gesamtpaket|gesamtjahres|rémunération totale|rémunération globale|package|paquete|pacchetto|totaalpakket|retribución total|retribuzione totale');
/** Money that is not pay (revenue, funding, valuation) in the profile languages; headcounts carry no currency. */
const LOCAL_NOT_PAY = sub('umsatz|finanzierung|investition|bewertung|chiffre d|levée de fonds|facturaci|financiaci|fatturato|omzet|przychod|omsättning|startkapital|risikokapital');
/** Perks and benefit budgets in the profile languages, plus retirement matching. */
const LOCAL_PERK = sub('weiterbildung|fortbildung|schulung|budget|zuschuss|jobrad|jobticket|deutschlandticket|fitness|gutschein|umzug|401\\s*\\(k\\)|matching|homeoffice|home-office|formation continue|plan de formation|mutuelle|tickets? restaurant|télétravail|formación|formazione|buoni pasto|welfare|opleiding|reiskosten|szkoleni|multisport|friskvård|utbildning|kursus|tagegeld|spesen');

/** Period words, by kind: hour, day and week cannot be annualised honestly; month is twelve; year is one. */
const PERIOD = new RegExp(
  `(?<![\\p{L}])(?:${[
    // hour
    '(?<hour>per hour|an hour|/\\s*h(?:ou)?r?|hourly|stündlich|pro stunde|die stunde|/\\s*std\\.?|\\p{L}*stunden(?:lohn|satz)\\p{L}*|par heure|de l[\'’]heure|/\\s*heure|per uur|/\\s*uur|uurloon|por hora|/\\s*hora|all[\'’]ora|orari[ao]|za godzinę|/\\s*godz\\.?|na godzinę|per timme|/\\s*tim|i timmen|timlön|i timen|pr\\.? time)',
    // day
    '(?<day>per day|a day|/\\s*day|daily|day rate|pro tag|/\\s*tag|am tag|\\p{L}*tages(?:satz|honorar)\\p{L}*|par jour|/\\s*jour|journalier|tjm|per dag|/\\s*dag|dagtarief|por día|/\\s*día|al giorno|giornalier[ao]|dziennie|za dzień|/\\s*dzień|dagpris)',
    // week
    '(?<week>per week|a week|/\\s*w(?:ee)?k|weekly|pro woche|/\\s*woche|wöchentlich|par semaine|/\\s*semaine|hebdomadaire|por semana|/\\s*semana|a settimana|settimanal[ei]|tygodniowo|/\\s*tydz\\.?|i veckan|per vecka|om ugen)',
    // month
    '(?<month>per month|a month|/\\s*mo(?:nth)?|/\\s*mth|monthly|p\\.\\s?m\\.|pro monat|/\\s*monat|monatlich|im monat|\\p{L}*monats(?:gehalt|lohn|brutto)\\p{L}*|par mois|/\\s*mois|mensu\\p{L}*|per maand|/\\s*maand|maandelijks|maandsalaris|bruto per maand|por mes|/\\s*mes|al mes|mensual\\p{L}*|al mese|/\\s*mese|mensil\\p{L}*|miesięcznie|/\\s*mies\\.?|na miesiąc|per månad|/\\s*mån|i månaden|månadslön|om måneden|pr\\.? måned|per måned|i måneden|/\\s*md|por mês|/\\s*mês|mensal)',
    // year
    '(?<year>per year|a year|/\\s*y(?:ea)?r|annual\\p{L}*|yearly|p\\.\\s?a\\.|per annum|pro jahr|/\\s*jahr|jährlich|im jahr|\\p{L}*jahres(?:gehalt|lohn|brutto)\\p{L}*|par an|/\\s*an|annuel\\p{L}*|per jaar|/\\s*jaar|jaarlijks|jaarsalaris|por año|/\\s*año|al año|anual\\p{L}*|all[\'’]anno|/\\s*anno|annu[ioa]|lordi annui|rocznie|/\\s*rok|na rok|per år|/\\s*år|om året|årlig\\p{L}*|årslön|por ano|/\\s*ano)',
  ].join('|')})(?![\\p{L}])`,
  'giu',
);
type Period = 'hour' | 'day' | 'week' | 'month' | 'year';
const periodOf = (m: RegExpExecArray): Period => {
  const g = m.groups ?? {};
  return g.hour !== undefined ? 'hour' : g.day !== undefined ? 'day' : g.week !== undefined ? 'week' : g.month !== undefined ? 'month' : 'year';
};
/** The first period word in `after`, else the last in `before`, else a year. */
function periodNear(before: string, after: string): Period {
  PERIOD.lastIndex = 0;
  const a = PERIOD.exec(after);
  if (a !== null) return periodOf(a);
  PERIOD.lastIndex = 0;
  let last: Period = 'year';
  for (let m = PERIOD.exec(before); m !== null; m = PERIOD.exec(before)) {
    last = periodOf(m);
    if (m[0] === '') PERIOD.lastIndex++;
  }
  return last;
}

const UP_TO = /(?<![\p{L}])(?:up ?to|upto|max(?:imum)?\.?(?: of)?|as high as|not exceeding|no more than|bis(?: zu)?|maximal|höchstens|jusqu['’]à|au maximum|tot(?: maximaal)?|maximaal|hasta|fino a|massimo|do|maksymalnie|upp till|högst|até)\s*:?\s*$/iu;
const FROM = /(?<![\p{L}])(?:from|starting(?: at| from)?|starts at|at least|min(?:imum)?\.?(?: of)?|no less than|ab|mindestens|à partir de|dès|au moins|vanaf|minimaal|desde|a partir de|da|a partire da|almeno|od|från|minst)\s*:?\s*$/iu;
const OR_MORE = /^\s*(?:\+(?!\s*\p{L})|or more|and above|or higher|onwards|oder mehr|und mehr|et plus|of meer|o más|e oltre|lub więcej|eller mer|eller mere)/iu;

/** Characters of context read on each side of a figure for its wording, and before or after it for its period. */
const CONTEXT = 160;
const NEAR = 40;
/** At most this many plausible figures are read per description. */
const MAX_FIGURES = 64;
/** The normalizer's INR bounds of a yearly salary. */
const INR_MIN = 100_000;
const INR_MAX = 100_000_000;

interface Piece {
  first: number;
  last: number;
  value: number | null;
  k: boolean;
  code: CurrencyCode | null | undefined;
}

interface Figure {
  start: number;
  end: number;
  min: number;
  max: number;
  code: CurrencyCode | null;
}

/** The figures of one sentence: single amounts and ranges, each with its currency (null when it has no rate here). */
function figuresOf(toks: readonly Tok[], locale: PayLocale): Figure[] {
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
    pieces.push({ first: prefix === undefined ? i : i - 1, last: suffix === undefined ? i : i + 1, value, k: t.k, code: (prefix ?? suffix)?.code });
  }
  const out: Figure[] = [];
  for (let p = 0; p < pieces.length; p++) {
    const a = pieces[p] as Piece;
    const b = pieces[p + 1];
    const between = b !== undefined && b.first === a.last + 2 ? toks[a.last + 1] : undefined;
    const lead = toks[a.first - 1];
    const joins = between?.kind === 'conn' && (between.word === '-' || RANGE_WORDS.has(between.word) || (AND_WORDS.has(between.word) && lead?.kind === 'word' && BETWEEN_WORDS.has(lead.word)));
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
      out.push({ start: (toks[a.first] as Tok).start, end: (toks[b.last] as Tok).end, min: lo, max: hi, code });
    } else if (a.value !== null && a.code !== undefined) {
      out.push({ start: (toks[a.first] as Tok).start, end: (toks[a.last] as Tok).end, min: a.value, max: a.value, code: a.code });
    }
  }
  return out;
}

interface Read {
  min: number | null;
  max: number | null;
  currency: CurrencyCode;
  base: boolean;
}

/**
 * The yearly pay stated in `text`, read in `o.locale`, or null. Each figure needs a currency beside it (a sign or a
 * code); a range shares one. A figure per hour, day or week is not read; per month is twelve times. A sentence about
 * money that is not pay (funding, headcount, a perk or budget) or that names only a pay component (bonus, equity) is
 * not read. "up to" keeps only the max, "from" only the min. Every bound must lie within ₹1 lakh to ₹10 crore a year
 * at the pack's rate, and the currency must have one. Several figures: base ones win, then the home currency's, and
 * the rest must share one currency; their union is the comp, as the normalizer's.
 */
export function parsePay(text: string, o: PayOptions): LocalComp | null {
  const { spaces } = GROUPING[o.locale];
  const reads: Read[] = [];
  const budget = { numbers: MAX_NUMBERS };
  for (const [a, b] of sentences(text)) {
    if (reads.length >= MAX_FIGURES || budget.numbers <= 0) break;
    const s = text.slice(a, b);
    if (!/\d/.test(s)) continue;
    const figures = figuresOf(tokenise(s, o.home, spaces, budget), o.locale);
    for (let f = 0; f < figures.length && reads.length < MAX_FIGURES; f++) {
      const g = figures[f] as Figure;
      if (g.code === null) continue;
      const rate = o.fx.toINR[g.code];
      if (rate === undefined) continue;
      // cheap first: not plausible a year even as a month's pay, or too much even as a year's
      if (g.max * 12 * rate < INR_MIN || g.min * rate > INR_MAX) continue;
      const prevEnd = f > 0 ? (figures[f - 1] as Figure).end : 0;
      const nextStart = f + 1 < figures.length ? (figures[f + 1] as Figure).start : s.length;
      const before = s.slice(Math.max(prevEnd, g.start - NEAR), g.start);
      const after = s.slice(g.end, Math.min(nextStart, g.end + NEAR));
      const period = periodNear(before, after);
      if (period !== 'year' && period !== 'month') continue;
      const perYear = period === 'month' ? 12 : 1;
      let min: number | null = g.min * perYear;
      let max: number | null = g.max * perYear;
      if (![min, max].every((v) => v * rate >= INR_MIN && v * rate <= INR_MAX)) continue;
      const w = s.slice(Math.max(0, g.start - CONTEXT), Math.min(s.length, g.end + CONTEXT));
      if (NOT_PAY.test(w) || LOCAL_NOT_PAY.test(w) || isPerk(w) || LOCAL_PERK.test(w)) continue;
      const other = (o.locale === 'en' ? OTHER_PAY : OTHER_PAY_INTL).test(w) || LOCAL_OTHER.test(w) || LOCAL_OTHER_WORD.test(w);
      const salary = SALARY_WORD.test(w) || LOCAL_SALARY.test(w) || LOCAL_SALARY_WORD.test(w);
      const total = TOTAL_PAY.test(w) || LOCAL_TOTAL.test(w);
      if (total && other) continue;
      if (other && !salary && !total) continue;
      if (g.min === g.max) {
        const up = UP_TO.test(before);
        const from = FROM.test(before) || OR_MORE.test(after);
        if (up && from) continue;
        if (up) min = null;
        if (from) max = null;
      }
      reads.push({ min, max, currency: g.code, base: !total && !NOT_BASE.test(w) });
    }
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
  return { min, max, currency, period: 'year', basis: use.every((r) => r.base) ? 'base' : 'unknown' };
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
