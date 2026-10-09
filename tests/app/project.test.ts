import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diskDocCheck } from '../../src/app/docs-check.js';
import { runProblems } from '../../src/app/problems.js';
import { projectRun, runCounts } from '../../src/app/project.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { dedupeKey, jobKey } from '../../src/app/text/norm.js';
import { jobKeyOf, makeJobTracker } from '../../src/app/tracker.js';
import type { EligibilityVerdict, Posting, QaReport, Rendered, Scored } from '../../src/app/types.js';
import { makeEnvelopeId, ZERO_COST, type Envelope } from '../../src/kernel/envelope.js';
import { InvalidTransition } from '../../src/kernel/errors.js';
import { Store } from '../../src/kernel/store/store.js';

const RUN = 'daily-2026-10-09';
const AT = '2026-10-09T01:30:00.000Z';
const FX = { toINR: { INR: 1, USD: 83.5, EUR: 90.2, GBP: 106.4 } };
const OPTS = { minFit: 60, fx: FX, docOnDisk: () => 'ok' as const };

/** A fictional posting; its keys are computed as the normalizer does unless `over` sets them. */
function posting(n: number, over: Partial<Posting> = {}): Posting {
  const p: Omit<Posting, 'jobKey' | 'dedupeKey'> = {
    source: 'greenhouse',
    sourceId: String(1000 + n),
    company: `Company ${n}`,
    slug: `company-${n}`,
    ats: 'greenhouse',
    title: 'Senior Backend Engineer',
    url: `https://boards.example.test/c${n}/jobs/${1000 + n}`,
    locationText: 'Remote, India',
    remote: { structured: 'remote', countries: ['india'], signals: ['workplaceType:remote'] },
    employmentType: 'full-time',
    descriptionText: `JD ${n}`,
    postedAt: '2026-10-01',
    comp: null,
    yearsRequired: null,
    ...over,
  };
  return { jobKey: jobKey(p.source, p.sourceId), dedupeKey: dedupeKey(p.company, p.title, p.locationText), ...p, ...over } as Posting;
}
const verdict = (p: Posting, v: EligibilityVerdict['verdict'], reasons: string[] = []): EligibilityVerdict => ({ posting: p, verdict: v, reasons, notes: ['pay not disclosed'] });
const scored = (p: Posting, score: number, v: Scored['verdict'] = 'eligible'): Scored => ({
  posting: p,
  verdict: v,
  notes: [],
  score,
  breakdown: [{ label: 'title', points: score }],
  jdTerms: { strong: ['java'], medium: [], gap: [] },
});
const file = (jobKey: string, kind: 'resume' | 'cover', format: 'pdf' | 'docx' | 'html') => ({
  kind,
  format,
  path: `${jobKey}/${kind}.${format}`,
  sha256: (kind === 'resume' ? 'a' : 'b').repeat(64),
  pages: format === 'html' ? null : 1,
});

