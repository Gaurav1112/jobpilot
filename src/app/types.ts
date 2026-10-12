import { z } from 'zod';
import { definePredicate } from '../kernel/predicates.js';
import { defineType } from '../kernel/types.js';

const Ats = z.enum(['greenhouse', 'lever', 'ashby', 'feed', 'careers']);
/** A real calendar date: month 1-12, day within that month (leap years included). */
export const isCalendarDate = (s: string): boolean => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return days !== undefined && d >= 1 && d <= days;
};
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isCalendarDate, 'not a real calendar date');
export const IsoDateOrDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/, 'expected ISO date or datetime');
export const JobKey = z.string().regex(/^[0-9a-f]{16}$/, 'expected 16 lowercase hex chars');
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex chars');
const RelativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..'), 'path must be relative with no .. segment');
const Verdict = z.enum(['eligible', 'rejected', 'review']);

export const DiscoveryRequest = defineType(
  'DiscoveryRequest',
  1,
  z
    .object({
      ats: Ats,
      slug: z.string(),
      company: z.string(),
      runDate: IsoDate,
      /**
       * `jobpilot run --refresh` only: the run's ordinal on its date (`daily-<runDate>-<n>`, n >= 2), so the sources
       * fetch again on the same day. Absent by default, so a normal run's step keys are unchanged; sources ignore it.
       */
      attempt: z.number().int().min(2).optional(),
    })
    .strict(),
);
export type DiscoveryRequest = z.infer<typeof DiscoveryRequest.schema>;

export const RawPosting = defineType(
  'RawPosting',
  1,
  z.object({ source: z.string(), sourceId: z.string(), company: z.string(), slug: z.string(), raw: z.unknown() }).strict(),
);
export type RawPosting = z.infer<typeof RawPosting.schema>;

/**
 * One job link found on a career site's listing, handed from `src-careers-list` to `src-careers-job`. There is
 * deliberately no run date: the payload is the step key, so an unchanged link replays instead of being rendered again.
 * - `refresh` is a staggered refresh epoch, `floor((dayNumber(runDate) + bucket(url)) / 7)`: each link's epoch
 *   advances once every 7 days, on a day fixed by its URL, so about a seventh of the links re-render each day and
 *   none is more than 7 days stale.
 * - `titleKey` is a normalised key of the job's title on the listing (a title element inside the anchor, else its
 *   text without digits, dates or badges): a retitled job re-renders the next day, a "Posted N days ago" does not.
 * A link that leaves the listing simply stops being emitted.
 */
export const CareerLink = defineType(
  'CareerLink',
  1,
  z
    .object({
      company: z.string(),
      slug: z.string(),
      listUrl: z.string(),
      url: z.string(),
      linkPattern: z.string(),
      titleKey: z.string(),
      refresh: z.number().int().nonnegative(),
    })
    .strict(),
);
export type CareerLink = z.infer<typeof CareerLink.schema>;

export const Posting = defineType(
  'Posting',
  1,
  z
    .object({
      /** The posting's identity, `jobKey(source, sourceId)`: one job per posting, stable across days. */
      jobKey: JobKey,
      /** `dedupeKey(company, title, location)`: links one job listed on two sources; never an identity. */
      dedupeKey: JobKey,
      source: z.string(),
      sourceId: z.string(),
      company: z.string(),
      slug: z.string(),
      ats: Ats,
      title: z.string(),
      url: z.string(),
      locationText: z.string(),
      remote: z
        .object({
          /** The source's structured arrangement (Lever/Ashby workplaceType, Ashby isRemote, JSON-LD TELECOMMUTE, a remote-only feed); null when it has none. */
          structured: z.enum(['remote', 'hybrid', 'onsite']).nullable(),
          /** Canonical lowercase country or region names (`india`, `united states`, `apac`, `worldwide`, ...), sorted. */
          countries: z.array(z.string()),
          /**
           * The evidence, in order: structured fields first (`workplaceType:remote`, `isRemote:true`,
           * `jobLocationType:TELECOMMUTE`, `feed:remote-only`), then words found in the text (`location:hybrid`,
           * `title:remote`). When they disagree, `structured` follows the structured field and both stay visible here.
           */
          signals: z.array(z.string()),
        })
        .strict(),
      employmentType: z.string().nullable(),
      descriptionText: z.string(),
      // Deliberately lenient (shape only): it is source data, and one source's impossible date must not fail the
      // whole board. The normalizer (Task 6) sets a date that is not a real calendar date to null.
      postedAt: IsoDateOrDateTime.nullable(),
      /**
       * Disclosed pay per year. A bound the source does not state is null ("up to X" has no min, "from X" no max);
       * at least one is set, and min <= max when both are. `basis` is `base` only for pay stated as base, fixed or
       * CTC; OTE, total comp, bonus or equity wording makes it `unknown`.
       */
      comp: z
        .object({
          min: z.number().nullable(),
          max: z.number().nullable(),
          currency: z.enum(['INR', 'USD', 'EUR', 'GBP']),
          period: z.literal('year'),
          basis: z.enum(['base', 'unknown']),
        })
        .strict()
        .refine((c) => c.min !== null || c.max !== null, 'comp needs at least one bound')
        .refine((c) => c.min === null || c.max === null || c.min <= c.max, 'comp min must not exceed max')
        .nullable(),
      /**
       * The highest stated years-of-experience requirement (the upper bound of a range: "3-5 years" is 5); null when
       * none is stated. Above 14 years the sentence must say experience or ask for it: a bullet-only 15+ requirement
       * ("- 15+ years designing systems") is null, the accepted trade-off against company-highlight bullets.
       */
      yearsRequired: z.number().nullable(),
    })
    .strict(),
);
export type Posting = z.infer<typeof Posting.schema>;

