import { z } from 'zod';
import { defineAgent } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { KernelError } from '../../kernel/errors.js';
import { hasTerm } from '../lexicon.js';
import { compileSafePattern } from '../pack/regex.js';
import { forbiddenTermStrict } from '../pack/rules.js';
import { countriesIn } from '../text/norm.js';
import { HOURS_PER_WEEK } from './gig-normalizer.js';
import { GigVerdict, RatedGig, type Gig } from './types.js';

/**
 * Gig eligibility: the fixed checks, in order. The first reject wins; every rule also adds its notes, and a rule that
 * cannot decide adds a `review` instead. The governing principle: a wrong reject silently hides a real opportunity, so
 * a reject needs literal, unambiguous text. Every text rule below is therefore an allow-list of confirming wording,
 * bound to its own clause; wording that merely might mean the same thing (a ceiling, a habit, an alternative, a
 * preference, a negation) is `review`, never `rejected`.
 *
 * 1. closed: a blank title or url.
 * 2. role / company: `filters.companyDeny` against the client name (`hasTerm`) rejects as `company:<name>`. A
 *    `filters.roleDeny` match on the title (`compileSafePattern`) is only a review (`role-filter`, note `title matches
 *    your role filter: <pattern>`): the v1 list was written for job titles and misfires on gig titles.
 * 3. naming: the client name, title or description names a forbidden term (`forbiddenTermStrict`). Only the reason
 *    `naming` is ever shown.
 * 4. location-outside-india, from a stated place only:
 *    - `location.text` says "US only" and the like (ONLY), unless the gig is also worldwide (then review);
 *    - a non-worldwide gig whose countries name none of india, apac, asia, south asia, worldwide rejects only when the
 *      platform's own candidate-location field (`location.text`) is there, nothing in it is soft ("preferred",
 *      "welcome"), it names no India-like word ("Asia", "global") and every item of its list is a place we recognise.
 *      Countries picked from a post's first line (no `location.text`, hn) are review: the company's home is not a
 *      candidate restriction.
 *    - nothing stated is review (`location not stated - verify`). A description saying "US only", "must be based in
 *      the US" or "European time zones only" is a review note, never a reject.
 * 5. hours-over-cap, for kind `contract` (fixed-price kinds skip it):
 *    - a stated hours-per-week figure whose minimum is above `freelance.maxHoursPerWeek` rejects when its own clause
 *      confirms it as this engagement's requirement (a label such as "Commitment:", a `| 32-40h/week |` header field,
 *      or need/require/expect/must/you/looking for ...). A ceiling ("up to"), a negation, a habit ("typically",
 *      "our projects") or a figure with no cue is review;
 *    - no figure: "full-time" rejects only inside a shape that ties it to this engagement (FULL_TIME_SHAPES: "a
 *      full-time remote contract role", "full-time contractor", "Commitment: Full-time", "we need a full-time
 *      developer", a header field "| Full-Time", "Contract, full-time"), with no alternative, preference or negation
 *      in its clause. "We're a full-time remote team", "our full-time engineers", "hiring full-time employees" fit
 *      no shape and count for nothing; anything else is `hours not stated - verify`;
 *    - "dedicated" alone never rejects.
 *    - freelance-boost (the one approved rule change, user 2026-10-14): a Freelancer.com hourly contract with a
 *      `stated` rate whose `maxUsdH` (after FX) is at or above `rateFloorUsdHour`, with no per-week hours figure
 *      anywhere in its text (not even an ambiguous one) and no full-time wording tied to it, passes the hours rule with the note `hours not stated; you set them` (Freelancer
 *      bills the hours the freelancer logs). Stated full-time still rejects; a hedged full-time mention stays review.
 * 6. overlap-outside-ist-window: only a CLOSED requirement sentence on the candidate (see "closed requirement sentences"
 *    below): "You must be online 9am-5pm PST", "Must be available ...", "We need you to be online ...", "Working hours
 *    ... are required". Fixed offsets (EST -5, EDT -4, ET -4, CST -6, PST -8, PDT -7, PT -7, CET +1, CEST +2, GMT/UTC 0,
 *    BST +1, IST +5.5) put the window of at least 4 hours on IST; a bare "9-5" reads as 9am-5pm. It rejects when every
 *    such window shares less than 2 hours with `freelance.istWindow`. A window that is not closed (a hedge, another
 *    owner, a sync, "should") adds `overlap stated - verify` when it speaks to the candidate, and never rejects.
 * 7. exclusive: only a closed sentence ("You must not work for other clients during this contract", "Cannot work for other
 *    clients", "We need an exclusive contractor", "You will work exclusively for us", "No other clients while engaged").
 *    A narrowed prohibition (same industry, from our clients, using our data, on this codebase) is review with `restriction
 *    on other work - verify`; "exclusive rights", "non-exclusive" and "exclusively for Android" are not that.
 * 7b. licensed-professional: the title or a description clause asks for a licensed firm or professional (CPA, AICPA,
 *    an audit or law firm, a licensed attorney or auditor, a peer-reviewed firm) with a requirement cue ("only", "must",
 *    "need", "looking for"): review with `asks for a licensed firm or professional`, never a reject.
 * 8. budget-below-floor: kind `gig`, rate unknown, `budgetUsd` below `fixedBudgetFloorUsd`. A kind `gig` with a budget
 *    at or above the floor is eligible on that, with the rate left unknown. A fixed budget whose raw currency, minimum
 *    and maximum are exactly one of the platform's `platformRules.<platform>.presetBrackets` is no stated budget: it is
 *    review (`budget-preset`, note `preset bracket - bids may exceed it`), never rejected; at or above the floor
 *    (user decision 2026-10-13) it stays eligible with that note, so every surface labels it a preset tier. A fixed
 *    budget with a minimum and no maximum ("$300+ per post", sources-expansion) below the floor is review
 *    (`rate-unclear`, `budget is a minimum with no maximum - verify`), never a reject.
 * 8b. ceiling (freelance-boost): a `stated-ceiling` rate ("up to $X/hr") below the floor rejects as
 *    `rate-below-floor:<X>` (a hedge is review, as below); at or above it is review `ceiling-only` with the note
 *    `pay is a stated ceiling only (up to $X/h) - verify`: a ceiling never passes the floor on its own. A reject from
 *    another rule still wins.
 * 9. rate-below-floor:<maxUsdH>: `maxUsdH` below `rateFloorUsdHour`, for a `stated` rate, or for a derived one
 *    (`derivedRateCountsForFloor`; when false it is a note). A rate with no maximum cannot be below the floor. An
 *    unknown rate (contract, or a gig with no budget) is `rate unknown - verify`.
 */

const PresetTier = z.object({ type: z.enum(['fixed', 'hourly']), min: z.number(), max: z.number().nullable(), currencies: z.union([z.literal('*'), z.array(z.string())]) });
type Tier = z.infer<typeof PresetTier>;

const PackView = z.object({
  filters: z.object({ roleDeny: z.array(z.string()), companyDeny: z.array(z.string()) }),
  naming: z.object({ forbiddenTerms: z.array(z.string()) }),
  // Per platform, only the preset brackets are read.
  platformRules: z.record(z.string(), z.object({ presetBrackets: z.array(PresetTier).default([]) })).default({}),
  freelance: z.object({
    rateFloorUsdHour: z.number().nonnegative(),
    maxHoursPerWeek: z.number().positive(),
    istWindow: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/),
    derivedRateCountsForFloor: z.boolean(),
    fixedBudgetFloorUsd: z.number().nonnegative(),
  }),
});
export type GigPack = z.infer<typeof PackView>;

export interface GigDecision {
  verdict: GigVerdict['verdict'];
  reasons: string[];
  notes: string[];
}

/** What one rule says: a reject reason, a review reason (both optional), and notes. */
export interface Outcome {
  readonly reject: string | null;
  readonly review: string | null;
  readonly notes: readonly string[];
}
const PASS: Outcome = { reject: null, review: null, notes: [] };
const rejectOf = (reason: string, notes: readonly string[] = []): Outcome => ({ reject: reason, review: null, notes });
const reviewOf = (reason: string, note: string): Outcome => ({ reject: null, review: reason, notes: [note] });
const noteOf = (note: string): Outcome => ({ reject: null, review: null, notes: [note] });

