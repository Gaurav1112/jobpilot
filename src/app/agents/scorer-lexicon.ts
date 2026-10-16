import { z } from 'zod';
import { defineAgent } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { KernelError } from '../../kernel/errors.js';
import { anyTermIn, termsIn } from '../lexicon.js';
import { effectiveTargets, ROLE_FAMILY_IDS } from '../profiles/families.js';
import { EligibilityVerdict, Scored } from '../types.js';

/**
 * The lexicon scorer: exactly the v2 §6 formula (spec §5.3).
 *
 * | Row | Points | Breakdown label |
 * |---|---|---|
 * | base | 30 | `base` |
 * | the first `targets.seniority` group with a word in the title (staff, lead, principal, sde-3, sde iii: 10; else senior: 8) | its points | `title:seniority` |
 * | a `targets.titleBonusWords` word in the title (backend, platform, java, distributed; empty: the role family's) | `titleBonusPoints` | `title:family` |
 * | each strong lexicon group in the description | +4 | `strong:<key>` |
 * | each medium group | +1.5 | `medium:<key>` |
 * | each gap group | −4 | `gap:<key>` |
 * | `yearsRequired` above `targets.maxYearsRequired` | −`yearsPenalty` | `years>max` |
 *
 * Skills are read from the description only (the title has its own rows), each group once through its synonyms
 * (`termsIn`, with every tier as list neighbours for the ambiguous words). The sum is rounded half up (`Math.floor(x + 0.5)`) and clamped to 0..100. Only rows that apply appear in
 * the breakdown, in the table's order, keys sorted within a row kind. Verdict and notes pass through; a rejected
 * verdict yields no output (it is terminal at eligibility). The `minFit` cut is applied downstream (evidence-matcher).
 */

const BASE = 30;
const POINTS = { strong: 4, medium: 1.5, gap: -4 } as const;

const Group = z.object({ key: z.string(), synonyms: z.array(z.string()) });
const PackView = z.object({
  lexicon: z.object({ strong: z.array(Group), medium: z.array(Group), gap: z.array(Group) }),
  targets: z.object({
    seniority: z.array(z.object({ words: z.array(z.string()), points: z.number() })),
    titleBonusWords: z.array(z.string()),
    titleBonusPoints: z.number(),
    maxYearsRequired: z.number(),
    yearsPenalty: z.number(),
    // profiles Task 19: the role family whose bonus words apply when `titleBonusWords` is empty
    roleFamily: z.enum(ROLE_FAMILY_IDS).optional(),
  }),
});
export type ScorerPack = z.infer<typeof PackView>;

/** The formula's result on plain text: the score, its rows in table order, and the lexicon keys found per tier. */
export interface TextScore {
  readonly score: number;
  readonly breakdown: Scored['breakdown'];
  readonly jdTerms: Scored['jdTerms'];
}

/**
 * The v2 §6 formula on plain text. Pure. `title` feeds the title rows; `text` is read for the skill groups (the
 * description, plus any skill list the caller appends). `yearsRequired` is the posting's, or null when the source has none
 * (a gig). `scorePosting` and the gig scorer both call this, so there is one copy of the formula.
 */
export function scoreText(title: string, text: string, yearsRequired: number | null, pack: ScorerPack): TextScore {
  const breakdown: Scored['breakdown'] = [{ label: 'base', points: BASE }];
  const seniority = pack.targets.seniority.find((g) => anyTermIn(title, g.words));
  if (seniority !== undefined) breakdown.push({ label: 'title:seniority', points: seniority.points });
  const { titleBonusWords } = effectiveTargets({ titles: [], ...pack.targets });
  if (anyTermIn(title, titleBonusWords)) breakdown.push({ label: 'title:family', points: pack.targets.titleBonusPoints });
  const all = [...pack.lexicon.strong, ...pack.lexicon.medium, ...pack.lexicon.gap];
  const jdTerms = {
    strong: termsIn(text, pack.lexicon.strong, all),
    medium: termsIn(text, pack.lexicon.medium, all),
    gap: termsIn(text, pack.lexicon.gap, all),
  };
  for (const kind of ['strong', 'medium', 'gap'] as const) {
    for (const key of jdTerms[kind]) breakdown.push({ label: `${kind}:${key}`, points: POINTS[kind] });
  }
  if (yearsRequired !== null && yearsRequired > pack.targets.maxYearsRequired) {
    breakdown.push({ label: 'years>max', points: -pack.targets.yearsPenalty });
  }
  const sum = breakdown.reduce((s, b) => s + b.points, 0);
  const score = Math.min(100, Math.max(0, Math.floor(sum + 0.5)));
  return { score, breakdown, jdTerms };
}

/** The score of one eligible or review verdict. Pure. */
export function scorePosting(v: EligibilityVerdict, pack: ScorerPack): Scored {
  if (v.verdict === 'rejected') throw new Error('scorePosting: a rejected verdict is not scored');
  const { posting } = v;
  const { score, breakdown, jdTerms } = scoreText(posting.title, posting.descriptionText, posting.yearsRequired, pack);
  return { posting, verdict: v.verdict, notes: [...v.notes], score, breakdown, jdTerms };
}

/** The scorer's view of a pack; a pack lacking lexicon or targets fails loudly. */
export function packOf(pack: unknown): ScorerPack {
  const view = PackView.safeParse(pack);
  if (!view.success) throw new KernelError('invalid_output', 'scorer-lexicon: the pack is missing or lacks lexicon or targets');
  return view.data;
}

export const scorerLexiconContract = defineContract({
  id: 'scorer-lexicon',
  version: '1.6.0',
  description: 'Scores one eligible posting against the lexicon',
  skills: ['lexicon-scoring'],
  team: 'evaluation',
  kind: 'deterministic',
  consumes: EligibilityVerdict,
  produces: Scored,
  capabilities: { pack: true },
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
});

export const scorerLexicon = defineAgent(scorerLexiconContract, async (v, ctx) => {
  const pack = packOf(ctx.pack);
  return v.verdict === 'rejected' ? [] : [scorePosting(v, pack)];
});
