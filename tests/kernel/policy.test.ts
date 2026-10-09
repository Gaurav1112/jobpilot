import { describe, expect, it } from 'vitest';
import { PolicyViolation } from '../../src/kernel/errors.js';
import { PRODUCT_POLICY_V1, egressAllowed, hostMatches, mergePolicy, normalizeHost, policyHash } from '../../src/kernel/policy.js';

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
      const v = (e as PolicyViolation).violations;
      expect(v).toHaveLength(4);
      for (const key of ['maxUsdPerRun', 'maxSubmitsPerDay', 'requireApprovalForEffects', 'egressClasses.api.anthropic.com']) {
        expect(v.some((m) => m.includes(key))).toBe(true);
      }
    }
  });

  it('rejects unknown keys in the user file', () => {
    expect(() => mergePolicy(PRODUCT_POLICY_V1, { maxUsdPerDay: 1 })).toThrow(PolicyViolation);
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

describe('policy hardening', () => {
  it('normalizeHost lower-cases and strips trailing dots', () => {
    expect(normalizeHost('Tracker.Example.')).toBe('tracker.example');
    expect(hostMatches('CDN.Tracker.Example.', 'tracker.example')).toBe(true);
  });

  it('matches the deny list regardless of case or trailing dot', () => {
    const p = mergePolicy(PRODUCT_POLICY_V1, { deniedEgressHosts: ['tracker.example'] });
    for (const h of ['Tracker.Example', 'tracker.example.', 'CDN.tracker.example']) {
      expect(egressAllowed(p, h, 'P0')).toBe(false);
    }
  });

  it('normalises user host entries before merging', () => {
    const p = mergePolicy(PRODUCT_POLICY_V1, { deniedEgressHosts: ['Tracker.Example.'] });
    expect(p.deniedEgressHosts).toEqual(['glassdoor.com', 'indeed.com', 'linkedin.com', 'naukri.com', 'tracker.example']);
  });

  it('survives prototype-named hosts', () => {
    const p = mergePolicy(PRODUCT_POLICY_V1, {});
    for (const h of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(egressAllowed(p, h, 'P1')).toBe(false);
      expect(egressAllowed(p, h, 'P0')).toBe(true);
    }
  });

  it('rejects __proto__ and malformed host keys', () => {
    expect(() => mergePolicy(PRODUCT_POLICY_V1, JSON.parse('{"egressClasses":{"__proto__":["P0"]}}'))).toThrow(PolicyViolation);
    expect(() => mergePolicy(PRODUCT_POLICY_V1, { deniedEgressHosts: ['a b'] })).toThrow(PolicyViolation);
    expect(() => mergePolicy(PRODUCT_POLICY_V1, { deniedSubmitHosts: ['x/y'] })).toThrow(PolicyViolation);
    expect(() => mergePolicy(PRODUCT_POLICY_V1, { egressClasses: { 'a_b': ['P0'] } })).toThrow(PolicyViolation);
  });

  it('stores a user egress key named constructor as an own entry and uses it', () => {
    const p = mergePolicy(PRODUCT_POLICY_V1, { egressClasses: { constructor: [] } });
    expect(Object.hasOwn(p.egressClasses, 'constructor')).toBe(true);
    expect(egressAllowed(p, 'constructor', 'P0')).toBe(false);
    expect(egressAllowed(p, 'toString', 'P0')).toBe(true);
  });

  it('reports schema failures as PolicyViolation with path: message', () => {
    try {
      mergePolicy(PRODUCT_POLICY_V1, { maxUsdPerRun: 'x' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyViolation);
      expect((e as PolicyViolation).violations[0]).toMatch(/^maxUsdPerRun: /);
    }
  });

  it('is deeply frozen', () => {
    const merged = mergePolicy(PRODUCT_POLICY_V1, { deniedSubmitHosts: ['foundit.in'] });
    expect(() => (PRODUCT_POLICY_V1.deniedSubmitHosts as string[]).push('x.com')).toThrow(TypeError);
    expect(() => (merged.egressClasses['api.anthropic.com'] as string[]).push('P1')).toThrow(TypeError);
    expect(() => ((merged.egressClasses as Record<string, unknown>)['new.host'] = [])).toThrow(TypeError);
    expect(merged.egressClasses['api.anthropic.com']).not.toBe(PRODUCT_POLICY_V1.egressClasses['api.anthropic.com']);
    expect(merged.defaultEgressClasses).not.toBe(PRODUCT_POLICY_V1.defaultEgressClasses);
  });

  it('lets a user tighten a host to nothing', () => {
    const p = mergePolicy(PRODUCT_POLICY_V1, { egressClasses: { 'api.anthropic.com': [] } });
    expect(egressAllowed(p, 'api.anthropic.com', 'P0')).toBe(false);
  });

  it('hashes identically for order, case and duplicate differences', () => {
    const a = mergePolicy(PRODUCT_POLICY_V1, { deniedEgressHosts: ['a.example', 'b.example'] });
    const b = mergePolicy(PRODUCT_POLICY_V1, { deniedEgressHosts: ['B.Example.', 'a.example', 'A.EXAMPLE', 'b.example'] });
    expect(policyHash(a)).toBe(policyHash(b));
  });
});

describe('redactors (agents allowed to lower a data class)', () => {
  it('the product policy allows none, and a user policy may not add one', () => {
    expect(PRODUCT_POLICY_V1.redactors).toEqual([]);
    expect(mergePolicy(PRODUCT_POLICY_V1, { redactors: [] }).redactors).toEqual([]);
    expect(() => mergePolicy(PRODUCT_POLICY_V1, { redactors: ['pii-scrubber'] })).toThrow(/redactors may not add pii-scrubber/);
  });

  it('a user policy may keep a subset of what the product allows', () => {
    const product = { ...PRODUCT_POLICY_V1, redactors: ['a-scrubber', 'b-scrubber'] };
    expect(mergePolicy(product, { redactors: ['b-scrubber'] }).redactors).toEqual(['b-scrubber']);
    expect(mergePolicy(product, {}).redactors).toEqual(['a-scrubber', 'b-scrubber']);
  });
});

describe('v1 kernel extensions: HTTP policy caps', () => {
  it('ships maxResponseBytes 16 MiB and minHostIntervalMs 1000 in the product policy', () => {
    expect(PRODUCT_POLICY_V1.maxResponseBytes).toBe(16_777_216);
    expect(PRODUCT_POLICY_V1.minHostIntervalMs).toBe(1000);
  });

  it('lets a user lower maxResponseBytes and raise minHostIntervalMs', () => {
    const p = mergePolicy(PRODUCT_POLICY_V1, { maxResponseBytes: 1_000_000, minHostIntervalMs: 2500 });
    expect(p.maxResponseBytes).toBe(1_000_000);
    expect(p.minHostIntervalMs).toBe(2500);
  });

  it('refuses a user policy that raises maxResponseBytes or lowers minHostIntervalMs', () => {
    try {
      mergePolicy(PRODUCT_POLICY_V1, { maxResponseBytes: 20_000_000, minHostIntervalMs: 10 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyViolation);
      const v = (e as PolicyViolation).violations;
      expect(v).toHaveLength(2);
      expect(v.some((m) => m.includes('maxResponseBytes'))).toBe(true);
      expect(v.some((m) => m.includes('minHostIntervalMs'))).toBe(true);
    }
  });
});
