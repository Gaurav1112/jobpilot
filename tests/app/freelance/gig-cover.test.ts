import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appEvalSpecs } from '../../../src/app/evals.js';
import { runEval } from '../../../src/evals/runner.js';
import { COVER_P4_THANKS, COVER_OPENING } from '../../../src/app/agents/writing/templates.js';
import { COVER_PLATFORMS, getsCover, GIG_COVER_P4_CITY } from '../../../src/app/freelance/writing/gig-cover.js';
import { planGigDocs } from '../../../src/app/freelance/writing/proposal-planner.js';
import { GigDocsPlan, type Gig, type ScoredGig } from '../../../src/app/freelance/types.js';
import { G_GROUND, G_NAMING, gigDocsProblems } from '../../../src/app/guardrails.js';
import { proposalPlannerContract } from '../../../src/app/freelance/writing/proposal-planner.js';
import type { Envelope } from '../../../src/kernel/envelope.js';
import { freezePack } from '../../../src/kernel/broker.js';
import type { GuardrailContext } from '../../../src/kernel/guardrails/index.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import { boardRole, fixturePack, scoredGig } from '../../support/gig-fixtures.js';

/**
 * freelance-v2 Feature 2: a full tailored cover letter for contract roles from employer job boards (`boards`, the
 * daily contract postings, and `himalayas`), planned with the daily cover-letter machinery (`planCover`) on the gig's
 * synthetic posting named for the real company, and grounded by the same checks. Fictional pack and companies only.
 */

const { full, pub } = fixturePack();

const plan = (s: ScoredGig, pack: unknown = pub): GigDocsPlan => {
  const p = planGigDocs(s, pack);
  if (p === undefined) throw new Error('no plan');
  return p;
};
const letter = (p: GigDocsPlan): string => (p.cover?.paragraphs ?? []).map((x) => x.text).join('\n\n');

describe('which gigs get a cover letter', () => {
  it('employer job boards are the boards and Himalayas sources', () => {
    expect([...COVER_PLATFORMS]).toEqual(['boards', 'himalayas']);
  });

  it('a boards or Himalayas contract with a company gets one, in any list; the pitch and CV are unchanged', () => {
    for (const s of [boardRole(), boardRole({ platform: 'himalayas', sourceId: 'h1' }), boardRole({}, 'contracts')]) {
      const p = plan(s);
      expect(p.cover, s.risked.verdict.rated.gig.platform).toBeDefined();
      expect(p.pitch).not.toBeNull();
      expect(p.proposal).toBeNull();
      expect(GigDocsPlan.schema.safeParse(p).success).toBe(true);
      // the CV and pitch are what they were before (the cover is only added)
      const { cover: _c, ...rest } = p;
      expect(rest.resume.evidence.scored.posting.company).toBe(s.risked.verdict.rated.gig.platform);
    }
  });

  it('a marketplace contract, a gig, a board contract with no company, and a bounty get none (the key is left out)', () => {
    const freelancer = plan(scoredGig({ kind: 'contract' }));
    const gig = plan(scoredGig());
    const hn = plan(boardRole({ platform: 'hn-hiring', sourceId: 'hn1' }));
    const noCompany = plan(boardRole({ client: { name: null, country: null, paymentVerified: null, hireRate: null, spendUsd: null, reviews: null, since: null } }));
    for (const p of [freelancer, gig, hn, noCompany]) expect('cover' in p).toBe(false);
    expect(getsCover(boardRole().risked.verdict.rated.gig)).toBe(true);
    expect(getsCover(scoredGig({ kind: 'contract' }).risked.verdict.rated.gig)).toBe(false);
    expect(getsCover({ ...boardRole().risked.verdict.rated.gig, kind: 'gig' })).toBe(false);
  });

  it('a company or title the letter cannot name safely (a forbidden term, an email address, a script the font lacks) gets no cover; the pitch and CV stay', () => {
    const forbidden = plan(boardRole({ client: { name: 'Initech Labs', country: null, paymentVerified: null, hireRate: null, spendUsd: null, reviews: null, since: null } }));
    expect('cover' in forbidden).toBe(false);
    expect(forbidden.pitch).not.toBeNull();
    const markup = plan(boardRole({ client: { name: 'Mail cv@example.com', country: null, paymentVerified: null, hireRate: null, spendUsd: null, reviews: null, since: null } }));
    expect('cover' in markup).toBe(false);
    const cjk = plan(boardRole({ client: { name: String.fromCodePoint(0x6771, 0x4eac) + ' Labs', country: null, paymentVerified: null, hireRate: null, spendUsd: null, reviews: null, since: null } }));
    expect('cover' in cjk).toBe(false);
    // a pictograph some boards put before a title is decoration: the letter names the title without it
    const globe = plan(boardRole({ title: String.fromCodePoint(0x1f30d) + ' Senior Backend Engineer, Payments - Remote - Contract' }));
    expect(globe.cover?.paragraphs[0]!.text).toContain("I'm applying for the Senior Backend Engineer, Payments - Remote - Contract role at Example Robotics.");
    expect(gigDocsProblems(globe, pub)).toEqual([]);
    expect(globe.resume.evidence.scored.posting.title).toBe(String.fromCodePoint(0x1f30d) + ' Senior Backend Engineer, Payments - Remote - Contract');
    const accented = plan(boardRole({ client: { name: 'Caf' + String.fromCodePoint(0xe9) + ' Systems', country: null, paymentVerified: null, hireRate: null, spendUsd: null, reviews: null, since: null } }));
    expect('cover' in accented).toBe(true);
  });
});

