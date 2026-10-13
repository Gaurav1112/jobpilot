import { describe, expect, it } from 'vitest';
import { coverageNotification, deferralLine, projectCoverage } from '../../../src/app/coverage/project.js';
import type { CareersSite, CompanyCandidate, CompanyVerdict, PlatformGuess } from '../../../src/app/coverage/types.js';
import { HOST_DISABLED_MARK, runProblems } from '../../../src/app/problems.js';
import { HOST_DISABLED } from '../../../src/app/coverage/gate.js';
import { AppStore } from '../../../src/app/store/app-store.js';
import { runsBody } from '../../../src/app/web/views/runs.js';
import { Store } from '../../../src/kernel/store/store.js';

const W1 = '2026-10-11T01:30:00.000Z';
const W2 = '2026-10-18T01:30:00.000Z';
const W3 = '2026-10-25T01:30:00.000Z';
const W4 = '2026-11-01T01:30:00.000Z';
const W1_LATER = '2026-10-14T04:30:00.000Z';

const cand = (key: string, source: CompanyCandidate['source'] = 'yc'): CompanyCandidate => ({ companyKey: key, name: key.split('.')[0] ?? key, website: `https://${key}`, careersUrl: null, source, runDate: '2026-10-11' });
const site = (c: CompanyCandidate, located = true): CareersSite =>
  located ? { candidate: c, careersUrl: `https://${c.companyKey}/careers`, method: 'path', evidence: 'GET /careers 200' } : { candidate: c, careersUrl: null, method: 'none', evidence: null, reasons: ['homepage: 404'] };
const guess = (c: CompanyCandidate): PlatformGuess => ({ site: site(c), platform: 'greenhouse', slug: c.name, boardUrl: null, signature: 'greenhouse:a', routedFrom: null, evidence: [`detected: greenhouse ${c.name}`] });
const verdict = (c: CompanyCandidate, status: CompanyVerdict['status']): CompanyVerdict => ({ guess: guess(c), status, reasons: [status], boardName: status === 'failed' ? null : c.name, jobsSeen: status === 'failed' ? null : 3 });

const open = (): AppStore => AppStore.on(Store.open(':memory:'));
const row = (app: AppStore, key: string) => app.listCompanies().find((r) => r.companyKey === key);

