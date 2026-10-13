import { z } from 'zod';
import { defineAgent } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { KernelError } from '../../kernel/errors.js';
import { belowFloor, toInrPerYear } from '../comp/floor.js';
import { hasTerm } from '../lexicon.js';
import { compileSafePattern } from '../pack/regex.js';
import { citiesIn, cityKey, countriesIn, excludedParts, excludedPlaces, officeCity } from '../text/norm.js';
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
 *    temporary, intern, freelance). A bare deny word is not an employment phrase, and (final fix I7) a phrase counts
 *    only when it describes this role ("this is a contract role", "freelance basis", "hourly rate of $40", "this
 *    internship"); a word about the employer's product or customers never does. "internship" counts in the title.
 *    Re-review R9: "on" counts only before "basis" ("work on contract engagement workflows" is product text), and a
 *    product noun after the phrase ("a temporary staffing product", "a contract management platform") voids it.
 *    Freelance spec D2: when the only reason would be `employment:contract` (the only canonical kind is contract: a
 *    structured Contract/Contractor, a "Contract"/"Contractor" title word, or a contract phrase) and the posting is a
 *    full-time B2B contractor role (`fullTimeContract`), it passes with the note `B2B contractor: no PF/benefits`. Every
 *    other kind (temporary, intern, part-time, hourly, freelance, contract-to-hire, c2h) still rejects, and rules 5 and 6
 *    then apply unchanged.
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
 *    b1. final fix L2: working hours limited to time zones that exclude UTC+5:30 → `timezone-excludes-india`
 *       (`timezoneExcludesIndia`); overlap, flexibility, preferences, descriptions of the team and APAC time zones
 *       never count, and a range counts only with restrictive wording. Re-review R2: when the posting names India (or
 *       IST) it is `review` with the note `time zone may exclude India - verify`, never rejected.
 *    b2. final fix L1: any other posting whose countries are non-empty and name none of india, apac, asia, south asia,
 *       worldwide → `location-outside-india`, whatever remote words it has. Guard (re-review R1): when something says
 *       remote and the description names India, apac, asia or south asia (or a sentence saying remote also says
 *       worldwide/anywhere) → `review`. "Global" or "worldwide" in prose never counts, and nothing remote never reviews.
 *    c. eligible when: India is a country and something structured or the location or title says remote; or the
 *       watchlist entry is all-remote; or structured remote, the countries name apac, asia, south asia or worldwide,
 *       and the watchlist says hiresInIndia; or the location says remote and India. Remote with no country, region or
 *       worldwide stated is never eligible on hiresInIndia alone (final fix I6): it is review.
 *    d. otherwise, when anything says remote (structured, a signal, or the word in the title, location or
 *       description) → `review` with `remote-unclear` and the note `remote scope unclear - verify`; else `onsite`.
 *    The watchlist entry is found by (ats, slug), or by company name for a feed.
 *    e. office cities (`officeCityNote`): when the decision is `onsite` or `hybrid` and the pack lists
 *       `eligibility.officeCities`, a posting located in one of them passes, with the note `office/hybrid: <City>`
 *       (`officeNote`). Each key resolves through the office-city alias table (`officeCity`; an unknown key matches only itself), matched on
 *       word boundaries, case-insensitively, in a segment of the location text (split on `; | / &`, "or", "and", new
 *       lines) whose places are none or include India, or in an entry of the structured countries. When the location
 *       field is generic ("In-Office", "Hybrid", "India", "N/A", empty), the value of an explicit label line in the
 *       first 3000 characters of the description ("Location: Bengaluru") stands in for it, for this match only. Any
 *       other city named only in the description never counts. It needs nothing to exclude India: countries naming none of India or an office
 *       city, a `location:excludes:india` signal, India or the city excluded in the location, an exclusion phrase
 *       (rule b) or a time-zone restriction (b1). A relocation, "must be located/based in" or "work(ing) from / based
 *       in|at / report(ing) to our <City> office" sentence in the first 1500 characters naming another city keeps the
 *       reject. Rule 6 then applies unchanged.
 * 6. comp: only a `base` basis with a stated maximum is judged: its maximum in INR (`toInrPerYear`) below
 *    `offers.floor` → `below-floor:<maxInr>`. No comp adds the note `pay not disclosed`; an unknown basis adds
 *    `pay basis unclear` and is never rejected on pay; "from X" (no maximum) is never below the floor.
 * 7. experience is not checked here: the scorer applies the years penalty.
 */

const HEAD = 1500;
export const NOTE_PAY_UNDISCLOSED = 'pay not disclosed';
export const NOTE_PAY_BASIS = 'pay basis unclear';
export const NOTE_REMOTE_UNCLEAR = 'remote scope unclear - verify';
export const NOTE_TIMEZONE = 'time zone may exclude India - verify';
export const NOTE_B2B = 'B2B contractor: no PF/benefits';
export const NOTE_OFFICE_PREFIX = 'office/hybrid: ';
/** The note for an onsite or hybrid role in an office city: `office/hybrid: Pune`. */
export const officeNote = (display: string): string => `${NOTE_OFFICE_PREFIX}${display}`;

/** The parts of the pack this agent reads; anything else in it is ignored. */
const PackView = z.object({
  // `filters.employmentDeny` are the words that reject when bare in the title (fix round 2); the description uses the
  // fixed EMPLOYMENT_PHRASES instead, because bare words there are mostly not about employment (fix round 1, I1).
  filters: z.object({ roleDeny: z.array(z.string()), companyDeny: z.array(z.string()), employmentDeny: z.array(z.string()) }),
  eligibility: z.object({ employmentTypes: z.array(z.string()), officeCities: z.array(z.string()).optional() }),
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
/** A money figure: a currency sign or code before digits. */
const MONEY = '(?:[$€£₹]|\\b(?:usd|inr|eur|gbp|rs\\.?)\\s*)\\s*\\d[\\d,]*(?:\\.\\d+)?';
/** A duration before the employment word: "6-month", "12 month", "short-term". */
const TERM = '(?:\\d+[\\s-]months?[\\s-]|(?:short|long)[\\s-]term\\s+)?';
const KIND = '(contract|freelance|hourly|temporary)';
/** Nouns that name the role itself: a phrase ending in one describes the job ("a contract data engineering role"). */
const ROLE_NOUN =
  '(?:roles?|positions?|jobs?|engineers?|developers?|opportunit(?:y|ies)|hires?|contractors?|consultants?|analysts?|architects?|scientists?|specialists?|assignments?|gigs?|openings?|vacanc(?:y|ies))';
/**
 * Re-review R9: a product noun right after the phrase makes it product text ("the engagement is a temporary staffing
 * product", "this is a contract management platform", "join as freelance contractor agencies").
 * Re-review-2 M4: only as a noun compound. When a role noun follows within two more words ("a contract data
 * engineering role", "a contract software developer hire"), the phrase describes the role and still counts.
 */
const NOT_PRODUCT =
  `(?![\\s-]+(?:staffing|management|lifecycle|workflows?|agenc(?:y|ies)|platforms?|products?|tools?|software|marketplaces?|solutions?|services?|systems?|onboarding|data|analytics|billing|tracking)\\b(?![\\s-]+(?:(?!(?:for|of|to|with|that|which|and|or|the|a|an|in|on|at|by)\\b)[a-z]+[\\s-]+){0,2}${ROLE_NOUN}\\b))`;
/**
 * Employment phrases, in order. Final fix I7: a phrase counts only when it describes this role ("this is a contract
 * role", "the position is a temporary engagement", "you will be hired on a contract basis", "freelance basis", "hourly
 * rate of $40", "we pay $60 per hour", "this internship"). A word about the employer's product or customers ("the
 * world's largest freelance marketplace", "we run internships", "each worker's hourly rate", "customers pay $15 per
 * hour for GPUs", "every contract position and clause", "fill temporary roles") never rejects. Group 1, when present,
 * names the kind; else the entry's own label is the reason.
 */
const EMPLOYMENT_PHRASES: readonly (readonly [string, RegExp])[] = [
  ['contract-to-hire', /\bcontract[\s-]to[\s-]hire\b/i],
  ['c2h', /\bc2h\b/i],
  ['', new RegExp(`\\bthis is (?:a|an) ${TERM}${KIND}\\b${NOT_PRODUCT}`, 'i')],
  ['', new RegExp(`\\b(?:role|position|job|engagement) is (?:on )?(?:a |an )?${TERM}${KIND}\\b${NOT_PRODUCT}`, 'i')],
  // Re-review R9: "on" only before "basis" ("hired on a contract basis"); "work on contract engagement workflows" is
  // product text. "as" takes the other nouns ("join as a freelance contractor").
  [
    '',
    new RegExp(
      `\\b(?:hired|engaged|employed|join|joining|work|working)\\b[^.;\\n]{0,30}?(?:\\bon (?:a |an )?(?=(?:contract|freelance) basis\\b)|\\bas (?:a |an )?)(contract|freelance) (?:basis|employee|contractor|engagement)\\b${NOT_PRODUCT}`,
      'i',
    ),
  ],
  ['contract', /\b\d+[\s-]months?[\s-]contract\b/i],
  ['freelance', /\bfreelance (?:role|position|contract|basis|engagement)s?\b/i],
  ['hourly', new RegExp(`\\bhourly rate(?:\\s+(?:of|is))?\\s*:?\\s*(?:up to\\s*)?${MONEY}`, 'i')],
  [
    'hourly',
    new RegExp(
      `\\b(?:we pay|we offer|you(?:'ll| will)? (?:earn|be paid|get|receive)|pay(?: rate)?\\s*(?:is|of|:)|rate\\s*(?:is|of|:)|compensation\\s*(?:is|of|:)|salary\\s*(?:is|of|:))\\s*(?:up to\\s*)?${MONEY}\\s*(?:\\/\\s*|per\\s+)(?:hour|hr)\\b`,
      'i',
    ),
  ],
  ['intern', /\bthis (?:is an )?internship\b/i],
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
    // fix round 4: the bracket holds just the word, optionally with "role" or "position" ("(Contract Role)")
    bracketed.some((b) => sameWords(b.replace(/\s+(?:role|position)\s*$/i, ''), w)) ||
    sameWords(last, w) ||
    new RegExp(`^\\s*${titleWordRe(w)}\\s+(?!(?:${DOMAIN_WORD})\\b)(?:[\\p{L}\\p{N}+#./]+\\s+){0,2}(?:${ROLE_WORD})\\b`, 'iu').test(t);
  return [...words].filter((w) => w.trim() !== '').sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).find(standalone);
}

/** Freelance spec D2: wording that says a contract role is a full-time B2B engagement. Case-insensitive. */
const B2B_FULL_TIME: readonly RegExp[] = [
  /\bcontract type:\s*b2b\b/i,
  /\bb2b (?:contract|agreement|contractor)\b/i,
  /\bfull[\s-]?time (?:contract|contractor|b2b)\b/i,
  /\b(?:contract|contractor)[,\s]+full[\s-]?time\b/i,
  /\blong[\s-]term (?:contract|contractor)\b/i,
];
/** Freelance spec D2: wording that keeps a contract role rejected. */
const SHORT_TERM: readonly RegExp[] = [
  /\b\d{1,2}[\s-]?(?:months?|weeks?)\b[^.\n]{0,20}\bcontract\b/i,
  /\bshort[\s-]term\b/i,
  /\bpart[\s-]?time\b/i,
  /\bper hour\b|\/\s?h(?:ou)?r\b|\bhourly\b/i,
  /\bduration:?\s*\d{1,2}\s*(?:months?|weeks?)\b/i,
  /\b\d{1,2}[\s-]?(?:months?|weeks?)\s+(?:project|engagement|assignment)\b/i,
  // under 30 hours a week is not full-time ("~15 hrs a week")
  /\b(?:[1-9]|[12]\d)\s*(?:hrs?|hours?)\s*(?:a|per|\/)\s*week\b/i,
];
/** One window for the trigger and for the other-kind scan: a blocking phrase anywhere the trigger can see must block. */
const B2B_HEAD = 3000;
const INTERN_TITLE = /\binterns?(?:hips?)?\b/i;

/**
 * Freelance spec D2: a full-time B2B contractor role. True when the title or the first 3,000 characters of the
 * description carry full-time B2B wording, or an annual base salary is stated; false whenever short-term, part-time or
 * hourly wording is there.
 */
export function fullTimeContract(p: Posting): boolean {
  const text = `${p.title}\n${p.descriptionText.slice(0, B2B_HEAD)}`;
  if (SHORT_TERM.some((re) => re.test(text))) return false;
  return B2B_FULL_TIME.some((re) => re.test(text)) || (p.comp !== null && p.comp.basis === 'base');
}

/** True when `contract` is the only employment kind the posting states anywhere the rules look. */
function onlyContractKind(p: Posting): boolean {
  const known = (p.employmentType ?? '').split(/[,;/|]/).map((s) => canonicalEmployment(s.trim())).filter((c): c is string => c !== null);
  if (known.some((c) => c !== 'contract')) return false;
  if (INTERN_TITLE.test(p.title)) return false;
  const text = [p.employmentType ?? '', p.title, p.descriptionText.slice(0, B2B_HEAD)].join('\n');
  return EMPLOYMENT_PHRASES.every(([label, re]) => {
    const m = re.exec(text);
    return m === null || (label !== '' ? label : (m[1] ?? '').toLowerCase()) === 'contract';
  });
}

function employmentReason(p: Posting, pack: EligibilityPack): { reason: string | null; b2b: boolean } {
  const reason = rawEmploymentReason(p, pack);
  const kind = reason?.startsWith('employment:') === true ? canonicalEmployment(reason.slice('employment:'.length)) : null;
  if (kind === 'contract' && onlyContractKind(p) && fullTimeContract(p)) return { reason: null, b2b: true };
  return { reason, b2b: false };
}

function rawEmploymentReason(p: Posting, pack: EligibilityPack): string | null {
  // A bare contract word in the title is the posting's own label; it wins over a structured type (fix round 2).
  const titleWord = titleDenyWord(p.title, pack.filters.employmentDeny);
  if (titleWord !== undefined) return `employment:${titleWord}`;
  const parts = (p.employmentType ?? '').split(/[,;/|]/).map((s) => s.trim()).filter((s) => s !== '');
  const known = parts.map(canonicalEmployment).filter((c): c is string => c !== null);
  if (known.some((c) => pack.eligibility.employmentTypes.includes(c))) return null;
  if (known.length > 0) return `employment:${known[0]}`;
  const text = [p.employmentType ?? '', p.title, p.descriptionText.slice(0, HEAD)].join('\n');
  if (FULL_TIME_TEXT.test(text)) return null;
  if (INTERN_TITLE.test(p.title)) return 'employment:intern';
  for (const [label, re] of EMPLOYMENT_PHRASES) {
    const m = re.exec(text);
    if (m !== null) return `employment:${label !== '' ? label : (m[1] ?? '').toLowerCase()}`;
  }
  return null;
}

/** "not hybrid", "no office", "remote or hybrid", "onsite/remote": negations and alternatives never reject. */
const NEGATED_OR_ALTERNATIVE =
  /\b(?:not|no|non)[\s-]+(?:an?\s+)?(?:hybrid|on-?site|in[- ]office|office)\b|\bremote\s*(?:\/|\bor\b|\band\/or\b)\s*(?:hybrid|on-?site|in[- ]office)\b|\b(?:hybrid|on-?site|in[- ]office)\s*(?:\/|\bor\b|\band\/or\b)\s*remote\b/gi;
/**
 * Fix round 4: "no need", "no requirement", "not required", "never", "without" negate the rest of their clause; a
 * clause that ends in "is/are not required" is negated whole.
 */
const NEGATED_CLAUSE = /\b(?:no need|no requirement|not required|never|without)\b[^.;\n]*|[^.;\n]*\b(?:is|are)\s+not\s+required\b/gi;
const withoutAlternatives = (s: string): string => s.replace(NEGATED_CLAUSE, ' ').replace(NEGATED_OR_ALTERNATIVE, ' ');
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
/**
 * Final fix L2 (LIVE RUN 1): working hours limited to time zones that exclude India (UTC+5:30).
 * - "(European|EU|US|American|Americas|EMEA|CET|EST|PST|Pacific|Eastern) time zone(s) only";
 * - "must work in|within (the) (US|EU|…) (business|working) hours";
 * - an explicit "UTC±a to UTC±b" (or "between GMT±a and GMT±b") range, or a "UTC±a ± n hours" span, that does not
 *   contain +5:30.
 * A clause that speaks of overlap, flexibility or a preference never counts ("some overlap with US hours", "flexible
 * hours", "the preferred timezone is GMT-4 to GMT+2"), nor does a negated one; APAC or Asia time zones are not in the
 * list. Unicode minus and dashes count as a minus sign.
 *
 * Re-review R2: a range or span counts only in a sentence with restrictive wording (only, must, required, need to
 * be/work, "candidates in|from …"); a description of where the team sits ("our team spans GMT to GMT+3", "we sit in
 * UTC-5 and UTC+1") never does, and "X and Y" is a range only after "between". "Candidates in|from <zone> time zones"
 * is a restriction of its own. A posting that names India never reaches a reject here (`postingNamesIndia`).
 */
const TZ_ZONE = '(?:european|eu|us|usa|u\\.s\\.|american|americas|emea|cet|est|pst|pacific|eastern|uk|gmt|central european)';
const TZ_ONLY = new RegExp(`\\b${TZ_ZONE}\\s+time\\s?zones?\\s+only\\b`, 'i');
const TZ_MUST_WORK = new RegExp(`\\bmust work (?:in|within) (?:the )?${TZ_ZONE}(?:\\s+(?:business|working|office))? hours\\b`, 'i');
const TZ_CANDIDATES = new RegExp(`\\b(?:candidates?|applicants?)\\s+(?:located\\s+|based\\s+)?(?:in|from|within)\\s+(?:the\\s+)?(?:${TZ_ZONE}\\s+)*${TZ_ZONE}\\s+time\\s?zones?\\b`, 'i');
const OFFSET = '(?:\\s*([+-])\\s*(\\d{1,2})(?::?(\\d{2}))?)?';
const TZ_RANGE = new RegExp(`\\b(between\\s+)?(?:utc|gmt)${OFFSET}\\s*(to|-|and)\\s*(?:utc|gmt)${OFFSET}(?![\\d:])`, 'gi');
const TZ_SPAN = new RegExp(`\\b(?:utc|gmt)${OFFSET}\\s*(?:±|\\+\\s*\\/\\s*-|\\+-|plus or minus)\\s*(\\d{1,2})\\s*h(?:ou)?rs?\\b`, 'gi');
const TZ_SOFT = /\b(?:overlap\w*|flexib\w*|prefer\w*)\b/i;
const TZ_STRICT =
  /\b(?:only|must|required|requirement|mandatory|needs?\s+to\s+(?:be|work|live|reside)|(?:candidates?|applicants?)\s+(?:located\s+|based\s+)?(?:in|from|within))\b/i;
const IST = 5.5;
const offsetOf = (sign: string | undefined, h: string | undefined, m: string | undefined): number =>
  sign === undefined ? 0 : (sign === '-' ? -1 : 1) * (Number(h) + Number(m ?? '0') / 60);

function timezoneExcludesIndia(head: string): boolean {
  // Unicode minus, hyphen and dashes as an ASCII minus, so "UTC−1" reads as UTC-1.
  const s = withoutAlternatives(head.replace(/[−‐‑–—]/g, '-'));
  const counts = (at: number, len: number): boolean => !TZ_SOFT.test(sentenceAt(s, at, len));
  const strict = (at: number, len: number): boolean => TZ_STRICT.test(sentenceAt(s, at, len)) && counts(at, len);
  for (const re of [TZ_ONLY, TZ_MUST_WORK, TZ_CANDIDATES]) {
    for (const m of s.matchAll(new RegExp(re.source, 'gi'))) if (counts(m.index ?? 0, m[0].length)) return true;
  }
  for (const m of s.matchAll(TZ_RANGE)) {
    if (m[5]?.toLowerCase() === 'and' && m[1] === undefined) continue;
    const a = offsetOf(m[2], m[3], m[4]);
    const b = offsetOf(m[6], m[7], m[8]);
    if ((IST < Math.min(a, b) || IST > Math.max(a, b)) && strict(m.index ?? 0, m[0].length)) return true;
  }
  for (const m of s.matchAll(TZ_SPAN)) {
    const a = offsetOf(m[1], m[2], m[3]);
    const n = Number(m[4]);
    if ((IST < a - n || IST > a + n) && strict(m.index ?? 0, m[0].length)) return true;
  }
  return false;
}

/**
 * Re-review R2: the posting names India as a place or time zone: India or a named region with it (apac, asia, south
 * asia; not `worldwide`) among the countries or in the title, location or head, "India" in the title or location, or
 * IST / UTC+5:30 in the head. Such a posting is never rejected on time zones; a restriction sends it to review.
 */
function postingNamesIndia(p: Posting, head: string): boolean {
  if (namesIndiaRegion(p.remote.countries) || /\bindia\b/i.test(`${p.title}\n${p.locationText}`)) return true;
  if (namesIndiaRegion(countriesIn(head))) return true;
  return /\bIST\b/.test(head) || /\b(?:utc|gmt)\s*\+\s*0?5:?30\b/i.test(head);
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
/** India or a named region with India (apac, asia, south asia); `worldwide` is not one ("global", "anywhere" are prose). */
const namesIndiaRegion = (countries: readonly string[]): boolean => countries.some((c) => c !== 'worldwide' && indiaInScope([c]));

/**
 * Re-review R1: the description names India or a region with India as a place, or a sentence that says remote also
 * says worldwide ("fully remote: work from anywhere in the world"). "A global leader", "customers worldwide" do not.
 */
function descriptionNamesIndiaScope(description: string): boolean {
  if (namesIndiaRegion(countriesIn(description))) return true;
  return description.split(/[.!?;\n]+/).some((s) => REMOTE_ANYWHERE.test(s) && countriesIn(s).includes('worldwide'));
}
/** "remote … anywhere", "work from anywhere", "worldwide, remote": the worldwide word is about the remote work itself, close to it. */
const REMOTE_ANYWHERE =
  /\bremote(?:ly)?\b[^.;\n]{0,40}\b(?:anywhere|worldwide|globally|global)\b|\b(?:anywhere|worldwide|globally|global)\b[^.;\n]{0,15}\bremote\b|\bwork (?:from )?anywhere\b/i;

/** The remote decision table: a reject reason, `review`, or null for eligible. */
function remoteDecision(p: Posting, pack: EligibilityPack): string | 'review' | 'review-timezone' | null {
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
    // Fix round 4: India in the countries also counts when the description says remote (remote-first, fully remote),
    // even if the location ("Bengaluru, India") does not. Documented: "Remote - Worldwide" is a scope with India too,
    // so it also goes to review on a JD phrase.
    const ownIndiaScope =
      ((structured === 'remote' || REMOTE_WORD.test(p.locationText)) && (indiaInScope(countries) || /\bindia\b/i.test(p.locationText))) ||
      (countries.includes('india') && REMOTE_WORD.test(p.descriptionText));
    return ownIndiaScope ? 'review' : `remote-excludes-india:${rule}`;
  }
  if (timezoneExcludesIndia(head)) return postingNamesIndia(p, head) ? 'review-timezone' : 'timezone-excludes-india';
  // Remote, but only in foreign countries; checked before allRemote and hiresInIndia (#5, I3). A description that
  // names India or a region with India makes it unclear rather than excluded.
  if ((structured === 'remote' || REMOTE_WORD.test(p.locationText)) && countries.length > 0 && !indiaInScope(countries)) {
    return indiaInScope(countriesIn(p.descriptionText)) ? 'review' : 'remote-excludes-india:country-list';
  }
  const remoteStated = structured === 'remote' || signals.includes('location:remote') || signals.includes('title:remote') || REMOTE_WORD.test(p.locationText) || REMOTE_WORD.test(p.title);
  const anythingRemote = remoteStated || signals.some((s) => STRUCTURED_REMOTE_SIGNAL.test(s) || s.endsWith(':remote')) || REMOTE_WORD.test(p.descriptionText);
  // Final fix L1 (LIVE RUN 1): the posting names places and none is India or a region with India, whether or not
  // anything says remote ("UK; Lithuania; Bulgaria; Serbia", "Redwood City, US; New York, US" with a remote-friendly
  // JD). Re-review R1: the guard (review instead) needs something that says remote AND a description that names India
  // or a region with India; "global", "worldwide" or "anywhere" count only inside a sentence that says remote ("a
  // global leader", "customers worldwide" are prose). With nothing remote it is outside India whatever the JD names.
  if (countries.length > 0 && !indiaInScope(countries)) {
    return anythingRemote && descriptionNamesIndiaScope(`${p.title}\n${p.descriptionText}`) ? 'review' : 'location-outside-india';
  }

  const entry = watchEntry(p, pack);
  if (countries.includes('india') && remoteStated) return null;
  if (entry?.allRemote === true) return null;
  // Final fix I6: hiresInIndia upgrades only a stated region with India (apac, asia, south asia, worldwide). Remote with
  // no country, region or worldwide at all is unclear (a US-only role often states none) and goes to review below.
  if (structured === 'remote' && countries.some((c) => INDIA_REGIONS.has(c)) && entry?.hiresInIndia === true) return null;
  if (REMOTE_WORD.test(p.locationText) && /india/i.test(p.locationText)) return null;

  return anythingRemote ? 'review' : 'onsite';
}

/** Indian states: a relocation sentence naming one ("Pune, Maharashtra") names no other city. */
const INDIAN_STATES: ReadonlySet<string> = new Set(['karnataka', 'maharashtra', 'telangana', 'tamil nadu', 'kerala', 'haryana', 'uttar pradesh', 'west bengal', 'gujarat']);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namesAlias = (text: string, aliases: readonly string[]): boolean =>
  aliases.some((a) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(a).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu').test(text));
/** Location segments: separate locations are joined by these ("Pune, India; Remote US", "Pune or Singapore"). */
const LOCATION_SPLIT = /[;|\n/&]|\bor\b|\band\b/i;
/** Sentences that require living in or moving to a place, or working from a named office. */
const RELOCATION = /\brelocat\w*\b|\bmust be (?:located|based)\b|\b(?:work(?:ing)? from|based (?:in|at)|report(?:ing)? to) our [^.;\n]{1,40}?\boffice\b/i;
/** A location field that names no place of its own ("In-Office", "Hybrid", "India", "N/A"), or an empty one. */
const GENERIC_LOCATION = /^(?:in[- ]office|on[- ]?site|onsite|hybrid|office|india|in|n\/a|na|multiple locations?|various)$/i;
/**
 * An explicit location label line in the description ("Location: Bengaluru", "Office - Bangalore", "Work location:
 * Pune"), also "Available Locations: …", "Job location …" and "Office location — …" (a plural label, an em dash).
 */
const LOCATION_LABEL = /^\s*(?:(?:available|office|work|job)\s+)?(?:locations?|office|based in)\s*[:\-–—]\s*(.+)$/im;
const LABEL_HEAD = 3000;
/**
 * The location text the office-city match reads: the field itself, or, when the field is generic, the value of the
 * first label line in the first 3000 characters of the description. Never used for the remote decision.
 */
function officeLocationText(p: Posting): string {
  const field = p.locationText.trim();
  if (field !== '' && !GENERIC_LOCATION.test(field)) return p.locationText;
  return LOCATION_LABEL.exec(p.descriptionText.slice(0, LABEL_HEAD))?.[1]?.trim() ?? p.locationText;
}

/**
 * Rule 5e: the office-city note for an onsite or hybrid posting located in one of the pack's office cities, or null.
 * See the header for what counts and what keeps the reject.
 */
function officeCityNote(p: Posting, pack: EligibilityPack): string | null {
  const cities = (pack.eligibility.officeCities ?? []).map(officeCity);
  if (cities.length === 0) return null;
  const { countries, signals } = p.remote;
  const allAliases = new Set(cities.flatMap((c) => c.aliases));
  const head = [p.title, p.locationText, p.descriptionText.slice(0, HEAD)].join('\n');
  // Nothing may exclude India.
  if (signals.includes('location:excludes:india') || excludedPlaces(p.locationText).includes('india')) return null;
  if (countries.length > 0 && !countries.includes('india') && !countries.some((c) => allAliases.has(cityKey(c)))) return null;
  if (exclusionRule(head) !== undefined || timezoneExcludesIndia(head)) return null;
  // A relocation or residence requirement naming another city keeps the reject.
  const jd = p.descriptionText.slice(0, HEAD);
  for (const sentence of jd.split(/[.!?;\n]+/)) {
    if (!RELOCATION.test(sentence)) continue;
    const named = citiesIn(sentence).filter((c) => !INDIAN_STATES.has(c));
    if (named.some((c) => !namesAlias(c, [...allAliases]))) return null;
  }
  const where = officeLocationText(p);
  if (excludedPlaces(where).includes('india')) return null;
  const excluded = excludedParts(where);
  const segments = where.split(LOCATION_SPLIT).filter((seg) => {
    const places = countriesIn(seg);
    return places.length === 0 || places.includes('india');
  });
  for (const city of cities) {
    if (city.aliases.some((a) => excluded.includes(a))) continue;
    if (segments.some((seg) => namesAlias(seg, city.aliases)) || countries.some((c) => namesAlias(c, city.aliases))) return officeNote(city.display);
  }
  return null;
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
  if (employment.reason !== null) return reject(employment.reason);

  const decided = remoteDecision(p, pack);
  const office = decided === 'onsite' || decided === 'hybrid' ? officeCityNote(p, pack) : null;
  const remote = office !== null ? null : decided;
  const reasons: string[] = [];
  const notes: string[] = employment.b2b ? [NOTE_B2B] : [];
  if (office !== null) notes.push(office);
  const review = remote === 'review' || remote === 'review-timezone';
  if (review) {
    reasons.push('remote-unclear');
    notes.push(NOTE_REMOTE_UNCLEAR);
    if (remote === 'review-timezone') notes.push(NOTE_TIMEZONE);
  } else if (remote !== null) {
    return reject(remote);
  }

  const pay = compDecision(p, pack);
  if ('reject' in pay) return reject(pay.reject);
  if (pay.note !== null) notes.push(pay.note);
  return { verdict: review ? 'review' : 'eligible', reasons, notes };
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
