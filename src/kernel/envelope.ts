import { sha256 } from './canonical.js';
import type { Contract } from './contract.js';
import type { DataClass } from './data-class.js';

export interface Obligation {
  readonly id: string;
  readonly dischargedBy: string;
  readonly discharged: boolean;
}

/** What one agent passes to the next, besides the payload. */
export interface Handoff {
  readonly guarantees: readonly string[];
  readonly dataClass: DataClass;
  readonly obligations: readonly Obligation[];
  readonly pins: { readonly policyHash: string };
}

export interface Producer {
  readonly agentId: string;
  readonly version: string;
  readonly contractHash: string;
}

export interface GuardrailVerdict {
  readonly id: string;
  readonly verdict: 'pass' | 'warn' | 'trip';
  readonly detail?: string;
}

export interface Cost {
  readonly usd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export const ZERO_COST: Cost = Object.freeze({ usd: 0, inputTokens: 0, outputTokens: 0 });

/** Deliberately free of run ids and timestamps, so the same input yields byte-identical envelopes. */
export interface Envelope<T = unknown> {
  readonly envelopeId: string;
  readonly stepKey: string;
  readonly index: number;
  readonly type: string;
  readonly producer: Producer;
  readonly parents: readonly string[];
  readonly payload: T;
  readonly handoff: Handoff;
  readonly guardrails: readonly GuardrailVerdict[];
  readonly cost: Cost;
}

export function makeEnvelopeId(stepKey: string, index: number): string {
  return sha256(`${stepKey}:${index}`);
}

/** Discharge what this agent may discharge, add what it adds; sorted by id. */
export function nextObligations(input: readonly Obligation[], contract: Pick<Contract, 'id' | 'obligations'>): Obligation[] {
  const byId = new Map<string, Obligation>();
  for (const o of input) {
    const discharge = o.dischargedBy === contract.id && contract.obligations.discharges.includes(o.id);
    byId.set(o.id, discharge ? { ...o, discharged: true } : o);
  }
  for (const a of contract.obligations.adds) {
    if (!byId.has(a.id)) byId.set(a.id, { id: a.id, dischargedBy: a.dischargedBy, discharged: false });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function openObligations(env: Pick<Envelope, 'handoff'>): string[] {
  return env.handoff.obligations.filter((o) => !o.discharged).map((o) => o.id);
}