describe('projectCoverage: the registry transitions', () => {
  it('verified sets last_verified and fail_weeks 0, counted as new once', () => {
    const app = open();
    const a = cand('acme.test');
    const p1 = projectCoverage(app, { verdicts: [verdict(a, 'verified')], unlocated: [], at: W1, countFailures: true });
    expect(p1).toMatchObject({ newVerified: 1, registry: { verified: 1, proposed: 0, failing: 0 } });
    expect(row(app, 'acme.test')).toMatchObject({ status: 'verified', lastVerified: W1, failWeeks: 0 });
    const p2 = projectCoverage(app, { verdicts: [verdict(a, 'verified')], unlocated: [], at: W2, countFailures: true });
    expect(p2.newVerified).toBe(0);
    expect(row(app, 'acme.test')).toMatchObject({ lastVerified: W2 });
  });

  it('a failed verdict on a verified company adds a fail week; the third makes it failing; a verified one recovers it', () => {
    const app = open();
    const a = cand('acme.test');
    projectCoverage(app, { verdicts: [verdict(a, 'verified')], unlocated: [], at: W1, countFailures: true });
    projectCoverage(app, { verdicts: [verdict(a, 'failed')], unlocated: [], at: W2, countFailures: true });
    expect(row(app, 'acme.test')).toMatchObject({ status: 'verified', failWeeks: 1, failingSince: W2 });
    projectCoverage(app, { verdicts: [verdict(a, 'failed')], unlocated: [], at: W3, countFailures: true });
    expect(row(app, 'acme.test')).toMatchObject({ status: 'verified', failWeeks: 2 });
    const p = projectCoverage(app, { verdicts: [verdict(a, 'failed')], unlocated: [], at: W4, countFailures: true });
    expect(row(app, 'acme.test')).toMatchObject({ status: 'failing', failWeeks: 3, failingSince: W2 });
    expect(p.registry).toMatchObject({ verified: 0, failing: 1 });
    projectCoverage(app, { verdicts: [verdict(a, 'verified')], unlocated: [], at: '2026-11-08T01:30:00.000Z', countFailures: true });
    expect(row(app, 'acme.test')).toMatchObject({ status: 'verified', failWeeks: 0, failingSince: null });
  });

  it('a second run in the same coverage week does not count the week\'s failure twice', () => {
    const app = open();
    const a = cand('acme.test');
    projectCoverage(app, { verdicts: [verdict(a, 'verified')], unlocated: [], at: W1, countFailures: true });
    projectCoverage(app, { verdicts: [verdict(a, 'failed')], unlocated: [], at: W2, countFailures: true });
    projectCoverage(app, { verdicts: [verdict(a, 'failed')], unlocated: [], at: '2026-10-19T01:30:00.000Z', countFailures: false });
    expect(row(app, 'acme.test')).toMatchObject({ status: 'verified', failWeeks: 1 });
  });

  it('user overrides win: rejected stays rejected through a verified verdict; approved promotes a proposed one', () => {
    const app = open();
    const a = cand('acme.test');
    const b = cand('beta.test');
    projectCoverage(app, { verdicts: [verdict(a, 'verified'), verdict(b, 'proposed')], unlocated: [], at: W1, countFailures: true });
    app.setCompanyOverride('acme.test', 'rejected', W1_LATER);
    app.setCompanyOverride('beta.test', 'approved', W1_LATER);
    const p = projectCoverage(app, { verdicts: [verdict(a, 'verified'), verdict(b, 'proposed')], unlocated: [], at: W2, countFailures: true });
    expect(row(app, 'acme.test')).toMatchObject({ status: 'rejected', userOverride: 'rejected' });
    expect(row(app, 'beta.test')).toMatchObject({ status: 'verified', userOverride: 'approved' });
    expect(p.newVerified).toBe(0);
    expect(app.verifiedCompanies().map((c) => c.companyKey)).toEqual(['beta.test']);
  });

  it('not located: a pick is proposed, a live company fails a week, any other candidate is only counted', () => {
    const app = open();
    const live = cand('live.test');
    projectCoverage(app, { verdicts: [verdict(live, 'verified')], unlocated: [], at: W1, countFailures: true });
    const pick = cand('mine.test', 'pick');
    const other = cand('other.test');
    const p = projectCoverage(app, { verdicts: [], unlocated: [site(pick, false), site(live, false), site(other, false)], at: W2, countFailures: true });
    expect(row(app, 'mine.test')).toMatchObject({ status: 'proposed', source: 'pick', careersUrl: null });
    expect(row(app, 'mine.test')?.reasons.join('\n')).toMatch(/careers site not located: homepage: 404/);
    expect(row(app, 'live.test')).toMatchObject({ status: 'verified', failWeeks: 1 });
    expect(row(app, 'other.test')).toBeUndefined();
    expect(p).toMatchObject({ unlocated: { proposed: 1, failed: 1, counted: 1 } });
  });
});

