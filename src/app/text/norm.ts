import { sha256Hex } from '../agents/sources/sha256.js';
import type { OfficeCity } from '../geo/base.js';
import { DEFAULT_PLACES, type PlaceTable } from '../geo/places.js';
import { isCalendarDate } from '../types.js';

/**
 * Normalisation helpers for the normalizer agent. Pure (no I/O, no clock); agent code imports them, so the containment
 * scan reads this file like agent code. Hashing uses the pure-TypeScript sha256 the sources use: agent code may not
 * import node:crypto, so the kernel's `canonical.ts` hash is out of reach here.
 */

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

// ---- places ----

/**
 * The places (countries and regions with their spellings) are `BASE_PLACES` (`../geo/base.ts`); a residence's cities
 * and states join its country's entry in its `PlaceTable` (`../geo/places.ts`). Every function here that reads places
 * takes an optional last `table`, by default `DEFAULT_PLACES` (India's).
 */

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
/** Every ISO alpha-2 code the table knows (`UK` as well as `GB`). */
export const ISO2_CODES: readonly string[] = Object.keys(ISO2);

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** Parts of countries every table knows: constituent countries, states and cities spelled in `BASE_PLACES`. */
const BASE_SUB_PLACES = ['new mexico', 'new england', 'new south wales', 'england', 'scotland', 'wales', 'northern ireland', 'dubai', 'abu dhabi'];

/** What a table's place scan derives from it, built once per table. */
interface TableScan {
  /**
   * Spellings that name a part of a country (a city, a state, a constituent country) rather than the country or a
   * region: the residence country's spellings that are not `byName`, plus `BASE_SUB_PLACES`. Excluding one excludes
   * that part only: "India (excluding Mumbai)" is still India.
   */
  readonly subPlaces: ReadonlySet<string>;
  /** After "anywhere"/"global": "in|within|across [the] <listed place>". */
  readonly scopedAnywhere: RegExp;
  /** The residence country's canonical name (India's table: `india`), or null when the table names none. */
  readonly country: string | null;
}
const scans = new WeakMap<PlaceTable, TableScan>();
function tableScan(table: PlaceTable): TableScan {
  let s = scans.get(table);
  if (s !== undefined) return s;
  // The residence country is the one its by-name spellings (India's: india, bharat) name.
  const country = [...table.byName].map((a) => table.alias.get(a)).find((n) => n !== undefined);
  s = {
    subPlaces: new Set([...(country === undefined ? [] : (table.places[country] ?? [])).filter((a) => !table.byName.has(a)), ...BASE_SUB_PLACES]),
    scopedAnywhere: new RegExp(`^\\s+(?:in|within|across)\\s+(?:the\\s+)?${table.re.source}`, 'iu'),
    country: country ?? null,
  };
  scans.set(table, s);
  return s;
}
/** Words that turn the places after them (to the end of the clause) into exclusions. */
const EXCLUDING = /\b(?:except|excluding|excl\.?|outside(?: of)?|not(?: in| from)?|anywhere but|but not|other than)\b/i;
/** A clause ends at these; commas do not end it ("except India, Pakistan" excludes both). */
const CLAUSE_END = /[;|()[\]\n]/g;
/** One place: separate locations are joined by these ("Bengaluru or Singapore", "Pune; Austin"). */
const SEGMENT_SPLIT = /[;|\n/&]|\bor\b|\band\b/gi;

interface PlaceScan {
  places: string[];
  /** Excluded countries or regions (canonical names): these leave `places`. */
  excluded: string[];
  /** Excluded cities or states, as written (lower-cased): signalled only, the country stays. */
  excludedParts: string[];
}

/**
 * Final fix I6: a country code in capitals glued to a short tier number ("USA1", "US2", "UK3", an Ashby pay-tier or
 * location code) names that country. Lower case or a longer number is not a tier code.
 */
const TIER_CODE = /(?<![\p{L}\p{N}])(USA|US|UK|EU)(?=\d{1,2}(?![\p{L}\p{N}]))/gu;

