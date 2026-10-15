import { z } from 'zod';
import { definePredicate } from '../../kernel/predicates.js';
import { defineType } from '../../kernel/types.js';
import { CoverPlan, IsoDate, IsoDateOrDateTime, JobKey, RenderedFile, ResumePlan } from '../types.js';

export const Platform = z.enum(['freelancer', 'remotive', 'hn-freelancer', 'hn-hiring', 'boards', 'gmail', 'upwork', 'reddit', 'himalayas']);
export type Platform = z.infer<typeof Platform>;

const GigCurrency = z.enum(['USD', 'INR', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD', 'NZD', 'HKD']);

export const GigRequest = defineType(
  'GigRequest',
  1,
  z
    .object({
      platform: Platform,
      query: z.string(),
      runDate: IsoDate,
      half: z.enum(['am', 'pm']),
      /** Only for platform `boards`: one stored daily posting per seed. */
      item: z.unknown().optional(),
    })
    .strict(),
);
export type GigRequest = z.infer<typeof GigRequest.schema>;

export const RawGig = defineType('RawGig', 1, z.object({ platform: Platform, sourceId: z.string(), raw: z.unknown() }).strict());
export type RawGig = z.infer<typeof RawGig.schema>;

/** Every value a source does not state stays null / `unknown`; nothing is estimated here. */
export const Gig = defineType(
  'Gig',
  1,
  z
    .object({
      gigKey: JobKey,
      dedupeKey: JobKey,
      platform: Platform,
      sourceId: z.string(),
      url: z.string(),
      title: z.string(),
      description: z.string(),
      client: z
        .object({
          name: z.string().nullable(),
          country: z.string().nullable(),
          paymentVerified: z.boolean().nullable(),
          hireRate: z.number().nullable(),
          spendUsd: z.number().nullable(),
          reviews: z.number().nullable(),
          since: z.string().nullable(),
        })
        .strict(),
      kind: z.enum(['contract', 'gig', 'bounty', 'network-alert']),
      budget: z
        .object({
          type: z.enum(['hourly', 'fixed', 'monthly', 'unknown']),
          min: z.number().nullable(),
          max: z.number().nullable(),
          currency: GigCurrency.nullable(),
          /** USD per unit of `currency` as the platform states it (Freelancer `currency.exchange_rate`, copied); null elsewhere. Used only for a currency the pack fx table lacks. */
          usdPerUnit: z.number().nullable(),
          /**
           * Where the pay was read (freelance-boost): `platform` a structured pay field of the source (Himalayas'
           * `minSalary`/`maxSalary`/`salaryPeriod`), `description` the posting's own text (boards, Himalayas without a
           * pay field). Absent on the older sources, whose mapping is fixed per platform (Freelancer: its budget
           * fields; Remotive, HN, Gmail: the text).
           */
          from: z.enum(['platform', 'description']).optional(),
          /** `ceiling`: the text states only an upper bound ("up to $130/hr"): `min` is null, `max` the ceiling. */
          bound: z.literal('ceiling').optional(),
        })
        .strict(),
      hoursPerWeek: z.object({ min: z.number().nullable(), max: z.number().nullable(), source: z.literal('text').nullable() }).strict(),
      duration: z.object({ weeks: z.number().nullable(), text: z.string().nullable() }).strict(),
      timezone: z.object({ required: z.string().nullable(), overlapText: z.string().nullable() }).strict(),
      location: z.object({ countries: z.array(z.string()), worldwide: z.boolean(), text: z.string().nullable() }).strict(),
      skills: z.array(z.string()),
      // Lenient like Posting.postedAt: source data, shape only.
      postedAt: IsoDateOrDateTime.nullable(),
      bids: z.number().nullable(),
    })
    .strict(),
);
export type Gig = z.infer<typeof Gig.schema>;

export const RatedGig = defineType(
  'RatedGig',
  1,
  z
    .object({
      gig: Gig.schema,
      rate: z
        .object({
          minUsdH: z.number().nullable(),
          maxUsdH: z.number().nullable(),
          method: z.enum(['stated', 'stated-ceiling', 'fixed÷stated-hours', 'derived-from-duration', 'monthly÷hours', 'unknown']),
          fxDate: IsoDate.nullable(),
          /** Which table converted the money: the pack's, the platform's own rate, or none (USD, or nothing converted). */
          fxSource: z.enum(['pack', 'platform']).nullable(),
          budgetUsd: z.number().nullable(),
        })
        .strict(),
    })
    .strict(),
);
export type RatedGig = z.infer<typeof RatedGig.schema>;

export const GigVerdict = defineType(
  'GigVerdict',
  1,
  z.object({ rated: RatedGig.schema, verdict: z.enum(['eligible', 'rejected', 'review']), reasons: z.array(z.string()), notes: z.array(z.string()) }).strict(),
);
export type GigVerdict = z.infer<typeof GigVerdict.schema>;

export const RiskedGig = defineType(
  'RiskedGig',
  1,
  z.object({ verdict: GigVerdict.schema, flags: z.array(z.object({ id: z.string(), detail: z.string() }).strict()) }).strict(),
);
export type RiskedGig = z.infer<typeof RiskedGig.schema>;

export const ScoredGig = defineType(
  'ScoredGig',
  1,
  z.object({ risked: RiskedGig.schema, fit: z.number(), breakdown: z.record(z.string(), z.number()), list: z.enum(['contracts', 'gigs', 'review']) }).strict(),
);
export type ScoredGig = z.infer<typeof ScoredGig.schema>;

const FactLine = z.object({ text: z.string(), factIds: z.array(z.string()) }).strict();

/**
 * The screening documents of one gig, planned (spec §7, Task 8). `proposal` is set for kind `gig`, `pitch` for kind
 * `contract`; the other is null. `resume` is the contract CV: `planResume` of the Evidence of the gig's synthetic
 * posting. `covered` and `missing` are the resume plan's lexicon keys. The availability text keeps the `{cadence}`
 * placeholder, which only the gig renderer fills (from `answers.yaml`, P1). Rules: `writing/proposal-planner.ts`.
 */
export const GigDocsPlan = defineType(
  'GigDocsPlan',
  1,
  z
    .object({
      gigKey: JobKey,
      scored: ScoredGig.schema,
      platform: Platform,
      proposal: z
        .object({
          /**
           * `quote` is the client's own words, a substring of the description; `title` the client's gig title (or a
           * prefix of it), a substring of the title. At most one is set; both null for a term or plain hook.
           */
          hook: z.object({ text: z.string(), quote: z.string().nullable(), title: z.string().nullable() }).strict(),
          /** The line before the evidence list (empty when there is no evidence line). */
          evidenceIntro: z.string(),
          evidence: z.array(FactLine),
          planIntro: z.string(),
          plan: z.array(z.string()),
          availability: z.string(),
          question: z.string(),
        })
        .strict()
        .nullable(),
      pitch: z.object({ lines: z.array(FactLine) }).strict().nullable(),
      /**
       * freelance-v2: the daily cover letter of a contract role from an employer job board (`writing/gig-cover.ts`),
       * its resume plan the gig's posting named for the company; its last paragraph keeps `{city}` for the gig
       * renderer. Absent for every other gig (and when the letter cannot be planned).
       */
      cover: CoverPlan.schema.optional(),
      resume: ResumePlan.schema,
      covered: z.array(z.string()),
      missing: z.array(z.string()),
    })
    .strict(),
);
export type GigDocsPlan = z.infer<typeof GigDocsPlan.schema>;

/** A gig file: the paste-ready text (`proposal.txt` or `pitch.txt`) or the contract CV (`resume.pdf`, `resume.docx`). */
export const GigFile = RenderedFile.extend({ kind: z.enum(['proposal', 'pitch', 'resume']), format: z.enum(['txt', 'pdf', 'docx']) }).strict();
export type GigFile = z.infer<typeof GigFile>;

/**
 * The gig renderer's output. `plan` is the input plan unchanged (gig-qa re-derives it); `text` is each document's exact
 * text: the proposal or pitch with `{cadence}` filled (the `.txt` file is this text plus one LF), and the resume's
 * document text (`render/model.ts` `modelText`, contact block included).
 */
export const GigRendered = defineType(
  'GigRendered',
  1,
  z
    .object({
      gigKey: JobKey,
      files: z.array(GigFile),
      plan: GigDocsPlan.schema,
      text: z.object({ proposal: z.string().nullable(), pitch: z.string().nullable(), resume: z.string() }).strict(),
    })
    .strict(),
);
export type GigRendered = z.infer<typeof GigRendered.schema>;

export const GigQaReport = defineType(
  'GigQaReport',
  1,
  z
    .object({
      gigKey: JobKey,
      ok: z.boolean(),
      checks: z.array(z.object({ id: z.string(), ok: z.boolean(), detail: z.string() }).strict()),
      files: z.array(GigFile),
    })
    .strict(),
);
export type GigQaReport = z.infer<typeof GigQaReport.schema>;

export const gigQaRan = definePredicate<GigQaReport>('gig-qa.ran', 'at least one gig QA check ran', (q) => q.checks.length > 0);
