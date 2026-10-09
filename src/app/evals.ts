import { join } from 'node:path';
import { loadJsonl, type EvalSpec } from '../evals/runner.js';
import { freezePack } from '../kernel/broker.js';
import { eligibility } from './agents/eligibility.js';
import { scorerLexicon } from './agents/scorer-lexicon.js';
import { loadPack } from './pack/load.js';
import type { EligibilityVerdict, Scored } from './types.js';

/** Exactly one output, projected; any other number of outputs is reported as `{outputs: n}`, never as a verdict or score. */
function one<T>(outs: readonly unknown[], f: (o: T) => unknown): unknown {
  return outs.length === 1 ? f(outs[0] as T) : { outputs: outs.length };
}

/**
 * The app's golden-set evals. They run on the fictional fixture pack (`tests/fixtures/pack`), never the user's own:
 * the public part of it (no contact, no answers), frozen with `freezePack` as the supervisor does, with its hash.
 */
export function appEvalSpecs(datasetDir: string, packDir: string): EvalSpec[] {
  const { pack: full, hash } = loadPack(packDir);
  const { contact: _contact, answers: _answers, ...publicPack } = full;
  const pack = freezePack(publicPack);
  return [
    {
      agent: eligibility,
      cases: loadJsonl(join(datasetDir, 'eligibility.jsonl')),
      project: (outs) => one(outs, (o: EligibilityVerdict) => ({ verdict: o.verdict, reasons: o.reasons, notes: o.notes })),
      metric: 'exactMatch',
      min: 1,
      pack,
      packHash: hash,
    },
    {
      agent: scorerLexicon,
      cases: loadJsonl(join(datasetDir, 'scorer-lexicon.jsonl')),
      project: (outs) => (outs.length === 0 ? { outputs: 0 } : one(outs, (o: Scored) => ({ score: o.score, breakdown: o.breakdown }))),
      metric: 'exactMatch',
      min: 1,
      pack,
      packHash: hash,
    },
  ];
}
