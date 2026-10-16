import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideEligibility, NOTE_B2B, NOTE_TIMEZONE } from '../../src/app/agents/eligibility.js';
import { isPlatformFacetSkip } from '../../src/app/agents/sources/platforms/shared.js';
import { DEFAULT_RESIDENCE, residenceScope } from '../../src/app/geo/residence.js';
import { loadPack } from '../../src/app/pack/load.js';
import { EligibilitySchema } from '../../src/app/pack/schema.js';
import type { Posting } from '../../src/app/types.js';
import { reasonText } from '../../src/app/web/copy.js';

const repo = join(import.meta.dirname, '../..');
const { pack: full } = loadPack(join(repo, 'tests/fixtures/pack'));
const { contact: _c, answers: _a, ...pub } = full;
const living = (code: string) => ({ ...pub, eligibility: { ...pub.eligibility, residence: code } });
// The fixture pack denies frontend titles (`role:front[- ]?end`); the default title is the existing suite's.
const posting = (over: Partial<Posting>): Posting => ({
  jobKey: '0123456789abcdef', dedupeKey: 'fedcba9876543210', source: 'greenhouse', sourceId: 's1', company: 'Unlisted Co', slug: 'unlisted', ats: 'greenhouse',
  title: 'Senior Backend Engineer', url: 'https://jobs.example.com/1', locationText: 'Remote', remote: { structured: 'remote', countries: [], signals: ['location:remote'] },
  employmentType: null, descriptionText: 'Build interfaces.', postedAt: null, comp: null, yearsRequired: null, ...over,
});

describe('residence scope', () => {
  it('IN is today\'s constants', () => {
    expect(DEFAULT_RESIDENCE).toMatchObject({ code: 'IN', country: 'india', display: 'India', token: 'india', isDefault: true, utcOffsets: [5.5] });
    expect([...DEFAULT_RESIDENCE.regions].sort()).toEqual(['apac', 'asia', 'south asia', 'worldwide']);
    expect(DEFAULT_RESIDENCE.benefitsNote).toBe(NOTE_B2B);
  });
  it('DE derives country, regions, token, display', () => {
    const de = residenceScope('DE');
    expect(de).toMatchObject({ code: 'DE', country: 'germany', display: 'Germany', token: 'germany', isDefault: false, utcOffsets: [1, 2] });
    expect([...de.regions].sort()).toEqual(['emea', 'europe', 'worldwide']);
    expect(residenceScope('US').token).toBe('united-states');
  });
  it('the schema takes any known ISO country and refuses others', () => {
    expect(EligibilitySchema.parse({ ...pub.eligibility, residence: 'DE' }).residence).toBe('DE');
    expect(() => EligibilitySchema.parse({ ...pub.eligibility, residence: 'XX' })).toThrow(/unknown country code/);
  });
});

describe('eligibility for a profile living in Germany', () => {
  const de = living('DE');
  it('remote in Germany or Europe passes; remote in India only is outside', () => {
    expect(decideEligibility(posting({ locationText: 'Remote - Germany', remote: { structured: 'remote', countries: ['germany'], signals: ['location:remote'] } }), de).verdict).toBe('eligible');
    expect(decideEligibility(posting({ locationText: 'Remote - India', remote: { structured: 'remote', countries: ['india'], signals: ['location:remote'] } }), de).reasons).toEqual(['remote-excludes-germany:country-list']);
  });
  it('an EU-only phrase does not exclude Germany; a US-only phrase does', () => {
    // Remote with only a region named is review for India too ("Remote - APAC"); the location names Germany so the
    // EU-only phrase is what this case checks.
    expect(decideEligibility(posting({ locationText: 'Remote - Germany', descriptionText: 'This role is EU-only.', remote: { structured: 'remote', countries: ['europe', 'germany'], signals: [] } }), de).verdict).toBe('eligible');
    expect(decideEligibility(posting({ descriptionText: 'This position is US-only.' }), de).reasons).toEqual(['remote-excludes-germany:us-only']);
  });
  it('a city of the residence counts as the country (its own place table)', () => {
    expect(decideEligibility(posting({ locationText: 'Remote, Berlin' , remote: { structured: 'remote', countries: [], signals: ['location:remote'] } }), de).verdict).toBe('eligible');
  });
  it('hours limited to US time zones exclude Germany; CET hours do not', () => {
    expect(decideEligibility(posting({ descriptionText: 'You must work hours between UTC-8 and UTC-5.' }), de).reasons).toEqual(['timezone-excludes-germany']);
    expect(decideEligibility(posting({ descriptionText: 'You must work hours between UTC+0 and UTC+3.' }), de).verdict).not.toBe('rejected');
  });
  it('a named zone restriction excludes Germany only when the zone does not cover it', () => {
    expect(decideEligibility(posting({ descriptionText: 'US time zones only.' }), de).reasons).toEqual(['timezone-excludes-germany']);
    expect(decideEligibility(posting({ descriptionText: 'European time zones only.' }), de).verdict).not.toBe('rejected');
  });
  it('the B2B note has no Indian benefit names', () => {
    const d = decideEligibility(posting({ title: 'Contract Backend Engineer', employmentType: 'Contractor', descriptionText: 'Full-time B2B contract, 40 hours a week.' }), de);
    expect(d.notes.filter((n) => n.startsWith('B2B'))).toEqual(['B2B contractor: no employee benefits']);
  });
});

describe('a residence without a country file (NZ)', () => {
  it('regions come from regions.yaml; the time-zone rule never rejects without offsets', () => {
    const nz = living('NZ');
    expect(decideEligibility(posting({ locationText: 'Remote - APAC', remote: { structured: 'remote', countries: ['apac'], signals: [] } }), nz).verdict).not.toBe('rejected');
    expect(decideEligibility(posting({ descriptionText: 'You must work hours between UTC-8 and UTC-5.' }), nz).reasons).not.toContain('timezone-excludes-new-zealand');
  });
});

