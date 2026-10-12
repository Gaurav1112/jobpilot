import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_ALLOW_LIST, capabilityProblems } from '../../../src/app/allow-list.js';
import type { WritingPack } from '../../../src/app/agents/writing/grounded.js';
import { gigQa, gigQaChecks, gigQaContract, repeatKey, type GigQaInputs } from '../../../src/app/freelance/writing/gig-qa.js';
import { freelanceDocsPacks, gigPath, gigRenderer, gigRendererContract } from '../../../src/app/freelance/writing/gig-renderer.js';
import { asciiPunct, PHRASES, variantOf } from '../../../src/app/freelance/writing/phrases.js';
import { pitchText } from '../../../src/app/freelance/writing/pitch-planner.js';
import { cadenceOf, DEFAULT_CADENCE, hookQuote, planGigDocs, proposalPlanner, proposalPlannerContract, proposalText } from '../../../src/app/freelance/writing/proposal-planner.js';
import { GigDocsPlan, GigQaReport, GigRendered, type ScoredGig } from '../../../src/app/freelance/types.js';
import { appGuardrails, G_GROUND, G_NAMING, gigDocsProblems, resumeProblems } from '../../../src/app/guardrails.js';
import { loadRunPack } from '../../../src/app/kernel.js';
import type { Pack } from '../../../src/app/pack/schema.js';
import { forbiddenTermStrict } from '../../../src/app/pack/rules.js';
import { type AnyAgent } from '../../../src/kernel/agent.js';
import { freezePack, issueContext } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { contractHash } from '../../../src/kernel/contract.js';
import { type Envelope, ZERO_COST } from '../../../src/kernel/envelope.js';
import { executeStep } from '../../../src/kernel/executor.js';
import { commitPending, openPending, type PendingFiles } from '../../../src/kernel/files.js';
import type { GuardrailContext } from '../../../src/kernel/guardrails/index.js';
import { PRODUCT_POLICY_V1, policyHash } from '../../../src/kernel/policy.js';
import { pdftotextProvider } from '../../../src/kernel/providers.js';
import { Store } from '../../../src/kernel/store/store.js';
import { fixturePack, fixtureScoredGigs, packDir, scoredGig } from '../../support/gig-fixtures.js';

const PDFTOTEXT = ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', '/usr/bin/pdftotext'].find((p) => existsSync(p));
const withPdftotext = PDFTOTEXT === undefined ? it.skip : it;

const { full, pub } = fixturePack();
const wpack = pub as unknown as WritingPack;
const naming = { forbiddenTerms: full.naming.forbiddenTerms };
const fixtures = await fixtureScoredGigs(pub);
const gigsOnly = fixtures.filter((s) => s.risked.verdict.rated.gig.kind === 'gig');
const contracts = fixtures.filter((s) => s.risked.verdict.rated.gig.kind === 'contract');
const planOf = (s: ScoredGig, pack: unknown = pub): GigDocsPlan => {
  const p = planGigDocs(s, pack);
  if (p === undefined) throw new Error('no plan');
  return p;
};
const textOf = (p: GigDocsPlan): string => (p.proposal !== null ? proposalText(p.proposal, DEFAULT_CADENCE) : pitchText(p.pitch!, DEFAULT_CADENCE));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** Two gig keys whose first 8 hex digits give different variants modulo n. */
const keyWith = (v: number, n: number): string => (v + n * 7).toString(16).padStart(8, '0') + '00000000';

describe('fixture coverage', () => {
  it('has at least 20 scored fixture gigs, of both kinds', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
    expect(gigsOnly.length).toBeGreaterThan(0);
    expect(contracts.length).toBeGreaterThan(0);
  });
});

