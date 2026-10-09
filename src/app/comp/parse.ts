export type Currency = 'INR' | 'USD' | 'EUR' | 'GBP';

export interface CompRange {
  min: number;
  max: number;
  currency: Currency;
  period: 'year';
}

const WESTERN_GROUPS = /^\d{1,3}(,\d{3})+$/;
const INDIAN_GROUPS = /^\d{1,2}(,\d{2})+,\d{3}$/;

/**
 * Convert a grouped numeric string to a number, or null if its grouping
 * matches neither the western 3-digit nor the Indian 2,2,3 shape. Refusing an
 * unrecognised shape is deliberate: silently de-grouping `18,00000` is how a
 * lakh figure becomes a two-digit number.
 */
export function degroup(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;
  const parts = s.split('.');
  if (parts.length > 2) return null;
  const intPart = parts[0] ?? '';
  const frac = parts[1];
  if (frac !== undefined && !/^\d+$/.test(frac)) return null;

  let digits: string;
  if (intPart.includes(',')) {
    if (!WESTERN_GROUPS.test(intPart) && !INDIAN_GROUPS.test(intPart)) return null;
    digits = intPart.replace(/,/g, '');
  } else {
    if (!/^\d+$/.test(intPart)) return null;
    digits = intPart;
  }

  const n = Number(frac === undefined ? digits : `${digits}.${frac}`);
  return Number.isFinite(n) ? n : null;
}

/**
 * Single source of truth for magnitude vocabulary. Each group lists every
 * spelling that shares a factor and an INR-implying verdict. `MAGNITUDE`,
 * `INR_IMPLYING`, and `MAGWORD_SUFFIX_RE` are all derived from this, so
 * adding a recognised word means touching this list once instead of three
 * separate places that would otherwise have to be kept in sync by hand.
 */
const MAGNITUDE_GROUPS: ReadonlyArray<{
  factor: number;
  impliesInr: boolean;
  words: readonly string[];
}> = [
  { factor: 1e5, impliesInr: true, words: ['lpa', 'lakh', 'lakhs', 'lac', 'lacs', 'l'] },
  { factor: 1e7, impliesInr: true, words: ['cr', 'crore', 'crores'] },
  { factor: 1e3, impliesInr: false, words: ['k'] },
  { factor: 1e6, impliesInr: false, words: ['m'] },
];

const MAGNITUDE: Record<string, number> = Object.fromEntries(
  MAGNITUDE_GROUPS.flatMap((g) => g.words.map((w) => [w, g.factor] as const)),
);

/** Magnitude words that imply rupees even with no symbol present. */
const INR_IMPLYING = new Set(MAGNITUDE_GROUPS.filter((g) => g.impliesInr).flatMap((g) => g.words));

interface Figure {
  base: number;
  factor: number | null; // null means the figure carried no magnitude word
  impliesInr: boolean;
}

/**
 * In `₹50-70 LPA` only the last figure carries the magnitude, but it governs
 * both ends of the range. A bare figure inherits the factor of the nearest
 * figure to its right that has one; if none does, it stands alone.
 *
 * Inheriting the neighbour's factor is the only correct rule here. Inferring a
 * multiplier from the ratio between the two numbers would read `50` as 50,000
 * against a 7,000,000 upper bound — a range no posting ever means.
 */
function applyInheritedFactors(found: Figure[]): number[] {
  const values: number[] = new Array(found.length).fill(0);
  let inherited = 1;
  for (let i = found.length - 1; i >= 0; i -= 1) {
    const figure = found[i]!;
    if (figure.factor !== null) inherited = figure.factor;
    values[i] = figure.base * (figure.factor ?? inherited);
  }
  return values;
}

// ---------------------------------------------------------------------------
// Anchoring
//
// A bare digit run is not a compensation figure. It only counts once it is
// tied to a currency signal: a symbol/code immediately in front of it (`₹50`,
// `Rs. 50`), or a magnitude word/currency code immediately after it (`50 LPA`,
// `150K`, `2500000 INR`). A number with neither is ignored outright — never
// folded into a min/max — unless it is the other end of a range whose
// anchored end supplies the missing signal (`50` in `₹50-70 LPA`).
// ---------------------------------------------------------------------------

