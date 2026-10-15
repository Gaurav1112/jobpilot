import { describe, expect, it } from 'vitest';
import { gigDedupeKey, gigKey } from '../../../src/app/freelance/keys.js';
import { Gig, GigRequest, GigVerdict, Platform, RatedGig, RawGig, RiskedGig, ScoredGig } from '../../../src/app/freelance/types.js';
import { dedupeKey, jobKey } from '../../../src/app/text/norm.js';

const gig = {
  gigKey: gigKey('freelancer', '40752583'),
  dedupeKey: gigDedupeKey('Acme', 'Backend API'),
  platform: 'freelancer',
  sourceId: '40752583',
  url: 'https://example.com/g/1',
  title: 'Backend API',
  description: 'Build an API',
  client: { name: null, country: null, paymentVerified: null, hireRate: null, spendUsd: null, reviews: null, since: null },
  kind: 'gig',
  budget: { type: 'unknown', min: null, max: null, currency: null, usdPerUnit: null },
  hoursPerWeek: { min: null, max: null, source: null },
  duration: { weeks: null, text: null },
  timezone: { required: null, overlapText: null },
  location: { countries: [], worldwide: false, text: null },
  skills: [],
  postedAt: null,
  bids: null,
};
const rated = { gig, rate: { minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, fxSource: null, budgetUsd: null } };
const verdict = { rated, verdict: 'review', reasons: [], notes: [] };
const risked = { verdict, flags: [{ id: 'x', detail: 'y' }] };
const scored = { risked, fit: 70, breakdown: { skills: 70 }, list: 'review' };

const minimal: Record<string, [{ schema: { safeParse(v: unknown): { success: boolean } } }, unknown]> = {
  GigRequest: [GigRequest, { platform: 'boards', query: 'java', runDate: '2026-10-12', half: 'am' }],
  RawGig: [RawGig, { platform: 'freelancer', sourceId: '1', raw: { a: 1 } }],
  Gig: [Gig, gig],
  RatedGig: [RatedGig, rated],
  GigVerdict: [GigVerdict, verdict],
  RiskedGig: [RiskedGig, risked],
  ScoredGig: [ScoredGig, scored],
};

describe('freelance types', () => {
  for (const [name, [type, value]] of Object.entries(minimal)) {
    it(`${name} parses a minimal value and rejects an unknown key`, () => {
      expect(type.schema.safeParse(value).success).toBe(true);
      expect(type.schema.safeParse({ ...(value as object), extra: 1 }).success).toBe(false);
    });
  }
  it('rejects unknown keys in nested objects', () => {
    expect(Gig.schema.safeParse({ ...gig, client: { ...gig.client, extra: 1 } }).success).toBe(false);
    expect(RatedGig.schema.safeParse({ ...rated, rate: { ...rated.rate, extra: 1 } }).success).toBe(false);
  });
  it('Platform lists the twelve platforms (himalayas: freelance-boost; draftdev, prime-intellect, fractional-jobs: sources-expansion)', () => {
    expect(Platform.options).toEqual(['freelancer', 'remotive', 'hn-freelancer', 'hn-hiring', 'boards', 'gmail', 'upwork', 'reddit', 'himalayas', 'draftdev', 'prime-intellect', 'fractional-jobs']);
  });
  it('gigKey is 16 hex, stable, and differs from jobKey', () => {
    const k = gigKey('freelancer', '40752583');
    expect(k).toMatch(/^[0-9a-f]{16}$/);
    expect(gigKey('freelancer', '40752583')).toBe(k);
    expect(k).not.toBe(jobKey('freelancer', '40752583'));
    expect(k).toBe(jobKey('gig:freelancer', '40752583'));
  });
  it('gigDedupeKey treats a missing client as empty', () => {
    expect(gigDedupeKey(null, 'Backend API')).toBe(dedupeKey('', 'Backend API', ''));
    expect(gigDedupeKey('Acme', 'Backend API')).not.toBe(gigDedupeKey(null, 'Backend API'));
  });
});
