import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideGig, type GigPack } from '../../../src/app/freelance/gig-eligibility.js';
import { normalizeGig } from '../../../src/app/freelance/gig-normalizer.js';
import { gigDedupeKey, gigKey } from '../../../src/app/freelance/keys.js';
import { rateOf } from '../../../src/app/freelance/rate.js';
import { himalayasGigsHosts, himalayasGigsUrl, HIMALAYAS_ROBOTS_URL, makeSrcHimalayasGigs, srcHimalayasGigsContract } from '../../../src/app/freelance/sources/himalayas-gigs.js';
import type { Gig, RawGig } from '../../../src/app/freelance/types.js';
import { loadPack } from '../../../src/app/pack/load.js';
import { AppStore, type GigUpsert } from '../../../src/app/store/app-store.js';
import { issueContext } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import { Store } from '../../../src/kernel/store/store.js';
import { CONTRACT_REASONS, routesToFreelance, structuredFullTime } from '../../../src/app/store/contract-routes.js';
import { jobRow } from '../../support/app-fixtures.js';

/** freelance-boost review round (2026-10-15): I1, I2, wide ranges and the minors. Fictional fixtures only. */

const root = join(import.meta.dirname, '../../..');
const { pack: full } = loadPack(join(root, 'tests/fixtures/pack'));
const gp: GigPack = { filters: full.filters, naming: full.naming, platformRules: full.platformRules, freelance: full.freelance };
const CAP = full.freelance.maxHoursPerWeek;
const decide = (g: Gig) => decideGig({ gig: g, rate: rateOf(g, full.fx, CAP) }, gp);
const YOU_SET = 'hours not stated; you set them';

const fl = (description: string, min: number | null = 30, max: number | null = 50): RawGig => ({
  platform: 'freelancer', sourceId: '8001',
  raw: { title: 'Backend API developer', description, preview_description: null, type: 'hourly', budget: { minimum: min, maximum: max }, currency: { code: 'USD', exchange_rate: 1 }, time_submitted: 1791700000, seo_url: 'go/backend-api-8001', jobs: [{ name: 'Golang' }], local: false, bid_stats: { bid_count: 3 }, owner_id: null, hourly_project_info: null },
});
const hn = (t: string): RawGig => ({ platform: 'hn-hiring', sourceId: '8101', raw: { id: 8101, text: `Example Labs | Go engineer | REMOTE (worldwide) | Contract\n${t}`, created_at_i: 1791700000 } });
const hm = (desc: string, o: Record<string, unknown> = {}): RawGig => ({
  platform: 'himalayas', sourceId: 'https://himalayas.app/companies/example-co/jobs/x',
  raw: { title: 'Backend Engineer (Contract)', companyName: 'Example Co', employmentType: 'Contractor', minSalary: null, maxSalary: null, salaryPeriod: null, currency: 'USD', locationRestrictions: [], timezoneRestrictions: [], description: `<p>${desc}</p>`, pubDate: 1791972122, guid: 'https://himalayas.app/companies/example-co/jobs/x', ...o },
});

describe('I1: "hours not stated" only when no hours figure in any unit and no full-time wording', () => {
  it.each([
    'Need Go backend work, about 160 hours per month.',
    'Need Go backend work, 8 hours a day, Monday to Friday.',
    'Need Go backend work, 40 hours weekly.',
    'Need Go backend work, 40hrs/wk.',
    'Need Go backend work, forty hours a week.',
    'We pay per hour… per week we need 30 hours.',
    'You must dedicate your entire week to this project, 9-5.',
    'This is a full-time job. Start ASAP.',
    'Looking for a full time developer for long term.',
    'Must be available daily 9am to 6pm IST for this long term work.',
  ])('%s → review, never "you set them"', (text) => {
    const d = decide(normalizeGig(fl(text)));
    expect(d.notes).not.toContain(YOU_SET);
    expect(d.verdict).not.toBe('eligible');
  });

  it('no hours at all and no full-time wording: still the approved rule', () => {
    expect(decide(normalizeGig(fl('Need Go backend work on our API.')))).toEqual({ verdict: 'eligible', reasons: [], notes: [YOU_SET] });
  });

  it('per month and per day convert to a week only as a note: never eligible, never rejected (controller, 2026-10-15)', () => {
    expect(decide(normalizeGig(fl('We need 40 hours per month.')))).toEqual({ verdict: 'review', reasons: ['hours-unclear'], notes: ['≈9.2 h/week from 40 hours per month (assumed 4.33 weeks/month); confirm'] });
    expect(decide(normalizeGig(fl('About 2 hours a day.')))).toEqual({ verdict: 'review', reasons: ['hours-unclear'], notes: ['≈10 h/week from 2 hours per day (assumed 5 days/week); confirm'] });
    expect(decide(normalizeGig(fl('About 4.5 hours a day.')))).toMatchObject({ verdict: 'review', notes: ['≈22.5 h/week from 4.5 hours per day (assumed 5 days/week) - verify'] });
    expect(decide(normalizeGig(fl('About 160 hours per month.')))).toMatchObject({ verdict: 'review', reasons: ['hours-unclear'], notes: ['≈37 h/week from 160 hours per month (assumed 4.33 weeks/month) - verify'] });
    for (const t of ['4 hours a day, 7 days a week.', 'At least 80 hours per month.', '30 hours per month but full-time during launch week.', '3-5 hours a day.']) {
      expect(decide(normalizeGig(fl(`Pay $45/hr. ${t}`))).verdict, t).toBe('review');
    }
    // On another platform the same: a converted figure never rejects.
    expect(decide(normalizeGig(hn('We pay $80/hr. Work 8 hours a day.')))).toMatchObject({ verdict: 'review', reasons: ['hours-unclear'] });
  });

  it('"N hours weekly" is a per-week figure', () => {
    expect(normalizeGig(hn('Pay $80/hr. 10 hours weekly.')).hoursPerWeek).toEqual({ min: 10, max: 10, source: 'text' });
  });
});

