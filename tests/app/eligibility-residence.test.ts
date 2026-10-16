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

describe('pay stated in the profile\'s locale (Task 18)', () => {
  const text = 'Gehalt: 45.000 – 50.000 € brutto pro Jahr';
  const germanEur = { ...living('DE'), offers: { floor: { amount: 60000, currency: 'EUR', period: 'year' as const, basis: 'base' as const }, payLocale: 'de' as const } };
  it('a DE profile reading de pay rejects a range below its EUR floor', () => {
    const d = decideEligibility(posting({ locationText: 'Remote - Germany', remote: { structured: 'remote', countries: ['germany'], signals: [] }, descriptionText: text }), germanEur);
    expect(d.reasons).toEqual([`below-floor:${Math.round(50000 * 90.2)}`]);
  });
  it('the unchanged fixture pack keeps "pay not disclosed"', () => {
    const d = decideEligibility(posting({ descriptionText: text }), pub);
    expect(d.notes).toContain('pay not disclosed');
    expect(d.reasons.some((r) => r.startsWith('below-floor'))).toBe(false);
  });
  it('an EUR floor without a payLocale is untouched too', () => {
    const { payLocale: _l, ...offers } = germanEur.offers;
    const d = decideEligibility(posting({ locationText: 'Remote - Germany', remote: { structured: 'remote', countries: ['germany'], signals: [] }, descriptionText: text }), { ...germanEur, offers });
    expect(d.notes).toContain('pay not disclosed');
  });
});

