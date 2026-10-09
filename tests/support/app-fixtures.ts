import type { JobUpsert } from '../../src/app/store/app-store.js';

export const AT = '2026-10-09T01:30:00.000Z';
export const LATER = '2026-10-10T01:30:00.000Z';

/** A fictional run-owned job row; override any field. */
export function jobRow(over: Partial<JobUpsert> = {}): JobUpsert {
  return {
    jobKey: '0123456789abcdef',
    source: 'greenhouse',
    sourceId: '1001',
    company: 'Acme Robotics',
    title: 'Senior Backend Engineer',
    url: 'https://boards.example.test/acme/jobs/1001',
    ats: 'greenhouse',
    location: 'Remote, India',
    remote: { structured: 'remote', countries: ['india'], signals: ['workplaceType:remote'] },
    compMinInr: null,
    compMaxInr: null,
    compBasis: null,
    score: 70,
    breakdown: [{ label: 'title', points: 70 }],
    verdict: 'eligible',
    reasons: [],
    notes: [],
    jdText: 'Build services.',
    terms: null,
    recommendedFormat: null,
    docsState: 'none',
    docsDetail: null,
    postedAt: '2026-10-01',
    at: AT,
    ...over,
  };
}
