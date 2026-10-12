import { z } from 'zod';
import { Platform } from '../freelance/types.js';

const FREELANCER_QUERIES = ['java', 'golang', 'typescript', 'node.js', 'react', 'aws', 'kafka', 'kubernetes', 'python', 'llm'];

const PlatformConfig = (enabledByDefault: boolean) =>
  z.strictObject({ enabled: z.boolean().default(enabledByDefault), queries: z.array(z.string()).default([]) });
export type PlatformConfig = z.infer<ReturnType<typeof PlatformConfig>>;

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
function perPlatform<T>(item: (p: Platform) => z.ZodType<T>, defaults: Record<Platform, T>) {
  const shape = Object.fromEntries(Platform.options.map((p) => [p, item(p).default(defaults[p] as never)])) as Record<Platform, z.ZodDefault<z.ZodType<T>>>;
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
  platforms: perPlatform((p) => PlatformConfig(DEFAULT_PLATFORMS[p].enabled), DEFAULT_PLATFORMS).prefault({}),
});
export type FreelanceRules = z.infer<typeof FreelanceFile>;

/**
 * A budget bracket a platform offers as a preset (a client picks it without stating a real budget). Matched on the raw
 * currency, minimum and maximum before any conversion; `max` is null for an open-ended tier ("50+").
 */
const PresetBracket = z.strictObject({ currency: z.string().min(1), min: z.number().nonnegative(), max: z.number().positive().nullable() });
export type PresetBracket = z.infer<typeof PresetBracket>;

const PlatformRule = z.strictObject({
  maxChars: z.number().int().positive().nullable(),
  hookChars: z.number().int().positive().nullable(),
  linksAllowed: z.boolean(),
  attachmentsAllowed: z.boolean(),
  minIntervalMs: z.number().int().nonnegative(),
  presetBrackets: z.array(PresetBracket).default([]),
});
export type PlatformRule = z.infer<typeof PlatformRule>;

/**
 * Derived from the 228 live Freelancer projects recorded on 2026-10-12 (scratchpad probe-out/raw/freelancer-*.json): every
 * (type, currency, min, max) seen on 3 or more distinct projects. Fixed: INR 12500-37500 (39), USD 250-750 (29), USD
 * 30-250 (16), USD 10-30 (14), INR 1500-12500 (12), INR 600-1500 (8), AUD 250-750 (4), INR 37500-75000 (4), CAD 10-30
 * (3). Hourly: USD 15-25 (15), INR 750-1250 (13), USD 8-15 (7), USD 25-50 (4), USD 2-8 (4), USD 50+ (3), INR 100-400
 * (3). (`owner_id` is null in every recording, so distinct owners could not be counted.)
 */
const FREELANCER_PRESETS: PresetBracket[] = [
  { currency: 'INR', min: 12500, max: 37500 }, { currency: 'USD', min: 250, max: 750 }, { currency: 'USD', min: 30, max: 250 },
  { currency: 'USD', min: 10, max: 30 }, { currency: 'INR', min: 1500, max: 12500 }, { currency: 'INR', min: 600, max: 1500 },
  { currency: 'AUD', min: 250, max: 750 }, { currency: 'INR', min: 37500, max: 75000 }, { currency: 'CAD', min: 10, max: 30 },
  { currency: 'USD', min: 15, max: 25 }, { currency: 'INR', min: 750, max: 1250 }, { currency: 'USD', min: 8, max: 15 },
  { currency: 'USD', min: 25, max: 50 }, { currency: 'USD', min: 2, max: 8 }, { currency: 'USD', min: 50, max: null },
  { currency: 'INR', min: 100, max: 400 },
];
const PLAIN: PlatformRule = { maxChars: 2500, hookChars: null, linksAllowed: true, attachmentsAllowed: true, minIntervalMs: 1500, presetBrackets: [] };
const DEFAULT_RULES: Record<Platform, PlatformRule> = {
  freelancer: { maxChars: 1500, hookChars: 150, linksAllowed: false, attachmentsAllowed: true, minIntervalMs: 2000, presetBrackets: FREELANCER_PRESETS },
  upwork: { maxChars: 5000, hookChars: 220, linksAllowed: true, attachmentsAllowed: true, minIntervalMs: 2000, presetBrackets: [] },
  remotive: PLAIN,
  'hn-freelancer': PLAIN,
  'hn-hiring': PLAIN,
  boards: PLAIN,
  gmail: PLAIN,
  reddit: PLAIN,
};

export const PlatformRulesFile = perPlatform(() => PlatformRule, DEFAULT_RULES);
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
