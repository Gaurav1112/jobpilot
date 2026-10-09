import { sha256Hex } from '../agents/sources/sha256.js';
import { isCalendarDate } from '../types.js';

/**
 * Normalisation helpers for the normalizer agent. Pure (no I/O, no clock); agent code imports them, so the containment
 * scan reads this file like agent code. Hashing uses the pure-TypeScript sha256 the sources use: agent code may not
 * import node:crypto, so the kernel's `canonical.ts` hash is out of reach here.
 */

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

// ---- places ----

/**
 * Canonical lowercase names, each with the spellings that mean it. Regions are tokens of their own: `worldwide`,
 * `apac`, `emea`, `europe`, `americas`, `latam`, `north america`, `asia`, `south asia`, `southeast asia`,
 * `middle east`, `africa`, `oceania`. Matching is whole-word and longest-first, so "Southeast Asia" is not "asia"
 * and "USA1" (an Ashby tier code) is nothing.
 */
const PLACES: Readonly<Record<string, readonly string[]>> = {
  worldwide: ['worldwide', 'world wide', 'anywhere', 'anywhere in the world', 'global', 'globally'],
  apac: ['apac', 'apj', 'asia pacific', 'asia-pacific', 'asia/pacific', 'asiapac'],
  emea: ['emea'],
  europe: ['europe', 'eu', 'european union', 'eea', 'european economic area'],
  americas: ['americas', 'the americas'],
  latam: ['latam', 'latin america', 'south america'],
  'north america': ['north america', 'northern america'],
  asia: ['asia'],
  'south asia': ['south asia'],
  'southeast asia': ['southeast asia', 'south east asia', 'south-east asia', 'sea region'],
  'middle east': ['middle east', 'mena'],
  africa: ['africa'],
  oceania: ['oceania', 'anz'],
  india: [
    'india', 'bharat', 'bangalore', 'bengaluru', 'hyderabad', 'pune', 'chennai', 'mumbai', 'bombay', 'delhi', 'new delhi', 'ncr', 'delhi ncr',
    'gurgaon', 'gurugram', 'noida', 'kolkata', 'calcutta', 'ahmedabad', 'kochi', 'cochin', 'trivandrum', 'thiruvananthapuram', 'jaipur',
    'chandigarh', 'indore', 'coimbatore', 'mysore', 'mysuru', 'nagpur', 'vadodara', 'bhubaneswar', 'visakhapatnam', 'lucknow', 'mohali',
    'karnataka', 'maharashtra', 'telangana', 'tamil nadu', 'kerala', 'haryana', 'uttar pradesh', 'west bengal', 'gujarat',
  ],
  'united states': ['united states', 'united states of america', 'usa', 'us', 'u.s.', 'u.s.a.', 'u.s'],
  'united kingdom': ['united kingdom', 'uk', 'u.k.', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland'],
  canada: ['canada'],
  mexico: ['mexico'],
  brazil: ['brazil', 'brasil'],
  argentina: ['argentina'],
  chile: ['chile'],
  colombia: ['colombia'],
  peru: ['peru'],
  uruguay: ['uruguay'],
  'costa rica': ['costa rica'],
  germany: ['germany', 'deutschland'],
  france: ['france'],
  spain: ['spain'],
  portugal: ['portugal'],
  italy: ['italy'],
  netherlands: ['netherlands', 'the netherlands', 'holland'],
  belgium: ['belgium'],
  luxembourg: ['luxembourg'],
  ireland: ['ireland'],
  switzerland: ['switzerland'],
  austria: ['austria'],
  poland: ['poland'],
  'czech republic': ['czech republic', 'czechia'],
  slovakia: ['slovakia'],
  hungary: ['hungary'],
  romania: ['romania'],
  bulgaria: ['bulgaria'],
  greece: ['greece'],
  croatia: ['croatia'],
  serbia: ['serbia'],
  slovenia: ['slovenia'],
  ukraine: ['ukraine'],
  estonia: ['estonia'],
  latvia: ['latvia'],
  lithuania: ['lithuania'],
  sweden: ['sweden'],
  norway: ['norway'],
  denmark: ['denmark'],
  finland: ['finland'],
  iceland: ['iceland'],
  cyprus: ['cyprus'],
  malta: ['malta'],
  turkey: ['turkey', 'türkiye', 'turkiye'],
  israel: ['israel'],
  'united arab emirates': ['united arab emirates', 'uae', 'dubai', 'abu dhabi'],
  'saudi arabia': ['saudi arabia', 'ksa'],
  qatar: ['qatar'],
  egypt: ['egypt'],
  'south africa': ['south africa'],
  nigeria: ['nigeria'],
  kenya: ['kenya'],
  australia: ['australia'],
  'new zealand': ['new zealand'],
  japan: ['japan'],
  china: ['china', 'prc'],
  'hong kong': ['hong kong'],
  taiwan: ['taiwan'],
  'south korea': ['south korea', 'korea', 'republic of korea'],
  singapore: ['singapore'],
  malaysia: ['malaysia'],
  indonesia: ['indonesia'],
  philippines: ['philippines'],
  thailand: ['thailand'],
  vietnam: ['vietnam', 'viet nam'],
  pakistan: ['pakistan'],
  bangladesh: ['bangladesh'],
  'sri lanka': ['sri lanka'],
  nepal: ['nepal'],
};

/** ISO 3166 alpha-2 codes of the places above (Lever `country`, JSON-LD and Himalayas `alpha2`). */
const ISO2: Readonly<Record<string, string>> = {
  IN: 'india', US: 'united states', GB: 'united kingdom', UK: 'united kingdom', CA: 'canada', MX: 'mexico', BR: 'brazil', AR: 'argentina',
  CL: 'chile', CO: 'colombia', PE: 'peru', UY: 'uruguay', CR: 'costa rica', DE: 'germany', FR: 'france', ES: 'spain', PT: 'portugal',
  IT: 'italy', NL: 'netherlands', BE: 'belgium', LU: 'luxembourg', IE: 'ireland', CH: 'switzerland', AT: 'austria', PL: 'poland',
  CZ: 'czech republic', SK: 'slovakia', HU: 'hungary', RO: 'romania', BG: 'bulgaria', GR: 'greece', HR: 'croatia', RS: 'serbia',
  SI: 'slovenia', UA: 'ukraine', EE: 'estonia', LV: 'latvia', LT: 'lithuania', SE: 'sweden', NO: 'norway', DK: 'denmark', FI: 'finland',
  IS: 'iceland', CY: 'cyprus', MT: 'malta', TR: 'turkey', IL: 'israel', AE: 'united arab emirates', SA: 'saudi arabia', QA: 'qatar',
  EG: 'egypt', ZA: 'south africa', NG: 'nigeria', KE: 'kenya', AU: 'australia', NZ: 'new zealand', JP: 'japan', CN: 'china',
  HK: 'hong kong', TW: 'taiwan', KR: 'south korea', SG: 'singapore', MY: 'malaysia', ID: 'indonesia', PH: 'philippines', TH: 'thailand',
  VN: 'vietnam', PK: 'pakistan', BD: 'bangladesh', LK: 'sri lanka', NP: 'nepal',
};

const ALIAS = new Map<string, string>(Object.entries(PLACES).flatMap(([name, spellings]) => spellings.map((s) => [s, name] as const)));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Longest spelling first, so "south east asia" wins over "asia" and "united states of america" over "united states". */
const PLACE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${[...ALIAS.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`,
  'giu',
);

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** Places named in free location text, as canonical lowercase names, sorted. Text that names no listed place gives []. */
export function countriesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize('NFKC').matchAll(PLACE_RE)) {
    const name = ALIAS.get((m[1] ?? '').toLowerCase());
    if (name !== undefined) out.push(name);
  }
  return sortedUnique(out);
}

/**
 * One entry of a structured place list (a Himalayas restriction, a JSON-LD country, an Ashby address country): its
 * canonical name when it is a listed place or an ISO alpha-2 code, else the entry itself lower-cased. An unlisted
 * restriction is kept verbatim rather than dropped, because an empty list means "no restriction".
 */
export function placeOf(entry: string): string | null {
  const t = collapse(entry.normalize('NFKC'));
  if (t === '') return null;
  if (/^[A-Za-z]{2}$/.test(t) && ISO2[t.toUpperCase()] !== undefined) return ISO2[t.toUpperCase()] ?? null;
  const whole = ALIAS.get(t.toLowerCase());
  if (whole !== undefined) return whole;
  const found = countriesIn(t);
  return found.length === 1 ? (found[0] ?? null) : t.toLowerCase();
}

/** Canonical name of an ISO 3166 alpha-2 code, or null when it is not one of the listed places. */
export const countryOfCode = (code: string): string | null => ISO2[code.trim().toUpperCase()] ?? null;

// ---- titles, locations, keys ----

/** `(m/f/d)`, `(f/m/x)`, `(m/w/d)`, `(h/f)`, `(all genders)` and the like, anywhere in a title. */
const GENDER = /\(\s*(?:[mfwdhx*]\s*\/\s*){1,3}[mfwdhx*]{1,3}\s*\)|\(\s*(?:all genders|gn\*?|d\/f\/m)\s*\)/gi;
/** Words that may sit beside places inside a trailing location parenthesis. */
const LOCATION_WORDS = /\b(?:remote|hybrid|on-?site|in-?office|wfh|work from home|fully|only|based|first|friendly|or|and|in|from|within|anywhere)\b/gi;

function isLocationParen(inner: string): boolean {
  const rest = inner.normalize('NFKC').replace(PLACE_RE, ' ').replace(LOCATION_WORDS, ' ').replace(/[\s,;/|&+–—-]+/g, '');
  return rest === '' && inner.trim() !== '';
}

/**
 * The title's comparison form: NFKC, lowercase, whitespace collapsed, gender markers removed, and trailing
 * parentheses that only name places or a work arrangement ("(Remote)", "(India)", "(Remote - India)") removed.
 * Other parentheses ("(YDB Team)") are part of the title.
 */
export function normTitle(title: string): string {
  let t = collapse(title.normalize('NFKC').toLowerCase().replace(GENDER, ' '));
  for (;;) {
    const m = /\(([^()]*)\)\s*$/.exec(t);
    if (m === null || !isLocationParen(m[1] ?? '')) break;
    t = t.slice(0, m.index).replace(/[\s,;|:–—-]+$/, '');
  }
  return collapse(t);
}

/**
 * The location's comparison form: NFKC, lowercase, split into parts at commas, semicolons, slashes, bars,
 * parentheses and spaced dashes, each part whitespace-collapsed, then de-duplicated and sorted, so "Remote, India"
 * and "India (Remote)" compare equal.
 */
export function normLocation(location: string): string {
  const parts = location
    .normalize('NFKC')
    .toLowerCase()
    .split(/[,;/|()[\]•·]+|\s[-–—]\s|\s[-–—]|[-–—]\s/)
    .map(collapse)
    .filter((p) => p !== '');
  return sortedUnique(parts).join(', ');
}

/** `sha256(company.toLowerCase() | normTitle | normLocation)`, first 16 hex chars. */
export function jobKey(company: string, title: string, location: string): string {
  return sha256Hex(`${company.toLowerCase()}|${normTitle(title)}|${normLocation(location)}`).slice(0, 16);
}

// ---- remote wording ----

const REMOTE_WORDS: readonly (readonly [string, RegExp])[] = [
  ['remote', /\bremote\b/i],
  ['hybrid', /\bhybrid\b/i],
  ['onsite', /\bon-?site\b|\bin[- ]office\b|\bin[- ]person\b/i],
];

/** `<origin>:remote|hybrid|onsite` for each arrangement word in `text`, in that order. */
export function remoteTextSignals(origin: string, text: string): string[] {
  return REMOTE_WORDS.filter(([, re]) => re.test(text)).map(([word]) => `${origin}:${word}`);
}

// ---- experience ----

/** A figure of years: not part of a longer number or a decimal, and not a company's age or a person's. */
const YEARS = /(?<![\d.])(\d{1,2})\+?\s*(?:years|yrs)\b(?!\s+(?:old|ago|young)\b|\s+of\s+age\b)/gi;
/** Sentences: lines, then sentence ends followed by a space. */
const SENTENCE_SPLIT = /\n+|(?<=[.!?;])\s+/;

/**
 * The largest years figure (`N years`, `N+ years`, `N yrs`; "3-5 years" counts 5) in sentences that mention
 * experience. Figures above 30 are ignored. Null when there is none.
 */
export function yearsRequired(text: string): number | null {
  let max: number | null = null;
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    if (!/experience/i.test(sentence)) continue;
    for (const m of sentence.matchAll(YEARS)) {
      const n = Number(m[1]);
      if (n <= 30 && (max === null || n > max)) max = n;
    }
  }
  return max;
}

// ---- dates ----

/** The earliest year a posting date may carry; anything before is a placeholder or a unit error. */
const MIN_YEAR = 1990;
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))?)?$/;

/**
 * A posting date as Posting@1 carries it, or null when it is impossible or unparseable:
 * - a string must be an ISO date or datetime with a real calendar date, a real time of day and offset, and a year
 *   from 1990; it is kept unchanged;
 * - a number is an epoch in the stated unit (Lever: ms; Himalayas: seconds, read as ms when it is above 1e11, the
 *   documented-vs-live discrepancy) and becomes an ISO UTC datetime. A number with no unit is never guessed.
 */
export function postedAtOf(v: unknown, unit?: 'ms' | 's'): string | null {
  if (typeof v === 'string') {
    const s = v.trim();
    const m = ISO.exec(s);
    if (m === null || Number(m[1]) < MIN_YEAR || !isCalendarDate(s.slice(0, 10))) return null;
    if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59)) return null;
    if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) return null;
    return Number.isNaN(Date.parse(s)) ? null : s;
  }
  if (typeof v !== 'number' || unit === undefined || !Number.isFinite(v) || v <= 0) return null;
  const ms = unit === 'ms' || v > 1e11 ? v : v * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < MIN_YEAR || d.getUTCFullYear() > 9999) return null;
  return d.toISOString();
}
