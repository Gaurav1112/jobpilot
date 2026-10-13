import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_ALLOW_LIST, capabilityProblems } from '../../../src/app/allow-list.js';
import { COMPACT, CV_BULLET_CHARS, DEFAULT_BUDGET, planResume, type WritingPack } from '../../../src/app/agents/writing/grounded.js';
import { gigQa, gigQaChecks, gigQaContract, repeatKey, type GigQaInputs } from '../../../src/app/freelance/writing/gig-qa.js';
import { freelanceDocsPacks, gigPath, gigRenderer, gigRendererContract } from '../../../src/app/freelance/writing/gig-renderer.js';
import { asciiPunct, PHRASES, planCategory, variantOf } from '../../../src/app/freelance/writing/phrases.js';
import { pitchText } from '../../../src/app/freelance/writing/pitch-planner.js';
import { cadenceOf, DEFAULT_CADENCE, hookQuote, hookTitle, planGigDocs, sentencesOf, proposalPlanner, proposalPlannerContract, proposalText } from '../../../src/app/freelance/writing/proposal-planner.js';
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

  it('hookQuote: whole sentences, scored by request words plus covered terms, ties to the earliest; clause cuts only', () => {
    const groups = [{ key: 'kafka', synonyms: [] }, { key: 'java', synonyms: [] }];
    // the best-scoring sentence, not the first
    expect(hookQuote('The team uses Kafka daily. The service must be rebuilt in Java with Kafka.', groups, groups, 140)).toEqual({ quote: 'The service must be rebuilt in Java with Kafka.', cut: false });
    // ties go to the earliest
    expect(hookQuote('The team uses Kafka. The service uses Kafka too.', groups, groups, 140)?.quote).toBe('The team uses Kafka.');
    // too long: cut at the last clause boundary within the room that keeps at least 6 words
    const long = `The consumer service must read orders from Kafka and write them out, then ${'enrich every record further '.repeat(6)}today.`;
    expect(hookQuote(long, groups, groups, 80)).toEqual({ quote: 'The consumer service must read orders from Kafka and write them out', cut: true });
    // no clause boundary within the room: the sentence is skipped, never cut mid-clause
    expect(hookQuote(`The Kafka consumer must ${'handle many many records '.repeat(8)}today.`, groups, groups, 60)).toBeNull();
    expect(hookQuote('Mail me at a@b.com about Kafka. Nothing else.', groups, groups, 140)).toBeNull();
    expect(hookQuote('The team uses “Kafka” daily.', groups, groups, 140)).toBeNull(); // non-ASCII punctuation is never quoted
    // never a list, a stray list number, first person, the bidder, a negation or a status
    expect(hookQuote('Ideal Skills: Kafka, Java and Go.', groups, groups, 140)).toBeNull();
    expect(hookQuote('The stack is Kafka, Java, Go, Redis, and AWS.', groups, groups, 140)).toBeNull();
    expect(hookQuote('Kafka deployment configuration 9.', groups, groups, 140)).toBeNull();
    for (const first of ['I', 'We', 'Our', 'My', 'Me', 'You', 'Your']) expect(hookQuote(`${first} run Kafka consumers in production.`, groups, groups, 140), first).toBeNull();
    // "We ..." / "Our ..." only as a request, never "Our developer ..."; I, My, Me, You, Your never
    expect(hookQuote('We need a Kafka consumer built in Java.', groups, groups, 140)?.quote).toBe('We need a Kafka consumer built in Java.');
    expect(hookQuote('We are looking for a Kafka engineer.', groups, groups, 140)?.quote).toBe('We are looking for a Kafka engineer.');
    expect(hookQuote('Our developer must know Kafka.', groups, groups, 140)).toBeNull();
    expect(hookQuote('I need a Kafka engineer.', groups, groups, 140)).toBeNull();
    // a cut quote must have balanced brackets and a request word
    expect(hookQuote('Propose your approach to the parsing work (OCR plus Kafka, and some extra glue code around it today).', groups, groups, 50)).toBeNull();
    expect(hookQuote('Solid AWS skills, containerisation, Kafka (some Java), and lots of other things on top of that.', groups, groups, 60)).toBeNull();
    expect(hookQuote('Please build the backend (preferred stack: Kafka or Java), secure and fast and with plenty of tests around it.', groups, groups, 90)).toEqual({ quote: 'Please build the backend (preferred stack: Kafka or Java)', cut: true });
    expect(hookQuote('The job does not involve Kafka work.', groups, groups, 140)).toBeNull();
    expect(hookQuote("The team doesn't want Kafka.", groups, groups, 140)).toBeNull();
    expect(hookQuote('Ship it without Kafka.', groups, groups, 140)).toBeNull();
    expect(hookQuote('The Kafka cluster is already configured.', groups, groups, 140)).toBeNull();
    expect(hookQuote('The Kafka cluster is configured, and it needs a consumer.', groups, groups, 140)?.quote).toBe('The Kafka cluster is configured, and it needs a consumer.');
    expect(hookQuote('- The service must use Kafka in production.', groups, groups, 140)).toEqual({ quote: 'The service must use Kafka in production.', cut: false });
  });

  it('sentencesOf keeps abbreviations inside a sentence (e.g., i.e., U.S., etc.)', () => {
    expect(sentencesOf('Use a broker, e.g. Kafka. Then ship.')).toEqual(['Use a broker, e.g. Kafka.', 'Then ship.']);
    expect(sentencesOf('Clients in the U.S. Midwest need it. Done!')).toEqual(['Clients in the U.S. Midwest need it.', 'Done!']);
    expect(sentencesOf('Queues, logs, etc. are in scope. Next.')).toEqual(['Queues, logs, etc. are in scope.', 'Next.']);
    expect(sentencesOf('One thing, i.e. the API. Two  things.')).toEqual(['One thing, i.e. the API.', 'Two things.']);
    expect(sentencesOf('Version 2.5 of the app. It runs.')).toEqual(['Version 2.5 of the app.', 'It runs.']);
  });

  it('evidence is an intro line, then "- employer (years): claim" lines, each one fact verbatim with its capital', () => {
    const p = planOf(scoredGig());
    expect(p.proposal!.evidence.length).toBeGreaterThanOrEqual(2);
    expect(p.proposal!.evidence.length).toBeLessThanOrEqual(3);
    expect(PHRASES.evidenceIntro).toContain(p.proposal!.evidenceIntro);
    const byId = new Map(full.facts.map((f) => [f.id, f]));
    const perEmployer = new Map<string, number>();
    for (const e of p.proposal!.evidence) {
      expect(e.factIds).toHaveLength(1);
      const f = byId.get(e.factIds[0]!)!;
      expect(e.text).toMatch(/^- (Northwind Labs \(2022-now\)|Contoso Retail \(2018-2022\)|Fabrikam \(2016-2018\)): /);
      expect(e.text.endsWith(`: ${asciiPunct(f.claim)}`), e.text).toBe(true);
      const emp = e.text.slice(2, e.text.indexOf(' ('));
      perEmployer.set(emp, (perEmployer.get(emp) ?? 0) + 1);
    }
    for (const [emp, n] of perEmployer) expect(n, emp).toBeLessThanOrEqual(2);
    const text = proposalText(p.proposal!, DEFAULT_CADENCE);
    expect(text).toContain(`${p.proposal!.evidenceIntro}\n${p.proposal!.evidence[0]!.text}`);
    expect(text).not.toMatch(/^Relevant work:/m);
    for (const s of fixtures) {
      const plan = planOf(s);
      for (const e of [...(plan.proposal?.evidence ?? []), ...(plan.pitch?.lines.filter((l) => l.factIds.length > 0) ?? [])]) {
        expect(e.factIds).toHaveLength(1);
        expect(e.text).toMatch(/^- .+ \((\d{4}|\d{4}-(\d{4}|now))\): /);
      }
    }
  });

  it('evidence prefers facts whose terms the gig title or skills name', () => {
    // the title names Redis, so the Redis fact leads even though Kafka facts rank higher on this description
    // no sentence is quotable, so only the title counts: the Redis fact leads, though Kafka facts rank higher
    const p = planOf(scoredGig({ title: 'Redis caching layer', description: 'Ideal skills: Kafka, Java, Redis.', skills: [] }));
    expect(p.proposal!.evidence[0]!.factIds).toEqual(['f-nw-02']);
  });

  it('the lead is chosen before the length limit and rotates among literal top-3 candidates by gig key', () => {
    const lead = (gigKey: string) => planOf(scoredGig({ gigKey, title: 'Java and Kafka services', description: 'Ideal skills: Kafka, Java, Redis.', skills: [] })).proposal!.evidence[0]!.factIds[0];
    const leads = new Set(Array.from({ length: 12 }, (_, i) => lead(keyWith(i, 12))));
    expect(leads.size).toBeGreaterThan(1);
    expect(lead(keyWith(3, 12))).toBe(lead(keyWith(3, 12)));
    // a lead over 220 characters stays the lead
    const longClaim = `Led the design of an event-driven order pipeline on Kafka handling 40M events a day${', with replay'.repeat(20)}.`;
    const longPack = { ...pub, facts: pub.facts.map((f) => (f.id === 'f-nw-01' ? { ...f, claim: longClaim } : f)) };
    const g = planGigDocs(scoredGig({ gigKey: keyWith(0, 12), title: 'Kafka pipeline', description: 'Ideal skills: Kafka.', skills: [] }), longPack)!;
    expect(g.proposal!.evidence[0]!.factIds).toEqual(['f-nw-01']);
    expect(gigDocsProblems(g, longPack)).toEqual([]);
  });

  it('the hook term skips domains and falls back to the lead fact, not the first covered term', () => {
    // the title (2 words, so no title hook) names SaaS (a domain) and Redis: the hook names Redis
    const r = planOf(scoredGig({ title: 'SaaS Redis', description: 'Ideal skills: Kafka, Java, Redis, SaaS.', skills: [] }));
    expect(r.proposal!.hook.quote).toBeNull();
    expect(PHRASES.hookTerm.map((h) => h.replace('{term}', 'Redis'))).toContain(r.proposal!.hook.text);
    // the title names only SaaS, and the lead fact's only covered term is SaaS: no domain hook, a plain one
    const d = planOf(scoredGig({ title: 'SaaS dashboard', description: 'Ideal skills: Kafka, Java, Redis, SaaS.', skills: [] }));
    expect(d.proposal!.evidence[0]!.factIds).toEqual(['f-nw-03']);
    expect(PHRASES.hookPlain).toContain(d.proposal!.hook.text);
    // no literal term at all: the lead is rank 1, and the hook names the lead's first non-domain term, not covered[0]
    const n = planOf(scoredGig({ title: 'Help wanted', description: 'Ideal skills: Redis, Kafka.', skills: [] }));
    const leadId = n.proposal!.evidence[0]!.factIds[0]!;
    expect(n.covered[0]).toBe('kafka');
    expect(leadId).toBe(n.resume.evidence.ranked.find((x) => x.matched.some((k) => n.covered.includes(k)))!.factId);
    const term = leadId === 'f-nw-02' ? 'Redis' : 'Kafka';
    expect(PHRASES.hookTerm.map((h) => h.replace('{term}', term))).toContain(n.proposal!.hook.text);
  });

  it('hookTitle: the client title verbatim, cut with "..." outside the quotes; short or all-caps titles fall through', () => {
    expect(hookTitle('Secure Digital Passport Platform Development', 70)).toEqual({ title: 'Secure Digital Passport Platform Development', cut: false });
    expect(hookTitle('Aplikasi Android dengan Login Pengguna - 06/10/2026 22:05 EDT', 70)).toEqual({ title: 'Aplikasi Android dengan Login Pengguna', cut: false });
    expect(hookTitle('Lead Developers Needed: Two Separate Projects – Real-Time Monitoring', 70)).toEqual({ title: 'Lead Developers Needed: Two Separate Projects', cut: true });
    const long = hookTitle('Build a cross platform mobile application for booking local fitness classes and trainers', 70)!;
    expect(long.cut).toBe(true);
    expect(long.title.length).toBeLessThanOrEqual(70);
    expect('Build a cross platform mobile application for booking local fitness classes and trainers').toContain(long.title);
    expect(hookTitle('SOC 2 Type I audit (licensed, AICPA peer-reviewed CPA firm only) for a B2B SaaS platform', 70)).toEqual({ title: 'SOC 2 Type I audit (licensed, AICPA peer-reviewed CPA firm only)', cut: true }); // no "for a" before the "..."
    expect(hookTitle('Kafka work', 70)).toBeNull(); // 2 words
    expect(hookTitle('URGENT JAVA DEVELOPER NEEDED', 70)).toBeNull(); // all capitals
    expect(hookTitle('Fix my site example.com today', 70)).toBeNull();
    expect(hookTitle('Initech payments portal rebuild', 70, ['Initech'])).toBeNull();
    const p = planOf(scoredGig({ title: 'Kafka consumer for order events', description: 'Ideal skills: Kafka, Java.', skills: [] }));
    expect(p.proposal!.hook).toMatchObject({ quote: null, title: 'Kafka consumer for order events' });
    expect(PHRASES.hookTitle.map((h) => h.replace('{title}', 'Kafka consumer for order events').replace('{end}', ''))).toContain(p.proposal!.hook.text);
    // with no evidence at all, a qualifying title still gives a title hook (it claims nothing)
    const none = planOf(scoredGig({ title: 'Garden landscaping design project', description: 'Design my garden please.', skills: [] }));
    expect(none.proposal!.evidence).toEqual([]);
    expect(none.proposal!.hook.title).toBe('Garden landscaping design project');
    expect(gigDocsProblems(none, pub)).toEqual([]);
    // G-GROUND: a title that is not the gig's
    const forged = { ...p, proposal: { ...p.proposal!, hook: { ...p.proposal!.hook, title: 'Kafka consumer for all events', text: p.proposal!.hook.text.replace('order', 'all') } } };
    expect(gigDocsProblems(forged, pub).join('\n')).toMatch(/hook.title is not in the gig title verbatim/);
  });

  it('relevance beats rotation: a top-3 fact the hook quote names leads, whatever the gig key', () => {
    const lead = (gigKey: string) =>
      planOf(scoredGig({ gigKey, title: 'Java and Kafka services', description: 'The service must cache prices in Redis for speed.', skills: [] })).proposal!;
    for (let i = 0; i < 6; i++) {
      const p = lead(keyWith(i, 6));
      expect(p.hook.quote).toBe('The service must cache prices in Redis for speed.');
      expect(p.evidence[0]!.factIds).toEqual(['f-nw-02']);
    }
  });

  it('the compact CV keeps the total bullet characters within CV_BULLET_CHARS, skipping a fact that would go over', () => {
    expect(COMPACT).toEqual({ latest: 2, other: 0, chars: CV_BULLET_CHARS });
    for (const s of fixtures) {
      const r = planOf(s).resume;
      expect(r.roles.flatMap((x) => x.bullets).reduce((n, b) => n + b.text.length, 0)).toBeLessThanOrEqual(CV_BULLET_CHARS);
    }
    const ev = planOf(scoredGig()).resume.evidence;
    const tight = planResume(ev, wpack, { latest: 2, other: 0, chars: 120 });
    const used = tight.roles.flatMap((x) => x.bullets);
    expect(used.reduce((n, b) => n + b.text.length, 0)).toBeLessThanOrEqual(120);
    expect(used.length).toBeGreaterThan(0);
    // a fact that would go over is skipped for the next one in its role, so a later, shorter fact can stand in
    const loose = planResume(ev, wpack, { latest: 2, other: 0 }).roles.flatMap((x) => x.bullets.map((b) => b.factId));
    expect(used.map((b) => b.factId)).not.toEqual(loose);
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

  it('the plan steps come from the title category, a wording picked by the gig key', () => {
    expect(planCategory('SOC 2 Type I audit for a SaaS platform')).toBe('audit');
    expect(planCategory('Debug Java Spring Service Logic')).toBe('fix');
    expect(planCategory('Final Hardening & Release: 2 Working Apps')).toBe('finish');
    expect(planCategory('Migrate our monolith')).toBe('migrate');
    expect(planCategory('Stripe webhook setup')).toBe('integrate');
    expect(planCategory('Build an LLM chatbot')).toBe('ai');
    expect(planCategory('Stripe API for an AI model')).toBe('ai'); // ai comes before integrate
    expect(planCategory('AI-Assisted Software Engineer for Fintech')).not.toBe('ai'); // using AI tools, not building AI
    expect(planCategory('Train a model agent')).toBe('default'); // bare "model" and "agent" are not ai
    expect(planCategory('Cross-Platform App Build')).toBe('build');
    expect(planCategory('Tracking & Measurement Specialist Required')).toBe('default');
    expect(planCategory('Admin Portal tidy')).toBe('default'); // whole words only: "Portal" is not "port"
    const p = planOf(scoredGig({ title: 'Fix a Kafka consumer bug' }));
    expect(PHRASES.planSteps.fix.map((s) => JSON.stringify(s))).toContain(JSON.stringify(p.proposal!.plan));
    for (const steps of Object.values(PHRASES.planSteps).flat()) for (const step of steps) expect(step).not.toMatch(/or your spec, if this is new|I have (done|built|shipped)/);
    const bare = planOf(scoredGig({ title: 'Help needed', description: 'Need someone to help with a project.', skills: [] }));
    expect(PHRASES.planSteps.default.map((s) => JSON.stringify(s))).toContain(JSON.stringify(bare.proposal!.plan));
    expect(bare.proposal!.hook.quote).toBeNull();
    expect(PHRASES.hookPlain).toContain(bare.proposal!.hook.text);
    // covered terms but no sentence safe to quote: a hook naming the covered term the title names
    const unquoted = planOf(scoredGig({ title: 'Kafka work', description: 'Ideal skills: Java, Kafka, AWS, PostgreSQL, Redis.', skills: [] }));
    expect(unquoted.proposal!.hook.quote).toBeNull();
    expect(PHRASES.hookTerm.map((h) => h.replace('{term}', 'Kafka'))).toContain(unquoted.proposal!.hook.text);
  });

  it('the question names the missing term the title names first, and asks about a domain as a domain', () => {
    const p = planOf(scoredGig({ title: 'Elixir data job', description: 'We need help with Kafka. Scala and Elixir are used.', skills: [] }));
    expect(p.missing).toEqual(expect.arrayContaining(['elixir', 'scala']));
    expect(p.missing.indexOf('scala')).toBeLessThan(p.missing.indexOf('elixir'));
    expect(p.proposal!.question).toMatch(/Elixir/);
    const pack2 = { ...pub, facts: pub.facts.map((f) => (f.tech.includes('fintech') ? { ...f, tech: f.tech.filter((t) => t !== 'fintech') } : f)) };
    const d = planGigDocs(scoredGig({ title: 'Fintech backend', description: 'A fintech product needs Java services on Kafka.', skills: [] }), pack2)!;
    expect(d.missing).toContain('fintech');
    expect(PHRASES.domainQuestion.map((q) => q.replace('{term}', 'fintech'))).toContain(d.proposal!.question);
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

  it('the contract CV is planResume with the compact budget, so it passes G-GROUND at full strength', () => {
    for (const s of fixtures) {
      const r = planOf(s).resume;
      expect(resumeProblems(r, wpack, '', pub, COMPACT), s.risked.verdict.rated.gig.sourceId).toEqual([]);
      r.roles.forEach((role, i) => expect(role.bullets.length).toBeLessThanOrEqual(i < 2 ? 2 : 0));
      expect(r.roles.length).toBe(full.roles.length); // older roles keep title, employer and dates
    }
    // the daily budget is unchanged
    expect(DEFAULT_BUDGET).toEqual({ latest: 4, other: 2 });
    expect(resumeProblems(planOf(fixtures[0]!).resume, wpack, '', pub).join('\n')).toMatch(/differs from its re-derivation/);
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

  it('no hook echoes a plan heading ("approach it", "run it/this")', () => {
    for (const h of [...PHRASES.hookTitle, ...PHRASES.hookTerm, ...PHRASES.hookPlain, ...PHRASES.hook]) expect(h).not.toMatch(/approach (it|this)|run (it|this)/i);
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
    for (const [cat, v] of Object.entries(PHRASES.planSteps)) expect(v.length, cat).toBeGreaterThanOrEqual(2);
  });
});

describe('gigDocsProblems (G-GROUND for GigDocsPlan@1)', () => {
  it('is empty for every fixture gig', () => {
    for (const s of fixtures) expect(gigDocsProblems(planOf(s), pub), s.risked.verdict.rated.gig.sourceId).toEqual([]);
  });

  it('names an evidence line that is not its fact verbatim, a quote not in the description, and any re-derivation difference', () => {
    const p = planOf(scoredGig());
    const ev = p.proposal!.evidence.map((e, i) => (i === 0 ? { ...e, text: e.text.replace(/\d+(?=[^)]*$)/, '99') } : e));
    expect(gigDocsProblems({ ...p, proposal: { ...p.proposal!, evidence: ev } }, pub).join('\n')).toMatch(/proposal.evidence\[0\].*verbatim/);
    const yrs = p.proposal!.evidence.map((e, i) => (i === 0 ? { ...e, text: e.text.replace(/\(\d{4}/, '(2001') } : e));
    expect(gigDocsProblems({ ...p, proposal: { ...p.proposal!, evidence: yrs } }, pub).join('\n')).toMatch(/proposal.evidence\[0\]: the line is not "- employer \(years\): claim"/);
    const hook = { text: p.proposal!.hook.text.replace(p.proposal!.hook.quote!, 'The team wants Kafka now.'), quote: 'The team wants Kafka now.', title: null };
    expect(gigDocsProblems({ ...p, proposal: { ...p.proposal!, hook } }, pub).join('\n')).toMatch(/hook.quote is not in the gig description/);
    expect(gigDocsProblems({ ...p, proposal: { ...p.proposal!, plan: ['Ship it in a day.', ...p.proposal!.plan.slice(1)] } }, pub).join('\n')).toMatch(/differs from its re-derivation/);
    expect(gigDocsProblems({ ...p, missing: [] }, pub).join('\n')).toMatch(/missing/);
    expect(gigDocsProblems({ ...p, proposal: { ...p.proposal!, evidence: [{ text: '- Northwind Labs (2022-now): Built it.', factIds: ['f-nope'] }] } }, pub).join('\n')).toMatch(/unknown fact f-nope/);
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
      const loaded = loadRunPack(dir, {}, '2026-10', undefined, 'strict');
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

