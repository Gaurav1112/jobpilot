import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ZodType } from 'zod';
import { hashOf } from '../../kernel/canonical.js';
import {
  AnswersSchema,
  ContactSchema,
  EligibilitySchema,
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
  type Naming,
} from './schema.js';

export class PackError extends Error {
  override readonly name = 'PackError';
}

export class ForbiddenTermError extends Error {
  override readonly name = 'ForbiddenTermError';
  constructor(readonly term: string) {
    super(`forbidden term found: ${term}`);
  }
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
  return { key: g.key, synonyms: [g.key, ...g.synonyms.filter((s) => s !== g.key)] };
}

/**
 * Loads and validates the pack in `dir`. `overrides` replaces fact statuses (Task 8) before hashing.
 * The hash covers the public pack only, so contact and answers edits never invalidate cached steps.
 */
export function loadPack(dir: string, overrides: Readonly<Record<string, Fact['status']>> = {}): { pack: Pack; hash: string } {
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
  const pack: Pack = {
    contact: readYaml(dir, 'contact.yaml', ContactSchema),
    facts: facts.map((f) => (Object.hasOwn(overrides, f.id) ? { ...f, status: overrides[f.id] as Fact['status'] } : f)),
    roles: readYaml(dir, 'roles.yaml', RolesFile).roles,
    eligibility: readYaml(dir, 'eligibility.yaml', EligibilitySchema),
    lexicon: { strong: lexicon.strong.map(withKey), medium: lexicon.medium.map(withKey), gap: lexicon.gap.map(withKey) },
    targets: readYaml(dir, 'targets.yaml', TargetsSchema),
    filters: readYaml(dir, 'filters.yaml', FiltersSchema),
    naming: readYaml(dir, 'naming.yaml', NamingSchema),
    offers: readYaml(dir, 'offers.yaml', OffersSchema, { floor: null }),
    fx: readYaml(dir, 'fx.yaml', FxSchema, DEFAULT_FX),
    answers: readYaml(dir, 'answers.yaml', AnswersSchema),
    watchlist: readYaml(dir, 'watchlist.yaml', WatchlistFile).watchlist,
    feeds: readYaml(dir, 'feeds.yaml', FeedsSchema, { enabled: [] }),
    policyUser: readYaml(dir, 'policy.user.yaml', PolicyUserSchema, {}),
  };
  const { contact: _contact, answers: _answers, ...pub } = pack;
  const publicPack: PublicPack = pub;
  return { pack, hash: hashOf(publicPack) };
}

/** Only verified and user-stated facts may be cited in a document. */
export function citeable(f: Fact): boolean {
  return f.status === 'verified' || f.status === 'user-stated';
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Cyrillic and Greek letters that look like Latin ones, mapped to the Latin letter, so a homoglyph spelling of a
 * forbidden term still matches. For the forbidden-term check only.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic lower and upper case
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S',
  // Greek upper case, and the lower case letters that read as Latin
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Χ: 'X', Υ: 'Y',
  ο: 'o', ι: 'i', κ: 'k', ρ: 'p', ν: 'v',
  // Turkish dotless i (dotted İ decomposes to I plus a combining dot, removed with the other marks)
  ı: 'i',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'gu');

/**
 * Folds text for matching: NFKD, combining marks and invisible format characters (zero-width etc.) removed, Cyrillic
 * and Greek homoglyphs and the dotless i mapped to Latin, case-folded, ß as ss, then NFKC. So `İnitech`, `Іnitech`
 * (Cyrillic І) and `Café` fold like `initech` and `cafe`.
 */
function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c)
    .toLowerCase()
    .replaceAll('ß', 'ss')
    .normalize('NFKC');
}

/**
 * Throws `ForbiddenTermError` if `text` contains any forbidden term. Both sides are folded (see `fold`),
 * whitespace runs inside a term match any whitespace (including NBSP and newlines), and boundaries are
 * Unicode letter/digit lookarounds.
 */
export function assertNoForbidden(text: string, naming: Naming): void {
  const hay = fold(text);
  for (const term of naming.forbiddenTerms) {
    const words = fold(term).split(/\s+/u).filter((w) => w !== '');
    if (words.length === 0) continue;
    const body = words.map(escapeRe).join('\\s+');
    if (new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'u').test(hay)) throw new ForbiddenTermError(term);
  }
}
