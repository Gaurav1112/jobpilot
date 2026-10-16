/**
 * The place data every residence shares: the countries and regions with their spellings, the place regex builder, and
 * the office-city and country-data shapes. Pure (no I/O): `norm.ts` and `places.ts` both import it, which breaks the
 * cycle between them. A residence's own cities and states come from its country file (`data/countries/<code>.yaml`,
 * compiled into `data.generated.ts`); India's are appended to `india` by `placeTable('IN')`.
 */

/**
 * Canonical lowercase names, each with the spellings that mean it. Regions are tokens of their own: `worldwide`,
 * `apac`, `emea`, `europe`, `americas`, `latam`, `north america`, `asia`, `south asia`, `southeast asia`,
 * `middle east`, `africa`, `oceania`. Matching is whole-word and longest-first, so "Southeast Asia" is not "asia"
 * and "Indiana" is nothing; a capitalised code glued to a tier number ("USA1", final fix I6) is its country.
 */
export const BASE_PLACES: Readonly<Record<string, readonly string[]>> = {
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
  india: ['india', 'bharat'],
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

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The whole-word place expression over `keys` (spellings). Longest spelling first, so "south east asia" wins over
 * "asia" and "united states of america" over "united states".
 */
export const buildPlaceRegex = (keys: Iterable<string>): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])(${[...keys].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`,
    'giu',
  );

/**
 * Office city keys (the pack's `eligibility.officeCities`) and the spellings each one matches, with the name documents
 * and notes show. Generic place data: which cities count is the pack's choice. An unknown key matches only itself and
 * shows title-cased ("kochi" shows "Kochi").
 */
export interface OfficeCity {
  readonly display: string;
  readonly aliases: readonly string[];
}

/** One country file (`data/countries/<code>.yaml`), as validated by `scripts/gen-geo.ts`. */
export interface CountryData {
  readonly code: string;
  /** The canonical place name (a `BASE_PLACES` key). */
  readonly country: string;
  readonly display: string;
  readonly regions: readonly string[];
  readonly utcOffsets: readonly number[];
  readonly zoneWords: readonly string[];
  /** Spellings appended to the country's entry, cities first, then states. */
  readonly cities: readonly string[];
  readonly states: readonly string[];
  readonly offices: Readonly<Record<string, OfficeCity>>;
  readonly benefitsNote?: string;
}
