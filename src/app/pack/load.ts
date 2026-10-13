import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ZodType } from 'zod';
import { hashOf } from '../../kernel/canonical.js';
import { sanitisePostingText, unsafePostingText } from '../agents/writing/templates.js';
import { FEED_SOURCES, knownFeeds } from '../feeds.js';
import { CompaniesFile, type CompanyPick } from './companies-schema.js';
import { DEFAULT_FX } from './defaults.js';
import { FreelanceFile, NetworkFile, PlatformRulesFile, type Network } from './freelance-schema.js';
import { redactText } from './rules.js';
import { companiesFileProblems, freelanceFileProblems, networkLabel } from './scan.js';
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

/**
 * A YAML error as "file:line:col: message" (final I9): the parser's message quotes the source line, which may hold a
 * raw employer or a forbidden term, so only its first sentence (cut before " at line") and its position are kept.
 */
function yamlProblem(file: string, e: unknown): string {
  const pos = (e as { linePos?: readonly { line: number; col: number }[] } | null)?.linePos?.[0];
  const first = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';
  const message = first.replace(/ at line \d+, column \d+:?\s*$/u, '').trim() || 'invalid YAML';
  return pos === undefined ? `${file}: invalid YAML: ${message}` : `${file}:${pos.line}:${pos.col}: ${message}`;
}

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
      throw new PackError(yamlProblem(file, e));
    }
  }
  const r = schema.safeParse(raw ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`);
    throw new PackError(`${file}: ${issues.join('; ')}`);
  }
  return r.data;
}

/**
 * The pack as the daily pipeline hashes it: without the freelance fields, so editing (or adding) a freelance file never
 * re-runs a daily step. `freelancePackHash` is the hash with them.
 */
export function withoutFreelance<T extends object>(pack: T): Omit<T, 'freelance' | 'platformRules' | 'networks'> {
  const { freelance: _f, platformRules: _r, networks: _n, ...rest } = pack as T & Record<string, unknown>;
  return rest as Omit<T, 'freelance' | 'platformRules' | 'networks'>;
}

/** The networks/ entries that are the user's files, sorted by name: dotfiles (.DS_Store) and editor leftovers (foo.yaml~, .foo.swp) are not. */
function networkEntries(nd: string): import('node:fs').Dirent[] {
  return readdirSync(nd, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && !e.name.endsWith('~') && !e.name.endsWith('.swp'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** One networks/ entry as a network; throws a `PackError` for a folder, a non-.yaml file, a bad file or an id that is not its file name. */
function readNetwork(dir: string, e: import('node:fs').Dirent): Network {
  const f = e.name;
  if (e.isDirectory()) throw new PackError(`networks/${f}: a folder cannot be a network file; only .yaml files belong in networks/`);
  if (!f.endsWith('.yaml')) throw new PackError(`networks/${f}: only .yaml files belong in networks/`);
  const n = readYaml(dir, `networks/${f}`, NetworkFile);
  if (n.id !== f.slice(0, -'.yaml'.length)) throw new PackError(`networks/${f}: id: ${n.id} must match the file name`);
  return n;
}

/** networks/<id>.yaml, sorted by id; each file's id must be its file name, so the id is never a surprise. */
function readNetworks(dir: string): Network[] {
  const nd = join(dir, 'networks');
  if (!existsSync(nd)) return [];
  return networkEntries(nd).map((e) => readNetwork(dir, e));
}

/**
 * The daily load of the freelance files (final review C1): the daily run never fails because of them. Each file is
 * read, schema-checked and text-checked (`freelanceFileProblems`: the strict forbidden-term check and the glyph check)
 * on its own; a file with any problem is ignored (freelance.yaml and platform-rules.yaml take their defaults, a network
 * file is left out, a stray networks/ entry is skipped) and named in a warning, redacted. The freelance run and
 * `pack check` load strictly and refuse instead.
 */
function readFreelanceLeniently(dir: string, naming: Pick<Pack['naming'], 'forbiddenTerms'>, warnings: string[]): Pick<Pack, 'freelance' | 'platformRules' | 'networks'> {
  const warn = (problem: string): void => {
    warnings.push(redactText(`${problem} (the daily run ignores this file; \`jobpilot pack check\` and the freelance run refuse it until it is fixed)`, naming));
  };
  const reason = (e: unknown): string => (e instanceof PackError ? e.message : `could not be read: ${e instanceof Error ? e.message : String(e)}`);
  function one<T>(file: string, schema: ZodType<T>): T {
    const fallback = schema.parse({});
    try {
      const v = readYaml(dir, file, schema, {});
      const text = freelanceFileProblems(file, v, naming);
      if (text.length === 0) return v;
      warn(text.join('; '));
    } catch (e) {
      warn(reason(e));
    }
    return fallback;
  }
  const freelance = one('freelance.yaml', FreelanceFile);
  const platformRules = one('platform-rules.yaml', PlatformRulesFile);
  const networks: Network[] = [];
  const nd = join(dir, 'networks');
  if (existsSync(nd)) {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = networkEntries(nd);
    } catch (e) {
      warn(`networks: ${reason(e)}`);
    }
    entries.forEach((e, i) => {
      const label = networkLabel(e.name.replace(/\.yaml$/u, ''), i, naming);
      try {
        const n = readNetwork(dir, e);
        const text = freelanceFileProblems(label, n, naming);
        if (text.length === 0) networks.push(n);
        else warn(text.join('; '));
      } catch (err) {
        // A file name holding a forbidden term is named by position only (the problem names the file).
        warn(label.startsWith('networks #') ? `${label}: ${redactText(reason(err), naming)}` : reason(err));
      }
    });
  }
  return { freelance, platformRules, networks };
}