// A comma must be followed by digits to be consumed as grouping — otherwise a
// stray trailing comma ("$50,000, negotiable") would be swallowed into the
// figure and hand degroup a shape it correctly refuses, nulling a clean case.
const NUMBER = /\d+(?:,\d+)*(?:\.\d+)?/g;

const PREFIX_RE = /(?:[₹$€£]|\bRs\.?)\s*$/i;
// Longer alternatives first: `lakhs`/`crores` must win over the bare `l`/`cr`.
const MAGWORD_SUFFIX_RE = new RegExp(
  `^\\s*(${MAGNITUDE_GROUPS.flatMap((g) => g.words)
    .slice()
    .sort((a, b) => b.length - a.length)
    .join('|')})\\b`,
  'i',
);
const CODE_SUFFIX_RE = /^\s*(INR|USD|EUR|GBP)\b/i;
const CONNECTOR_RE = /^\s*(?:-|–|—|to)\s*$/i;

interface NumMatch {
  base: number;
  hasPrefix: boolean;
  exprStart: number; // start of the currency prefix, if any, else of the digits
  exprEnd: number; // end of the magnitude/code suffix, if any, else of the digits
  suffixWord: string | null; // lowercased magnitude word, when the suffix is one
  suffixIsCode: boolean; // true when the suffix is a bare currency code
}

function findPrefixStart(text: string, numStart: number): number {
  const before = text.slice(0, numStart);
  const m = PREFIX_RE.exec(before);
  return m ? m.index : numStart;
}

/**
 * Scan every digit run and record whatever anchors it, if any. Returns null
 * if any digit run has grouping that `degroup` refuses to trust — one
 * unparseable figure poisons the string.
 */
function scanNumbers(text: string): NumMatch[] | null {
  const out: NumMatch[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const raw = m[0] ?? '';
    const base = degroup(raw);
    if (base === null) return null;
    const start = m.index ?? 0;
    const end = start + raw.length;

    const hasPrefix = PREFIX_RE.test(text.slice(0, start));
    const after = text.slice(end);
    const magMatch = MAGWORD_SUFFIX_RE.exec(after);
    const codeMatch = magMatch === null ? CODE_SUFFIX_RE.exec(after) : null;
    const magLen = magMatch !== null ? (magMatch[0] ?? '').length : 0;
    const codeLen = codeMatch !== null ? (codeMatch[0] ?? '').length : 0;

    out.push({
      base,
      hasPrefix,
      exprStart: hasPrefix ? findPrefixStart(text, start) : start,
      exprEnd: magMatch !== null ? end + magLen : codeMatch !== null ? end + codeLen : end,
      suffixWord: magMatch !== null ? (magMatch[1] ?? '').toLowerCase() : null,
      suffixIsCode: codeMatch !== null,
    });
  }
  return out;
}

function isAnchored(n: NumMatch): boolean {
  return n.hasPrefix || n.suffixWord !== null || n.suffixIsCode;
}

interface Run {
  nums: NumMatch[];
  exprEnd: number;
}

/**
 * Group consecutive numbers into single figures or exactly one range each. A
 * range connector is a hyphen, en dash, em dash, or the word "to", with only
 * whitespace (and, on the far side, the other number's own currency prefix)
 * separating the two figures. A chain of three or more numbers all joined by
 * connectors (`50-70-90`) is not a shape this parser assigns meaning to, so
 * it is treated as ambiguous.
 */
function buildRuns(nums: NumMatch[], text: string): Run[] | null {
  const runs: Run[] = [];
  let i = 0;
  while (i < nums.length) {
    const first = nums[i]!;
    const second = nums[i + 1];
    if (second !== undefined && CONNECTOR_RE.test(text.slice(first.exprEnd, second.exprStart))) {
      const third = nums[i + 2];
      if (third !== undefined && CONNECTOR_RE.test(text.slice(second.exprEnd, third.exprStart))) {
        return null; // three-or-more-figure chain: not a shape we assign meaning to
      }
      runs.push({ nums: [first, second], exprEnd: second.exprEnd });
      i += 2;
    } else {
      runs.push({ nums: [first], exprEnd: first.exprEnd });
      i += 1;
    }
  }
  return runs;
}

