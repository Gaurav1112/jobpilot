import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GEO_GENERATED, renderGeo } from '../../../scripts/gen-geo.js';
import { REGIONS } from '../../../src/app/geo/data.generated.js';
import { countryData, DEFAULT_PLACES, placeTable, regionsOf } from '../../../src/app/geo/places.js';
import * as n from '../../../src/app/text/norm.js';
import { placeCorpus } from '../../support/place-corpus.js';

const repo = join(import.meta.dirname, '../../..');
const golden = JSON.parse(readFileSync(join(repo, 'tests/fixtures/geo/places-golden.json'), 'utf8')) as { corpus: unknown[]; offices: unknown[]; placeOf: unknown[]; spellings: { inputs: string[]; outputs: unknown[] } };

describe('place data as files', () => {
  it('IN.yaml gives exactly today\'s behaviour over the whole corpus', () => {
    const keys = ['bengaluru', 'bangalore', 'pune', 'delhi ncr', 'mumbai', 'chennai', 'mysuru', 'hyderabad', 'kochi', 'berlin'];
    expect(placeCorpus().map((t) => [n.countriesIn(t), n.citiesIn(t), n.excludedPlaces(t), n.excludedParts(t), n.isPlaceList(t), n.normLocation(t)])).toEqual(golden.corpus);
    expect(keys.map((k) => n.officeCity(k))).toEqual(golden.offices);
    expect(placeCorpus().slice(0, 400).map((t) => n.placeOf(t))).toEqual(golden.placeOf);
  });
  it('every spelling the parent commit knew (places and offices) behaves exactly as it did', () => {
    // Inputs: every quoted spelling in the parent commit's PLACES and OFFICE_CITY_ALIASES, recorded with its outputs.
    const row = (w: string) => [n.countriesIn(w), n.citiesIn(w), n.countriesIn(`Anywhere in ${w}`), n.excludedPlaces(`Remote (except ${w})`), n.excludedParts(`India (excluding ${w})`), n.placeOf(w), n.isPlaceList(`${w}, Remote`), n.officeCity(w)];
    expect(golden.spellings.inputs.length).toBeGreaterThan(150);
    expect(golden.spellings.inputs.map(row)).toEqual(golden.spellings.outputs);
  });
  it('the default table is IN\'s and India keeps its spellings in order', () => {
    expect(DEFAULT_PLACES).toBe(placeTable('IN'));
    expect(DEFAULT_PLACES.places['india']?.slice(0, 4)).toEqual(['india', 'bharat', 'bangalore', 'bengaluru']);
    expect(countryData('IN')?.display).toBe('India');
    expect(regionsOf('IN')).toEqual(['apac', 'asia', 'south asia']);
  });
  it('another residence\'s table has none of India\'s cities', () => {
    expect(n.countriesIn('Bengaluru', placeTable('GB'))).toEqual([]);
    expect(n.countriesIn('India', placeTable('GB'))).toEqual(['india']);
    expect(countryData('GB')).toBeUndefined();
  });
  it('regions.yaml covers every ISO2 code the place table knows', () => {
    for (const c of ['IN', 'US', 'GB', 'DE', 'CA', 'SG', 'AU', 'BR', 'ZA', 'AE']) expect(regionsOf(c).length).toBeGreaterThan(0);
    expect(Object.keys(REGIONS).sort()).toEqual([...n.ISO2_CODES].sort());
    expect(n.ISO2_CODES).toContain('UK');
    expect(Object.values(REGIONS).flat()).not.toContain('worldwide');
    expect(Object.fromEntries(['US', 'CA', 'GB', 'DE', 'SG', 'AU', 'BR', 'AE', 'ZA'].map((c) => [c, regionsOf(c)]))).toEqual({
      US: ['americas', 'north america'], CA: ['americas', 'north america'], GB: ['europe', 'emea'], DE: ['europe', 'emea'],
      SG: ['apac', 'asia', 'southeast asia'], AU: ['apac', 'oceania'], BR: ['americas', 'latam'], AE: ['emea', 'middle east'], ZA: ['emea', 'africa'],
    });
  });
  it('data.generated.ts is exactly what the YAML compiles to, and does no I/O', () => {
    const committed = readFileSync(GEO_GENERATED, 'utf8');
    expect(committed, 'src/app/geo/data.generated.ts is out of date with src/app/geo/data/**.yaml: run `node --run geo:gen`').toBe(renderGeo());
    expect(committed).not.toMatch(/\bimport\b[^\n]*['"](?:node:)?(?:fs|fs\/promises|yaml)['"]/);
    expect(committed.match(/^import .*$/gm)).toEqual(["import type { CountryData } from './base.js';"]);
  });
});