describe('mixed hour units with a per-week figure go to review (controller, 2026-10-15)', () => {
  const MIXED = 'hours stated in several ways; confirm';
  it.each([
    'We pay $80/hr. 10 hours per week to start; 160 hours per month after onboarding.',
    'We pay $80/hr. 10 h/week. You must also be online 8 hours a day.',
  ])('%s', (text) => {
    const d = decide(normalizeGig(hn(text)));
    expect(d.verdict).toBe('review');
    expect(d.notes).toContain(MIXED);
  });

  it('I6: a "10+ hours per week" figure meets the mixed-units check too', () => {
    for (const raw of [hn('Pay $45/hr. 10+ hours per week, and 8 hours a day during launch.'), fl('Pay $45/hr. 10+ hours per week, and 8 hours a day during launch.')]) {
      const d = decide(normalizeGig(raw));
      expect(d.verdict).toBe('review');
      expect(d.notes).toContain(MIXED);
    }
  });

  it('X4: "18 h/week, 91 h/month" agree within 20% but the month is over the cap: review', () => {
    const d = decide(normalizeGig(hn('We pay $80/hr. 18 hours per week, 91 hours per month.')));
    expect(d.verdict).toBe('review');
    expect(d.notes).toContain(MIXED);
  });

  it('units that agree within 20% and stay under the cap are not "several ways"', () => {
    expect(decide(normalizeGig(hn('We pay $80/hr. 10 hours per week, about 40 hours per month.')))).toEqual({ verdict: 'eligible', reasons: [], notes: [] });
    // disagreeing by over 20%, both under the cap: review
    expect(decide(normalizeGig(hn('We pay $80/hr. 10 hours per week, about 80 hours per month.'))).notes).toContain(MIXED);
    // agreeing within 20% but over the cap: review
    expect(decide(normalizeGig(hn('We pay $80/hr. 25 hours per week, about 100 hours per month.'))).notes).toContain(MIXED);
  });
});

describe('wide hours ranges go to review (controller decision 2026-10-15)', () => {
  it.each([
    ['Expected workload is 10–39 hours per week.', 39],
    ['We pay $45/h. 5 to 39 hours per week.', 39],
    ['We pay $45/h. 1 to 99 hours per week.', 99],
  ])('%s', (text, max) => {
    const d = decide(normalizeGig(hn(`We pay $80-100/hr. ${text}`)));
    expect(d.verdict).toBe('review');
    expect(d.reasons).toContain('hours-unclear');
    expect(d.notes).toContain(`hours range up to ${max}/week exceeds ${CAP}; confirm`);
  });

  it('a range within the cap still passes', () => {
    expect(decide(normalizeGig(hn('We pay $80-100/hr. 10–20 hours per week.')))).toEqual({ verdict: 'eligible', reasons: [], notes: [] });
  });
});

