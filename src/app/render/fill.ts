import { COVER_P4, renderP4, sanitisePostingText, unsafePostingText, type WorkMode } from '../agents/writing/templates.js';
import { z } from 'zod';
import { DEFAULT_PLACES, type PlaceTable } from '../geo/places.js';
import { residenceScope } from '../geo/residence.js';
import { cityKey, officeCity, officeCityDisplays } from '../text/norm.js';
import type { CoverPlan } from '../types.js';
import { coverModel, type DocModel, resumeModel } from './model.js';

/**
 * The cover letter's p4 fill (spec §3 answers.yaml, §5.4 cover-writer, cover letter v2). Only the renderer calls it,
 * and only on the last paragraph: `{city}` comes from `contact.yaml` `city` and `{notice}` from `answers.yaml`
 * `notice_period` ("30 days" reads "a 30-day notice period", any other shape "a notice period of ..."; `noticePhrase`).
 * A missing (or empty, or non-text) notice drops the notice clause, an empty city the city clause (`renderP4`); an
 * immediate notice ("immediately", "0", "none", ...) reads "available to start immediately". `eligibility.officeCities`,
 * when set, turns "a fully remote role" into "a remote role, or an office or hybrid role in <cities>"; each key resolves
 * through the residence country's office table (`eligibility.residence`, default India's; an unknown key is itself).
 * `eligibility.workModes`, when set, names only the listed modes in that role (`roleClause`); absent, the letter is
 * today's.
 * `available_from` is never read: a calendar date goes stale and would make the letter untrue. G-FILL and G-GROUND
 * re-run this from the full pack and compare. Pure.
 */

/** The answer keys the fill reads; no other answer may reach a document. */
export const FILL_KEYS = { notice: 'notice_period' } as const;

/**
 * An answer as fill text: a non-empty string or a number, trimmed, with one trailing "." or "," removed (the template
 * supplies its own punctuation, so "Immediate." does not become "Immediate.."); anything else counts as missing.
 */
function answerText(answers: Readonly<Record<string, unknown>>, key: string): string | undefined {
  if (!Object.hasOwn(answers, key)) return undefined;
  const v = answers[key];
  const s = typeof v === 'string' ? v.trim().replace(/[.,]$/, '').trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
  return s === undefined || s === '' ? undefined : s;
}

/**
 * `answers.yaml` `notice_period` as fill text (`answerText`), or undefined when missing. Throws when it cannot go into a
 * document: it must be its own sanitised form, pass the posting-slot rules and hold no brace. Shared by the daily p4
 * and (freelance-v2) the gig cover letter's availability clause.
 */
export function noticeAnswer(answers: Readonly<Record<string, unknown>>): string | undefined {
  const notice = answerText(answers, FILL_KEYS.notice);
  if (notice !== undefined) {
    const why = sanitisePostingText(notice) !== notice ? 'it changes when sanitised' : unsafePostingText(notice);
    if (why !== null || /[{}]/.test(notice)) throw new Error(`answers.yaml ${FILL_KEYS.notice} cannot go into a document (${why ?? 'it has a brace'})`);
  }
  return notice;
}

