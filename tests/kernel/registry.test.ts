import { describe, expect, it } from 'vitest';
import { contractHash } from '../../src/kernel/contract.js';
import { Registry } from '../../src/kernel/registry.js';
import { demoSource } from '../../src/demo/agents.js';

describe('Registry.rememberVersion', () => {
  it('accepts past versions of the same major only, for registered agents only, and never overrides the current hash', () => {
    const r = new Registry();
    r.register(demoSource);
    const current = contractHash(demoSource.contract);
    r.rememberVersion('demo-source', '1.0.0', 'stale-hash');
    r.rememberVersion('demo-source', '1.2.0', 'h12');
    r.rememberVersion('demo-source', '2.0.0', 'h2');
    r.rememberVersion('nobody', '1.0.0', 'hn');
    expect(r.contractHashOf('demo-source', '1.0.0')).toBe(current);
    expect(r.contractHashOf('demo-source', '1.2.0')).toBe('h12');
    expect(r.contractHashOf('demo-source', '2.0.0')).toBeUndefined();
    expect(r.contractHashOf('nobody', '1.0.0')).toBeUndefined();
  });
});