export const NOTE_LOCATION_NOT_STATED = 'location not stated - verify';
export const NOTE_LOCATION_MAY_EXCLUDE = 'location may exclude India - verify';
export const NOTE_LOCATION_LIST = 'location list not fully understood - verify';
export const NOTE_LOCATION_TEXT = 'location restriction in text - verify';
export const NOTE_HOURS_UNKNOWN = 'hours not stated - verify';
export const NOTE_HOURS_UNCLEAR = 'hours stated without a clear requirement - verify';
export const NOTE_HOURS_CONFLICT = 'hours conflict - verify';
export const NOTE_OVERLAP = 'overlap stated - verify';
export const NOTE_OTHER_WORK = 'restriction on other work - verify';
export const NOTE_EXCLUSIVITY = 'exclusivity wording - verify';
export const NOTE_PRESET = 'preset bracket - bids may exceed it';
/**
 * The preset tier a stored gig was posted in, in US dollars (final review I1): the gig carries `NOTE_PRESET`, a fixed
 * budget with a raw minimum and maximum, and a converted `budgetUsd` (the raw maximum in USD), so the minimum is
 * converted at the same rate. Null for any other gig. The dashboard's rate label and the notification's top use it.
 */
export function presetTierUsd(g: { readonly notes: readonly string[]; readonly budget: unknown; readonly rate: unknown }): { readonly lo: number; readonly hi: number } | null {
  if (!g.notes.includes(NOTE_PRESET)) return null;
  const b = g.budget as { type?: unknown; min?: unknown; max?: unknown } | null;
  const hi = (g.rate as { budgetUsd?: unknown } | null)?.budgetUsd;
  if (b === null || typeof b !== 'object' || b.type !== 'fixed' || typeof b.min !== 'number' || typeof b.max !== 'number' || b.max <= 0 || typeof hi !== 'number') return null;
  return { lo: (hi * b.min) / b.max, hi };
}
export const NOTE_ROLE_FILTER = 'title matches your role filter: ';
export const NOTE_PARTIAL_SCOPE = 'stated hours may cover part of the scope - verify';
export const NOTE_RATE_NEGOTIABLE = 'rate negotiable - verify';
export const NOTE_LOCATION_ZONES = 'location field names time zones - verify';
export const NOTE_RATE_UNKNOWN = 'rate unknown - verify';
/** sources-expansion: a fixed budget stated as a minimum ("$300+ per post"), no maximum, below the floor. */
export const NOTE_BUDGET_MINIMUM = 'budget is a minimum with no maximum - verify';
export const NOTE_DERIVED_NOT_COUNTED = 'derived rate below floor - not counted';
/** freelance-boost: the pay is only a stated ceiling at or above the floor. */
export const noteCeiling = (max: number): string => `pay is a stated ceiling only (up to $${max}/h) - verify`;

/* ------------------------------------------------------------------ closed requirement sentences */
/*
 * A text reject for residence, presence (overlap) or exclusivity needs ONE closed sentence that is a requirement on YOU:
 *   SUBJECT (you, candidates, the developer ... or an imperative "Must be", "Must work", "Cannot ...")
 *   + MODAL (must, are required to, have to, need to, will need to; or a prohibition: cannot, may not, must not)
 *   + PREDICATE and OBJECT (be located in <place>, be online <window>, not work for other clients)
 *   + a CLOSED TAIL (the object ends the sentence, or only "daily", "every weekday", "during the contract", "to apply" ...),
 *   with NO HEDGE word in the sentence. "Should", "ideally", "expected to" are no modal. Anything that matches only partly
 *   (a hedge, a narrowing such as "in the same industry", an owner who is not you) is review with a note, never a reject.
 */
const CLAUSES = /(?<=[.!?])\s+|[;\n]/;
const FILLER = /^(?:(?:note that|please note(?: that)?|please be aware(?: that)?:?|important:?|also|additionally|and|but|so)[\s,]+)+/i;
const REQ_HEDGE = /\b(?:ideally|preferred|preferably|prefer|if|unless|or|welcome|occasionally|sometimes|when needed|if needed|for launch|only for|during the launch|optional|nice to have|plus|mostly|usually|often|typically|generally)\b/i;
const NARROWING = /\b(?:in the same (?:industry|niche|market)|directly|from our clients|of ours|using our|through our|on this (?:codebase|project)|competing|competitors?)\b/i;
const SUBJ = '(?:you|(?:the\\s+)?(?:freelancers?|developers?|contractors?|engineers?|candidates?|applicants?))';
const MODAL = '(?:must|are required to|is required to|have to|has to|need to|needs to|will need to)';
const CLOSED_TAIL = '(?:(?:\\s*,\\s*|\\s+)(?:daily|every day|each weekday|every weekday|on weekdays|monday to friday|during the (?:contract|engagement|project)|during this (?:contract|engagement|project)|while engaged(?: with us)?|at all times|to apply|to be considered|for [a-z0-9-]+ (?:reasons|purposes)))*';
/** A clause without its trailing punctuation and its lead-in words ("Note that", "Please be aware:"). */
const LIST_MARKER = /^(?:[-*•]\s+|\d+[.)]\s+)/;
/**
 * A leading requirement label is stripped; any OTHER label ("Error text:", "Example:", "Popup:", "Old policy:", "Not required:",
 * "Test case:", "Myth:") quotes or illustrates a requirement, so the clause stays unmatched and is no requirement.
 */
const LABEL = /^(?:requirements?|location|availability|eligibility|hours|working hours|schedule|must[- ]haves?|note|important|exclusivity|commitment|time ?zone):\s+/i;
const clauseOf = (raw: string): string => raw.trim().replace(/[.!?:\s]+$/, '').replace(LIST_MARKER, '').replace(FILLER, '').replace(LABEL, '');

/**
 * After a closed reject, the next two clauses may soften it ("Exceptions are possible", "Hours are flexible", "This is
 * negotiable", "Part-time is fine"); for a residence requirement also a widening ("we also hire in India", "from
 * anywhere"). "Not negotiable" does not soften. A softened reject is review.
 */
const SOFTENS = /\b(?:negotiable|flexible|exceptions?|possible|welcome|fine|ok(?:ay)?|not a hard rule|can be discussed|open to|depends?)\b/i;
const WIDENS = /\b(?:india|anywhere|worldwide|globally|also hire in|other countries|remote applicants from)\b/i;
const PART_TIME_OK = /part[- ]time (?:is )?(?:possible|fine|ok|okay|welcome)/i;
/** After an hours requirement: fewer hours would do. */
const FEWER_HOURS_OK = /part[- ]time (?:is )?(?:possible|fine|ok|okay|welcome)|fewer hours|less hours|(?:10|15|20) hours (?:is )?(?:fine|ok|okay|possible)/i;
function softenedAfter(following: readonly string[], widening?: RegExp): boolean {
  const t = following.filter((c) => c.trim() !== '').slice(0, 2).join(' ').replace(/\b(?:not negotiable|non-?negotiable)\b/gi, ' ');
  return SOFTENS.test(t) || (widening?.test(t) ?? false);
}
const NOTE_SOFTENED = 'requirement softened nearby - verify';
const softened = (): Outcome => reviewOf('requirement-softened', NOTE_SOFTENED);

/* ------------------------------------------------------------------ 4. location */

