import { z } from 'zod';
import { defineType } from '../../kernel/types.js';
import { IsoDate } from '../types.js';

/** The career-site platforms the coverage pipeline can tell apart (spec §3). */
export const Platform = z.enum([
  'workday', 'eightfold', 'oracle', 'icims', 'successfactors', 'smartrecruiters', 'workable', 'recruitee', 'teamtailor', 'personio',
  'bamboohr', 'breezy', 'pinpoint', 'rippling', 'gem', 'greenhouse', 'lever', 'ashby', 'jsonld-sitemap',
]);
export type Platform = z.infer<typeof Platform>;

/** Where a candidate company came from; `pick` (the user's own `companies.yaml`) has the highest priority. */
export const CandidateSource = z.enum(['pick', 'remoteintech', 'yc', 'jobs']);
export type CandidateSource = z.infer<typeof CandidateSource>;

/**
 * One seed request per source. `items` is how the app layer hands in what only it can read: `pack.companies` for
 * `picks`, the `seedItemsFromJobs` pairs for `jobs`. The `remoteintech` and `yc` sources fetch their own data.
 */
export const CoverageRequest = defineType(
  'CoverageRequest',
  1,
  z
    .object({
      runDate: IsoDate,
      source: z.enum(['picks', 'remoteintech', 'yc', 'jobs']),
      items: z.unknown().optional(),
    })
    .strict(),
);
export type CoverageRequest = z.infer<typeof CoverageRequest.schema>;

export const CompanyCandidate = defineType(
  'CompanyCandidate',
  1,
  z
    .object({
      /** The registrable domain, lowercase. */
      companyKey: z.string().min(1),
      name: z.string().min(1),
      website: z.string(),
      careersUrl: z.string().nullable(),
      source: CandidateSource,
      runDate: IsoDate,
    })
    .strict(),
);
export type CompanyCandidate = z.infer<typeof CompanyCandidate.schema>;

export const CareersSite = defineType(
  'CareersSite',
  1,
  z
    .object({
      candidate: CompanyCandidate.schema,
      careersUrl: z.string().nullable(),
      method: z.enum(['listed', 'homepage-link', 'path', 'subdomain', 'sitemap', 'none']),
      evidence: z.string().nullable(),
      /** One short reason per probe that missed (and, for `none`, why nothing was found); absent on sites recorded before the locator. */
      reasons: z.array(z.string()).optional(),
    })
    .strict(),
);
export type CareersSite = z.infer<typeof CareersSite.schema>;

export const PlatformGuess = defineType(
  'PlatformGuess',
  1,
  z
    .object({
      site: CareersSite.schema,
      platform: Platform.nullable(),
      /** The tenant, site or board id. */
      slug: z.string().nullable(),
      boardUrl: z.string().nullable(),
      /**
       * The signal that decided the platform, `<platform>:<where>` (e.g. `workday:inline`; `greenhouse:listed` for the
       * board a listed careersUrl names as written, its redirect off the platform not followed); null when no platform was decided.
       */
      signature: z.string().nullable(),
      /** The front-end that was routed through to the back-end ATS: `phenom`, or `jsonld` (a company page with JobPosting JSON-LD). */
      routedFrom: z.string().nullable(),
      /** Why: the verdict first (`detected: …`, or the reason for a null platform), then the signals seen, in document order. */
      evidence: z.array(z.string()),
    })
    .strict(),
);
export type PlatformGuess = z.infer<typeof PlatformGuess.schema>;

export const CompanyVerdict = defineType(
  'CompanyVerdict',
  1,
  z
    .object({
      guess: PlatformGuess.schema,
      status: z.enum(['verified', 'proposed', 'failed']),
      reasons: z.array(z.string()),
      boardName: z.string().nullable(),
      jobsSeen: z.number().int().nonnegative().nullable(),
    })
    .strict(),
);
export type CompanyVerdict = z.infer<typeof CompanyVerdict.schema>;

/** The name-match question: `domainLabel` is the registrable domain's first label (e.g. `purestorage`). */
export const NamePair = defineType(
  'NamePair',
  1,
  z.object({ a: z.string(), b: z.string(), domainLabel: z.string().nullable() }).strict(),
);
export type NamePair = z.infer<typeof NamePair.schema>;

export const NameMatch = defineType('NameMatch', 1, z.object({ same: z.boolean() }).strict());
export type NameMatch = z.infer<typeof NameMatch.schema>;
