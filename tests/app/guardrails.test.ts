import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coverWriter } from '../../src/app/agents/writing/cover-writer.js';
import { evidenceMatcher } from '../../src/app/agents/writing/evidence-matcher.js';
import { buildEvidence, planCover, planResume, type WritingPack } from '../../src/app/agents/writing/grounded.js';
import { resumePlanner } from '../../src/app/agents/writing/resume-planner.js';
import { eligibility } from '../../src/app/agents/eligibility.js';
import { scorePosting } from '../../src/app/agents/scorer-lexicon.js';
import { appEvalSpecs } from '../../src/app/evals.js';
import { assertNoForbidden } from '../../src/app/pack/rules.js';
import { runEval } from '../../src/evals/runner.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { APP_GUARDRAILS, appGuardrails, G_GROUND, G_NAMING, G_NO_GAP_CLAIM } from '../../src/app/guardrails.js';
import { loadPack } from '../../src/app/pack/load.js';
import { Scored, type CoverPlan, type Evidence, type Posting, type ResumePlan } from '../../src/app/types.js';
import type { AnyContract } from '../../src/kernel/contract.js';
import { contractHash } from '../../src/kernel/contract.js';
import { freezePack, issueContext } from '../../src/kernel/broker.js';
import { ZERO_COST, type Envelope } from '../../src/kernel/envelope.js';
import { builtinGuardrails } from '../../src/kernel/guardrails/builtin.js';
import type { Guardrail, GuardrailContext } from '../../src/kernel/guardrails/index.js';
import { PRODUCT_POLICY_V1, policyHash } from '../../src/kernel/policy.js';
import { Registry } from '../../src/kernel/registry.js';
import { compileWiring, type Pipeline } from '../../src/kernel/wiring.js';

const root = join(import.meta.dirname, '../..');
const { pack: full } = loadPack(join(root, 'tests/fixtures/pack'));
const { contact: _c, answers: _a, ...pub } = full;
const pack = freezePack(pub) as unknown as WritingPack;

const JD =
  'We build event-driven payments services in Java with Spring Boot, Kafka and PostgreSQL on AWS. ' +
  'You will run Kubernetes, Docker, gRPC and Elasticsearch in production. Scala is a plus.';
const posting: Posting = {
  jobKey: '0123456789abcdef', dedupeKey: 'fedcba9876543210', source: 'greenhouse', sourceId: 'w1', company: 'Acme Payments', slug: 'acme',
  ats: 'greenhouse', title: 'Senior Backend Engineer (Java)', url: 'https://jobs.example.com/w1', locationText: 'Remote - India',
  remote: { structured: 'remote', countries: ['india'], signals: ['workplaceType:remote'] }, employmentType: 'Full-time',
  descriptionText: JD, postedAt: '2026-10-01T09:00:00Z', comp: null, yearsRequired: null,
};
const scored = scorePosting({ posting, verdict: 'eligible', reasons: [], notes: [] }, pack as unknown as Parameters<typeof scorePosting>[1]);
const evidence = buildEvidence(scored, pack);
const resume = planResume(evidence, pack);
const cover = planCover(resume, pack);

const clone = <T>(v: T): T => structuredClone(v) as T;
const pHash = policyHash(PRODUCT_POLICY_V1);
const env = (type: string, payload: unknown, producer: AnyContract): Envelope => ({
  envelopeId: 'e1', stepKey: 's1', index: 0, type,
  producer: { agentId: producer.id, version: producer.version, contractHash: contractHash(producer) },
  parents: [], payload,
  handoff: { guarantees: producer.guarantees.map((g) => g.id), dataClass: 'P0', obligations: [], pins: { policyHash: pHash } },
  guardrails: [], cost: ZERO_COST,
});
const ctxOut = (contract: AnyContract, input: Envelope, payload: unknown, p: unknown = pack): GuardrailContext => ({
  side: 'out', contract, policy: PRODUCT_POLICY_V1, policyHash: pHash,
  contractHashOf: () => undefined,
  input, output: { payload, dataClass: 'P0' },
  ...(p !== null && p !== undefined ? { pack: p as object } : {}),
});
const evidenceIn = env('Evidence@1', evidence, evidenceMatcher.contract);
const resumeIn = env('ResumePlan@1', resume, resumePlanner.contract);
const onResume = (g: Guardrail, plan: unknown, input: Envelope = evidenceIn) => g.check(ctxOut(resumePlanner.contract, input, plan));
const onCover = (g: Guardrail, plan: unknown, input: Envelope = resumeIn) => g.check(ctxOut(coverWriter.contract, input, plan));

