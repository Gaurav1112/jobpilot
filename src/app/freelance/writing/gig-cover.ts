import { COMPACT, hasOngoingRole, planCover, planResume, type WritingPack } from '../../agents/writing/grounded.js';
import { COVER_P4_THANKS, fill, sanitisePostingText, unsafePostingText } from '../../agents/writing/templates.js';
import { forbiddenTermStrict } from '../../pack/rules.js';
import { planHasBullets, type CoverPlan, type Posting, type ResumePlan } from '../../types.js';
import type { Gig, Platform } from '../types.js';
import { evidenceFor, syntheticPosting } from './gig-evidence.js';

/**
 * The cover letter of a contract role from an employer job board (freelance-v2, Feature 2). Contract roles on employer
 * boards are applied for on the employer's own form, which wants a cover letter, so they get the daily pipeline's
 * letter in addition to the pitch and the contract CV. Pure and deterministic; G-GROUND (`gigDocsProblems`) re-derives
 * it with these functions.
 *
 * - **Which gigs** (`getsCover`): kind `contract` from an employer job board (`COVER_PLATFORMS`): `boards` (the daily
 *   contract postings, mostly Himalayas) and `himalayas` (src-himalayas-gigs). In any list (contracts, gigs, review),
 *   at or above the freelance fit floor like every gig document (proposal-planner's `belowFitFloor`).
 * - **The posting.** The gig's synthetic posting (`gigPostingOf`, the one the contract CV is planned from) named for the
 *   real company, `client.name`, its title without pictographs (`coverTitleOf`: "🌍 Senior Engineer" is named
 *   "Senior Engineer"). The scorer never reads the company, so the Evidence, and with the compact budget
 *   (`COMPACT`) the resume plan's bullets, are the contract CV's: the letter cites what the CV sent with it shows.
 * - **No cover** (the plan leaves `cover` out and names why in `coverNote`, `COVER_NOTES`) when the gig has no company,
 *   when the title or company states pay or hours (`PAY_OR_HOURS`), when the sanitised title or company is not
 *   safe for a template slot (`unsafePostingText`), names a forbidden term (strict), or has a character outside the
 *   Latin, Greek and Cyrillic ranges the embedded font draws (`NAMEABLE`), or when no bullet backs the letter (the
 *   daily cover-writer's `plan.has-bullets`). The pitch and CV are planned either way.
 * - **The letter** is `planCover` (the daily cover-writer's rules: p1 opening, employer-anchored evidence, the
 *   signature fact), then its availability paragraph is the contract one (`gigCoverP4`): the freelance pack's
 *   `maxHoursPerWeek` and `istWindow`, "alongside my current role" only when a role is ongoing, and `{city}` left for the
 *   gig renderer (contact.yaml is P1), and `{notice}` for the availability clause from answers.yaml notice_period (the
 *   daily phrasing, `availabilityClause`). It never states the role's pay or hours: no slot reads the budget or the
 *   hours, and a title or company that states them gets no letter.
 */

/** The employer job boards whose contract roles get a cover letter. */
export const COVER_PLATFORMS: readonly Platform[] = ['boards', 'himalayas'];

/** Whether a gig's kind and platform get a cover letter. */
export const getsCover = (gig: Pick<Gig, 'kind' | 'platform'>): boolean => gig.kind === 'contract' && COVER_PLATFORMS.includes(gig.platform);

/** The placeholders the gig renderer fills from `contact.yaml` city and `answers.yaml` notice_period (both P1). */
export const CITY_PLACEHOLDER = '{city}';
export const NOTICE_PLACEHOLDER = '{notice}';
/**
 * The contract availability paragraph, before the thanks; `{city}` and `{notice}` stay for the renderer, the rest is
 * filled from the pack. The renderer drops the clause of a missing city or notice (`fillGigCoverP4`).
 */
export const GIG_COVER_P4_CITY = "I'm based in {city}, {notice}, and can work up to {maxHoursPerWeek} hours a week{alongside}, mostly {istWindow} IST.";
/** Said only when a role is ongoing (the freelance work runs alongside it). */
export const ALONGSIDE = ' alongside my current role';
/** The planned opening, up to the hours, that the renderer rewrites. */
const PLANNED_LEAD = `I'm based in ${CITY_PLACEHOLDER}, ${NOTICE_PLACEHOLDER}, and can `;

/** The planned availability paragraph: see the module rules. */
export function gigCoverP4(rules: { readonly maxHoursPerWeek: number; readonly istWindow: string }, pack: WritingPack): string {
  const first = fill(GIG_COVER_P4_CITY, {
    city: CITY_PLACEHOLDER,
    notice: NOTICE_PLACEHOLDER,
    maxHoursPerWeek: rules.maxHoursPerWeek,
    istWindow: rules.istWindow,
    alongside: hasOngoingRole(pack) ? ALONGSIDE : '',
  });
  return `${first} ${COVER_P4_THANKS}`;
}

/**
 * The planned availability paragraph filled: `city` (already checked safe by the caller, '' for none) and `available`
 * (the availability clause of the notice, `availabilityClause`, or undefined for none), each clause dropped when
 * missing: "I'm based in Pune, available after a 30-day notice period, and can ...", "I'm based in Pune and can ...",
 * "I'm available to start immediately and can ...", "I can ...". Throws when `p4` is not a planned paragraph (its
 * opening, with exactly one `{city}` and one `{notice}`).
 */
export function fillGigCoverP4(p4: string, city: string, available: string | undefined): string {
  if (!p4.startsWith(PLANNED_LEAD) || p4.split(CITY_PLACEHOLDER).length !== 2 || p4.split(NOTICE_PLACEHOLDER).length !== 2) {
    throw new Error('the last cover paragraph is not the contract availability template, so it cannot be filled');
  }
  const lead =
    city !== '' && available !== undefined ? "I'm based in " + city + ', ' + available + ', and can '
    : city !== '' ? "I'm based in " + city + ' and can '
    : available !== undefined ? "I'm " + available + ' and can '
    : 'I can ';
  return lead + p4.slice(PLANNED_LEAD.length);
}