describe('I2: Himalayas structured pay needs both ends; non-hourly units void the hourly label', () => {
  const H = 'Commitment: 10 hours per week.';
  it('min only → no budget (review); max only → a ceiling (never passes alone); both → stated', () => {
    const minOnly = normalizeGig(hm(H, { minSalary: 5, maxSalary: null, salaryPeriod: 'hourly' }));
    expect(minOnly.budget.type).toBe('unknown');
    expect(decide(minOnly)).toMatchObject({ verdict: 'review', reasons: ['rate-unclear'] });
    const maxOnly = normalizeGig(hm(H, { minSalary: null, maxSalary: 45, salaryPeriod: 'hourly' }));
    expect(maxOnly.budget).toMatchObject({ type: 'hourly', min: null, max: 45, bound: 'ceiling', from: 'platform' });
    expect(decide(maxOnly)).toMatchObject({ verdict: 'review', reasons: ['ceiling-only'] });
    expect(normalizeGig(hm(H, { minSalary: 100, maxSalary: null, salaryPeriod: 'monthly' })).budget.type).toBe('unknown');
    const both = normalizeGig(hm(H, { minSalary: 50, maxSalary: 60, salaryPeriod: 'hourly' }));
    expect(rateOf(both, full.fx, CAP)).toMatchObject({ method: 'stated', minUsdH: 50, maxUsdH: 60 });
  });

  it.each([
    ['Earn 400 USD per task.', 400],
    ['Pay is $400 per day.', 400],
    ['Budget $4,000 total.', 4000],
    ['We pay 250 USD/day.', 250],
    ['Paid $300 a week.', 300],
    ['A flat $500 fixed.', 500],
    ['Up to $40/task.', 40],
  ])('"%s" voids an hourly %i', (text, fig) => {
    expect(normalizeGig(hm(`${H} ${text}`, { minSalary: fig, maxSalary: fig, salaryPeriod: 'hourly' })).budget.type).toBe('unknown');
  });

  it('a plain hourly mention of the same figure keeps it', () => {
    expect(normalizeGig(hm(`${H} Pay $50/hr.`, { minSalary: 50, maxSalary: 50, salaryPeriod: 'hourly' })).budget).toMatchObject({ type: 'hourly', min: 50, max: 50 });
  });
});

describe('minors', () => {
  it('a Freelancer hourly project with only a maximum is a ceiling: the approved rule never passes it', () => {
    const g = normalizeGig(fl('Need Go backend work on our API.', null, 45));
    expect(g.budget).toMatchObject({ type: 'hourly', min: null, max: 45, bound: 'ceiling' });
    expect(decide(g)).toMatchObject({ verdict: 'review', reasons: expect.arrayContaining(['ceiling-only']) });
  });

  it.each([
    [[5, 6], false],
    [[5.75], false],
    [[5, 5.75, 6], false],
    [[5.5], true],
    [[0, 5.5, 8], true],
  ])('IST is in the time zones exactly: %j → worldwide %s', (zones, worldwide) => {
    expect(normalizeGig(hm('x', { timezoneRestrictions: zones })).location.worldwide).toBe(worldwide);
  });

  it('a Himalayas job of an unsupported employment type is a named skip, not a failed step', async () => {
    const job = (guid: string, employmentType: string) => ({ guid, title: 'Backend Engineer', employmentType, locationRestrictions: [], description: 'x' });
    const body = JSON.stringify({ totalCount: 2, jobs: [job('https://himalayas.app/a', 'Full Time'), job('https://himalayas.app/b', 'Contractor')] });
    const fetch = async (url: string) => ({ status: url === HIMALAYAS_ROBOTS_URL ? 404 : 200, text: async () => (url === HIMALAYAS_ROBOTS_URL ? '' : body) });
    const ctx = issueContext({ contract: srcHimalayasGigsContract(), policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock: fixedClock('2026-10-15T00:00:00Z'), signal: new AbortController().signal, hostPacer: { wait: async () => {} } });
    const gigs = await makeSrcHimalayasGigs(himalayasGigsHosts()).run({ platform: 'himalayas', query: 'java', runDate: '2026-10-15', half: 'am' }, ctx);
    expect(gigs.map((g) => g.sourceId)).toEqual(['https://himalayas.app/b']);
    expect(ctx.skips()).toContain('himalayas java job 0: employment type "Full Time" is not contract or part-time work');
    expect(himalayasGigsUrl('java')).not.toMatch(/page=/);
  });

  it('dedupe head switch: the status the user set on the boards row moves to the Himalayas row that becomes the head', () => {
    const app = AppStore.on(Store.open(':memory:'));
    const row = (platform: string, id: string, at: string): GigUpsert => ({
      gigKey: gigKey(platform, id), dedupeKey: gigDedupeKey('Example Co', 'Backend Engineer'), platform, sourceId: id, url: `https://x.test/${id}`, title: 'Backend Engineer',
      description: '', client: {}, kind: 'contract', budget: {}, rate: null, hours: {}, verdict: 'review', reasons: [], notes: [], flags: [], fit: 50, breakdown: null,
      list: 'review', docsState: 'none', docsDetail: null, postedAt: null, at,
    });
    app.upsertGig(row('boards', 'b1', '2026-10-12T01:00:00.000Z'));
    app.setGigStatus(gigKey('boards', 'b1'), 'applied', '2026-10-13T10:00:00.000Z');
    app.upsertGig(row('himalayas', 'h1', '2026-10-14T13:00:00.000Z'));
    const shown = app.listGigs();
    expect(shown.map((g) => [g.sourceId, g.status, g.appliedAt])).toEqual([['h1', 'applied', '2026-10-13T10:00:00.000Z']]);
  });
});

