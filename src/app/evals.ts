import { join } from 'node:path';
import { z } from 'zod';
import { loadJsonl, type EvalSpec } from '../evals/runner.js';
import { defineAgent, type AnyAgent } from '../kernel/agent.js';
import { defineContract } from '../kernel/contract.js';
import { defineType } from '../kernel/types.js';
import { freezePack, issueContext } from '../kernel/broker.js';
import { fixedClock } from '../kernel/clock.js';
import { hashOf } from '../kernel/canonical.js';
import { contractHash } from '../kernel/contract.js';
import { KernelError } from '../kernel/errors.js';
import { ZERO_COST, type Envelope } from '../kernel/envelope.js';
import { policyHash, PRODUCT_POLICY_V1 } from '../kernel/policy.js';
import { eligibility } from './agents/eligibility.js';
import { scorerLexicon } from './agents/scorer-lexicon.js';
import { coverWriter } from './agents/writing/cover-writer.js';
import { evidenceMatcher } from './agents/writing/evidence-matcher.js';
import { resumePlanner } from './agents/writing/resume-planner.js';
import { detectorEgressSets, makePlatformDetector, platformDetectorContract } from './coverage/detector.js';
import { memoryHostStateStore } from './coverage/gate.js';
import { freehireRowClassifier } from './coverage/freehire-api.js';
import { companyNameMatcher } from './coverage/names.js';
import { CURRENCY_CODES } from './comp/currencies.js';
import { PAY_LOCALES, parsePay } from './comp/locale.js';
import { gigEligibility } from './freelance/gig-eligibility.js';
import { gigNormalizer } from './freelance/gig-normalizer.js';
import { gigRisk } from './freelance/gig-risk.js';
import { gigScorer } from './freelance/gig-scorer.js';
import { rateNormalizer } from './freelance/rate.js';
import { gigQaChecks } from './freelance/writing/gig-qa.js';
import { gigRendererContract } from './freelance/writing/gig-renderer.js';
import { gigFilesOf, gigTexts } from './freelance/writing/gig-text.js';
import { proposalPlanner } from './freelance/writing/proposal-planner.js';
import { appGuardrails, G_FILL, G_GROUND } from './guardrails.js';
import { offlineProviders } from './offline.js';
import { loadPack } from './pack/load.js';
import type { GigDocsPlan, GigVerdict, RatedGig, RiskedGig, ScoredGig } from './freelance/types.js';
import type { RowClass } from './coverage/freehire-api.js';
import type { CareersSite, NameMatch, PlatformGuess } from './coverage/types.js';
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

/** The stand-in full pack of the gig-cover gate: the eval pack plus a fictional contact block (city included) and no answers. */
const COVER_EVAL_CONTACT = { name: 'Eval Candidate', email: 'eval@example.com', phone: '', city: 'Eval City', links: [] };

/**
 * The `gig-cover-grounding` gate (freelance-v2): from one ScoredGig, run proposal-planner as the pipeline would and pass
 * every out guardrail (G-GROUND re-derives the cover letter, G-NAMING, G-NO-GAP-CLAIM); then, with a planned cover,
 * render its texts (`gigTexts`, the fictional contact block) and pass G-GROUND and G-FILL as the gig renderer's output
 * (the city filled, no placeholder left), and gig-qa's `cover.no-terms` (the opening states no pay or hours). `{pass, cover}`:
 * `cover` is whether a letter was planned; any trip or failed check is listed.
 */