/** Writes a hand-made run straight through the kernel store's own write API, the way the executor does. */
class RunBuilder {
  readonly store = Store.open(':memory:');
  private n = 0;
  constructor(readonly runId = RUN) {
    this.store.startRun(runId, 'daily@1', 'policy-hash', AT);
    this.store.appendEvent(runId, AT, 'run_started', { pipeline: 'daily', seeds: 1 }, 'policy-hash');
  }
  private env(stepKey: string, i: number, type: string, payload: unknown): Envelope {
    return {
      envelopeId: makeEnvelopeId(stepKey, i), stepKey, index: i, type, producer: { agentId: 'x', version: '1.0.0', contractHash: 'h' },
      parents: [], payload, handoff: { guarantees: [], dataClass: 'P0', obligations: [], pins: { policyHash: 'policy-hash' } }, guardrails: [], cost: ZERO_COST,
    };
  }
  /** A seed-like input envelope with no producing step in the run. */
  input(type: string, payload: unknown): Envelope {
    const stepKey = `seed-${(this.n += 1)}`;
    const e = this.env(stepKey, 0, type, payload);
    this.store.putSeed(stepKey, e, '1', 'seed-hash');
    return e;
  }
  done(agent: string, input: Envelope, outputs: { type: string; payload: unknown }[], runId = this.runId): Envelope[] {
    const stepKey = `step-${(this.n += 1)}`;
    const envs = outputs.map((o, i) => this.env(stepKey, i, o.type, o.payload));
    this.store.enqueue(runId, 1, agent, input.envelopeId);
    this.store.markRunning({ stepKey, agentId: agent, version: '1.0.0', contractHash: 'h', inputEnvelopeId: input.envelopeId });
    this.store.finishStep({ runId, stepKey, agentId: agent, status: 'done', envelopes: envs, cost: ZERO_COST, event: { at: AT, kind: 'step_done', data: { agent, stepKey, outputs: envs.length }, policyHash: 'policy-hash' } });
    this.store.markQueue(runId, agent, input.envelopeId, 'done');
    return envs;
  }
  quarantinedOut(agent: string, input: Envelope, verdictDetail: string): void {
    const stepKey = `step-${(this.n += 1)}`;
    const v = { id: 'G-GROUND', verdict: 'trip', detail: verdictDetail };
    this.store.enqueue(this.runId, 5, agent, input.envelopeId);
    this.store.markRunning({ stepKey, agentId: agent, version: '1.0.0', contractHash: 'h', inputEnvelopeId: input.envelopeId });
    this.store.finishStep({
      runId: this.runId, stepKey, agentId: agent, status: 'quarantined', envelopes: [], cost: ZERO_COST, detail: JSON.stringify([v]),
      event: { at: AT, kind: 'step_quarantined', data: { agent, stepKey, side: 'out', index: 0, verdict: v }, policyHash: 'policy-hash' },
    });
    this.store.markQueue(this.runId, agent, input.envelopeId, 'quarantined');
  }
  /** An input-side trip writes no step row; only the tracker's transition names the job. */
  /** `prior`: the tracker events the job went through before the trip, so the transition's from-state is right. */
  quarantinedIn(agent: string, input: Envelope, jobKey: string, prior: readonly string[]): void {
    const stepKey = `step-${(this.n += 1)}`;
    this.store.enqueue(this.runId, 5, agent, input.envelopeId);
    this.store.appendEvent(this.runId, AT, 'step_quarantined', { agent, stepKey, side: 'in', verdict: { id: 'G-NAMING', verdict: 'trip', detail: 'forbidden term' } }, 'policy-hash');
    const t = makeJobTracker({ minFit: 60 });
    prior.forEach((ev, i) => this.store.applyTransition(jobKey, t.kind, `${stepKey}-prior-${i}`, ev, t.machine, 'done'));
    this.store.applyTransition(jobKey, t.kind, stepKey, 'blocked', t.machine, 'quarantined');
    this.store.markQueue(this.runId, agent, input.envelopeId, 'quarantined');
  }
  failed(agent: string, input: Envelope, error: string, detail = 'x'): void {
    const stepKey = `step-${(this.n += 1)}`;
    this.store.enqueue(this.runId, 0, agent, input.envelopeId);
    this.store.markRunning({ stepKey, agentId: agent, version: '1.0.0', contractHash: 'h', inputEnvelopeId: input.envelopeId });
    this.store.finishStep({
      runId: this.runId, stepKey, agentId: agent, status: 'failed', envelopes: [], cost: ZERO_COST, errorCode: error as 'gone', detail,
      event: { at: AT, kind: 'step_failed', data: { agent, stepKey, envelopeId: input.envelopeId, error, detail }, policyHash: 'policy-hash' },
    });
    this.store.markQueue(this.runId, agent, input.envelopeId, 'failed');
  }
  skipped(agent: string, input: Envelope): void {
    this.store.enqueue(this.runId, 0, agent, input.envelopeId);
    this.store.markQueue(this.runId, agent, input.envelopeId, 'skipped');
    this.store.appendEvent(this.runId, AT, 'step_skipped', { agent, envelopeId: input.envelopeId, reason: 'breaker_open' }, 'policy-hash');
  }
  /** Normalizer → eligibility → (scorer) chain for one posting; returns the last envelope. */
  chain(p: Posting, v: EligibilityVerdict['verdict'], score?: number, reasons: string[] = []): Envelope {
    const raw = this.input('RawPosting@1', { source: p.source, sourceId: p.sourceId, company: p.company, slug: p.slug, raw: {} });
    const [post] = this.done('normalizer', raw, [{ type: 'Posting@1', payload: p }]) as [Envelope];
    const [ev] = this.done('eligibility', post, [{ type: 'EligibilityVerdict@1', payload: verdict(p, v, reasons) }]) as [Envelope];
    if (score === undefined) return ev;
    const [sc] = this.done('scorer-lexicon', ev, [{ type: 'Scored@1', payload: scored(p, score, v === 'review' ? 'review' : 'eligible') }]) as [Envelope];
    return sc;
  }
  /** Stand-ins for the writing team (Tasks 9-10): Scored → Rendered → QaReport. */
  write(sc: Envelope, ok: boolean): void {
    const p = (sc.payload as Scored).posting;
    const files = [file(p.jobKey, 'resume', 'pdf'), file(p.jobKey, 'resume', 'docx'), file(p.jobKey, 'cover', 'pdf')];
    const rendered = { jobKey: p.jobKey, files, recommended: 'pdf', plan: {} } as unknown as Rendered;
    const [r] = this.done('renderer', sc, [{ type: 'Rendered@1', payload: rendered }]) as [Envelope];
    const qa: QaReport = { jobKey: p.jobKey, ok, checks: [{ id: 'pages', ok, detail: ok ? 'resume 1 page' : 'resume 3 pages > 2' }], files };
    this.done('qa-gate', r, [{ type: 'QaReport@1', payload: qa }]);
  }
}