describe('routing: every contract wording the daily run rejects reaches the freelance run (closed allow-list)', () => {
  it.each([
    'employment:contract', 'employment:contractor', 'employment:freelance', 'employment:part-time', 'employment:temporary', 'employment:temp',
    'employment:fixed-term', 'employment:fixed term', 'employment:contract-to-hire', 'employment:c2h', 'employment:6 months', 'employment:12-month contract',
    'employment:3 month contract', 'Employment:Contractor',
  ])('%s → freelance', (r) => expect(routesToFreelance(r)).toBe(true));

  it.each(['employment:intern', 'employment:full-time', 'employment:hourly-ish', 'employment:6 monthly', 'employment:contract management', 'remote-excludes-india', 'company:contract', 'employment:', 'employment:999 months'])('%s → not routed', (r) =>
    expect(routesToFreelance(r)).toBe(false),
  );

  it('the duration bound is 24 months: 24 is routed, 25 is not', () => {
    expect(routesToFreelance('employment:24 months')).toBe(true);
    expect(routesToFreelance('employment:24-month contract')).toBe(true);
    expect(routesToFreelance('employment:25 months')).toBe(false);
    expect(routesToFreelance('employment:25-month contract')).toBe(false);
  });

  it('a structured full-time role is never routed, whatever title label gave the reason', () => {
    expect(structuredFullTime('Full-time')).toBe(true);
    expect(structuredFullTime('FULL_TIME')).toBe(true);
    expect(structuredFullTime('Full time; Permanent')).toBe(true);
    expect(structuredFullTime('Full-time, Contractor')).toBe(false);
    expect(structuredFullTime('Contract')).toBe(false);
    expect(structuredFullTime(null)).toBe(false);
    expect(structuredFullTime('')).toBe(false);
    const app = AppStore.on(Store.open(':memory:'));
    const put = (jobKey: string, i: number, employmentType: string | null, reasons: string[]) => {
      app.upsertJob(jobRow({ jobKey, dedupeKey: `e00000000000000${i}`, sourceId: `ft${i}`, title: 'Senior Backend Engineer - 6 months', verdict: 'rejected', reasons }));
      app.kernel.db
        .prepare(`INSERT INTO envelopes (envelope_id, step_key, idx, type, body) VALUES (?, ?, 0, 'Posting@1', ?)`)
        .run(`e-${jobKey}`, `s-${jobKey}`, JSON.stringify({ type: 'Posting@1', payload: { jobKey, title: 'Senior Backend Engineer - 6 months', employmentType } }));
    };
    put('b000000000000001', 1, 'Full-time', ['employment:6 months']);
    put('b000000000000002', 2, 'Contract', ['employment:6 months']);
    put('b000000000000003', 3, null, ['employment:6 months']);
    put('b000000000000004', 4, 'Full-time, Contractor', ['employment:contractor']);
    const got = app.contractPostings('2000-01-01T00:00:00.000Z');
    expect(got.postings.map((p) => p.jobKey)).toEqual(['b000000000000002', 'b000000000000003', 'b000000000000004']);
    expect(got.missing).toEqual([]);
  });

  it('the list is closed and exact', () => {
    expect([...CONTRACT_REASONS]).toEqual(['contract', 'contractor', 'freelance', 'part-time', 'temporary', 'temp', 'fixed-term', 'contract-to-hire', 'c2h']);
  });

  it('contractPostings seeds exactly the routed jobs (no stored posting: listed as missing)', () => {
    const app = AppStore.on(Store.open(':memory:'));
    const reasons: [string, string[]][] = [
      ['a000000000000001', ['employment:contract']], ['a000000000000002', ['employment:contractor']], ['a000000000000003', ['employment:fixed-term']],
      ['a000000000000004', ['employment:contract-to-hire']], ['a000000000000005', ['employment:6 months']], ['a000000000000006', ['employment:temporary']],
      ['a000000000000007', ['employment:intern']], ['a000000000000008', ['remote-excludes-india']], ['a000000000000009', []],
    ];
    reasons.forEach(([jobKey, r], i) => app.upsertJob(jobRow({ jobKey, dedupeKey: `d00000000000000${i}`, sourceId: String(i), verdict: r.length > 0 ? 'rejected' : 'eligible', reasons: r })));
    const got = app.contractPostings('2000-01-01T00:00:00.000Z');
    expect([...got.missing, ...got.postings.map((p) => p.jobKey)].sort()).toEqual(['a000000000000001', 'a000000000000002', 'a000000000000003', 'a000000000000004', 'a000000000000005', 'a000000000000006']);
  });
});
