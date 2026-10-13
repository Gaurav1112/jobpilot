import { describe, expect, it } from 'vitest';
import { memoryHostStateStore, makeRunGate } from '../../../src/app/coverage/gate.js';
import { compileCoverage, COVERAGE_MIN_HOST_INTERVAL_MS, coveragePolicy, coveragePolicyHash, coverageSeeds, deniedWebsites, selectCandidates, STAGES } from '../../../src/app/coverage/pipeline.js';
import type { CompanyCandidate } from '../../../src/app/coverage/types.js';
import { mergePolicy, policyHash, PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';

const cand = (key: string, source: CompanyCandidate['source'] = 'yc', website = `https://${key}`): CompanyCandidate => ({ companyKey: key, name: key, website, careersUrl: null, source, runDate: '2026-10-11' });

describe('coverage pipeline helpers', () => {
  it('the policy raises minHostIntervalMs to at least 2 s, never lowers a stricter user value, and hashes apart from the daily one', () => {
    expect(coveragePolicy({ policyUser: {} }).minHostIntervalMs).toBe(COVERAGE_MIN_HOST_INTERVAL_MS);
    expect(coveragePolicy({ policyUser: { minHostIntervalMs: 5000 } }).minHostIntervalMs).toBe(5000);
    expect(coveragePolicyHash({ policyUser: {} })).toBe(policyHash(coveragePolicy({ policyUser: {} })));
    expect(coveragePolicyHash({ policyUser: {} })).not.toBe(policyHash(mergePolicy(PRODUCT_POLICY_V1, {})));
  });

  it('--limit keeps every pick plus the first N others, in the merged (companyKey) order', () => {
    const merged = [cand('a.test'), cand('b.test', 'pick'), cand('c.test'), cand('d.test'), cand('z.test', 'pick')];
    expect(selectCandidates(merged, 2).map((c) => c.companyKey)).toEqual(['a.test', 'b.test', 'c.test', 'z.test']);
    expect(selectCandidates(merged, 0).map((c) => c.companyKey)).toEqual(['b.test', 'z.test']);
    expect(selectCandidates(merged)).toHaveLength(5);
  });

  it('a website on a policy-denied host (a job-board profile) is left out with a note, never sent to the locator', () => {
    const { kept, notes } = deniedWebsites([cand('acme.test'), cand('linkedin.com', 'yc', 'https://www.linkedin.com/company/acme'), cand('x.test', 'yc', 'https://in.indeed.com/cmp/x')], PRODUCT_POLICY_V1);
    expect(kept.map((c) => c.companyKey)).toEqual(['acme.test']);
    expect(notes).toEqual(['linkedin.com (linkedin.com): www.linkedin.com is a host the policy denies; not located', 'x.test (x.test): in.indeed.com is a host the policy denies; not located']);
  });

  it('every stage compiles through the allow-list with one team per agent, its contract\'s own', () => {
    const compiled = compileCoverage(makeRunGate({ runKey: 't', store: memoryHostStateStore() }));
    const teams = STAGES.map((s) => [...compiled[s].compiled.teamOf.values()].map((t) => t.id));
    expect(teams).toEqual([['coverage-seed'], ['coverage-locator'], ['coverage-detector'], ['coverage-verifier']]);
    expect(STAGES.map((s) => compiled[s].agent.contract.id)).toEqual(['company-seed', 'careers-locator', 'platform-detector', 'board-verifier']);
  });

  it('the seeds carry the coverage week, so a second run in the week has the same step keys', () => {
    expect(coverageSeeds('2026-10-11', [{ name: 'Acme' }], [])).toEqual([
      { runDate: '2026-10-11', source: 'picks', items: [{ name: 'Acme' }] },
      { runDate: '2026-10-11', source: 'remoteintech' },
      { runDate: '2026-10-11', source: 'yc' },
      { runDate: '2026-10-11', source: 'jobs', items: [] },
    ]);
  });
});
