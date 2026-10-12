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
 * 6. overlap-outside-ist-window: only a window of at least 4 hours, stated with a time zone, after a word saying
 *    online / available / working in the same sentence. Fixed offsets (EST -5, EDT -4, ET -4, CST -6, PST -8, PDT -7,
 *    PT -7, CET +1, CEST +2, GMT/UTC 0, BST +1, IST +5.5) put it on IST. A bare "9-5" reads as business hours
 *    (9am-5pm). It rejects when every such window shares less than 2 hours with `freelance.istWindow`. A sentence
 *    saying async, flexible, some overlap, preferred or ideally voids its windows, and so does one about the
 *    company's own hours ("we are available 9-5 PST") unless it addresses the candidate. A zone named without a
 *    window we can read, or a window under 4 hours (a call slot), adds `overlap stated - verify` and nothing else.
 * 7. exclusive: the candidate may not work for others ("cannot work for other clients", "exclusive contractor",
 *    "work exclusively for us"). "Exclusive rights", "non-exclusive" and "exclusively for Android" are not that. Weaker
 *    wording about the person ("exclusivity expected from the developer", "an exclusive engagement") is review.
 * 8. budget-below-floor: kind `gig`, rate unknown, `budgetUsd` below `fixedBudgetFloorUsd`. A kind `gig` with a budget
 *    at or above the floor is eligible on that, with the rate left unknown. A fixed budget whose raw currency, minimum
 *    and maximum are exactly one of the platform's `platformRules.<platform>.presetBrackets` is no stated budget: it is
 *    review (`budget-preset`, note `preset bracket - bids may exceed it`), never rejected.
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
interface Outcome {
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
export const NOTE_EXCLUSIVITY = 'exclusivity wording - verify';
export const NOTE_PRESET = 'preset bracket - bids may exceed it';
export const NOTE_ROLE_FILTER = 'title matches your role filter: ';
export const NOTE_PARTIAL_SCOPE = 'stated hours may cover part of the scope - verify';
export const NOTE_RATE_NEGOTIABLE = 'rate negotiable - verify';
export const NOTE_LOCATION_ZONES = 'location field names time zones - verify';
export const NOTE_RATE_UNKNOWN = 'rate unknown - verify';
export const NOTE_DERIVED_NOT_COUNTED = 'derived rate below floor - not counted';

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
    '\\bmust (?:be )?(?:based|located|residing|living|resident) in (?:the )?(?:US|USA|U\\.S\\.|UK|EU|Europe|United States|Canada)\\b',
    '\\b(?:European|American|US|EU|UK|EMEA|Americas) time ?zones? only\\b',
    '\\b(?:in|within) (?:the )?time ?zones?:? (?:GMT|UTC)\\s?[+\\-\\u2212]\\d',
  ].join('|'),
);

const TIMEZONE_WORDS = /\b(?:time ?zones?|hours?)\b/i;
const TIMEZONE_ABBREVIATIONS = /\b(?:EST|EDT|PST|PDT|CET|CEST|GMT|UTC|PT|ET|IST)\b/;

/**
 * "You must be located in the US": a requirement on the candidate, in words. Case-sensitive for the abbreviations. Not when
 * negated, and not when the same sentence names India or somewhere wider ("or India", "or anywhere").
 */
const RESIDENCE = /\b(?:[Yy]ou|[Tt]he (?:freelancer|developer|contractor)|[Cc]andidates?|[Aa]pplicants?|[Ff]reelancers?)\s+(?:must|need to|have to|should)\s+(?:be\s+)?(?:based|located|resident|residing|living)\s+in\s+(?:the\s+)?(?:US|USA|U\.S\.|United States|UK|Canada|EU|Europe)\b/;
const WIDER = /\b(?:india|asia|apac|worldwide|anywhere|or elsewhere|globally|global)\b/i;
function residenceStated(description: string): boolean {
  return description.split(/(?<=[.!?])\s+|\n/).some((sentence) => {
    const m = RESIDENCE.exec(sentence);
    return m !== null && !NEGATION.test(sentence.slice(0, m.index)) && !WIDER.test(sentence) && !/\bnot\b/i.test(sentence);
  });
}

/** The gig's own location data does not already put India in scope. */
const indiaNotInScope = (g: Gig): boolean => !inScope(g.location.countries);

