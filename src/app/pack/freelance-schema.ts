import { z } from 'zod';
import { Platform } from '../freelance/types.js';

/**
 * The default freelance keywords (freelance-boost, research C1/B2 2026-10-14): backend and AI-agent work, the stack
 * the research found paying at or above the floor; the generic `react` and `python` are left out (they pulled consumer
 * app work). One search per keyword; a pack's freelance.yaml replaces a platform's list whole.
 */
export const FREELANCE_KEYWORDS: readonly string[] = ['backend', 'api development', 'java', 'spring boot', 'kafka', 'golang', 'microservices', 'aws', 'llm', 'ai agent', 'rag', 'node.js', 'typescript', 'kubernetes'];

const PlatformConfig = (enabledByDefault: boolean) =>
  z.strictObject({ enabled: z.boolean().default(enabledByDefault), queries: z.array(z.string()).default([]) });
export type PlatformConfig = z.infer<ReturnType<typeof PlatformConfig>>;

/** Sources without a query list are on by default; upwork and reddit have no source in this build, so they start off. */
const DEFAULT_PLATFORMS: Record<Platform, PlatformConfig> = {
  freelancer: { enabled: true, queries: [...FREELANCE_KEYWORDS] },
  remotive: { enabled: true, queries: [] },
  'hn-freelancer': { enabled: true, queries: [] },
  'hn-hiring': { enabled: true, queries: [] },
  boards: { enabled: true, queries: [] },
  gmail: { enabled: true, queries: [] },
  upwork: { enabled: false, queries: [] },
  reddit: { enabled: false, queries: [] },
  himalayas: { enabled: true, queries: [...FREELANCE_KEYWORDS] },
  // One request each (no query): Draft.dev and Prime Intellect read GitHub's API, Fractional Jobs its public page.
  draftdev: { enabled: true, queries: [] },
  'prime-intellect': { enabled: true, queries: [] },
  'fractional-jobs': { enabled: true, queries: [] },
};

/** One entry per platform; a platform the file leaves out takes its default; one it names is replaced whole (platform config) or merged over the defaults (platform rules). */
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
  // 45, not the daily pipeline's 60 (user decision 2026-10-12): a gig title never earns the full-time title points (seniority, family), so the same lexicon scores gigs lower.
  fitFloor: z.number().min(0).max(100).default(45),
  kinds: z.array(z.enum(['contract', 'gig', 'bounty'])).min(1, 'at least one kind is required').default(['contract', 'gig', 'bounty']),
  platforms: perPlatform((p) => PlatformConfig(DEFAULT_PLATFORMS[p].enabled), DEFAULT_PLATFORMS).prefault({}),
});
export type FreelanceRules = z.infer<typeof FreelanceFile>;

/**
 * A budget tier a platform offers as a preset (a client picks it without stating a real budget). `type` keeps fixed and
 * hourly tiers apart (a fixed budget matches only fixed tiers). Matched on the raw minimum and maximum before any
 * conversion; `max` is null for an open-ended tier ("50+"). `currencies` is the list of currency codes the tier holds
 * in, or '*' for any.
 */
const PresetBracket = z.strictObject({
  type: z.enum(['fixed', 'hourly']),
  min: z.number().nonnegative(),
  max: z.number().positive().nullable(),
  currencies: z.union([z.literal('*'), z.array(z.string().min(1)).min(1)]),
});
export type PresetBracket = z.infer<typeof PresetBracket>;

const nullablePositiveInt = z.number().int().positive().nullable();
const ruleShape = (d: { maxChars: number | null; hookChars: number | null; linksAllowed: boolean; attachmentsAllowed: boolean; minIntervalMs: number; presetBrackets: PresetBracket[] }) =>
  z.strictObject({
    maxChars: nullablePositiveInt.default(d.maxChars),
    hookChars: nullablePositiveInt.default(d.hookChars),
    linksAllowed: z.boolean().default(d.linksAllowed),
    attachmentsAllowed: z.boolean().default(d.attachmentsAllowed),
    minIntervalMs: z.number().int().nonnegative().default(d.minIntervalMs),
    presetBrackets: z.array(PresetBracket).default(d.presetBrackets),
  });
export type PlatformRule = z.infer<ReturnType<typeof ruleShape>>;

