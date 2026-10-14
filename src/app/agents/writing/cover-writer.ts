import { defineAgent } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { CoverPlan, planHasBullets, ResumePlan } from '../../types.js';
import { failLoud, planCover, writingPackOf } from './grounded.js';

/**
 * cover-writer (spec §5.4, cover letter v2): the fixed four-paragraph cover letter of one resume plan. Every sentence
 * is a template rendering with computed slots or a citeable claim verbatim, anchored to its display employer (rules in
 * `grounded.ts`, templates in `templates.ts`). It reads the public pack only, never `contact.yaml` or `answers.yaml`
 * (P1): the city and notice stay as the placeholders `{city}` and `{notice}` for the renderer, which has the full pack
 * (see `COVER_P4`). 1.1.0: v2 templates (employer-anchored evidence, no gap sentence, no availability date). 1.1.1: a
 * colon-form evidence fact gives way to a verb-led resume bullet backing the same p1 terms (`preferVerbLed`).
 */
export const coverWriterContract = defineContract({
  id: 'cover-writer',
  version: '1.4.0',
  description: 'Writes one grounded cover letter plan from a resume plan',
  skills: ['cover-writing'],
  team: 'writing',
  kind: 'deterministic',
  consumes: ResumePlan,
  produces: CoverPlan,
  requires: [planHasBullets],
  capabilities: { pack: true },
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
  guardrails: { in: [], out: ['G-GROUND', 'G-NAMING'] },
});

export const coverWriter = defineAgent(coverWriterContract, async (plan, ctx) => {
  const pack = writingPackOf(ctx.pack, 'cover-writer');
  return [failLoud('cover-writer', () => planCover(plan, pack))];
});