function detectCurrencies(text: string): Set<Currency> {
  const found = new Set<Currency>();
  if (/₹|\bINR\b|\bRs\.?\b/i.test(text)) found.add('INR');
  if (/\$|\bUSD\b/.test(text)) found.add('USD');
  if (/€|\bEUR\b/.test(text)) found.add('EUR');
  if (/£|\bGBP\b/.test(text)) found.add('GBP');
  return found;
}

type PeriodSignal = 'disallowed' | 'monthly' | 'annual';

/**
 * What a single marker position (leading or trailing) resolved to, plus the
 * literal text that matched — needed so a `disallowed` verdict can name the
 * actual marker ("biweekly", "/hour", "semi-monthly", ...) in its refusal
 * reason rather than reporting a bare category. `null` means no marker was
 * found at that position at all.
 */
interface PeriodMarker {
  signal: PeriodSignal;
  raw: string;
}

/**
 * Single source of truth for period vocabulary. An unrecognised
 * period-shaped word must never fall through to the annual default — that
 * default belongs only to the genuinely `absent` case (no marker of any
 * kind). So every marker this parser is willing to reason about is listed
 * explicitly in exactly one of these three buckets; `hourly`/`weekly`/
 * `biweekly`/`quarterly`/... cannot be annualised without assuming a
 * pay-period figure this parser never has, so they resolve to `disallowed`
 * rather than silently defaulting to annual.
 */
const PERIOD_CATEGORIES: ReadonlyArray<{
  signal: 'annual' | 'monthly' | 'disallowed';
  words: readonly string[];
  slashWords: readonly string[];
}> = [
  // `disallowed` is checked first: "semi-monthly" contains "monthly" as a
  // suffix after a hyphen, and a hyphen is a non-word character, so `\b`
  // genuinely holds right before that embedded "monthly". Checking the more
  // specific compound word first stops it from being misread as the shorter
  // marker it happens to contain.
  {
    signal: 'disallowed',
    words: [
      'per\\s+hour',
      'hourly',
      'per\\s+week',
      'weekly',
      'bi-?weekly',
      'fortnightly',
      'per\\s+diem',
      'per\\s+day',
      'daily',
      'quarterly',
      'semi-?monthly',
      'ph',
      'pw',
    ],
    slashWords: ['hour', 'hr', 'week', 'wk', 'day'],
  },
  {
    signal: 'monthly',
    words: ['per\\s+month', 'monthly', 'p\\.m\\.', 'pm'],
    slashWords: ['month', 'mo'],
  },
  {
    signal: 'annual',
    words: ['per\\s+annum', 'p\\.a\\.', 'annually', 'yearly', 'annual', 'pa'],
    slashWords: ['year', 'yr'],
  },
];

// A marker must not be followed by another letter, or by a dot then a letter
// (the "D" in "Ph.D."). Without this, the bare `ph`/`pa`/`pm` abbreviations
// would fire inside ordinary words and credentials ("package", "PhD").
const NOT_A_WORD_CONTINUATION = '(?![a-zA-Z]|\\.[A-Za-z])';

function markerAlternation(words: readonly string[], slashWords: readonly string[]): string[] {
  const parts: string[] = [];
  if (words.length > 0) parts.push(`(?:${words.join('|')})`);
  if (slashWords.length > 0) parts.push(`/\\s*(?:${slashWords.join('|')})`);
  return parts;
}

function buildTrailingRe(words: readonly string[], slashWords: readonly string[]): RegExp {
  const alt = markerAlternation(words, slashWords).join('|');
  return new RegExp(`^(?:${alt})${NOT_A_WORD_CONTINUATION}`, 'i');
}

