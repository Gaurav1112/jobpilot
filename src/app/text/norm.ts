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
  'united states': ['united states', 'united states of america', 'usa', 'us', 'u.s.', 'u.s.a.', 'u.s', 'new mexico', 'new england'],
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
  australia: ['australia', 'new south wales'],
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

/** Canonical names that are countries (not regions): an address's last one names its country. */
const ISO_NAMES: ReadonlySet<string> = new Set(Object.values(ISO2));
const ALIAS = new Map<string, string>(Object.entries(PLACES).flatMap(([name, spellings]) => spellings.map((s) => [s, name] as const)));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Longest spelling first, so "south east asia" wins over "asia" and "united states of america" over "united states". */
const PLACE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${[...ALIAS.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`,
  'giu',
);

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** India named by a city or state rather than the country: a city of that name elsewhere must not add India. */
const INDIA_BY_NAME = new Set(['india', 'bharat']);
/**
 * Spellings that name a part of a country (a city, a state, a constituent country) rather than the country or a
 * region. Excluding one excludes that part only: "India (excluding Mumbai)" is still India.
 */
const SUB_PLACES: ReadonlySet<string> = new Set([
  ...(PLACES.india ?? []).filter((a) => !INDIA_BY_NAME.has(a)),
  'new mexico', 'new england', 'new south wales', 'england', 'scotland', 'wales', 'northern ireland', 'dubai', 'abu dhabi',
]);
/** Words that turn the places after them (to the end of the clause) into exclusions. */
const EXCLUDING = /\b(?:except|excluding|excl\.?|outside(?: of)?|not(?: in| from)?|anywhere but|but not|other than)\b/i;
/** A clause ends at these; commas do not end it ("except India, Pakistan" excludes both). */
const CLAUSE_END = /[;|()[\]\n]/g;
/** One place: separate locations are joined by these ("Bengaluru or Singapore", "Pune; Austin"). */
const SEGMENT_SPLIT = /[;|\n/&]|\bor\b|\band\b/gi;

/** After "anywhere"/"global": "in|within|across [the] <listed place>". */
const SCOPED_ANYWHERE = new RegExp(`^\\s+(?:in|within|across)\\s+(?:the\\s+)?${PLACE_RE.source}`, 'iu');

interface PlaceScan {
  places: string[];
  /** Excluded countries or regions (canonical names): these leave `places`. */
  excluded: string[];
  /** Excluded cities or states, as written (lower-cased): signalled only, the country stays. */
  excludedParts: string[];
}

function scanPlaces(text: string): PlaceScan {
  const t = text.normalize('NFKC');
  const out: string[] = [];
  const excluded: string[] = [];
  const excludedParts: string[] = [];
  const bounds = [0, ...[...t.matchAll(SEGMENT_SPLIT)].flatMap((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]), t.length];
  for (let k = 0; k + 1 < bounds.length; k += 2) {
    const segStart = bounds[k] ?? 0;
    const segment = t.slice(segStart, bounds[k + 1] ?? t.length);
    const found: { name: string; byCity: boolean }[] = [];
    for (const m of segment.matchAll(PLACE_RE)) {
      const alias = (m[1] ?? '').toLowerCase();
      const name = ALIAS.get(alias);
      if (name === undefined) continue;
      const at = segStart + (m.index ?? 0);
      // "Anywhere in India", "anywhere within APAC": the place scopes the anywhere, so it is not worldwide.
      if (name === 'worldwide' && SCOPED_ANYWHERE.test(t.slice(at + (m[1] ?? '').length))) continue;
      const before = t.slice(0, at);
      const clauseStart = Math.max(-1, ...[...before.matchAll(CLAUSE_END)].map((c) => c.index ?? -1)) + 1;
      if (EXCLUDING.test(before.slice(clauseStart))) {
        if (SUB_PLACES.has(alias)) excludedParts.push(alias.replace(/\s+/g, ' '));
        else excluded.push(name);
        continue;
      }
      found.push({ name, byCity: name === 'india' && !INDIA_BY_NAME.has(alias) });
    }
    // "Hyderabad, Sindh, Pakistan": an address ending in another country is in that country.
    const lastCountry = [...found].reverse().find((f) => ISO_NAMES.has(f.name));
    const cityOnlyIndia = found.some((f) => f.name === 'india') && found.every((f) => f.name !== 'india' || f.byCity);
    for (const f of found) if (!(f.name === 'india' && cityOnlyIndia && lastCountry !== undefined && lastCountry.name !== 'india')) out.push(f.name);
  }
  const ex = sortedUnique(excluded);
  return { places: withoutExcluded(out, ex), excluded: ex, excludedParts: sortedUnique(excludedParts) };
}

/**
 * `places` minus the excluded ones. When India is excluded, `worldwide` goes too: "Anywhere except India" is not a
 * worldwide posting for someone in India.
 */
export function withoutExcluded(places: Iterable<string>, excluded: readonly string[]): string[] {
  const drop = new Set(excluded);
  if (drop.has('india')) drop.add('worldwide');
  return sortedUnique([...places].filter((p) => !drop.has(p)));
}

/**
 * Places named in free location text, as canonical lowercase names, sorted. Text that names no listed place gives [].
 * A place after "except", "excluding", "outside", "not", "anywhere but" (to the end of its clause) is left out; see
 * `hasPlaceExclusion`.
 */
export const countriesIn = (text: string): string[] => scanPlaces(text).places;

/**
 * The cities and states (parts of a country, not the country or a region) named in `text`, as written, lower-cased,
 * in order: "near Pune" gives ['pune'], "in India" gives [].
 */
export const citiesIn = (text: string): string[] =>
  [...text.normalize('NFKC').matchAll(PLACE_RE)].map((m) => (m[1] ?? '').toLowerCase().replace(/\s+/g, ' ')).filter((a) => SUB_PLACES.has(a));

/** The places the text excludes ("Remote (except India)" gives ['india']), sorted; `countriesIn` leaves them out. */
export const excludedPlaces = (text: string): string[] => scanPlaces(text).excluded;

/** The cities or states the text excludes ("India (excluding Mumbai)" gives ['mumbai']); their country stays. */
export const excludedParts = (text: string): string[] => scanPlaces(text).excludedParts;

/**
 * One entry of a structured place list (a Himalayas restriction, a JSON-LD country, an Ashby address country): its
 * canonical name when it is a listed place or an ISO alpha-2 code, every listed place when it names several
 * ("USA & Canada"), else the entry itself lower-cased. An unlisted restriction is kept verbatim rather than dropped,
 * because an empty list means "no restriction".
 */
export function placeOf(entry: string): string[] {
  const t = collapse(entry.normalize('NFKC'));
  if (t === '') return [];
  const code = ISO2[t.toUpperCase()];
  if (/^[A-Za-z]{2}$/.test(t) && code !== undefined) return [code];
  const whole = ALIAS.get(t.toLowerCase());
  if (whole !== undefined) return [whole];
  const found = countriesIn(t);
  return found.length > 0 ? found : [t.toLowerCase()];
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

/** The title's comparison form and the places taken out of it (see `normTitle`). */
export function splitTitle(title: string): { title: string; places: string[] } {
  let t = collapse(title.normalize('NFKC').toLowerCase().replace(GENDER, ' '));
  const places: string[] = [];
  for (;;) {
    const m = /\(([^()]*)\)\s*$/.exec(t);
    if (m === null || !isLocationParen(m[1] ?? '')) break;
    places.push(m[1] ?? '');
    t = t.slice(0, m.index).replace(/[\s,;|:–—-]+$/, '');
  }
  return { title: collapse(t).replace(/[\s.]+$/, ''), places };
}

/**
 * The title's comparison form: NFKC, lowercase, whitespace collapsed, gender markers removed, a trailing full stop
 * removed, and trailing parentheses that only name places or a work arrangement ("(Remote)", "(India)",
 * "(Remote - India)") removed. Other parentheses ("(YDB Team)") are part of the title. `jobKey` moves the removed
 * places into the location part, so "Engineer (US)" and "Engineer (India)" stay distinct.
 */
export const normTitle = (title: string): string => splitTitle(title).title;

/** City spellings that name one place, folded to one form for comparison. */
const CITY_ALIASES: Readonly<Record<string, string>> = {
  bangalore: 'bengaluru', bombay: 'mumbai', gurgaon: 'gurugram', calcutta: 'kolkata', madras: 'chennai', mysore: 'mysuru',
  cochin: 'kochi', trivandrum: 'thiruvananthapuram',
};
const CITY_RE = new RegExp(`(?<![\\p{L}])(${Object.keys(CITY_ALIASES).join('|')})(?![\\p{L}])`, 'gu');

/**
 * The location's comparison form: NFKC, lowercase, split into parts at commas, semicolons, slashes, bars,
 * parentheses and spaced dashes, each part whitespace-collapsed with city spellings folded (Bangalore = Bengaluru),
 * then de-duplicated and sorted, so "Remote, India" and "India (Remote)" compare equal.
 */
export function normLocation(location: string): string {
  const parts = location
    .normalize('NFKC')
    .toLowerCase()
    .replace(CITY_RE, (c) => CITY_ALIASES[c] ?? c)
    .split(/[,;/|()[\]•·]+|\s[-–—]\s|\s[-–—]|[-–—]\s/)
    .map(collapse)
    .filter((p) => p !== '');
  return sortedUnique(parts).join(', ');
}

/**
 * `sha256(company | normTitle | normLocation)`, first 16 hex chars. The company is trimmed, whitespace-collapsed and
 * lower-cased; the places taken out of the title join the location parts.
 */
export function jobKey(company: string, title: string, location: string): string {
  const t = splitTitle(title);
  return sha256Hex(`${collapse(company).toLowerCase()}|${t.title}|${normLocation([location, ...t.places].join(', '))}`).slice(0, 16);
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

/**
 * A figure of years: not part of a longer number or a decimal, not "after/every/within/next/first N years", and not a
 * company's age or a person's.
 */
const YEARS = /(?<![\d.])(?<!\b(?:after|every|within|next|first|for the|up to)\s+)(\d{1,2})\s*(\+?)\s*(?:years?|yrs?)\b(?!\s+(?:old|ago|young)\b|\s+of\s+age\b)/gi;
/** Sentences: lines, then sentence ends followed by a space. */
const SENTENCE_SPLIT = /(?<=[.!?;])\s+/;
const EXPERIENCE = /experience|\bexp\b/i;
/** After "N+ years": what the years are spent on. */
const SPENT_ON = /^\s*(?:of|in|as|with|building|managing|leading|working|developing|designing|running|shipping|hands-on|professional|industry|relevant|commercial|production)\b/i;
/** Sentences about the company, a benefit or history, never a requirement. */
const NOT_A_REQUIREMENT =
  /\b(?:combined|collectively|in business|founded|history|track record|vest(?:s|ed|ing)?|warranty|sabbatical|service award|of service|over the (?:past|last)|anniversary|since)\b/i;
/** The company as the subject ("we have 20 years"), unless it is asking for something. */
const COMPANY_SUBJECT = /\b(?:we|we've|we're|our|us|the company)\b/i;
const ASKING = /\b(?:looking for|seeking|need|needs|require[sd]?|requirements?|must|minimum|at least|you|your|candidates?|ideal|ideally|applicants?|preferred|should|qualifications?)\b|^\s*(?:experience|exp)\b\s*:/i;

/**
 * The largest years requirement in the text, or null. A figure (`N years`, `N+ yrs`, `N year`; "3-5 years" counts 5)
 * counts when its sentence mentions experience ("experience", "exp"), when it sits on a bullet line, or when it is
 * "N+ years of|in|as|with ...". Sentences about the company itself (history, founding, combined experience, "we
 * have ..." without asking for anything), vesting and benefits are skipped. Above 14 years a figure also needs
 * experience or requirement wording in its sentence (a bullet alone is not enough). Figures above 30 are ignored.
 * Accepted trade-off: a bullet-only 15+ requirement ("- 15+ years designing distributed systems") gives null, because
 * company-highlight bullets ("- 20 years in the market") look the same; only a −20 scorer penalty is missed.
 */
export function yearsRequired(text: string): number | null {
  let max: number | null = null;
  for (const line of text.split(/\n+/)) {
    const bullet = /^\s*-\s/.test(line);
    for (const sentence of line.split(SENTENCE_SPLIT)) {
      if (NOT_A_REQUIREMENT.test(sentence)) continue;
      const asking = ASKING.test(sentence);
      if (COMPANY_SUBJECT.test(sentence) && !asking) continue;
      const experience = EXPERIENCE.test(sentence);
      for (const m of sentence.matchAll(YEARS)) {
        const n = Number(m[1]);
        const spentOn = m[2] === '+' && SPENT_ON.test(sentence.slice((m.index ?? 0) + m[0].length));
        if (!experience && !bullet && !spentOn) continue;
        // A bullet alone is not requirement wording: company highlights ("- 20 years in the market") are bullets too.
        if (n > 30 || (n > 14 && !experience && !asking)) continue;
        if (max === null || n > max) max = n;
      }
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