/**
 * companies.yaml (the career-site coverage's company picks), read apart from the pack: only the coverage reads it, so
 * it is in neither the daily hash nor `freelancePackHash`, and an absent file is no companies. `strict` (the coverage
 * run and `pack check` only) throws on a parse or schema problem; `daily` and `freelance` ignore a file with any
 * problem, with a redacted warning, so it can never stop the daily or the freelance run (as the freelance files are
 * for the daily run, final review C1). Forbidden terms and glyphs are `packTextProblems`' job
 * when strict; the daily load also checks them here and ignores the file.
 */
function readCompanies(dir: string, mode: LoadMode, naming: Pick<Pack['naming'], 'forbiddenTerms'>, warnings: string[]): CompanyPick[] {
  if (mode === 'strict') return readYaml(dir, 'companies.yaml', CompaniesFile, {}).companies;
  try {
    const v = readYaml(dir, 'companies.yaml', CompaniesFile, {});
    const text = companiesFileProblems(v.companies, naming);
    if (text.length === 0) return v.companies;
    warnings.push(redactText(`${text.join('; ')} (the ${mode} run ignores this file; \`jobpilot pack check\` and the coverage run refuse it until it is fixed)`, naming));
  } catch (e) {
    const why = e instanceof PackError ? e.message : `companies.yaml: could not be read: ${e instanceof Error ? e.message : String(e)}`;
    warnings.push(redactText(`${why} (the ${mode} run ignores this file; \`jobpilot pack check\` and the coverage run refuse it until it is fixed)`, naming));
  }
  return [];
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
  /**
   * How the freelance files (freelance.yaml, platform-rules.yaml, networks/) are read (final review C1). `strict`
   * (the default; the freelance run, `networks pack`, `sources probe`, `pack check`, `pack import`): any problem
   * throws. `daily` (`run`, `docs rebuild`, `serve`): a file with a parse, schema, stray-file, glyph or forbidden-term
   * problem is ignored with a warning (`readFreelanceLeniently`), so it can never stop the daily run, and its content
   * never reaches it. `freelance` (`run-freelance`, `sources probe`): the freelance files are read as in `strict`, and a
   * broken companies.yaml is ignored with a warning.
   */
  readonly mode?: LoadMode;
}

/**
 * `strict`: every optional file is refused on any problem (`pack check`, the coverage run, `networks`, `pack import`).
 * `daily`: the freelance files and companies.yaml are ignored with a warning when broken.
 * `freelance`: the freelance files are strict as in `strict`, but companies.yaml (which freelance never reads) is
 * ignored with a warning when broken.
 */
export type LoadMode = 'strict' | 'daily' | 'freelance';

/**
 * No role or fact may start after asOf, and no role may end after it (a cert's validity end may). Roles are named by
 * index and facts by id, never by employer (final I9: the raw employer may be the client's name).
 */
function checkDates(pack: Pick<Pack, 'roles' | 'facts' | 'experience'>): void {
  const asOf = pack.experience.asOf;
  pack.roles.forEach((r, i) => {
    if (r.start > asOf) throw new PackError(`roles.yaml: role ${i} starts ${r.start}, after experience.asOf ${asOf}`);
    if (r.end !== 'present' && r.end > asOf) throw new PackError(`roles.yaml: role ${i} ends ${r.end}, after experience.asOf ${asOf}`);
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
export function loadPack(
  dir: string,
  overrides: Readonly<Record<string, Fact['status']>> = {},
  opts: LoadOptions = {},
): { pack: Pack; hash: string; freelancePackHash: string; companies: CompanyPick[]; companiesHash: string; warnings: string[] } {
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
  const base: Omit<Pack, 'freelance' | 'platformRules' | 'networks'> = {
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
    // The fx default (an optional file) is deliberately ancient so the dashboard warns it is stale.
    fx: readYaml(dir, 'fx.yaml', FxSchema, DEFAULT_FX),
    answers: readYaml(dir, 'answers.yaml', AnswersSchema),
    watchlist: readYaml(dir, 'watchlist.yaml', WatchlistFile).watchlist,
    feeds: readYaml(dir, 'feeds.yaml', FeedsSchema, { enabled: [] }),
    policyUser: readYaml(dir, 'policy.user.yaml', PolicyUserSchema, {}),
  };
  // Read after the daily files, so a strict load names the same first problem as before; a daily load needs naming.
  const warnings: string[] = [];
  const freelanceParts: Pick<Pack, 'freelance' | 'platformRules' | 'networks'> =
    opts.mode === 'daily'
      ? readFreelanceLeniently(dir, base.naming, warnings)
      : {
          freelance: readYaml(dir, 'freelance.yaml', FreelanceFile, {}),
          platformRules: readYaml(dir, 'platform-rules.yaml', PlatformRulesFile, {}),
          networks: readNetworks(dir),
        };
  const companies = readCompanies(dir, opts.mode ?? 'strict', base.naming, warnings);
  const pack: Pack = { ...base, ...freelanceParts };
  checkDates(pack);
  // A feed with no source agent would be configuration the run silently never honours (review I2).
  for (const f of pack.feeds.enabled) if (!Object.hasOwn(FEED_SOURCES, f)) throw new PackError(`feeds.yaml: unknown feed ${f} (known: ${knownFeeds().join(', ')})`);
  checkClaimable(pack.targets.claimableTitles);
  const { contact: _contact, answers: _answers, ...pub } = pack;
  const publicPack: PublicPack = pub;
  return { pack, hash: hashOf(withoutFreelance(publicPack)), freelancePackHash: hashOf(publicPack), companies, companiesHash: hashOf({ companies }), warnings };
}

export { assertNoForbidden, citeable, ForbiddenTermError } from './rules.js';