/**
 * A leading marker must sit immediately before the figure, separated only by
 * an optional label word (`salary`, `pay`, `compensation`, `CTC`, `package`)
 * and punctuation (`:`, `-`, whitespace) — "Monthly salary: ₹1,00,000"
 * qualifies. `\b` guards the start of the word alternatives so "Bimonthly"
 * doesn't register as "monthly".
 *
 * All three categories are compiled into a *single* regex, with one named
 * group per category, rather than tried as three separate regexes in a loop.
 * That matters for a compound marker like "semi-monthly": it contains
 * "monthly" as a genuine `\b`-bounded suffix (the hyphen is a non-word
 * character), so a separate, independently-run `monthly` regex would happily
 * match the embedded word even when the whole-word `disallowed` match is the
 * correct read. One combined regex lets normal leftmost-match scanning do
 * the right thing: it tries the earliest possible start position first, so
 * "semi-monthly" (which starts earlier) is found and wins outright — the
 * embedded "monthly" is never reached, let alone falls back to it.
 */
function buildCombinedLeadingRe(
  categories: ReadonlyArray<{
    signal: 'annual' | 'monthly' | 'disallowed';
    words: readonly string[];
    slashWords: readonly string[];
  }>,
): RegExp {
  const groupAlts = categories.map((c, i) => {
    const parts: string[] = [];
    if (c.words.length > 0) parts.push(`\\b(?:${c.words.join('|')})`);
    if (c.slashWords.length > 0) parts.push(`/\\s*(?:${c.slashWords.join('|')})`);
    return `(?<cat${i}>${parts.join('|')})`;
  });
  return new RegExp(
    `(?:${groupAlts.join('|')})${NOT_A_WORD_CONTINUATION}` +
      `\\s*(?:salary|pay|compensation|ctc|package)?\\s*[:\\-]?\\s*$`,
    'i',
  );
}

const TRAILING_MATCHERS = PERIOD_CATEGORIES.map((c) => ({
  signal: c.signal,
  re: buildTrailingRe(c.words, c.slashWords),
}));
const LEADING_RE = buildCombinedLeadingRe(PERIOD_CATEGORIES);

// How far back a leading marker may sit from the figure it modifies. Sized to
// the worst case in the vocabulary — longest marker ("semi-monthly", 12
// chars) + space + longest label ("compensation", 12 chars) + punctuation
// (2) = 27 — so realistic phrasing like "Semi-monthly compensation: $50,000"
// still resolves, while remaining bounded: it still can't reach into
// unrelated prose several clauses earlier (see the "far away in unrelated
// prose" regression test).
const LEADING_WINDOW = 28;

/**
 * The trailing marker is read only from the text immediately after the comp
 * expression (after leading whitespace/comma), not from the whole string.
 * Scanning the whole string would let an unrelated "5 p.m." interview time or
 * a stray "weekly sync" mention several clauses away silently reclassify the
 * period of a figure it has nothing to do with — turning a clean annual
 * number into a wrong monthly-annualised one.
 */
function matchTrailing(afterExpr: string): PeriodMarker | null {
  const t = afterExpr.replace(/^[\s,]+/, '');
  for (const { signal, re } of TRAILING_MATCHERS) {
    const m = re.exec(t);
    if (m !== null) return { signal, raw: m[0] };
  }
  return null;
}

/**
 * The leading marker is read only from a bounded window before the figure —
 * see `buildCombinedLeadingRe` and `LEADING_WINDOW` for why that stays safe.
 *
 * The bound is enforced by checking the matched marker's distance from the
 * figure, not by pre-slicing the text to the last `LEADING_WINDOW`
 * characters. Pre-slicing is tempting but wrong: it can truncate a glued
 * prefix (`"XXXmonthly salary: $100K"`, no real word break before
 * "monthly") exactly at the marker's first letter, and start-of-string
 * always counts as a `\b` boundary — manufacturing a word break that was
 * never actually there and turning an unrelated run of letters into a false
 * monthly marker. Matching against the real preceding text keeps `\b`
 * honest; the window is still enforced, just after the fact.
 */
function matchLeading(text: string, exprStart: number): PeriodMarker | null {
  const before = text.slice(0, exprStart);
  const m = LEADING_RE.exec(before);
  if (m === null || exprStart - m.index > LEADING_WINDOW) return null;
  const groups = m.groups ?? {};
  for (let i = 0; i < PERIOD_CATEGORIES.length; i += 1) {
    const raw = groups[`cat${i}`];
    if (raw !== undefined) return { signal: PERIOD_CATEGORIES[i]!.signal, raw };
  }
  return null; // unreachable: a successful match always has one named group set
}

