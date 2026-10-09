import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coverWriter } from '../../src/app/agents/writing/cover-writer.js';
import { evidenceMatcher } from '../../src/app/agents/writing/evidence-matcher.js';
import { buildEvidence, firstSeenOf, planCover, planResume, yearsOf, type WritingPack } from '../../src/app/agents/writing/grounded.js';
import { resumePlanner } from '../../src/app/agents/writing/resume-planner.js';
import { COVER_P1, COVER_P3_TAIL, COVER_P3_TAIL_ONE, COVER_P4, joinList, RENDER_PLACEHOLDERS, renderSummary, sanitisePostingText, SUMMARY_TEMPLATE, unsafePostingText } from '../../src/app/agents/writing/templates.js';
import { scorePosting } from '../../src/app/agents/scorer-lexicon.js';
import { tagIs } from '../../src/app/lexicon.js';
import { loadPack } from '../../src/app/pack/load.js';
import { assertNoForbidden } from '../../src/app/pack/rules.js';
import type { Fact } from '../../src/app/pack/schema.js';
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
    text: 'Senior Backend Engineer with 10+ years building Java, Spring, Kafka and PostgreSQL systems. Currently at Northwind Labs.',
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
    text: 'I am applying for the Senior Backend Engineer (Java) role at Acme Payments. I am a Senior Backend Engineer with 10+ years of experience. I am based in India and am looking for a fully remote role.',
    factIds: [],
  },
  {
    text: 'Relevant work: Built the payments reconciliation service in Java and Postgres, processing 2M transactions nightly. Led the design of an event-driven order pipeline on Kafka handling 40M events a day.',
    factIds: ['f-ct-01', 'f-nw-01'],
  },
  {
    // fintech is covered, but the cited text says "payments" (a synonym), so it is not listed.
    text: 'Built REST services in Java with Spring and MySQL for the store-locator product. The role asks for Java, Spring, Kafka, PostgreSQL and event-driven; each appears in the work above.',
    factIds: ['f-fb-01'],
  },
  { text: 'I am available from {availableFrom}, with a notice period of {notice}. Thank you for your time.', factIds: [] },
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

  it('picks the headline from the claimable titles only, verbatim; a tie goes to the most recent role title (fix C2)', () => {
    const head = (title: string, p: WritingPack = pack) => planResume(buildEvidence(scoredOf(posting({ title }), p), p), p).headline;
    // The default claimable titles are the role titles: Senior Backend Engineer, Software Engineer II, Software Engineer.
    expect(head('Principal Engineer')).toBe('Senior Backend Engineer'); // never "Principal Engineer": not a title held
    expect(head('Staff Platform Engineer')).toBe('Senior Backend Engineer'); // all tie at 1: the most recent role title
    expect(head('Software Engineer II, Payments')).toBe('Software Engineer II');
    expect(head('Data Wrangler')).toBe('Senior Backend Engineer');
    const custom = freezePack({ ...pack, targets: { ...pack.targets, claimableTitles: ['Backend Engineer', 'Software Engineer', 'SDE 3', 'Senior Backend Engineer'] } }) as WritingPack;
    expect(head('SDE 3, Payments', custom)).toBe('SDE 3'); // verbatim, no re-casing
    expect(head('Backend Engineer', custom)).toBe('Senior Backend Engineer'); // Backend Engineer and it tie at 2: the role title wins
    expect(head('Lead Software Engineer', custom)).toBe('Software Engineer');
    const p1 = planCover(planResume(buildEvidence(scoredOf(posting({ title: 'Principal Engineer' })), pack), pack), pack).paragraphs[0]!.text;
    expect(p1).toContain('I am a Senior Backend Engineer with 10+ years');
  });
});

