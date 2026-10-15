import { describe, expect, it } from 'vitest';
import { FOLLOW_UP_DAYS, followUpDue, isFollowUpDue, isToDecide, TO_DECIDE_DAYS, toDecideFrom } from '../../src/app/triage.js';

const NOW = '2026-10-15T06:30:00.000Z'; // 12:00 IST
const job = (over: Partial<{ status: string; band: string; firstSeen: string }>) => ({ status: 'new', band: 'review', firstSeen: '2026-10-12T01:30:00.000Z', ...over });

describe('U9: To decide', () => {
  it('is 7 IST days: today and the 6 days before, from IST midnight', () => {
    expect(TO_DECIDE_DAYS).toBe(7);
    expect(toDecideFrom(NOW)).toBe('2026-10-08T18:30:00.000Z'); // 9 Oct 00:00 IST
    expect(toDecideFrom('2026-10-15T18:29:59.000Z')).toBe('2026-10-08T18:30:00.000Z'); // 15 Oct 23:59 IST
    expect(toDecideFrom('2026-10-15T18:30:00.000Z')).toBe('2026-10-09T18:30:00.000Z'); // 16 Oct 00:00 IST
  });
  it('means untriaged, eligible or check first, and first seen inside the window', () => {
    expect(isToDecide(job({}), NOW)).toBe(true);
    expect(isToDecide(job({ firstSeen: '2026-10-08T18:30:00.000Z' }), NOW)).toBe(true);
    expect(isToDecide(job({ firstSeen: '2026-10-08T18:29:59.999Z' }), NOW)).toBe(false);
    for (const band of ['disclosed', 'undisclosed', 'review']) expect(isToDecide(job({ band }), NOW), band).toBe(true);
    for (const band of ['below-floor', 'rejected']) expect(isToDecide(job({ band }), NOW), band).toBe(false);
    for (const status of ['approved', 'applied', 'interview', 'offer', 'rejected', 'skipped']) expect(isToDecide(job({ status }), NOW), status).toBe(false);
  });
});

describe('U9: follow-ups', () => {
  it('are due 5 days after applying (IST dates), unless a date is set', () => {
    expect(FOLLOW_UP_DAYS).toBe(5);
    expect(followUpDue('2026-10-09T20:00:00.000Z', null)).toBe('2026-10-15'); // applied 10 Oct 01:30 IST
    expect(followUpDue('2026-10-09T20:00:00.000Z', '2026-10-20')).toBe('2026-10-20');
    expect(isFollowUpDue('2026-10-09T20:00:00.000Z', null, '2026-10-14T18:29:59.000Z')).toBe(false); // 14 Oct 23:59 IST
    expect(isFollowUpDue('2026-10-09T20:00:00.000Z', null, '2026-10-14T18:30:00.000Z')).toBe(true); // 15 Oct 00:00 IST
    expect(isFollowUpDue(null, null, NOW)).toBe(false);
  });
});