describe('proposal-planner', () => {
  it('a Freelancer fixture gig gets a proposal within 1500 characters and its hook within 150', () => {
    for (const s of gigsOnly) {
      const p = planOf(s);
      expect(p.proposal, s.risked.verdict.rated.gig.sourceId).not.toBeNull();
      expect(p.pitch).toBeNull();
      expect([...textOf(p)].length, s.risked.verdict.rated.gig.sourceId).toBeLessThanOrEqual(1500);
      expect([...p.proposal!.hook.text].length).toBeLessThanOrEqual(150);
    }
  });

  it('the hook quote is a verbatim substring of the description, cut only at a sentence end or a word with "..." outside the quote', () => {
    const p = planOf(scoredGig());
    const desc = scoredGig().risked.verdict.rated.gig.description;
    expect(p.proposal!.hook.quote).not.toBeNull();
    expect(desc).toContain(p.proposal!.hook.quote!);
    expect(p.proposal!.hook.text).toContain(`"${p.proposal!.hook.quote}"`);
    let quoted = 0;
    for (const s of fixtures) {
      const plan = planOf(s);
      const hook = plan.proposal?.hook ?? null;
      if (hook === null || hook.quote === null) continue;
      quoted++;
      expect(s.risked.verdict.rated.gig.description.replace(/\s+/g, ' ').trim()).toContain(hook.quote);
      expect(hook.text).toMatch(/"(\.\.\.)?/);
    }
    expect(quoted).toBeGreaterThan(0);
  });

  it('hookQuote: first sentence with a matched term; long sentences cut at a word boundary within the limit', () => {
    const groups = [{ key: 'kafka', synonyms: [] }];
    expect(hookQuote('We are a team. We use Kafka daily. Kafka again.', groups, groups, 140)).toEqual({ quote: 'We use Kafka daily.', cut: false });
    const long = `We need ${'very '.repeat(30)}good Kafka people. Next.`;
    const q = hookQuote(`We need Kafka for ${'many '.repeat(40)}things.`, groups, groups, 60);
    expect(q?.cut).toBe(true);
    expect(q?.quote.length).toBeLessThanOrEqual(60);
    expect(q?.quote.endsWith(' ')).toBe(false);
    expect(hookQuote(long, groups, groups, 60)).toBeNull(); // the term lies past the cut
    expect(hookQuote('Mail me at a@b.com about Kafka. Nothing else.', groups, groups, 140)).toBeNull();
    expect(hookQuote('We use “Kafka” daily.', groups, groups, 140)).toBeNull(); // non-ASCII punctuation is never quoted
    // never a list, a stray list number or a line about the bidder
    expect(hookQuote('Ideal Skills: Kafka, Java and Go.', groups, groups, 140)).toBeNull();
    expect(hookQuote('We use Kafka, Java, Go, Redis, and AWS.', groups, groups, 140)).toBeNull();
    expect(hookQuote('Kafka deployment configuration 9.', groups, groups, 140)).toBeNull();
    expect(hookQuote('You have shipped Kafka consumers before.', groups, groups, 140)).toBeNull();
    expect(hookQuote('- We run Kafka in production.', groups, groups, 140)).toEqual({ quote: 'We run Kafka in production.', cut: false });
  });

  it('every evidence line carries the fact ids of verbatim resume bullets', () => {
    const p = planOf(scoredGig());
    expect(p.proposal!.evidence.length).toBeGreaterThanOrEqual(2);
    const bullets = new Map(p.resume.roles.flatMap((r) => r.bullets.map((b) => [b.factId, b.text] as const)));
    for (const e of p.proposal!.evidence) {
      expect(e.factIds.length).toBeGreaterThan(0);
      for (const id of e.factIds) {
        const claim = bullets.get(id);
        expect(claim, id).toBeDefined();
        const c = asciiPunct(claim!);
        expect(e.text.includes(c) || e.text.includes(`${c.charAt(0).toLowerCase()}${c.slice(1)}`), e.text).toBe(true);
      }
    }
    for (const s of fixtures) {
      const plan = planOf(s);
      for (const e of [...(plan.proposal?.evidence ?? []), ...(plan.pitch?.lines.filter((l) => l.factIds.length > 0) ?? [])]) expect(e.factIds.length).toBeGreaterThan(0);
    }
  });

  it('a missing term appears in the question, by its display name', () => {
    const p = planOf(scoredGig());
    expect(p.missing).toContain('scala');
    expect(p.proposal!.question).toContain('Scala');
    const none = planOf(scoredGig({ description: 'We need event-driven Java services with Kafka. They run on AWS.', skills: [] }));
    expect(none.missing).toEqual([]);
    expect(PHRASES.scopeQuestion).toContain(none.proposal!.question);
  });

  it('the variant is stable for one gigKey and differs across gig keys with different % n', () => {
    const n = PHRASES.hook.length;
    expect(variantOf(keyWith(0, n), n)).toBe(variantOf(keyWith(0, n), n));
    expect(variantOf(keyWith(0, n), n)).not.toBe(variantOf(keyWith(1, n), n));
    const a = planOf(scoredGig({ gigKey: keyWith(0, n) }));
    const b = planOf(scoredGig({ gigKey: keyWith(1, n) }));
    expect(planOf(scoredGig({ gigKey: keyWith(0, n) }))).toEqual(a);
    expect(a.proposal!.hook.text).not.toBe(b.proposal!.hook.text);
    expect(repeatKey(proposalText(a.proposal!, DEFAULT_CADENCE))).not.toBe(repeatKey(proposalText(b.proposal!, DEFAULT_CADENCE)));
  });

  it('the plan steps come from the step library of the top covered term group', () => {
    const p = planOf(scoredGig());
    const lib = Object.values(PHRASES.planSteps);
    expect(lib.some((steps) => JSON.stringify(steps) === JSON.stringify(p.proposal!.plan))).toBe(true);
    expect(p.proposal!.plan).toHaveLength(3);
    const bare = planOf(scoredGig({ description: 'Need someone to help with a project.', skills: [] }));
    expect(bare.proposal!.plan).toEqual(PHRASES.planSteps['default']);
    expect(bare.proposal!.hook.quote).toBeNull();
    expect(PHRASES.hookPlain).toContain(bare.proposal!.hook.text);
    // covered terms but no sentence safe to quote: a hook naming the first covered term
    const unquoted = planOf(scoredGig({ description: 'Ideal skills: Java, Kafka, AWS, PostgreSQL, Redis.', skills: [] }));
    expect(unquoted.proposal!.hook.quote).toBeNull();
    expect(unquoted.proposal!.hook.text).toContain('Java');
    expect(PHRASES.hookTerm.map((h) => h.replace('{term}', 'Java'))).toContain(unquoted.proposal!.hook.text);
  });

  it('availability states the freelance rules and leaves {cadence} for the renderer', () => {
    const p = planOf(scoredGig());
    expect(p.proposal!.availability).toContain('20 hours a week');
    expect(p.proposal!.availability).toContain('18:00-00:00 IST');
    expect(p.proposal!.availability).toContain('{cadence}');
    expect(PHRASES.availability[0]).toBe('I can give this {maxHoursPerWeek} hours a week, mostly {istWindow} IST, with updates every {cadence}.');
    expect(cadenceOf({})).toBe('two days');
    expect(cadenceOf({ updateCadence: 'day' })).toBe('day');
    expect(() => cadenceOf({ updateCadence: 'see https://x.test' })).toThrow();
  });

  it('a contract gets a five-line pitch from the same sources, and no proposal', () => {
    const p = planOf(scoredGig({ kind: 'contract', budget: { type: 'hourly', min: 50, max: 60, currency: 'USD', usdPerUnit: 1 } }));
    expect(p.proposal).toBeNull();
    expect(p.pitch!.lines).toHaveLength(5);
    expect(p.pitch!.lines[1]!.factIds.length).toBeGreaterThan(0);
    expect(p.pitch!.lines[2]!.factIds.length).toBeGreaterThan(0);
    expect(pitchText(p.pitch!, DEFAULT_CADENCE).split('\n')).toHaveLength(5);
    for (const s of contracts) expect(planOf(s).pitch, s.risked.verdict.rated.gig.sourceId).not.toBeNull();
  });

  it('a bounty or network alert gets no plan', () => {
    expect(planGigDocs(scoredGig({ kind: 'bounty' }), pub)).toBeUndefined();
  });

  it('the contract CV is planResume of the synthetic posting, so it passes G-GROUND at full strength', () => {
    for (const s of fixtures) expect(resumeProblems(planOf(s).resume, wpack, '', pub), s.risked.verdict.rated.gig.sourceId).toEqual([]);
  });

  it('the template text is plain ASCII: every phrase, and every proposal outside the quoted words', () => {
    const all = JSON.stringify(PHRASES);
    expect(all).toMatch(/^[\x20-\x7e]*$/);
    for (const s of fixtures) {
      const p = planOf(s);
      const q = p.proposal?.hook.quote ?? p.pitch?.lines[0]?.text ?? '';
      const t = textOf(p).replace(p.proposal?.hook.quote ?? '\u0000', '');
      expect(t.replace(/[\p{L}\p{M}\p{N}]/gu, ''), q).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
    }
    expect(asciiPunct('Led X — the core – 2019–2021 “a” ’s … →')).toBe("Led X - the core - 2019-2021 \"a\" 's ... ->");
  });

  it('a quoting hook claims nothing about the gig: it only points to the closest evidence below', () => {
    for (const h of PHRASES.hook) expect(h).not.toMatch(/I have done (this|close)|I know|exactly/i);
  });

  it('no phrase reads like a robot: no "Relevant", no "I am writing to express", no keyword list', () => {
    for (const s of JSON.stringify(PHRASES).split('"')) {
      expect(s).not.toMatch(/^Relevant/);
      expect(s).not.toMatch(/I am writing to express|to whom it may concern/i);
    }
    for (const [slot, v] of Object.entries(PHRASES)) if (Array.isArray(v)) expect(v.length, slot).toBeGreaterThanOrEqual(3);
    for (const [slot, v] of Object.entries(PHRASES.evidenceLead)) expect(v.length, slot).toBeGreaterThanOrEqual(3);
  });
});

describe('gigDocsProblems (G-GROUND for GigDocsPlan@1)', () => {
  it('is empty for every fixture gig', () => {
    for (const s of fixtures) expect(gigDocsProblems(planOf(s), pub), s.risked.verdict.rated.gig.sourceId).toEqual([]);
  });

  it('names an evidence line that is not its fact verbatim, a quote not in the description, and any re-derivation difference', () => {
    const p = planOf(scoredGig());
    const ev = p.proposal!.evidence.map((e, i) => (i === 0 ? { ...e, text: e.text.replace(/\d+/, '99') } : e));
    expect(gigDocsProblems({ ...p, proposal: { ...p.proposal!, evidence: ev } }, pub).join('\n')).toMatch(/proposal.evidence\[0\].*verbatim/);
    const hook = { text: p.proposal!.hook.text.replace(p.proposal!.hook.quote!, 'We want Kafka now.'), quote: 'We want Kafka now.' };
    expect(gigDocsProblems({ ...p, proposal: { ...p.proposal!, hook } }, pub).join('\n')).toMatch(/hook.quote is not in the gig description/);
    expect(gigDocsProblems({ ...p, proposal: { ...p.proposal!, plan: ['Ship it in a day.', ...p.proposal!.plan.slice(1)] } }, pub).join('\n')).toMatch(/differs from its re-derivation/);
    expect(gigDocsProblems({ ...p, missing: [] }, pub).join('\n')).toMatch(/missing/);
    expect(gigDocsProblems({ ...p, proposal: { ...p.proposal!, evidence: [{ text: 'At Northwind Labs, I built it.', factIds: ['f-nope'] }] } }, pub).join('\n')).toMatch(/unknown fact f-nope/);
  });

  it('G-GROUND passes the planner output and trips on a tampered plan', () => {
    const p = planOf(scoredGig());
    const ctx = (payload: unknown): GuardrailContext => ({
      side: 'out', contract: proposalPlannerContract, policy: PRODUCT_POLICY_V1, policyHash: 'p', contractHashOf: () => undefined,
      input: { payload: scoredGig(), type: 'ScoredGig@1' } as unknown as Envelope, output: { payload, dataClass: 'P0' }, pack: freezePack(pub),
    });
    expect(G_GROUND.check(ctx(p)).verdict).toBe('pass');
    expect(G_NAMING.check(ctx(p)).verdict).toBe('pass');
    expect(G_GROUND.check(ctx({ ...p, covered: ['scala'] })).verdict).toBe('trip');
  });
});

describe('gig agents', () => {
  it('contracts: one skill, no "and", deterministic or io, no llm, no effect; the allow-list names the gig renderer and gig-qa', () => {
    for (const c of [proposalPlannerContract, gigRendererContract, gigQaContract]) {
      expect(c.skills).toHaveLength(1);
      expect(c.description.length).toBeGreaterThanOrEqual(10);
      expect(c.description).not.toMatch(/\band\b/i);
      expect(c.capabilities.llm).toBeFalsy();
      expect('effect' in c && c.effect !== undefined).toBe(false);
    }
    expect(proposalPlannerContract.kind).toBe('deterministic');
    expect(gigQaContract.kind).toBe('deterministic');
    expect(gigRendererContract.kind).toBe('io'); // writing files needs io, exactly as the daily renderer
    expect(gigRendererContract.capabilities.pack).toBe('full');
    expect(CAPABILITY_ALLOW_LIST.fullPack).toContain('gig-renderer');
    expect(CAPABILITY_ALLOW_LIST.filesWrite).toContain('gig-renderer');
    expect(CAPABILITY_ALLOW_LIST.pdfText).toContain('gig-qa');
    expect(capabilityProblems([proposalPlannerContract, gigRendererContract, gigQaContract])).toEqual([]);
    expect(proposalPlannerContract.guardrails.out).toEqual(expect.arrayContaining(['G-GROUND', 'G-NAMING', 'G-NO-GAP-CLAIM']));
  });

  it('the planner agent returns exactly planGigDocs', async () => {
    const ctx = issueContext({ contract: proposalPlannerContract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, clock: fixedClock('2026-10-12T00:00:00Z'), signal: AbortSignal.timeout(10_000), pack: freezePack(pub) });
    const out = await proposalPlanner.run(scoredGig(), ctx);
    expect(out).toEqual([planOf(scoredGig())]);
    expect(GigDocsPlan.schema.safeParse(out[0]).success).toBe(true);
  });
});

// ---- rendering and gig-qa ----

const KEY = 'c'.repeat(64);
const stages = new Map<string, PendingFiles>();
function ctxFor(agent: AnyAgent, out: string, pack: unknown) {
  const pending = agent.contract.capabilities.files?.access === 'read-write' ? openPending(out, KEY) : undefined;
  if (pending !== undefined) stages.set(out, pending);
  return issueContext({
    ...(pending !== undefined ? { pendingFiles: pending } : {}),
    contract: agent.contract,
    policy: PRODUCT_POLICY_V1,
    inputClass: agent === gigQa ? 'P1' : 'P0',
    providers: { fetch: async () => ({ status: 404, text: async () => '' }), fileRoots: { out }, ...(PDFTOTEXT ? { pdfText: pdftotextProvider(PDFTOTEXT) } : {}) },
    clock: fixedClock('2026-10-12T00:00:00Z'),
    signal: AbortSignal.timeout(60_000),
    pack: freezePack(pack),
  });
}
async function renderGig(plan: GigDocsPlan, pack: Pack = full): Promise<{ r: GigRendered; out: string }> {
  const out = mkdtempSync(join(tmpdir(), 'jobpilot-gig-'));
  const ctx = ctxFor(gigRenderer, out, pack);
  const [r] = await gigRenderer.run(plan, ctx);
  await stages.get(out)?.markFinal();
  await commitPending(out, KEY, PRODUCT_POLICY_V1.maxResponseBytes);
  return { r: GigRendered.schema.parse(r), out };
}
async function qa(r: GigRendered, out: string, pack: unknown = pub): Promise<GigQaReport> {
  const [rep] = await gigQa.run(r, ctxFor(gigQa, out, pack));
  return GigQaReport.schema.parse(rep);
}
type C = { id: string; ok: boolean; detail: string };
const checkOf = (rep: { checks: readonly C[] } | readonly C[], id: string) => ('checks' in rep ? rep.checks : rep).find((c) => c.id === id);

describe('gig-renderer and gig-qa', () => {
  withPdftotext('renders proposal.txt (UTF-8, LF), resume.pdf and resume.docx, and gig-qa passes every check', async () => {
    const { r, out } = await renderGig(planOf(scoredGig()));
    expect(r.files.map((f) => f.path)).toEqual([gigPath(r.gigKey, 'proposal', 'txt'), gigPath(r.gigKey, 'resume', 'pdf'), gigPath(r.gigKey, 'resume', 'docx')]);
    const txt = readFileSync(join(out, r.files[0]!.path), 'utf8');
    expect(txt).toBe(`${r.text.proposal}\n`);
    expect(txt).not.toContain('\r');
    expect(r.text.proposal).toContain('updates every two days');
    expect(r.text.proposal).not.toContain('{');
    for (const f of r.files) expect(sha(readFileSync(join(out, f.path))), f.path).toBe(f.sha256);
    const rep = await qa(r, out);
    expect(rep.checks.filter((c) => !c.ok)).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['gig.limits', 'gig.links', 'gig.banned', 'gig.ground', 'gig.naming']));
  });

  withPdftotext('renders pitch.txt for a contract, byte-identical on a second render', async () => {
    const plan = planOf(scoredGig({ kind: 'contract', budget: { type: 'hourly', min: 50, max: 60, currency: 'USD', usdPerUnit: 1 } }));
    const a = await renderGig(plan);
    const b = await renderGig(plan);
    expect(a.r.files.map((f) => f.kind)).toEqual(['pitch', 'resume', 'resume']);
    expect(a.r.files).toEqual(b.r.files);
    expect((await qa(a.r, a.out)).ok).toBe(true);
  });

  it('fills the cadence from answers.yaml updateCadence', async () => {
    const { r } = await renderGig(planOf(scoredGig()), { ...full, answers: { ...full.answers, updateCadence: 'day' } });
    expect(r.text.proposal).toContain('updates every day');
  });

  withPdftotext('over the limit fails gig.limits, and the text is never truncated', async () => {
    const plan = planOf(scoredGig());
    const { r, out } = await renderGig(plan);
    const tight = { ...pub, platformRules: { ...pub.platformRules, freelancer: { ...pub.platformRules.freelancer, maxChars: 200, hookChars: 20 } } };
    const rep = await qa(r, out, tight);
    expect(checkOf(rep, 'gig.limits')?.ok).toBe(false);
    expect(checkOf(rep, 'gig.limits')?.detail).toMatch(/limit is 200/);
    expect(checkOf(rep, 'gig.limits')?.detail).toMatch(/hook.*limit is 20/);
    expect(rep.ok).toBe(false);
    expect(readFileSync(join(out, r.files[0]!.path), 'utf8')).toBe(`${r.text.proposal}\n`);
    expect([...r.text.proposal!].length).toBeGreaterThan(200);
  });

  it('a banned opening, a keyword-list line or a link fails gig.banned or gig.links', () => {
    const plan = planOf(scoredGig());
    const base: GigRendered = { gigKey: plan.gigKey, files: [], plan, text: { proposal: proposalText(plan.proposal!, DEFAULT_CADENCE), pitch: null, resume: '' } };
    const read: GigQaInputs = { files: new Map(), pdfText: new Map() };
    const run = (proposal: string) => gigQaChecks({ ...base, text: { ...base.text, proposal } }, pub, read);
    expect(checkOf(run(`Relevant work: Kafka\n${base.text.proposal}`), 'gig.banned')?.ok).toBe(false);
    expect(checkOf(run(`I am writing to express my interest.\n${base.text.proposal}`), 'gig.banned')?.ok).toBe(false);
    expect(checkOf(run(`To whom it may concern,\n${base.text.proposal}`), 'gig.banned')?.ok).toBe(false);
    expect(checkOf(run(`${base.text.proposal}\nJava, Kafka, AWS, PostgreSQL`), 'gig.banned')?.ok).toBe(false);
    expect(checkOf(run(base.text.proposal!), 'gig.banned')?.ok).toBe(true);
    expect(checkOf(run(`${base.text.proposal}\nSee https://example.com/me`), 'gig.links')?.ok).toBe(false);
    expect(checkOf(run(`${base.text.proposal}\nMail me: a@example.com`), 'gig.links')?.ok).toBe(false);
    expect(checkOf(run(base.text.proposal!), 'gig.links')?.ok).toBe(true);
  });

  withPdftotext('a forbidden term planted in a fixture fact employer: the output shows employerDisplay, and the strict scan finds 0 hits', async () => {
    const planted: Pack = { ...full, facts: full.facts.map((f) => (f.id === 'f-nw-01' ? { ...f, employer: 'Initech India (GCC for Northwind)' } : f)) };
    const { contact: _c, answers: _a, ...plantedPub } = planted;
    const plan = planOf(scoredGig(), plantedPub);
    const ev = plan.proposal!.evidence.find((e) => e.factIds.includes('f-nw-01'));
    expect(ev?.text).toContain('Northwind Labs');
    expect(gigDocsProblems(plan, plantedPub)).toEqual([]);
    const { r, out } = await renderGig(plan, planted);
    for (const t of [r.text.proposal!, r.text.resume, JSON.stringify(plan.proposal), JSON.stringify(plan.resume.roles)]) expect(forbiddenTermStrict(t, naming)).toBeUndefined();
    for (const f of r.files) {
      const bytes = readFileSync(join(out, f.path));
      const text = f.format === 'pdf' ? '' : bytes.toString('utf8');
      expect(forbiddenTermStrict(text, naming), f.path).toBeUndefined();
    }
    const rep = await qa(r, out, plantedPub);
    expect(checkOf(rep, 'gig.naming')).toEqual({ id: 'gig.naming', ok: true, detail: 'ok' });
    expect(rep.ok).toBe(true);
  });

  it('gig.naming fails on a forbidden term in the text file', () => {
    const plan = planOf(scoredGig());
    const proposal = proposalText(plan.proposal!, DEFAULT_CADENCE);
    const r: GigRendered = { gigKey: plan.gigKey, files: [], plan, text: { proposal, pitch: null, resume: '' } };
    const path = gigPath(plan.gigKey, 'proposal', 'txt');
    const bytes = new TextEncoder().encode(`${proposal}\nInitech\n`);
    const checks = gigQaChecks(r, pub, { files: new Map([[path, { bytes, sha256: sha(bytes) }]]), pdfText: new Map() });
    expect(checkOf(checks, 'gig.naming')?.ok).toBe(false);
    expect(checkOf(checks, 'gig.naming')?.detail).toMatch(/forbidden term #1/);
    expect(checkOf(checks, 'gig.naming')?.detail).not.toMatch(/Initech/);
  });

  it('gig.ground fails when the plan in the rendered output was tampered with', () => {
    const plan = planOf(scoredGig());
    const bad = { ...plan, proposal: { ...plan.proposal!, question: 'Can you pay upfront?' } };
    const r: GigRendered = { gigKey: plan.gigKey, files: [], plan: bad, text: { proposal: proposalText(bad.proposal, DEFAULT_CADENCE), pitch: null, resume: '' } };
    expect(checkOf(gigQaChecks(r, pub, { files: new Map(), pdfText: new Map() }), 'gig.ground')?.ok).toBe(false);
  });

  it('repeatKey is the first 60 normalised characters', () => {
    expect(repeatKey('  Hello   World ')).toBe('hello world');
    expect(repeatKey('a'.repeat(80))).toHaveLength(60);
    expect(repeatKey('A  b\nC')).toBe(repeatKey('a b c'));
  });
});