function locationOutcome(g: Gig): Outcome {
  const { countries, worldwide, text } = g.location;
  if (indiaNotInScope(g) && residenceStated(g.description)) return rejectOf('location-outside-india');
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
    if (!confirmed || CEILING_BEFORE.test(before) || CEILING_AFTER.test(afterRaw) || HABITUAL.test(`${before} ${after}`) || CONDITIONAL.test(`${before} ${after}`)) return 'unclear';
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
const FULL_TIME_SOFT = /\b(?:or|and\/or|either|part[\s-]?time|prefer(?:red)?|ideally|possible|path|then|may|might|could|can be|optional|option|flexible|negotiable|not|non|no|never|rather than|instead of|convert|conversion|eventually|potential|after|starting|until|without|unlike|instead|have|has|keep|alongside|if|with|previously|elsewhere|current|day job|while|besides|in addition to|welcome|welcomed|welcomes)\b|\b\w+n['’]t\b|\//i;

/** `yes`: a "full-time" is tied to this engagement and not hedged; `unclear`: one is hedged; `no`: none is tied to it (boilerplate, or none). */
function fullTime(text: string): 'yes' | 'unclear' | 'no' {
  const spans: [number, number][] = [];
  for (const shape of FULL_TIME_SHAPES) for (const m of text.matchAll(shape)) spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  let result: 'yes' | 'unclear' | 'no' = 'no';
  for (const m of text.matchAll(FULL_TIME)) {
    const at = m.index ?? 0;
    if (!spans.some(([lo, hi]) => lo <= at && at < hi)) continue;
    // The mention's own clause: between the nearest sentence ends or `|`, at most 50 characters either way.
    const left = text.slice(Math.max(0, at - 50), at).search(/[^.;!?\n|]*$/);
    const rightRaw = text.slice(at + m[0].length, at + m[0].length + 50);
    const rightEnd = rightRaw.search(/[.;!?\n|]/);
    const clause = text.slice(Math.max(0, at - 50) + left, at + m[0].length) + (rightEnd === -1 ? rightRaw : rightRaw.slice(0, rightEnd));
    if (FULL_TIME_SOFT.test(clause) || rightRaw[rightEnd] === '?') return 'unclear';
    result = 'yes';
  }
  return result;
}

function hoursOutcome(g: Gig, cap: number): Outcome {
  if (g.kind !== 'contract') return PASS;
  const text = `${g.title}\n${g.description}`;
  let min = g.hoursPerWeek.min;
  if (min === null) {
    const plus = new Set([...g.description.matchAll(PLUS_HOURS)].map((m) => Number(m[1])));
    if (plus.size === 1) min = [...plus][0] ?? null;
  }
  const ft = fullTime(text);
  if (min !== null) {
    if (min > cap) {
      const status = figureStatus(g.description, min);
      return status === 'unclear' ? reviewOf('hours-unclear', NOTE_HOURS_UNCLEAR) : rejectOf('hours-over-cap');
    }
    return ft === 'yes' ? reviewOf('hours-unclear', NOTE_HOURS_CONFLICT) : PASS;
  }
  return ft === 'yes' ? rejectOf('hours-over-cap') : reviewOf('hours-unclear', NOTE_HOURS_UNKNOWN);
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
 * A window counts only when the REQUIRED party is the candidate, in a requirement shape: "you must be online ...",
 * "the developer should be available ...", "we need you to be online ...", or an imperative sentence ("Must be online
 * ...", "Available 9-5 CET"). A window whose subject is I / my / we / our / the team / support / customers / users is the
 * client's own hours, not a requirement on you.
 */
const SUBJECT = '(?:you|(?:the\\s+)?(?:freelancers?|developers?|contractors?|engineers?|candidates?))';
const REQUIREMENT = new RegExp(
  `\\b${SUBJECT}\\s+(?:must|will need to|are required to|is required to|need to|needs to|should|have to|has to|will be|are expected to|is expected to)\\s+(?:be\\s+)?(?:online|available|work(?:ing)?|reachable|present)\\b|\\b(?:need|require|expect|want)s?\\s+${SUBJECT}\\s+to\\s+(?:be\\s+)?(?:online|available|work(?:ing)?|reachable)\\b`,
  'gi',
);
const IMPERATIVE = /^\W*(?:(?:must|should|need to|required to|has to|have to)\s+)?(?:be\s+)?(?:online|available|working|on call|reachable)\b/i;
const REQUIRED_AFTER = /^[^.]{0,30}?\b(?:are|is)\s+(?:required|mandatory|needed)\b/i;
/** A short or rare meeting inside the sentence ("a weekly 30 minute sync", "for a call", "two days a week") is not a working-hours requirement. */
const SYNC = /\b(?:sync|calls?|meetings?|stand-?ups?|catch-?ups?|check-?ins?|once a week|once per week|twice a week|weekly|monthly|(?:one|two|three|\d) days? (?:a|per|each) week)\b/i;
/** Time zone names written out: "Pacific time" is PT, "Eastern time" is ET (the brief's fixed offsets). */
const ZONE_NAMES: readonly [RegExp, string][] = [[/\bPacific (?:Standard |Daylight )?[Tt]ime\b/g, 'PT'], [/\bEastern (?:Standard |Daylight )?[Tt]ime\b/g, 'ET']];

function isRequirement(sentence: string, at: number): boolean {
  const prefix = sentence.slice(Math.max(0, at - 70), at);
  const near = [...prefix.matchAll(REQUIREMENT)].some((m) => prefix.length - ((m.index ?? 0) + m[0].length) <= 60);
  return near || IMPERATIVE.test(sentence) || (/\bhours?\b/i.test(prefix) && REQUIRED_AFTER.test(sentence.slice(at)));
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
  for (const sentence of raw.split(/(?<=[.!?])\s+|\n/)) {
    if (VOID_OVERLAP.test(sentence)) continue;
    let rangeHere = false;
    for (const m of sentence.matchAll(RANGE)) {
      rangeHere = true;
      const at = m.index ?? 0;
      if (!isRequirement(sentence, at) || SYNC.test(sentence)) continue;
      const w = parseWindow(m);
      if (w === null || w.dur < MIN_WINDOW_MIN) {
        unparsed = true;
        continue;
      }
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
  if (shares.length > 0 && shares.every((s) => s < MIN_SHARE_MIN)) return rejectOf('overlap-outside-ist-window');
  return unparsed ? noteOf(NOTE_OVERLAP) : PASS;
}

/* ------------------------------------------------------------------ 7. exclusive */

/**
 * The person may not work for anyone else. "Exclusive rights", "non-exclusive" and "exclusively for Android" are not
 * that, and a match counts only as a requirement on the candidate (see `exclusiveOutcome`).
 */
const STRONG_EXCLUSIVE =
  /\b(?:(?:must not|cannot|can't|can not|may not|not allowed to|not permitted to|no)\s+(?:work|hold|have|take(?: on)?)\s+(?:for\s+)?(?:any\s+)?(?:other|another)\s+(?:jobs?|employment|employers?|clients?|projects?|commitments?)|no other (?:clients?|jobs?|employment|employers?|projects?) (?:while|during|whilst)|(?<!non[-\s])exclusive\s+contractor(?!\s+(?:agreement|deal|arrangement|status))|work(?:ing)?\s+exclusively\s+(?:for|with)\s+(?:us|the client|our)|(?:sole|only)\s+employer)\b/gi;
/** In the sentence before the match: a negation anywhere voids it ("you do not need to be an exclusive contractor"). */
const NEGATION = /\b(?:not|no|never|without|nor)\b|n['’]t\b/i;
/** Who is bound: you / the freelancer / ..., or the client asking for a hire ("we need an exclusive contractor"). */
const BOUND = /\b(?:you|your|freelancers?|contractors?|developers?|candidates?|engineers?)\b|\b(?:we|i)\s+(?:need|want|seek|require|are looking for|am looking for|will hire|hire)\b/i;
const WEAK_EXCLUSIVE = /(?<!non[-\s])\bexclusiv(?:e|ity)\b/i;
const ABOUT_THE_PERSON = /\b(?:you|your|freelancer|contractor|candidate|developer|engineer|availability|full[\s-]?time|commitment|engagement|work for|worker|resource)\b/i;
const ABOUT_RIGHTS = /\b(?:rights?|licen[sc]\w*|ownership|ip|copyright|source code|code|domain|distribution|resale|territor\w*|intellectual|patent|trademark|content|design|assets?)\b/i;

function exclusiveOutcome(g: Gig): Outcome {
  for (const sentence of g.description.split(/(?<=[.!?])\s+|\n/)) {
    for (const m of sentence.matchAll(STRONG_EXCLUSIVE)) {
      const prefix = sentence.slice(0, m.index ?? 0);
      if (NEGATION.test(prefix)) continue;
      // An imperative has no subject ("Cannot work for other clients"); anything else needs a person or a hiring client.
      if (prefix.replace(/\b(?:please|also|note|and|but|so|that)\b|[^\w]/gi, '') === '' || BOUND.test(prefix)) return rejectOf('exclusive');
    }
  }
  const weak = g.description.split(/(?<=[.!?])\s+|\n/).some((s) => WEAK_EXCLUSIVE.test(s) && ABOUT_THE_PERSON.test(s) && !ABOUT_RIGHTS.test(s));
  return weak ? reviewOf('exclusivity-unclear', NOTE_EXCLUSIVITY) : PASS;
}

/* ------------------------------------------------------------------ 8-9. pay */

const DERIVED: ReadonlySet<RatedGig['rate']['method']> = new Set(['fixed÷stated-hours', 'derived-from-duration', 'monthly÷hours']);

/** The raw budget (before any conversion) is exactly one of the platform's fixed tiers: the client did not state a real budget. */
function isPreset(g: Gig, tiers: readonly Tier[]): boolean {
  const { currency, min, max, type } = g.budget;
  return type === 'fixed' && currency !== null && min !== null && tiers.some((t) => t.type === 'fixed' && t.min === min && t.max === max && (t.currencies === '*' || t.currencies.includes(currency)));
}

/** The price is open to the bidder's proposal: "indicative only", "rate negotiable", "quote your rate", "budget is flexible". */
const HEDGE_SPECIFIC = /\b(?:quote your (?:own )?(?:hourly )?rate|your (?:own )?(?:hourly )?rate|different rate|name your (?:own )?(?:price|rate)|propose (?:a|your) (?:own )?(?:rate|price))\b|\b(?:state|share|include|send|provide|give|tell|quote|propose|let|your)\b[^.]{0,60}\b(?:hourly|project[- ]based|expected|desired)(?: or \w[\w-]*)? (?:rate|price)\b/i;
const HEDGE_SOFT = /\b(?:indicative|negotiable|flexible|open to (?:offers|proposals))\b/i;
const MONEY_WORD = /\b(?:rates?|budgets?|prices?|pricing|pay|payment|fees?|cost|compensation)\b/i;
const hedged = (description: string): boolean => description.split(/(?<=[.!?])\s+|\n/).some((s) => HEDGE_SPECIFIC.test(s) || (HEDGE_SOFT.test(s) && MONEY_WORD.test(s)));
const PARTIAL_SCOPE = /\b(?:milestones?|phases?|stages?|sprints?|iterations?|first part|initial)\b/i;
const negotiable = (): Outcome => reviewOf('rate-unclear', NOTE_RATE_NEGOTIABLE);

function payOutcome(r: RatedGig, f: GigPack['freelance'], tiers: readonly Tier[]): Outcome {
  const { rate, gig } = r;
  const preset = isPreset(gig, tiers);
  if (rate.method === 'unknown' || (rate.minUsdH === null && rate.maxUsdH === null)) {
    if (gig.kind === 'gig' && rate.budgetUsd !== null) {
      if (rate.budgetUsd >= f.fixedBudgetFloorUsd) return PASS;
      if (preset) return reviewOf('budget-preset', NOTE_PRESET);
      return hedged(gig.description) ? negotiable() : rejectOf('budget-below-floor');
    }
    return reviewOf('rate-unclear', NOTE_RATE_UNKNOWN);
  }
  if (rate.maxUsdH === null || rate.maxUsdH >= f.rateFloorUsdHour) return PASS;
  // A rate worked out of a preset bracket inherits the bracket's doubt: the budget was never stated.
  if (preset && (rate.method === 'fixed÷stated-hours' || rate.method === 'derived-from-duration')) return reviewOf('budget-preset', NOTE_PRESET);
  if (hedged(gig.description)) return negotiable();
  // "This $800 covers the first milestone of about 40 hours": the hours are part of the scope, so the rate is not the job's.
  if (rate.method === 'fixed÷stated-hours' && PARTIAL_SCOPE.test(gig.description)) return reviewOf('rate-unclear', NOTE_PARTIAL_SCOPE);
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
    hoursOutcome(g, pack.freelance.maxHoursPerWeek),
    overlapOutcome(g, pack.freelance.istWindow),
    exclusiveOutcome(g),
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
  version: '1.0.0',
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