describe('the weekly coverage line', () => {
  it('reads exactly "Coverage: N verified (+k new) · p proposed · f failing"', () => {
    expect(coverageNotification({ verified: 12, newVerified: 3, proposed: 40, failing: 1 }, null)).toBe('Coverage: 12 verified (+3 new) · 40 proposed · 1 failing');
    expect(coverageNotification({ verified: 0, newVerified: 0, proposed: 0, failing: 0 }, null)).toBe('Coverage: 0 verified (+0 new) · 0 proposed · 0 failing');
  });

  it('adds the deferral line when steps were deferred by a disabled host, naming each host once', () => {
    expect(deferralLine(0, [['a.test', 'http-429']])).toBeNull();
    const line = deferralLine(4, [['www.acme.test', 'http-429'], ['jobs.beta.test', 'challenge']]);
    expect(line).toBe('not located this week: 4, host-disabled jobs.beta.test (challenge), www.acme.test (http-429)');
    expect(coverageNotification({ verified: 1, newVerified: 1, proposed: 0, failing: 0 }, line)).toBe('Coverage: 1 verified (+1 new) · 0 proposed · 0 failing · not located this week: 4, host-disabled jobs.beta.test (challenge), www.acme.test (http-429)');
    const many = deferralLine(9, Array.from({ length: 8 }, (_, i) => [`h${i}.test`, 'http-403'] as [string, string]));
    expect(many).toBe('not located this week: 9, host-disabled h0.test (http-403), h1.test (http-403), h2.test (http-403), h3.test (http-403), h4.test (http-403) and 3 more hosts');
  });
});

describe('deferrals on the dashboard (carry 10)', () => {
  it('the problems module and the gate agree on the host-disabled marker', () => expect(HOST_DISABLED_MARK).toBe(HOST_DISABLED));

  it('runProblems names a host-disabled refusal "deferred", not input_rejected; the runs view says "Deferred: host disabled (<why>)"', () => {
    const kernel = Store.open(':memory:');
    kernel.startRun('r1', 'jobpilot-coverage/locate@1.0.0', 'p', W1);
    const env = { envelopeId: 'e1', stepKey: 's1', index: 0, type: 'CompanyCandidate@1', producer: { agentId: 'supervisor', version: '1.0.0', contractHash: 'h' }, parents: [], payload: cand('acme.test'), handoff: { guarantees: [], dataClass: 'P0' as const, obligations: [], pins: {} }, guardrails: [], cost: { usd: 0, inputTokens: 0, outputTokens: 0 } };
    kernel.putSeed('s1', env as never, '1.0.0', 'h');
    kernel.enqueue('r1', 1, 'careers-locator', 'e1');
    kernel.markQueue('r1', 'careers-locator', 'e1', 'failed');
    kernel.appendEvent('r1', W1, 'step_failed', { agent: 'careers-locator', stepKey: 's2', envelopeId: 'e1', error: 'input_rejected', detail: 'skipped by run state set by another candidate (/careers: host-disabled:http-429)' }, 'p');
    const problems = runProblems(kernel, 'r1', { forbiddenTerms: [] });
    expect(problems).toEqual([{ kind: 'deferred', agent: 'careers-locator', item: 'acme (acme.test)', reason: 'input_rejected: skipped by run state set by another candidate (/careers: host-disabled:http-429)' }]);
    const html = String(runsBody({ runs: [{ runId: 'coverage-2026-10-11', at: W1, counts: { byAgent: { 'careers-locator': { done: 0, failed: 1, deferred: 1, inputRejected: 0 } }, totals: { done: 0, failed: 1, deferred: 1, inputRejected: 0 } }, packHash: 'x', policyHash: 'y', problems }], chain: { ok: true, events: 1 }, istTime: (s) => s }));
    expect(html).toContain('Deferred: host disabled (http-429)');
    expect(html).not.toContain('Input rejected</span>');
    expect(html).toContain('>Deferred</th>');
  });

  it('a daily run\'s counts table is unchanged: no Deferred column when no run counts deferrals', () => {
    const html = String(runsBody({ runs: [{ runId: 'daily-2026-10-11', at: W1, counts: { byAgent: { 'src-lever': { done: 1, inputRejected: 0 } }, totals: { done: 1, inputRejected: 0 } }, packHash: 'x', policyHash: 'y', problems: [] }], chain: { ok: true, events: 1 }, istTime: (s) => s }));
    expect(html).not.toContain('Deferred');
    expect(html).toContain('Input rejected');
  });
});