describe('summary template', () => {
  const base = { title: 'Backend Engineer', years: 10, employer: 'Northwind Labs' };
  it('keeps the exact template strings', () => {
    expect(SUMMARY_TEMPLATE).toBe('{title} with {years}+ years building {top1}, {top2}, {top3} and {top4} systems. Currently at {employer}.');
    expect(COVER_P1).toBe('I am applying for the {title} role at {company}. I am a {targetTitle} with {years}+ years of experience. I am based in India and am looking for a fully remote role.');
    expect(COVER_P3_TAIL).toBe('The role asks for {coveredList}; each appears in the work above.');
    expect(COVER_P3_TAIL_ONE).toBe('The role asks for {coveredList}; it appears in the work above.');
    expect(COVER_P4).toBe('I am available from {availableFrom}, with a notice period of {notice}. Thank you for your time.');
  });
  it('drops missing term slots, joining the rest with ", " and " and "', () => {
    expect(renderSummary({ ...base, top1: 'java', top2: 'kafka', top3: 'aws', top4: 'redis' })).toBe('Backend Engineer with 10+ years building java, kafka, aws and redis systems. Currently at Northwind Labs.');
    expect(renderSummary({ ...base, top1: 'java', top2: 'kafka', top3: 'aws' })).toBe('Backend Engineer with 10+ years building java, kafka and aws systems. Currently at Northwind Labs.');
    expect(renderSummary({ ...base, top1: 'java', top2: 'kafka' })).toBe('Backend Engineer with 10+ years building java and kafka systems. Currently at Northwind Labs.');
    expect(renderSummary({ ...base, top1: 'java' })).toBe('Backend Engineer with 10+ years building java systems. Currently at Northwind Labs.');
  });
  it('with no covered term, drops the building clause; with no current role, drops the Currently sentence', () => {
    expect(renderSummary(base)).toBe('Backend Engineer with 10+ years. Currently at Northwind Labs.');
    expect(renderSummary({ title: 'Backend Engineer', years: 10, top1: 'java' })).toBe('Backend Engineer with 10+ years building java systems.');
    expect(joinList([])).toBe('');
    expect(joinList(['a', 'b', 'c'])).toBe('a, b and c');
  });
  it('plans fewer slots when fewer terms are covered', () => {
    const plan = planResume(buildEvidence(scoredOf(posting({ descriptionText: 'Java and Kafka, on Kubernetes.' })), pack), pack);
    expect(plan.summary).toEqual({
      text: 'Senior Backend Engineer with 10+ years building Java, Kafka and Kubernetes systems. Currently at Northwind Labs.',
      slots: { title: 'Senior Backend Engineer', years: 10, top1: 'Java', top2: 'Kafka', top3: 'Kubernetes', employer: 'Northwind Labs' },
    });
    const none = planResume(buildEvidence(scoredOf(posting({ descriptionText: 'Build things.' })), pack), pack);
    expect(none.summary).toEqual({
      text: 'Senior Backend Engineer with 10+ years. Currently at Northwind Labs.',
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
    expect(plan.summary.text).toBe('Senior Backend Engineer with 10+ years building Java, Spring, PostgreSQL and fintech systems.');
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

  it('leaves exactly the two renderer placeholders, whose answers.yaml keys the fixture pack has', () => {
    const resume = planResume(buildEvidence(scoredOf(posting()), pack), pack);
    const text = planCover(resume, pack).paragraphs.map((p) => p.text).join('\n');
    expect(text.match(/\{[A-Za-z]+\}/g)).toEqual([...RENDER_PLACEHOLDERS]);
    const { pack: full } = loadPack(packDir);
    expect(full.answers).toMatchObject({ available_from: '1 November 2026', notice_period: '30 days' });
    expect(Object.keys(pack)).not.toContain('answers'); // the cover-writer never sees them
  });

  it('lists in p3 only the covered terms whose key or display the cited claims literally hold (fix I5)', () => {
    const jd = 'Stack: Java, Spring Boot, Kafka, microservices, PostgreSQL, event-driven design, AWS, Kubernetes, Redis.';
    const resume = planResume(buildEvidence(scoredOf(posting({ title: 'Lead Software Engineer', descriptionText: jd })), pack), pack);
    const p3 = planCover(resume, pack).paragraphs[2]!;
    // The cited facts are f-nw-01, f-nw-02 and f-nw-03: java and spring are in their tech tags, but no claim names them.
    expect(resume.evidence.ranked.slice(0, 3).map((r) => r.factId)).toEqual(['f-nw-01', 'f-nw-02', 'f-nw-03']);
    expect(p3.text).toBe(
      'Migrated a multi-tenant SaaS billing module from a monolith to three microservices on Kubernetes. The role asks for Kafka, microservices, event-driven, Kubernetes and Redis; each appears in the work above.',
    );
  });

  it('uses the singular sentence for one listed term', () => {
    const resume = planResume(buildEvidence(scoredOf(posting({ descriptionText: 'Java only.' })), pack), pack);
    const p3 = planCover(resume, pack).paragraphs[2]!;
    expect(p3.text).toMatch(/The role asks for Java; it appears in the work above\.$/);
  });

  it('degrades without inventing: one ranked fact, no covered-term sentence', () => {
    const solo = freezePack({ ...pack, facts: pack.facts.filter((f) => f.id === 'f-nw-04' || f.kind === 'cert') }) as WritingPack;
    const resume = planResume(buildEvidence(scoredOf(posting(), solo), solo), solo);
    expect(planCover(resume, solo).paragraphs.map((p) => p.text)).toEqual([
      'I am applying for the Senior Backend Engineer (Java) role at Acme Payments. I am a Senior Backend Engineer with 10+ years of experience. I am based in India and am looking for a fully remote role.',
      'Relevant work: Mentored four engineers and ran the weekly design review for the platform group.',
      'I am available from {availableFrom}, with a notice period of {notice}. Thank you for your time.',
    ]);
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
    expect(awsOnly.r.summary.text).toBe('Senior Backend Engineer with 10+ years building Kubernetes systems. Currently at Northwind Labs.');
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
    expect([...sanitisePostingText('x'.repeat(300))]).toHaveLength(120);
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
    for (const bad of ['I hold a PhD in Systems', 'Engineer I will relocate', "I've built systems", 'Contact me', 'My team', 'Hire Me'])
      expect(why(bad), bad).toBe('has a first-person pronoun');
    expect(why('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen')).toBe('has more than 14 words');
    expect(why('Backend Engineer. Apply now')).toBe('has a sentence end followed by more text');
    expect(why('Backend Engineer at https://acme.example')).toBe('has a URL or email address');
    expect(why('Backend Engineer www.acme.example')).toBe('has a URL or email address');
    expect(why('Backend Engineer!')).toMatch(/^has a character outside the allowed set \(U\+0021\)$/);
    expect(why('Acme &lt;script&gt;')).toMatch(/^has a character outside the allowed set/);
    expect(why('Backend {notice} Engineer')).toMatch(/^has a character outside the allowed set/);
    expect(why('jobs@acme.example')).toMatch(/^has a character outside the allowed set|^has a URL/);
    expect(why('   ')).toBe('is empty');
  });
});