/** The currencies in which Freelancer's dollar-like tiers keep the same (min, max) shape. INR and HKD have their own scaled tiers. */
const DOLLAR_LIKE = ['USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'SGD'];
const dollar = (type: 'fixed' | 'hourly', min: number, max: number | null): PresetBracket => ({ type, min, max, currencies: DOLLAR_LIKE });
const inr = (type: 'fixed' | 'hourly', min: number, max: number | null): PresetBracket => ({ type, min, max, currencies: ['INR'] });
/**
 * Derived from the 228 unique live Freelancer projects recorded on 2026-10-12 (scratchpad probe-out/raw/freelancer-*.json):
 * every (type, shape) seen on 3 or more projects, the dollar-like currencies pooled by shape. Fixed: 250-750 (37 in
 * dollar-like currencies), 30-250 (18), 10-30 (17), 750-1500 (3), 3000-5000 (3), 5000-10000 (3); INR 12500-37500 (39),
 * 1500-12500 (12), 600-1500 (8), 37500-75000 (4). Hourly: 15-25 (15), 8-15 (7), 25-50 (4), 2-8 (4), 50+ (3); INR
 * 750-1250 (13), 100-400 (3). `owner_id` is null in every recording, so distinct owners could not be counted.
 * Three more were each OBSERVED ONCE in the recordings, in a currency whose tier minimum differs from the dollar one:
 * EUR 8-30 (gig 40753031), NZD 14-30 (40762859) and HKD 240-2000 (40760110). Nothing is added that was not observed.
 */
const FREELANCER_PRESETS: PresetBracket[] = [
  dollar('fixed', 250, 750), dollar('fixed', 30, 250), dollar('fixed', 10, 30), dollar('fixed', 750, 1500), dollar('fixed', 3000, 5000), dollar('fixed', 5000, 10000),
  inr('fixed', 12500, 37500), inr('fixed', 1500, 12500), inr('fixed', 600, 1500), inr('fixed', 37500, 75000),
  { type: 'fixed', min: 8, max: 30, currencies: ['EUR'] }, { type: 'fixed', min: 14, max: 30, currencies: ['NZD'] }, { type: 'fixed', min: 240, max: 2000, currencies: ['HKD'] },
  dollar('hourly', 15, 25), dollar('hourly', 8, 15), dollar('hourly', 25, 50), dollar('hourly', 2, 8), dollar('hourly', 50, null),
  inr('hourly', 750, 1250), inr('hourly', 100, 400),
];
const PLAIN_DEFAULTS: PlatformRule = { maxChars: 2500, hookChars: null, linksAllowed: true, attachmentsAllowed: true, minIntervalMs: 1500, presetBrackets: [] };
const DEFAULT_RULES: Record<Platform, PlatformRule> = {
  freelancer: { maxChars: 1500, hookChars: 150, linksAllowed: false, attachmentsAllowed: true, minIntervalMs: 2000, presetBrackets: FREELANCER_PRESETS },
  upwork: { maxChars: 5000, hookChars: 220, linksAllowed: true, attachmentsAllowed: true, minIntervalMs: 2000, presetBrackets: [] },
  remotive: PLAIN_DEFAULTS,
  'hn-freelancer': PLAIN_DEFAULTS,
  'hn-hiring': PLAIN_DEFAULTS,
  boards: PLAIN_DEFAULTS,
  gmail: PLAIN_DEFAULTS,
  reddit: PLAIN_DEFAULTS,
  // src-himalayas-gigs: at least 2 s between requests to himalayas.app (the brief's politeness floor).
  himalayas: { ...PLAIN_DEFAULTS, minIntervalMs: 2000 },
  // The sources-expansion gig sources: at least 2 s between requests to one host (api.github.com, fractionaljobs.io).
  draftdev: { ...PLAIN_DEFAULTS, minIntervalMs: 2000 },
  'prime-intellect': { ...PLAIN_DEFAULTS, minIntervalMs: 2000 },
  'fractional-jobs': { ...PLAIN_DEFAULTS, minIntervalMs: 2000 },
};

/** A user-written entry MERGES over the platform's defaults: every field it leaves out keeps the default (an explicit `presetBrackets: []` stays empty). */
export const PlatformRulesFile = perPlatform((p) => ruleShape(DEFAULT_RULES[p]), DEFAULT_RULES);
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