describe('reason text and named skips', () => {
  it('reason sentences name the residence country', () => {
    expect(reasonText('remote-excludes-germany:us-only')).toBe('Remote, but not open to people in Germany');
    expect(reasonText('location-outside-united-states')).toBe('The posting names only places outside the United States');
    expect(reasonText('timezone-excludes-new-zealand')).toBe('Working hours are limited to time zones that exclude New Zealand');
  });
  it('a facet skip for any residence is a named skip', () => {
    expect(isPlatformFacetSkip('no-germany-or-remote-facet Acme: its location facets name neither Germany nor a remote type')).toBe(true);
    expect(isPlatformFacetSkip('no-united-states-or-remote-facet Acme: …')).toBe(true);
    expect(isPlatformFacetSkip('no-remote Acme')).toBe(false);
  });
});

describe('India is unchanged', () => {
  it('the notes keep their exact text', () => {
    expect(NOTE_TIMEZONE).toBe('time zone may exclude India - verify');
    expect(NOTE_B2B).toBe('B2B contractor: no PF/benefits');
  });
  it('the reason sentences keep their exact text', () => {
    expect(reasonText('remote-excludes-india:us-only')).toBe('Remote, but not open to people in India');
    expect(reasonText('location-outside-india')).toBe('The posting names only places outside India');
    expect(reasonText('timezone-excludes-india')).toBe('Working hours are limited to time zones that exclude India');
  });
});

describe('named time zones (Task 13 review)', () => {
  const de = living('DE');
  const ca = living('CA');
  const zoneVerdict = (p: typeof de, text: string) => decideEligibility(posting({ descriptionText: text }), p);
  it.each(['European or US time zones only.', 'US or EU time zones only.', 'Candidates in US or European time zones only.', 'US and European time zones only.', 'US, EU time zones only.'])(
    'every zone a restriction names counts: %s',
    (t) => {
      expect(zoneVerdict(de, t).verdict).not.toBe('rejected');
      expect(zoneVerdict(ca, t).verdict).not.toBe('rejected');
    },
  );
  it('a restriction naming only zones that miss the residence still excludes it', () => {
    expect(zoneVerdict(de, 'US or Pacific time zones only.').reasons).toEqual(['timezone-excludes-germany']);
    expect(zoneVerdict(ca, 'European or UK time zones only.').reasons).toEqual(['timezone-excludes-canada']);
  });
  it('zone ranges: Eastern is -5..-4, CET is +1..+2, and Asia Pacific is not the Pacific', () => {
    // Pacific-only Canada resident is never in Eastern; a Germany-only CET restriction needs +1/+2
    expect(zoneVerdict(living('CA'), 'Eastern time zones only.').verdict).not.toBe('rejected'); // CA spans Eastern
    expect(zoneVerdict(ca, 'Asia Pacific time zones only.').reasons).toEqual(['timezone-excludes-canada']);
    expect(zoneVerdict(de, 'Asia Pacific time zones only.').reasons).toEqual(['timezone-excludes-germany']);
    expect(zoneVerdict(de, 'CET time zones only.').verdict).not.toBe('rejected');
  });
});

describe('the residence code reaching the agent (Task 13 review)', () => {
  it('a lower-case code is the same residence, so in keeps India\'s defaults', () => {
    const p = posting({ descriptionText: 'US time zones only.' });
    expect(decideEligibility(p, living('in'))).toEqual(decideEligibility(p, living('IN')));
  });
  it('an unknown code is a clear error naming the field', () => {
    expect(() => decideEligibility(posting({}), living('XX'))).toThrow(/residence/);
  });
  it('copy reads "the" before country names that take it', () => {
    expect(reasonText('location-outside-united-states')).toMatch(/the United States/);
    expect(reasonText('timezone-excludes-united-kingdom')).toMatch(/exclude the United Kingdom/);
    expect(reasonText('timezone-excludes-germany')).toMatch(/exclude Germany/);
  });
});

describe('a description that excludes the residence (Task 16 review)', () => {
  it.each([
    ['DE', 'Fully remote: work from anywhere except Germany.', 'remote-excludes-germany:country-list'],
    ['GB', 'Remote worldwide (excluding the United Kingdom).', 'remote-excludes-united-kingdom:country-list'],
    ['CA', 'Work from anywhere, but not Canada.', 'remote-excludes-canada:country-list'],
    ['US', 'Fully remote: work from anywhere except the United States.', 'remote-excludes-united-states:country-list'],
  ])('%s: "%s" is rejected, as India is for "except India"', (code, description, reason) => {
    const p = posting({ locationText: 'Remote, Brazil', descriptionText: description, remote: { structured: 'remote', countries: ['brazil'], signals: ['location:remote'] } });
    expect(decideEligibility(p, living(code)).reasons).toEqual([reason]);
  });
  it('India: the same posting shape is rejected, as before', () => {
    const p = posting({ locationText: 'Remote, Brazil', descriptionText: 'Fully remote: work from anywhere except India.', remote: { structured: 'remote', countries: ['brazil'], signals: ['location:remote'] } });
    expect(decideEligibility(p, living('IN')).reasons).toEqual(['remote-excludes-india:country-list']);
  });
  it('a worldwide description that does not exclude the residence still makes it unclear (review)', () => {
    const p = posting({ locationText: 'Remote, Brazil', descriptionText: 'Fully remote: work from anywhere except India.', remote: { structured: 'remote', countries: ['brazil'], signals: ['location:remote'] } });
    expect(decideEligibility(p, living('DE')).verdict).toBe('review');
  });
});
