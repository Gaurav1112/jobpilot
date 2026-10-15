import { defineAgent } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { Evidence, Scored } from '../../types.js';
import { buildEvidence, failLoud, writingPackOf } from './grounded.js';

/**
 * evidence-matcher (spec §5.4): ranks the citeable facts against one scored posting and splits its JD terms into
 * covered and missing (rules in `grounded.ts`). A posting scored below `targets.minFit` yields nothing: it is terminal
 * at the scorer (BELOW_FLOOR). Reads the public pack only.
 */
export const evidenceMatcherContract = defineContract({
  id: 'evidence-matcher',
  version: '1.6.0',
  description: 'Ranks citeable facts against one scored posting',
  skills: ['evidence-matching'],
  team: 'writing',
  kind: 'deterministic',
  consumes: Scored,
  produces: Evidence,
  capabilities: { pack: true },
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
  guardrails: { in: [], out: ['G-NAMING'] },
});

export const evidenceMatcher = defineAgent(evidenceMatcherContract, async (scored, ctx) => {
  const pack = writingPackOf(ctx.pack, 'evidence-matcher');
  if (scored.score < pack.targets.minFit) return [];
  return [failLoud('evidence-matcher', () => buildEvidence(scored, pack))];
});
