import { z } from 'zod';
import { defineAgent } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { KernelError } from '../../kernel/errors.js';
import { belowFloor, toInrPerYear } from '../comp/floor.js';
import { hasTerm } from '../lexicon.js';
import { compileSafePattern } from '../pack/regex.js';
import { citiesIn, countriesIn } from '../text/norm.js';
import { EligibilityVerdict, Posting } from '../types.js';

/**
 * Eligibility (spec §5.2): the fixed checks, in order; the first failure ends them. A `review` (remote scope unclear)
 * is not a failure, so the comp check still runs after it.
 *
 * 1. closed: a blank title or URL → `closed`.
 * 2. role: the first `filters.roleDeny` pattern (pack order, compiled only by `compileSafePattern`) that the title
 *    matches → `role:<pattern>`.
 * 3. company: the first `filters.companyDeny` name found in the company as a whole word, case-insensitive →
 *    `company:<name>`.
 * 4. employment: the structured type, split on `, ; / |`, each part canonicalised (`canonicalEmployment`). Any part in
 *    `eligibility.employmentTypes` (full-time) passes. Otherwise the first known part rejects as
 *    `employment:<canonical>` (contract, temporary, intern, part-time). When no part is known (null, or "Regular"):
 *    "full-time" or "permanent" in the type, title or first 1500 characters passes; else "intern" in the title, or the
 *    first EMPLOYMENT_PHRASES phrase there, rejects as `employment:<word>` (contract-to-hire, c2h, contract, hourly,
 *    temporary, intern, freelance). A bare deny word is not an employment phrase.
 * 5. remote from India, by the decision table:
 *    a. `structured` onsite or hybrid → `onsite` / `hybrid`. In the title or location a bare `hybrid` → `hybrid`, a bare
 *       `on-site`/`onsite`/`in-office` → `onsite`. In the first 1500 characters of the description only
 *       work-arrangement phrases count (HYBRID_PHRASES, ONSITE_PHRASES, "must be located/based in|near <city or our
 *       office>"). Negations and alternatives ("not hybrid", "no office", "remote or hybrid") never count.
 *    b. India excluded → `remote-excludes-india:<rule>`, rules in this order: `location` (a `location:excludes:india`
 *       signal; a city-level exclusion is informational only), `us-only`, `must-reside`, `us-work-authorization`,
 *       `eu-only` (phrases in the title, location or first 1500 characters; US, USA and U.S. only in capitals;
 *       must-reside only in sentences about the candidate; a phrase whose own sentence names India is no exclusion;
 *       a posting whose remote location names India or a region with India goes to `review` instead), and
 *       `country-list`: structured remote or a location that says remote, with a non-empty country list naming none
 *       of india, apac, asia, south asia, worldwide. When the description names India or one of those regions, it is
 *       `review` instead. This runs before the allRemote and hiresInIndia checks.
 *    c. eligible when: India is a country and something structured or the location or title says remote; or the
 *       watchlist entry is all-remote; or structured remote, the countries are empty or name apac, asia, south asia or
 *       worldwide, and the watchlist says hiresInIndia; or the location says remote and India.
 *    d. otherwise, when anything says remote (structured, a signal, or the word in the title, location or
 *       description) → `review` with `remote-unclear` and the note `remote scope unclear - verify`; else `onsite`.
 *    The watchlist entry is found by (ats, slug), or by company name for a feed.
 * 6. comp: only a `base` basis with a stated maximum is judged: its maximum in INR (`toInrPerYear`) below
 *    `offers.floor` → `below-floor:<maxInr>`. No comp adds the note `pay not disclosed`; an unknown basis adds
 *    `pay basis unclear` and is never rejected on pay; "from X" (no maximum) is never below the floor.
 * 7. experience is not checked here: the scorer applies the years penalty.
 */

const HEAD = 1500;
export const NOTE_PAY_UNDISCLOSED = 'pay not disclosed';
export const NOTE_PAY_BASIS = 'pay basis unclear';
export const NOTE_REMOTE_UNCLEAR = 'remote scope unclear - verify';