describe('job tracker', () => {
  const t = makeJobTracker({ minFit: 60 });
  const e = (type: string, payload: unknown) => ({ type, payload }) as Envelope;
  const p = posting(1);

  it('keys every app type that carries a posting and returns null for anything else, never throwing', () => {
    expect(jobKeyOf(e('Posting@1', p))).toBe(p.jobKey);
    expect(jobKeyOf(e('EligibilityVerdict@1', verdict(p, 'eligible')))).toBe(p.jobKey);
    expect(jobKeyOf(e('Scored@1', scored(p, 70)))).toBe(p.jobKey);
    expect(jobKeyOf(e('Evidence@1', { scored: scored(p, 70), ranked: [], covered: [], missing: [] }))).toBe(p.jobKey);
    for (const type of ['ResumePlan@1', 'CoverPlan@1', 'Rendered@1', 'QaReport@1']) expect(jobKeyOf(e(type, { jobKey: p.jobKey }))).toBe(p.jobKey);
    for (const x of [e('RawPosting@1', {}), e('DiscoveryRequest@1', {}), e('CareerLink@1', {}), e('Other@1', null), e('Posting@1', null), e('Scored@1', { posting: 3 }), e('QaReport@1', { jobKey: 'NOPE' })]) {
      expect(t.keyOf(x)).toBeNull();
    }
  });

  it('walks a job through NORMALIZED, SCORED, PLANNED, RENDERED to READY or BLOCKED', () => {
    const m = t.machine;
    const ev = (agent: string, type: string, payload: unknown) => t.eventFor(agent, 'done', e(type, payload)) as string;
    let s = m.def.initial;
    expect(s).toBe('DISCOVERED');
    s = m.next(s, ev('normalizer', 'Posting@1', p));
    expect(s).toBe('NORMALIZED');
    expect(t.eventFor('eligibility', 'done', e('EligibilityVerdict@1', verdict(p, 'eligible')))).toBeNull();
    s = m.next(s, ev('scorer-lexicon', 'Scored@1', scored(p, 70)));
    expect(s).toBe('SCORED');
    expect(t.eventFor('evidence-matcher', 'done', e('Evidence@1', {}))).toBeNull();
    s = m.next(s, ev('resume-planner', 'ResumePlan@1', { jobKey: p.jobKey }));
    expect(s).toBe('PLANNED');
    expect(t.eventFor('cover-writer', 'done', e('CoverPlan@1', {}))).toBeNull();
    s = m.next(s, ev('renderer', 'Rendered@1', { jobKey: p.jobKey }));
    expect(s).toBe('RENDERED');
    expect(m.next(s, ev('qa-gate', 'QaReport@1', { jobKey: p.jobKey, ok: true }))).toBe('READY');
    expect(m.next(s, ev('qa-gate', 'QaReport@1', { jobKey: p.jobKey, ok: false }))).toBe('BLOCKED');
  });

  it('ends rejected and below-floor jobs, which count as successes, and blocks on quarantine', () => {
    const m = t.machine;
    expect(m.next('NORMALIZED', t.eventFor('eligibility', 'done', e('EligibilityVerdict@1', verdict(p, 'rejected'))) as string)).toBe('REJECTED');
    expect(m.next('NORMALIZED', t.eventFor('scorer-lexicon', 'done', e('Scored@1', scored(p, 59))) as string)).toBe('BELOW_FLOOR');
    expect(m.next('PLANNED', t.eventFor('renderer', 'quarantined', e('CoverPlan@1', {})) as string)).toBe('BLOCKED');
    expect(m.def.terminal).toEqual(['REJECTED', 'BELOW_FLOOR', 'READY', 'BLOCKED']);
    for (const s of ['REJECTED', 'BELOW_FLOOR', 'READY']) expect(m.isSuccess(s)).toBe(true);
    expect(m.isSuccess('BLOCKED')).toBe(false);
    expect(() => m.next('READY', 'normalized')).toThrow(InvalidTransition);
  });
});

