import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coverWriter } from '../../src/app/agents/writing/cover-writer.js';
import { evidenceMatcher } from '../../src/app/agents/writing/evidence-matcher.js';
import { buildEvidence, firstSeenOf, planCover, planResume, yearsOf, type WritingPack } from '../../src/app/agents/writing/grounded.js';
import { resumePlanner } from '../../src/app/agents/writing/resume-planner.js';
import {
  articleFor,
  COVER_EXAMPLES,
  COVER_OPENING,
  COVER_P4,
  COVER_TERMS,
  COVER_TITLE_NOW,
  COVER_TITLE_PAST,
  EVIDENCE_ALSO_AT,
  EVIDENCE_ALSO_AT_COLON,
  EVIDENCE_AT,
  EVIDENCE_AT_COLON,
  EVIDENCE_AT_NOW,
  EVIDENCE_THERE,
  evidenceSentence,
  joinList,
  RENDER_PLACEHOLDERS,
  renderSummary,
  sanitisePostingText,
  SIGNATURE_LEADS,
  signatureLead,
  startsWithPastVerb,
  SUMMARY_TEMPLATE,
  unsafePostingText,
} from '../../src/app/agents/writing/templates.js';
import { scorePosting } from '../../src/app/agents/scorer-lexicon.js';
import { tagIs } from '../../src/app/lexicon.js';
import { loadPack } from '../../src/app/pack/load.js';
import { assertNoForbidden } from '../../src/app/pack/rules.js';
import type { Fact } from '../../src/app/pack/schema.js';
import { coverProblems } from '../../src/app/guardrails.js';
import { CoverPlan, Evidence, ResumePlan, type Posting, type Scored } from '../../src/app/types.js';
import type { AnyAgent } from '../../src/kernel/agent.js';
import { freezePack, issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { KernelError } from '../../src/kernel/errors.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';

const root = join(import.meta.dirname, '../..');
const packDir = join(root, 'tests/fixtures/pack');

function publicPack(overrides: Record<string, Fact['status']> = {}): WritingPack {
  const { pack: full } = loadPack(packDir, overrides);
  const { contact: _c, answers: _a, ...pub } = full;
  return freezePack(pub) as unknown as WritingPack;
}
const pack = publicPack();

export const JD =
  'We build event-driven payments services in Java with Spring Boot, Kafka and PostgreSQL on AWS. ' +
  'You will run Kubernetes, Docker, gRPC and Elasticsearch in production. Scala is a plus.';

export function posting(over: Partial<Posting> = {}): Posting {
  return {
    jobKey: '0123456789abcdef',
    dedupeKey: 'fedcba9876543210',
    source: 'greenhouse',
    sourceId: 'w1',
    company: 'Acme Payments',
    slug: 'acme',
    ats: 'greenhouse',
    title: 'Senior Backend Engineer (Java)',
    url: 'https://jobs.example.com/w1',
    locationText: 'Remote - India',
    remote: { structured: 'remote', countries: ['india'], signals: ['workplaceType:remote'] },
    employmentType: 'Full-time',
    descriptionText: JD,
    postedAt: '2026-10-01T09:00:00Z',
    comp: null,
    yearsRequired: null,
    ...over,
  };
}
export const scoredOf = (p: Posting, p2: WritingPack = pack): Scored =>
  scorePosting({ posting: p, verdict: 'eligible', reasons: [], notes: [] }, p2 as unknown as Parameters<typeof scorePosting>[1]);

const ctxFor = (agent: AnyAgent, p: unknown = pack) =>
  issueContext({
    contract: agent.contract,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: { fetch: async () => ({ status: 404, text: async () => '' }) },
    clock: fixedClock('2026-01-01T00:00:00Z'),
    signal: AbortSignal.timeout(5000),
    pack: p,
  });

describe('lexicon: tagIs (fact tech tags)', () => {
  it('matches a whole tag to a key or synonym, case-insensitively, with spaces and hyphens interchangeable', () => {
    expect(tagIs('spring boot', 'spring boot')).toBe(true);
    expect(tagIs('Spring-Boot', 'spring boot')).toBe(true);
    expect(tagIs('event driven', 'event-driven')).toBe(true);
    expect(tagIs('Go', 'go')).toBe(true); // a tag is a skill label: no English-word ambiguity
    expect(tagIs('C#', 'c#')).toBe(true);
    expect(tagIs('spring', 'spring boot')).toBe(false);
    expect(tagIs('spring boot', 'spring')).toBe(false); // the whole tag must be the term
    expect(tagIs('java', 'javascript')).toBe(false);
    expect(tagIs('anything', '  ')).toBe(false);
  });
});

describe('years of experience', () => {
  it('counts the union of role months up to the firstSeen month (fixture: 23 + 45 + 55 months = 10 years)', () => {
    expect(yearsOf(pack.roles, '2026-10-01')).toBe(10);
    expect(yearsOf(pack.roles, '2026-12-31')).toBe(10); // 125 months
    expect(yearsOf(pack.roles, '2027-02-01')).toBe(10); // 127 months
    expect(yearsOf(pack.roles, '2027-06-01')).toBe(10); // 131 months
    expect(yearsOf(pack.roles, '2027-07-01')).toBe(11); // 132 months
  });
  it('never double-counts overlapping roles, never counts gaps, and stops at firstSeen', () => {
    const role = (start: string, end: string) => ({ employer: 'E', title: 'T', location: '', start, end });
    expect(yearsOf([role('2020-01', '2021-12'), role('2021-01', '2022-12')], '2026-01-01')).toBe(3); // 36 months, not 48
    expect(yearsOf([role('2010-01', '2010-12'), role('2015-01', '2015-12')], '2026-01-01')).toBe(2); // the gap is not counted
    expect(yearsOf([role('2020-01', 'present')], '2023-01-15')).toBe(3); // 2020-01..2022-12; the firstSeen month is not counted
    expect(yearsOf([role('2020-01', '2030-12')], '2023-01-15')).toBe(3); // an end after firstSeen is cut there
    expect(yearsOf([role('2024-01', 'present')], '2023-01-15')).toBe(0); // a role starting after firstSeen counts nothing
    expect(yearsOf([], '2023-01-15')).toBe(0);
  });
});

describe('firstSeen', () => {
  it("is the posting's postedAt date when present", () => {
    expect(firstSeenOf(posting(), pack)).toBe('2026-10-01');
    expect(firstSeenOf(posting({ postedAt: '2026-09-02T14:50:52-04:00' }), pack)).toBe('2026-09-02');
  });
  it('without postedAt, is the first day of the pack asOf month (never the clock); no rule reads it', () => {
    expect(firstSeenOf(posting({ postedAt: null }), pack)).toBe('2026-10-01');
  });
});

describe('evidence-matcher', () => {
  it('ranks every citeable experience or project fact: 3 x tech + 1 x claim terms + recency', () => {
    const ev = buildEvidence(scoredOf(posting()), pack);
    expect(Evidence.schema.parse(ev)).toEqual(ev);
    expect(ev.ranked).toEqual([
      { factId: 'f-ct-01', employer: 'Contoso Retail', rank: 12.5333, matched: ['fintech', 'java', 'postgres'] },
      { factId: 'f-nw-01', employer: 'Northwind Labs', rank: 12, matched: ['event-driven', 'java', 'kafka'] },
      { factId: 'f-fb-01', employer: 'Fabrikam', rank: 8.1583, matched: ['java', 'spring'] },
      { factId: 'f-nw-02', employer: 'Northwind Labs', rank: 7, matched: ['java', 'spring'] },
      { factId: 'f-nw-03', employer: 'Northwind Labs', rank: 5, matched: ['kubernetes'] },
      { factId: 'f-ct-03', employer: 'Contoso Retail', rank: 3.5333, matched: ['docker'] },
      { factId: 'f-ct-02', employer: 'Contoso Retail', rank: 3.325, matched: ['java'] },
      { factId: 'f-nw-04', employer: 'Northwind Labs', rank: 1, matched: [] },
      { factId: 'f-fb-02', employer: 'Fabrikam', rank: 0.0917, matched: [] },
    ]);
    // aws is backed by a citeable cert; elasticsearch only by a user-cannot-confirm fact, grpc by none; scala is a gap.
    expect(ev.covered).toEqual(['java', 'spring', 'kafka', 'postgres', 'event-driven', 'aws', 'kubernetes', 'fintech', 'docker']);
    expect(ev.missing).toEqual(['elasticsearch', 'grpc', 'scala']);
  });

  it('returns nothing below minFit, and one Evidence at or above it', async () => {
    const s = scoredOf(posting());
    expect(await evidenceMatcher.run({ ...s, score: 59 }, ctxFor(evidenceMatcher))).toEqual([]);
    expect(await evidenceMatcher.run({ ...s, score: 60 }, ctxFor(evidenceMatcher))).toHaveLength(1);
  });

  it('fails loudly without a pack', async () => {
    await expect(evidenceMatcher.run(scoredOf(posting()), ctxFor(evidenceMatcher, null))).rejects.toThrow(KernelError);
  });
});

const EXPECTED_RESUME_BODY = {
  jobKey: '0123456789abcdef',
  headline: 'Senior Backend Engineer',
  summary: {
    // aws is covered (the verified AWS cert backs it), but only an experience fact placed in a role may back a
    // "years building X" claim, so it is not a summary term.
    text: 'Senior Backend Engineer with 10+ years of experience. Core skills: Java, Spring, Kafka and PostgreSQL. Currently at Northwind Labs.',
    slots: { title: 'Senior Backend Engineer', years: 10, top1: 'Java', top2: 'Spring', top3: 'Kafka', top4: 'PostgreSQL', employer: 'Northwind Labs' },
  },
  skills: ['Java', 'Spring', 'Kafka', 'PostgreSQL', 'event-driven', 'AWS', 'Kubernetes', 'fintech', 'Docker', 'microservices', 'Redis', 'multi-tenant', 'SaaS', 'RabbitMQ', 'Python'],
  roles: [
    {
      employer: 'Northwind Labs',
      title: 'Senior Backend Engineer',
      location: 'Pune, India (Remote)',
      start: '2022-03',
      end: 'present',
      bullets: [
        { factId: 'f-nw-01', text: 'Led the design of an event-driven order pipeline on Kafka handling 40M events a day.' },
        { factId: 'f-nw-02', text: 'Cut p99 latency of the pricing service from 800 ms to 180 ms by introducing a Redis read-through cache.' },
        { factId: 'f-nw-03', text: 'Migrated a multi-tenant SaaS billing module from a monolith to three microservices on Kubernetes.' },
        { factId: 'f-nw-04', text: 'Mentored four engineers and ran the weekly design review for the platform group.' },
      ],
    },
    {
      employer: 'Contoso Retail',
      title: 'Software Engineer II',
      location: 'Bengaluru, India',
      start: '2018-06',
      end: '2022-02',
      bullets: [
        { factId: 'f-ct-01', text: 'Built the payments reconciliation service in Java and Postgres, processing 2M transactions nightly.' },
        { factId: 'f-ct-03', text: 'Owned the on-call rotation and wrote the first runbooks for the checkout stack.' },
        { factId: 'f-ct-02', text: 'Introduced RabbitMQ based retry queues that removed a class of duplicate-charge incidents.' },
      ],
    },
    {
      employer: 'Fabrikam',
      title: 'Software Engineer',
      location: 'Pune, India',
      start: '2016-07',
      end: '2018-05',
      bullets: [
        { factId: 'f-fb-01', text: 'Built REST services in Java with Spring and MySQL for the store-locator product.' },
        { factId: 'f-fb-02', text: 'Wrote a Python tool that generated nightly sales reports for regional managers.' },
      ],
    },
  ],
  certs: [
    { factId: 'f-ce-02', text: 'Certified Kubernetes Application Developer (CKAD).' },
    { factId: 'f-ce-01', text: 'AWS Certified Solutions Architect - Associate.' },
  ],
  education: [{ factId: 'f-ed-01', text: 'B.E. in Computer Engineering, Savitribai Phule Pune University.' }],
  unplaced: [],
  covered: ['java', 'spring', 'kafka', 'postgres', 'event-driven', 'aws', 'kubernetes', 'fintech', 'docker'],
  missing: ['elasticsearch', 'grpc', 'scala'],
  ats: 'greenhouse',
  firstSeen: '2026-10-01',
};

const EXPECTED_PARAGRAPHS = [
  {
    // The covered terms backed by an experience fact placed in a role, top three (aws is backed only by a cert).
    text: "I'm applying for the Senior Backend Engineer (Java) role at Acme Payments. I'm a Senior Backend Engineer with 10+ years of experience. The role asks for Java, Spring and Kafka, and I've used all three in my work. Three examples follow.",
    factIds: [],
  },
  {
    text: 'At Contoso Retail, I built the payments reconciliation service in Java and Postgres, processing 2M transactions nightly. At Northwind Labs, where I work now, I led the design of an event-driven order pipeline on Kafka handling 40M events a day.',
    factIds: ['f-ct-01', 'f-nw-01'],
  },
  { text: 'At Fabrikam, I built REST services in Java with Spring and MySQL for the store-locator product.', factIds: ['f-fb-01'] },
  { text: "I'm based in {city}, looking for a fully remote role, and available after {notice}. Thank you for considering my application.", factIds: [] },
];

describe('resume-planner', () => {
  it('plans the fixture resume exactly', () => {
    const ev = buildEvidence(scoredOf(posting()), pack);
    const plan = planResume(ev, pack);
    expect(ResumePlan.schema.parse(plan)).toEqual(plan);
    expect(plan).toEqual({ ...EXPECTED_RESUME_BODY, evidence: ev });
  });

  it('every bullet and cert is a citeable claim, character for character', () => {
    const plan = planResume(buildEvidence(scoredOf(posting()), pack), pack);
    const byId = new Map(pack.facts.map((f) => [f.id, f]));
    for (const b of [...plan.roles.flatMap((r) => r.bullets), ...plan.certs]) {
      expect(byId.get(b.factId)?.claim).toBe(b.text);
      expect(['verified', 'user-stated']).toContain(byId.get(b.factId)?.status);
    }
  });

  it('never cites a derived-unverified, user-cannot-confirm or rejected fact, even when its tech is all the JD asks', () => {
    const p = posting({ descriptionText: 'Scala, Elasticsearch, AWS, Kubernetes. Spot capacity and right-sizing.' });
    const plan = planResume(buildEvidence(scoredOf(p), pack), pack);
    const cited = [...plan.roles.flatMap((r) => r.bullets), ...plan.certs].map((b) => b.factId);
    for (const id of ['f-nw-05', 'f-ct-04', 'f-fb-03']) expect(cited).not.toContain(id);
    expect(plan.skills).not.toContain('Elasticsearch'); // backed only by f-fb-03 (user-cannot-confirm)
    expect(plan.skills).not.toContain('Scala'); // a gap skill, and backed only by the rejected f-ct-04
    expect(plan.missing).toEqual(['elasticsearch', 'scala']);
  });

  it('honours a fact override: a verified fact the user rejects is no longer cited', () => {
    const p2 = publicPack({ 'f-nw-01': 'rejected' });
    const plan = planResume(buildEvidence(scoredOf(posting(), p2), p2), p2);
    expect(plan.roles[0]?.bullets.map((b) => b.factId)).toEqual(['f-nw-02', 'f-nw-03', 'f-nw-04']);
    expect(plan.covered).not.toContain('kafka'); // f-nw-01 was the only fact with kafka
    expect(plan.skills).not.toContain('Kafka');
  });

  it('rewrites the forbidden employer through employerDisplay', () => {
    const plan = planResume(buildEvidence(scoredOf(posting()), pack), pack);
    const raw = pack.facts.find((f) => f.id === 'f-nw-04')?.employer ?? '';
    expect(() => assertNoForbidden(raw, pack.naming)).toThrow(); // the raw pack string does name it
    expect(plan.roles[0]?.bullets.some((b) => b.factId === 'f-nw-04')).toBe(true);
    expect(plan.roles[0]?.employer).toBe('Northwind Labs');
    const { evidence: _e, ...body } = plan;
    expect(() => assertNoForbidden(JSON.stringify(body), pack.naming)).not.toThrow();
    expect(() => assertNoForbidden(JSON.stringify(plan.evidence.ranked), pack.naming)).not.toThrow();
  });

  it('is a hard error when a raw employer names a forbidden term and has no mapping', async () => {
    const unmapped = freezePack({ ...pack, naming: { ...pack.naming, employerDisplay: {} } });
    expect(() => buildEvidence(scoredOf(posting()), unmapped as WritingPack)).toThrow(/forbidden term/);
    await expect(evidenceMatcher.run(scoredOf(posting()), ctxFor(evidenceMatcher, unmapped))).rejects.toMatchObject({ code: 'invalid_output' });
    const ev = buildEvidence(scoredOf(posting()), pack);
    await expect(resumePlanner.run(ev, ctxFor(resumePlanner, unmapped))).rejects.toMatchObject({ code: 'invalid_output' });
    const leaky = freezePack({ ...pack, naming: { ...pack.naming, employerDisplay: { ...pack.naming.employerDisplay, Fabrikam: 'Initech Labs' } } });
    expect(() => planResume(ev, leaky as WritingPack)).toThrow(/still holds a forbidden term/);
  });

  it('a role with no citeable facts still appears, with no bullets', () => {
    const extra = freezePack({
      ...pack,
      roles: [...pack.roles, { employer: 'Tailspin Toys', title: 'Intern', location: 'Pune', start: '2015-06', end: '2015-12' }],
    }) as WritingPack;
    const plan = planResume(buildEvidence(scoredOf(posting(), extra), extra), extra);
    expect(plan.roles.map((r) => r.employer)).toEqual(['Northwind Labs', 'Contoso Retail', 'Fabrikam', 'Tailspin Toys']);
    expect(plan.roles[3]?.bullets).toEqual([]);
  });

  it('picks the headline from the claimable titles only, verbatim; a tie goes to the claimableTitles order', () => {
    const head = (title: string, p: WritingPack = pack) => planResume(buildEvidence(scoredOf(posting({ title }), p), p), p).headline;
    // The default claimable titles are the ongoing roles' titles: here only Senior Backend Engineer (round 2 I-R1).
    for (const t of ['Principal Engineer', 'Software Engineer', 'Lead Software Engineer', 'Software Engineer II, Payments', 'Data Wrangler']) {
      expect(head(t), t).toBe('Senior Backend Engineer');
      const p1 = planCover(planResume(buildEvidence(scoredOf(posting({ title: t })), pack), pack), pack).paragraphs[0]!.text;
      expect(p1, t).toContain("I'm a Senior Backend Engineer with 10+ years");
      expect(p1, t).not.toMatch(/I'm an? Software Engineer/); // a past title is never stated as the current one
    }
    const custom = freezePack({ ...pack, targets: { ...pack.targets, claimableTitles: ['Backend Engineer', 'Software Engineer', 'SDE 3', 'Senior Backend Engineer'] } }) as WritingPack;
    expect(head('SDE 3, Payments', custom)).toBe('SDE 3'); // verbatim, no re-casing
    expect(head('Backend Engineer', custom)).toBe('Backend Engineer'); // it and Senior Backend Engineer tie at 2: list order wins
    expect(head('Lead Software Engineer', custom)).toBe('Software Engineer');
  });

  describe('(f) title selection: the claimable title closest to the posting title, never the current role title by default', () => {
    // The current role is "Founding Engineer"; the user may claim it, but it is employer-specific.
    const founding = (claimableTitles: string[]) =>
      freezePack({
        ...pack,
        roles: pack.roles.map((r) => (r.end === 'present' ? { ...r, title: 'Founding Engineer' } : r)),
        facts: pack.facts.map((f) => (f.role === 'Senior Backend Engineer' ? { ...f, role: 'Founding Engineer' } : f)),
        targets: { ...pack.targets, claimableTitles },
      }) as WritingPack;
    const head = (title: string, p: WritingPack) => {
      const r = planResume(buildEvidence(scoredOf(posting({ title }), p), p), p);
      return { headline: r.headline, summary: r.summary.text, p1: planCover(r, p).paragraphs[0]!.text };
    };

    it('a Staff Software Engineer posting picks the closest claimable title, in the resume headline, summary and letter', () => {
      const p = founding(['Founding Engineer', 'Senior Backend Engineer', 'Senior Software Engineer']);
      const x = head('Staff Software Engineer', p);
      expect(x.headline).toBe('Senior Software Engineer'); // software + engineer, and a seniority word against Staff
      expect(x.summary.startsWith('Senior Software Engineer with 10+ years of experience.')).toBe(true);
      expect(x.p1).toContain("I'm a Senior Software Engineer with 10+ years of experience.");
      expect(`${x.headline} ${x.summary} ${x.p1}`).not.toContain('Founding Engineer');
    });

    it('counts any seniority word as matching any other, so Founding Engineer loses a Staff posting even when listed first', () => {
      // The live shape: overlap alone ties (Engineer) and the list order would pick Founding Engineer.
      const p = founding(['Founding Engineer', 'Senior Backend Engineer']);
      expect(head('Staff Software Engineer', p).headline).toBe('Senior Backend Engineer');
      expect(head('Senior Software Engineer, Backend', p).headline).toBe('Senior Backend Engineer');
      expect(head('Lead Engineer', p).headline).toBe('Senior Backend Engineer');
      // a posting with no seniority word: a plain tie, so the list order decides
      expect(head('Software Engineer', p).headline).toBe('Founding Engineer');
      // the current role title wins only when it is claimable and the best match
      expect(head('Founding Engineer (Platform)', p).headline).toBe('Founding Engineer');
      expect(head('Founding Engineer (Platform)', founding(['Senior Backend Engineer'])).headline).toBe('Senior Backend Engineer');
    });

    it('breaks a tie by claimableTitles order, never by which title the current role has', () => {
      expect(head('Software Engineer', founding(['Senior Backend Engineer', 'Founding Engineer'])).headline).toBe('Senior Backend Engineer');
      expect(head('Platform Engineer', founding(['Backend Engineer', 'Founding Engineer'])).headline).toBe('Backend Engineer');
    });
  });

  it('with no ongoing role, uses the most recent role title in the past-tense p1 (round 2 I-R1)', () => {
    const ended = freezePack({ ...pack, roles: pack.roles.map((r) => (r.end === 'present' ? { ...r, end: '2026-06' } : r)), targets: { ...pack.targets, claimableTitles: [] } }) as WritingPack;
    const r = planResume(buildEvidence(scoredOf(posting({ title: 'Software Engineer' }), ended), ended), ended);
    expect(r.headline).toBe('Senior Backend Engineer');
    expect(planCover(r, ended).paragraphs[0]!.text).toBe(
      "I'm applying for the Software Engineer role at Acme Payments. I most recently worked as a Senior Backend Engineer and have 10+ years of experience. The role asks for Java, Spring and PostgreSQL, and I've used all three in my work. Three examples follow.",
    );
  });

  it('chooses a or an by sound, with a small exception list (round 2 minor)', () => {
    const cases: [string, string][] = [
      ['Senior Backend Engineer', 'a'], ['Engineering Manager', 'an'], ['SDE 3', 'an'], ['MLE', 'an'], ['SRE', 'an'], ['HR Partner', 'an'],
      ['UX Engineer', 'a'], ['Unix Engineer', 'a'], ['Ubiquitous Engineer', 'a'], ['Engineer', 'an'], ['Hourly Lead', 'an'], ['Honest Engineer', 'an'],
      ['Head of Platform', 'a'], ['One Platform Lead', 'a'], ['European Lead', 'a'], ['Infrastructure Engineer', 'an'], ['8-Figure Lead', 'an'], ['Staff Engineer', 'a'],
      // acronyms read as words take their word sound; initialisms (and single letters) are read letter by letter
      ['NASA Engineer', 'a'], ['FAANG Engineer', 'a'], ['SaaS Engineer', 'a'], ['SAAS Engineer', 'a'], ['AWS Engineer', 'an'], ['X-ray Engineer', 'an'], ['NATO Analyst', 'a'],
    ];
    for (const [t, a] of cases) expect(articleFor(t), t).toBe(a);
    const custom = freezePack({ ...pack, targets: { ...pack.targets, claimableTitles: ['Engineering Manager'] } }) as WritingPack;
    expect(planCover(planResume(buildEvidence(scoredOf(posting(), custom), custom), custom), custom).paragraphs[0]!.text).toContain("I'm an Engineering Manager with");
  });
});

describe('summary template', () => {
  const base = { title: 'Backend Engineer', years: 10, employer: 'Northwind Labs' };
  it('keeps the exact template strings', () => {
    expect(SUMMARY_TEMPLATE).toBe('{title} with {years}+ years of experience. Core skills: {top1}, {top2}, {top3} and {top4}. Currently at {employer}.');
    expect(COVER_OPENING).toBe("I'm applying for the {title} role at {company}.");
    expect(COVER_TITLE_NOW).toBe("I'm {article} {targetTitle} with {years}+ years of experience.");
    expect(COVER_TITLE_PAST).toBe('I most recently worked as {article} {targetTitle} and have {years}+ years of experience.');
    expect(COVER_TERMS).toBe("The role asks for {coveredList}, and I've used {quantifier} in my work.");
    expect(COVER_EXAMPLES).toEqual({ 1: 'One example follows.', 2: 'Two examples follow.', 3: 'Three examples follow.' });
    expect(EVIDENCE_AT).toBe('At {employer}, I {claim}');
    expect(EVIDENCE_AT_NOW).toBe('At {employer}, where I work now, I {claim}');
    expect(EVIDENCE_AT_COLON).toBe('At {employer}: {claim}');
    expect(EVIDENCE_THERE).toBe('There I also {claim}');
    expect(EVIDENCE_ALSO_AT).toBe('Also at {employer}, I {claim}');
    expect(EVIDENCE_ALSO_AT_COLON).toBe('Also at {employer}: {claim}');
    expect(COVER_P4).toBe("I'm based in {city}, looking for a fully remote role, and available after {notice}. Thank you for considering my application.");
  });
  it("uses I'm, never I am, in every cover template", () => {
    for (const t of [COVER_OPENING, COVER_TITLE_NOW, COVER_TITLE_PAST, COVER_TERMS, COVER_P4]) expect(t, t).not.toMatch(/\bI am\b/);
  });
  it('drops missing term slots, joining the rest with ", " and " and "', () => {
    expect(renderSummary({ ...base, top1: 'java', top2: 'kafka', top3: 'aws', top4: 'redis' })).toBe('Backend Engineer with 10+ years of experience. Core skills: java, kafka, aws and redis. Currently at Northwind Labs.');
    expect(renderSummary({ ...base, top1: 'java', top2: 'kafka', top3: 'aws' })).toBe('Backend Engineer with 10+ years of experience. Core skills: java, kafka and aws. Currently at Northwind Labs.');
    expect(renderSummary({ ...base, top1: 'java', top2: 'kafka' })).toBe('Backend Engineer with 10+ years of experience. Core skills: java and kafka. Currently at Northwind Labs.');
    expect(renderSummary({ ...base, top1: 'java' })).toBe('Backend Engineer with 10+ years of experience. Core skills: java. Currently at Northwind Labs.');
  });
  it('with no covered term, drops the building clause; with no current role, drops the Currently sentence', () => {
    expect(renderSummary(base)).toBe('Backend Engineer with 10+ years of experience. Currently at Northwind Labs.');
    expect(renderSummary({ title: 'Backend Engineer', years: 10, top1: 'java' })).toBe('Backend Engineer with 10+ years of experience. Core skills: java.');
    expect(joinList([])).toBe('');
    expect(joinList(['a', 'b', 'c'])).toBe('a, b and c');
  });
  it('plans fewer slots when fewer terms are covered', () => {
    const plan = planResume(buildEvidence(scoredOf(posting({ descriptionText: 'Java and Kafka, on Kubernetes.' })), pack), pack);
    expect(plan.summary).toEqual({
      text: 'Senior Backend Engineer with 10+ years of experience. Core skills: Java, Kafka and Kubernetes. Currently at Northwind Labs.',
      slots: { title: 'Senior Backend Engineer', years: 10, top1: 'Java', top2: 'Kafka', top3: 'Kubernetes', employer: 'Northwind Labs' },
    });
    const none = planResume(buildEvidence(scoredOf(posting({ descriptionText: 'Build things.' })), pack), pack);
    expect(none.summary).toEqual({
      text: 'Senior Backend Engineer with 10+ years of experience. Currently at Northwind Labs.',
      slots: { title: 'Senior Backend Engineer', years: 10, employer: 'Northwind Labs' },
    });
    expect(none.covered).toEqual([]);
    // every backed key is still listed, by display name, none of them from the JD
    expect(none.skills).toEqual(['Java', 'Spring', 'Kafka', 'microservices', 'PostgreSQL', 'event-driven', 'AWS', 'Kubernetes', 'Redis', 'multi-tenant', 'SaaS', 'fintech', 'RabbitMQ', 'Docker', 'Python']);
  });
  it('does not claim a current employer when no role is ongoing', () => {
    // 23 + 45 + 52 months (2022-03..2026-06, the end month included) = 120 months.
    const ended = freezePack({ ...pack, roles: pack.roles.map((r) => (r.end === 'present' ? { ...r, end: '2026-06' } : r)) }) as WritingPack;
    const plan = planResume(buildEvidence(scoredOf(posting(), ended), ended), ended);
    // The Northwind facts run '..present' (to asOf 2026-10), past the role's new end, so none is placed (fix I3):
    // Kafka loses its only experience backing and the Northwind role has no bullets.
    expect(plan.summary.text).toBe('Senior Backend Engineer with 10+ years of experience. Core skills: Java, Spring, PostgreSQL and fintech.');
    expect(plan.summary.slots).not.toHaveProperty('employer');
    expect(plan.unplaced).toEqual(['f-nw-01', 'f-nw-02', 'f-nw-03', 'f-nw-04']);
    expect(plan.roles[0]?.bullets).toEqual([]);
  });
});

describe('cover-writer', () => {
  it('plans the fixture cover letter exactly, availability left as renderer placeholders', () => {
    const resume = planResume(buildEvidence(scoredOf(posting()), pack), pack);
    const cover = planCover(resume, pack);
    expect(CoverPlan.schema.parse(cover)).toEqual(cover);
    expect(cover).toEqual({ jobKey: '0123456789abcdef', resume, paragraphs: EXPECTED_PARAGRAPHS });
  });

  it('leaves exactly the two renderer placeholders; available_from is never one', () => {
    const resume = planResume(buildEvidence(scoredOf(posting()), pack), pack);
    const text = planCover(resume, pack).paragraphs.map((p) => p.text).join('\n');
    expect(text.match(/\{[A-Za-z]+\}/g)).toEqual([...RENDER_PLACEHOLDERS]);
    expect(RENDER_PLACEHOLDERS).toEqual(['{city}', '{notice}']);
    expect(text).not.toMatch(/available from|availableFrom/i);
    const { pack: full } = loadPack(packDir);
    expect(full.answers).toMatchObject({ notice_period: '30 days' });
    expect(full.contact.city).toBe('Pune');
    expect(Object.keys(pack)).not.toContain('answers'); // the cover-writer never sees them
    expect(Object.keys(pack)).not.toContain('contact');
  });

  it('never mentions a missing or gap skill', () => {
    const resume = planResume(buildEvidence(scoredOf(posting()), pack), pack);
    const text = planCover(resume, pack).paragraphs.map((p) => p.text).join(' ');
    expect(resume.missing).toEqual(['elasticsearch', 'grpc', 'scala']);
    for (const t of ['Elasticsearch', 'gRPC', 'Scala', 'appears in the work above', 'Relevant work']) expect(text).not.toContain(t);
  });

  it('(b) anchors each fact to its display employer: a past-tense verb lower-cased after "I", anything else after a colon', () => {
    const at = (claim: string, extra: Partial<Parameters<typeof evidenceSentence>[0]> = {}) => evidenceSentence({ employer: 'Fabrikam', claim, ongoing: false, after: 'first', ...extra });
    expect(at('Built REST services.')).toBe('At Fabrikam, I built REST services.');
    expect(at('Led the platform team')).toBe('At Fabrikam, I led the platform team.');
    expect(at('Re-architected the billing flow.')).toBe('At Fabrikam, I re-architected the billing flow.');
    expect(at('Shipped the v2 API.', { ongoing: true })).toBe('At Fabrikam, where I work now, I shipped the v2 API.');
    // not a past-tense verb: the claim stays verbatim after a colon
    expect(at('Mentorship of four engineers.')).toBe('At Fabrikam: Mentorship of four engineers.');
    expect(at('Kafka pipeline handling 40M events a day.', { ongoing: true })).toBe('At Fabrikam: Kafka pipeline handling 40M events a day.');
    expect(at('Distributed tracing rollout across 40 services.')).toBe('At Fabrikam: Distributed tracing rollout across 40 services.');
    expect(at('Embedded systems work on payment terminals.')).toBe('At Fabrikam: Embedded systems work on payment terminals.');
    expect(at('Speed-up of the nightly batch by 4x.')).toBe('At Fabrikam: Speed-up of the nightly batch by 4x.');
    expect(at('AWS migration lead for three products.')).toBe('At Fabrikam: AWS migration lead for three products.');
    expect(at('SEEDED the cache.')).toBe('At Fabrikam: SEEDED the cache.'); // not sentence case: never re-cased
    // the same employer again
    expect(at('Wrote the runbooks.', { after: 'adjacent' })).toBe('There I also wrote the runbooks.');
    expect(at('On-call owner.', { after: 'adjacent' })).toBe('Also at Fabrikam: On-call owner.');
    expect(at('Wrote the runbooks.', { after: 'again' })).toBe('Also at Fabrikam, I wrote the runbooks.');
    expect(at('On-call owner.', { after: 'again' })).toBe('Also at Fabrikam: On-call owner.');
    for (const w of ['Built', 'Led', 'Ran', 'Wrote', 'Drove', 'Made', 'Set', 'Cut', 'Grew', 'Took', 'Began', 'Won', 'Shipped', 'Owned', 'Co-led']) expect(startsWithPastVerb(`${w} x`), w).toBe(true);
    for (const w of ['Need', 'Seed', 'Red', 'Speed', 'Feed', 'Mentorship', 'Distributed', 'Embedded', 'Advanced', 'Ed', 'I', 'Go', 'Java']) expect(startsWithPastVerb(`${w} x`), w).toBe(false);
  });

  describe('evidence selection prefers verb-led facts (a colon-form fact is swapped for a verb-led one backing its letter terms)', () => {
    const nounLed = (claims: Record<string, string>) =>
      freezePack({ ...pack, facts: pack.facts.map((f) => (claims[f.id] !== undefined ? { ...f, claim: claims[f.id] as string } : f)) }) as WritingPack;
    const letterOf = (pk: WritingPack) => {
      const resume = planResume(buildEvidence(scoredOf(posting(), pk), pk), pk);
      return { resume, cover: planCover(resume, pk) };
    };
    const P1 = EXPECTED_PARAGRAPHS[0]!;

    it('a noun-led top fact gives way to the highest-ranked verb-led bullet outside the top 3 that backs its letter terms', () => {
      // f-ct-01 (rank 1) backs java among the letter's terms (Java, Spring, Kafka); f-nw-02 ("Cut ...", rank 4) backs java too.
      const pk = nounLed({ 'f-ct-01': 'Payments reconciliation service in Java and Postgres, processing 2M transactions nightly.' });
      const { resume, cover } = letterOf(pk);
      expect(resume.evidence.ranked.slice(0, 4).map((r) => r.factId)).toEqual(['f-ct-01', 'f-nw-01', 'f-fb-01', 'f-nw-02']);
      expect(cover.paragraphs).toEqual([
        P1, // the covered list and "I've used all three" are unchanged
        {
          text: 'At Northwind Labs, where I work now, I cut p99 latency of the pricing service from 800 ms to 180 ms by introducing a Redis read-through cache. There I also led the design of an event-driven order pipeline on Kafka handling 40M events a day.',
          factIds: ['f-nw-02', 'f-nw-01'],
        },
        { text: 'At Fabrikam, I built REST services in Java with Spring and MySQL for the store-locator product.', factIds: ['f-fb-01'] },
        { text: COVER_P4, factIds: [] },
      ]);
      expect(coverProblems(cover, pk)).toEqual([]); // G-GROUND recomputes the same selection, byte for byte
      // the resume is untouched: every placed fact in role order, the noun-led claim included
      expect(resume.roles[1]!.bullets[0]).toEqual({ factId: 'f-ct-01', text: 'Payments reconciliation service in Java and Postgres, processing 2M transactions nightly.' });
    });

    it('keeps the colon form when no verb-led fact outside the top 3 backs every letter term it contributes', () => {
      // f-nw-01 backs java and kafka; no other fact backs kafka.
      const pk = nounLed({ 'f-nw-01': 'Event-driven order pipeline design on Kafka handling 40M events a day.' });
      const { cover } = letterOf(pk);
      expect(cover.paragraphs[1]).toEqual({
        text: 'At Contoso Retail, I built the payments reconciliation service in Java and Postgres, processing 2M transactions nightly. At Northwind Labs: Event-driven order pipeline design on Kafka handling 40M events a day.',
        factIds: ['f-ct-01', 'f-nw-01'],
      });
      expect(coverProblems(cover, pk)).toEqual([]);
    });

    it('swaps in rank order: an earlier colon fact takes the substitute a later one would also need', () => {
      // f-ct-01 (java) takes f-nw-02; f-fb-01 (java, spring) then has no verb-led fact left backing both, so stays a colon.
      const pk = nounLed({
        'f-ct-01': 'Payments reconciliation service in Java and Postgres, processing 2M transactions nightly.',
        'f-fb-01': 'REST services in Java with Spring and MySQL for the store-locator product.',
      });
      const { cover } = letterOf(pk);
      expect(cover.paragraphs.slice(1, 3)).toEqual([
        {
          text: 'At Northwind Labs, where I work now, I cut p99 latency of the pricing service from 800 ms to 180 ms by introducing a Redis read-through cache. There I also led the design of an event-driven order pipeline on Kafka handling 40M events a day.',
          factIds: ['f-nw-02', 'f-nw-01'],
        },
        { text: 'At Fabrikam: REST services in Java with Spring and MySQL for the store-locator product.', factIds: ['f-fb-01'] },
      ]);
      expect(coverProblems(cover, pk)).toEqual([]);
    });
  });

  it('(c) shows the display employer, never the raw one, when a fact of the forbidden raw employer is cited', () => {
    // f-nw-04's raw employer names the forbidden term; make it the top fact.
    const top = freezePack({ ...pack, facts: pack.facts.map((f) => (f.id === 'f-nw-04' ? { ...f, tech: ['java', 'kafka', 'postgres', 'spring'] } : f)) }) as WritingPack;
    const c = planCover(planResume(buildEvidence(scoredOf(posting(), top), top), top), top);
    expect(c.paragraphs[1]!.factIds[0]).toBe('f-nw-04');
    expect(c.paragraphs[1]!.text.startsWith('At Northwind Labs, where I work now, I mentored four engineers and ran the weekly design review for the platform group.')).toBe(true);
    const text = c.paragraphs.map((p) => p.text).join(' ');
    expect(text).not.toMatch(/initech|GCC/i);
    expect(() => assertNoForbidden(text, pack.naming)).not.toThrow();
  });

  it('a second fact from the same employer says "There I also"; a later one in another paragraph "Also at"', () => {
    const jd = 'Stack: Java, Spring Boot, Kafka, microservices, PostgreSQL, event-driven design, AWS, Kubernetes, Redis.';
    const resume = planResume(buildEvidence(scoredOf(posting({ title: 'Lead Software Engineer', descriptionText: jd })), pack), pack);
    expect(resume.evidence.ranked.slice(0, 3).map((r) => r.factId)).toEqual(['f-nw-01', 'f-nw-02', 'f-nw-03']);
    expect(planCover(resume, pack).paragraphs.slice(1, 3)).toEqual([
      {
        text: 'At Northwind Labs, where I work now, I led the design of an event-driven order pipeline on Kafka handling 40M events a day. There I also cut p99 latency of the pricing service from 800 ms to 180 ms by introducing a Redis read-through cache.',
        factIds: ['f-nw-01', 'f-nw-02'],
      },
      { text: 'Also at Northwind Labs, I migrated a multi-tenant SaaS billing module from a monolith to three microservices on Kubernetes.', factIds: ['f-nw-03'] },
    ]);
  });

  it('p1 lists at most three covered terms an experience fact backs, with "it" or "both" for fewer', () => {
    const p1 = (descriptionText: string) => planCover(planResume(buildEvidence(scoredOf(posting({ descriptionText })), pack), pack), pack).paragraphs[0]!.text;
    expect(p1('Java only.')).toContain("The role asks for Java, and I've used it in my work.");
    expect(p1('Java and Kafka.')).toContain("The role asks for Java and Kafka, and I've used both in my work.");
    // AWS is backed only by a cert: never claimed as used in work
    expect(p1('AWS and Kafka.')).toContain("The role asks for Kafka, and I've used it in my work.");
    // nothing covered: no terms sentence, the examples still follow
    expect(p1('Build things.')).toBe("I'm applying for the Senior Backend Engineer (Java) role at Acme Payments. I'm a Senior Backend Engineer with 10+ years of experience. Three examples follow.");
  });

  it('degrades without inventing: one ranked fact, "One example follows."', () => {
    const solo = freezePack({ ...pack, facts: pack.facts.filter((f) => f.id === 'f-nw-04' || f.kind === 'cert') }) as WritingPack;
    const resume = planResume(buildEvidence(scoredOf(posting(), solo), solo), solo);
    expect(planCover(resume, solo).paragraphs.map((p) => p.text)).toEqual([
      "I'm applying for the Senior Backend Engineer (Java) role at Acme Payments. I'm a Senior Backend Engineer with 10+ years of experience. One example follows.",
      'At Northwind Labs, where I work now, I mentored four engineers and ran the weekly design review for the platform group.',
      COVER_P4,
    ]);
  });

  it('never cites a fact no role holds (a project or fact with no matching employer role)', () => {
    const loose = freezePack({
      ...pack,
      facts: [...pack.facts, { id: 'f-px-01', claim: 'Built an open-source Kafka and Java toolkit with PostgreSQL and Spring.', tech: ['java', 'kafka', 'postgres', 'spring', 'event-driven'], employer: 'Personal', period: '2025-01..2025-06', kind: 'project', status: 'verified' }],
      naming: { ...pack.naming, employerDisplay: { ...pack.naming.employerDisplay, Personal: 'Personal' } },
    }) as WritingPack;
    const c = planCover(planResume(buildEvidence(scoredOf(posting(), loose), loose), loose), loose);
    expect(c.paragraphs.flatMap((p) => p.factIds)).not.toContain('f-px-01');
    expect(c.paragraphs.map((p) => p.text).join(' ')).not.toContain('Personal');
  });
});

describe('cover-writer: signature facts (writing.signatureFacts)', () => {
  const withSignature = (ids: string[], base: WritingPack = pack) => freezePack({ ...base, writing: { signatureFacts: ids } }) as WritingPack;
  const letterOf = (pk: WritingPack, p: Posting = posting()) => {
    const resume = planResume(buildEvidence(scoredOf(p, pk), pk), pk);
    return { resume, cover: planCover(resume, pk) };
  };
  const NW03 = 'Migrated a multi-tenant SaaS billing module from a monolith to three microservices on Kubernetes.';

  it('has at least three leads, each ending in ": " before the claim, so the claim stays byte-identical', () => {
    expect(SIGNATURE_LEADS.length).toBeGreaterThanOrEqual(3);
    for (const l of SIGNATURE_LEADS) expect(l, l).toMatch(/\{employer\}: \{claim\}$/);
  });

  it('adds one sentence, the first citeable signature fact verbatim, after the evidence and before p4, with its fact id', () => {
    const pk = withSignature(['f-nw-03']);
    const { cover } = letterOf(pk);
    expect(cover.paragraphs.slice(0, 3)).toEqual(EXPECTED_PARAGRAPHS.slice(0, 3));
    expect(cover.paragraphs[3]).toEqual({ text: `Beyond the stack this role lists, at Northwind Labs: ${NW03}`, factIds: ['f-nw-03'] });
    expect(cover.paragraphs[4]).toEqual({ text: COVER_P4, factIds: [] });
    expect(cover.paragraphs).toHaveLength(5);
    expect(coverProblems(cover, pk)).toEqual([]); // G-GROUND re-derives it byte for byte
  });

  it('adds nothing when a signature fact is already among the evidence facts', () => {
    expect(letterOf(withSignature(['f-nw-01'])).cover.paragraphs).toEqual(EXPECTED_PARAGRAPHS);
    expect(letterOf(withSignature(['f-nw-03', 'f-ct-01'])).cover.paragraphs).toEqual(EXPECTED_PARAGRAPHS);
  });

  it('skips a fact that is not citeable, unknown, or placed in no role, and takes the next', () => {
    const pk = withSignature(['f-nw-05', 'nope', 'f-ed-01', 'f-nw-03', 'f-nw-02']);
    const { cover } = letterOf(pk);
    expect(cover.paragraphs[3]?.factIds).toEqual(['f-nw-03']);
    expect(coverProblems(cover, pk)).toEqual([]);
    // none usable: the letter is as without signature facts
    expect(letterOf(withSignature(['f-nw-05'])).cover.paragraphs).toEqual(EXPECTED_PARAGRAPHS);
    expect(letterOf(withSignature([])).cover.paragraphs).toEqual(EXPECTED_PARAGRAPHS);
  });

  it('chooses the lead deterministically from the jobKey, and every lead is reachable', () => {
    const pk = withSignature(['f-nw-03']);
    const keys = ['0123456789abcdef', '0123456789abcdf0', '0123456789abcdf1', '0123456789abcdf2'];
    const leads = keys.map((k) => signatureLead(k));
    expect(new Set(leads).size).toBe(3);
    for (const k of keys) {
      const a = letterOf(pk, posting({ jobKey: k })).cover.paragraphs[3]!.text;
      expect(letterOf(pk, posting({ jobKey: k })).cover.paragraphs[3]!.text).toBe(a);
      expect(a).toBe(`${signatureLead(k).replace('{employer}', 'Northwind Labs').replace('{claim}', NW03)}`);
    }
  });

  it('G-GROUND catches a tampered signature sentence or fact id', () => {
    const pk = withSignature(['f-nw-03']);
    const { cover } = letterOf(pk);
    const swap = (i: number, p: { text: string; factIds: string[] }) => ({ ...cover, paragraphs: cover.paragraphs.map((x, j) => (j === i ? p : x)) });
    const sig = cover.paragraphs[3]!;
    for (const bad of [
      swap(3, { ...sig, text: sig.text.replace('three', 'five') }),
      swap(3, { ...sig, text: sig.text.replace('Beyond the stack this role lists', 'Alongside that') }),
      swap(3, { ...sig, factIds: ['f-nw-02'] }),
      { ...cover, paragraphs: cover.paragraphs.filter((_, j) => j !== 3) },
    ]) expect(coverProblems(bad as CoverPlan, pk).length).toBeGreaterThan(0);
    // and the letter without signature facts is caught under a pack that has them
    expect(coverProblems(letterOf(pack).cover, pk)).toContain('paragraphs[3] is not the template rendering of its computed slots and facts');
  });
});

describe('the writing agents', () => {
  it('declare one deterministic contract each, reading the public pack, with the app guardrails out', () => {
    for (const [agent, out] of [
      [evidenceMatcher, ['G-NAMING']],
      [resumePlanner, ['G-GROUND', 'G-NAMING', 'G-NO-GAP-CLAIM']],
      [coverWriter, ['G-GROUND', 'G-NAMING']],
    ] as const) {
      expect(agent.contract).toMatchObject({ team: 'writing', kind: 'deterministic', capabilities: { pack: true } });
      expect(agent.contract.capabilities).not.toHaveProperty('llm');
      expect(agent.contract.guardrails.out).toEqual(out);
    }
    expect(evidenceMatcher.contract.produces.id).toBe('Evidence@1');
    expect(resumePlanner.contract.produces.id).toBe('ResumePlan@1');
    expect(coverWriter.contract.produces.id).toBe('CoverPlan@1');
  });

  it('chain end to end through their contexts, deterministically', async () => {
    const run = async () => {
      const [ev] = await evidenceMatcher.run(scoredOf(posting()), ctxFor(evidenceMatcher));
      const [plan] = await resumePlanner.run(ev as Evidence, ctxFor(resumePlanner));
      return coverWriter.run(plan as ResumePlan, ctxFor(coverWriter));
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect((a[0] as CoverPlan).paragraphs).toEqual(EXPECTED_PARAGRAPHS);
  });
});

describe('fix round 1: review probes as regressions', () => {
  const plans = (p: Posting, pk: WritingPack = pack) => {
    const ev = buildEvidence(scoredOf(p, pk), pk);
    const r = planResume(ev, pk);
    return { ev, r, c: planCover(r, pk) };
  };
  const base = plans(posting());

  it('C1: postedAt never moves years or recency (2040, 2019, null)', () => {
    for (const postedAt of ['2040-01-01', '2019-01-01', null]) {
      const x = plans(posting({ postedAt }));
      expect(x.r.summary.slots['years'], String(postedAt)).toBe(10);
      expect(x.r.summary.text).toBe(base.r.summary.text);
      expect(x.ev.ranked).toEqual(base.ev.ranked);
      expect(x.r.roles).toEqual(base.r.roles);
    }
    // asOf, not the posting, moves them: a pack a year later has 11 years and older recency.
    const later = freezePack({ ...pack, experience: { asOf: '2027-07' } }) as WritingPack;
    expect(plans(posting(), later).r.summary.slots['years']).toBe(11);
  });

  it('I2: a cert, a project or an education fact never backs a "years building X" term', () => {
    const awsOnly = plans(posting({ descriptionText: 'We run on AWS and Kubernetes. Python scripting helpful.' }));
    expect(awsOnly.r.covered).toEqual(['aws', 'kubernetes', 'python']); // AWS by the cert, Python by a project
    expect(awsOnly.r.summary.text).toBe('Senior Backend Engineer with 10+ years of experience. Core skills: Kubernetes. Currently at Northwind Labs.');
    expect(awsOnly.r.skills.slice(0, 3)).toEqual(['AWS', 'Kubernetes', 'Python']); // the skills line may still list them
    const edu = freezePack({ ...pack, facts: pack.facts.map((f) => (f.id === 'f-ed-01' ? { ...f, tech: ['go'] } : f)) }) as WritingPack;
    const goJd = plans(posting({ descriptionText: 'Go and Kubernetes services.' }), edu);
    expect(goJd.r.covered).toEqual(['kubernetes']);
    expect(goJd.r.skills).not.toContain('Go');
    expect(goJd.r.summary.text).not.toContain('Go');
  });

  it('I3: a fact dated outside every role at its employer is unplaced, never shown under the nearest role', () => {
    const outside = freezePack({
      ...pack,
      facts: [...pack.facts, { id: 'f-fb-09', claim: 'Built a Java billing engine used by 3 banks.', tech: ['java'], employer: 'Fabrikam', period: '2010-01..2011-01', kind: 'experience', status: 'verified' }],
    }) as WritingPack;
    const a = plans(posting(), outside);
    expect(a.r.roles.flatMap((r) => r.bullets.map((b) => b.factId))).not.toContain('f-fb-09');
    expect(a.r.unplaced).toEqual(['f-fb-09']);
    expect(a.c.paragraphs.flatMap((p) => p.factIds)).not.toContain('f-fb-09');

    const twoRoles = freezePack({
      ...pack,
      roles: [...pack.roles, { employer: 'Northwind Labs', title: 'Backend Engineer', location: 'Pune', start: '2020-01', end: '2021-01' }],
      facts: [
        ...pack.facts,
        { id: 'f-nw-09', claim: 'Designed the Java ledger for Northwind.', tech: ['java'], employer: 'Northwind Labs', period: '2021-03..2021-09', kind: 'experience', status: 'verified' },
        { id: 'f-nw-10', claim: 'Shipped the first Northwind billing API.', tech: ['java'], employer: 'Northwind Labs', period: '2020-02..2020-11', kind: 'experience', status: 'verified' },
      ],
    }) as WritingPack;
    const b = plans(posting(), twoRoles);
    expect(b.r.unplaced).toEqual(['f-nw-09']); // in the gap between the two Northwind roles
    const old = b.r.roles.find((r) => r.title === 'Backend Engineer')!;
    expect(old.bullets.map((x) => x.factId)).toEqual(['f-nw-10']); // inside the 2020 role, so placed there
  });

  it('I5: every shown term is its display name, a synonym tag included', () => {
    const ai = freezePack({
      ...pack,
      facts: [...pack.facts, { id: 'f-nw-11', claim: 'Used an AI chatbot API in an internal demo.', tech: ['ai'], employer: 'Northwind Labs', period: '2024-01..2024-02', kind: 'project', status: 'user-stated' }],
    }) as WritingPack;
    const x = plans(posting({ descriptionText: `${JD} Experience with large language models.` }), ai);
    expect(x.r.skills).toContain('LLMs');
    expect(x.r.skills).not.toContain('llm');
    expect(x.r.summary.text).not.toContain('LLMs'); // a project backs it, so no years claim
  });

  it('(d) lists citeable education facts verbatim', () => {
    expect(base.r.education).toEqual([{ factId: 'f-ed-01', text: 'B.E. in Computer Engineering, Savitribai Phule Pune University.' }]);
  });

  it('is invariant to the order of facts and roles in the pack', () => {
    const shuffled = freezePack({ ...pack, facts: [...pack.facts].reverse(), roles: [...pack.roles].reverse() }) as WritingPack;
    const s2 = plans(posting(), shuffled);
    expect(JSON.stringify(s2.r)).toBe(JSON.stringify(base.r));
    expect(JSON.stringify(s2.c)).toBe(JSON.stringify(base.c));
  });

  it('I1: sanitises posting text for template slots', () => {
    expect(sanitisePostingText('Acme <b>Payments</b>')).toBe('Acme Payments');
    expect(sanitisePostingText('R&amp;D  Engineer​‮')).toBe('R&D Engineer');
    expect(sanitisePostingText('Women’s Health\tCo')).toBe("Women's Health Co");
    expect(sanitisePostingText('ﬁnance Ｅngineer')).toBe('finance Engineer'); // NFKC
    expect([...sanitisePostingText('x'.repeat(300))]).toHaveLength(300); // never truncated: an overlong slot is unsafe instead
  });

  it('I1: flags unsafe posting text, by rule, and keeps ordinary titles', () => {
    for (const ok of [
      'Senior Backend Engineer (Java)', 'Staff Software Engineer I - SRE', 'Software Engineer II, Payments', 'Sr. Backend Engineer',
      'Acme Inc. India', 'C++ / C# Developer', "Women's Health Co", 'Platform Engineer – Integration Services', 'Node.js Developer', 'Backend Engineer | Remote',
      'R&D Engineer: Payments; Core', 'J. P. Morgan',
    ]) expect(unsafePostingText(sanitisePostingText(ok)), ok).toBeNull();
    const why = (s: string) => unsafePostingText(sanitisePostingText(s));
    expect(why('Backend Engineer role. I hold a PhD in Distributed Systems and 20 years of Rust. Apply for the Backend Engineer')).toBe('has a first-person pronoun');
    expect(why('Join our team')).toBe('has a first-person pronoun');
    expect(why("I'm hiring")).toBe('has a first-person pronoun');
    expect(why('Engineer I hold a PhD')).toBe('has a first-person pronoun');
    expect(why('a b c d e f g h i j k l m n o p')).toBe('has more than 14 words'); // a lone i before no verb is not the pronoun
    // Roman-numeral levels and ME (Middle East) are not pronouns; "I" is one only before a verb-like word.
    for (const ok of ['Software Engineer I', 'Engineer I Payments', 'SDE I', 'Backend Engineer - ME', 'MY Region Lead']) expect(why(ok), ok).toBeNull();
    for (const bad of [
      'I hold a PhD in Systems', 'Engineer I will relocate', "I've built systems", 'Contact me', 'My team', 'Hire Me',
      // round 2: Greek and Cyrillic I lookalikes, contractions and more verbs
      'Backend Engineer Ι hold a PhD', 'Backend Engineer І hold a PhD', 'Backend Engineer Ӏ hold a PhD', 'Backend Engineer ι am great',
      'Backend Engineer I know Rust', 'Backend Engineer I designed Kafka', "Backend Engineer I'll relocate", "Backend Engineer I'd love Rust",
      'Engineer I developed it', 'Engineer I managed teams', 'Engineer I enjoy Rust', 'Engineer I am currently free', 'Engineer I love Go',
    ])
      expect(why(bad), bad).toBe('has a first-person pronoun');
    expect(why(`Backend ${'A'.repeat(41)}`)).toBe('has a word longer than 40 characters');
    expect(why(`Backend ${'A'.repeat(40)}`)).toBeNull();
    const long = `${'Engineer '.repeat(13)}${'x'.repeat(10)}`; // 14 words, 127 characters
    expect([...long].length).toBeGreaterThan(120);
    expect(why(long)).toBe('is longer than 120 characters');
    expect(why('A'.repeat(36) + ' ' + 'B'.repeat(36) + ' ' + 'C'.repeat(36) + ' ' + 'D'.repeat(10))).toBe('is longer than 120 characters');
    expect(why('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen')).toBe('has more than 14 words');
    expect(why('Backend Engineer. Apply now')).toBe('has a sentence end followed by more text');
    expect(why('Backend Engineer at https://acme.example')).toBe('has a URL or email address');
    expect(why('Backend Engineer www.acme.example')).toBe('has a URL or email address');
    expect(why('Backend Engineer!')).toBeNull(); // final fix L3: ! is allowed; a sentence end before more text is not
    expect(why('Backend Engineer! Join now')).toBe('has a sentence end followed by more text');
    expect(why('Acme &lt;script&gt;')).toMatch(/^has a character outside the allowed set/);
    expect(why('Backend {notice} Engineer')).toMatch(/^has a character outside the allowed set/);
    expect(why('jobs@acme.example')).toMatch(/^has a character outside the allowed set|^has a URL/);
    expect(why('   ')).toBe('is empty');
  });

  it('final fix L3: allows [ ] _ % − ‐ " \' ! ? @ * + = ~ and the LIVE RUN 1 titles; still blocks markup, URLs and emails', () => {
    const why = (s: string) => unsafePostingText(sanitisePostingText(s));
    for (const ok of [
      'Senior Full Stack Developer [Java, Angular]',
      'Principal Software Engineer_Fullstack',
      'Technical Lead - GPU Infrastructure (100% Remote - Worldwide)',
      'Senior PHP Backend Engineer (Remote, Full-Time) [AR025]',
      'Senior Backend Developer (Go) — Full Remote, European Timezones Only (UTC−1 to UTC+3)',
      'Backend Engineer ‐ Payments',
      'Staff Engineer "Core"',
      'Engineer @ Scale',
      'Data Engineer*',
      'C++ = Fun?',
      'Platform Engineer ~ Infra',
    ]) expect(why(ok), ok).toBeNull();
    for (const ch of ['<', '>', '{', '}', '`', '\\']) expect(why(`Backend ${ch} Engineer`), ch).toMatch(/^has a character outside the allowed set/);
    expect(why('Backend Engineer \u0007 now')).toBeNull(); // a control character is sanitised to a space, never kept
    expect(unsafePostingText('Backend\u0007Engineer')).toMatch(/^has a character outside the allowed set/);
    expect(why('Backend Engineer at https://acme.example')).toBe('has a URL or email address');
    expect(why('Write to jobs@acme.example')).toBe('has a URL or email address');
    expect(why('Join our team!')).toBe('has a first-person pronoun');
    expect(why('Backend Engineer? Apply today')).toBe('has a sentence end followed by more text');
  });
});
