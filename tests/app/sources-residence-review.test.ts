import { describe, expect, it } from 'vitest';
import { scopeListed } from '../../src/app/agents/sources/platforms/listing-pages.js';
import { exactCountryRe, listName, namesResidence } from '../../src/app/agents/sources/platforms/shared.js';
import { sitemalCountry } from '../../src/app/agents/sources/platforms/successfactors.js';
import { workdayScopesKey } from '../../src/app/agents/sources/platforms/workday.js';
import { DEFAULT_RESIDENCE, residenceScope } from '../../src/app/geo/residence.js';

// Task 14 probe review: US/GB spellings, UK = GB, listing-page scope, cache key, list names.
describe('a country facet in the spellings boards use', () => {
  it.each([
    ['US', ['United States', 'United States of America', 'USA', 'U.S.', 'u.s.a.', ' united states ']],
    ['GB', ['United Kingdom', 'UK', 'U.K.', 'Great Britain', 'Britain']],
    ['DE', ['Germany', 'GERMANY', ' germany ']],
  ])('%s', (code, values) => {
    for (const v of values) expect(exactCountryRe(residenceScope(code)).test(v), v).toBe(true);
  });
  it('never a part of the country, or another country', () => {
    const gb = exactCountryRe(residenceScope('GB'));
    for (const v of ['England', 'Scotland', 'London', 'United States']) expect(gb.test(v), v).toBe(false);
    const us = exactCountryRe(residenceScope('US'));
    for (const v of ['New Mexico', 'New England', 'Texas', 'UK']) expect(us.test(v), v).toBe(false);
  });
  it('India keeps today\'s exact rule', () => {
    expect(exactCountryRe(DEFAULT_RESIDENCE).source).toBe(/^\s*india\s*$/iu.source);
  });
});

describe('UK and GB are one residence', () => {
  it('UK resolves to GB, so GB-coded jobs are home', () => {
    const uk = residenceScope('UK');
    expect(uk.code).toBe('GB');
    expect(namesResidence('London, ENG, GB', uk)).toBe(true);
  });
});

describe('the listing-page scope follows the residence', () => {
  const jobs = [
    { location: 'Berlin, Germany', remote: false },
    { location: 'Bengaluru, India', remote: false },
    { location: null, remote: false },
  ] as never[];
  const ctx = () => {
    const notes: string[] = [];
    return { notes, ctx: { skipped: (n: string[]) => notes.push(...n) } as never };
  };
  it('a German profile keeps German cards and names the rest', () => {
    const c = ctx();
    const kept = scopeListed(jobs, [], 'Acme', c.ctx, residenceScope('DE'));
    expect(kept.map((j: { location: string | null }) => j.location)).toEqual(['Berlin, Germany', null]);
    expect(c.notes).toEqual(['not-germany Acme: 1 of 3 listed jobs outside Germany and not remote (not fetched)']);
  });
  it('India is today\'s note, byte for byte', () => {
    const c = ctx();
    scopeListed(jobs, [], 'Acme', c.ctx);
    expect(c.notes).toEqual(['not-india Acme: 1 of 3 listed jobs outside India and not remote (not fetched)']);
  });
});

describe('cache keys and list names', () => {
  it('the Workday scopes key cannot collide across residences', () => {
    expect(workdayScopesKey('ref', ['berlin'], residenceScope('DE'))).not.toBe(workdayScopesKey('ref', ['berlin DE'], DEFAULT_RESIDENCE));
    expect(workdayScopesKey('ref', ['pune'], DEFAULT_RESIDENCE)).toBe('ref pune'); // India's key is today's
  });
  it('a list is named by the country, India\'s as today', () => {
    expect(listName(residenceScope('US'))).toBe('United States');
    expect(listName(DEFAULT_RESIDENCE)).toBe('india');
  });
  it('SuccessFactors reads GB items as home for a UK profile', () => {
    expect(sitemalCountry('GB', residenceScope('UK'))).toBe('home');
  });
});