export const EligibilityVerdict = defineType(
  'EligibilityVerdict',
  1,
  z.object({ posting: Posting.schema, verdict: Verdict, reasons: z.array(z.string()), notes: z.array(z.string()) }).strict(),
);
export type EligibilityVerdict = z.infer<typeof EligibilityVerdict.schema>;

export const Scored = defineType(
  'Scored',
  1,
  z
    .object({
      posting: Posting.schema,
      verdict: z.enum(['eligible', 'review']),
      notes: z.array(z.string()),
      score: z.number(),
      breakdown: z.array(z.object({ label: z.string(), points: z.number() }).strict()),
      jdTerms: z
        .object({ strong: z.array(z.string()), medium: z.array(z.string()), gap: z.array(z.string()) })
        .strict(),
    })
    .strict(),
);
export type Scored = z.infer<typeof Scored.schema>;

export const Evidence = defineType(
  'Evidence',
  1,
  z
    .object({
      scored: Scored.schema,
      ranked: z
        .array(
          z.object({ factId: z.string(), employer: z.string(), rank: z.number(), matched: z.array(z.string()) }).strict(),
        ),
      covered: z.array(z.string()),
      missing: z.array(z.string()),
    })
    .strict(),
);
export type Evidence = z.infer<typeof Evidence.schema>;

const FactText = z.object({ factId: z.string(), text: z.string() }).strict();

/**
 * The resume plan of one job. It carries its parent `evidence` (Task 9), as the later types carry theirs: the
 * cover-writer needs the posting's title and company, and G-GROUND re-derives every slot from the posting and the
 * pack rather than trusting the plan's own values.
 */
export const ResumePlan = defineType(
  'ResumePlan',
  1,
  z
    .object({
      jobKey: JobKey,
      evidence: Evidence.schema,
      headline: z.string(),
      summary: z
        .object({ text: z.string(), slots: z.record(z.string(), z.union([z.string(), z.number()])) })
        .strict(),
      skills: z.array(z.string()),
      roles: z.array(
        z
          .object({
            employer: z.string(),
            title: z.string(),
            location: z.string(),
            start: z.string(),
            end: z.string(),
            bullets: z.array(FactText),
          })
          .strict(),
      ),
      certs: z.array(FactText),
      /** Citeable education facts, verbatim, newest first (fix round 1). */
      education: z.array(FactText),
      /** Citeable experience or project facts dated inside no role at their employer: never placed as a bullet. */
      unplaced: z.array(z.string()),
      covered: z.array(z.string()),
      missing: z.array(z.string()),
      ats: Ats,
      firstSeen: IsoDate,
    })
    .strict(),
);
export type ResumePlan = z.infer<typeof ResumePlan.schema>;

export const CoverPlan = defineType(
  'CoverPlan',
  1,
  z
    .object({
      jobKey: JobKey,
      resume: ResumePlan.schema,
      paragraphs: z.array(z.object({ text: z.string(), factIds: z.array(z.string()) }).strict()),
    })
    .strict(),
);
export type CoverPlan = z.infer<typeof CoverPlan.schema>;

/** One rendered file: exported so the freelance renderer (`GigRendered@1`) extends it rather than copying it. */
export const RenderedFile = z
  .object({
    kind: z.enum(['resume', 'cover']),
    format: z.enum(['pdf', 'docx', 'html']),
    path: RelativePath,
    sha256: Sha256,
    pages: z.number().nullable(),
  })
  .strict();

export const Rendered = defineType(
  'Rendered',
  1,
  z
    .object({
      jobKey: JobKey,
      files: z.array(RenderedFile),
      recommended: z.enum(['pdf', 'docx']),
      /** The cover plan as rendered: identical to the input except that p4's placeholders are filled (G-FILL). */
      plan: CoverPlan.schema,
      /**
       * The exact text of each document (`render/model.ts` `modelText`): contact details included, one line per
       * block, bullets as "• claim". G-FILL re-renders it from the plan and the full pack; the qa-gate compares the
       * DOCX and PDF text layers with it.
       */
      text: z.object({ resume: z.string(), cover: z.string() }).strict(),
    })
    .strict(),
);
export type Rendered = z.infer<typeof Rendered.schema>;

export const QaReport = defineType(
  'QaReport',
  1,
  z
    .object({
      jobKey: JobKey,
      ok: z.boolean(),
      checks: z.array(z.object({ id: z.string(), ok: z.boolean(), detail: z.string() }).strict()),
      files: z.array(RenderedFile),
    })
    .strict(),
);
export type QaReport = z.infer<typeof QaReport.schema>;

// `score.at-least-floor` is deliberately not a predicate: it needs the pack's
// score floor, so the scoring agent checks it directly (see Task 7).
export const knownAts = definePredicate<DiscoveryRequest>(
  'req.known-ats',
  'ats is one of greenhouse, lever, ashby, feed, careers',
  (r) => Ats.safeParse(r.ats).success,
);
export const hasTitleUrl = definePredicate<Posting>(
  'posting.has-title-url',
  'posting has a non-empty title and url',
  (p) => p.title.trim().length > 0 && p.url.trim().length > 0,
);
export const notRejected = definePredicate<EligibilityVerdict>(
  'verdict.not-rejected',
  'verdict is not rejected',
  (v) => v.verdict !== 'rejected',
);
export const planHasBullets = definePredicate<ResumePlan>(
  'plan.has-bullets',
  'at least one role carries a bullet',
  (p) => p.roles.some((r) => r.bullets.length > 0),
);
export const qaRan = definePredicate<QaReport>('qa.ran', 'at least one QA check ran', (q) => q.checks.length > 0);
