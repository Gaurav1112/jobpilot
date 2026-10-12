import { z } from 'zod';
import { defineType } from '../../kernel/types.js';
import { IsoDate, IsoDateOrDateTime, JobKey } from '../types.js';

export const Platform = z.enum(['freelancer', 'remotive', 'hn-freelancer', 'hn-hiring', 'boards', 'gmail', 'upwork', 'reddit']);
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
          method: z.enum(['stated', 'fixed÷stated-hours', 'derived-from-duration', 'monthly÷hours', 'unknown']),
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