describe('the cover letter', () => {
  it('is the daily letter for the role at the real company: p1 opens with the title and company, and its facts are cited', () => {
    const p = plan(boardRole());
    const c = p.cover!;
    expect(c.paragraphs[0]!.text.startsWith(COVER_OPENING.replace('{title}', 'Senior Backend Engineer - Java (6-month contract)').replace('{company}', 'Example Robotics'))).toBe(true);
    expect(c.resume.evidence.scored.posting.company).toBe('Example Robotics');
    expect(c.paragraphs.slice(1, -1).flatMap((x) => x.factIds).length).toBeGreaterThan(0);
    for (const para of c.paragraphs.slice(1, -1))
      for (const id of para.factIds) {
        const f = full.facts.find((x) => x.id === id)!;
        expect(para.text.includes(f.claim) || para.text.includes(f.claim.charAt(0).toLowerCase() + f.claim.slice(1)), id).toBe(true);
      }
    // its resume is the contract CV's budget (1 page): the same bullets as the CV sent with it
    expect(c.resume.roles.map((r) => r.bullets)).toEqual(p.resume.roles.map((r) => r.bullets));
  });

  it('ends with contract availability from the pack (hours, IST window, alongside the current role), the city left for the renderer', () => {
    const p4 = plan(boardRole()).cover!.paragraphs.at(-1)!;
    expect(p4.factIds).toEqual([]);
    expect(p4.text).toBe(`I'm based in {city} and can start right away, working up to 20 hours a week alongside my current role, mostly 18:00-00:00 IST. ${COVER_P4_THANKS}`);
    expect(GIG_COVER_P4_CITY).toContain('{maxHoursPerWeek}');
    expect(p4.text).not.toMatch(/fully remote|notice/);
    // the pack values, never hard-coded
    const other = { ...pub, freelance: { ...pub.freelance, maxHoursPerWeek: 12, istWindow: '19:00-23:00' } };
    expect(plan(boardRole(), other).cover!.paragraphs.at(-1)!.text).toContain('working up to 12 hours a week alongside my current role, mostly 19:00-23:00 IST.');
    // with no ongoing role, no "alongside my current role"
    const ended = { ...pub, roles: pub.roles.map((r) => (r.end === 'present' ? { ...r, end: '2026-09' } : r)), experience: { ...pub.experience } };
    expect(plan(boardRole(), ended).cover?.paragraphs.at(-1)!.text ?? '').not.toContain('alongside');
  });

  it('never states pay or hours of the role: nothing from the budget reaches the letter', () => {
    const paid = boardRole({ budget: { type: 'hourly', min: 55, max: 70, currency: 'USD', usdPerUnit: 1 }, hoursPerWeek: { min: 30, max: 30, source: 'text' } });
    const t = letter(plan(paid));
    expect(t).not.toMatch(/\$|USD|\b55\b|\b70\b|\b30 hours|per hour|rate/i);
  });
});

