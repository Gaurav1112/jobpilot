import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coverWriter } from '../../src/app/agents/writing/cover-writer.js';
import { evidenceMatcher } from '../../src/app/agents/writing/evidence-matcher.js';
import { buildEvidence, firstSeenOf, planCover, planResume, yearsOf, type WritingPack } from '../../src/app/agents/writing/grounded.js';
import { resumePlanner } from '../../src/app/agents/writing/resume-planner.js';
import { COVER_P1, COVER_P3_TAIL, COVER_P4, joinList, RENDER_PLACEHOLDERS, renderSummary, SUMMARY_TEMPLATE } from '../../src/app/agents/writing/templates.js';
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
  it('without postedAt, is the latest month the citeable non-cert facts and the roles name (never the clock)', () => {
    // Role months reach 2022-03; the citeable f-nw-04 starts 2023-01. The derived-unverified f-nw-05 (to 2024-06)
    // and the cert validity periods (to 2025-09) are not evidence of a date, so they are ignored.
    expect(firstSeenOf(posting({ postedAt: null }), pack)).toBe('2023-01-01');
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
  headline: 'Backend Engineer',
  summary: {
    text: 'Backend Engineer with 10+ years building java, spring, kafka and postgres systems. Currently at Northwind Labs.',
    slots: { title: 'Backend Engineer', years: 10, top1: 'java', top2: 'spring', top3: 'kafka', top4: 'postgres', employer: 'Northwind Labs' },
  },
  skills: ['java', 'spring', 'kafka', 'postgres', 'event-driven', 'aws', 'kubernetes', 'fintech', 'docker', 'microservices', 'redis', 'multi-tenant', 'saas', 'rabbitmq', 'python'],
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
  covered: ['java', 'spring', 'kafka', 'postgres', 'event-driven', 'aws', 'kubernetes', 'fintech', 'docker'],
  missing: ['elasticsearch', 'grpc', 'scala'],
  ats: 'greenhouse',
  firstSeen: '2026-10-01',
};

const EXPECTED_PARAGRAPHS = [
  {
    text: 'I am applying for the Senior Backend Engineer (Java) role at Acme Payments. I am a Backend Engineer with 10+ years of backend experience, and I work fully remote from India.',
    factIds: [],
  },
  {
    text: 'Relevant work: Built the payments reconciliation service in Java and Postgres, processing 2M transactions nightly. Led the design of an event-driven order pipeline on Kafka handling 40M events a day.',
    factIds: ['f-ct-01', 'f-nw-01'],
  },
  {
    text: 'Built REST services in Java with Spring and MySQL for the store-locator product. The role asks for java, spring, kafka, postgres, event-driven and fintech; each appears in the work above.',
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
    expect(plan.skills).not.toContain('elasticsearch'); // backed only by f-fb-03 (user-cannot-confirm)
    expect(plan.skills).not.toContain('scala'); // a gap skill, and backed only by the rejected f-ct-04
    expect(plan.missing).toEqual(['elasticsearch', 'scala']);
  });

  it('honours a fact override: a verified fact the user rejects is no longer cited', () => {
    const p2 = publicPack({ 'f-nw-01': 'rejected' });
    const plan = planResume(buildEvidence(scoredOf(posting(), p2), p2), p2);
    expect(plan.roles[0]?.bullets.map((b) => b.factId)).toEqual(['f-nw-02', 'f-nw-03', 'f-nw-04']);
    expect(plan.covered).not.toContain('kafka'); // f-nw-01 was the only fact with kafka
    expect(plan.skills).not.toContain('kafka');
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

  it('picks the headline by word overlap with the posting title; a tie goes to the first entry', () => {
    const head = (title: string) => planResume(buildEvidence(scoredOf(posting({ title })), pack), pack).headline;
    expect(head('Staff Platform Engineer')).toBe('Platform Engineer'); // platform engineer and staff engineer tie at 2
    expect(head('Principal Engineer')).toBe('Principal Engineer');
    expect(head('Senior Software Engineer, Backend')).toBe('Backend Engineer'); // backend and software engineer tie
    expect(head('Data Wrangler')).toBe('Backend Engineer'); // no overlap: the first entry
  });
});

describe('summary template', () => {
  const base = { title: 'Backend Engineer', years: 10, employer: 'Northwind Labs' };
  it('keeps the exact template string', () => {
    expect(SUMMARY_TEMPLATE).toBe('{title} with {years}+ years building {top1}, {top2}, {top3} and {top4} systems. Currently at {employer}.');
    expect(COVER_P1).toBe('I am applying for the {title} role at {company}. I am a {targetTitle} with {years}+ years of backend experience, and I work fully remote from India.');
    expect(COVER_P3_TAIL).toBe('The role asks for {coveredList}; each appears in the work above.');
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
      text: 'Backend Engineer with 10+ years building java, kafka and kubernetes systems. Currently at Northwind Labs.',
      slots: { title: 'Backend Engineer', years: 10, top1: 'java', top2: 'kafka', top3: 'kubernetes', employer: 'Northwind Labs' },
    });
    const none = planResume(buildEvidence(scoredOf(posting({ descriptionText: 'Build things.' })), pack), pack);
    expect(none.summary).toEqual({
      text: 'Backend Engineer with 10+ years. Currently at Northwind Labs.',
      slots: { title: 'Backend Engineer', years: 10, employer: 'Northwind Labs' },
    });
    expect(none.covered).toEqual([]);
    // every citeable tech key is still listed, none of them from the JD
    expect(none.skills).toEqual(['java', 'spring', 'kafka', 'microservices', 'postgres', 'event-driven', 'aws', 'kubernetes', 'redis', 'multi-tenant', 'saas', 'fintech', 'rabbitmq', 'docker', 'python']);
  });
  it('does not claim a current employer when no role is ongoing', () => {
    // 23 + 45 + 52 months (2022-03..2026-06, the end month included) = 120 months.
    const ended = freezePack({ ...pack, roles: pack.roles.map((r) => (r.end === 'present' ? { ...r, end: '2026-06' } : r)) }) as WritingPack;
    const plan = planResume(buildEvidence(scoredOf(posting(), ended), ended), ended);
    expect(plan.summary.text).toBe('Backend Engineer with 10+ years building java, spring, kafka and postgres systems.');
    expect(plan.summary.slots).not.toHaveProperty('employer');
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

  it('lists in p3 only the covered terms the cited claims themselves name', () => {
    const jd = 'Stack: Java, Spring Boot, Kafka, microservices, PostgreSQL, event-driven design, AWS, Kubernetes, Redis.';
    const resume = planResume(buildEvidence(scoredOf(posting({ title: 'Lead Software Engineer', descriptionText: jd })), pack), pack);
    const p3 = planCover(resume, pack).paragraphs[2]!;
    // The cited facts are f-nw-01, f-nw-02 and f-nw-03: java and spring are in their tech tags, but no claim names them.
    expect(resume.evidence.ranked.slice(0, 3).map((r) => r.factId)).toEqual(['f-nw-01', 'f-nw-02', 'f-nw-03']);
    expect(p3.text).toBe(
      'Migrated a multi-tenant SaaS billing module from a monolith to three microservices on Kubernetes. The role asks for kafka, microservices, event-driven, kubernetes and redis; each appears in the work above.',
    );
  });

  it('degrades without inventing: one ranked fact, no covered-term sentence', () => {
    const solo = freezePack({ ...pack, facts: pack.facts.filter((f) => f.id === 'f-nw-04' || f.kind === 'cert') }) as WritingPack;
    const resume = planResume(buildEvidence(scoredOf(posting(), solo), solo), solo);
    expect(planCover(resume, solo).paragraphs.map((p) => p.text)).toEqual([
      'I am applying for the Senior Backend Engineer (Java) role at Acme Payments. I am a Backend Engineer with 10+ years of backend experience, and I work fully remote from India.',
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
