import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contractHash, contractMajor, contractShape, defineContract, type ContractSpec } from '../../src/kernel/contract.js';
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

  it('changes its hash when budget, guardrails or retry change', () => {
    const h = contractHash(defineContract(base));
    expect(contractHash(defineContract({ ...base, kind: 'io', capabilities: { http: true }, egress: ['example.com'], budget: { usdPerCall: 0, usdPerRun: 1 } }))).not.toBe(h);
    const io: ContractSpec<{ n: number }, { n: number }> = { ...base, kind: 'io', capabilities: { http: true }, egress: ['example.com'] };
    const ioHash = contractHash(defineContract(io));
    expect(contractHash(defineContract({ ...io, budget: { usdPerCall: 0.1, usdPerRun: 1 } }))).not.toBe(ioHash);
    expect(contractHash(defineContract({ ...io, guardrails: { in: ['G-PII'], out: [] } }))).not.toBe(ioHash);
    expect(contractHash(defineContract({ ...io, retry: { max: 1, on: ['timeout'], backoffMs: [10] } }))).not.toBe(ioHash);
    expect(contractHash(defineContract({ ...io, timeoutMs: 2000 }))).not.toBe(ioHash);
    expect(contractHash(defineContract({ ...io, breaker: { consecutiveFailures: 2 } }))).not.toBe(ioHash);
  });

  it('does not change its hash when obligations.adds are reordered', () => {
    const a = defineContract({ ...base, obligations: { adds: [{ id: 'a.one', dischargedBy: 'x-agent' }, { id: 'b.two', dischargedBy: 'y-agent' }], discharges: [] } });
    const b = defineContract({ ...base, obligations: { adds: [{ id: 'b.two', dischargedBy: 'y-agent' }, { id: 'a.one', dischargedBy: 'x-agent' }], discharges: [] } });
    expect(contractHash(a)).toBe(contractHash(b));
  });

  it('deep-freezes nested structures', () => {
    const c = defineContract({
      ...base,
      kind: 'llm',
      capabilities: { llm: { model: 'm', maxTokens: 10 } },
      egress: ['api.anthropic.com'],
      budget: { usdPerCall: 0.01, usdPerRun: 1 },
      obligations: { adds: [{ id: 'a.one', dischargedBy: 'x-agent' }], discharges: [] },
    });
    expect(() => (c.egress as string[]).push('x')).toThrow(TypeError);
    expect(() => {
      (c.capabilities as any).llm = { model: 'z', maxTokens: 1 };
    }).toThrow(TypeError);
    expect(() => {
      (c.capabilities.llm as any).model = 'z';
    }).toThrow(TypeError);
    expect(() => (c.dataClasses.in as string[]).push('P1')).toThrow(TypeError);
    expect(() => {
      (c.obligations.adds[0] as any).id = 'zzz';
    }).toThrow(TypeError);
    expect(() => {
      (c.budget as any).usdPerRun = 99;
    }).toThrow(TypeError);
    expect(() => (c.retry.on as string[]).push('timeout')).toThrow(TypeError);
    expect(() => (c.guardrails.in as string[]).push('G-X')).toThrow(TypeError);
    expect(() => (c.requires as unknown[]).push(1)).toThrow(TypeError);
  });

  it('does not alias the caller spec', () => {
    const egress = ['example.com'];
    const classes: ('P0' | 'P1')[] = ['P0'];
    const spec: ContractSpec<{ n: number }, { n: number }> = {
      ...base,
      kind: 'io',
      capabilities: { http: true },
      egress,
      dataClasses: { in: classes, out: ['P0'] },
    };
    const c = defineContract(spec);
    const before = contractHash(c);
    egress.push('evil.com');
    classes.push('P1');
    expect(c.egress).toEqual(['example.com']);
    expect(c.dataClasses.in).toEqual(['P0']);
    expect(contractHash(c)).toBe(before);
  });

  it('requires egress for http and http or llm for egress', () => {
    expect(() => defineContract({ ...base, kind: 'io', capabilities: { http: true } })).toThrow(/capabilities.http requires at least one egress host/);
    expect(() => defineContract({ ...base, kind: 'io', egress: ['example.com'] })).toThrow(/egress requires capabilities.http or capabilities.llm/);
  });

  it('accepts a valid io contract and a valid llm contract', () => {
    const io = defineContract({ ...base, kind: 'io', capabilities: { http: true }, egress: ['example.com'] });
    expect(io.egress).toEqual(['example.com']);
    const llm = defineContract({
      ...base,
      kind: 'llm',
      capabilities: { llm: { model: 'claude-x', maxTokens: 100 } },
      egress: ['api.anthropic.com'],
      budget: { usdPerCall: 0.01, usdPerRun: 1 },
    });
    expect(llm.capabilities.llm?.maxTokens).toBe(100);
  });

  it('validates the llm capability shape', () => {
    const llm = { ...base, kind: 'llm' as const, egress: ['api.anthropic.com'], budget: { usdPerCall: 0.01, usdPerRun: 1 } };
    expect(() => defineContract({ ...llm, capabilities: { llm: { model: 'm', maxTokens: -1 } } })).toThrow(/maxTokens/);
    expect(() => defineContract({ ...llm, capabilities: { llm: { model: '', maxTokens: 10 } } })).toThrow(/model/);
  });

  it('rejects usdPerRun below usdPerCall', () => {
    expect(() => defineContract({ ...base, kind: 'io', capabilities: { http: true }, egress: ['example.com'], budget: { usdPerCall: 1, usdPerRun: 0.5 } })).toThrow(
      /usdPerRun must be at least budget.usdPerCall/,
    );
  });

  it('rejects inconsistent retry settings', () => {
    expect(() => defineContract({ ...base, retry: { max: 1, on: [], backoffMs: [10] } })).toThrow(/needs at least one code in retry.on/);
    expect(() => defineContract({ ...base, retry: { max: 1, on: ['timeout'], backoffMs: [10, 20] } })).toThrow(/exactly one entry per retry/);
  });
});

describe('emits (minimum output data class)', () => {
  it('must be one of the classes the contract may emit', () => {
    expect(() => defineContract({ ...base, emits: 'P1' })).toThrow(/emits P1 is not in dataClasses.out/);
    expect(defineContract({ ...base, dataClasses: { in: ['P0'], out: ['P0', 'P1'] }, emits: 'P1' }).emits).toBe('P1');
  });

  it('is part of the shape when set, and leaves existing hashes alone when not', () => {
    const plain = defineContract({ ...base, dataClasses: { in: ['P0'], out: ['P0', 'P1'] } });
    const emitting = defineContract({ ...plain, emits: 'P1' });
    expect(contractShape(plain)).not.toHaveProperty('emits');
    expect(contractShape(emitting)).toMatchObject({ emits: 'P1' });
    expect(contractHash(emitting)).not.toBe(contractHash(plain));
  });
});

describe('contractShape ordering is locale independent', () => {
  it('sorts obligations by code unit, and no source file uses localeCompare', () => {
    const c = defineContract({ ...base, obligations: { adds: [{ id: 'a.b', dischargedBy: 'x' }, { id: 'a-b', dischargedBy: 'x' }, { id: 'a0', dischargedBy: 'x' }], discharges: [] } });
    const ids = (contractShape(c).obligations as { adds: { id: string }[] }).adds.map((a) => a.id);
    expect(ids).toEqual(['a-b', 'a.b', 'a0']);
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
    const users = walk(join(import.meta.dirname, '../../src')).filter((f) => /\blocaleCompare\b/.test(readFileSync(f, 'utf8')));
    expect(users).toEqual([]);
  });
});

