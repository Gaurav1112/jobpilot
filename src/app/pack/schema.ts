import { z } from 'zod';
import { compileRoleDeny } from './regex.js';

const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM');
const Currency = z.enum(['INR', 'USD', 'EUR', 'GBP']);

export const FactStatus = z.enum(['verified', 'user-stated', 'derived-unverified', 'user-cannot-confirm', 'rejected']);
export const FactSchema = z.strictObject({
  id: z.string().min(1),
  claim: z.string().min(1),
  tech: z.array(z.string()),
  employer: z.string().min(1),
  role: z.string().min(1).optional(),
  period: z.string().regex(/^\d{4}-\d{2}\.\.(\d{4}-\d{2}|present)$/, 'expected YYYY-MM..YYYY-MM or YYYY-MM..present'),
  kind: z.enum(['experience', 'cert', 'education', 'project']),
  status: FactStatus,
});
export const FactsFile = z.strictObject({ facts: z.array(FactSchema) });

export const RoleSchema = z.strictObject({
  employer: z.string().min(1),
  title: z.string().min(1),
  location: z.string(),
  start: YearMonth,
  end: z.union([YearMonth, z.literal('present')]),
});
export const RolesFile = z.strictObject({ roles: z.array(RoleSchema) });

export const LexiconGroupSchema = z.strictObject({ key: z.string().min(1), synonyms: z.array(z.string()) });
export const LexiconSchema = z.strictObject({
  strong: z.array(LexiconGroupSchema),
  medium: z.array(LexiconGroupSchema),
  gap: z.array(LexiconGroupSchema),
});

export const TargetsSchema = z.strictObject({
  titles: z.array(z.string()),
  seniority: z.array(z.strictObject({ words: z.array(z.string()), points: z.number() })),
  titleBonusWords: z.array(z.string()),
  titleBonusPoints: z.number(),
  minFit: z.number(),
  maxYearsRequired: z.number(),
  yearsPenalty: z.number(),
});

const RegexSource = z.string().superRefine((s, ctx) => {
  try {
    compileRoleDeny(s);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : 'not a valid regular expression' });
  }
});
export const FiltersSchema = z.strictObject({
  roleDeny: z.array(RegexSource),
  companyDeny: z.array(z.string()),
  employmentDeny: z.array(z.string()),
});

export const NamingSchema = z.strictObject({
  employerDisplay: z.record(z.string(), z.string()),
  forbiddenTerms: z.array(z.string().trim().min(1)),
});

export const OffersSchema = z.strictObject({
  floor: z
    .strictObject({
      amount: z.number().positive(),
      currency: Currency,
      period: z.literal('year'),
      basis: z.literal('base'),
    })
    .nullable(),
});

export const FxSchema = z.strictObject({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  toINR: z.strictObject({
    USD: z.number().positive(),
    EUR: z.number().positive(),
    GBP: z.number().positive(),
    INR: z.number().positive(),
  }),
});

export const AnswersSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export const WatchEntrySchema = z.strictObject({
  company: z.string().min(1),
  ats: z.enum(['greenhouse', 'lever', 'ashby']),
  slug: z.string().min(1),
  hiresInIndia: z.boolean(),
  allRemote: z.boolean(),
});
export const WatchlistFile = z.strictObject({ watchlist: z.array(WatchEntrySchema) });

export const FeedsSchema = z.strictObject({ enabled: z.array(z.string()) });

export const ContactSchema = z.strictObject({
  name: z.string().min(1),
  email: z.string().min(1),
  phone: z.string(),
  city: z.string(),
  links: z.array(z.string()),
});

export const EligibilitySchema = z.strictObject({
  residence: z.literal('IN'),
  acceptRemoteScopes: z.array(z.string()),
  onsiteCities: z.array(z.string()),
  employmentTypes: z.tuple([z.literal('full-time')]),
});

/** Raw user policy overrides; validated and tightened by the kernel's `mergePolicy`, not here. */
export const PolicyUserSchema = z.record(z.string(), z.json());

export type Fact = z.infer<typeof FactSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type LexiconGroup = z.infer<typeof LexiconGroupSchema>;
export type Lexicon = z.infer<typeof LexiconSchema>;
export type Targets = z.infer<typeof TargetsSchema>;
export type Filters = z.infer<typeof FiltersSchema>;
export type Naming = z.infer<typeof NamingSchema>;
export type Offers = z.infer<typeof OffersSchema>;
export type Fx = z.infer<typeof FxSchema>;
export type Answers = z.infer<typeof AnswersSchema>;
export type WatchEntry = z.infer<typeof WatchEntrySchema>;
export type Feeds = z.infer<typeof FeedsSchema>;
export type Contact = z.infer<typeof ContactSchema>;
export type Eligibility = z.infer<typeof EligibilitySchema>;

export interface Pack {
  contact: Contact;
  facts: Fact[];
  roles: Role[];
  eligibility: Eligibility;
  lexicon: Lexicon;
  targets: Targets;
  filters: Filters;
  naming: Naming;
  offers: Offers;
  fx: Fx;
  answers: Answers;
  watchlist: WatchEntry[];
  feeds: Feeds;
  policyUser: Record<string, unknown>;
}

/** What agents may read: no P1 data (contact, answers). */
export type PublicPack = Omit<Pack, 'contact' | 'answers'>;