const ONLY = /\b(?:us|usa|u\.s\.|united states|canada|uk|eu|europe|emea|latam)\s*only\b/i;
const INDIA_SCOPE: ReadonlySet<string> = new Set(['india', 'apac', 'asia', 'south asia', 'worldwide']);
const inScope = (countries: readonly string[]): boolean => countries.some((c) => INDIA_SCOPE.has(c));
/** Wording that makes a place list a preference, an example or an exclusion, not a clean restriction to those places. */
const SOFT_LOCATION = /\b(?:prefer(?:red)?|ideally|welcome|open to|also|others?|elsewhere|flexible|negotiable|plus|mostly|primarily|not|no|except|excluding|outside|apart|besides|other than)\b/i;
/** A word that may mean India is inside ("Southeast Asia", "global"): the list is then not a clean exclusion. */
const INDIA_LIKE = /\b(?:india|asia|apac|worldwide|global|anywhere|world)\b/i;
const LOCATION_FILLER = /\b(?:remote|remotely|only|based|timezones?|time zones?|region|regions|countries|country|candidates?|hybrid)\b/gi;
/** Restrictive wording in a description. Case-sensitive for the abbreviations ("us only" is usually "contact us only"). */
const DESCRIPTION_RESTRICTION = new RegExp(
  [
    '\\b(?:US|USA|U\\.S\\.|UK|EU|EMEA|LATAM|UAE)[\\s-][Oo]nly\\b',
    '\\b(?:United States|Canada|Europe|North America)[\\s-][Oo]nly\\b',
    '\\b[Oo]nly (?:open to |for )?(?:candidates |freelancers |developers |applicants |people |residents )?(?:based |located |residing |living )?(?:in|from) (?:the )?(?:US|USA|U\\.S\\.|United States|UK|Canada|EU|Europe)\\b',
    '\\b(?:must|should|need to|have to) (?:be )?(?:based|located|residing|living|resident) in (?:the )?(?:US|USA|U\\.S\\.|UK|EU|Europe|United States|Canada)\\b',
    '\\b(?:must|need to|needs to|should|have to) reside in (?:the )?(?:US|USA|U\\.S\\.|UK|EU|Europe|United States|Canada|Germany)\\b',
    '\\b[Oo]nly (?:US|UK|EU|Canadian|European|American) (?:residents|citizens)\\b',
    '\\b(?:European|American|US|EU|UK|EMEA|Americas) time ?zones? only\\b',
    '\\b(?:in|within) (?:the )?time ?zones?:? (?:GMT|UTC)\\s?[+\\-\\u2212]\\d',
  ].join('|'),
);

const TIMEZONE_WORDS = /\b(?:time ?zones?|hours?)\b/i;
const TIMEZONE_ABBREVIATIONS = /\b(?:EST|EDT|PST|PDT|CET|CEST|GMT|UTC|PT|ET|IST)\b/;

/** Places outside India that a residence requirement can name: a closed list, not a pattern. */
const PLACES = '(?:U\\.?S\\.?(?:A\\.?)?|United States(?: of America)?|U\\.?K\\.?|United Kingdom|Britain|Canada|EU|European Union|Europe|Australia|New Zealand|Germany|France|Spain|Italy|Netherlands|Poland|Ireland|Sweden|Norway|Denmark|Finland|Switzerland|Israel|Mexico|Brazil|Argentina|Japan)';
const RESIDENCE = new RegExp(`^(?:${SUBJ})\\s+(?:${MODAL})\\s+be\\s+(?:physically\\s+)?(?:based|located|living|resident|residing)\\s+in\\s+(?:the\\s+)?${PLACES}${CLOSED_TAIL}$`, 'i');
const RESIDE = new RegExp(`^(?:${SUBJ})\\s+must\\s+reside\\s+in\\s+(?:the\\s+)?${PLACES}${CLOSED_TAIL}$`, 'i');
/** "You must be located in the US.": one closed requirement on the candidate (see the block above). */
function residenceStated(description: string): 'reject' | 'softened' | null {
  const clauses = description.split(CLAUSES);
  for (let k = 0; k < clauses.length; k++) {
    const c = clauseOf(clauses[k] as string);
    if (REQ_HEDGE.test(c) || !(RESIDENCE.test(c) || RESIDE.test(c))) continue;
    return softenedAfter(clauses.slice(k + 1), WIDENS) ? 'softened' : 'reject';
  }
  return null;
}

/** The gig's own location data does not already put India in scope. */
const indiaNotInScope = (g: Gig): boolean => !inScope(g.location.countries);

export function locationOutcome(g: Gig): Outcome {
  const { countries, worldwide, text } = g.location;
  if (indiaNotInScope(g)) {
    const stated = residenceStated(g.description);
    if (stated === 'reject') return rejectOf('location-outside-india');
    if (stated === 'softened') return softened();
  }
  // A sentence that also names India or somewhere wider ("the US or India") is no restriction.
  const restricted = g.description.split(/(?<=[.!?])\s+|\n/).some((sentence) => DESCRIPTION_RESTRICTION.test(sentence) && !/\b(?:india|asia|apac|worldwide|anywhere)\b/i.test(sentence));
  const withText = (o: Outcome): Outcome => (o.reject === null && restricted && !o.notes.includes(NOTE_LOCATION_TEXT) ? { reject: null, review: o.review ?? 'location-unclear', notes: [...o.notes, NOTE_LOCATION_TEXT] } : o);

  if (text !== null && ONLY.test(text)) {
    return worldwide || inScope(countries) ? reviewOf('location-unclear', NOTE_LOCATION_MAY_EXCLUDE) : rejectOf('location-outside-india');
  }
  if (worldwide || inScope(countries)) return withText(PASS);
  // A location field about time zones or hours ("USA timezones", "EU hours") is a preference for overlap, not a country restriction.
  if (text !== null && (TIMEZONE_WORDS.test(text) || TIMEZONE_ABBREVIATIONS.test(text))) return withText(reviewOf('location-unclear', NOTE_LOCATION_ZONES));
  if (countries.length === 0) return withText(reviewOf('location-unclear', NOTE_LOCATION_NOT_STATED));
  // Countries named, none of them India or a region with India.
  if (text === null) return withText(reviewOf('location-unclear', NOTE_LOCATION_MAY_EXCLUDE));
  if (INDIA_LIKE.test(text) || SOFT_LOCATION.test(text)) return withText(reviewOf('location-unclear', NOTE_LOCATION_MAY_EXCLUDE));
  const parts = text
    .split(/[,;/|]|\band\b|\bor\b/i)
    .map((p) => p.replace(LOCATION_FILLER, ' ').trim())
    .filter((p) => p !== '');
  if (parts.length > 0 && parts.every((p) => countriesIn(p).length > 0)) return rejectOf('location-outside-india');
  return withText(reviewOf('location-unclear', NOTE_LOCATION_LIST));
}

/* ------------------------------------------------------------------ 5. hours */

