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
import { gigEligibility } from './freelance/gig-eligibility.js';
import { gigNormalizer } from './freelance/gig-normalizer.js';
import { gigRisk } from './freelance/gig-risk.js';
import { gigScorer } from './freelance/gig-scorer.js';
import { rateNormalizer } from './freelance/rate.js';
import { gigQaChecks } from './freelance/writing/gig-qa.js';
import { gigTexts } from './freelance/writing/gig-text.js';
import { proposalPlanner } from './freelance/writing/proposal-planner.js';
import { appGuardrails } from './guardrails.js';
import { loadPack } from './pack/load.js';
import type { GigDocsPlan, GigVerdict, RatedGig, RiskedGig, ScoredGig } from './freelance/types.js';
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

/** The text-level gig QA checks: everything gig-qa checks that needs no rendered file. */
const GIG_TEXT_CHECKS = ['gig.limits', 'gig.links', 'gig.banned', 'gig.ascii', 'gig.ground'];
/** A stand-in contact block: the eval pack is public (no contact, no answers), and the text checks never read it. */
const EVAL_CONTACT = { name: 'Eval', email: '', phone: '', city: '', links: [] };

/**
 * The `gig-grounding` gate (Task 8): from one ScoredGig, run proposal-planner as the pipeline would and pass every out
 * guardrail (G-GROUND, G-NAMING, G-NO-GAP-CLAIM), then the text-level gig QA checks on the proposal or pitch with the
 * default cadence. `{pass: true}`, `{plans: 0}` for a kind with no documents, or the trips and failed check ids.
 */
async function gigGrounding(scored: ScoredGig, pack: unknown): Promise<unknown> {
  const plan = await runChecked(proposalPlanner, 'ScoredGig@1', scored, gigScorer, pack);
  if (plan.outs.length !== 1) return { plans: plan.outs.length, trips: plan.trips };
  const p = plan.outs[0] as GigDocsPlan;
  const text = gigTexts(p, { contact: EVAL_CONTACT, answers: {}, naming: { forbiddenTerms: [] } });
  const checks = gigQaChecks({ gigKey: p.gigKey, files: [], plan: p, text }, pack, { files: new Map(), pdfText: new Map() });
  const failed = checks.filter((c) => GIG_TEXT_CHECKS.includes(c.id) && !c.ok).map((c) => `${c.id}: ${c.detail}`);
  return plan.trips.length === 0 && failed.length === 0 ? { pass: true } : { pass: false, trips: plan.trips, failed };
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
      // Every scored fixture gig (the recorded Freelancer projects through the real freelance chain), plus edge cases, through the gig writing chain.
      name: 'gig-grounding',
      agent: proposalPlanner,
      cases: loadJsonl(join(datasetDir, 'gig-grounding.jsonl')),
      project: async (outs) => (outs.length === 1 ? gigGrounding((outs[0] as GigDocsPlan).scored, pack) : { plans: outs.length }),
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
    {
      // RatedGig@1 to the verdict, reasons and notes, on the fixture pack's freelance rules (40 an hour, 20 h, 18:00-00:00 IST, 500 fixed).
      name: 'gig-eligibility',
      agent: gigEligibility,
      cases: [...loadJsonl(join(datasetDir, 'gig-eligibility.jsonl')), ...loadJsonl(join(datasetDir, 'gig-eligibility-reviewed.jsonl'))],
      project: (outs) => one(outs, (o: GigVerdict) => ({ verdict: o.verdict, reasons: o.reasons, notes: o.notes })),
      metric: 'exactMatch',
      min: 1,
      pack,
      packHash: hash,
    },
    {
      // GigVerdict@1 to its red-flag ids (the fixed detail text is covered by the unit tests).
      name: 'gig-risk',
      agent: gigRisk,
      cases: loadJsonl(join(datasetDir, 'gig-risk.jsonl')),
      project: (outs) => one(outs, (o: RiskedGig) => ({ flags: o.flags.map((f) => f.id) })),
      metric: 'exactMatch',
      min: 1,
      pack,
      packHash: hash,
    },
    {
      // RiskedGig@1 to fit, breakdown and list, on the fixture pack's lexicon; the eval clock is 2026-01-01T00:00:00Z.
      name: 'gig-scorer',
      agent: gigScorer,
      cases: loadJsonl(join(datasetDir, 'gig-scorer.jsonl')),
      project: (outs) => (outs.length === 0 ? { outputs: 0 } : one(outs, (o: ScoredGig) => ({ fit: o.fit, breakdown: o.breakdown, list: o.list }))),
      metric: 'exactMatch',
      min: 1,
      pack,
      packHash: hash,
    },
  ];
}
