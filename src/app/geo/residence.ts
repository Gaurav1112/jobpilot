import { countryOfCode, ISO2_CODES } from '../text/norm.js';
import { countryData, placeTable, regionsOf, type PlaceTable } from './places.js';

/**
 * The residence scope (profiles spec §6): the pack's `eligibility.residence` (any ISO 3166 alpha-2 code `norm.ts`
 * knows) and what the eligibility rules derive from it: the country, its regions plus `worldwide`, the token reason
 * codes carry, the display name, the UTC offsets and zone words, the B2B note and the place table. Pure: the country
 * files are compiled into `data.generated.ts`. For `IN` every value is today's constant (`isDefault`), and the
 * regexes are today's own objects.
 */
export interface ResidenceScope {
  readonly code: string;
  /** The canonical place name: 'india'. */
  readonly country: string;
  /** 'India'. */
  readonly display: string;
  /** The country with spaces as hyphens, used in reason codes: 'india', 'united-states'. */
  readonly token: string;
  /** The regions with the country, plus 'worldwide'. */
  readonly regions: ReadonlySet<string>;
  /** Empty when the country has no file: the time-zone rule then never rejects. */
  readonly utcOffsets: readonly number[];
  readonly zoneWord: RegExp | null;
  readonly offsetRe: RegExp | null;
  readonly nameWord: RegExp;
  readonly nameLoose: RegExp;
  readonly benefitsNote: string;
  readonly table: PlaceTable;
  /** code === 'IN': today's residence. */
  readonly isDefault: boolean;
}

const IST_WORD = /\bIST\b/;
const IST_OFFSET = /\b(?:utc|gmt)\s*\+\s*0?5:?30\b/i;
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const offsetRe = (offsets: readonly number[]): RegExp | null => {
  if (offsets.length === 0) return null;
  const forms = offsets.map((o) => {
    const sign = o < 0 ? '-' : '\\+';
    const h = Math.trunc(Math.abs(o));
    const m = Math.round((Math.abs(o) - h) * 60);
    return m === 0 ? `${sign}\\s*0?${h}(?::?00)?` : `${sign}\\s*0?${h}:?${String(m).padStart(2, '0')}`;
  });
  return new RegExp(`\\b(?:utc|gmt)\\s*(?:${forms.join('|')})\\b`, 'i');
};

/** The ISO code of a canonical country name ('united kingdom' → 'GB', listed before 'UK'), or null. */
const codeOfCountry = (name: string): string | null => ISO2_CODES.find((c) => countryOfCode(c) === name) ?? null;

const cache = new Map<string, ResidenceScope>();
/** The scope of the residence `code` (default 'IN'); throws on a code `norm.ts` does not know. Cached per code. */
export function residenceScope(code = 'IN'): ResidenceScope {
  const hit = cache.get(code);
  if (hit !== undefined) return hit;
  const country = countryOfCode(code);
  if (country === null) throw new Error(`unknown country code ${code}`);
  // one residence per country: UK resolves to GB, so a GB-coded job is home for either spelling
  const canonical = codeOfCountry(country) ?? code;
  const data = countryData(canonical);
  const isDefault = canonical === 'IN';
  const names = [country];
  const s: ResidenceScope = {
    code: canonical,
    country,
    display: data?.display ?? country.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase()),
    token: country.replace(/\s+/g, '-'),
    regions: new Set([...(data?.regions ?? regionsOf(code)), 'worldwide']),
    utcOffsets: data?.utcOffsets ?? [],
    zoneWord: isDefault ? IST_WORD : data !== undefined && data.zoneWords.length > 0 ? new RegExp(`\\b(?:${data.zoneWords.map(esc).join('|')})\\b`) : null,
    offsetRe: isDefault ? IST_OFFSET : offsetRe(data?.utcOffsets ?? []),
    nameWord: isDefault ? /\bindia\b/i : new RegExp(`\\b(?:${names.map(esc).join('|')})\\b`, 'i'),
    nameLoose: isDefault ? /india/i : new RegExp(`(?:${names.map(esc).join('|')})`, 'i'),
    benefitsNote: data?.benefitsNote ?? 'B2B contractor: no employee benefits',
    table: placeTable(code),
    isDefault,
  };
  cache.set(code, s);
  return s;
}

export const DEFAULT_RESIDENCE: ResidenceScope = residenceScope('IN');

/** True when one of `places` is the residence country or a region with it (worldwide included). */
export const inScope = (scope: ResidenceScope, places: readonly string[]): boolean => places.some((c) => c === scope.country || scope.regions.has(c));

/** The display name behind a reason token: 'india' → 'India', 'united-states' → 'United States'; an unknown token as it is. */
export function countryDisplayOfToken(token: string): string {
  const code = codeOfCountry(token.replace(/-/g, ' '));
  return code === null ? token : residenceScope(code).display;
}
