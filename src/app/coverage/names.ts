import { defineAgent } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { NameMatch, NamePair } from './types.js';

/**
 * The company-name matcher (spec §3). The fixed normalisation: NFKC, case-fold, `&` to `and`, punctuation stripped
 * (apostrophes and dots join, every other mark separates), spaces collapsed, then trailing legal suffixes dropped.
 * Two names are the same company only when they are equal after it. There is no alias guessing, no accent folding
 * and no fuzzy match: `Tata Consultancy Services` and `TCS` stay different, and the company goes to Proposed.
 */

/** Legal-form words dropped from the end of a name (one per token, plus the two-word `private limited`). */
const SUFFIX_TOKENS: ReadonlySet<string> = new Set(['inc', 'ltd', 'llc', 'pvt', 'limited', 'gmbh', 'corp', 'corporation', 'co', 'plc', 'sa', 'ag', 'bv', 'technology', 'technologies']);

export function normalCompanyName(s: string): string {
  const words = s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/gu, ' and ')
    .replace(/[.'‘’]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '');
  // A suffix is only dropped while something is left, so a name made of suffix words alone keeps them.
  while (words.length > 1) {
    const last = words[words.length - 1] as string;
    if (last === 'limited' && words[words.length - 2] === 'private' && words.length > 2) words.splice(-2, 2);
    else if (SUFFIX_TOKENS.has(last)) words.pop();
    else break;
  }
  return words.join(' ');
}

/**
 * Domain labels that say nothing about which company owns the domain (`jobs.com`, `careers.io`, `app.dev`, ...). A
 * closed list, never extended at run time. The domain-label route of `sameCompany` is refused for them: a board named
 * "Jobs" on `jobs.example` proves nothing. The names themselves may still match.
 */
export const GENERIC_LABELS: ReadonlySet<string> = new Set([
  'jobs', 'careers', 'career', 'app', 'apply', 'work', 'hire', 'hiring', 'team', 'inc', 'join', 'talent', 'recruit', 'people', 'hr', 'boards', 'my',
  'get', 'go', 'try', 'the',
]);

/**
 * True iff the two names are equal after `normalCompanyName`, or `b` (the name the board gives) with its spaces
 * removed is `domainLabel` (the company's registrable domain without its suffix, e.g. `purestorage`). The label route
 * is refused when the label is one of GENERIC_LABELS, and nothing matches when either NAME normalises to one of them
 * (such a company goes to Proposed).
 */
export function sameCompany(a: string, b: string, domainLabel?: string): boolean {
  const na = normalCompanyName(a);
  const nb = normalCompanyName(b);
  // a name that is itself a generic word ("Careers", "Jobs Inc") identifies no company: never a match on its own
  if (GENERIC_LABELS.has(na.replace(/ /gu, '')) || GENERIC_LABELS.has(nb.replace(/ /gu, ''))) return false;
  if (na !== '' && na === nb) return true;
  const label = domainLabel?.normalize('NFKC').toLowerCase();
  return label !== undefined && label !== '' && !GENERIC_LABELS.has(label) && nb.replace(/ /gu, '') === label;
}

export const companyNameMatcherContract = defineContract({
  id: 'company-name-matcher',
  version: '1.0.0',
  description: 'Decides whether two company names are one company',
  skills: ['company-name-match'],
  team: 'coverage',
  kind: 'deterministic',
  consumes: NamePair,
  produces: NameMatch,
  capabilities: {},
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
});

export const companyNameMatcher = defineAgent(companyNameMatcherContract, async (p) => [{ same: sameCompany(p.a, p.b, p.domainLabel ?? undefined) }]);
