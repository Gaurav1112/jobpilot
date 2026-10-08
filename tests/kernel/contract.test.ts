import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contractHash, contractMajor, defineContract, type ContractSpec } from '../../src/kernel/contract.js';
import { definePredicate } from '../../src/kernel/predicates.js';
import { defineType } from '../../src/kernel/types.js';

const In = defineType('ThingIn', 1, z.object({ n: z.number() }).strict());
const Out = defineType('ThingOut', 1, z.object({ n: z.number() }).strict());

const base: ContractSpec<{ n: number }, { n: number }> = {
  id: 'thing-doubler',
  version: '1.0.0',
  description: 'Doubles a number deterministically',
  skills: ['doubling'],
  team: 'demo',
  kind: 'deterministic',
  consumes: In,
  produces: Out,
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 1000,
};

describe('defineContract', () => {
  it('fills defaults and freezes the contract', () => {
    const c = defineContract(base);
    expect(c.retry).toEqual({ max: 0, on: [], backoffMs: [] });
    expect(c.breaker.consecutiveFailures).toBe(5);
    expect(Object.isFrozen(c)).toBe(true);
    expect(contractMajor(c)).toBe('1');
  });

  it('rejects a description containing "and": one agent, one skill', () => {
    expect(() => defineContract({ ...base, description: 'Parses and scores a posting' })).toThrow(/split it/);
  });

  it('rejects non-semver versions and non-kebab ids', () => {
    expect(() => defineContract({ ...base, version: '1.0' })).toThrow(/semver/);
    expect(() => defineContract({ ...base, id: 'Thing_Doubler' })).toThrow(/kebab-case/);
  });

  it('only lets retryable codes into retry.on, with one backoff per retry', () => {
    expect(() => defineContract({ ...base, retry: { max: 1, on: ['invalid_output'], backoffMs: [10] } })).toThrow(/retryable/);
    expect(() => defineContract({ ...base, retry: { max: 2, on: ['timeout'], backoffMs: [10] } })).toThrow(/one entry per retry/);
  });

  it('ties capabilities to kind', () => {
    expect(() => defineContract({ ...base, capabilities: { llm: { model: 'm', maxTokens: 10 } } })).toThrow(/may not request capabilities.llm/);
    expect(() => defineContract({ ...base, kind: 'llm', budget: { usdPerCall: 0.01, usdPerRun: 1 } })).toThrow(/requires capabilities.llm/);
    expect(() => defineContract({ ...base, capabilities: { http: true } })).toThrow(/may not request capabilities.http/);
    expect(() => defineContract({ ...base, egress: ['example.com'] })).toThrow(/may not declare egress/);
  });

  it('changes its hash when the produced schema changes', () => {
    const a = defineContract(base);
    const Out2 = defineType('ThingOut', 1, z.object({ n: z.number(), extra: z.string() }).strict());
    const b = defineContract({ ...base, produces: Out2 });
    expect(contractHash(a)).not.toBe(contractHash(b));
    expect(contractHash(a)).toBe(contractHash(defineContract(base)));
  });

  it('changes its hash when a guarantee is added', () => {
    const g = definePredicate<{ n: number }>('n.even', 'n is even', (p) => p.n % 2 === 0);
    expect(contractHash(defineContract({ ...base, guarantees: [g] }))).not.toBe(contractHash(defineContract(base)));
  });
});