/** The parts of the pack this agent reads; anything else in it is ignored. */
const PackView = z.object({
  // `filters.employmentDeny` are the words that reject when bare in the title (fix round 2); the description uses the
  // fixed EMPLOYMENT_PHRASES instead, because bare words there are mostly not about employment (fix round 1, I1).
  filters: z.object({ roleDeny: z.array(z.string()), companyDeny: z.array(z.string()), employmentDeny: z.array(z.string()) }),
  eligibility: z.object({ employmentTypes: z.array(z.string()) }),
  watchlist: z.array(z.object({ company: z.string(), ats: z.string(), slug: z.string(), hiresInIndia: z.boolean(), allRemote: z.boolean() })),
  offers: z.object({ floor: z.object({ amount: z.number(), currency: z.enum(['INR', 'USD', 'EUR', 'GBP']) }).nullable() }),
  fx: z.object({ toINR: z.object({ INR: z.number(), USD: z.number(), EUR: z.number(), GBP: z.number() }) }),
});
export type EligibilityPack = z.infer<typeof PackView>;

export interface Decision {
  verdict: EligibilityVerdict['verdict'];
  reasons: string[];
  notes: string[];
}

const reject = (reason: string): Decision => ({ verdict: 'rejected', reasons: [reason], notes: [] });

const EMPLOYMENT: Readonly<Record<string, string>> = {
  fulltime: 'full-time',
  permanent: 'full-time',
  contract: 'contract',
  contractor: 'contract',
  temporary: 'temporary',
  temp: 'temporary',
  intern: 'intern',
  internship: 'intern',
  parttime: 'part-time',
};

/** One employment-type value in canonical form (`full-time`, `contract`, `temporary`, `intern`, `part-time`), or null when unknown. */
export function canonicalEmployment(value: string): string | null {
  const key = value.toLowerCase().replace(/[\s_-]+/g, '');
  return Object.hasOwn(EMPLOYMENT, key) ? (EMPLOYMENT[key] ?? null) : null;
}

/** Full-time stated in the type, title or text: it passes like a structured full-time type. */
const FULL_TIME_TEXT = /\b(?:full[\s_-]?time|permanent)\b/i;
/** A pay figure per hour ("$60 per hour", "₹900/hr"): "events per hour" is not employment. */
const PAY_PER_HOUR = /(?:[$€£₹]|\b(?:usd|inr|eur|gbp|rs\.?)\s*)\s*\d[\d,]*(?:\.\d+)?\s*(?:\/\s*|per\s+)(?:hour|hr)\b/i;
/**
 * Employment phrases, in order (task 7 fix round 1, I1): a bare deny word is not enough ("first 6 months", "hourly
 * batch jobs", "temporary credentials", "contract testing", "smart contract" all pass).
 */
const EMPLOYMENT_PHRASES: readonly (readonly [string, RegExp])[] = [
  ['contract-to-hire', /\bcontract[\s-]to[\s-]hire\b/i],
  ['c2h', /\bc2h\b/i],
  ['contract', /\bcontract (?:role|position|basis|employee)s?\b/i],
  ['contract', /\b\d+[\s-]months?[\s-]contract\b/i],
  ['hourly', /\bhourly rate\b/i],
  ['hourly', PAY_PER_HOUR],
  ['temporary', /\btemporary (?:position|role)s?\b/i],
  ['intern', /\binternships?\b/i],
  ['freelance', /\bfreelance\b/i],
];

/** Title phrases where a contract word is not employment ("Smart Contract Engineer", "Contract Testing"). */
const TITLE_NOT_EMPLOYMENT = /\bsmart[\s-]+contracts?\b|\bcontract[\s-]+testing\b/gi;

