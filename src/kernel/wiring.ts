import { z } from 'zod';
import { hashOf } from './canonical.js';
import type { DataClass } from './data-class.js';
import { WiringError } from './errors.js';
import type { GuardrailRegistry } from './guardrails/index.js';
import type { Predicate } from './predicates.js';
import type { Registry } from './registry.js';
import type { MessageType } from './types.js';

export const SUPERVISOR_ID = 'supervisor';

export interface Team {
  readonly id: string;
  /** Name of the team lead; its playbook is the team's edges. */
  readonly lead: string;
  readonly members: readonly string[];
  /** Every envelope leaving the team must carry these guarantees. */
  readonly exitGuarantees: readonly string[];
  readonly breaker: { readonly consecutiveFailures: number };
}

export interface Edge {
  /** Message type id, e.g. `DemoItem@1`. */
  readonly type: string;
  readonly to: string;
}

export interface Pipeline {
  readonly id: string;
  readonly version: string;
  /**
   * Seed payload type, the guarantees the supervisor checks on it (any: predicates are contravariant)
   * and the data class seed envelopes carry (default P0).
   */
  readonly seed: { readonly type: MessageType<any>; readonly guarantees: readonly Predicate<any>[]; readonly dataClass?: DataClass };
  readonly teams: readonly Team[];
  readonly edges: readonly Edge[];
}

export interface CompiledPipeline {
  readonly pipeline: Pipeline;
  /** type id → consumer agent ids, sorted. */
  readonly routes: ReadonlyMap<string, readonly string[]>;
  /** agent id → depth from the seed; queues drain in stage order. */
  readonly stage: ReadonlyMap<string, number>;
  readonly teamOf: ReadonlyMap<string, Team>;
  /** Stands in for a contract hash on seed envelopes. */
  readonly seedHash: string;
}

/** Proves the graph is sound before anything runs. Collects every problem, then throws once. */
export function compileWiring(registry: Registry, pipeline: Pipeline, guardrails: GuardrailRegistry): CompiledPipeline {
  const problems: string[] = [];
  const teamOf = new Map<string, Team>();
  const teamIds = new Set<string>();

  for (const t of pipeline.teams) {
    if (teamIds.has(t.id)) problems.push(`team ${t.id} declared twice`);
    teamIds.add(t.id);
    for (const m of t.members) {
      if (teamOf.has(m)) problems.push(`agent ${m} is in two teams`);
      teamOf.set(m, t);
      if (!registry.has(m)) {
        problems.push(`team ${t.id} lists unregistered agent ${m}`);
        continue;
      }
      const c = registry.get(m).contract;
      if (c.team !== t.id) problems.push(`agent ${m} declares team ${c.team} but is listed in ${t.id}`);
      for (const g of [...c.guardrails.in, ...c.guardrails.out]) {
        if (!guardrails.has(g)) problems.push(`agent ${m} lists unknown guardrail ${g}`);
      }
    }
  }

  const members = [...teamOf.keys()].filter((m) => registry.has(m));
  const producersOf = (type: string): string[] => {
    const ps = members.filter((m) => registry.get(m).contract.produces.id === type);
    if (pipeline.seed.type.id === type) ps.push(SUPERVISOR_ID);
    return ps.sort();
  };
  const guaranteesOf = (producer: string): string[] =>
    producer === SUPERVISOR_ID ? pipeline.seed.guarantees.map((g) => g.id) : registry.get(producer).contract.guarantees.map((g) => g.id);

  const routes = new Map<string, string[]>();
  for (const e of pipeline.edges) {
    if (!registry.has(e.to)) {
      problems.push(`edge ${e.type} → ${e.to}: agent is not registered`);
      continue;
    }
    if (!teamOf.has(e.to)) problems.push(`edge ${e.type} → ${e.to}: agent is in no team`);
    const c = registry.get(e.to).contract;
    if (c.consumes.id !== e.type) problems.push(`edge ${e.type} → ${e.to}: agent consumes ${c.consumes.id}`);
    const producers = producersOf(e.type);
    if (producers.length === 0) problems.push(`edge ${e.type} → ${e.to}: nothing produces ${e.type}`);
    for (const p of producers) {
      const promised = guaranteesOf(p);
      for (const r of c.requires) {
        if (!promised.includes(r.id)) problems.push(`${e.to} requires ${r.id} but producer ${p} does not guarantee it`);
      }
      const from = teamOf.get(p);
      const to = teamOf.get(e.to);
      if (p !== SUPERVISOR_ID && from && to && from.id !== to.id) {
        for (const g of from.exitGuarantees) {
          if (!promised.includes(g)) problems.push(`${p} leaves team ${from.id} without its exit guarantee ${g}`);
        }
      }
    }
    const list = routes.get(e.type) ?? [];
    if (list.includes(e.to)) problems.push(`edge ${e.type} → ${e.to} declared twice`);
    list.push(e.to);
    routes.set(e.type, list.sort());
  }

  checkObligations(registry, members, routes, teamOf, problems);
  checkSchemaIdentity(registry, pipeline, members, problems);
  if (!pipeline.edges.some((e) => e.type === pipeline.seed.type.id)) problems.push(`nothing consumes the seed type ${pipeline.seed.type.id}`);

  const stage = computeStages(registry, pipeline, routes, problems);
  if (problems.length > 0) throw new WiringError(problems);
  return {
    pipeline,
    routes,
    stage,
    teamOf,
    seedHash: hashOf({
      pipeline: pipeline.id,
      version: pipeline.version,
      seed: pipeline.seed.type.id,
      guarantees: pipeline.seed.guarantees.map((g) => g.id).sort(),
      dataClass: seedClass(pipeline),
    }),
  };
}

