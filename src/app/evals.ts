import { join } from 'node:path';
import { loadJsonl, type EvalSpec } from '../evals/runner.js';
import type { AnyAgent } from '../kernel/agent.js';
import { freezePack, issueContext } from '../kernel/broker.js';
import { fixedClock } from '../kernel/clock.js';
import { contractHash } from '../kernel/contract.js';
import { KernelError } from '../kernel/errors.js';
import { ZERO_COST, type Envelope } from '../kernel/envelope.js';
import { policyHash, PRODUCT_POLICY_V1 } from '../kernel/policy.js';
import { eligibility } from './agents/eligibility.js';
import { scorerLexicon } from './agents/scorer-lexicon.js';
import { coverWriter } from './agents/writing/cover-writer.js';
import { evidenceMatcher } from './agents/writing/evidence-matcher.js';
import { resumePlanner } from './agents/writing/resume-planner.js';
import { gigNormalizer } from './freelance/gig-normalizer.js';
import { rateNormalizer } from './freelance/rate.js';
import { appGuardrails } from './guardrails.js';
import { loadPack } from './pack/load.js';
import type { RatedGig } from './freelance/types.js';
import type { EligibilityVerdict, Evidence, Scored } from './types.js';

/** Exactly one output, projected; any other number of outputs is reported as `{outputs: n}`, never as a verdict or score. */
function one<T>(outs: readonly unknown[], f: (o: T) => unknown): unknown {
  return outs.length === 1 ? f(outs[0] as T) : { outputs: outs.length };
}

const PHASH = policyHash(PRODUCT_POLICY_V1);

/** Runs one writing agent on `input` through a broker context, as the executor would, and checks its out guardrails. */
async function runChecked(agent: AnyAgent, inputType: string, input: unknown, producer: AnyAgent, pack: unknown): Promise<{ outs: readonly unknown[]; trips: string[] }> {
  const c = agent.contract;
  const ctx = issueContext({
    contract: c,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: {
      fetch: async () => {
        throw new KernelError('policy_denied', 'evals are offline');
      },
    },
    clock: fixedClock('2026-01-01T00:00:00Z'),
    signal: AbortSignal.timeout(c.timeoutMs),
    pack,
  });
  const outs = await agent.run(input, ctx);
  const env: Envelope = {
    envelopeId: 'eval', stepKey: 'eval', index: 0, type: inputType,
    producer: { agentId: producer.contract.id, version: producer.contract.version, contractHash: contractHash(producer.contract) },
    parents: [], payload: input,
    handoff: { guarantees: producer.contract.guarantees.map((g) => g.id), dataClass: 'P0', obligations: [], pins: { policyHash: PHASH } },
    guardrails: [], cost: ZERO_COST,
  };
  const guardrails = appGuardrails();
  const trips = outs.flatMap((payload) => {
    const r = guardrails.run('out', { side: 'out', contract: c, policy: PRODUCT_POLICY_V1, policyHash: PHASH, contractHashOf: () => undefined, input: env, output: { payload, dataClass: 'P0' }, pack: pack as object });
    return r.tripped ? r.verdicts.filter((v) => v.verdict === 'trip').map((v) => `${c.id} ${v.id}: ${v.detail ?? ''}`) : [];
  });
  return { outs, trips };
}

/**
 * The `grounding` gate: from one Evidence, run resume-planner and cover-writer as the pipeline would and pass every
 * out guardrail (the mandatory ones plus G-GROUND, G-NAMING, G-NO-GAP-CLAIM). `{pass: true}` or the trips.
 */
async function grounding(evidence: Evidence, pack: unknown): Promise<unknown> {
  const plan = await runChecked(resumePlanner, 'Evidence@1', evidence, evidenceMatcher, pack);
  if (plan.outs.length !== 1) return { resumePlans: plan.outs.length, trips: plan.trips };
  const cover = await runChecked(coverWriter, 'ResumePlan@1', plan.outs[0], resumePlanner, pack);
  if (cover.outs.length !== 1) return { coverPlans: cover.outs.length, trips: [...plan.trips, ...cover.trips] };
  const trips = [...plan.trips, ...cover.trips];
  return trips.length === 0 ? { pass: true } : { pass: false, trips };
}

/**
 * The app's golden-set evals. They run on the fictional fixture pack (`tests/fixtures/pack`), never the user's own:
 * the public part of it (no contact, no answers), frozen with `freezePack` as the supervisor does, with its hash.
 */
export function appEvalSpecs(datasetDir: string, packDir: string): EvalSpec[] {
  // `loadPack`'s hash is already the hash of the public pack (no contact, no answers), exactly what the agents see.
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
    {
      // Every real fixture posting that clears minFit, plus synthetic edge cases, through the whole writing chain.
      name: 'grounding',
      agent: evidenceMatcher,
      cases: loadJsonl(join(datasetDir, 'grounding.jsonl')),
      project: async (outs) => (outs.length === 1 ? grounding(outs[0] as Evidence, pack) : { outputs: outs.length }),
      metric: 'exactMatch',
      min: 1,
      pack,
      packHash: hash,
    },
    {
      // RawGig@1 to Gig@1: the whole Gig, or the error message of a raw the normalizer refuses.
      name: 'gig-normalizer',
      agent: gigNormalizer,
      cases: loadJsonl(join(datasetDir, 'gig-normalizer.jsonl')),
      project: (outs) => one(outs, (o: unknown) => o),
      metric: 'exactMatch',
      min: 1,
    },
    {
      // Gig@1 to the rate: method, USD per hour, fx date and budget, on the fixture pack's fx table and 20 h cap.
      name: 'gig-rate',
      agent: rateNormalizer,
      cases: loadJsonl(join(datasetDir, 'gig-rate.jsonl')),
      project: (outs) => one(outs, (o: RatedGig) => o.rate),
      metric: 'exactMatch',
      min: 1,
      pack,
      packHash: hash,
    },
  ];
}