describe('projectRun', () => {
  it('writes rejected, below-floor, ready and blocked rows from a hand-made run', () => {
    const b = new RunBuilder();
    const app = AppStore.on(b.store);
    b.chain(posting(1), 'rejected', undefined, ['onsite-only']);
    b.chain(posting(2, { comp: { min: 4_000_000, max: 8_000_000, currency: 'INR', period: 'year', basis: 'base' } }), 'eligible', 40);
    b.write(b.chain(posting(3, { comp: { min: null, max: 100_000, currency: 'USD', period: 'year', basis: 'unknown' } }), 'eligible', 75), true);
    b.write(b.chain(posting(4), 'eligible', 80), false);
    const s5 = b.chain(posting(5), 'review', 66);
    b.quarantinedOut('evidence-matcher', s5, 'bullet 2 is not a fact claim');
    b.chain(posting(6), 'eligible', 90); // writing not reached: docs pending

    const r = projectRun(b.store, app, RUN, OPTS);
    expect(r).toMatchObject({ jobs: 6, inserted: 6, docs: { none: 2, 'below-floor': 1, ready: 1, blocked: 2 } });

    const j = (n: number) => app.getJob(posting(n).jobKey);
    expect(j(1)).toMatchObject({ verdict: 'rejected', reasons: ['onsite-only'], docsState: 'none', score: null, status: 'new', firstSeen: AT });
    expect(j(2)).toMatchObject({ verdict: 'eligible', score: 40, docsState: 'below-floor', compMinInr: 4_000_000, compMaxInr: 8_000_000, compBasis: 'base' });
    expect(j(3)).toMatchObject({ docsState: 'ready', recommendedFormat: 'pdf', compMinInr: null, compMaxInr: 8_350_000, compBasis: 'unknown', jdText: 'JD 3' });
    expect(j(3)?.docs.map((d) => [d.kind, d.format, d.qaOk])).toEqual([['cover', 'pdf', true], ['resume', 'docx', true], ['resume', 'pdf', true]]);
    expect(j(4)).toMatchObject({ docsState: 'blocked', docsDetail: 'qa failed: pages: resume 3 pages > 2' });
    expect(j(4)?.docs.every((d) => !d.qaOk)).toBe(true);
    expect(j(5)).toMatchObject({ docsState: 'blocked', docsDetail: 'evidence-matcher quarantined: G-GROUND: bullet 2 is not a fact claim', verdict: 'review', reasons: [] });
    expect(j(6)).toMatchObject({ docsState: 'none', score: 90 });
  });

  it('blocks a job whose writing step tripped an input-side guardrail, named through the tracker transition', () => {
    const b = new RunBuilder();
    const app = AppStore.on(b.store);
    const sc = b.chain(posting(7), 'eligible', 70);
    b.quarantinedIn('evidence-matcher', sc, posting(7).jobKey, ['normalized', 'scored']);
    projectRun(b.store, app, RUN, OPTS);
    expect(app.getJob(posting(7).jobKey)).toMatchObject({ docsState: 'blocked', docsDetail: 'evidence-matcher quarantined: G-NAMING: forbidden term' });
  });

  it('an input-side trip at eligibility or the scorer leaves docs none, with the detail (fix round 2)', () => {
    const b = new RunBuilder();
    const app = AppStore.on(b.store);
    const raw = b.input('RawPosting@1', {});
    const [post] = b.done('normalizer', raw, [{ type: 'Posting@1', payload: posting(13) }]) as [Envelope];
    b.quarantinedIn('eligibility', post, posting(13).jobKey, ['normalized']);
    const ev = b.chain(posting(14), 'eligible');
    b.quarantinedIn('scorer-lexicon', ev, posting(14).jobKey, ['normalized']);
    projectRun(b.store, app, RUN, OPTS);
    expect(app.getJob(posting(13).jobKey)).toMatchObject({ docsState: 'none', docsDetail: 'eligibility quarantined: G-NAMING: forbidden term' });
    expect(app.getJob(posting(14).jobKey)).toMatchObject({ docsState: 'none', docsDetail: 'scorer-lexicon quarantined: G-NAMING: forbidden term' });
  });

  it('never lets an older run overwrite newer data: project A, then B, then A again (fix round 2)', () => {
    const b = new RunBuilder();
    const app = AppStore.on(b.store);
    b.write(b.chain(posting(3), 'eligible', 75), true);
    projectRun(b.store, app, RUN, OPTS);
    const run2 = 'daily-2026-10-16';
    const at2 = '2026-10-16T01:30:00.000Z';
    b.store.startRun(run2, 'daily@1', 'policy-hash', at2);
    b.store.appendEvent(run2, at2, 'run_started', {}, 'policy-hash');
    const newer = posting(3, { title: 'Staff Backend Engineer' });
    const [post] = b.done('normalizer', b.input('RawPosting@1', {}), [{ type: 'Posting@1', payload: newer }], run2) as [Envelope];
    const [ev] = b.done('eligibility', post, [{ type: 'EligibilityVerdict@1', payload: verdict(newer, 'eligible') }], run2) as [Envelope];
    b.done('scorer-lexicon', ev, [{ type: 'Scored@1', payload: scored(newer, 50) }], run2);
    projectRun(b.store, app, run2, OPTS);
    const afterB = JSON.stringify(app.getJob(posting(3).jobKey));
    expect(projectRun(b.store, app, RUN, OPTS)).toMatchObject({ jobs: 0, stale: 1 });
    expect(JSON.stringify(app.getJob(posting(3).jobKey))).toBe(afterB);
    expect(app.getJob(posting(3).jobKey)).toMatchObject({ title: 'Staff Backend Engineer', lastSeen: at2, docsState: 'below-floor', docs: [] });
  });

  it('a later run upserts the same (source, sourceId) as a newer version and keeps the user status', () => {
    const b = new RunBuilder();
    const app = AppStore.on(b.store);
    b.write(b.chain(posting(3), 'eligible', 75), true);
    projectRun(b.store, app, RUN, OPTS);
    app.setStatus(posting(3).jobKey, 'applied', 'user', AT);
    app.setNote(posting(3).jobKey, 'called back');

    // A second run on the same kernel DB, a week later.
    const run2 = 'daily-2026-10-16';
    const at2 = '2026-10-16T01:30:00.000Z';
    b.store.startRun(run2, 'daily@1', 'policy-hash', at2);
    b.store.appendEvent(run2, at2, 'run_started', {}, 'policy-hash');
    // Same (source, sourceId), so the same job key; the new title changes only the dedupe key.
    const retitled = posting(3, { title: 'Staff Backend Engineer' });
    expect(retitled.jobKey).toBe(posting(3).jobKey);
    expect(retitled.dedupeKey).not.toBe(posting(3).dedupeKey);
    const raw = b.input('RawPosting@1', {});
    const [post] = b.done('normalizer', raw, [{ type: 'Posting@1', payload: retitled }], run2) as [Envelope];
    const [ev] = b.done('eligibility', post, [{ type: 'EligibilityVerdict@1', payload: verdict(retitled, 'eligible') }], run2) as [Envelope];
    b.done('scorer-lexicon', ev, [{ type: 'Scored@1', payload: scored(retitled, 50) }], run2);

    expect(projectRun(b.store, app, run2, OPTS)).toMatchObject({ jobs: 1, inserted: 0 });
    expect(app.getJob(posting(3).jobKey)).toMatchObject({
      title: 'Staff Backend Engineer', score: 50, docsState: 'below-floor', docs: [], status: 'applied', note: 'called back', firstSeen: AT, lastSeen: at2,
    });
  });

  it('ignores steps of other runs and a step whose done outputs a tracker quarantined in this run', () => {
    const b = new RunBuilder();
    const app = AppStore.on(b.store);
    b.chain(posting(8), 'eligible', 70);
    const raw = b.input('RawPosting@1', {});
    const [post] = b.done('normalizer', raw, [{ type: 'Posting@1', payload: posting(9) }]) as [Envelope];
    b.store.appendEvent(RUN, AT, 'step_quarantined', { agent: 'normalizer', stepKey: post.stepKey, side: 'tracker', persisted: false, verdict: { id: 'G-TRACKER', verdict: 'trip' } }, 'policy-hash');
    b.done('normalizer', b.input('RawPosting@1', {}), [{ type: 'Posting@1', payload: posting(10) }], 'other-run');
    expect(projectRun(b.store, app, RUN, OPTS).jobs).toBe(1);
    expect(app.getJob(posting(8).jobKey)).toBeDefined();
    expect(app.getJob(posting(9).jobKey)).toBeUndefined();
    expect(app.getJob(posting(10).jobKey)).toBeUndefined();
  });

  it('keeps a feed listing of the same job as its own row, linked to the ATS row and hidden by default', () => {
    const b = new RunBuilder();
    const app = AppStore.on(b.store);
    b.write(b.chain(posting(11), 'eligible', 70), true);
    const dup = posting(11, { source: 'himalayas', sourceId: 'https://himalayas.example.test/j/11', ats: 'feed', descriptionText: 'shorter' });
    b.chain(dup, 'eligible', 65);
    expect(projectRun(b.store, app, RUN, OPTS)).toMatchObject({ jobs: 2, inserted: 2 });
    expect(app.getJob(posting(11).jobKey)).toMatchObject({ docsState: 'ready', jdText: 'JD 11', duplicateOf: null, alsoListedOn: ['himalayas'] });
    expect(app.getJob(dup.jobKey)).toMatchObject({ docsState: 'none', jdText: 'shorter', duplicateOf: posting(11).jobKey });
    expect(app.listJobs().map((j) => j.jobKey)).toEqual([posting(11).jobKey]);
  });

  it('keeps two same-title postings of one company and source as two jobs', () => {
    const b = new RunBuilder();
    const app = AppStore.on(b.store);
    const a = posting(12, { sourceId: '5001' });
    const c = posting(12, { sourceId: '5002' });
    expect(a.dedupeKey).toBe(c.dedupeKey);
    b.chain(a, 'eligible', 70);
    b.chain(c, 'eligible', 70);
    expect(projectRun(b.store, app, RUN, OPTS)).toMatchObject({ jobs: 2, inserted: 2 });
    expect(app.listJobs().map((j) => [j.jobKey, j.duplicateOf])).toEqual([a.jobKey, c.jobKey].sort().map((k) => [k, null]));
  });

  it('is idempotent: projecting the same run twice changes nothing', () => {
    const b = new RunBuilder();
    const app = AppStore.on(b.store);
    b.write(b.chain(posting(3), 'eligible', 75), true);
    projectRun(b.store, app, RUN, OPTS);
    const before = JSON.stringify(app.getJob(posting(3).jobKey));
    expect(projectRun(b.store, app, RUN, OPTS)).toMatchObject({ jobs: 1, inserted: 0 });
    expect(JSON.stringify(app.getJob(posting(3).jobKey))).toBe(before);
  });

  it('refuses an unknown run', () => {
    const b = new RunBuilder();
    expect(() => projectRun(b.store, AppStore.on(b.store), 'nope', OPTS)).toThrow(/unknown run/);
  });
});

