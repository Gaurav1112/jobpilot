import { z } from 'zod';
import { Platform } from '../freelance/types.js';

const FREELANCER_QUERIES = ['java', 'golang', 'typescript', 'node.js', 'react', 'aws', 'kafka', 'kubernetes', 'python', 'llm'];

const PlatformConfig = z.strictObject({ enabled: z.boolean().default(true), queries: z.array(z.string()).default([]) });
export type PlatformConfig = z.infer<typeof PlatformConfig>;

/** Sources without a query list are on by default; upwork and reddit have no source in this build, so they start off. */
const DEFAULT_PLATFORMS: Record<Platform, PlatformConfig> = {
  freelancer: { enabled: true, queries: FREELANCER_QUERIES },
  remotive: { enabled: true, queries: [] },
  'hn-freelancer': { enabled: true, queries: [] },
  'hn-hiring': { enabled: true, queries: [] },
  boards: { enabled: true, queries: [] },
  gmail: { enabled: true, queries: [] },
  upwork: { enabled: false, queries: [] },
  reddit: { enabled: false, queries: [] },
};

/** One entry per platform; a platform the file leaves out takes its default, one it names is replaced whole. */
function perPlatform<T>(item: z.ZodType<T>, defaults: Record<Platform, T>) {
  const shape = Object.fromEntries(Platform.options.map((p) => [p, item.default(defaults[p] as never)])) as Record<Platform, z.ZodDefault<z.ZodType<T>>>;
  return z.strictObject(shape);
}

const IstWindow = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM-HH:MM');
const Money = z.number().nonnegative();

/** Spec §5, §13 values are the defaults, so an absent file and an empty file both mean the user's rules. */
export const FreelanceFile = z.strictObject({
  rateFloorUsdHour: Money.default(40),
  maxHoursPerWeek: z.number().positive().default(20),
  istWindow: IstWindow.default('18:00-00:00'),
  derivedRateCountsForFloor: z.boolean().default(true),
  fixedBudgetFloorUsd: Money.default(500),
  fitFloor: z.number().min(0).max(100).default(60),
  kinds: z.array(z.enum(['contract', 'gig', 'bounty'])).min(1, 'at least one kind is required').default(['contract', 'gig', 'bounty']),
  platforms: perPlatform(PlatformConfig, DEFAULT_PLATFORMS).prefault({}),
});
export type FreelanceRules = z.infer<typeof FreelanceFile>;

const PlatformRule = z.strictObject({
  maxChars: z.number().int().positive().nullable(),
  hookChars: z.number().int().positive().nullable(),
  linksAllowed: z.boolean(),
  attachmentsAllowed: z.boolean(),
  minIntervalMs: z.number().int().nonnegative(),
});
export type PlatformRule = z.infer<typeof PlatformRule>;

const PLAIN: PlatformRule = { maxChars: 2500, hookChars: null, linksAllowed: true, attachmentsAllowed: true, minIntervalMs: 1500 };
const DEFAULT_RULES: Record<Platform, PlatformRule> = {
  freelancer: { maxChars: 1500, hookChars: 150, linksAllowed: false, attachmentsAllowed: true, minIntervalMs: 2000 },
  upwork: { maxChars: 5000, hookChars: 220, linksAllowed: true, attachmentsAllowed: true, minIntervalMs: 2000 },
  remotive: PLAIN,
  'hn-freelancer': PLAIN,
  'hn-hiring': PLAIN,
  boards: PLAIN,
  gmail: PLAIN,
  reddit: PLAIN,
};

export const PlatformRulesFile = perPlatform(PlatformRule, DEFAULT_RULES);
export type PlatformRules = z.infer<typeof PlatformRulesFile>;

/** The user is expected to check a shipped starter against the network's live page before relying on it. */
export const NetworkFile = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'expected a lowercase id'),
  name: z.string().min(1),
  url: z.url(),
  kind: z.literal('vetted-network'),
  screening: z.array(z.strictObject({ stage: z.string().min(1), prep: z.array(z.string()) })),
  profileFields: z.array(z.strictObject({ id: z.string().min(1), maxChars: z.number().int().positive() })),
  targetTitles: z.array(z.string()),
  keywords: z.array(z.string()),
  checkedByUser: z.boolean(),
});
export type Network = z.infer<typeof NetworkFile>;