describe('pay in the profile\'s locale end to end (Task 18 fix round 1)', () => {
  const floorOf = (amount: number, currency: string) => ({ floor: { amount, currency, period: 'year' as const, basis: 'base' as const } });
  const profile = (code: string, payLocale: 'de' | 'en' | 'fr' | 'nl' | 'es' | 'it' | 'sv', amount: number, currency: string) => ({
    ...living(code),
    offers: { ...floorOf(amount, currency), payLocale },
    fx: { ...pub.fx, toINR: { ...pub.fx.toINR, CAD: 61.2, SEK: 7.9, CHF: 94.1 } },
  });
  const job = (descriptionText: string) => posting({ descriptionText });
  // every C1 figure, inside a benefits list, on a profile whose floor is far above it (fictional values)
  it.each([
    ['DE', 'de', 'Hardware im Wert von 3.000 €'],
    ['DE', 'de', 'Firmenwagen im Wert von 45.000 €'],
    ['DE', 'de', 'Empfehlungsbonus: 2.000 €'],
    ['DE', 'de', 'Inflationsausgleich 3.000 €'],
    ['DE', 'de', 'Lizenzkosten 20.000 € pro Jahr'],
    ['DE', 'de', 'Marketingetat 500.000 €'],
    ['DE', 'de', 'Wir spenden 10.000 € im Jahr.'],
    ['DE', 'de', 'Preis der Lizenz: 9.900 €'],
    ['DE', 'de', 'Unsere Kunden sparen bis zu 120.000 €.'],
    ['DE', 'de', 'Fahrtkostenerstattung bis 150 € monatlich'],
    ['FR', 'fr', "Ordinateur portable d'une valeur de 2 500 €"],
    ['NL', 'nl', 'Laptop ter waarde van € 2.500'],
    ['ES', 'es', 'Portátil valorado en 2.500 €'],
    ['IT', 'it', 'Laptop del valore di 2.500 €'],
  ] as const)('%s %s: "%s" is not pay', (code, locale, line) => {
    const d = decideEligibility(job(`Wir bieten:\n- 30 Tage Urlaub\n- ${line}\n- Teamevents`), profile(code, locale, 60000, 'EUR'));
    expect(d.reasons.filter((r) => r.startsWith('below-floor'))).toEqual([]);
    expect(d.notes).toContain('pay not disclosed');
  });
  it.each([
    'There is a $5k bounty for a working port.',
    '$4000/month for the team lunch fund',
    'We spend $250,000 on cloud every year.',
    'The winner gets a $10,000 prize.',
    'Our product costs $12,000 a year.',
  ])('CA en: "%s" is not pay', (line) => {
    const d = decideEligibility(job(`Perks:\n${line}`), profile('CA', 'en', 150000, 'CAD'));
    expect(d.reasons.filter((r) => r.startsWith('below-floor'))).toEqual([]);
    expect(d.notes).toContain('pay not disclosed');
  });
  it('a perk line beside the real salary neither rejects nor hides it', () => {
    const d = decideEligibility(job('Gehalt: 70.000 € brutto pro Jahr.\nHardware im Wert von 3.000 €'), profile('DE', 'de', 60000, 'EUR'));
    expect(d.reasons.filter((r) => r.startsWith('below-floor'))).toEqual([]);
    expect(d.notes).not.toContain('pay not disclosed');
  });
  it('I1: monthly pay after "brutto/" is monthly, so 54,000 a year clears a 50,000 floor', () => {
    const d = decideEligibility(job('Gehalt 4.500 € brutto/Monat'), profile('DE', 'de', 50000, 'EUR'));
    expect(d.reasons.filter((r) => r.startsWith('below-floor'))).toEqual([]);
    expect(d.notes).not.toContain('pay not disclosed');
  });
  // Task 18 round 3: every review item end to end, with a €60,000 floor (CAD 90,000, SEK 600,000, CHF 60,000)
  const belowFloor = (d: ReturnType<typeof decideEligibility>) => d.reasons.filter((r) => r.startsWith('below-floor'));
  it.each([
    // item 1: a cue far from a perk figure
    ['DE', 'en', 60000, 'EUR', '- Competitive salary, learning budget, up to €2,000 per year'],
    ['DE', 'de', 60000, 'EUR', 'Attraktives Gehalt, Weiterbildungsbudget, bis zu 2.000 € im Jahr'],
    ['DE', 'en', 60000, 'EUR', 'Competitive salary, 30 days off and a training budget, up to €1,500 a year.'],
    ['CA', 'en', 90000, 'CAD', 'We pay for your conference trips, up to $3,000 a year.'],
    // item 2
    ['DE', 'en', 60000, 'EUR', "Worker's compensation insurance up to $40,000 is included."],
    ['NL', 'nl', 60000, 'EUR', 'Een beloning van € 3.000 voor elke geslaagde referral.'],
    // item 5
    ['DE', 'en', 60000, 'EUR', 'Pay attention to detail: you will own a €40,000 vendor contract.'],
    ['DE', 'en', 60000, 'EUR', "Workers' compensation coverage of €35,000."],
    ['DE', 'de', 60000, 'EUR', 'Wir belohnen jede erfolgreiche Empfehlung mit 3.000 €.'],
    ['DE', 'de', 60000, 'EUR', 'Es lohnt sich: 3.000 € Willkommensgeschenk.'],
    ['DE', 'de', 60000, 'EUR', 'Bruttoinlandsprodukt-Analysen für Kunden mit 40.000 € Volumen.'],
    ['DE', 'de', 60000, 'EUR', 'Bruttomarge von 45.000 € pro Projekt.'],
    ['ES', 'es', 60000, 'EUR', 'Un margen bruto de 45.000 € por proyecto.'],
    ['FR', 'fr', 60000, 'EUR', 'Un fonds de 40 000 € pour un projet brutaliste.'],
    ['FR', 'fr', 60000, 'EUR', "Nos salariés bénéficient d'un CSE avec 2 000 € par an."],
    ['SE', 'sv', 600000, 'SEK', 'Belöning på 30 000 kr för varje rekommendation.'],
    ['SE', 'sv', 600000, 'SEK', 'En lönsam affär: vi har ökat med 4 000 000 kr.'],
    ['ES', 'es', 60000, 'EUR', 'Pedido ordenado de 45.000 €.'],
    ['DE', 'en', 60000, 'EUR', 'Remuneration committee approved a €50,000 grant.'],
    ['DE', 'en', 60000, 'EUR', 'Salary sacrifice scheme for bikes up to €4,000.'],
    ['DE', 'de', 60000, 'EUR', 'Gehaltsumwandlung für betriebliche Altersvorsorge bis 7.000 € jährlich.'],
    ['DE', 'en', 60000, 'EUR', 'Compensation for overtime: €40 per hour, capped at €8,000 a year.'],
  ] as const)('%s %s: "%s" is not pay', (code, locale, amount, currency, text) => {
    const d = decideEligibility(job(text), profile(code, locale, amount, currency));
    expect(belowFloor(d)).toEqual([]);
    expect(d.notes).toContain('pay not disclosed');
  });
  it.each([
    // item 3: the 13th month never makes the figure monthly; the base stays as written
    ['DE', 'de', 60000, 'EUR', 'Gehalt: 50.000 € (inkl. 13. Monatsgehalt)', 4510000],
    ['DE', 'de', 60000, 'EUR', 'Gehalt 50.000 €, 13. Monatsgehalt', 4510000],
    ['DE', 'de', 60000, 'EUR', 'Gehalt: 50.000 € + 13. Monatsgehalt', 4510000],
    ['DE', 'de', 60000, 'EUR', 'Gehalt: 50.000 € zzgl. 13. Monatsgehalt', 4510000],
    ['DE', 'de', 60000, 'EUR', 'Jahresgehalt 50.000 € inkl. Weihnachtsgeld', 4510000],
    // item 4: headings with the figure on the next line
    ['DE', 'fr', 60000, 'EUR', 'Rémunération\n45 000 € - 55 000 €', 4961000],
    ['SE', 'sv', 600000, 'SEK', 'Lön\n40 000 kr/mån', 3792000],
    ['DE', 'en', 60000, 'EUR', '- Salary range\n  €50,000 - €55,000', 4961000],
    ['DE', 'en', 60000, 'EUR', '| Salary |\n| €50,000 |', 4510000],
    // item 6: "+ €10,000 bonus" is an add-on, so the max stays 50,000
    ['DE', 'en', 60000, 'EUR', 'Salary: €50,000 + €10,000 bonus', 4510000],
    // item 7: Salär, N payments a year
    ['CH', 'de', 60000, 'CHF', "Salär: CHF 50'000", 4705000],
    ['DE', 'de', 60000, 'EUR', 'Gehalt: 14 Gehälter à 3.500 €', 4419800],
    ['ES', 'es', 60000, 'EUR', 'Salario: 14 pagas de 2.500 € brutos', 3157000],
    ['DE', 'de', 60000, 'EUR', 'Gehalt: 13 x 4.000 €', 4690400],
  ] as const)('%s %s: "%s" is read and judged', (code, locale, amount, currency, text, inr) => {
    const d = decideEligibility(job(text), profile(code, locale, amount, currency));
    expect(belowFloor(d)).toEqual([`below-floor:${inr}`]);
  });
  it.each([
    ['DE', 'en', 'Salary\n€60,000 – €75,000'],
    ['DE', 'de', 'Vergütung:\n60.000 €'],
    ['DE', 'en', '**Compensation**\n\n€55,000 - €65,000'],
  ] as const)('%s %s: the heading layout "%s" is read and clears the floor', (code, locale, text) => {
    const d = decideEligibility(job(text), profile(code, locale, 60000, 'EUR'));
    expect(belowFloor(d)).toEqual([]);
    expect(d.notes).not.toContain('pay not disclosed');
  });
});