/** Role words that a leading "Contract <role>" must reach within three words. */
const ROLE_WORD = 'engineers?|developers?|programmers?|architects?|consultants?|analysts?|sde|swe|leads?|specialists?|administrators?|testers?';
/** Domain nouns: "Contract Management", "Temporary Storage", "Hourly Billing" name a product, not employment. */
const DOMAIN_WORD = 'management|lifecycle|intelligence|platform|billing|storage|deposits?|data|analytics|systems?|marketplace|services?|operations|ledger';
const titleWordRe = (w: string): string => w.trim().split(/[\s-]+/).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s-]+');
const sameWords = (a: string, b: string): boolean => a.toLowerCase().replace(/[\s-]+/g, ' ').trim() === b.toLowerCase().replace(/[\s-]+/g, ' ').trim();

/**
 * The longest `filters.employmentDeny` word that stands as a qualifier in the title (fix round 3): in parentheses or
 * brackets ("(Contract)", "[6 months]"), as the whole last part after " - ", " | ", "," or ":" ("... - Contract"), or
 * leading a role ("Contract Java Developer", but not "Contract Management Engineer"). Anywhere else it is a domain
 * word ("Contract Lifecycle Management", "Temporary Storage") and does not count.
 */
function titleDenyWord(title: string, words: readonly string[]): string | undefined {
  const t = title.replace(TITLE_NOT_EMPLOYMENT, ' ');
  const bracketed = [...t.matchAll(/[([]([^)\]]*)[)\]]/g)].map((m) => m[1] ?? '');
  const parts = t.split(/\s+[-–—|]\s+|\s*[,:]\s*/);
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  const standalone = (w: string): boolean =>
    bracketed.some((b) => hasTerm(b, w)) ||
    sameWords(last, w) ||
    new RegExp(`^\\s*${titleWordRe(w)}\\s+(?!(?:${DOMAIN_WORD})\\b)(?:[\\p{L}\\p{N}+#./]+\\s+){0,2}(?:${ROLE_WORD})\\b`, 'iu').test(t);
  return [...words].filter((w) => w.trim() !== '').sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).find(standalone);
}

function employmentReason(p: Posting, pack: EligibilityPack): string | null {
  // A bare contract word in the title is the posting's own label; it wins over a structured type (fix round 2).
  const titleWord = titleDenyWord(p.title, pack.filters.employmentDeny);
  if (titleWord !== undefined) return `employment:${titleWord}`;
  const parts = (p.employmentType ?? '').split(/[,;/|]/).map((s) => s.trim()).filter((s) => s !== '');
  const known = parts.map(canonicalEmployment).filter((c): c is string => c !== null);
  if (known.some((c) => pack.eligibility.employmentTypes.includes(c))) return null;
  if (known.length > 0) return `employment:${known[0]}`;
  const text = [p.employmentType ?? '', p.title, p.descriptionText.slice(0, HEAD)].join('\n');
  if (FULL_TIME_TEXT.test(text)) return null;
  if (/\bintern\b/i.test(p.title)) return 'employment:intern';
  const phrase = EMPLOYMENT_PHRASES.find(([, re]) => re.test(text));
  return phrase === undefined ? null : `employment:${phrase[0]}`;
}

/** "not hybrid", "no office", "remote or hybrid", "onsite/remote": negations and alternatives never reject. */
const NEGATED_OR_ALTERNATIVE =
  /\b(?:not|no|non)[\s-]+(?:an?\s+)?(?:hybrid|on-?site|in[- ]office|office)\b|\bremote\s*(?:\/|\bor\b|\band\/or\b)\s*(?:hybrid|on-?site|in[- ]office)\b|\b(?:hybrid|on-?site|in[- ]office)\s*(?:\/|\bor\b|\band\/or\b)\s*remote\b/gi;
