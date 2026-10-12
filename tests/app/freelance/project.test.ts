import { describe, expect, it } from 'vitest';
import { deadReason, isoWeek, previousWeek } from '../../../src/app/freelance/health.js';
import { gigDedupeKey, gigKey } from '../../../src/app/freelance/keys.js';
import { gigRowsOf, NOTE_NO_FACTS, NOTE_ONE_SKILL, type GigRunOutputs } from '../../../src/app/freelance/project.js';
import { freshGigs, gigNotificationFor } from '../../../src/app/freelance/run.js';
import type { Gig, GigQaReport, GigRendered, ScoredGig } from '../../../src/app/freelance/types.js';
import { belowFitFloor, proposalPlanner } from '../../../src/app/freelance/writing/proposal-planner.js';
import { AppStore, type GigUpsert, type GigView } from '../../../src/app/store/app-store.js';
import { freezePack, issueContext } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import { Store } from '../../../src/kernel/store/store.js';
import { fixturePack, scoredGig } from '../../support/gig-fixtures.js';

const AT = '2026-10-12T03:00:00.000Z';
const OPTS = { fitFloor: 45, docOnDisk: () => 'ok' as const, at: AT };
const empty = (): GigRunOutputs => ({ gigs: [], rated: [], verdicts: [], risked: [], scored: [], rendered: [], qa: [], blocked: new Map(), writingFailed: new Map() });
const gigOf = (s: ScoredGig): Gig => s.risked.verdict.rated.gig;
const outputsOf = (scored: readonly ScoredGig[], extra: Partial<GigRunOutputs> = {}): GigRunOutputs => ({
  ...empty(),
  gigs: scored.map(gigOf),
  rated: scored.map((s) => s.risked.verdict.rated),
  verdicts: scored.map((s) => s.risked.verdict),
  risked: scored.map((s) => s.risked),
  scored,
  ...extra,
});
const withGig = (s: ScoredGig, over: Partial<Gig>): ScoredGig => {
  const gig = { ...gigOf(s), ...over };
  return { ...s, risked: { ...s.risked, verdict: { ...s.risked.verdict, rated: { ...s.risked.verdict.rated, gig } } } };
};
const flagsOf = (rows: ReturnType<typeof gigRowsOf>, key: string): string[] => rows.find((r) => r.row.gigKey === key)!.row.flags.map((f) => f.id);

/** A rendered proposal and its passing QA report for one gig. */
function docsFor(key: string, proposal: string): { rendered: GigRendered; qa: GigQaReport } {
  const files = [{ kind: 'proposal' as const, format: 'txt' as const, path: `gigs/${key}/proposal.txt`, sha256: key.padEnd(64, '0').slice(0, 64), pages: null }];
  return {
    rendered: { gigKey: key, files, plan: {} as GigRendered['plan'], text: { proposal, pitch: null, resume: '' } },
    qa: { gigKey: key, ok: true, checks: [{ id: 'qa.files', ok: true, detail: '' }], files },
  };
}

