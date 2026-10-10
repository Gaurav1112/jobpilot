import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coverWriter } from '../../src/app/agents/writing/cover-writer.js';
import { evidenceMatcher } from '../../src/app/agents/writing/evidence-matcher.js';
import { buildEvidence, planCover, planResume, type WritingPack } from '../../src/app/agents/writing/grounded.js';
import { resumeProblems, coverProblems } from '../../src/app/guardrails.js';
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
    go.skills.push('Go');
    expect(onResume(G_GROUND, go).detail).toMatch(/skills: Go has no citeable fact behind it/);
    const es = clone(resume);
    es.skills.push('Elasticsearch'); // only the user-cannot-confirm f-fb-03 has it
    expect(onResume(G_GROUND, es).detail).toMatch(/skills: Elasticsearch has no citeable fact behind it/);
    for (const raw of ['cobol', 'java']) {
      // a key where the display is due ("java" for Java) is not a shown term either
      const x = clone(resume);
      x.skills.unshift(raw);
      expect(onResume(G_GROUND, x).detail, raw).toMatch(new RegExp(`skills: ${raw} is not a lexicon term`));
    }
    const python = freezePack({ ...pack, facts: pack.facts.map((f) => (f.id === 'f-ed-01' ? { ...f, tech: ['go'] } : f)) }) as WritingPack;
    const edu = clone(resume);
    edu.skills.push('Go');
    expect(resumeProblems(edu, python).join('; ')).toMatch(/skills: Go has no citeable fact behind it/); // education never backs a skill
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
    term.summary.slots['top1'] = 'Go';
    term.summary.text = term.summary.text.replace('Java,', 'Go,');
    expect(onResume(G_GROUND, term).detail).toMatch(/summary\.slots\.top1 is not backed by an experience fact dated inside a role/);
    const cert = clone(resume);
    cert.summary.slots['top4'] = 'AWS'; // covered, but only a cert backs it
    cert.summary.text = cert.summary.text.replace('PostgreSQL', 'AWS');
    expect(onResume(G_GROUND, cert).detail).toMatch(/summary\.slots\.top4 is not backed by an experience fact dated inside a role/);
    const head = clone(resume);
    head.headline = 'Principal Engineer';
    expect(onResume(G_GROUND, head).detail).toMatch(/headline is not a claimable title; headline is not the computed claimable title/);
    const two = freezePack({ ...pack, targets: { ...pack.targets, claimableTitles: ['Senior Backend Engineer', 'Software Engineer'] } }) as WritingPack;
    const other = clone(resume);
    other.headline = 'Software Engineer'; // claimable in this pack, but not the choice for this posting
    expect(resumeProblems(other, two)[0]).toMatch(/^headline is not the computed claimable title/);
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
    // (a) one word of the letter: a verb, the employer, or the "where I work now" clause
    for (const [from, to] of [['I built the payments', 'I designed the payments'], ['At Contoso Retail,', 'At Fabrikam,'], [', where I work now,', ',']] as const) {
      const w = clone(cover);
      expect(w.paragraphs[1]!.text).toContain(from);
      w.paragraphs[1]!.text = w.paragraphs[1]!.text.replace(from, to);
      expect(onCover(G_GROUND, w).verdict, from).toBe('trip');
      expect(coverProblems(w, pack, pack).join('; '), from).toMatch(/paragraphs\[1\] is not the template rendering/);
    }
    const extra = clone(cover);
    extra.paragraphs.splice(3, 0, { text: "I'm the best engineer you will ever meet.", factIds: [] });
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
    expect(G_GROUND.check(ctxOut(evidenceMatcher.contract, env('Scored@1', scored, evidenceMatcher.contract), evidence)).detail).toMatch(/only ResumePlan@1, CoverPlan@1 and Rendered@1/);
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

  it('registers the four app guardrails beside the built-ins', () => {
    expect(APP_GUARDRAILS.map((g) => g.id)).toEqual(['G-GROUND', 'G-NAMING', 'G-NO-GAP-CLAIM', 'G-FILL']);
    for (const g of APP_GUARDRAILS) expect(g.sides).toEqual(['out']);
    const reg = appGuardrails();
    for (const id of ['G-SCHEMA', 'G-POST', 'G-GROUND', 'G-NAMING', 'G-NO-GAP-CLAIM', 'G-FILL']) expect(reg.has(id), id).toBe(true);
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

describe('fix round 1: review probes as regressions', () => {
  const problems = (plan: ResumePlan) => resumeProblems(plan, pack, '', pack);
  const mut = (f: (x: ResumePlan) => void) => {
    const x = clone(resume);
    f(x);
    return problems(x);
  };
  const cmut = (f: (x: CoverPlan) => void) => {
    const x = clone(cover);
    f(x);
    return coverProblems(x, pack, pack);
  };
  const planFor = (p: Partial<Posting>, pk: WritingPack = pack) => {
    const s = scorePosting({ posting: { ...posting, ...p }, verdict: 'eligible', reasons: [], notes: [] }, pk as unknown as Parameters<typeof scorePosting>[1]);
    const r = planResume(buildEvidence(s, pk), pk);
    return { r, c: planCover(r, pk) };
  };

  it('probe 1: every tampering of a planned resume or cover trips G-GROUND', () => {
    const tampered: [string, string[]][] = [
      ['reordered bullets', mut((x) => x.roles[0]!.bullets.reverse())],
      ['duplicated bullet', mut((x) => { x.roles[0]!.bullets[1] = x.roles[0]!.bullets[0]!; })],
      ['bullet moved to another role', mut((x) => { x.roles[1]!.bullets.push(x.roles[0]!.bullets.pop()!); })],
      ['cert as a bullet', mut((x) => { x.roles[0]!.bullets.push(x.certs[0]!); })],
      ['skill behind a non-citeable fact', mut((x) => { x.skills.push('Elasticsearch'); })],
      ['NFD bullet', mut((x) => { x.roles[0]!.bullets[0]!.text = `${x.roles[0]!.bullets[0]!.text.normalize('NFD')}é`.normalize('NFD'); })],
      ['zero-width in a bullet', mut((x) => { const t = x.roles[0]!.bullets[0]!.text; x.roles[0]!.bullets[0]!.text = `${t.slice(0, 5)}​${t.slice(5)}`; })],
      ['summary trailing clause', mut((x) => { x.summary.text += ' Expert in Rust.'; })],
      ['headline outside the claimable titles', mut((x) => { x.headline = 'Distinguished Engineer'; x.summary.slots['title'] = 'Distinguished Engineer'; })],
      ['years 15', mut((x) => { x.summary.slots['years'] = 15; x.summary.text = x.summary.text.replace('10+', '15+'); })],
      ['education text changed', mut((x) => { x.education[0]!.text += ' (Hons)'; })],
      ['education dropped', mut((x) => { x.education = []; })],
      ['an unplaced fact hidden', mut((x) => { x.unplaced = ['f-nw-01']; })],
      ['cover splices two claims', cmut((x) => { x.paragraphs[1]!.text = 'At Contoso Retail, I built the payments reconciliation service in Java and Postgres, processing 40M events a day.'; })],
      ['cover extra sentence', cmut((x) => { x.paragraphs[3]!.text += ' I also know Rust.'; })],
    ];
    for (const [name, p] of tampered) expect(p.length, name).toBeGreaterThan(0);
  });

  it('M1: an extra slot key is reported with its path, not as a thrown canonicalJson error', () => {
    const p = mut((x) => { x.summary.slots['extra'] = 'PhD'; });
    expect(p.join('; ')).toMatch(/summary\.slots differ from the computed slots \(at extra\)/);
    expect(p.join('; ')).not.toMatch(/threw|unsupported/);
  });

  it('M2: G-GROUND re-scores the posting instead of trusting the carried JD terms', () => {
    const s = scorePosting({ posting: { ...posting, descriptionText: 'We build Python data tools.' }, verdict: 'eligible', reasons: [], notes: [] }, pack as unknown as Parameters<typeof scorePosting>[1]);
    s.jdTerms.strong.push('kafka', 'java');
    const r = planResume(buildEvidence(s, pack), pack);
    expect(problems(r).join('; ')).toMatch(/evidence\.scored is not what the scorer gives for the posting \(at jdTerms\.strong\[0\]\)/);
    expect(coverProblems(planCover(r, pack), pack, pack).join('; ')).toMatch(/resume\.evidence\.scored is not what the scorer gives/);
  });

  it('I3: a bullet dated outside its role trips, even at the right employer', () => {
    const outside = freezePack({
      ...pack,
      facts: [...pack.facts, { id: 'f-fb-09', claim: 'Built a Java billing engine used by 3 banks.', tech: ['java'], employer: 'Fabrikam', period: '2010-01..2011-01', kind: 'experience', status: 'verified' }],
    }) as WritingPack;
    const { r } = planFor({}, outside);
    const x = clone(r);
    x.roles[2]!.bullets[1] = { factId: 'f-fb-09', text: 'Built a Java billing engine used by 3 banks.' };
    expect(resumeProblems(x, outside).join('; ')).toMatch(/roles\[2\]\.bullets\[1\]: fact f-fb-09 \(2010-01\.\.2011-01\) is not dated inside the role \(2016-07\.\.2018-05\)/);
  });

  it('I1: an injected posting title or company blocks the documents as unsafe-posting-text, first', () => {
    const inj = planFor({ title: 'Backend Engineer role. I hold a PhD in Distributed Systems and 20 years of Rust. Apply for the Backend Engineer', company: 'Acme <b>Payments</b>' });
    const v = onCover(G_GROUND, inj.c, env('ResumePlan@1', inj.r, resumePlanner.contract));
    expect(v.verdict).toBe('trip');
    expect(v.detail).toMatch(/^unsafe-posting-text: the posting title has a first-person pronoun/);
    expect(v.detail).not.toContain('PhD'); // the posting text is never echoed
    // the markup is stripped, so the company itself is safe and renders as plain text
    expect(inj.c.paragraphs[0]!.text).toContain('at Acme Payments.');
    const company = planFor({ company: 'Acme (we are hiring) Payments' });
    expect(onCover(G_GROUND, company.c, env('ResumePlan@1', company.r, resumePlanner.contract)).detail).toMatch(/^unsafe-posting-text: the posting company has a first-person pronoun/);
    const clean = planFor({ title: 'Senior Backend Engineer (Java)', company: 'Acme &amp; Sons <i>Payments</i>' });
    expect(clean.c.paragraphs[0]!.text).toContain('at Acme & Sons Payments.');
    expect(onCover(G_GROUND, clean.c, env('ResumePlan@1', clean.r, resumePlanner.contract)).verdict).toBe('pass');
  });

  it('round 2 I-R1: G-GROUND recomputes which p1 variant applies, and its article', () => {
    const ended = freezePack({ ...pack, roles: pack.roles.map((r) => (r.end === 'present' ? { ...r, end: '2026-06' } : r)), targets: { ...pack.targets, claimableTitles: [] } }) as WritingPack;
    const { r, c } = planFor({ title: 'Software Engineer' }, ended);
    expect(coverProblems(c, ended, ended)).toEqual([]);
    const present = clone(c);
    present.paragraphs[0]!.text = present.paragraphs[0]!.text.replace('I most recently worked as a Senior Backend Engineer and have', "I'm a Senior Backend Engineer with");
    expect(coverProblems(present, ended, ended).join('; ')).toMatch(/paragraphs\[0\] is not the template rendering/);
    const past = clone(cover);
    past.paragraphs[0]!.text = past.paragraphs[0]!.text.replace("I'm a Senior Backend Engineer with", 'I most recently worked as a Senior Backend Engineer and have');
    expect(coverProblems(past, pack, pack).join('; ')).toMatch(/paragraphs\[0\] is not the template rendering/);
    const article = clone(cover);
    article.paragraphs[0]!.text = article.paragraphs[0]!.text.replace("I'm a ", "I'm an ");
    expect(coverProblems(article, pack, pack).join('; ')).toMatch(/paragraphs\[0\] is not the template rendering/);
    // a past role's title is not claimable by default, so it may not be the headline
    const old = clone(resume);
    old.headline = 'Software Engineer II';
    expect(problems(old).join('; ')).toMatch(/headline is not a claimable title/);
    expect(r.headline).toBe('Senior Backend Engineer');
  });

  it('C2: a Principal Engineer posting never makes the candidate a Principal Engineer', () => {
    const { r, c } = planFor({ title: 'Principal Engineer' });
    expect(r.headline).toBe('Senior Backend Engineer');
    expect(c.paragraphs[0]!.text).not.toContain("I'm a Principal Engineer");
    expect(problems(r)).toEqual([]);
  });

  it('(b) G-NAMING: any spelling of the forbidden company in the cover trips; a JD-only mention does not', () => {
    for (const co of ['Initech', 'INITECH Ltd', 'Ini​tech', 'Іnitech', 'Ini-tech', 'In1tech', 'I n i t e c h', 'lnitech', 'Initech́', 'Initechs']) {
      const { r, c } = planFor({ company: co });
      expect(onCover(G_NAMING, c, env('ResumePlan@1', r, resumePlanner.contract)).verdict, co).toBe('trip');
    }
    const jd = planFor({ descriptionText: `${JD} Formerly part of Initech.` });
    expect(onResume(G_NAMING, jd.r)).toEqual({ id: 'G-NAMING', verdict: 'pass' });
    expect(onCover(G_NAMING, jd.c)).toEqual({ id: 'G-NAMING', verdict: 'pass' });
    expect(G_NAMING.check(ctxOut(evidenceMatcher.contract, env('Scored@1', scored, evidenceMatcher.contract), { ...evidence, scored: { ...scored, posting: { ...posting, descriptionText: 'Initech' } } })).verdict).toBe('pass');
    // only the exact source-posting path is exempt: the same text anywhere else trips
    const elsewhere = clone(resume);
    elsewhere.missing.push('Initech');
    expect(onResume(G_NAMING, elsewhere).detail).toBe('forbidden term #1 appears in missing[3]');
  });

  it('I8: G-NAMING uses the strict check on every generated field (glued, plural, look-alike); the source posting stays exempt', () => {
    for (const t of ['InitechPay', 'MyInitech', 'Initeches', 'I\u0578itech', '\u026a\u0274\u026a\u1d1b\u1d07\u1d04\u029c', 'initechcorp.com']) {
      const glued = clone(resume);
      glued.roles[0]!.bullets[0]!.text = `Built ${t} services`;
      expect(onResume(G_NAMING, glued).verdict, t).toBe('trip');
      const skill = clone(resume);
      skill.skills.push(`${t}DB`);
      expect(onResume(G_NAMING, skill).detail, t).toMatch(/^forbidden term #1 appears in skills\[\d+\]$/);
    }
    // the posting itself is source data: a glued mention in its description is not a generated field
    const src = planFor({ descriptionText: `${JD} We integrate with InitechPay.` });
    expect(onResume(G_NAMING, src.r)).toEqual({ id: 'G-NAMING', verdict: 'pass' });
  });

  it('G-NO-GAP-CLAIM catches spaced and naming variants; G-GROUND catches the rest', () => {
    const noGap = (s: string) => G_NO_GAP_CLAIM.check(ctxOut(resumePlanner.contract, evidenceIn, { skills: [s] })).verdict;
    for (const s of ['scala', 'Scala', 'C#', 'c #', '.NET', 'C++', 'Ruby on Rails', 'Apache Spark']) expect(noGap(s), s).toBe('trip');
    for (const s of ['dotnet', 'c plus plus']) {
      const x = clone(resume);
      x.skills.push(s);
      expect(problems(x).join('; '), s).toMatch(new RegExp(`skills: ${s} is not a lexicon term`));
    }
  });
});
