import { z } from 'zod';
import { hostDenied, PRODUCT_POLICY_V1 } from '../../kernel/policy.js';
import { isCalendarDate } from '../types.js';
import { compileSafePattern } from './regex.js';

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

/** `display` is how documents show the group ("PostgreSQL" for key postgres); it defaults to the key. */
export const LexiconGroupSchema = z.strictObject({ key: z.string().min(1), synonyms: z.array(z.string()), display: z.string().trim().min(1).optional() });
export const LexiconSchema = z.strictObject({
  strong: z.array(LexiconGroupSchema),
  medium: z.array(LexiconGroupSchema),
  gap: z.array(LexiconGroupSchema),
});

export const TargetsSchema = z.strictObject({
  /** Titles the search aims for: scoring and search only, never written into a document as the candidate's title. */
  titles: z.array(z.string()),
  /**
   * Titles the candidate can truthfully claim, used verbatim as the resume headline and in the cover letter. Defaults
   * to the distinct roles.yaml titles, newest role first.
   */
  claimableTitles: z.array(z.string().trim().min(1)).optional(),
  seniority: z.array(z.strictObject({ words: z.array(z.string()), points: z.number() })),
  titleBonusWords: z.array(z.string()),
  titleBonusPoints: z.number(),
  minFit: z.number(),
  maxYearsRequired: z.number(),
  yearsPenalty: z.number(),
});

const RegexSource = z.string().superRefine((s, ctx) => {
  try {
    compileSafePattern(s);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : 'not a valid regular expression' });
  }
});
/**
 * `asOf` (YYYY-MM) is the month years of experience and fact recency are measured to. The daily run injects the
 * current IST month from its clock (loadPack's `asOf` override); the file pins one (the fixture does).
 */
export const ExperienceSchema = z.strictObject({ asOf: YearMonth });

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
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').refine(isCalendarDate, 'not a real calendar date'),
  toINR: z.strictObject({
    USD: z.number().positive(),
    EUR: z.number().positive(),
    GBP: z.number().positive(),
    INR: z.number().positive(),
  }),
});

export const AnswersSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

/** An https URL with no explicit port and no credentials: the only kind the broker will render. */
const ListUrl = z.string().superRefine((s, ctx) => {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'listUrl is not a valid URL' });
    return;
  }
  if (u.protocol !== 'https:') ctx.addIssue({ code: 'custom', message: 'listUrl must be https' });
  if (u.port !== '') ctx.addIssue({ code: 'custom', message: 'listUrl may not name a port' });
  if (u.username !== '' || u.password !== '') ctx.addIssue({ code: 'custom', message: 'listUrl may not carry credentials' });
  if (/^[\d.]+$/.test(u.hostname) || u.hostname.startsWith('[')) ctx.addIssue({ code: 'custom', message: 'listUrl must name a host, not an IP address' });
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host.includes('.') || /(^|\.)(localhost|local|internal)$/.test(host)) {
    ctx.addIssue({ code: 'custom', message: `listUrl host ${host} is local or internal; it must be a public host name` });
  }
  if (hostDenied(PRODUCT_POLICY_V1, u.hostname)) ctx.addIssue({ code: 'custom', message: `listUrl host ${u.hostname} is a job board jobpilot never contacts` });
});

/**
 * One employer to watch. API boards (`greenhouse`, `lever`, `ashby`) are found by `slug`. A `careers` entry is a
 * career site without a public API, rendered by `src-careers`: `slug` is a kebab id, `listUrl` the https page that
 * lists every job, and `linkPattern` a required regex (safety-checked, flags 'iu') tested against each same-host
 * link's path plus query to pick the job links. It is required because no default rule tells a job page from a
 * benefits or team page.
 * A listUrl on a denied job board (LinkedIn, Naukri, Indeed, Glassdoor, under any suffix) is refused, so those
 * companies' own careers pages cannot be watched either. The careers hosts also become `src-careers`'s exact egress.
 */
export const WatchEntrySchema = z
  .strictObject({
    company: z.string().min(1),
    ats: z.enum(['greenhouse', 'lever', 'ashby', 'careers']),
    slug: z.string().min(1),
    listUrl: ListUrl.optional(),
    linkPattern: RegexSource.optional(),
    hiresInIndia: z.boolean(),
    allRemote: z.boolean(),
  })
  .superRefine((w, ctx) => {
    if (w.ats === 'careers') {
      if (w.listUrl === undefined) ctx.addIssue({ code: 'custom', path: ['listUrl'], message: 'listUrl is required when ats is careers' });
      if (w.linkPattern === undefined) ctx.addIssue({ code: 'custom', path: ['linkPattern'], message: 'linkPattern is required when ats is careers' });
      if (!/^[a-z][a-z0-9-]*$/.test(w.slug)) ctx.addIssue({ code: 'custom', path: ['slug'], message: 'a careers slug must be a kebab id' });
    } else {
      if (w.listUrl !== undefined) ctx.addIssue({ code: 'custom', path: ['listUrl'], message: `listUrl is only for ats careers, not ${w.ats}` });
      if (w.linkPattern !== undefined) ctx.addIssue({ code: 'custom', path: ['linkPattern'], message: `linkPattern is only for ats careers, not ${w.ats}` });
    }
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

export type Experience = z.infer<typeof ExperienceSchema>;

export interface Pack {
  contact: Contact;
  facts: Fact[];
  roles: Role[];
  experience: Experience;
  eligibility: Eligibility;
  lexicon: Lexicon;
  /** `claimableTitles` is always set after loading (defaulted from the roles). */
  targets: Targets & { claimableTitles: string[] };
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