describe('the freelance projector: one row per gig', () => {
  it('dedupe: one Freelancer project returned by two queries (bids changed in between) is one row, whatever the input order', () => {
    const a = scoredGig({ sourceId: '7', bids: 4 });
    const b = { ...withGig(a, { bids: 9 }), breakdown: { bids: 9 } };
    const ab = gigRowsOf(outputsOf([a, b]), OPTS);
    const ba = gigRowsOf(outputsOf([b, a]), OPTS);
    expect(ab).toHaveLength(1);
    expect(ab).toEqual(ba);
    expect(ab[0]!.row).toMatchObject({ gigKey: gigKey('freelancer', '7'), list: 'gigs', fit: 60, verdict: 'eligible' });
  });

  it('dedupe: the same gig on two platforms links to the earliest-first-seen one; two gigs of one platform stay separate', () => {
    const app = AppStore.on(Store.open(':memory:'));
    const row = (platform: string, id: string, at: string): GigUpsert => ({
      gigKey: gigKey(platform, id), dedupeKey: gigDedupeKey('Acme', 'Go API contract'), platform, sourceId: id, url: `https://x.test/${id}`, title: 'Go API contract',
      description: '', client: {}, kind: 'contract', budget: {}, rate: null, hours: {}, verdict: 'review', reasons: [], notes: [], flags: [], fit: 50, breakdown: null,
      list: 'review', docsState: 'none', docsDetail: null, postedAt: null, at,
    });
    app.upsertGig(row('remotive', 'r1', '2026-10-12T01:00:00.000Z'));
    app.upsertGig(row('boards', 'b1', '2026-10-12T02:00:00.000Z'));
    app.upsertGig(row('remotive', 'r2', '2026-10-12T03:00:00.000Z'));
    const dupOf = Object.fromEntries(app.listGigs({ duplicates: true }).map((g) => [g.sourceId, g.duplicateOf]));
    expect(dupOf).toEqual({ r1: null, b1: gigKey('remotive', 'r1'), r2: null });
    expect(app.listGigs().map((g) => g.sourceId).sort()).toEqual(['r1', 'r2']);
    // A re-projection with the same time is applied; an older one is stale and changes nothing.
    expect(app.upsertGig(row('boards', 'b1', '2026-10-12T02:00:00.000Z')).stale).toBe(false);
    expect(app.upsertGig(row('boards', 'b1', '2026-10-11T02:00:00.000Z')).stale).toBe(true);
  });

  it('list: below the fit floor a gig is below-floor with no documents; a rejected gig has no list', () => {
    const low = { ...scoredGig({ sourceId: '1' }), fit: 30 };
    const rows = gigRowsOf(outputsOf([low]), OPTS);
    expect(rows[0]!.row).toMatchObject({ list: 'below-floor', docsState: 'none', docsDetail: 'below the fit floor' });
    const lowReview = { ...scoredGig({ sourceId: '9' }), fit: 30, list: 'review' as const };
    expect(gigRowsOf(outputsOf([lowReview]), OPTS)[0]!.row).toMatchObject({ list: 'review', docsState: 'none', docsDetail: 'below the fit floor' });
    const rejected = scoredGig({ sourceId: '2' });
    const v = { ...rejected.risked.verdict, verdict: 'rejected' as const, reasons: ['rate:below-floor'] };
    const r = gigRowsOf({ ...empty(), gigs: [gigOf(rejected)], rated: [v.rated], verdicts: [v] }, OPTS);
    expect(r[0]!.row).toMatchObject({ list: null, verdict: 'rejected', reasons: ['rate:below-floor'], fit: null });
  });
});

