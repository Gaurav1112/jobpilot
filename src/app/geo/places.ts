import { BASE_PLACES, buildPlaceRegex, type CountryData, type OfficeCity } from './base.js';
import { COUNTRIES, REGIONS } from './data.generated.js';

/**
 * Place tables per residence country. Pure: the country files (`data/countries/<code>.yaml`) and `data/regions.yaml`
 * are compiled into `data.generated.ts` by `node --run geo:gen`, so agent code reaches them without file I/O.
 */
export type { CountryData } from './base.js';

/** The country file for `code`, or undefined when there is none. */
export const countryData = (code: string): CountryData | undefined => (Object.hasOwn(COUNTRIES, code) ? COUNTRIES[code] : undefined);

/** The region tokens that contain the country `code` (never `worldwide`), or [] for an unknown code. */
export const regionsOf = (code: string): string[] => [...(Object.hasOwn(REGIONS, code) ? (REGIONS[code] ?? []) : [])];

export interface PlaceTable {
  readonly places: Readonly<Record<string, readonly string[]>>;
  readonly alias: ReadonlyMap<string, string>;
  readonly re: RegExp;
  /** The spellings that name a country by name (not a city or state): India's are india and bharat. */
  readonly byName: ReadonlySet<string>;
  readonly offices: Readonly<Record<string, OfficeCity>>;
  readonly states: ReadonlySet<string>;
}

const tables = new Map<string, PlaceTable>();

/** The base places plus `code`'s cities and states appended to its country's entry; cached per code. */
export function placeTable(code: string): PlaceTable {
  let t = tables.get(code);
  if (t !== undefined) return t;
  const c = countryData(code);
  const places: Record<string, readonly string[]> = { ...BASE_PLACES };
  if (c !== undefined) places[c.country] = [...(BASE_PLACES[c.country] ?? []), ...c.cities, ...c.states];
  const alias = new Map<string, string>(Object.entries(places).flatMap(([name, spellings]) => spellings.map((s) => [s, name] as const)));
  t = {
    places,
    alias,
    re: buildPlaceRegex(alias.keys()),
    byName: new Set(c === undefined ? [] : (BASE_PLACES[c.country] ?? [])),
    offices: c?.offices ?? {},
    states: new Set(c?.states ?? []),
  };
  tables.set(code, t);
  return t;
}

/** Today's table: India's residence. */
export const DEFAULT_PLACES: PlaceTable = placeTable('IN');