/** Either the period resolved (annual/monthly, safe to annualise by), or it
 * was refused, with a reason specific enough to name the actual marker text
 * or the conflicting pair that caused the refusal. */
type PeriodOutcome = { signal: 'annual' | 'monthly' } | { signal: 'disallowed'; reason: string };

/**
 * Read the period from both sides of the winning expression: the text
 * trailing it, and a bounded window leading it. Three outcomes, not two:
 *  - a recognised marker on either side settles it;
 *  - recognised markers on both sides that disagree are a conflict —
 *    `disallowed`, naming both markers;
 *  - no marker on either side is the true "absent" case — assume annual;
 *  - any recognised-but-unsupported marker (hourly/weekly/biweekly/...) is
 *    `disallowed` regardless of what the other side says, because there is
 *    no way to annualise it without guessing — the reason names the exact
 *    marker text that fired.
 * The one thing this function must never do is silently collapse an
 * unrecognised period-shaped word into the annual default — that would be a
 * guess dressed up as a default, and the module's rule is that a plausible
 * wrong number is worse than none.
 */
function detectPeriod(text: string, run: Run): PeriodOutcome {
  const trailing = matchTrailing(text.slice(run.exprEnd));
  const leading = matchLeading(text, run.nums[0]!.exprStart);

  const unsupported = trailing?.signal === 'disallowed' ? trailing : leading?.signal === 'disallowed' ? leading : null;
  if (unsupported !== null) {
    return {
      signal: 'disallowed',
      reason: `unsupported pay period "${unsupported.raw.trim()}" cannot be annualised without assuming a pay-period count`,
    };
  }
  if (trailing !== null && leading !== null && trailing.signal !== leading.signal) {
    return {
      signal: 'disallowed',
      reason: `conflicting pay-period markers: "${leading.raw.trim()}" before the figure vs "${trailing.raw.trim()}" after it`,
    };
  }
  if (trailing !== null) return { signal: trailing.signal as 'annual' | 'monthly' };
  if (leading !== null) return { signal: leading.signal as 'annual' | 'monthly' };
  return { signal: 'annual' };
}

/**
 * The three-way distinction `parseComp` reports instead of a bare boolean
 * "did it parse":
 *  - `parsed` — a confident annual range.
 *  - `absent` — the text carried no figure or money-shaped token at all
 *    ("competitive salary", ""). Neutral: there is nothing to judge.
 *  - `refused` — a figure or money-shaped token WAS present but could not
 *    be resolved with confidence (unknown currency, conflicting currencies,
 *    an unsupported period, an ambiguous multi-figure expression,
 *    unparseable grouping, ...). `reason` names the specific cause so a
 *    human reviewing it knows what to look at, rather than just that
 *    *something* went wrong.
 *
 * Collapsing `absent` and `refused` into one bare `null` (the previous
 * shape) is the defect this type exists to fix: "₹30 LPA + ₹20L joining
 * bonus" is a `refused` case (two anchored figures, not one clean range) and
 * must not be treated the same as a posting that mentions no compensation
 * at all — `meetsFloor` needs to tell them apart to avoid passing a
 * below-floor role just because it also mentioned a bonus.
 */
export type CompResult =
  { kind: 'parsed'; range: CompRange } | { kind: 'absent' } | { kind: 'refused'; reason: string };

const ABSENT: CompResult = { kind: 'absent' };

function refused(reason: string): CompResult {
  return { kind: 'refused', reason };
}

/**
 * Parse a compensation string into an annual range, distinguishing "no
 * figure was mentioned" (`absent`) from "something was mentioned but
 * couldn't be resolved with confidence" (`refused`). A plausible wrong
 * number is worse than none, so every uncertain shape below is `refused`
 * rather than guessed at:
 *  - an ambiguous currency glyph (¥: JPY or CNY),
 *  - a digit run whose grouping matches neither recognised shape,
 *  - three or more figures chained by range connectors,
 *  - no anchored figure at all, despite a number being present,
 *  - two or more anchored figures not joined into one range,
 *  - two different currencies mentioned anywhere in the text,
 *  - a magnitude word (lakh/crore) implying a currency other than the one
 *    detected from a symbol/code,
 *  - a magnitude word that implies no specific currency (K/M) with no
 *    symbol or code to resolve it,
 *  - a recognised-but-unsupported period (hourly/weekly/biweekly/...),
 *  - a leading and trailing period marker that disagree.
 * Only the true absence of any figure or money-shaped token — no digit run
 * in the text at all — is `absent`.
 */