export function seedClass(pipeline: Pipeline): DataClass {
  return pipeline.seed.dataClass ?? 'P0';
}

/** Longest path from the seed; a cycle is a wiring error. */
function computeStages(registry: Registry, pipeline: Pipeline, routes: Map<string, string[]>, problems: string[]): Map<string, number> {
  const stage = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (agent: string, depth: number, path: string[]): void => {
    if (visiting.has(agent)) {
      problems.push(`cycle: ${[...path, agent].join(' → ')}`);
      return;
    }
    if ((stage.get(agent) ?? -1) >= depth) return;
    stage.set(agent, depth);
    if (!registry.has(agent)) return;
    visiting.add(agent);
    for (const next of routes.get(registry.get(agent).contract.produces.id) ?? []) visit(next, depth + 1, [...path, agent]);
    visiting.delete(agent);
  };
  for (const first of routes.get(pipeline.seed.type.id) ?? []) visit(first, 1, []);
  for (const t of pipeline.teams) {
    for (const m of t.members) if (registry.has(m) && !stage.has(m)) problems.push(`agent ${m} is unreachable from the seed`);
  }
  return stage;
}

/** Agents an envelope from `from` can reach through the routes, excluding `from` itself unless a cycle leads back. */
function downstreamOf(registry: Registry, from: string, routes: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [...(routes.get(registry.get(from).contract.produces.id) ?? [])];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next)) continue;
    seen.add(next);
    if (registry.has(next)) queue.push(...(routes.get(registry.get(next).contract.produces.id) ?? []));
  }
  return seen;
}

/** Whoever must discharge an obligation has to be a team member the item can actually reach after it is added. */
function checkObligations(
  registry: Registry,
  members: readonly string[],
  routes: ReadonlyMap<string, readonly string[]>,
  teamOf: ReadonlyMap<string, Team>,
  problems: string[],
): void {
  for (const m of [...members].sort()) {
    const adds = registry.get(m).contract.obligations.adds;
    if (adds.length === 0) continue;
    const reachable = downstreamOf(registry, m, routes);
    for (const a of adds) {
      if (!registry.has(a.dischargedBy) || !teamOf.has(a.dischargedBy) || !reachable.has(a.dischargedBy)) {
        problems.push(`${m} adds obligation ${a.id} but ${a.dischargedBy} is not reachable downstream`);
      }
    }
  }
}

/** One type id must mean one payload shape everywhere it is used. */
function checkSchemaIdentity(registry: Registry, pipeline: Pipeline, members: string[], problems: string[]): void {
  const uses = new Map<string, Map<string, string>>(); // type id → agent → schema hash
  const note = (type: MessageType<any>, agent: string): void => {
    const byAgent = uses.get(type.id) ?? new Map<string, string>();
    if (!byAgent.has(agent)) byAgent.set(agent, hashOf(z.toJSONSchema(type.schema)));
    uses.set(type.id, byAgent);
  };
  note(pipeline.seed.type, SUPERVISOR_ID);
  for (const m of members) {
    const c = registry.get(m).contract;
    note(c.consumes, m);
    note(c.produces, m);
  }
  for (const [id, byAgent] of [...uses].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const agents = [...byAgent.keys()].sort();
    const first = agents[0];
    const other = agents.find((a) => byAgent.get(a) !== byAgent.get(first ?? ''));
    if (first !== undefined && other !== undefined) problems.push(`type ${id} is defined with different schemas (${first}, ${other})`);
  }
}