describe('G-GROUND for the gig cover (gigDocsProblems)', () => {
  it('is empty for a planned cover, on both employer boards', () => {
    expect(gigDocsProblems(plan(boardRole()), pub)).toEqual([]);
    expect(gigDocsProblems(plan(boardRole({ platform: 'himalayas', sourceId: 'h2' })), pub)).toEqual([]);
  });

  it('names a tampered paragraph, an invented fact, a changed availability, a dropped cover and a cover on a gig that gets none', () => {
    const p = plan(boardRole());
    const c = p.cover!;
    const para = (i: number, text: string, factIds = c.paragraphs[i]!.factIds) => ({ ...p, cover: { ...c, paragraphs: c.paragraphs.map((x, j) => (j === i ? { text, factIds: [...factIds] } : x)) } });
    expect(gigDocsProblems(para(1, `${c.paragraphs[1]!.text} I also led a team of 40.`), pub).join('\n')).toMatch(/cover\.paragraphs\[1\] is not the template rendering/);
    expect(gigDocsProblems(para(1, c.paragraphs[1]!.text, ['f-nope']), pub).join('\n')).toMatch(/cover\.paragraphs\[1\]: unknown fact f-nope/);
    const last = c.paragraphs.length - 1;
    expect(gigDocsProblems(para(last, c.paragraphs[last]!.text.replace('20 hours', '40 hours')), pub).join('\n')).toMatch(/cover\.paragraphs\[\d\] is not the template rendering/);
    const { cover: _drop, ...dropped } = p;
    expect(gigDocsProblems(dropped, pub).join('\n')).toMatch(/differs from its re-derivation \(at cover\)/);
    const onFreelancer = { ...plan(scoredGig({ kind: 'contract' })), cover: c };
    expect(gigDocsProblems(onFreelancer, pub).join('\n')).toMatch(/only a contract from an employer job board gets a cover letter/);
    const otherCompany = { ...p, cover: { ...c, resume: { ...c.resume, evidence: { ...c.resume.evidence, scored: { ...c.resume.evidence.scored, posting: { ...c.resume.evidence.scored.posting, company: 'Other Co' } } } } } };
    expect(gigDocsProblems(otherCompany, pub).join('\n')).toMatch(/cover\.resume\.evidence\.scored\.posting is not the gig's synthetic posting named for its company/);
  });
});

describe('the planner guardrails on a plan with a cover', () => {
  const ctx = (input: ScoredGig, payload: unknown): GuardrailContext => ({
    side: 'out', contract: proposalPlannerContract, policy: PRODUCT_POLICY_V1, policyHash: 'p', contractHashOf: () => undefined,
    input: { payload: input, type: 'ScoredGig@1' } as unknown as Envelope, output: { payload, dataClass: 'P0' }, pack: freezePack(pub),
  });

  it('G-GROUND and G-NAMING pass; the posting text inside the cover plan is source data, exempt like the CV one', () => {
    const s = boardRole({ description: `${boardRole().risked.verdict.rated.gig.description} Our parent group Initech runs the platform.` });
    const p = plan(s);
    expect(p.cover).toBeDefined();
    expect(G_GROUND.check(ctx(s, p)).verdict).toBe('pass');
    expect(G_NAMING.check(ctx(s, p)).verdict).toBe('pass');
    const bad = { ...p, cover: { ...p.cover!, paragraphs: p.cover!.paragraphs.map((x, i) => (i === 1 ? { ...x, text: `${x.text} Initech.` } : x)) } };
    expect(G_NAMING.check(ctx(s, bad)).verdict).toBe('trip');
    expect(G_GROUND.check(ctx(s, bad)).verdict).toBe('trip');
  });
});

describe('the gig-cover-grounding eval (fictional fixtures, gate exactMatch 1.000)', () => {
  const root = join(import.meta.dirname, '../../..');
  const spec = () => appEvalSpecs(join(root, 'evals/datasets'), join(root, 'tests/fixtures/pack')).find((s) => s.name === 'gig-cover-grounding');

  it('is registered with a gate of 1 and passes every case', async () => {
    const s = spec();
    expect(s).toBeDefined();
    expect(s!.min).toBe(1);
    const r = await runEval(s!, { providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, policy: PRODUCT_POLICY_V1 });
    expect(r.failures).toEqual([]);
    expect(r.score).toBe(1);
    expect(r.n).toBeGreaterThanOrEqual(12);
  });

  it('has cases on both employer boards with a cover, and cases that must get none', () => {
    const cases = spec()!.cases as unknown as { id: string; input: ScoredGig; expected: { pass: boolean; cover: boolean } }[];
    const withCover = cases.filter((c) => c.expected.cover);
    expect(new Set(withCover.map((c) => c.input.risked.verdict.rated.gig.platform))).toEqual(new Set(['boards', 'himalayas']));
    expect(cases.filter((c) => !c.expected.cover).length).toBeGreaterThanOrEqual(4);
    expect(cases.every((c) => c.expected.pass)).toBe(true);
  });

  it('holds no personal data and no real pack value: fictional companies and the fixture pack only', () => {
    const text = readFileSync(join(root, 'evals/datasets/gig-cover-grounding.jsonl'), 'utf8');
    expect(text).not.toMatch(/@(?!example\.)[a-z0-9-]+\.[a-z]{2,}/i); // no email outside example domains
    for (const c of spec()!.cases as unknown as { input: ScoredGig }[]) {
      const name = c.input.risked.verdict.rated.gig.client.name ?? '';
      expect(name === '' || /^(?:Example|Fictional|Sample) /.test(name) || /\bExample\b/.test(name) || name.startsWith('Initech') || name.startsWith('Mail '), name).toBe(true);
    }
  });
});
