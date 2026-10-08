import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contractHash, defineContract } from '../../src/kernel/contract.js';
import type { Envelope } from '../../src/kernel/envelope.js';
import { ZERO_COST } from '../../src/kernel/envelope.js';
import { builtinGuardrails } from '../../src/kernel/guardrails/builtin.js';
import type { GuardrailContext } from '../../src/kernel/guardrails/index.js';
import { PRODUCT_POLICY_V1, policyHash } from '../../src/kernel/policy.js';
import { definePredicate } from '../../src/kernel/predicates.js';
import { defineType } from '../../src/kernel/types.js';

const Item = defineType('Item', 1, z.object({ id: z.string(), n: z.number().int() }).strict());
const idSet = definePredicate<{ id: string }>('item.id-nonempty', 'id is not empty', (p) => p.id.length > 0);
const small = definePredicate<{ n: number }>('item.n-small', 'n below 10', (p) => p.n < 10);

const producer = defineContract({
  id: 'maker', version: '1.0.0', description: 'Makes items from nothing', skills: ['making'], team: 'demo', kind: 'deterministic',
  consumes: Item, produces: Item, guarantees: [idSet], dataClasses: { in: ['P0'], out: ['P0'] }, budget: { usdPerCall: 0, usdPerRun: 0 }, timeoutMs: 1000,
});
const consumer = defineContract({
  id: 'user', version: '1.0.0', description: 'Uses items it is given', skills: ['using'], team: 'demo', kind: 'deterministic',
  consumes: Item, produces: Item, requires: [idSet], guarantees: [small], dataClasses: { in: ['P0'], out: ['P0'] }, budget: { usdPerCall: 0, usdPerRun: 0 }, timeoutMs: 1000,
});

const pHash = policyHash(PRODUCT_POLICY_V1);
const env = (over: Partial<Envelope> = {}): Envelope => ({
  envelopeId: 'e1', stepKey: 's1', index: 0, type: 'Item@1',
  producer: { agentId: 'maker', version: '1.0.0', contractHash: contractHash(producer) },
  parents: [], payload: { id: 'a', n: 1 },
  handoff: { guarantees: ['item.id-nonempty'], dataClass: 'P0', obligations: [], pins: { policyHash: pHash } },
  guardrails: [], cost: ZERO_COST, ...over,
});
const ctx = (input: Envelope, output?: GuardrailContext['output']): GuardrailContext => ({
  side: 'in', contract: consumer, policy: PRODUCT_POLICY_V1, policyHash: pHash,
  contractHashOf: (id, v) => (id === 'maker' && v === '1.0.0' ? contractHash(producer) : undefined),
  input, ...(output ? { output } : {}),
});
const reg = builtinGuardrails();

describe('input guardrails', () => {
  it('passes a well-formed, promised, untampered envelope', () => {
    const r = reg.run('in', ctx(env()));
    expect(r.tripped).toBe(false);
    expect(r.verdicts.map((v) => v.id)).toEqual(['G-SCHEMA', 'G-LINEAGE', 'G-DATACLASS', 'G-SIZE', 'G-PRE']);
  });

  it('G-SCHEMA trips on unknown keys and wrong types, and stops the pipeline', () => {
    const r = reg.run('in', ctx(env({ payload: { id: 'a', n: 1, extra: true } })));
    expect(r.tripped).toBe(true);
    expect(r.verdicts).toHaveLength(1);
    expect(r.verdicts[0]?.id).toBe('G-SCHEMA');
  });

  it('G-SCHEMA trips when the envelope type differs from what the contract consumes', () => {
    expect(reg.run('in', ctx(env({ type: 'Other@1' }))).verdicts[0]?.detail).toMatch(/consumes Item@1/);
  });

  it('G-LINEAGE trips on a tampered contract hash and on a foreign policy', () => {
    const forged = env({ producer: { agentId: 'maker', version: '1.0.0', contractHash: 'f'.repeat(64) } });
    expect(reg.run('in', ctx(forged)).verdicts.at(-1)).toMatchObject({ id: 'G-LINEAGE', verdict: 'trip' });
    const foreign = env({ handoff: { ...env().handoff, pins: { policyHash: 'other' } } });
    expect(reg.run('in', ctx(foreign)).verdicts.at(-1)?.detail).toMatch(/different policy/);
  });

  it('G-DATACLASS refuses P1 data to an agent that only takes P0', () => {
    const tainted = env({ handoff: { ...env().handoff, dataClass: 'P1' } });
    expect(reg.run('in', ctx(tainted)).verdicts.at(-1)).toMatchObject({ id: 'G-DATACLASS', verdict: 'trip' });
  });

  it('G-PRE needs the promise in the handoff and the predicate to hold', () => {
    const unpromised = env({ handoff: { ...env().handoff, guarantees: [] } });
    expect(reg.run('in', ctx(unpromised)).verdicts.at(-1)?.detail).toMatch(/was not guaranteed/);
    const broken = env({ payload: { id: '', n: 1 } });
    expect(reg.run('in', ctx(broken)).verdicts.at(-1)?.detail).toMatch(/does not hold/);
  });
});

describe('output guardrails', () => {
  it('G-POST trips when the agent breaks its own guarantee', () => {
    const r = reg.run('out', { ...ctx(env(), { payload: { id: 'a', n: 99 }, dataClass: 'P0' }), side: 'out' });
    expect(r.verdicts.at(-1)).toMatchObject({ id: 'G-POST', verdict: 'trip' });
  });

  it('G-DATACLASS trips when taint would push the output above what the contract emits', () => {
    const r = reg.run('out', { ...ctx(env(), { payload: { id: 'a', n: 1 }, dataClass: 'P1' }), side: 'out' });
    expect(r.verdicts.at(-1)).toMatchObject({ id: 'G-DATACLASS', verdict: 'trip' });
  });

  it('a predicate that throws is a trip, not a crash', () => {
    const boom = definePredicate<unknown>('item.boom', 'throws', () => { throw new Error('bad'); });
    const c = defineContract({ ...consumer, guarantees: [boom] });
    const r = reg.run('out', { ...ctx(env(), { payload: { id: 'a', n: 1 }, dataClass: 'P0' }), side: 'out', contract: c });
    expect(r.verdicts.at(-1)?.detail).toMatch(/guardrail threw/);
  });
});
