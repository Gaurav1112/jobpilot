import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ZodType } from 'zod';
import { hashOf } from '../../kernel/canonical.js';
import { sanitisePostingText, unsafePostingText } from '../agents/writing/templates.js';
import {
  AnswersSchema,
  ContactSchema,
  EligibilitySchema,
  ExperienceSchema,
  FactStatus,
  FactsFile,
  FeedsSchema,
  FiltersSchema,
  FxSchema,
  LexiconSchema,
  NamingSchema,
  OffersSchema,
  PolicyUserSchema,
  RolesFile,
  TargetsSchema,
  WatchlistFile,
  type Fact,
  type LexiconGroup,
  type Pack,
  type PublicPack,
} from './schema.js';

export class PackError extends Error {
  override readonly name = 'PackError';
}

/** Defaults for the optional files. The fx default is deliberately ancient so the dashboard warns it is stale. */
const DEFAULT_FX = { asOf: '1970-01-01', toINR: { USD: 83, EUR: 90, GBP: 105, INR: 1 } };

function readYaml<T>(dir: string, file: string, schema: ZodType<T>, fallback?: unknown): T {
  const path = join(dir, file);
  let raw: unknown;
  if (!existsSync(path)) {
    if (fallback === undefined) throw new PackError(`${file}: file not found at ${path}`);
    raw = fallback;
  } else {
    try {
      raw = parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new PackError(`${file}: invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const r = schema.safeParse(raw ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`);
    throw new PackError(`${file}: ${issues.join('; ')}`);
  }
  return r.data;
}

function withKey(g: LexiconGroup): LexiconGroup {
  return { key: g.key, synonyms: [g.key, ...g.synonyms.filter((s) => s !== g.key)], ...(g.display !== undefined ? { display: g.display } : {}) };
}

export interface LoadOptions {
  /**
   * The experience month (YYYY-MM), overriding experience.yaml. Task 11's daily run must pass the current IST month
   * taken from its injected clock, and only that (never a value from the pack or the command line): an asOf in the
   * future inflates the years claim, and nothing here can bound it.
   */
  readonly asOf?: string;
}

/** No role or fact may start after asOf, and no role may end after it (a cert's validity end may). */
function checkDates(pack: Pick<Pack, 'roles' | 'facts' | 'experience'>): void {
  const asOf = pack.experience.asOf;
  pack.roles.forEach((r, i) => {
    if (r.start > asOf) throw new PackError(`roles.yaml: role ${i} (${r.employer}) starts ${r.start}, after experience.asOf ${asOf}`);
    if (r.end !== 'present' && r.end > asOf) throw new PackError(`roles.yaml: role ${i} (${r.employer}) ends ${r.end}, after experience.asOf ${asOf}`);
  });
  for (const f of pack.facts) {
    const start = f.period.slice(0, 7);
    if (start > asOf) throw new PackError(`facts.yaml: fact ${f.id} starts ${start}, after experience.asOf ${asOf}`);
  }
}

const monthKey = (ym: string): number => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7));

/**
 * The default claimable titles (fix round 2, I-R1): the distinct titles of the ongoing roles (end `present`), newest
 * first. A past role's title is not claimable by default, since "I am a ..." states it as current; with no ongoing
 * role the list is empty and the documents use the most recent role's title in the past tense.
 */
export function ongoingRoleTitles(roles: readonly { title: string; start: string; end: string }[]): string[] {
  const sorted = roles.filter((r) => r.end === 'present').sort((a, b) => monthKey(b.start) - monthKey(a.start));
  return [...new Set(sorted.map((r) => r.title))];
}

/** Every claimable title must be a safe template slot already in its sanitised form, since documents use it verbatim. */
function checkClaimable(titles: readonly string[]): void {
  titles.forEach((t, i) => {
    const clean = sanitisePostingText(t);
    const why = clean !== t ? 'it changes when sanitised (markup, entities, control characters or spacing)' : unsafePostingText(clean);
    if (why !== null) throw new PackError(`targets.yaml: claimableTitles entry ${i} is not a safe title (${why})`);
  });
}

/**
 * Loads and validates the pack in `dir`. `overrides` replaces fact statuses (Task 8) before hashing.
 * The hash covers the public pack only, so contact and answers edits never invalidate cached steps.
 */
export function loadPack(dir: string, overrides: Readonly<Record<string, Fact['status']>> = {}, opts: LoadOptions = {}): { pack: Pack; hash: string } {
  const facts = readYaml(dir, 'facts.yaml', FactsFile).facts;
  const seen = new Set<string>();
  for (const f of facts) {
    if (seen.has(f.id)) throw new PackError(`facts.yaml: duplicate fact id ${f.id}`);
    seen.add(f.id);
  }
  for (const [id, status] of Object.entries(overrides)) {
    if (!seen.has(id)) throw new PackError(`fact override names unknown fact id ${id}`);
    if (!FactStatus.safeParse(status).success) throw new PackError(`fact override for ${id} has invalid status ${String(status)}`);
  }
  const lexicon = readYaml(dir, 'lexicon.yaml', LexiconSchema);
  const roles = readYaml(dir, 'roles.yaml', RolesFile).roles;
  let experience: Pack['experience'];
  if (opts.asOf !== undefined) {
    const r = ExperienceSchema.safeParse({ asOf: opts.asOf });
    if (!r.success) throw new PackError(`experience asOf override ${opts.asOf}: expected YYYY-MM`);
    experience = r.data;
  } else if (existsSync(join(dir, 'experience.yaml'))) {
    experience = readYaml(dir, 'experience.yaml', ExperienceSchema);
  } else {
    throw new PackError('experience.asOf is required: write experience.yaml or pass the asOf option (the daily run passes the current month)');
  }
  const targets = readYaml(dir, 'targets.yaml', TargetsSchema);
  const pack: Pack = {
    contact: readYaml(dir, 'contact.yaml', ContactSchema),
    facts: facts.map((f) => (Object.hasOwn(overrides, f.id) ? { ...f, status: overrides[f.id] as Fact['status'] } : f)),
    roles,
    experience,
    eligibility: readYaml(dir, 'eligibility.yaml', EligibilitySchema),
    lexicon: { strong: lexicon.strong.map(withKey), medium: lexicon.medium.map(withKey), gap: lexicon.gap.map(withKey) },
    targets: { ...targets, claimableTitles: targets.claimableTitles ?? ongoingRoleTitles(roles) },
    filters: readYaml(dir, 'filters.yaml', FiltersSchema),
    naming: readYaml(dir, 'naming.yaml', NamingSchema),
    offers: readYaml(dir, 'offers.yaml', OffersSchema, { floor: null }),
    fx: readYaml(dir, 'fx.yaml', FxSchema, DEFAULT_FX),
    answers: readYaml(dir, 'answers.yaml', AnswersSchema),
    watchlist: readYaml(dir, 'watchlist.yaml', WatchlistFile).watchlist,
    feeds: readYaml(dir, 'feeds.yaml', FeedsSchema, { enabled: [] }),
    policyUser: readYaml(dir, 'policy.user.yaml', PolicyUserSchema, {}),
  };
  checkDates(pack);
  checkClaimable(pack.targets.claimableTitles);
  const { contact: _contact, answers: _answers, ...pub } = pack;
  const publicPack: PublicPack = pub;
  return { pack, hash: hashOf(publicPack) };
}

export { assertNoForbidden, citeable, ForbiddenTermError } from './rules.js';