function scanPlaces(text: string, table: PlaceTable = DEFAULT_PLACES): PlaceScan {
  const { subPlaces, scopedAnywhere, country: home } = tableScan(table);
  const t = text.normalize('NFKC').replace(TIER_CODE, '$1 ');
  const out: string[] = [];
  const excluded: string[] = [];
  const excludedParts: string[] = [];
  const bounds = [0, ...[...t.matchAll(SEGMENT_SPLIT)].flatMap((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]), t.length];
  for (let k = 0; k + 1 < bounds.length; k += 2) {
    const segStart = bounds[k] ?? 0;
    const segment = t.slice(segStart, bounds[k + 1] ?? t.length);
    const found: { name: string; byCity: boolean }[] = [];
    for (const m of segment.matchAll(table.re)) {
      const alias = (m[1] ?? '').toLowerCase();
      const name = table.alias.get(alias);
      if (name === undefined) continue;
      const at = segStart + (m.index ?? 0);
      // "Anywhere in India", "anywhere within APAC": the place scopes the anywhere, so it is not worldwide.
      if (name === 'worldwide' && scopedAnywhere.test(t.slice(at + (m[1] ?? '').length))) continue;
      const before = t.slice(0, at);
      const clauseStart = Math.max(-1, ...[...before.matchAll(CLAUSE_END)].map((c) => c.index ?? -1)) + 1;
      if (EXCLUDING.test(before.slice(clauseStart))) {
        if (subPlaces.has(alias)) excludedParts.push(alias.replace(/\s+/g, ' '));
        else excluded.push(name);
        continue;
      }
      found.push({ name, byCity: name === home && !table.byName.has(alias) });
    }
    // "Hyderabad, Sindh, Pakistan" (or "Berlin, NH, United States" for Germany): an address whose residence-country
    // name comes only from a city or state and that ends in another country is in that country.
    const lastCountry = [...found].reverse().find((f) => ISO_NAMES.has(f.name));
    const cityOnlyHome = found.some((f) => f.name === home) && found.every((f) => f.name !== home || f.byCity);
    for (const f of found) if (!(f.name === home && cityOnlyHome && lastCountry !== undefined && lastCountry.name !== home)) out.push(f.name);
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
export const countriesIn = (text: string, table: PlaceTable = DEFAULT_PLACES): string[] => scanPlaces(text, table).places;

/**
 * The cities and states (parts of a country, not the country or a region) named in `text`, as written, lower-cased,
 * in order: "near Pune" gives ['pune'], "in India" gives [].
 */
export const citiesIn = (text: string, table: PlaceTable = DEFAULT_PLACES): string[] =>
  [...text.normalize('NFKC').matchAll(table.re)].map((m) => (m[1] ?? '').toLowerCase().replace(/\s+/g, ' ')).filter((a) => tableScan(table).subPlaces.has(a));

/** The places the text excludes ("Remote (except India)" gives ['india']), sorted; `countriesIn` leaves them out. */
export const excludedPlaces = (text: string, table: PlaceTable = DEFAULT_PLACES): string[] => scanPlaces(text, table).excluded;

/** The cities or states the text excludes ("India (excluding Mumbai)" gives ['mumbai']); their country stays. */
export const excludedParts = (text: string, table: PlaceTable = DEFAULT_PLACES): string[] => scanPlaces(text, table).excludedParts;

/**
 * One entry of a structured place list (a Himalayas restriction, a JSON-LD country, an Ashby address country): its
 * canonical name when it is a listed place or an ISO alpha-2 code, every listed place when it names several
 * ("USA & Canada"), else the entry itself lower-cased. An unlisted restriction is kept verbatim rather than dropped,
 * because an empty list means "no restriction".
 */
export function placeOf(entry: string, table: PlaceTable = DEFAULT_PLACES): string[] {
  const t = collapse(entry.normalize('NFKC'));
  if (t === '') return [];
  const code = ISO2[t.toUpperCase()];
  if (/^[A-Za-z]{2}$/.test(t) && code !== undefined) return [code];
  const whole = table.alias.get(t.toLowerCase());
  if (whole !== undefined) return [whole];
  const found = countriesIn(t, table);
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
  const rest = inner.normalize('NFKC').replace(DEFAULT_PLACES.re, ' ').replace(LOCATION_WORDS, ' ').replace(/[\s,;/|&+–—-]+/g, '');
  return rest === '' && inner.trim() !== '';
}

/** Mode and qualifier words that may sit beside places in an explicit location label's value. */
const LABEL_VALUE_WORDS = /\b(?:mode|ka|excluding|except|outside|office|offices)\b/gi;

/**
 * True when `text` is only a location list: listed places (cities, states, countries) and mode words (hybrid, remote,
 * in-office, ...) separated by , / ; | ( ) & - and dashes. Any other word ("our", "is", "closing", "snacks") makes it
 * prose, not a list.
 */
export function isPlaceList(text: string, table: PlaceTable = DEFAULT_PLACES): boolean {
  const rest = text.normalize('NFKC').replace(table.re, ' ').replace(LOCATION_WORDS, ' ').replace(LABEL_VALUE_WORDS, ' ').replace(/[\s,;/|&+()–—-]+/g, '');
  return rest === '' && text.trim() !== '';
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
 * "(Remote - India)") removed. Other parentheses ("(YDB Team)") are part of the title. `dedupeKey` moves the removed
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
 * The posting's identity: `sha256(source | sourceId)`, first 16 hex chars. Stable for one posting across days (a
 * re-emitted posting is a newer version of the same job) and unique per posting, so two postings of one title at one
 * company stay two jobs with two document folders.
 */
export function jobKey(source: string, sourceId: string): string {
  return sha256Hex(`${source}|${sourceId}`).slice(0, 16);
}

/**
 * Career-sites fix round 4: the registry platform adapters whose job ids are only unique within one tenant, board or
 * site (a Workday req id `JR1001`, an Oracle requisition, a Personio or Pinpoint number, ...), or not confirmed global.
 * Their posting's `sourceId`, and so its identity, is qualified with the board. Left out: the watchlist adapters
 * (greenhouse, lever, ashby: global ids; careers and the feeds: URLs), jsonld-sitemap (a hash of the full page URL,
 * host included) and bamboohr (its adapter already emits `<slug>:<id>`).
 */
export const TENANT_SCOPED_SOURCES: ReadonlySet<string> = new Set([
  'workday', 'eightfold', 'oracle', 'icims', 'successfactors', 'smartrecruiters',
  'workable', 'recruitee', 'teamtailor', 'personio', 'breezy', 'pinpoint', 'rippling', 'gem',
]);

/**
 * A posting's source id, the stable documented format the normalizer stores: `<board>|<platform id>` for a
 * TENANT_SCOPED_SOURCES source, where `<board>` is the DiscoveryRequest slug (the registry board ref, e.g. Workday
 * `<host>/<tenant>/<site>`) without an Eightfold API-variant prefix (`pcsx:`, `v2:`, which a weekly verify may change),
 * so the same tenant's job keeps one identity across days. Board refs hold no `|`, so the pair is unambiguous. Any other
 * source: the adapter's id unchanged.
 */
export function postingSourceId(source: string, slug: string, sourceId: string): string {
  if (!TENANT_SCOPED_SOURCES.has(source)) return sourceId;
  return `${boardRefOf(slug)}|${sourceId}`;
}

/** A registry board ref as it appears in a posting source id: without an Eightfold API-variant prefix. */
export const boardRefOf = (ref: string): string => ref.replace(/^(?:v2|pcsx):/u, '');

/** The board and platform id of a tenant-scoped posting source id (`postingSourceId`), or null for any other source. */
export function splitPostingSourceId(source: string, sourceId: string): { board: string; id: string } | null {
  if (!TENANT_SCOPED_SOURCES.has(source)) return null;
  const cut = sourceId.indexOf('|');
  return cut <= 0 || cut === sourceId.length - 1 ? null : { board: sourceId.slice(0, cut), id: sourceId.slice(cut + 1) };
}

/**
 * The cross-source duplicate key: `sha256(company | normTitle | normLocation)`, first 16 hex chars. The company is
 * trimmed, whitespace-collapsed and lower-cased; the places taken out of the title join the location parts. Used only
 * to link one job listed on two sources (a Greenhouse posting also on a feed); never an identity.
 */
export function dedupeKey(company: string, title: string, location: string): string {
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

// ---- office cities ----

/**
 * Office city keys (the pack's `eligibility.officeCities`) and the spellings each one matches come from the residence's
 * country file (`table.offices`). Generic place data: which cities count is the pack's choice. An unknown key matches
 * only itself and shows title-cased ("kochi" shows "Kochi").
 */
export type { OfficeCity } from '../geo/base.js';

/** A city key in canonical form: trimmed, lower-cased, inner spaces collapsed. */
export const cityKey = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, ' ');

/** The office city for one pack entry. */
export function officeCity(raw: string, table: PlaceTable = DEFAULT_PLACES): OfficeCity {
  const key = cityKey(raw);
  const known = Object.hasOwn(table.offices, key) ? table.offices[key] : undefined;
  return known ?? { display: key.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase()), aliases: [key] };
}

/** The display names for the pack's office cities, in pack order, each once. */
export const officeCityDisplays = (raw: readonly string[], table: PlaceTable = DEFAULT_PLACES): string[] => [...new Set(raw.map((r) => officeCity(r, table).display))];
