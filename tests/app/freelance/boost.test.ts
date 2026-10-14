import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideGig, type GigPack } from '../../../src/app/freelance/gig-eligibility.js';
import { normalizeGig } from '../../../src/app/freelance/gig-normalizer.js';
import { rateOf } from '../../../src/app/freelance/rate.js';
import type { Gig, RawGig } from '../../../src/app/freelance/types.js';
import { loadPack } from '../../../src/app/pack/load.js';

/**
 * freelance-boost (2026-10-14): the quick fixes and the one approved rule change, each against a fictional fixture
 * shaped like the live example the research found (`.superpowers/sdd/freelance-research.md` A3, A7). No real posting,
 * company or pay floor is used; the floor here is the fixture pack's.
 */

const root = join(import.meta.dirname, '../../..');
const { pack: full } = loadPack(join(root, 'tests/fixtures/pack'));
const gigPack: GigPack = { filters: full.filters, naming: full.naming, platformRules: full.platformRules, freelance: full.freelance };
const FLOOR = full.freelance.rateFloorUsdHour;

const hn = (text: string, id = '9001'): RawGig => ({ platform: 'hn-hiring', sourceId: id, raw: { id: Number(id), text, created_at_i: 1791700000 } });
const decide = (g: Gig) => decideGig({ gig: g, rate: rateOf(g, full.fx, full.freelance.maxHoursPerWeek) }, gigPack);

describe('hours ranges (research A7.1): en dash, em dash and "to" are ranges', () => {
  it.each([
    ['Expected workload is 10–39 hours per week.', 10, 39],
    ['Expected workload is 10—39 hours per week.', 10, 39],
    ['Expected workload is 10 to 39 hours per week.', 10, 39],
    ['Expected workload is 10-39 hours per week.', 10, 39],
    ['About 10–20 hrs/week, async.', 10, 20],
  ])('%s', (text, min, max) => {
    expect(normalizeGig(hn(`Example Labs | Python engineer | REMOTE | Contract\n${text}`)).hoursPerWeek).toEqual({ min, max, source: 'text' });
  });

  it('a 10–39 h/week contract is not rejected as over the cap (its minimum is 10)', () => {
    const g = normalizeGig(hn('Example Labs | Senior Python Developer | REMOTE (worldwide) | Contract\nWe pay $80-100/hr. Expected workload is 10–39 hours per week.'));
    const d = decide(g);
    expect(d.reasons).not.toContain('hours-over-cap');
    expect(d.verdict).not.toBe('rejected');
  });

  it('a stated 30 to 40 hours per week requirement still rejects', () => {
    const g = normalizeGig(hn('Example Labs | Go engineer | REMOTE (worldwide) | Contract\nWe pay $80/hr. You must commit 30 to 40 hours per week.'));
    expect(g.hoursPerWeek).toEqual({ min: 30, max: 40, source: 'text' });
    expect(decide(g)).toMatchObject({ verdict: 'rejected', reasons: ['hours-over-cap'] });
  });
});

export { FLOOR, decide, gigPack, full, hn };