const withoutAlternatives = (s: string): string => s.replace(NEGATED_OR_ALTERNATIVE, ' ');
/** In the title or location a bare word is the arrangement. */
const HYBRID_WORD = /\bhybrid\b/i;
const ONSITE_WORD = /\bon-?site\b|\bin[- ]office\b/i;
/** A number of office days, in digits or words ("2", "2-3", "two", "two-three"). */
const DAY_COUNT = '(?:\\d+|one|two|three|four|five)';
const DAYS = `${DAY_COUNT}(?:\\s*[-–]\\s*${DAY_COUNT})?`;
/** In the description only these work-arrangement phrases count (task 7 fix round 1, I2). */
const HYBRID_PHRASES: readonly RegExp[] = [
  /\bhybrid[\s-]+(?:work|working|role|position|model|schedule|arrangement|setup|policy|mode)\b/i,
  /\b(?:role|position|job) is (?:a )?hybrid\b/i,
  new RegExp(`\\b${DAYS} days? (?:(?:a|per|/) ?week )?(?:in|at) (?:the )?office\\b`, 'i'),
  new RegExp(`\\bin (?:the )?office ${DAYS} days\\b`, 'i'),
  /\b(?:on-?site|in[- ]office) (?:\d+|one|two|three|four) days\b/i,
];
const ONSITE_PHRASES: readonly RegExp[] = [
  /\bwork(?:ing)? from (?:the|our) office\b/i,
  /\bon-?site (?:role|position)\b/i,
  /\bon-?site presence (?:is )?required\b/i,
  /\b(?:role|position|job) is (?:an? )?on-?site\b/i,
  /\b(?:work|working|based) (?:on-?site|in[- ]office)\b/i,
  /\brelocat(?:e|ion) (?:is )?required\b/i,
];
/** "must be located/based in|near <city or our office>": an office requirement (a country is not). */
const MUST_BE_NEAR = /\bmust be (?:located|based) (?:in|near|close to|within commuting distance of) ([^.;\n]{0,60})/gi;
const officeRequirement = (s: string): boolean =>
  [...s.matchAll(MUST_BE_NEAR)].some((m) => citiesIn(m[1] ?? '').length > 0 || /\boffices?\b/i.test(m[1] ?? ''));

/** The country forms of the US match only as written in capitals ("Contact us only" is not the US). */
const US_FORMS: ReadonlySet<string> = new Set(['US', 'USA', 'U.S.', 'U.S.A.']);
const countryToken = (t: string): boolean => (/^(?:us|usa|u\.s\.(?:a\.)?)$/i.test(t) ? US_FORMS.has(t) : true);
const US = 'us|usa|u\\.s\\.(?:a\\.)?|united states';
const END = '(?![\\p{L}\\p{N}])';
/** Each rule: its id, and patterns whose group 1 is the country token (checked by `countryToken`). */
const EXCLUSION_RULES: readonly (readonly [string, readonly RegExp[]])[] = [
  ['us-only', [new RegExp(`(?<![\\p{L}\\p{N}])(${US})[\\s-]only\\b`, 'giu'), new RegExp(`(?<![\\p{L}\\p{N}])(${US}) residents only\\b`, 'giu')]],
  [
    'must-reside',
    [
      // Only sentences about the candidate (fix round 3, C-R1): "based in the US", "within the US" or "US-based team"
      // describe the employer or colleagues and are not exclusions.
      new RegExp(`\\bmust (?:be|reside|live) (?:located |based )?in the (${US}|uk|eu)${END}`, 'giu'),
      new RegExp(
        `\\b(?:you|candidates?|applicants?)\\b[^.]{0,40}?\\b(?:must|should|need to|needs to|required to|are required to|is required to) (?:be|reside|live) (?:located |based )?in the (${US}|uk|eu)${END}`,
        'giu',
      ),
      new RegExp(`\\bmust be (${US})-based${END}`, 'giu'),
      new RegExp(`(?<![\\p{L}\\p{N}])(${US})-based (?:candidates?|applicants?|residents?) only\\b`, 'giu'),
      new RegExp(`\\b(?:role|position|job) is (${US})-based${END}`, 'giu'),
      new RegExp(`(?<![\\p{L}\\p{N}])(${US})-based (?:role|position|job)\\b`, 'giu'),
    ],
  ],
  [
    'us-work-authorization',
    [new RegExp(`\\bauthori[sz]ed to work in the (${US})${END}`, 'giu'), new RegExp(`\\beligible to work in the (${US})${END}`, 'giu')],
  ],
  ['eu-only', [/\b(eu|europe)[\s-]only\b/gi]],
];
/** The sentence around a match: a phrase whose own sentence names India or a region with India is not an exclusion. */
const sentenceAt = (s: string, at: number, len: number): string => {
  const from = Math.max(0, ...[...s.slice(0, at).matchAll(/[.!?;\n]/g)].map((m) => (m.index ?? -1) + 1));
  const rest = s.slice(at + len).search(/[!?;\n]|\.(?=\s|$)/);
  return s.slice(from, rest < 0 ? s.length : at + len + rest);
};
function exclusionRule(s: string): string | undefined {
  for (const [id, patterns] of EXCLUSION_RULES) {
    for (const re of patterns) {
      for (const m of s.matchAll(re)) {
        if (!countryToken(m[1] ?? '')) continue;
        if (indiaInScope(countriesIn(sentenceAt(s, m.index ?? 0, m[0].length)))) continue;
        return id;
      }
    }
  }
  return undefined;
}
/** Regions that include India (decision 1: asia and south asia, like apac). */
const INDIA_REGIONS: ReadonlySet<string> = new Set(['apac', 'asia', 'south asia', 'worldwide']);
const REMOTE_WORD = /\bremote\b/i;
const STRUCTURED_REMOTE_SIGNAL = /^(?:isRemote:true|workplaceType:remote|jobLocationType:telecommute|feed:remote-only)$/i;

