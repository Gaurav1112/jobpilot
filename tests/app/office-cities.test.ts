import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideEligibility } from '../../src/app/agents/eligibility.js';
import { COVER_P4 } from '../../src/app/agents/writing/templates.js';
import { placeTable } from '../../src/app/geo/places.js';
import { loadPack } from '../../src/app/pack/load.js';
import { fillP4 } from '../../src/app/render/fill.js';
import { officeCity } from '../../src/app/text/norm.js';
import type { Posting } from '../../src/app/types.js';

const repo = join(import.meta.dirname, '../..');
const { pack: full } = loadPack(join(repo, 'tests/fixtures/pack'));
const { contact: _c, answers: _a, ...pub } = full;
const de = { ...pub, eligibility: { ...pub.eligibility, residence: 'DE', officeCities: ['berlin', 'munich'] } };
const onsite = (locationText: string, descriptionText = 'Build interfaces.'): Posting => ({
  jobKey: '0123456789abcdef', dedupeKey: 'fedcba9876543210', source: 'greenhouse', sourceId: 's1', company: 'Unlisted Co', slug: 'unlisted', ats: 'greenhouse',
  title: 'Senior Backend Engineer', url: 'https://jobs.example.com/1', locationText, remote: { structured: 'onsite', countries: [], signals: [] },
  employmentType: null, descriptionText, postedAt: null, comp: null, yearsRequired: null,
});

describe('office cities per country', () => {
  it('keys resolve through the residence country\'s file', () => {
    expect(officeCity('munich', placeTable('DE'))).toEqual({ display: 'Munich', aliases: ['munich', 'münchen'] });
    expect(officeCity('munich')).toEqual({ display: 'Munich', aliases: ['munich'] }); // IN table: unknown key, itself
  });
  it('an onsite job in München passes for a Berlin/Munich profile with the office note', () => {
    expect(decideEligibility(onsite('München, Germany'), de)).toEqual({ verdict: 'eligible', reasons: [], notes: ['office/hybrid: Munich', 'pay not disclosed'] });
  });
  it('a relocation to another city keeps the reject', () => {
    expect(decideEligibility(onsite('Berlin, Germany', 'You must relocate to Hamburg.'), de).verdict).toBe('rejected');
  });
  it('a city in another country is not the office', () => {
    expect(decideEligibility(onsite('Berlin, NH, United States'), de).verdict).toBe('rejected');
  });
  it('the letter names the German offices', () => {
    const p4 = fillP4(COVER_P4, { notice_period: '30 days' }, 'Berlin', ['berlin', 'munich'], placeTable('DE'));
    expect(p4).toBe("I'm based in Berlin, looking for a remote role, or an office or hybrid role in Berlin or Munich, and available after a 30-day notice period. Thank you for considering my application.");
  });
  it('the home city is the office by any of its spellings in the residence country\'s file', () => {
    const table = placeTable('DE');
    const de4 = fillP4(COVER_P4, { notice_period: '30 days' }, 'München', ['munich'], table);
    const in4 = fillP4(COVER_P4, { notice_period: '30 days' }, 'München', ['munich']);
    expect(de4).not.toBe(in4);
    expect(de4).not.toContain('Munich');
    expect(in4).toContain('Munich');
    expect(fillP4(COVER_P4, { notice_period: '30 days' }, 'Frankfurt am Main', ['frankfurt'], table)).not.toContain('role in Frankfurt');
  });
});