/** What the embedded font draws for sure: Latin (to Extended-B), combining marks, Greek, Cyrillic, dashes and the minus. */
const NAMEABLE = /^[ -~\u00a0-\u024f\u0300-\u036f\u0370-\u03ff\u0400-\u04ff\u2010-\u2014\u2212]*$/u;

/** Whether a title or company can go into the letter's p1: see the module rules. */
export function nameable(s: string, forbiddenTerms: readonly string[]): boolean {
  const shown = sanitisePostingText(s);
  if (unsafePostingText(shown) !== null || !NAMEABLE.test(shown)) return false;
  return forbiddenTermStrict(s, { forbiddenTerms }) === undefined && forbiddenTermStrict(shown, { forbiddenTerms }) === undefined;
}

/**
 * The role title a cover letter names: the gig title without pictographs (emoji such as a globe some boards put before
 * a title), their variation selectors and joiners, whitespace collapsed. Every other character is kept, so it is the
 * title the employer wrote, minus decoration; `nameable` still decides whether it can be named at all.
 */
export const coverTitleOf = (title: string): string =>
  title.replace(/[\p{Extended_Pictographic}\ufe0f\u200d]/gu, ' ').replace(/\s+/gu, ' ').trim();

/** The company a cover letter names: the gig's client name, trimmed, or null. */
export const companyOf = (gig: Gig): string | null => {
  const n = gig.client.name?.trim() ?? '';
  return n === '' ? null : n;
};

/**
 * The gig's synthetic posting: key the gigKey, title the gig title, text the description plus the skills line (as the
 * gig scorer reads it), firstSeen the gig's `postedAt` (else the first day of the pack's asOf month), and `company`.
 * The contract CV names the platform; the cover letter names the real company.
 */
export function gigPostingOf(gig: Gig, pack: WritingPack, company: string, title: string = gig.title): Posting {
  return syntheticPosting({
    key: gig.gigKey,
    title,
    company,
    text: gig.skills.length === 0 ? gig.description : `${gig.description}\n${gig.skills.join(', ')}`,
    firstSeen: gig.postedAt ?? `${pack.experience.asOf}-01`,
  });
}

/** The cover letter's resume plan: the compact plan of the gig's posting named for the company, its title `coverTitleOf`. */
export const gigCoverResume = (gig: Gig, company: string, pack: WritingPack, rawPack: unknown): ResumePlan =>
  planResume(evidenceFor(gigPostingOf(gig, pack, company, coverTitleOf(gig.title)), pack, rawPack), pack, COMPACT);

/**
 * Pay or hours stated in a title or company (freelance-v2 review): a currency sign or code, a rate unit ("per hour",
 * "/hr", "/month"), or a number of hours ("20 hours", "10-20 hrs/week"). The letter's p1 names the title and company
 * verbatim, so such a title would put the role's pay or hours into the letter: it gets no letter instead. gig-qa runs
 * the same test on every rendered letter's opening (`cover.no-terms`).
 */
export const PAY_OR_HOURS =
  /[$€£₹]|\b(?:usd|inr|eur|gbp|lpa|ctc)\b|\bper\s+(?:hour|hr|day|week|month|annum|year)\b|\/\s*(?:hr|hrs|hour|h|day|wk|week|mo|month|year|yr)\b|\b\d+\s*\+?\s*(?:[-–]\s*\d+\s*)?(?:hours?|hrs?)\b|\b\d+\s*h\s*(?:\/|per)\s*(?:week|wk)\b/i;

/** Why a gig from an employer job board gets no cover letter (`GigDocsPlan.coverNote`). */
export const COVER_NOTES = {
  noCompany: 'the posting names no company',
  payOrHours: 'title states pay or hours',
  unsafe: 'the title or company cannot go into a letter',
  noFacts: 'no verified fact backs a letter for it',
} as const;

/** The planned cover letter of one gig, or the named reason it gets none; undefined for a gig that never gets one. */
export function planGigCover(
  gig: Gig,
  pack: WritingPack,
  rawPack: unknown,
  rules: { readonly maxHoursPerWeek: number; readonly istWindow: string },
): { readonly cover: CoverPlan } | { readonly note: string } | undefined {
  if (!getsCover(gig)) return undefined;
  const company = companyOf(gig);
  if (company === null) return { note: COVER_NOTES.noCompany };
  const title = coverTitleOf(gig.title);
  if (PAY_OR_HOURS.test(title) || PAY_OR_HOURS.test(company)) return { note: COVER_NOTES.payOrHours };
  if (!nameable(company, pack.naming.forbiddenTerms) || !nameable(title, pack.naming.forbiddenTerms)) return { note: COVER_NOTES.unsafe };
  const resume = gigCoverResume(gig, company, pack, rawPack);
  if (!planHasBullets.test(resume)) return { note: COVER_NOTES.noFacts };
  return { cover: gigCoverOf(resume, pack, rules) };
}

/** The cover letter of a resume plan: `planCover`, its availability paragraph the contract one (`gigCoverP4`). */
export function gigCoverOf(resume: ResumePlan, pack: WritingPack, rules: { readonly maxHoursPerWeek: number; readonly istWindow: string }): CoverPlan {
  const cover = planCover(resume, pack);
  const last = cover.paragraphs.length - 1;
  return { ...cover, paragraphs: cover.paragraphs.map((p, i) => (i === last ? { text: gigCoverP4(rules, pack), factIds: [] } : p)) };
}
