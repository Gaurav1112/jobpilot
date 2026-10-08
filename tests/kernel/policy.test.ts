import { describe, expect, it } from 'vitest';
import { PolicyViolation } from '../../src/kernel/errors.js';
import { PRODUCT_POLICY_V1, egressAllowed, mergePolicy, policyHash } from '../../src/kernel/policy.js';

describe('mergePolicy (G-POLICY-MONOTONIC)', () => {
  it('lets a user tighten caps and add denied hosts', () => {
    const p = mergePolicy(PRODUCT_POLICY_V1, { maxUsdPerRun: 2, maxSubmitsPerDay: 3, deniedSubmitHosts: ['foundit.in'] });
    expect(p.maxUsdPerRun).toBe(2);
    expect(p.maxSubmitsPerDay).toBe(3);
    expect(p.deniedSubmitHosts).toEqual(['foundit.in', 'indeed.com', 'linkedin.com', 'naukri.com']);
  });

  it('refuses every attempt to loosen, listing all of them', () => {
    try {
      mergePolicy(PRODUCT_POLICY_V1, {
        maxUsdPerRun: 50,
        maxSubmitsPerDay: 100,
        requireApprovalForEffects: false,
        egressClasses: { 'api.anthropic.com': ['P0', 'P1'] },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyViolation);
      expect((e as PolicyViolation).violations).toHaveLength(4);
    }
  });

  it('rejects unknown keys in the user file', () => {
    expect(() => mergePolicy(PRODUCT_POLICY_V1, { maxUsdPerDay: 1 })).toThrow();
  });

  it('hashes differently once a user tightens anything', () => {
    expect(policyHash(mergePolicy(PRODUCT_POLICY_V1, {}))).not.toBe(policyHash(mergePolicy(PRODUCT_POLICY_V1, { maxUsdPerRun: 1 })));
  });
});

describe('egressAllowed (G-PII-EGRESS)', () => {
  const p = mergePolicy(PRODUCT_POLICY_V1, { deniedEgressHosts: ['tracker.example'] });

  it('allows public data to an allowed host', () => {
    expect(egressAllowed(p, 'api.anthropic.com', 'P0')).toBe(true);
  });

  it('never lets contact PII reach the model provider', () => {
    expect(egressAllowed(p, 'api.anthropic.com', 'P1')).toBe(false);
  });

  it('blocks denied hosts and their subdomains', () => {
    expect(egressAllowed(p, 'tracker.example', 'P0')).toBe(false);
    expect(egressAllowed(p, 'cdn.tracker.example', 'P0')).toBe(false);
  });
});