describe('gig-renderer through executeStep', () => {
  const copyPack = (edit: (dir: string) => void): string => {
    const dir = mkdtempSync(join(tmpdir(), 'jobpilot-pack-'));
    cpSync(packDir, dir, { recursive: true });
    edit(dir);
    return dir;
  };

  withPdftotext('runs with the app guardrails (G-GROUND, G-NAMING pass), and its step key is the freelance full pack hash', async () => {
    const plan = planOf(scoredGig());
    const pHash = policyHash(PRODUCT_POLICY_V1);
    const input: Envelope = {
      envelopeId: 'plan-env', stepKey: 'plan-step', index: 0, type: GigDocsPlan.id,
      producer: { agentId: 'proposal-planner', version: '1.0.0', contractHash: 'pp' }, parents: [], payload: plan,
      handoff: { guarantees: [], dataClass: 'P0', obligations: [], pins: { policyHash: pHash } }, guardrails: [], cost: ZERO_COST,
    };
    const run = async (dir: string) => {
      const loaded = loadRunPack(dir, {}, '2026-10');
      const out = mkdtempSync(join(tmpdir(), 'jobpilot-gig-'));
      const packs = freelanceDocsPacks(loaded);
      const res = await executeStep(
        {
          store: Store.open(':memory:'), policy: PRODUCT_POLICY_V1, policyHash: pHash, clock: fixedClock('2026-10-12T00:00:00Z'), guardrails: appGuardrails(),
          providers: { fetch: async () => ({ status: 404, text: async () => '' }), fileRoots: { out } },
          contractHashOf: (id) => (id === 'proposal-planner' ? 'pp' : contractHash(gigRendererContract)), sleep: async () => {},
          pack: freezePack(packs.pack), packHash: packs.packHash, fullPack: freezePack(packs.fullPack), fullPackHash: packs.fullPackHash,
        },
        'run', gigRenderer, input,
      );
      return { res, loaded };
    };
    const a = await run(packDir);
    expect(a.res.kind).toBe('done');
    if (a.res.kind !== 'done') return;
    expect(a.res.outputs[0]!.handoff.dataClass).toBe('P1');
    expect(a.res.outputs[0]!.guardrails.map((g) => `${g.id}:${g.verdict}`)).toEqual(expect.arrayContaining(['G-GROUND:pass', 'G-NAMING:pass']));
    // A freelance.yaml edit changes the gig renderer's step key (the daily full pack hash would not).
    const edited = copyPack((d) => writeFileSync(join(d, 'freelance.yaml'), readFileSync(join(d, 'freelance.yaml'), 'utf8').replace('fitFloor: 45', 'fitFloor: 46')));
    const b = await run(edited);
    expect(b.loaded.fullPackHash).toBe(a.loaded.fullPackHash);
    expect(b.loaded.freelanceFullPackHash).not.toBe(a.loaded.freelanceFullPackHash);
    expect(b.res.stepKey).not.toBe(a.res.stepKey);
    expect(freelanceDocsPacks(a.loaded)).toEqual({ pack: a.loaded.publicPack, packHash: a.loaded.freelancePackHash, fullPack: a.loaded.fullPack, fullPackHash: a.loaded.freelanceFullPackHash });
  });

  it('G-GROUND trips on renderer output whose text is not the plan re-rendered', () => {
    const plan = planOf(scoredGig());
    const proposal = proposalText(plan.proposal!, DEFAULT_CADENCE);
    const out: GigRendered = { gigKey: plan.gigKey, files: [], plan, text: { proposal: `${proposal}\nExtra line.`, pitch: null, resume: '' } };
    const ctx: GuardrailContext = {
      side: 'out', contract: gigRendererContract, policy: PRODUCT_POLICY_V1, policyHash: 'p', contractHashOf: () => undefined,
      input: { payload: plan, type: GigDocsPlan.id } as unknown as Envelope, output: { payload: out, dataClass: 'P1' }, pack: freezePack(pub), fullPack: freezePack(full),
    };
    const v = G_GROUND.check(ctx);
    expect(v.verdict).toBe('trip');
    expect(v.detail).toMatch(/text.proposal/);
  });
});

