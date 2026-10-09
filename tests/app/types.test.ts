import { describe, expect, it } from 'vitest';
import {
  CoverPlan,
  DiscoveryRequest,
  EligibilityVerdict,
  Evidence,
  hasTitleUrl,
  knownAts,
  notRejected,
  planHasBullets,
  Posting,
  QaReport,
  qaRan,
  RawPosting,
  Rendered,
  ResumePlan,
  Scored,
} from '../../src/app/types.js';

const posting: Posting = {
  jobKey: '0123456789abcdef', source: 'greenhouse', sourceId: '1', company: 'Acme', slug: 'acme', ats: 'greenhouse',
  title: 'Backend Engineer', url: 'https://example.com/jobs/1', locationText: 'Remote - India',
  remote: { structured: 'remote', countries: ['india'] }, employmentType: null, descriptionText: 'Build things.',
  postedAt: '2026-10-01', comp: { min: 1, max: 2, currency: 'INR', period: 'year', basis: 'base' }, yearsRequired: 5,
};
const verdict: EligibilityVerdict = { posting, verdict: 'eligible', reasons: [], notes: [] };
const scored: Scored = {
  posting, verdict: 'eligible', notes: [], score: 7, breakdown: [{ label: 'title', points: 3 }],
  jdTerms: { strong: ['go'], medium: [], gap: [] },
};
const evidence: Evidence = {
  scored, ranked: [{ factId: 'f1', employer: 'Acme', rank: 1, matched: ['go'] }], covered: ['go'], missing: [],
};
const resume: ResumePlan = {
  jobKey: posting.jobKey, headline: 'Engineer', summary: { text: 'Hi {n}', slots: { n: 3, s: 'x' } }, skills: ['Go'],
  roles: [{ employer: 'Acme', title: 'Eng', location: 'Pune', start: '2020-01', end: 'Present', bullets: [{ factId: 'f1', text: 'Did.' }] }],
  certs: [{ factId: 'c1', text: 'Cert' }], covered: ['go'], missing: [], ats: 'greenhouse', firstSeen: '2026-10-09',
};
const cover: CoverPlan = { jobKey: posting.jobKey, resume, paragraphs: [{ text: 'Dear', factIds: ['f1'] }] };
const files = [{ kind: 'resume' as const, format: 'pdf' as const, path: 'o/r.pdf', sha256: 'a'.repeat(64), pages: 1 }];
const rendered: Rendered = { jobKey: posting.jobKey, files, recommended: 'pdf', plan: cover };
const qa: QaReport = { jobKey: posting.jobKey, ok: true, checks: [{ id: 'pages', ok: true, detail: '1' }], files };

const cases: [string, { schema: { safeParse(v: unknown): { success: boolean } } }, unknown][] = [
  ['DiscoveryRequest', DiscoveryRequest, { ats: 'lever', slug: 's', company: 'C', runDate: '2026-10-09' }],
  ['RawPosting', RawPosting, { source: 's', sourceId: '1', company: 'C', slug: 's', raw: { any: ['thing'] } }],
  ['Posting', Posting, posting],
  ['EligibilityVerdict', EligibilityVerdict, verdict],
  ['Scored', Scored, scored],
  ['Evidence', Evidence, evidence],
  ['ResumePlan', ResumePlan, resume],
  ['CoverPlan', CoverPlan, cover],
  ['Rendered', Rendered, rendered],
  ['QaReport', QaReport, qa],
];