function watchEntry(p: Posting, pack: EligibilityPack): EligibilityPack['watchlist'][number] | undefined {
  if (p.ats === 'feed') {
    const name = p.company.trim().toLowerCase();
    return pack.watchlist.find((w) => w.company.trim().toLowerCase() === name);
  }
  return pack.watchlist.find((w) => w.ats === p.ats && w.slug === p.slug);
}

const indiaInScope = (countries: readonly string[]): boolean => countries.some((c) => c === 'india' || INDIA_REGIONS.has(c));

/** The remote decision table: a reject reason, `review`, or null for eligible. */
function remoteDecision(p: Posting, pack: EligibilityPack): string | 'review' | null {
  const { structured, countries, signals } = p.remote;
  if (structured === 'onsite') return 'onsite';
  if (structured === 'hybrid') return 'hybrid';
  const where = withoutAlternatives(`${p.title}\n${p.locationText}`);
  if (HYBRID_WORD.test(where)) return 'hybrid';
  if (ONSITE_WORD.test(where)) return 'onsite';
  const jd = withoutAlternatives(p.descriptionText.slice(0, HEAD));
  if (HYBRID_PHRASES.some((re) => re.test(jd))) return 'hybrid';
  if (ONSITE_PHRASES.some((re) => re.test(jd)) || officeRequirement(jd)) return 'onsite';

  if (signals.includes('location:excludes:india')) return 'remote-excludes-india:location';
  const head = [p.title, p.locationText, p.descriptionText.slice(0, HEAD)].join('\n');
  const rule = exclusionRule(head);
  if (rule !== undefined) {
    // The posting's own India scope wins over a JD phrase (fix round 3, C-R1): a remote location naming India (or a
    // region with India) can only go to review on a description phrase, never be rejected.
    const ownIndiaScope = (structured === 'remote' || REMOTE_WORD.test(p.locationText)) && (indiaInScope(countries) || /\bindia\b/i.test(p.locationText));
    return ownIndiaScope ? 'review' : `remote-excludes-india:${rule}`;
  }
  // Remote, but only in foreign countries; checked before allRemote and hiresInIndia (#5, I3). A description that
  // names India or a region with India makes it unclear rather than excluded.
  if ((structured === 'remote' || REMOTE_WORD.test(p.locationText)) && countries.length > 0 && !indiaInScope(countries)) {
    return indiaInScope(countriesIn(p.descriptionText)) ? 'review' : 'remote-excludes-india:country-list';
  }

  const entry = watchEntry(p, pack);
  const remoteStated = structured === 'remote' || signals.includes('location:remote') || signals.includes('title:remote') || REMOTE_WORD.test(p.locationText) || REMOTE_WORD.test(p.title);
  if (countries.includes('india') && remoteStated) return null;
  if (entry?.allRemote === true) return null;
  if (structured === 'remote' && (countries.length === 0 || countries.some((c) => INDIA_REGIONS.has(c))) && entry?.hiresInIndia === true) return null;
  if (REMOTE_WORD.test(p.locationText) && /india/i.test(p.locationText)) return null;

  const anythingRemote = remoteStated || signals.some((s) => STRUCTURED_REMOTE_SIGNAL.test(s) || s.endsWith(':remote')) || REMOTE_WORD.test(p.descriptionText);
  return anythingRemote ? 'review' : 'onsite';
}