describe('the freelance projector: run-wide flags', () => {
  const desc = 'Need a Go developer to build a REST API with PostgreSQL. Long term work for the right person.';

  it('duplicate-text: the same description from another (or an unknown) client in one run is flagged on both', () => {
    const a = withGig(scoredGig({ sourceId: '1' }), { description: desc });
    const b = withGig(scoredGig({ sourceId: '2' }), { description: `  ${desc.toUpperCase()}\n` });
    const c = withGig(scoredGig({ sourceId: '3' }), { description: 'Something else entirely.' });
    const rows = gigRowsOf(outputsOf([a, b, c]), OPTS);
    expect(flagsOf(rows, gigOf(a).gigKey)).toEqual(['duplicate-text']);
    expect(flagsOf(rows, gigOf(b).gigKey)).toEqual(['duplicate-text']);
    expect(flagsOf(rows, gigOf(c).gigKey)).toEqual([]);
    expect(rows.find((r) => r.row.gigKey === gigOf(a).gigKey)!.row.flags[0]!.detail).toBe(`same description as gig ${gigOf(b).gigKey} (client unknown)`);
  });

  it('duplicate-text: the same description from one named client is a repost, not flagged', () => {
    const client = { ...gigOf(scoredGig()).client, name: 'Acme' };
    const a = withGig(scoredGig({ sourceId: '1' }), { description: desc, client });
    const b = withGig(scoredGig({ sourceId: '2' }), { description: desc, client });
    const rows = gigRowsOf(outputsOf([a, b]), OPTS);
    expect(flagsOf(rows, gigOf(a).gigKey)).toEqual([]);
    expect(flagsOf(rows, gigOf(b).gigKey)).toEqual([]);
    // A third, named client with the same text: flagged against it, as another client.
    const c = withGig(scoredGig({ sourceId: '3' }), { description: desc, client: { ...client, name: 'Globex' } });
    const three = gigRowsOf(outputsOf([a, b, c]), OPTS);
    expect(three.find((r) => r.row.gigKey === gigOf(a).gigKey)!.row.flags).toEqual([{ id: 'duplicate-text', detail: `same description as gig ${gigOf(c).gigKey} (another client)` }]);
  });

  it('repeat: two proposals of one run that share their first 60 characters are both flagged', () => {
    const [a, b, c] = ['1', '2', '3'].map((id) => withGig(scoredGig({ sourceId: id }), { description: `Gig ${id} text.` })) as [ScoredGig, ScoredGig, ScoredGig];
    const same = 'I read through your brief. Here is what I would bring to it.';
    const docs = [docsFor(gigOf(a).gigKey, `${same}\nA`), docsFor(gigOf(b).gigKey, `${same.toUpperCase()}\nB`), docsFor(gigOf(c).gigKey, 'Your API caught my eye.\nC')];
    const rows = gigRowsOf(outputsOf([a, b, c], { rendered: docs.map((d) => d.rendered), qa: docs.map((d) => d.qa) }), OPTS);
    expect(flagsOf(rows, gigOf(a).gigKey)).toEqual(['repeat']);
    expect(flagsOf(rows, gigOf(b).gigKey)).toEqual(['repeat']);
    expect(flagsOf(rows, gigOf(c).gigKey)).toEqual([]);
    expect(rows.find((r) => r.row.gigKey === gigOf(c).gigKey)!.row).toMatchObject({ docsState: 'ready', docsDetail: null });
  });

  it('docs: a file gone from disk is missing; a failed QA blocks; a quarantined writing step blocks', () => {
    const a = scoredGig({ sourceId: '1' });
    const d = docsFor(gigOf(a).gigKey, 'Hello there.');
    const gone = gigRowsOf(outputsOf([a], { rendered: [d.rendered], qa: [d.qa] }), { ...OPTS, docOnDisk: () => 'absent' });
    expect(gone[0]!.row).toMatchObject({ docsState: 'missing', docsDetail: `documents missing: gigs/${gigOf(a).gigKey}/proposal.txt is not on disk` });
    const failed = { ...d.qa, ok: false, checks: [{ id: 'gig.limits', ok: false, detail: 'the proposal has 1600 characters, the limit is 1500' }] };
    expect(gigRowsOf(outputsOf([a], { qa: [failed] }), OPTS)[0]!.row).toMatchObject({ docsState: 'blocked', docsDetail: 'qa failed: gig.limits: the proposal has 1600 characters, the limit is 1500' });
    const blocked = new Map([[gigOf(a).gigKey, 'gig-renderer quarantined: G-GROUND: text differs']]);
    expect(gigRowsOf(outputsOf([a], { blocked }), OPTS)[0]!.row).toMatchObject({ docsState: 'blocked', docsDetail: 'gig-renderer quarantined: G-GROUND: text differs' });
  });
});

describe('writing runs only at or above the fit floor', () => {
  it('proposal-planner plans nothing for a gig under freelance.fitFloor, in any list', async () => {
    const { pub } = fixturePack();
    const ctx = issueContext({ contract: proposalPlanner.contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, clock: fixedClock(AT), signal: AbortSignal.timeout(10_000), pack: freezePack(pub) });
    for (const list of ['gigs', 'contracts', 'review'] as const) {
      expect(await proposalPlanner.run({ ...scoredGig(), list, fit: 44 }, ctx)).toEqual([]);
      expect(await proposalPlanner.run({ ...scoredGig(), list, fit: 45 }, ctx)).toHaveLength(1);
    }
    expect(belowFitFloor({ ...scoredGig(), fit: 44.9 }, pub)).toBe(true);
  });
});