describe('message types', () => {
  for (const [name, type, value] of cases) {
    it(`${name} round-trips`, () => {
      expect(type.schema.safeParse(JSON.parse(JSON.stringify(value))).success).toBe(true);
    });
    it(`${name} rejects unknown top-level keys`, () => {
      expect(type.schema.safeParse({ ...(value as object), extra: 1 }).success).toBe(false);
    });
  }

  it('rejects unknown keys in nested objects', () => {
    expect(Posting.schema.safeParse({ ...posting, remote: { ...posting.remote, x: 1 } }).success).toBe(false);
    expect(Posting.schema.safeParse({ ...posting, comp: { ...posting.comp, x: 1 } }).success).toBe(false);
    expect(Scored.schema.safeParse({ ...scored, posting: { ...posting, x: 1 } }).success).toBe(false);
    expect(Scored.schema.safeParse({ ...scored, jdTerms: { ...scored.jdTerms, x: [] } }).success).toBe(false);
    expect(Rendered.schema.safeParse({ ...rendered, files: [{ ...files[0], x: 1 }] }).success).toBe(false);
  });

  it('validates dates and enums', () => {
    expect(DiscoveryRequest.schema.safeParse({ ats: 'lever', slug: 's', company: 'C', runDate: '09/10/2026' }).success).toBe(false);
    expect(DiscoveryRequest.schema.safeParse({ ats: 'workday', slug: 's', company: 'C', runDate: '2026-10-09' }).success).toBe(false);
    expect(Posting.schema.safeParse({ ...posting, postedAt: 'yesterday' }).success).toBe(false);
    expect(Posting.schema.safeParse({ ...posting, postedAt: '2026-10-01T10:00:00Z' }).success).toBe(true);
    expect(Scored.schema.safeParse({ ...scored, verdict: 'rejected' }).success).toBe(false);
  });

  it('constrains jobKey everywhere it appears', () => {
    for (const bad of ['greenhouse:acme:1', '0123456789ABCDEF', '0123456789abcde', '']) {
      expect(Posting.schema.safeParse({ ...posting, jobKey: bad }).success).toBe(false);
      expect(ResumePlan.schema.safeParse({ ...resume, jobKey: bad }).success).toBe(false);
      expect(CoverPlan.schema.safeParse({ ...cover, jobKey: bad }).success).toBe(false);
      expect(Rendered.schema.safeParse({ ...rendered, jobKey: bad }).success).toBe(false);
      expect(QaReport.schema.safeParse({ ...qa, jobKey: bad }).success).toBe(false);
    }
  });

  it('constrains sha256 on rendered files', () => {
    for (const bad of ['ab', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)]) {
      expect(Rendered.schema.safeParse({ ...rendered, files: [{ ...files[0], sha256: bad }] }).success).toBe(false);
      expect(QaReport.schema.safeParse({ ...qa, files: [{ ...files[0], sha256: bad }] }).success).toBe(false);
    }
  });

  it('requires relative rendered paths', () => {
    for (const bad of ['/o/r.pdf', '../r.pdf', 'o/../../r.pdf', '..\\r.pdf', 'C:\\r.pdf', '']) {
      expect(Rendered.schema.safeParse({ ...rendered, files: [{ ...files[0], path: bad }] }).success).toBe(false);
    }
    expect(Rendered.schema.safeParse({ ...rendered, files: [{ ...files[0], path: 'out/a..b/r.pdf' }] }).success).toBe(true);
  });

  it('carries ids', () => {
    expect(Posting.id).toBe('Posting@1');
    expect(QaReport.id).toBe('QaReport@1');
  });
});

describe('predicates', () => {
  it('req.known-ats', () => {
    expect(knownAts.id).toBe('req.known-ats');
    expect(knownAts.test({ ats: 'feed', slug: 's', company: 'C', runDate: '2026-10-09' })).toBe(true);
    expect(knownAts.test({ ats: 'nope' as never, slug: 's', company: 'C', runDate: '2026-10-09' })).toBe(false);
  });
  it('posting.has-title-url', () => {
    expect(hasTitleUrl.test(posting)).toBe(true);
    expect(hasTitleUrl.test({ ...posting, title: '  ' })).toBe(false);
    expect(hasTitleUrl.test({ ...posting, url: '' })).toBe(false);
  });
  it('verdict.not-rejected', () => {
    expect(notRejected.test(verdict)).toBe(true);
    expect(notRejected.test({ ...verdict, verdict: 'review' })).toBe(true);
    expect(notRejected.test({ ...verdict, verdict: 'rejected' })).toBe(false);
  });
  it('plan.has-bullets', () => {
    expect(planHasBullets.test(resume)).toBe(true);
    expect(planHasBullets.test({ ...resume, roles: [{ ...resume.roles[0]!, bullets: [] }] })).toBe(false);
    expect(planHasBullets.test({ ...resume, roles: [] })).toBe(false);
  });
  it('qa.ran', () => {
    expect(qaRan.test(qa)).toBe(true);
    expect(qaRan.test({ ...qa, checks: [] })).toBe(false);
  });
});

describe('dates are real calendar dates', () => {
  const ok = (runDate: string) => DiscoveryRequest.schema.safeParse({ ats: 'careers', slug: 's', company: 'C', runDate }).success;
  it('accepts real dates, leap days included', () => {
    for (const d of ['2026-10-09', '2028-02-29', '2026-12-31', '1970-01-01']) expect(ok(d), d).toBe(true);
  });
  it('rejects impossible dates that only look right', () => {
    for (const d of ['2026-02-30', '2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-10-9', '2026-10-09T00:00']) expect(ok(d), d).toBe(false);
  });
});