async function gigCoverGrounding(scored: ScoredGig, pack: unknown): Promise<unknown> {
  const plan = await runChecked(proposalPlanner, 'ScoredGig@1', scored, gigScorer, pack);
  if (plan.outs.length !== 1) return { plans: plan.outs.length, trips: plan.trips };
  const p = plan.outs[0] as GigDocsPlan;
  const failed: string[] = [];
  if (p.cover !== undefined) {
    const full = { ...(pack as object), contact: COVER_EVAL_CONTACT, answers: {} };
    const { coverBlocked: _blocked, ...text } = gigTexts(p, full as unknown as Parameters<typeof gigTexts>[1]);
    const files = gigFilesOf(p).map((f) => ({ ...f, sha256: '0'.repeat(64), pages: f.format === 'pdf' ? 1 : null }));
    const env = {
      envelopeId: 'eval', stepKey: 'eval', index: 0, type: 'GigDocsPlan@1',
      producer: { agentId: 'proposal-planner', version: proposalPlanner.contract.version, contractHash: contractHash(proposalPlanner.contract) },
      parents: [], payload: p,
      handoff: { guarantees: [], dataClass: 'P0' as const, obligations: [], pins: { policyHash: PHASH } }, guardrails: [], cost: ZERO_COST,
    };
    const ctx = { side: 'out' as const, contract: gigRendererContract, policy: PRODUCT_POLICY_V1, policyHash: PHASH, contractHashOf: () => undefined, input: env, output: { payload: { gigKey: p.gigKey, files, plan: p, text }, dataClass: 'P1' as const }, pack: pack as object, fullPack: full };
    for (const g of [G_GROUND, G_FILL]) {
      const v = g.check(ctx);
      if (v.verdict === 'trip') failed.push(`${v.id}: ${v.detail ?? ''}`);
    }
    // the runtime gig-qa check (freelance-v2 review): the opening states no pay or hours
    const terms = gigQaChecks({ gigKey: p.gigKey, files: [], plan: p, text }, pack, { files: new Map(), pdfText: new Map() }).find((c) => c.id === 'cover.no-terms');
    if (terms?.ok !== true) failed.push(`cover.no-terms: ${terms?.detail ?? 'did not run'}`);
  }
  const trips = plan.trips;
  return trips.length === 0 && failed.length === 0 ? { pass: true, cover: p.cover !== undefined } : { pass: false, cover: p.cover !== undefined, trips, failed };
}

/** One description sentence with the profile's pay locale and home currency (the `pay-locale` eval's input). */
const PayText = defineType('PayText', 1, z.object({ text: z.string(), locale: z.enum(PAY_LOCALES), home: z.enum(CURRENCY_CODES) }).strict());
/** The pay read from it, or null. */
const PayRead = defineType(
  'PayRead',
  1,
  z
    .object({
      comp: z
        .object({ min: z.number().nullable(), max: z.number().nullable(), currency: z.enum(CURRENCY_CODES), period: z.literal('year'), basis: z.enum(['base', 'unknown']) })
        .strict()
        .nullable(),
    })
    .strict(),
);
/**
 * Fixed fictional rates for the `pay-locale` eval: the fixture pack's four plus made-up rates for the other currencies
 * its cases use (KRW has none on purpose). Only the plausibility bounds read them.
 */
const PAY_EVAL_FX = { toINR: { USD: 83.5, EUR: 90.2, GBP: 106.4, INR: 1, CAD: 61.2, CHF: 94.1, JPY: 0.56, SEK: 7.9, PLN: 21, BRL: 16.5 } };
/** The eval-only wrapper of `parsePay` (Task 18); not a pipeline agent, so it is not in the contract registry. */
const payLocaleReader = defineAgent(
  defineContract({
    id: 'pay-locale',
    version: '1.0.0',
    description: 'Reads the yearly pay a description states, in the profile\'s locale',
    skills: ['pay-locale'],
    team: 'evaluation',
    kind: 'deterministic',
    consumes: PayText,
    produces: PayRead,
    capabilities: {},
    dataClasses: { in: ['P0'], out: ['P0'] },
    budget: { usdPerCall: 0, usdPerRun: 0 },
    timeoutMs: 10_000,
  }),
  async (i) => [{ comp: parsePay(i.text, { locale: i.locale, home: i.home, fx: PAY_EVAL_FX }) }],
);

/**
 * The app's golden-set evals. They run on the fictional fixture pack (`tests/fixtures/pack`), never the user's own:
 * the public part of it (no contact, no answers), frozen with `freezePack` as the supervisor does, with its hash.
 */
