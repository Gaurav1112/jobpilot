import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAgent } from '../../src/kernel/agent.js';
import { defineContract } from '../../src/kernel/contract.js';
import { WiringError } from '../../src/kernel/errors.js';
import { builtinGuardrails } from '../../src/kernel/guardrails/builtin.js';
import { definePredicate } from '../../src/kernel/predicates.js';
import { Registry } from '../../src/kernel/registry.js';
import { defineType } from '../../src/kernel/types.js';
import { compileWiring, type Pipeline } from '../../src/kernel/wiring.js';
import { demoAgents, demoPipeline } from '../../src/demo/pipeline.js';

const registryWith = (...agents: Parameters<Registry['register']>[0][]) => {
  const r = new Registry();
  for (const a of agents) r.register(a);
  return r;
};
const problems = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof WiringError) return [...e.problems];
    throw e;
  }
  return [];
};

describe('compileWiring', () => {
  it('compiles the demo pipeline with routes and stages', () => {
    const c = compileWiring(registryWith(...demoAgents), demoPipeline, builtinGuardrails());
    expect(c.routes.get('DemoItem@1')).toEqual(['demo-scorer']);
    expect(c.stage.get('demo-source')).toBe(1);
    expect(c.stage.get('demo-scorer')).toBe(2);
    expect(c.teamOf.get('demo-scorer')?.id).toBe('evaluation');
  });

  it('refuses a consumer whose requirement no producer guarantees', () => {
    const Req = defineType('Q', 1, z.object({ s: z.string() }).strict());
    const needs = definePredicate<{ s: string }>('q.checked', 'checked', () => true);
    const greedy = defineAgent(
      defineContract({
        id: 'greedy', version: '1.0.0', description: 'Needs a promise nobody makes', skills: ['x'], team: 'evaluation', kind: 'deterministic',
        consumes: defineType('DemoItem', 1, z.object({ id: z.string(), text: z.string() }).strict()), produces: Req, requires: [needs as never],
        dataClasses: { in: ['P0'], out: ['P0'] }, budget: { usdPerCall: 0, usdPerRun: 0 }, timeoutMs: 100,
      }),
      async () => [],
    );
    const p: Pipeline = {
      ...demoPipeline,
      teams: demoPipeline.teams.map((t) => (t.id === 'evaluation' ? { ...t, members: [...t.members, 'greedy'], exitGuarantees: [] } : t)),
      edges: [...demoPipeline.edges, { type: 'DemoItem@1', to: 'greedy' }],
    };
    expect(problems(() => compileWiring(registryWith(...demoAgents, greedy), p, builtinGuardrails()))).toContain(
      'greedy requires q.checked but producer demo-source does not guarantee it',
    );
  });

  it('reports every problem at once: unknown agent, wrong type, no producer, team mismatch', () => {
    const p: Pipeline = {
      ...demoPipeline,
      teams: [{ ...demoPipeline.teams[0]!, members: ['demo-source', 'demo-scorer'] }, { ...demoPipeline.teams[1]!, members: ['ghost'] }],
      edges: [
        { type: 'DemoRequest@1', to: 'demo-source' },
        { type: 'DemoRequest@1', to: 'demo-scorer' },
        { type: 'Nothing@1', to: 'ghost' },
      ],
    };
    const ps = problems(() => compileWiring(registryWith(...demoAgents), p, builtinGuardrails()));
    expect(ps).toEqual(
      expect.arrayContaining([
        'team evaluation lists unregistered agent ghost',
        'agent demo-scorer declares team evaluation but is listed in sourcing',
        'edge DemoRequest@1 → demo-scorer: agent consumes DemoItem@1',
        'edge Nothing@1 → ghost: agent is not registered',
      ]),
    );
  });

  it('enforces team exit guarantees on cross-team edges', () => {
    const p: Pipeline = { ...demoPipeline, teams: demoPipeline.teams.map((t) => (t.id === 'sourcing' ? { ...t, exitGuarantees: ['item.deduped'] } : t)) };
    expect(problems(() => compileWiring(registryWith(...demoAgents), p, builtinGuardrails()))).toContain(
      'demo-source leaves team sourcing without its exit guarantee item.deduped',
    );
  });

  it('rejects contracts that name unknown guardrails', () => {
    const odd = defineAgent(defineContract({ ...demoAgents[0].contract, guardrails: { in: ['G-NOPE'], out: [] } }), demoAgents[0].run);
    expect(problems(() => compileWiring(registryWith(odd, demoAgents[1]), demoPipeline, builtinGuardrails()))).toContain(
      'agent demo-source lists unknown guardrail G-NOPE',
    );
  });

  it('flags agents nothing reachable from the seed feeds', () => {
    const Orphan = defineType('Orphan', 1, z.object({ id: z.string() }).strict());
    const orphan = defineAgent(
      defineContract({ id: 'orphan', version: '1.0.0', description: 'Waits for input that never comes', skills: ['x'], team: 'sourcing', kind: 'deterministic', consumes: Orphan, produces: Orphan, dataClasses: { in: ['P0'], out: ['P0'] }, budget: { usdPerCall: 0, usdPerRun: 0 }, timeoutMs: 100 }),
      async () => [],
    );
    const p: Pipeline = {
      ...demoPipeline,
      teams: demoPipeline.teams.map((t) => (t.id === 'sourcing' ? { ...t, members: [...t.members, 'orphan'] } : t)),
      edges: [...demoPipeline.edges, { type: 'Orphan@1', to: 'orphan' }],
    };
    expect(problems(() => compileWiring(registryWith(...demoAgents, orphan), p, builtinGuardrails()))).toContain('agent orphan is unreachable from the seed');
  });

  it('detects a cycle reachable from the seed', () => {
    const Item = demoAgents[0].contract.produces;
    const rescorer = defineAgent(
      defineContract({ id: 'rescorer', version: '1.0.0', description: 'Turns a score back into an item', skills: ['x'], team: 'evaluation', kind: 'deterministic', consumes: demoAgents[1].contract.produces, produces: Item, guarantees: demoAgents[0].contract.guarantees, dataClasses: { in: ['P0'], out: ['P0'] }, budget: { usdPerCall: 0, usdPerRun: 0 }, timeoutMs: 100 }),
      async () => [],
    );
    const p: Pipeline = {
      ...demoPipeline,
      teams: demoPipeline.teams.map((t) => (t.id === 'evaluation' ? { ...t, members: [...t.members, 'rescorer'] } : t)),
      edges: [...demoPipeline.edges, { type: 'DemoScore@1', to: 'rescorer' }],
    };
    const ps = problems(() => compileWiring(registryWith(...demoAgents, rescorer), p, builtinGuardrails()));
    expect(ps).toContain('cycle: demo-source → demo-scorer → rescorer → demo-scorer');
  });

  it('rejects one type id defined with two different schemas', () => {
    const Variant = defineType('DemoItem', 1, z.object({ id: z.string(), text: z.string(), extra: z.number() }).strict());
    const variant = defineAgent(
      defineContract({ id: 'variant', version: '1.0.0', description: 'Reads a different shape under the same id', skills: ['x'], team: 'evaluation', kind: 'deterministic', consumes: Variant, produces: defineType('VariantOut', 1, z.object({ id: z.string() }).strict()), dataClasses: { in: ['P0'], out: ['P0'] }, budget: { usdPerCall: 0, usdPerRun: 0 }, timeoutMs: 100 }),
      async () => [],
    );
    const p: Pipeline = {
      ...demoPipeline,
      teams: demoPipeline.teams.map((t) => (t.id === 'evaluation' ? { ...t, members: [...t.members, 'variant'], exitGuarantees: [] } : t)),
      edges: [...demoPipeline.edges, { type: 'DemoItem@1', to: 'variant' }],
    };
    const ps = problems(() => compileWiring(registryWith(...demoAgents, variant), p, builtinGuardrails())).filter((x) => /defined with different schemas/.test(x));
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatch(/type DemoItem@1 is defined with different schemas/);
  });

  it('does not flag a same-shape redefinition as a schema conflict', () => {
    const Req = defineType('Q', 1, z.object({ s: z.string() }).strict());
    const needs = definePredicate<{ s: string }>('q.checked', 'checked', () => true);
    const greedy = defineAgent(
      defineContract({
        id: 'greedy', version: '1.0.0', description: 'Needs a promise nobody makes', skills: ['x'], team: 'evaluation', kind: 'deterministic',
        consumes: defineType('DemoItem', 1, z.object({ id: z.string(), text: z.string() }).strict()), produces: Req, requires: [needs as never],
        dataClasses: { in: ['P0'], out: ['P0'] }, budget: { usdPerCall: 0, usdPerRun: 0 }, timeoutMs: 100,
      }),
      async () => [],
    );
    const p: Pipeline = {
      ...demoPipeline,
      teams: demoPipeline.teams.map((t) => (t.id === 'evaluation' ? { ...t, members: [...t.members, 'greedy'], exitGuarantees: [] } : t)),
      edges: [...demoPipeline.edges, { type: 'DemoItem@1', to: 'greedy' }],
    };
    const ps = problems(() => compileWiring(registryWith(...demoAgents, greedy), p, builtinGuardrails()));
    expect(ps).toEqual(['greedy requires q.checked but producer demo-source does not guarantee it']);
    expect(ps.some((x) => x.includes('different schemas'))).toBe(false);
  });

  it('rejects a pipeline whose seed type nothing consumes', () => {
    const p: Pipeline = { ...demoPipeline, edges: demoPipeline.edges.filter((e) => e.type !== demoPipeline.seed.type.id) };
    expect(problems(() => compileWiring(registryWith(...demoAgents), p, builtinGuardrails()))).toContain('nothing consumes the seed type DemoRequest@1');
  });
});