/** Characters a city may not hold: markup, template and escape characters. */
const CITY_DISALLOWED = /[<>{}`\\]/;

/** Why a contact city may not go into the letter, or null. The pack scan already checks its glyphs and forbidden terms. */
export function unsafeCity(city: string): string | null {
  if (sanitisePostingText(city) !== city) return 'it changes when sanitised';
  if (CITY_DISALLOWED.test(city)) return 'it has a markup or template character';
  const why = unsafePostingText(city);
  if (why === null || !why.startsWith('has a character outside the allowed set')) return why;
  // Only a glyph outside the posting-slot set (₹, say): every other rule still applies to the rest.
  const rest = unsafePostingText(city.replace(/[^\p{L}\p{M}\p{N}\s&,./()\-+#':;|–—[\]_%−‐"!?@*=~]/gu, ' ').replace(/\s+/gu, ' ').trim());
  return rest === 'is empty' ? null : rest;
}

/**
 * The filled p4 for `contact.city` and `answers.yaml`. Throws when p4 is not the template (the cover-writer's output
 * was changed) or when the notice or city is unsafe for a document: the notice must be its own sanitised form and pass
 * the posting-slot rules (no markup, braces, URL, pronoun, sentence break, or more than 14 words); the city likewise,
 * except that any glyph the pack scan accepts (₹, say) may stay.
 */
export function fillP4(
  p4: string,
  answers: Readonly<Record<string, unknown>>,
  city: string,
  officeCities: readonly string[] = [],
  table: PlaceTable = DEFAULT_PLACES,
  modes?: readonly WorkMode[],
): string {
  if (p4 !== COVER_P4) throw new Error('the last cover paragraph is not the availability template, so it cannot be filled');
  const notice = noticeAnswer(answers);
  const place = city.trim();
  if (place !== '') {
    const why = unsafeCity(place);
    if (why !== null) throw new Error(`contact.yaml city cannot go into the cover letter (${why})`);
  }
  const offices = officeCityDisplays(officeCities, table);
  for (const o of offices) {
    const why = o === '' ? 'it is empty' : unsafeCity(o);
    if (why !== null) throw new Error(`eligibility.yaml officeCities cannot go into the cover letter (${why})`);
  }
  // The home city is the only office city (by any of its spellings): it is named once.
  const homeIsOffice = place !== '' && offices.length === 1 && officeCities.some((k) => officeCity(k, table).aliases.includes(cityKey(place)));
  return renderP4(place === '' ? undefined : place, notice, offices, homeIsOffice, modes);
}

/** The cover plan with its last paragraph filled; every other paragraph, and the resume, unchanged. */
export function fillCover(
  cover: CoverPlan,
  answers: Readonly<Record<string, unknown>>,
  city: string,
  officeCities: readonly string[] = [],
  table: PlaceTable = DEFAULT_PLACES,
  modes?: readonly WorkMode[],
): CoverPlan {
  const last = cover.paragraphs.length - 1;
  if (last < 0) throw new Error('the cover plan has no paragraphs');
  return {
    ...cover,
    paragraphs: cover.paragraphs.map((p, i) => (i === last ? { text: fillP4(p.text, answers, city, officeCities, table, modes), factIds: [...p.factIds] } : { text: p.text, factIds: [...p.factIds] })),
  };
}

/** Whether a text still holds a placeholder brace. */
export const hasBrace = (s: string): boolean => /[{}]/.test(s);

/** What the renderer (and G-FILL) read from the full pack. */
export const RenderPack = z.object({
  contact: z.object({ name: z.string().min(1), email: z.string(), phone: z.string(), city: z.string(), links: z.array(z.string()) }),
  answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  naming: z.object({ forbiddenTerms: z.array(z.string()) }),
  eligibility: z
    .object({ officeCities: z.array(z.string()).optional(), residence: z.string().optional(), workModes: z.array(z.enum(['remote', 'office', 'hybrid'])).optional() })
    .optional(),
});
export type RenderPack = z.infer<typeof RenderPack>;

/**
 * The filled plan and both document models: what the renderer draws, and what G-FILL re-derives. Pure (no render
 * library), so the guardrail module never loads pdfkit or docx.
 */
export function renderModels(cover: CoverPlan, pack: RenderPack): { plan: CoverPlan; resume: DocModel; cover: DocModel } {
  const e = pack.eligibility;
  const plan = fillCover(cover, pack.answers, pack.contact.city, e?.officeCities ?? [], residenceScope(e?.residence ?? 'IN').table, e?.workModes);
  return { plan, resume: resumeModel(plan.resume, pack.contact), cover: coverModel(plan, pack.contact) };
}