export function appEvalSpecs(datasetDir: string, packDir: string): EvalSpec[] {
  // `loadPack`'s hash is already the hash of the public pack (no contact, no answers), exactly what the agents see.
  const { pack: full, hash } = loadPack(packDir);
  const { contact: _contact, answers: _answers, ...publicPack } = full;
  const pack = freezePack(publicPack);
  // The gig-grounding gate measures grounding on every scored fixture gig, so it runs with the shortlist floor off:
  // proposal-planner plans nothing under `freelance.fitFloor` (Task 9), which its unit tests cover.
  const unfloored = { ...publicPack, freelance: { ...publicPack.freelance, fitFloor: 0 } };
  const gigPack = freezePack(unfloored);
  // The `office-*` eligibility cases run on the fixture pack with one office city (Pune, the fixture candidate's city);
  // every other case runs on the fixture pack as it is, with no office city.
  const withOffice = { ...publicPack, eligibility: { ...publicPack.eligibility, officeCities: ['pune'] } };
  const officePack = freezePack(withOffice);
  const eligibilityCases = loadJsonl(join(datasetDir, 'eligibility.jsonl'));
  const isOffice = (c: { id: string }): boolean => c.id.startsWith('office-');
  const verdictOf = (outs: readonly unknown[]): unknown => one(outs, (o: EligibilityVerdict) => ({ verdict: o.verdict, reasons: o.reasons, notes: o.notes }));
  return [
    {
      agent: eligibility,
      cases: eligibilityCases.filter((c) => !isOffice(c)),
      project: verdictOf,
      metric: 'exactMatch',
      min: 1,
      pack,
      packHash: hash,
    },
    {
      name: 'eligibility-office',
      agent: eligibility,
      cases: eligibilityCases.filter(isOffice),
      project: verdictOf,
      metric: 'exactMatch',
      min: 1,
      pack: officePack,
      packHash: hashOf(withOffice),
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
      project: async (outs) => (outs.length === 1 ? gigGrounding((outs[0] as GigDocsPlan).scored, gigPack) : { plans: outs.length }),
      metric: 'exactMatch',
      min: 1,
      pack: gigPack,
      packHash: hashOf(unfloored),
    },
    {
      // freelance-v2: contract roles from employer job boards (fictional Himalayas recordings and boards postings) and
      // the gigs that must get no letter, through the planner and the cover letter's G-GROUND and G-FILL.
      name: 'gig-cover-grounding',
      agent: proposalPlanner,
      cases: loadJsonl(join(datasetDir, 'gig-cover-grounding.jsonl')),
      project: async (outs) => (outs.length === 1 ? gigCoverGrounding((outs[0] as GigDocsPlan).scored, gigPack) : { plans: outs.length }),
      metric: 'exactMatch',
      min: 1,
      pack: gigPack,
      packHash: hashOf(unfloored),
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
    {
      // NamePair@1 to whether two company names are one company; the labels are hand-written (no alias guessing, no accent folding).
      name: 'coverage-names',
      agent: companyNameMatcher,
      cases: loadJsonl(join(datasetDir, 'coverage-names.jsonl')),
      project: (outs) => one(outs, (o: NameMatch) => ({ same: o.same })),
      metric: 'exactMatch',
      min: 1,
    },
    {
      // A recorded freehire search row to board / lead / drop (jobpilot's own reading of the raw title and location, never
      // freehire's LLM-filled fields); the labels are hand-written from the rules in freehire-api.ts.
      name: 'freehire-rows',
      agent: freehireRowClassifier,
      cases: loadJsonl(join(datasetDir, 'freehire-rows.jsonl')),
      project: (outs) => one(outs, (o: { class: RowClass }) => ({ class: o.class })),
      metric: 'exactMatch',
      min: 1,
    },
    {
      // Task 18: a description's pay read per locale (8 locales x range, single, up to, from, monthly, hourly, headcount,
      // OTE, plus adversarial figures), on fixed fictional rates; the comp, or null when nothing is read.
      name: 'pay-locale',
      agent: payLocaleReader,
      cases: loadJsonl(join(datasetDir, 'pay-locale.jsonl')),
      project: (outs) => one(outs, (o: { comp: unknown }) => o.comp),
      metric: 'exactMatch',
      min: 1,
    },
    {
      // CareersSite@1 to the platform, slug, boardUrl, routedFrom and the verdict code (the evidence's first line up to
      // its colon), on ≥ 40 recorded, trimmed careers pages served from evals/datasets/coverage-detector/ (never the
      // network). Each case gets a fresh run gate, so one case's robots.txt or disabled host never leaks into another.
      name: 'coverage-detector',
      agent: defineAgent(platformDetectorContract, (site, ctx) => makePlatformDetector({ runKey: 'eval', store: memoryHostStateStore() }).run(site, ctx)),
      cases: loadJsonl(join(datasetDir, 'coverage-detector.jsonl')),
      fixtures: { fetch: offlineProviders(join(datasetDir, 'coverage-detector')).fetch, egressSets: (input) => detectorEgressSets([input as CareersSite]) },
      project: (outs) =>
        one(outs, (o: PlatformGuess) => ({ platform: o.platform, slug: o.slug, boardUrl: o.boardUrl, routedFrom: o.routedFrom, verdict: (o.evidence[0] ?? '').split(':')[0] })),
      metric: 'exactMatch',
      min: 1,
    },
  ];
}