describe('source health', () => {
  it('ISO weeks (IST date in, YYYY-Www out), across a year end', () => {
    expect(isoWeek('2026-10-12')).toBe('2026-W42');
    expect(isoWeek('2026-10-18')).toBe('2026-W42');
    expect(isoWeek('2021-01-03')).toBe('2020-W53');
    expect(isoWeek('2024-12-30')).toBe('2025-W01');
    expect(previousWeek('2026-W42')).toBe('2026-W41');
    expect(previousWeek('2021-W01')).toBe('2020-W53');
  });

  it('a source with 0 yield 4 weeks running, or 3 failed fetch runs in a row, looks dead; it is never removed', () => {
    const app = AppStore.on(Store.open(':memory:'));
    const zero = { fetched: 5, eligible: 0, aboveFloor: 0, shortlisted: 0, failed: false, probeFailures: 0 };
    const weeks = ['2026-W39', '2026-W40', '2026-W41', '2026-W42'];
    weeks.slice(0, 3).forEach((w, i) => app.addSourceHealth(`run-${i}`, 'hn-hiring', w, zero));
    expect(deadReason(app.sourceHealth('hn-hiring'), '2026-W41')).toBeUndefined(); // 3 weeks only
    app.addSourceHealth('run-3', 'hn-hiring', '2026-W42', zero);
    expect(deadReason(app.sourceHealth('hn-hiring'), '2026-W42')).toBe('0 gigs above the fit floor for 4 weeks running');
    // One counted run never counts twice.
    expect(app.addSourceHealth('run-3', 'hn-hiring', '2026-W42', zero)).toBe(false);
    expect(app.sourceHealth('hn-hiring').at(-1)).toMatchObject({ runs: 1, fetched: 5 });
    // A gap week (no counted run) is no evidence.
    app.addSourceHealth('run-a', 'remotive', '2026-W39', zero);
    app.addSourceHealth('run-b', 'remotive', '2026-W41', zero);
    app.addSourceHealth('run-c', 'remotive', '2026-W42', zero);
    expect(deadReason(app.sourceHealth('remotive'), '2026-W42')).toBeUndefined();
    // Yield in any of the 4 weeks: alive.
    app.addSourceHealth('run-d', 'boards', '2026-W39', { ...zero, aboveFloor: 1 });
    for (const [i, w] of weeks.slice(1).entries()) app.addSourceHealth(`run-e${i}`, 'boards', w, zero);
    expect(deadReason(app.sourceHealth('boards'), '2026-W42')).toBeUndefined();
    // The probe streak.
    for (const n of [1, 2]) app.addSourceHealth(`run-f${n}`, 'freelancer', '2026-W42', { ...zero, aboveFloor: 3, failed: true, probeFailures: n });
    expect(deadReason(app.sourceHealth('freelancer'), '2026-W42')).toBeUndefined();
    app.addSourceHealth('run-f3', 'freelancer', '2026-W42', { ...zero, failed: true, probeFailures: 3 });
    expect(deadReason(app.sourceHealth('freelancer'), '2026-W42')).toBe('3 runs in a row failed every fetch');
    expect(app.sourceHealth('freelancer')[0]).toMatchObject({ runs: 3, failedRuns: 3, aboveFloor: 6 });
  });
});

describe('the freelance notification', () => {
  const view = (over: Partial<GigView>): GigView => ({
    gigKey: 'a'.repeat(16), dedupeKey: 'b'.repeat(16), duplicateOf: null, platform: 'freelancer', sourceId: '1', url: 'https://x.test/1', title: 'Go API contract', description: '',
    client: {}, kind: 'contract', budget: {}, rate: { minUsdH: 50, maxUsdH: 65, method: 'stated', fxDate: null, fxSource: null, budgetUsd: null }, hours: {}, verdict: 'eligible',
    reasons: [], notes: [], flags: [], fit: 60, breakdown: {}, list: 'contracts', docsState: 'ready', docsDetail: null, postedAt: '2026-10-12T00:00:00Z',
    firstSeen: AT, lastSeen: AT, status: 'new', note: '', appliedAt: null, notifiedAt: null, ...over,
  });
  const o = { rateFloor: 40, half: 'am' as const, naming: { forbiddenTerms: ['Initech'] }, problems: 0 };

  it('names the count, the top hourly rate, the title (at most 40 characters) and the platform', () => {
    expect(gigNotificationFor([view({})], o)).toBe('1 new gig ≥$40/h · top: $65/h Go API contract (Freelancer)');
    const long = view({ gigKey: 'c'.repeat(16), title: 'Senior TypeScript engineer for a payments platform rewrite', rate: { maxUsdH: 80, minUsdH: 80, method: 'stated', budgetUsd: null }, platform: 'hn-hiring' });
    expect(gigNotificationFor([view({}), long], { ...o, problems: 2 })).toBe('2 new gigs ≥$40/h · top: $80/h Senior TypeScript engineer for a paymen… (HN) · 2 problems');
  });

  it('a top with an unknown hourly rate (an eligible fixed-price gig) shows its budget instead', () => {
    const fixed = view({ kind: 'gig', list: 'gigs', title: 'Build a Stripe checkout', rate: { minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, fxSource: null, budgetUsd: 1500 } });
    expect(gigNotificationFor([fixed], o)).toBe('1 new gig ≥$40/h · top: budget $1500 Build a Stripe checkout (Freelancer)');
  });

  it('skips a red-flagged top; with no gig: "No new gigs this morning" or "… this evening"', () => {
    const red = view({ gigKey: 'd'.repeat(16), title: 'Pay via crypto first', rate: { maxUsdH: 200, minUsdH: 200, method: 'stated', budgetUsd: null }, flags: [{ id: 'upfront-fee', detail: 'x' }] });
    expect(gigNotificationFor([red, view({})], o)).toBe('2 new gigs ≥$40/h · top: $65/h Go API contract (Freelancer)');
    expect(gigNotificationFor([red], o)).toBe('1 new gig ≥$40/h');
    expect(gigNotificationFor([], o)).toBe('No new gigs this morning');
    expect(gigNotificationFor([], { ...o, half: 'pm', problems: 1 })).toBe('No new gigs this evening · 1 problem');
  });

  it('never carries a forbidden term', () => {
    expect(gigNotificationFor([view({ title: 'Initech payments API' })], o)).toBe('1 new gig ≥$40/h');
  });
});