describe('G-GROUND', () => {
  it('passes the planned resume and cover letter', () => {
    expect(onResume(G_GROUND, resume)).toEqual({ id: 'G-GROUND', verdict: 'pass' });
    expect(onCover(G_GROUND, cover)).toEqual({ id: 'G-GROUND', verdict: 'pass' });
  });

  it('trips when one bullet character changes', () => {
    const p = clone(resume);
    const b = p.roles[0]!.bullets[0]!;
    b.text = b.text.replace('40M', '50M');
    const v = onResume(G_GROUND, p);
    expect(v.verdict).toBe('trip');
    expect(v.detail).toMatch(/roles\[0\]\.bullets\[0\]: text is not fact f-nw-01's claim verbatim/);
  });

  it('trips on a trailing-space or case change too', () => {
    for (const edit of [(t: string) => `${t} `, (t: string) => t.toLowerCase()]) {
      const p = clone(resume);
      p.certs[0]!.text = edit(p.certs[0]!.text);
      expect(onResume(G_GROUND, p).detail).toMatch(/certs\[0\]: text is not fact f-ce-02's claim verbatim/);
    }
  });

  it('trips when a skill has no citeable fact behind it, or is not a lexicon key', () => {
    const go = clone(resume);
    go.skills.push('go');
    expect(onResume(G_GROUND, go).detail).toMatch(/skills: go has no citeable fact behind it/);
    const es = clone(resume);
    es.skills.push('elasticsearch'); // only the user-cannot-confirm f-fb-03 has it
    expect(onResume(G_GROUND, es).detail).toMatch(/skills: elasticsearch has no citeable fact behind it/);
    const cobol = clone(resume);
    cobol.skills.unshift('cobol');
    expect(onResume(G_GROUND, cobol).detail).toMatch(/skills: cobol is not a lexicon key/);
  });

  it('trips when a non-citeable fact is cited, even verbatim', () => {
    for (const id of ['f-nw-05', 'f-ct-04', 'f-fb-03']) {
      const f = pack.facts.find((x) => x.id === id)!;
      const p = clone(resume);
      p.roles[0]!.bullets[3] = { factId: id, text: f.claim };
      expect(onResume(G_GROUND, p).detail, id).toMatch(new RegExp(`fact ${id} is not citeable \\(${f.status}\\)`));
    }
    const unknown = clone(resume);
    unknown.roles[1]!.bullets[0] = { factId: 'f-zz-99', text: 'Did everything.' };
    expect(onResume(G_GROUND, unknown).detail).toMatch(/roles\[1\]\.bullets\[0\]: unknown fact f-zz-99/);
  });

  it("trips when a bullet sits under another employer's role", () => {
    const p = clone(resume);
    p.roles[2]!.bullets[0] = { ...p.roles[0]!.bullets[0]! };
    expect(onResume(G_GROUND, p).detail).toMatch(/roles\[2\]\.bullets\[0\]: fact f-nw-01 is from Northwind Labs, not Fabrikam/);
  });

  it('trips when the summary years are altered, whether or not the text agrees', () => {
    const slotOnly = clone(resume);
    slotOnly.summary.slots['years'] = 12;
    expect(onResume(G_GROUND, slotOnly).detail).toMatch(/summary\.slots\.years is 12, the roles give 10/);
    const both = clone(resume);
    both.summary.slots['years'] = 12;
    both.summary.text = both.summary.text.replace('10+', '12+');
    expect(onResume(G_GROUND, both).detail).toMatch(/summary\.slots\.years is 12, the roles give 10/);
    const textOnly = clone(resume);
    textOnly.summary.text = textOnly.summary.text.replace('10+', '12+');
    expect(onResume(G_GROUND, textOnly).detail).toMatch(/summary\.text is not the template rendering of its computed slots/);
  });

  it('trips when a summary term or the headline is not computed', () => {
    const term = clone(resume);
    term.summary.slots['top1'] = 'go';
    term.summary.text = term.summary.text.replace('java,', 'go,');
    expect(onResume(G_GROUND, term).detail).toMatch(/summary\.slots differ from the computed slots/);
    const head = clone(resume);
    head.headline = 'Principal Architect';
    expect(onResume(G_GROUND, head).detail).toMatch(/headline is not the computed target title/);
  });

  it('re-derives the evidence instead of trusting it', () => {
    const p = clone(resume);
    p.evidence.ranked.unshift({ factId: 'f-nw-05', employer: 'Northwind Labs', rank: 99, matched: ['aws'] });
    // the input envelope carries the same tampered evidence, so only the re-derivation can catch it
    const v = onResume(G_GROUND, p, env('Evidence@1', p.evidence, evidenceMatcher.contract));
    expect(v.detail).toMatch(/evidence is not what the posting and the pack give \(at ranked\[0\]/);
  });

  it('trips when the plan does not carry its input evidence', () => {
    const other = { ...evidence, missing: [] } satisfies Evidence;
    expect(onResume(G_GROUND, resume, env('Evidence@1', other, evidenceMatcher.contract)).detail).toMatch(/evidence differs from the input Evidence@1/);
  });

  it('trips when a cover paragraph is altered', () => {
    const p = clone(cover);
    p.paragraphs[0]!.text = p.paragraphs[0]!.text.replace('10+', '15+');
    expect(onCover(G_GROUND, p).detail).toMatch(/paragraphs\[0\] is not the template rendering/);
    const claim = clone(cover);
    claim.paragraphs[1]!.text = claim.paragraphs[1]!.text.replace('2M', '20M');
    expect(onCover(G_GROUND, claim).detail).toMatch(/paragraphs\[1\]: fact f-ct-01's claim is not in the text verbatim/);
    const extra = clone(cover);
    extra.paragraphs.splice(3, 0, { text: 'I am the best engineer you will ever meet.', factIds: [] });
    expect(onCover(G_GROUND, extra).detail).toMatch(/paragraphs\[3\] is not the template rendering/);
  });

  it('trips when the renderer placeholders are filled in or a non-citeable fact is cited in the cover', () => {
    const filled = clone(cover);
    filled.paragraphs[3]!.text = filled.paragraphs[3]!.text.replace('{notice}', '30 days');
    expect(onCover(G_GROUND, filled).detail).toMatch(/paragraphs\[3\] is not the template rendering/);
    const f = pack.facts.find((x) => x.id === 'f-nw-05')!;
    const bad = clone(cover);
    bad.paragraphs[2] = { text: f.claim, factIds: ['f-nw-05'] };
    expect(onCover(G_GROUND, bad).detail).toMatch(/paragraphs\[2\]: fact f-nw-05 is not citeable \(derived-unverified\)/);
  });

  it('checks the resume inside the cover plan, and that it is the input plan', () => {
    const p = clone(cover);
    p.resume.roles[0]!.bullets[0]!.text += '!';
    expect(onCover(G_GROUND, p).detail).toMatch(/resume differs from the input ResumePlan@1/);
    expect(onCover(G_GROUND, p, env('ResumePlan@1', p.resume, resumePlanner.contract)).detail).toMatch(/resume\.roles\[0\]\.bullets\[0\]: text is not fact f-nw-01's claim verbatim/);
  });

  it('fails closed without a pack, without an output, or on a type it does not know', () => {
    expect(G_GROUND.check(ctxOut(resumePlanner.contract, evidenceIn, resume, null)).detail).toMatch(/no pack/);
    expect(G_GROUND.check({ ...ctxOut(resumePlanner.contract, evidenceIn, resume), output: undefined } as unknown as GuardrailContext).verdict).toBe('trip');
    expect(G_GROUND.check(ctxOut(evidenceMatcher.contract, env('Scored@1', scored, evidenceMatcher.contract), evidence)).detail).toMatch(/only ResumePlan@1 and CoverPlan@1/);
    expect(onResume(G_GROUND, { ...resume, extra: 1 }).detail).toMatch(/not a valid ResumePlan@1/);
  });
});

describe('G-NAMING', () => {
  it('passes clean writing outputs', () => {
    expect(G_NAMING.check(ctxOut(evidenceMatcher.contract, env('Scored@1', scored, evidenceMatcher.contract), evidence))).toEqual({ id: 'G-NAMING', verdict: 'pass' });
    expect(onResume(G_NAMING, resume)).toEqual({ id: 'G-NAMING', verdict: 'pass' });
    expect(onCover(G_NAMING, cover)).toEqual({ id: 'G-NAMING', verdict: 'pass' });
  });

  it('trips on an injected forbidden term, lookalike spellings included, and never echoes the term', () => {
    for (const term of ['Initech', 'INITECH', 'Ini\u0442ech', 'Init\u03b5ch', 'Init\u200bech', '\u0130nitech']) {
      const p = clone(resume);
      p.roles[0]!.bullets[1]!.text = `Shipped the ${term} migration.`;
      const v = onResume(G_NAMING, p);
      expect(v.verdict, term).toBe('trip');
      expect(v.detail).toBe('forbidden term #1 appears in roles[0].bullets[1].text');
      expect(v.detail?.toLowerCase()).not.toContain('initech');
    }
    const company = clone(cover);
    company.paragraphs[0]!.text = company.paragraphs[0]!.text.replace('Acme Payments', 'Initech');
    expect(onCover(G_NAMING, company).detail).toBe('forbidden term #1 appears in paragraphs[0].text');
    const key = clone(resume);
    key.summary.slots['Initech'] = 1;
    expect(onResume(G_NAMING, key).detail).toBe('forbidden term #1 appears in summary.slots (a key)');
  });

  it('fails closed without a pack', () => {
    expect(G_NAMING.check(ctxOut(resumePlanner.contract, evidenceIn, resume, null)).detail).toMatch(/no pack/);
  });
});

describe('G-NO-GAP-CLAIM', () => {
  it('passes a plan with no gap skill', () => {
    expect(onResume(G_NO_GAP_CLAIM, resume)).toEqual({ id: 'G-NO-GAP-CLAIM', verdict: 'pass' });
    expect(onCover(G_NO_GAP_CLAIM, cover)).toEqual({ id: 'G-NO-GAP-CLAIM', verdict: 'pass' });
  });
  it('trips on a gap key or a gap synonym in the skills line', () => {
    for (const s of ['scala', 'Scala', 'C#', '.NET']) {
      const p = clone(resume);
      p.skills.push(s);
      expect(onResume(G_NO_GAP_CLAIM, p).detail, s).toBe(`skills: ${s} is a gap skill`);
    }
    const c = clone(cover);
    c.resume.skills.push('rust');
    expect(onCover(G_NO_GAP_CLAIM, c).detail).toBe('resume.skills: rust is a gap skill');
  });
});

describe('app guardrail registration', () => {
  const writingPipeline: Pipeline = {
    id: 'writing-only',
    version: '1.0.0',
    seed: { type: Scored, guarantees: [] },
    teams: [{ id: 'writing', lead: 'writing-lead', members: ['evidence-matcher', 'resume-planner', 'cover-writer'], exitGuarantees: [], breaker: { consecutiveFailures: 3 } }],
    edges: [
      { type: 'Scored@1', to: 'evidence-matcher' },
      { type: 'Evidence@1', to: 'resume-planner' },
      { type: 'ResumePlan@1', to: 'cover-writer' },
    ],
  };
  const registry = new Registry();
  for (const a of [evidenceMatcher, resumePlanner, coverWriter]) registry.register(a);

  it('registers the three app guardrails beside the built-ins', () => {
    expect(APP_GUARDRAILS.map((g) => g.id)).toEqual(['G-GROUND', 'G-NAMING', 'G-NO-GAP-CLAIM']);
    for (const g of APP_GUARDRAILS) expect(g.sides).toEqual(['out']);
    const reg = appGuardrails();
    for (const id of ['G-SCHEMA', 'G-POST', 'G-GROUND', 'G-NAMING', 'G-NO-GAP-CLAIM']) expect(reg.has(id), id).toBe(true);
  });

  it('lets the wiring compiler accept contracts that list them, and only with them registered', () => {
    expect(() => compileWiring(registry, writingPipeline, appGuardrails())).not.toThrow();
    expect(() => compileWiring(registry, writingPipeline, builtinGuardrails())).toThrow(/lists unknown guardrail G-GROUND/);
  });

  it('runs after the mandatory ones and passes a planned resume', () => {
    const r = appGuardrails().run('out', ctxOut(resumePlanner.contract, evidenceIn, resume));
    expect(r.tripped).toBe(false);
    expect(r.verdicts.map((v) => v.id)).toEqual(['G-SCHEMA', 'G-DATACLASS', 'G-POST', 'G-GROUND', 'G-NAMING', 'G-NO-GAP-CLAIM']);
  });
});

// Typing aid: the clones above stay assignable to the plan types.
export type _Plans = [ResumePlan, CoverPlan];

describe('grounding golden eval', () => {
  const specs = appEvalSpecs(join(root, 'evals/datasets'), join(root, 'tests/fixtures/pack'));
  const spec = specs.find((s) => s.name === 'grounding')!;

  it('is registered, runs evidence-matcher then both planners, and passes its gate of 1.0', async () => {
    expect(spec).toBeDefined();
    expect(spec.agent.contract.id).toBe('evidence-matcher');
    expect(spec).toMatchObject({ metric: 'exactMatch', min: 1 });
    for (const c of spec.cases) expect(c.expected, c.id).toEqual({ pass: true });
    const r = await runEval(spec, { providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, policy: PRODUCT_POLICY_V1 });
    expect(r.failures).toEqual([]);
    expect(r).toMatchObject({ name: 'grounding', score: 1, pass: true, n: spec.cases.length });
  });

  it('holds every real fixture posting that clears minFit, each exactly as the scorer scores it today', async () => {
    const elig = specs.find((s) => s.agent.contract.id === 'eligibility')!;
    const real: string[] = [];
    for (const c of elig.cases.filter((k) => k.id.startsWith('real-'))) {
      const ctx = issueContext({ contract: eligibility.contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, clock: fixedClock('2026-01-01T00:00:00Z'), signal: AbortSignal.timeout(5000), pack });
      const [v] = await eligibility.run(c.input as Posting, ctx);
      if (v === undefined || v.verdict === 'rejected') continue;
      const s = scorePosting(v, pack as unknown as Parameters<typeof scorePosting>[1]);
      if (s.score < pack.targets.minFit) continue;
      real.push(c.id);
      expect(spec.cases.find((k) => k.id === c.id)?.input, c.id).toEqual(s);
    }
    expect(real.length).toBeGreaterThanOrEqual(2);
    expect(spec.cases.filter((k) => k.id.startsWith('real-')).map((k) => k.id).sort()).toEqual(real.sort());
  });

  it('synthetic cases are honest Scored inputs: rescoring gives the same, at or above minFit, covering the edge cases', () => {
    const syn = spec.cases.filter((k) => k.id.startsWith('syn-'));
    expect(syn.length).toBeGreaterThanOrEqual(5);
    for (const k of syn) {
      const s = k.input as Scored;
      expect(s.score, k.id).toBeGreaterThanOrEqual(pack.targets.minFit);
      expect(scorePosting({ posting: s.posting, verdict: s.verdict, reasons: [], notes: s.notes }, pack as unknown as Parameters<typeof scorePosting>[1]), k.id).toEqual(s);
    }
    const plans = syn.map((k) => planResume(buildEvidence(k.input as Scored, pack), pack));
    expect(plans.some((p) => p.covered.length === 0)).toBe(true); // the summary without its building clause
    expect(plans.some((p) => p.covered.length > 0 && p.covered.length < 4)).toBe(true); // dropped term slots
    expect(syn.some((k) => (k.input as Scored).posting.postedAt === null)).toBe(true); // the firstSeen fallback
    expect(syn.some((k) => (k.input as Scored).jdTerms.gap.length >= 3)).toBe(true);
  });

  it('reports a trip as a failure, never as a pass', async () => {
    const tampered = clone(evidence);
    tampered.ranked.unshift({ factId: 'f-nw-05', employer: 'Northwind Labs', rank: 99, matched: ['aws'] });
    const actual = (await spec.project([tampered])) as { pass: boolean; trips: string[] };
    expect(actual.pass).toBe(false);
    expect(actual.trips[0]).toMatch(/^resume-planner G-GROUND: evidence is not what the posting and the pack give/);
    expect(await spec.project([])).toEqual({ outputs: 0 });
  });

  it('carries no forbidden fixture term', () => {
    assertNoForbidden(readFileSync(join(root, 'evals/datasets/grounding.jsonl'), 'utf8'), full.naming);
  });
});