/**
 * The pay check: a reject reason, or the note to add (null when there is nothing to say).
 *
 * Fix round 2: a stated maximum below the floor rejects whatever the basis. A total-type figure (CTC, total comp, OTE,
 * a package, "compensation") is always at least the base inside it, so when its maximum is below the floor, the base
 * is too, and rejecting is sound. Pay components (variable, bonus, equity alone, allowances) never reach this point:
 * the normalizer skips them. A kept posting with an unknown basis gets the note `pay basis unclear`.
 */
function compDecision(p: Posting, pack: EligibilityPack): { reject: string } | { note: string | null } {
  const c = p.comp;
  if (c === null) return { note: NOTE_PAY_UNDISCLOSED };
  const floor = pack.offers.floor;
  if (floor !== null && c.max !== null) {
    const inr = toInrPerYear({ min: c.min ?? c.max, max: c.max, currency: c.currency, period: 'year' }, pack.fx);
    if (belowFloor(inr, floor, pack.fx)) return { reject: `below-floor:${inr.max}` };
  }
  return { note: c.basis === 'base' ? null : NOTE_PAY_BASIS };
}

/** The verdict for one posting under the pack's rules. Pure. It trusts `pack` to be well formed: the agent validates it first (a malformed pack here throws a TypeError, not a KernelError). */
export function decideEligibility(p: Posting, pack: EligibilityPack): Decision {
  if (p.title.trim() === '' || p.url.trim() === '') return reject('closed');
  // A blank pattern would match every title: it matches nothing instead (blank deny words likewise, in `hasTerm`).
  const role = pack.filters.roleDeny.find((pattern) => pattern.trim() !== '' && compileSafePattern(pattern).test(p.title));
  if (role !== undefined) return reject(`role:${role}`);
  const company = pack.filters.companyDeny.find((name) => hasTerm(p.company, name));
  if (company !== undefined) return reject(`company:${company}`);
  const employment = employmentReason(p, pack);
  if (employment !== null) return reject(employment);

  const remote = remoteDecision(p, pack);
  const reasons: string[] = [];
  const notes: string[] = [];
  if (remote === 'review') {
    reasons.push('remote-unclear');
    notes.push(NOTE_REMOTE_UNCLEAR);
  } else if (remote !== null) {
    return reject(remote);
  }

  const pay = compDecision(p, pack);
  if ('reject' in pay) return reject(pay.reject);
  if (pay.note !== null) notes.push(pay.note);
  return { verdict: remote === 'review' ? 'review' : 'eligible', reasons, notes };
}

/** The pack view, or a loud failure: without the pack there are no rules, so nothing may pass. */
function packOf(pack: unknown): EligibilityPack {
  const view = PackView.safeParse(pack);
  if (!view.success) throw new KernelError('invalid_output', 'eligibility: the pack is missing or lacks filters, eligibility, watchlist, offers or fx');
  return view.data;
}

export const eligibilityContract = defineContract({
  id: 'eligibility',
  version: '1.0.0',
  description: 'Decides whether one posting is open to the candidate',
  skills: ['eligibility-rules'],
  team: 'evaluation',
  kind: 'deterministic',
  consumes: Posting,
  produces: EligibilityVerdict,
  capabilities: { pack: true },
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
});

export const eligibility = defineAgent(eligibilityContract, async (posting, ctx) => [{ posting, ...decideEligibility(posting, packOf(ctx.pack)) }]);