describe('the coverage gate (Task 10 fix round 1)', () => {
  /** A ready proposal whose plan backs `covered` terms and cites `cited` evidence lines. */
  const planned = (s: ScoredGig, covered: string[], cited: number) => {
    const d = docsFor(gigOf(s).gigKey, `Proposal for ${gigOf(s).sourceId}.`);
    const evidence = Array.from({ length: Math.max(cited, 1) }, (_, i) => ({ text: `line ${i}`, factIds: i < cited ? [`f-${i}`] : [] }));
    d.rendered.plan = { proposal: { evidence }, pitch: null, covered, missing: ['rust'] } as unknown as GigRendered['plan'];
    return d;
  };
  const gigs = [scoredGig({ sourceId: '40' }), scoredGig({ sourceId: '41' }), scoredGig({ sourceId: '42' }), scoredGig({ sourceId: '43', kind: 'contract' })];
  const docs = [planned(gigs[0]!, [], 0), planned(gigs[1]!, ['java'], 1), planned(gigs[2]!, ['java', 'kafka'], 2), planned(gigs[3]!, ['java', 'kafka'], 0)];
  const rows = gigRowsOf(outputsOf(gigs, { rendered: docs.map((d) => d.rendered), qa: docs.map((d) => d.qa) }), OPTS);
  const rowOf = (s: ScoredGig) => rows.find((r) => r.row.gigKey === gigOf(s).gigKey)!.row;

  it('0 covered terms: review, the note, documents blocked; 1: listed with the amber note; 2: listed as it was', () => {
    expect(rowOf(gigs[0]!)).toMatchObject({ list: 'review', notes: [NOTE_NO_FACTS], docsState: 'blocked', docsDetail: NOTE_NO_FACTS, fit: 60 });
    expect(rowOf(gigs[1]!)).toMatchObject({ list: 'gigs', notes: [NOTE_ONE_SKILL], docsState: 'ready' });
    expect(rowOf(gigs[2]!)).toMatchObject({ list: 'gigs', notes: [], docsState: 'ready' });
  });

  it('covered terms but no cited evidence line: review too (a contract)', () => {
    expect(rowOf(gigs[3]!)).toMatchObject({ list: 'review', notes: [NOTE_NO_FACTS], docsState: 'blocked' });
  });

  it('the notification never announces a gated gig', () => {
    const app = AppStore.open(':memory:');
    try {
      for (const r of rows) app.upsertGig(r.row);
      const fresh = freshGigs(app).map((g) => g.gigKey).sort();
      expect(fresh).toEqual([gigOf(gigs[1]!).gigKey, gigOf(gigs[2]!).gigKey].sort());
      expect(gigNotificationFor(freshGigs(app), { rateFloor: 40, half: 'am', naming: { forbiddenTerms: [] }, problems: 0 })).toMatch(/^2 new gigs/);
    } finally {
      app.close();
    }
  });
});
