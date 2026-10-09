import { defineAgent } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { Evidence, planHasBullets, ResumePlan } from '../../types.js';
import { failLoud, planResume, writingPackOf } from './grounded.js';

/**
 * resume-planner (spec §5.4): one grounded resume plan per Evidence. Every bullet and cert is a citeable fact's claim
 * verbatim, every skill is backed by a citeable fact's tech, and every summary slot is computed (rules in
 * `grounded.ts`). G-GROUND re-derives the plan; G-NO-GAP-CLAIM keeps gap skills out. Reads the public pack only.
 */
export const resumePlannerContract = defineContract({
  id: 'resume-planner',
  version: '1.0.0',
  description: 'Plans one grounded resume from ranked evidence',
  skills: ['resume-planning'],
  team: 'writing',
  kind: 'deterministic',
  consumes: Evidence,
  produces: ResumePlan,
  guarantees: [planHasBullets],
  capabilities: { pack: true },
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
  guardrails: { in: [], out: ['G-GROUND', 'G-NAMING', 'G-NO-GAP-CLAIM'] },
});

export const resumePlanner = defineAgent(resumePlannerContract, async (evidence, ctx) => {
  const pack = writingPackOf(ctx.pack, 'resume-planner');
  return [failLoud('resume-planner', () => planResume(evidence, pack))];
});