describe('runCounts', () => {
  it('counts each agent by outcome, with gone, skipped, quarantined and failed, and the run totals', () => {
    const b = new RunBuilder();
    b.chain(posting(1), 'eligible', 70);
    const seed = b.input('DiscoveryRequest@1', {});
    b.failed('src-careers-job', b.input('CareerLink@1', { url: 'a' }), 'gone');
    b.failed('src-careers-job', b.input('CareerLink@1', { url: 'b' }), 'invalid_output');
    b.skipped('src-lever', seed);
    b.quarantinedOut('evidence-matcher', b.input('Scored@1', scored(posting(2), 70)), 'x');
    b.failed('renderer', b.input('CoverPlan@1', { jobKey: posting(3).jobKey, resume: { evidence: { scored: { posting: posting(3) } } } }), 'input_rejected', 'renderer: unrenderable-glyph:U+5C71 (in the posting title or company)');
    b.store.appendEvent(RUN, AT, 'step_replayed', { agent: 'normalizer', stepKey: 's', status: 'done' }, 'policy-hash');
    const c = runCounts(b.store, RUN);
    expect(c.byAgent['src-careers-job']).toEqual({ done: 0, failed: 2, gone: 1, inputRejected: 0, quarantined: 0, skipped: 0, pending: 0, replayed: 0 });
    expect(c.byAgent['src-lever']).toEqual({ done: 0, failed: 0, gone: 0, inputRejected: 0, quarantined: 0, skipped: 1, pending: 0, replayed: 0 });
    expect(c.byAgent['renderer']).toMatchObject({ failed: 1, inputRejected: 1 });
    expect(c.byAgent['evidence-matcher']).toMatchObject({ quarantined: 1 });
    expect(c.byAgent['normalizer']).toMatchObject({ done: 1, replayed: 1 });
    expect(c.totals).toEqual({ done: 3, failed: 3, gone: 1, inputRejected: 1, quarantined: 1, skipped: 1, pending: 0, replayed: 1 });
    // review I1: every one of them is named, with its item and reason
    expect(runProblems(b.store, RUN, { forbiddenTerms: ['Initech'] }).map((p) => `${p.kind} ${p.agent} | ${p.item} | ${p.reason}`)).toEqual([
      `input_rejected renderer | ${posting(3).company} — ${posting(3).title} (job ${posting(3).jobKey}) | input_rejected: renderer: unrenderable-glyph:U+5C71 (in the posting title or company)`,
      'failed src-careers-job | ? (careers:?) b | invalid_output: x',
      'gone src-careers-job | ? (careers:?) a | gone: x',
      'skipped src-lever | ? (?:?) | skipped: a breaker was open after earlier failures',
      `quarantined evidence-matcher | ${posting(2).company} — ${posting(2).title} (job ${posting(2).jobKey}) | G-GROUND: x`,
    ]);
    expect(Object.keys(c.byAgent)).toEqual([...Object.keys(c.byAgent)].sort());
  });
});