/** "40+ hours per week": a minimum the normalizer's per-week pattern does not read. */
const PLUS_HOURS = /(?<![\w.,\-–—+])(\d{1,2})\s?\+\s?(?:h|hrs|hours)\s?(?:\/|per|a)\s?(?:week|wk)\b/gi;
/** Right before the figure: a ceiling or a negation, so the figure is not a requirement. */
const CEILING_BEFORE = /\b(?:up\s?to|max(?:imum)?(?:\s+of)?|no more than|not more than|at most|less than|under|below|not exceed(?:ing)?|capped at|limit(?:ed)? to|not|no|never|rather than|instead of)\s*[:~]?\s*$/i;
/** Anywhere in the clause before the figure: a negation voids it ("Not a 40 hours per week contract"). */
const NEGATED_BEFORE = /\b(?:not|no|never|isn't|is not|unlike|without)\b/i;
const CEILING_AFTER = /^\s*(?:or less|or fewer|max(?:imum)?\b|at most|tops|cap\b)/i;
/** Anywhere in the figure's clause: a condition, a wish or an option, not a requirement. */
const CONDITIONAL = /\b(?:if|whether|ideally|prefer\w*|bonus|nice to have|optional|negotiable|can be|could|might|may|up to)\b/i;
/** A habit or a general statement about the company's work, not this engagement. */
const HABITUAL = /\b(?:typical(?:ly)?|usual(?:ly)?|rarely|often|generally|on average|averag\w+|most of our|some of our|many of our|our (?:projects|clients|engagements|team|developers)|can vary|varies|may vary|flexible)\b/i;
/** In the figure's own clause: wording that makes it this engagement's requirement. */
const CONFIRM = /\b(?:commit(?:ment|ted|s)?|require[sd]?|requirements?|need(?:s|ed)?|expect(?:s|ed|ing)?|must|dedicat\w+|availability|engagement|you(?:'ll|r)?|to work|looking for|seeking|minimum|min|at least|hours?\s*:|schedule|workload)\b/i;
const CONFIRM_AFTER = /^\s*(?:(?:is |are )?(?:required|needed|expected|minimum|mandatory)\b|commitment\b|of availability\b|(?:[\w-]+\s+)?(?:contract|role|position|engagement|assignment|gig|opportunity)\b)/i;

type Figure = 'yes' | 'unclear' | 'absent';

/** Whether every place the text states `min` hours a week confirms it as a requirement. `absent`: the text does not show it. */
function figureStatus(text: string, min: number): Figure {
  const found: { start: number; end: number }[] = [];
  for (const m of text.matchAll(HOURS_PER_WEEK)) if (Number(m[1] ?? m[3]) === min) found.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  for (const m of text.matchAll(PLUS_HOURS)) if (Number(m[1]) === min) found.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  if (found.length === 0) return 'absent';
  for (const f of found) {
    const windowRaw = text.slice(Math.max(0, f.start - 80), f.start);
    // The figure's own clause: after the last sentence end or `|`. (rate.ts `clauseBefore` also breaks at a comma after a
    // number, which is right for a deadline but cuts "Commitment: Full-time, 40 hours" away from its label.)
    const before = windowRaw.replace(/\*+/g, '').replace(/^[^]*[.;!?\n|]/, '');
    const afterRaw = text.slice(f.end, f.end + 60);
    const after = afterRaw.split(/[.;!?\n]/)[0] ?? '';
    const header = /\|\s*$/.test(windowRaw) && /^\s*(?:\||$)/.test(afterRaw);
    const confirmed = header || CONFIRM.test(before) || CONFIRM_AFTER.test(afterRaw);
    if (!confirmed || NEGATED_BEFORE.test(before.split(/,|\bso\b|\bbut\b|\bthen\b/i).pop() ?? '') || CEILING_BEFORE.test(before) || CEILING_AFTER.test(afterRaw) || HABITUAL.test(`${before} ${after}`) || CONDITIONAL.test(`${before} ${after}`)) return 'unclear';
  }
  return 'yes';
}

const FULL_TIME = /\bfull[\s-]?time\b/gi;
/**
 * The allow-list: a "full-time" counts only inside one of these shapes, each of which ties it to THIS engagement. A
 * mention outside every shape ("our full-time engineers", "we're a full-time remote team", "employed full-time") is
 * ignored; the hours then stay unknown (review).
 */
const ENGAGEMENT_NOUN = '(?:role|position|contract|contractor|engagement|assignment|commitment|basis|opportunity|opening|freelancer|consultant|gig|project)';
const FULL_TIME_SHAPES: readonly RegExp[] = [
  // "a full-time remote contract role", "full-time contractor", "on a full-time basis"
  new RegExp(`\\bfull[\\s-]?time,?\\s+(?:(?:remote|contract|contractual|freelance|independent|long[\\s-]term|on-?site),?\\s+){0,3}${ENGAGEMENT_NOUN}\\b`, 'gi'),
  // "this role is full-time"
  new RegExp(`\\b${ENGAGEMENT_NOUN}\\s+(?:is|are|will be|would be|requires?)\\s+(?:an?\\s+)?(?:\\w+\\s+){0,2}?full[\\s-]?time\\b`, 'gi'),
  // "we need a full-time ...", "looking for an experienced full-time ..."
  // (a singular person, not "hiring full-time employees")
  /\b(?:need|needs|seeking|looking for|hiring|want|wanted|require[sd]?)\s+(?:an?|the|someone|somebody)\s+(?:(?:experienced|senior|dedicated|remote|freelance|independent|contract)\s+){0,3}full[\s-]?time(?=\s+(?:[\w-]+\s+){0,3}?(?:developer|engineer|contractor|freelancer|consultant|specialist|architect|programmer|analyst|resource|expert)\b)/gi,
  // "you will work full-time", "your availability for full-time work"
  /\b(?:you(?:'ll| will| must| should| need to| would)?|to|must|will)\s+(?:be\s+)?(?:available|working|work|commit|dedicate)\w*\s+(?:for\s+|on\s+a\s+)?full[\s-]?time\b|\bavailability\s+for\s+full[\s-]?time\b/gi,
  // "Commitment: Full-time", "Job Type: Full-time"
  /\b(?:commitment|engagement|job type|employment type|schedule|hours?)\s*:\s*\**\s*full[\s-]?time\b/gi,
  // a header field of the post's first line: "... | Contract | REMOTE (US) | Full-Time ..."
  /(?:^|\n)[^\n]{0,250}?\|\s*full[\s-]?time\b/gi,
  // "Contract, full-time"
  /\b(?:contract|contractor|freelance)\s*,\s*full[\s-]?time\b|\bfull[\s-]?time\s*,\s*(?:contract|contractor|freelance)\b/gi,
];
/** Wording beside a "full-time" that makes it an alternative, a preference, a possibility or a negation. */
const FULL_TIME_SOFT = /\b(?:or|and\/or|either|part[\s-]?time|prefer(?:red)?|ideally|possible|path|then|may|might|could|can be|optional|option|flexible|negotiable|not|non|no|never|rather than|instead of|convert|conversion|eventually|potential|after|starting|until|without|unlike|instead|previously|hired|former|formerly|left|welcome|welcomed|welcomes)\b|\b\w+n['’]t\b|\//i;
/** The full-time phrase names ANOTHER job: "have a", "keep your current", "alongside a" before it, "elsewhere" after it, unless a contract shape follows. */
const ANOTHER_JOB_BEFORE = /\b(?:have|has|having|keep|with|alongside|current|day|while|besides|in addition to|already)\s+(?:an?\s+|your\s+|their\s+|the\s+)?(?:current\s+|existing\s+)?$/i;
const ANOTHER_JOB_AFTER = /^\s*(?:job|role|position|employment|engagement)?\s*(?:elsewhere|already|at another)/i;
const THIS_ROLE_AFTER = /^[,\s]*(?:remote\s+)?(?:contract|contractor|freelance|independent)\b/i;

/** `yes`: a "full-time" is tied to this engagement and not hedged; `unclear`: one is hedged; `no`: none is tied to it (boilerplate, or none). */
function fullTime(text: string): 'yes' | 'unclear' | 'no' | 'softened' {
  const spans: [number, number][] = [];
  for (const shape of FULL_TIME_SHAPES) for (const m of text.matchAll(shape)) spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  let result: 'yes' | 'unclear' | 'no' | 'softened' = 'no';
  for (const m of text.matchAll(FULL_TIME)) {
    const at = m.index ?? 0;
    if (!spans.some(([lo, hi]) => lo <= at && at < hi)) continue;
    // The mention's own clause: between the nearest sentence ends or `|`, at most 50 characters either way.
    const left = text.slice(Math.max(0, at - 50), at).search(/[^.;!?\n|]*$/);
    const rightRaw = text.slice(at + m[0].length, at + m[0].length + 50);
    const rightEnd = rightRaw.search(/[.;!?\n|]/);
    const clause = text.slice(Math.max(0, at - 50) + left, at + m[0].length) + (rightEnd === -1 ? rightRaw : rightRaw.slice(0, rightEnd));
    const before = text.slice(Math.max(0, at - 30), at);
    const after = text.slice(at + m[0].length, at + m[0].length + 40);
    if ((ANOTHER_JOB_BEFORE.test(before) && !THIS_ROLE_AFTER.test(after)) || ANOTHER_JOB_AFTER.test(after)) return 'unclear';
    if (FULL_TIME_SOFT.test(clause) || rightRaw[rightEnd] === '?') return 'unclear';
    // "You will work full-time. Actually part-time is fine too.": the next two clauses soften it.
    const following = text.slice(at + m[0].length).split(CLAUSES).slice(1);
    result = softenedAfter(following, PART_TIME_OK) ? 'softened' : result === 'softened' ? 'softened' : 'yes';
  }
  return result;
}

/** freelance-boost, the one approved rule change (user, 2026-10-14). */
export const NOTE_YOU_SET_HOURS = 'hours not stated; you set them';

/**
 * Freelancer.com bills hourly projects by the hours the freelancer logs, so the freelancer sets the weekly limit: an
 * hourly Freelancer contract whose stated USD rate (after FX) reaches the floor needs no stated hours (user decision
 * 2026-10-14). Only that: every other source, and any rate that is not `stated`, keeps the review.
 *
 * "Reaches the floor" means the TOP of the stated range (`maxUsdH >= rateFloorUsdHour`), so "$25–50/h" qualifies
 * (controller decision 2026-10-15): the same test the pay rule (9) and the notification's "K at ≥$X/h" use.
 */
export function youSetHours(r: RatedGig, floor: number): boolean {
  const { gig, rate } = r;
  return gig.platform === 'freelancer' && gig.kind === 'contract' && gig.budget.type === 'hourly' && rate.method === 'stated' && rate.maxUsdH !== null && rate.maxUsdH >= floor;
}

/* freelance-boost review round (I1): hours in any unit, and the wording that rules out "not stated". */
const WEEKS_PER_MONTH = 4.33;
const DAYS_PER_WEEK = 5;
const RANGE_SEP = '\\s?(?:-|–|—|to)\\s?';
/** "160 hours per month", "40-80 hrs/mo", "8 hours a day", "6-8 h/day". */
const NUM = '\\d{1,3}(?:\\.\\d+)?';
const HOURS_PER_MONTH = new RegExp(`\\b(${NUM})(?:${RANGE_SEP}(${NUM}))?\\s?(?:h|hrs|hours)\\s?(?:\\/|per|a|each|every)\\s?(?:month|mo)\\b`, 'gi');
const HOURS_PER_DAY = new RegExp(`\\b(${NUM})(?:${RANGE_SEP}(${NUM}))?\\s?(?:h|hrs|hours)\\s?(?:\\/|per|a|each|every)\\s?(?:day|weekday)\\b`, 'gi');
/** Any hours figure in any unit or wording: digits or written-out numbers next to "hour(s)", "N hours weekly", "per week ... N hours". */
const ANY_HOURS =
  /\b\d{1,3}(?:\.\d+)?\s?(?:\+|(?:-|–|—|to)\s?\d{1,3})?\s?(?:h|hrs?|hours?)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|eighty|hundred|few|several|couple of)(?:[\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?[\s-]+(?:hours?|hrs)\b|\bper\s+(?:week|month|day)\b[^.;\n]{0,40}\b\d{1,3}\s?(?:h|hrs?|hours?)\b/i;
/** Full-time wording of any shape, or a working-day window: never "hours not stated". */
const FULL_TIME_ANY = /\bfull[\s-]?time\b|\bentire\s+(?:week|day)\b|\b9\s?(?:am)?\s?(?:-|–|to)\s?[56]\s?(?:pm)?\b|\b\d{1,2}\s?(?:am|pm)\s?(?:-|–|to)\s?\d{1,2}\s?(?:am|pm)\b|\b40\s?(?:h|hrs?|hours?)\b/i;

/** Every per-month or per-day figure in the text, as hours per week (÷ 4.33, × 5), with what it said; null if one is malformed. */
function convertedAll(text: string): { min: number; max: number; note: string }[] | null {
  const found = new Map<string, { min: number; max: number; note: string }>();
  const r1 = (x: number): number => Math.round(x * 10) / 10;
  for (const m of text.matchAll(HOURS_PER_MONTH)) {
    const lo = Number(m[1]);
    const hi = Number(m[2] ?? m[1]);
    if (!(lo > 0 && hi >= lo)) return null;
    found.set(`m${lo}-${hi}`, { min: r1(lo / WEEKS_PER_MONTH), max: r1(hi / WEEKS_PER_MONTH), note: `${lo === hi ? lo : `${lo}–${hi}`} hours per month` });
  }
  for (const m of text.matchAll(HOURS_PER_DAY)) {
    const lo = Number(m[1]);
    const hi = Number(m[2] ?? m[1]);
    if (!(lo > 0 && hi >= lo)) return null;
    found.set(`d${lo}-${hi}`, { min: r1(lo * DAYS_PER_WEEK), max: r1(hi * DAYS_PER_WEEK), note: `${lo === hi ? lo : `${lo}–${hi}`} hours per day` });
  }
  return [...found.values()];
}

/** One unambiguous per-month or per-day figure, as hours per week, with what it said; else null. */
export function convertedHours(text: string): { min: number; max: number; note: string } | null {
  const all = convertedAll(text);
  return all !== null && all.length === 1 ? (all[0] ?? null) : null;
}

export const NOTE_MIXED_UNITS = 'hours stated in several ways; confirm';
/**
 * A per-week figure (`week`: the resolved one, a "10+ hours per week" minimum included) next to a per-month or per-day
 * one that disagrees by over 20%, or either over the cap.
 */
function mixedUnits(description: string, week: number | null, cap: number): boolean {
  const others = convertedAll(description);
  if (week === null || others === null || others.length === 0) return false;
  return others.some((o) => week > cap || o.max > cap || Math.abs(o.max - week) > 0.2 * Math.max(o.max, week));
}

export const noteWideRange = (max: number, cap: number): string => `hours range up to ${max}/week exceeds ${cap}; confirm`;

export function hoursOutcome(g: Gig, cap: number, setByYou = false): Outcome {
  if (g.kind !== 'contract') return PASS;
  const text = `${g.title}\n${g.description}`;
  let min = g.hoursPerWeek.min;
  if (min === null) {
    const plus = new Set([...g.description.matchAll(PLUS_HOURS)].map((m) => Number(m[1])));
    if (plus.size === 1) min = [...plus][0] ?? null;
  }
  const ft = fullTime(text);
  // A per-week figure beside a per-month or per-day one that disagrees (controller decision 2026-10-15): review.
  // The resolved figure: the normalizer's per-week one, or a single "N+ hours per week" (re-review I6, 2026-10-15).
  if (min !== null && mixedUnits(g.description, g.hoursPerWeek.max ?? min, cap)) return reviewOf('hours-unclear', NOTE_MIXED_UNITS);
  if (min !== null) {
    if (min > cap) {
      const status = figureStatus(g.description, min);
      if (status === 'unclear') return reviewOf('hours-unclear', NOTE_HOURS_UNCLEAR);
      // "You must commit 40 hours per week. This is negotiable.": the next two clauses may soften the requirement.
      const ends = [...g.description.matchAll(HOURS_PER_WEEK), ...g.description.matchAll(PLUS_HOURS)].filter((m) => Number(m[1] ?? m[3]) === min).map((m) => (m.index ?? 0) + m[0].length);
      const end = ends.length > 0 ? Math.max(...ends) : -1;
      if (end >= 0 && softenedAfter(g.description.slice(end).split(CLAUSES).slice(1), FEWER_HOURS_OK)) return softened();
      return rejectOf('hours-over-cap');
    }
    if (ft === 'yes') return reviewOf('hours-unclear', NOTE_HOURS_CONFLICT);
    // A range whose top is over the cap ("10–39 h/week") is review, never a pass (controller decision 2026-10-15).
    const max = g.hoursPerWeek.max;
    if (g.hoursPerWeek.min !== null && max !== null && max > cap) return reviewOf('hours-unclear', noteWideRange(max, cap));
    return PASS;
  }
  if (ft === 'softened') return softened();
  // Hours per month or per day are converted to a week ONLY as a note (controller decision 2026-10-15): the gig is
  // review either way ("7 days a week", "at least", a launch week at full time... a conversion cannot know), and a
  // converted figure never rejects.
  const converted = ft === 'no' ? convertedHours(g.description) : null;
  if (converted !== null) {
    const how = `≈${converted.min === converted.max ? converted.min : `${converted.min}–${converted.max}`} h/week from ${converted.note} (assumed ${converted.note.endsWith('month') ? `${WEEKS_PER_MONTH} weeks/month` : `${DAYS_PER_WEEK} days/week`})`;
    return reviewOf('hours-unclear', converted.max <= cap ? `${how}; confirm` : `${how} - verify`);
  }
  if (ft === 'yes') return rejectOf('hours-over-cap');
  // "Hours not stated" only when the text has NO hours figure in any unit or wording ("160 hours per month", "8
  // hours a day", "forty hours a week", "per week we need 30 hours") and no full-time wording of any shape ("This is a
  // full-time job", "your entire week, 9-5", "40 hours"): anything else stays review (review round I1, 2026-10-15).
  const anyFigure = ANY_HOURS.test(text) || [...text.matchAll(HOURS_PER_WEEK)].length > 0 || [...text.matchAll(PLUS_HOURS)].length > 0;
  if (ft === 'no' && setByYou && !anyFigure && !FULL_TIME_ANY.test(text)) return noteOf(NOTE_YOU_SET_HOURS);
  return reviewOf('hours-unclear', NOTE_HOURS_UNKNOWN);
}

/* ------------------------------------------------------------------ 6. IST overlap */

const ZONE_OFFSET: Readonly<Record<string, number>> = { EST: -5, EDT: -4, ET: -4, CST: -6, PST: -8, PDT: -7, PT: -7, CET: 1, CEST: 2, GMT: 0, UTC: 0, BST: 1, IST: 5.5 };
const ZONES = Object.keys(ZONE_OFFSET).join('|');
/** After this many characters of window length, a time range is a working window and not a call slot. */
const MIN_WINDOW_MIN = 240;
const MAX_WINDOW_MIN = 16 * 60;
const MIN_SHARE_MIN = 120;
const DAY = 1440;
/** Case-sensitive on purpose (zones are upper case, am/pm are normalised to lower case first). */
const RANGE = new RegExp(`(?<![\\d:.])(\\d{1,2})(?::(\\d{2}))?\\s?(am|pm)?\\s?(?:-|–|—|to|until|till|and)\\s?(\\d{1,2})(?::(\\d{2}))?\\s?(am|pm)?\\s?\\(?(${ZONES})\\b(?![+\\-\\u2212]\\s?\\d)`, 'g');
const ZONE_TOKEN = new RegExp(`\\b(?:${ZONES})\\b`, 'g');
const LEAD = /\b(?:online|available|availability|working|work|on call|present|reachable)\b/i;
const VOID_OVERLAP =
  /\b(?:async(?:hronous(?:ly)?)?|flexible|flexibility|some overlap|partial overlap|minimal overlap|prefer(?:red)?|ideally|nice to have|negotiable|adjustable|can be adjusted|variable)\b|\b(?:overlap|window|hours) (?:is |are )?not (?:required|needed|necessary|strict|mandatory)\b|\bno (?:strict |fixed )?overlap\b/i;
/**
 * A window counts only as a closed requirement on the candidate (see the block above): "You must be online 9am-5pm PST",
 * "We need you to be online ...", "Must be available ...", "Must work ...", "You will be working 9am-5pm PST, Monday to
 * Friday", or "Working hours 9am to 5pm PST are required". The window must follow the predicate directly and end the clause
 * (or be followed by a closed tail). A window owned by someone else ("our team, who are online ...") is no requirement.
 */
const PRESENCE_PREFIX = new RegExp(
  `^(?:(?:${SUBJ})\\s+(?:${MODAL}|will\\s+be)|must|we\\s+(?:need|require)\\s+(?:${SUBJ})\\s+to)\\s+(?:be\\s+)?(?:online|available|working|reachable|present)(?:\\s+(?:during|between|from))?$|^(?:(?:${SUBJ})\\s+${MODAL}|must)\\s+work(?:\\s+(?:during|between|from))?$`,
  'i',
);
const CLOSED_TAIL_ONLY = new RegExp(`^${CLOSED_TAIL}$`, 'i');
/** A clause that speaks to the candidate or states a requirement, but is not closed: worth a note. */
const SPEAKS_TO_YOU = new RegExp(`^(?:${SUBJ}|must|we\\s+(?:need|require))\\b`, 'i');
/** Time zone names written out: "Pacific time" is PT, "Eastern time" is ET (the brief's fixed offsets). */
const ZONE_NAMES: readonly [RegExp, string][] = [[/\bPacific (?:Standard |Daylight )?[Tt]ime\b/g, 'PT'], [/\bEastern (?:Standard |Daylight )?[Tt]ime\b/g, 'ET']];

function closedWindow(clause: string, m: RegExpMatchArray): boolean {
  if (REQ_HEDGE.test(clause) || [...clause.matchAll(RANGE)].length !== 1) return false;
  const at = m.index ?? 0;
  const prefix = clauseOf(clause.slice(0, at));
  const suffix = clause.slice(at + m[0].length).replace(/[.!?\s]+$/, '');
  return (PRESENCE_PREFIX.test(prefix) && CLOSED_TAIL_ONLY.test(suffix)) || (/^working hours$/i.test(prefix) && /^\s*(?:are|is) required$/i.test(suffix));
}
const ZONE_HOURS = new RegExp(`\\b(?:${ZONES})\\s+(?:hours|business hours|working hours|time ?zone)\\b`);

/** The start minutes a clock reading can mean: a suffix fixes it, an hour above 12 or 0 is 24-hour, else both halves of the day. */
function clockOptions(h: number, min: number, suffix: string | undefined): number[] | null {
  if (min > 59 || h > 24) return null;
  if (suffix !== undefined) return h >= 1 && h <= 12 ? [((h % 12) + (suffix === 'pm' ? 12 : 0)) * 60 + min] : null;
  if (h === 0 || h > 12) return [(h % 24) * 60 + min];
  return [(h % 12) * 60 + min, ((h % 12) + 12) * 60 + min];
}

/** The window as [start, duration] in local minutes, or null when it cannot be read with confidence. */
function parseWindow(m: RegExpMatchArray): { start: number; dur: number } | null {
  const h1 = Number(m[1]);
  const m1 = m[2] === undefined ? 0 : Number(m[2]);
  const s1 = m[3];
  const h2 = Number(m[4]);
  const m2 = m[5] === undefined ? 0 : Number(m[5]);
  const s2 = m[6];
  let starts = clockOptions(h1, m1, s1);
  const ends = clockOptions(h2, m2, s2);
  if (starts === null || ends === null) return null;
  // No suffix on either side and both hours are 1-12: business hours. 6-11 are morning, 12 and 1-5 afternoon.
  if (s1 === undefined && s2 === undefined && h1 >= 1 && h1 <= 12 && h2 >= 1 && h2 <= 12) starts = [(h1 >= 6 && h1 <= 11 ? starts[0] : starts[1]) as number];
  let best: { start: number; dur: number } | null = null;
  for (const s of starts) {
    for (const e of ends) {
      const dur = (((e - s) % DAY) + DAY) % DAY;
      if (dur > 0 && (best === null || dur < best.dur)) best = { start: s, dur };
    }
  }
  return best !== null && best.dur <= MAX_WINDOW_MIN ? best : null;
}

function windowMinutes(istWindow: string): { start: number; end: number } {
  const [a, b] = istWindow.split('-') as [string, string];
  const mins = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const start = mins(a);
  const end = mins(b);
  return { start, end: end <= start ? end + DAY : end };
}

function overlapOutcome(g: Gig, istWindow: string): Outcome {
  const win = windowMinutes(istWindow);
  let raw = `${g.description}\n${g.timezone.overlapText ?? ''}`.replace(/\b(\d{1,2}(?::\d{2})?)\s?([AaPp])\.?[Mm]\.?/g, (_m, t: string, ap: string) => `${t}${ap.toLowerCase()}m`);
  for (const [re, zone] of ZONE_NAMES) raw = raw.replace(re, zone);
  const shares: number[] = [];
  let unparsed = false;
  let softenedWindow = false;
  const clauses = raw.split(CLAUSES);
  for (const [k, sentence] of clauses.entries()) {
    if (VOID_OVERLAP.test(sentence)) continue;
    let rangeHere = false;
    for (const m of sentence.matchAll(RANGE)) {
      rangeHere = true;
      if (!closedWindow(sentence, m)) {
        if (SPEAKS_TO_YOU.test(clauseOf(sentence))) unparsed = true;
        continue;
      }
      const w = parseWindow(m);
      if (w === null || w.dur < MIN_WINDOW_MIN) {
        unparsed = true;
        continue;
      }
      if (softenedAfter(clauses.slice(k + 1))) softenedWindow = true;
      const istStart = (((w.start - (ZONE_OFFSET[m[7] as string] as number) * 60 + 330) % DAY) + DAY) % DAY;
      let share = 0;
      for (let k = -1; k <= 1; k++) share += Math.max(0, Math.min(istStart + w.dur, win.end + k * DAY) - Math.max(istStart, win.start + k * DAY));
      shares.push(share);
    }
    if (rangeHere) continue;
    for (const z of sentence.matchAll(ZONE_TOKEN)) {
      const at = z.index ?? 0;
      if (LEAD.test(sentence.slice(Math.max(0, at - 45), at))) unparsed = true;
    }
    if (ZONE_HOURS.test(sentence)) unparsed = true;
  }
  if (shares.length > 0 && shares.every((s) => s < MIN_SHARE_MIN)) return softenedWindow ? softened() : rejectOf('overlap-outside-ist-window');
  return unparsed ? noteOf(NOTE_OVERLAP) : PASS;
}

/* ------------------------------------------------------------------ 7. exclusive */

const OTHER = '(?:work(?:\\s+for)?|take on|take|accept|have|hold)\\s+(?:any\\s+)?(?:other|additional|another)\\s+(?:clients?|projects?|work|jobs?|employment|employers?|commitments?)';
/** The closed exclusivity sentences (see the block above); "Exclusive rights", "non-exclusive" and "exclusively for Android" are none of them. */
const EXCLUSIVE_CLOSED: readonly RegExp[] = [
  new RegExp(`^(?:${SUBJ})\\s+(?:must not|cannot|can not|can't|may not|(?:are|is) not (?:allowed|permitted) to|(?:${MODAL})\\s+not)\\s+${OTHER}${CLOSED_TAIL}$`, 'i'),
  new RegExp(`^(?:must not|cannot|can not|can't)\\s+${OTHER}${CLOSED_TAIL}$`, 'i'),
  new RegExp(`^we\\s+(?:need|want|require|are looking for)\\s+an?\\s+exclusive\\s+(?:contractor|freelancer|developer)${CLOSED_TAIL}$`, 'i'),
  new RegExp(`^(?:${SUBJ})\\s+(?:will|must|are required to|have to|need to)\\s+work\\s+exclusively\\s+(?:for|with)\\s+(?:us|the client|our company)${CLOSED_TAIL}$`, 'i'),
  new RegExp(`^(?:${SUBJ})\\s+(?:will be|must be|are|are to be)\\s+an?\\s+exclusive\\s+(?:contractor|freelancer|developer)${CLOSED_TAIL}$`, 'i'),
  /^no other (?:clients?|jobs?|work|projects?|employers?)\s+(?:while engaged(?: with us)?|during (?:the|this) (?:contract|engagement|project))$/i,
];
/** A prohibition on the candidate that is not closed (narrowed, hedged): a non-compete or non-solicit clause, not exclusivity. */
const EXCLUSIVE_LOOSE = new RegExp(`^(?:${SUBJ})\\s+(?:\\w+\\s+)?(?:must not|cannot|can not|can't|may not|not allowed to|(?:${MODAL})\\s+not)\\s+${OTHER}`, 'i');
const GENERALISING = /\b(?:often|usually|typically|generally|sometimes)\b/i;
const WEAK_EXCLUSIVE = /(?<!non[-\s])\bexclusiv(?:e|ity)\b/i;
const ABOUT_THE_PERSON = /\b(?:you|your|freelancer|contractor|candidate|developer|engineer|availability|full[\s-]?time|commitment|engagement|work for|worker|resource)\b/i;
const ABOUT_RIGHTS = /\b(?:rights?|licen[sc]\w*|ownership|ip|copyright|source code|code|domain|distribution|resale|territor\w*|intellectual|patent|trademark|content|design|assets?)\b/i;

function exclusiveOutcome(g: Gig): Outcome {
  let partial = false;
  const clauses = g.description.split(CLAUSES);
  for (const [k, raw] of clauses.entries()) {
    const c = clauseOf(raw);
    if (!REQ_HEDGE.test(c) && !NARROWING.test(c) && EXCLUSIVE_CLOSED.some((re) => re.test(c))) return softenedAfter(clauses.slice(k + 1)) ? softened() : rejectOf('exclusive');
    if (EXCLUSIVE_LOOSE.test(c) && !GENERALISING.test(c)) partial = true;
  }
  if (partial) return reviewOf('exclusivity-unclear', NOTE_OTHER_WORK);
  const weak = g.description.split(/(?<=[.!?])\s+|\n/).some((s) => WEAK_EXCLUSIVE.test(s) && ABOUT_THE_PERSON.test(s) && !ABOUT_RIGHTS.test(s));
  return weak ? reviewOf('exclusivity-unclear', NOTE_EXCLUSIVITY) : PASS;
}

/* ------------------------------------------------------------------ 7b. licensed professional */

/** A licensed firm or professional ("licensed, AICPA peer-reviewed CPA firm only", final review M10). */
const LICENSED = /\b(?:cpa|aicpa|licensed (?:cpa|accountant|attorney|lawyer|auditor)|audit firm|law firm|peer[- ]reviewed)\b/i;
/** The clause asks for it: a requirement cue in the same clause. */
const LICENSED_CUE = /\b(?:only|must|required|requires?|requirement|need(?:s|ed)?|looking for|seeking|hire|hiring|has to|have to|should be|eligible|qualified)\b/i;
/** "No CPA required", "you don't need to be a CPA", "a licensed auditor is not needed": the clause rules it out. */
const LICENSED_NOT_NEEDED =
  /\b(?:no|not|without|don't|do not|doesn't|does not|isn't|is not)\b[^.;]{0,30}\b(?:need(?:ed)?|requir\w*|necessary|cpa|aicpa|licen[sc]\w*|audit firm|law firm|peer[- ]reviewed)\b|\b(?:cpa|aicpa|licen[sc]\w*|audit firm|law firm)\b[^.;]{0,30}\bnot (?:needed|required|necessary)\b/i;
export const NOTE_LICENSED = 'asks for a licensed firm or professional';

/**
 * 7b. licensed-professional: the title or a description clause asks for a licensed firm or professional (a CPA or
 * audit firm, a law firm, a licensed attorney, a peer-reviewed firm), which the candidate is not: review with the
 * note, never a reject (the clause may be about the client, not the bidder).
 */
function licensedOutcome(g: Gig): Outcome {
  const clauses = [g.title, ...g.description.split(CLAUSES)].map(clauseOf);
  const asks = clauses.some((c) => LICENSED.test(c) && LICENSED_CUE.test(c) && !LICENSED_NOT_NEEDED.test(c));
  return asks ? reviewOf('licensed-professional', NOTE_LICENSED) : PASS;
}

/* ------------------------------------------------------------------ 8-9. pay */

const DERIVED: ReadonlySet<RatedGig['rate']['method']> = new Set(['fixed÷stated-hours', 'derived-from-duration', 'monthly÷hours']);

/** The raw budget (before any conversion) is exactly one of the platform's fixed tiers: the client did not state a real budget. */
function isPreset(g: Gig, tiers: readonly Tier[]): boolean {
  const { currency, min, max, type } = g.budget;
  return type === 'fixed' && currency !== null && min !== null && tiers.some((t) => t.type === 'fixed' && t.min === min && t.max === max && (t.currencies === '*' || t.currencies.includes(currency)));
}

/** The price is open to the bidder's proposal: "indicative only", "rate negotiable", "quote your rate", "budget is flexible". */
const HEDGE_SPECIFIC = /\b(?:budget can (?:increase|go up|be increased)|(?:will|can|happy to) pay more|what(?:'s| is) your (?:price|rate|quote)|tell (?:me|us) your (?:price|rate)|fixed[- ]price (?:quote|quotation|estimate|bid)|quote a (?:fixed )?price|bid what you think|open to higher rates|rate depends on|depending on experience|DOE|propose your (?:price|budget)|quote your (?:own )?(?:hourly )?rate|your (?:own )?(?:hourly )?rate|different rate|name your (?:own )?(?:price|rate)|propose (?:a|your) (?:own )?(?:rate|price))\b|\b(?:state|share|include|send|provide|give|tell|quote|propose|let|your)\b[^.]{0,60}\b(?:hourly|project[- ]based|expected|desired)(?: or \w[\w-]*)? (?:rate|price)\b/i;
const HEDGE_SOFT = /\b(?:indicative|negotiable|flexible|open to (?:offers|proposals))\b/i;
const MONEY_WORD = /\b(?:rates?|budgets?|prices?|pricing|pay|payment|fees?|cost|compensation)\b/i;
/** A request for a price in the bid ("include ... fixed price"), as opposed to the post saying the job is fixed price. */
const ASKS_FIXED_PRICE = /\b(?:include|provide|propose|quote|state|send|give)\b[^.]{0,40}\bfixed[- ]price\b|\b(?:in your (?:proposal|bid|reply|response)|(?:i|we) need in your (?:proposal|bid))\b[^.;]{0,400}\bfixed[- ]price\b/i;
/** In the same clause, these cancel a hedge: the price is firm. */
const FIRM = /\b(?:not negotiable|non-?negotiable|fixed at|firm)\b/i;
const hedged = (description: string): boolean =>
  description.split(/(?<=[.!?])\s+|[;\n]/).some((s) => (HEDGE_SPECIFIC.test(s) || ASKS_FIXED_PRICE.test(s) || (HEDGE_SOFT.test(s) && MONEY_WORD.test(s))) && !FIRM.test(s));
const PARTIAL_WORD = /\b(?:milestones?|phases?|stages?|sprints?|iterations?|first part|initial)\b/i;
/** The partial-scope word must sit in the same clause as the hours figure it would qualify. */
const partialScope = (description: string): boolean => description.split(/[.;!?\n]/).some((c) => PARTIAL_WORD.test(c) && /\b\d{1,4}(?:\s?-\s?\d{1,4})?\s?(?:hours|hrs)\b/i.test(c));
const negotiable = (): Outcome => reviewOf('rate-unclear', NOTE_RATE_NEGOTIABLE);

function payOutcome(r: RatedGig, f: GigPack['freelance'], tiers: readonly Tier[]): Outcome {
  const { rate, gig } = r;
  // freelance-boost: a stated ceiling ("up to $X/hr") can fail the floor but never pass it on its own.
  if (rate.method === 'stated-ceiling' && rate.maxUsdH !== null) {
    if (rate.maxUsdH < f.rateFloorUsdHour) return hedged(gig.description) ? negotiable() : rejectOf(`rate-below-floor:${rate.maxUsdH}`);
    return reviewOf('ceiling-only', noteCeiling(rate.maxUsdH));
  }
  const preset = isPreset(gig, tiers);
  if (rate.method === 'unknown' || (rate.minUsdH === null && rate.maxUsdH === null)) {
    if (gig.kind === 'gig' && rate.budgetUsd !== null) {
      // A preset at or above the floor stays eligible, labelled (spec §13 D1b, user decision 2026-10-13).
      if (rate.budgetUsd >= f.fixedBudgetFloorUsd) return preset ? noteOf(NOTE_PRESET) : PASS;
      if (preset) return reviewOf('budget-preset', NOTE_PRESET);
      // A budget with a minimum and no maximum ("$300+ per post") is open-ended: the floor cannot be judged from it.
      if (gig.budget.type === 'fixed' && gig.budget.min !== null && gig.budget.max === null) return reviewOf('rate-unclear', NOTE_BUDGET_MINIMUM);
      return hedged(gig.description) ? negotiable() : rejectOf('budget-below-floor');
    }
    return reviewOf('rate-unclear', NOTE_RATE_UNKNOWN);
  }
  if (rate.maxUsdH === null || rate.maxUsdH >= f.rateFloorUsdHour) return PASS;
  // A rate worked out of a preset bracket inherits the bracket's doubt: the budget was never stated.
  if (preset && (rate.method === 'fixed÷stated-hours' || rate.method === 'derived-from-duration')) return reviewOf('budget-preset', NOTE_PRESET);
  if (hedged(gig.description)) return negotiable();
  // "This $800 covers the first milestone of about 40 hours": the hours are part of the scope, so the rate is not the job's.
  if (rate.method === 'fixed÷stated-hours' && partialScope(gig.description)) return reviewOf('rate-unclear', NOTE_PARTIAL_SCOPE);
  if (rate.method === 'stated' || (DERIVED.has(rate.method) && f.derivedRateCountsForFloor)) return rejectOf(`rate-below-floor:${rate.maxUsdH}`);
  return noteOf(NOTE_DERIVED_NOT_COUNTED);
}

/* ------------------------------------------------------------------ the decision */

/** The verdict for one rated gig under the pack's rules. Pure. It trusts `pack` to be well formed: the agent validates it first. */
export function decideGig(r: RatedGig, pack: GigPack): GigDecision {
  const g = r.gig;
  const reject = (reason: string): GigDecision => ({ verdict: 'rejected', reasons: [reason], notes: [] });
  if (g.title.trim() === '' || g.url.trim() === '') return reject('closed');
  // The v1 role filter was written for job titles and misfires on gig titles: here a match is a review, never a reject.
  const role = pack.filters.roleDeny.find((pattern) => pattern.trim() !== '' && compileSafePattern(pattern).test(g.title));
  const roleOutcome: Outcome = role === undefined ? PASS : reviewOf('role-filter', `${NOTE_ROLE_FILTER}${role}`);
  const rejectAfterRole = (reason: string): GigDecision => ({ verdict: 'rejected', reasons: [reason], notes: [...roleOutcome.notes] });
  const company = g.client.name === null ? undefined : pack.filters.companyDeny.find((name) => hasTerm(g.client.name as string, name));
  if (company !== undefined) return rejectAfterRole(`company:${company}`);
  if (forbiddenTermStrict(`${g.client.name ?? ''}\n${g.title}\n${g.description}`, pack.naming) !== undefined) return rejectAfterRole('naming');

  const outcomes = [
    roleOutcome,
    locationOutcome(g),
    hoursOutcome(g, pack.freelance.maxHoursPerWeek, youSetHours(r, pack.freelance.rateFloorUsdHour)),
    overlapOutcome(g, pack.freelance.istWindow),
    exclusiveOutcome(g),
    licensedOutcome(g),
    payOutcome(r, pack.freelance, pack.platformRules[g.platform]?.presetBrackets ?? []),
  ];
  const notes = outcomes.flatMap((o) => o.notes);
  const rejected = outcomes.find((o) => o.reject !== null);
  if (rejected?.reject != null) return { verdict: 'rejected', reasons: [rejected.reject], notes };
  const reasons = [...new Set(outcomes.flatMap((o) => (o.review === null ? [] : [o.review])))];
  return { verdict: reasons.length > 0 ? 'review' : 'eligible', reasons, notes };
}

/** The pack view, or a loud failure: without the pack there are no rules, so nothing may pass. */
function packOf(pack: unknown): GigPack {
  const view = PackView.safeParse(pack);
  if (!view.success) throw new KernelError('invalid_output', 'gig-eligibility: the pack lacks filters, naming or the freelance rules');
  return view.data;
}

export const gigEligibilityContract = defineContract({
  id: 'gig-eligibility',
  version: '1.1.0',
  description: 'Decides whether one gig is open to the candidate',
  skills: ['gig-eligibility-rules'],
  team: 'evaluation',
  kind: 'deterministic',
  consumes: RatedGig,
  produces: GigVerdict,
  capabilities: { pack: true },
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
});

export const gigEligibility = defineAgent(gigEligibilityContract, async (rated, ctx) => [{ rated, ...decideGig(rated, packOf(ctx.pack)) }]);
