import { fakeLlm } from '../kernel/fakes.js';
import { StateMachine } from '../kernel/state-machine.js';
import type { Tracker } from '../kernel/supervisor.js';
import type { Pipeline } from '../kernel/wiring.js';
import { demoScorer, demoSource } from './agents.js';
import { countPositive, DemoRequest } from './types.js';

export const demoAgents = [demoSource, demoScorer] as const;

export const demoPipeline: Pipeline = {
  id: 'demo',
  version: '1.0.0',
  seed: { type: DemoRequest, guarantees: [countPositive] },
  teams: [
    { id: 'sourcing', lead: 'sourcing-lead', members: ['demo-source'], exitGuarantees: ['item.id-nonempty'], breaker: { consecutiveFailures: 3 } },
    { id: 'evaluation', lead: 'evaluation-lead', members: ['demo-scorer'], exitGuarantees: ['score.in-range'], breaker: { consecutiveFailures: 3 } },
  ],
  edges: [
    { type: 'DemoRequest@1', to: 'demo-source' },
    { type: 'DemoItem@1', to: 'demo-scorer' },
  ],
};

export const demoMachine = new StateMachine<'NEW' | 'DISCOVERED' | 'SCORED' | 'QUARANTINED', 'discovered' | 'scored' | 'trip'>({
  id: 'demo-item',
  initial: 'NEW',
  terminal: ['SCORED', 'QUARANTINED'],
  success: ['SCORED'],
  transitions: [
    { from: 'NEW', on: 'discovered', to: 'DISCOVERED' },
    { from: 'DISCOVERED', on: 'scored', to: 'SCORED' },
    { from: '*', on: 'trip', to: 'QUARANTINED' },
  ],
});

/** One entity per demo item, keyed by its id. */
export const demoTracker: Tracker = {
  kind: 'demo-item',
  machine: demoMachine,
  keyOf: (env) => (env.type === 'DemoItem@1' || env.type === 'DemoScore@1' ? (env.payload as { id: string }).id : null),
  eventFor: (agentId, outcome) => (outcome === 'quarantined' ? 'trip' : agentId === 'demo-source' ? 'discovered' : agentId === 'demo-scorer' ? 'scored' : null),
};

/** Deterministic stand-in for the model: the score is the prompt length mod 11. */
export function demoLlm(usdPerCall = 0.001) {
  return fakeLlm((req) => JSON.stringify({ score: req.prompt.length % 11, reason: 'length heuristic' }), { usdPerCall });
}