describe('projector: documents on disk (Task 10 fix round 1, replay safety)', () => {
  it('marks a QA-passed job missing unless every listed file is on disk with its recorded sha256', () => {
    const run = (check: (p: string, sha: string) => 'ok' | 'absent' | 'changed') => {
      const b = new RunBuilder();
      b.write(b.chain(posting(3), 'eligible', 80), true);
      const app = AppStore.on(b.store);
      const r = projectRun(b.store, app, RUN, { ...OPTS, docOnDisk: check });
      return { r, job: app.getJob(posting(3).jobKey) };
    };
    expect(run(() => 'ok').job).toMatchObject({ docsState: 'ready', docsDetail: null });
    const gone = run((p) => (p.endsWith('resume.pdf') ? 'absent' : p.endsWith('cover.pdf') ? 'changed' : 'ok'));
    expect(gone.r.docs).toMatchObject({ missing: 1, ready: 0 });
    expect(gone.job).toMatchObject({ docsState: 'missing' });
    expect(gone.job?.docsDetail).toBe(`documents missing: ${posting(3).jobKey}/resume.pdf is not on disk; ${posting(3).jobKey}/cover.pdf changed on disk`);
    expect(gone.job?.docs).toHaveLength(3);
  });

  it('does not check a QA-failed job (it is blocked whatever is on disk)', () => {
    const b = new RunBuilder();
    b.write(b.chain(posting(4), 'eligible', 80), false);
    const app = AppStore.on(b.store);
    projectRun(b.store, app, RUN, { ...OPTS, docOnDisk: () => 'absent' });
    expect(app.getJob(posting(4).jobKey)).toMatchObject({ docsState: 'blocked' });
  });

  it('diskDocCheck: present with the sha, changed, absent, outside the root or a symlink', () => {
    const out = mkdtempSync(join(tmpdir(), 'jobpilot-docs-'));
    mkdirSync(join(out, 'k'));
    writeFileSync(join(out, 'k', 'resume.pdf'), 'PDF');
    const sha = createHash('sha256').update('PDF').digest('hex');
    const check = diskDocCheck(out);
    expect(check('k/resume.pdf', sha)).toBe('ok');
    expect(check('k/resume.pdf', 'f'.repeat(64))).toBe('changed');
    expect(check('k/cover.pdf', sha)).toBe('absent');
    expect(check('../x.pdf', sha)).toBe('absent');
    symlinkSync(join(out, 'k', 'resume.pdf'), join(out, 'k', 'link.pdf'));
    expect(check('k/link.pdf', sha)).toBe('absent');
  });

  it('shows a named reason of a failed writing step and blocks the documents; free text is never shown', () => {
    const b = new RunBuilder();
    const sc = b.chain(posting(8), 'eligible', 80);
    b.failed('renderer', sc, 'invalid_output', 'renderer: unrenderable-glyph:U+30A2 (the resume has a character the embedded font cannot draw)');
    const sc2 = b.chain(posting(9), 'eligible', 80);
    b.failed('renderer', sc2, 'invalid_output', 'renderer: something private happened');
    const app = AppStore.on(b.store);
    projectRun(b.store, app, RUN, OPTS);
    expect(app.getJob(posting(8).jobKey)).toMatchObject({ docsState: 'blocked', docsDetail: 'renderer failed: invalid_output (unrenderable-glyph:U+30A2)' });
    expect(app.getJob(posting(9).jobKey)).toMatchObject({ docsState: 'none', docsDetail: 'renderer failed: invalid_output' });
  });
});
