import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideEligibility } from '../../src/app/agents/eligibility.js';
import { renderP4, roleClause } from '../../src/app/agents/writing/templates.js';
import { loadPack } from '../../src/app/pack/load.js';
import { EligibilitySchema } from '../../src/app/pack/schema.js';
import type { Posting } from '../../src/app/types.js';

const repo = join(import.meta.dirname, '../..');
const { pack: full } = loadPack(join(repo, 'tests/fixtures/pack'));
const { contact: _c, answers: _a, ...pub } = full;
const posting = (over: Partial<Posting>): Posting => ({
  jobKey: '0123456789abcdef', dedupeKey: 'fedcba9876543210', source: 'greenhouse', sourceId: 's1', company: 'Unlisted Co', slug: 'unlisted', ats: 'greenhouse',
  title: 'Senior Backend Engineer', url: 'https://jobs.example.com/1', locationText: 'Remote - India', remote: { structured: 'remote', countries: ['india'], signals: [] },
  employmentType: null, descriptionText: 'Build services.', postedAt: null, comp: null, yearsRequired: null, ...over,
});

describe('role clause', () => {
  it.each([
    [undefined, [], 'a fully remote role'],
    [undefined, ['Pune', 'Mumbai'], 'a remote role, or an office or hybrid role in Pune or Mumbai'],
    [['remote'], [], 'a fully remote role'],
    [['remote', 'office', 'hybrid'], ['Pune'], 'a remote role, or an office or hybrid role in Pune'],
    [['remote', 'office'], ['Pune'], 'a remote role, or an office role in Pune'],
    [['remote', 'hybrid'], ['Pune'], 'a remote role, or a hybrid role in Pune'],
    [['office', 'hybrid'], ['Pune', 'Mumbai'], 'an office or hybrid role in Pune or Mumbai'],
    [['office'], ['Pune'], 'an office role in Pune'],
    [['hybrid'], ['Pune'], 'a hybrid role in Pune'],
  ] as const)('%j %j', (modes, offices, want) => {
    expect(roleClause(modes, offices)).toBe(want);
  });
  it('an office-only letter', () => {
    expect(renderP4('Pune', '30 days', ['Pune'], false, ['office'])).toBe("I'm based in Pune, looking for an office role in Pune, and available after a 30-day notice period. Thank you for considering my application.");
  });
  it('without modes the letter is exactly today\'s', () => {
    expect(renderP4('Pune', '30 days', [], false, undefined)).toBe(renderP4('Pune', '30 days'));
    expect(renderP4('Pune', '30 days', ['Pune'], true, undefined)).toBe(renderP4('Pune', '30 days', ['Pune'], true));
  });
  it('no letter template names a fixed city', async () => {
    const t = (await import('../../src/app/agents/writing/templates.js')) as Record<string, unknown>;
    const texts = Object.entries(t).filter(([k, v]) => k.startsWith('COVER_') && typeof v === 'string').map(([, v]) => v as string);
    expect(texts.length).toBeGreaterThan(5);
    for (const city of ['Bengaluru', 'Bangalore', 'Pune', 'Mumbai', 'Hyderabad', 'Chennai', 'Delhi']) expect(texts.filter((x) => x.includes(city))).toEqual([]);
  });
});

describe('work modes in eligibility', () => {
  it('the schema refuses office without office cities', () => {
    expect(() => EligibilitySchema.parse({ ...pub.eligibility, workModes: ['office'] })).toThrow(/officeCities/);
  });
  it('office/hybrid only: remote is rejected; an office in the city passes', () => {
    const p = { ...pub, eligibility: { ...pub.eligibility, workModes: ['office', 'hybrid'] as ('office' | 'hybrid')[], officeCities: ['pune'] } };
    expect(decideEligibility(posting({}), p).reasons).toEqual(['remote-not-wanted']);
    expect(decideEligibility(posting({ locationText: 'Pune, India', remote: { structured: 'hybrid', countries: ['india'], signals: [] } }), p).verdict).toBe('eligible');
  });
  it('remote and hybrid: an onsite office job stays rejected', () => {
    const p = { ...pub, eligibility: { ...pub.eligibility, workModes: ['remote', 'hybrid'] as ('remote' | 'hybrid')[], officeCities: ['pune'] } };
    expect(decideEligibility(posting({ locationText: 'Pune, India', remote: { structured: 'onsite', countries: ['india'], signals: [] } }), p).reasons).toEqual(['onsite']);
  });
});