export function parseComp(input: string): CompResult {
  const text = input.trim();
  if (text === '') return ABSENT;
  if (/[¥]/.test(text)) {
    return refused('ambiguous currency symbol: ¥ could mean JPY or CNY, neither of which this parser supports');
  }

  const nums = scanNumbers(text);
  if (nums === null) {
    return refused("a number's digit grouping matches neither the western 3-digit nor the Indian 2,2,3 shape");
  }
  if (nums.length === 0) return ABSENT;

  const runs = buildRuns(nums, text);
  if (runs === null) {
    return refused('three or more figures chained by range connectors — not a shape this parser assigns meaning to');
  }

  const anchoredRuns = runs.filter((r) => r.nums.some(isAnchored));
  if (anchoredRuns.length === 0) {
    return refused(
      'found a number, but no currency symbol, code, or magnitude word anchors it to a compensation signal — currency unknown',
    );
  }
  if (anchoredRuns.length > 1) {
    return refused(
      'multiple anchored figures were found but not joined into a single range (e.g. a base salary and a separate bonus or equity figure)',
    );
  }
  const run = anchoredRuns[0]!;

  const currencies = detectCurrencies(text);
  if (currencies.size > 1) {
    return refused('more than one currency is mentioned in the text (conflicting currency symbols or codes)');
  }
  const currencyArr = [...currencies];
  const symbolCurrency: Currency | null = currencyArr.length === 1 ? currencyArr[0]! : null;

  const figures: Figure[] = run.nums.map((n) => ({
    base: n.base,
    factor: n.suffixWord === null ? null : (MAGNITUDE[n.suffixWord] ?? 1),
    impliesInr: n.suffixWord !== null && INR_IMPLYING.has(n.suffixWord),
  }));

  const magnitudeImpliesInr = figures.some((f) => f.impliesInr);
  if (magnitudeImpliesInr && symbolCurrency !== null && symbolCurrency !== 'INR') {
    return refused('a magnitude word (lakh/crore) implies INR but a different currency symbol is present');
  }

  const currency = symbolCurrency ?? (magnitudeImpliesInr ? 'INR' : null);
  if (currency === null) {
    return refused(
      'the figure carries a magnitude word that does not imply a specific currency (e.g. K or M), and no currency symbol or code is present — currency unknown',
    );
  }

  const period = detectPeriod(text, run);
  if (period.signal === 'disallowed') return refused(period.reason);
  const multiplier = period.signal === 'monthly' ? 12 : 1;

  const values = applyInheritedFactors(figures);
  return {
    kind: 'parsed',
    range: {
      min: Math.min(...values) * multiplier,
      max: Math.max(...values) * multiplier,
      currency,
      period: 'year',
    },
  };
}

/** `pass`, `fail`, or `review` — never a bare boolean, because a bare
 * boolean cannot distinguish "cleared the floor", "missed the floor", and
 * "the posting said something about money that couldn't be parsed with
 * confidence, so a human needs to look" (see `CompResult`). */
export type FloorVerdict = 'pass' | 'fail' | 'review';

export function meetsFloor(result: CompResult, floor: { INR: number; USD: number }): FloorVerdict {
  if (result.kind === 'absent') return 'pass'; // never penalise missing data
  if (result.kind === 'refused') return 'review'; // never silently pass a refusal
  const bar = result.range.currency === 'INR' ? floor.INR : floor.USD;
  return result.range.max >= bar ? 'pass' : 'fail';
}

/** The confident annual range, or null when the text is absent or refused. */
export function parseCompRange(input: string): CompRange | null {
  const result = parseComp(input);
  return result.kind === 'parsed' ? result.range : null;
}
