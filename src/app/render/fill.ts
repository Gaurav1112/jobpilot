import { COVER_P4, renderP4, sanitisePostingText, unsafePostingText } from '../agents/writing/templates.js';
import { z } from 'zod';
import type { CoverPlan } from '../types.js';
import { coverModel, type DocModel, resumeModel } from './model.js';

/**
 * The cover letter's p4 fill (spec §3 answers.yaml, §5.4 cover-writer, cover letter v2). Only the renderer calls it,
 * and only on the last paragraph: `{city}` comes from `contact.yaml` `city` and `{notice}` from `answers.yaml`
 * `notice_period` ("30 days" reads "a 30-day notice period", any other shape "a notice period of ..."; `noticePhrase`).
 * A missing (or empty, or non-text) notice drops the notice clause, an empty city the city clause (`renderP4`).
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

/** Characters a city may not hold: markup, template and escape characters. */
const CITY_DISALLOWED = /[<>{}`\\]/;

/** Why a contact city may not go into the letter, or null. The pack scan already checks its glyphs and forbidden terms. */
function unsafeCity(city: string): string | null {
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
export function fillP4(p4: string, answers: Readonly<Record<string, unknown>>, city: string): string {
  if (p4 !== COVER_P4) throw new Error('the last cover paragraph is not the availability template, so it cannot be filled');
  const notice = answerText(answers, FILL_KEYS.notice);
  if (notice !== undefined) {
    const why = sanitisePostingText(notice) !== notice ? 'it changes when sanitised' : unsafePostingText(notice);
    if (why !== null || /[{}]/.test(notice)) throw new Error(`answers.yaml ${FILL_KEYS.notice} cannot go into a document (${why ?? 'it has a brace'})`);
  }
  const place = city.trim();
  if (place !== '') {
    const why = unsafeCity(place);
    if (why !== null) throw new Error(`contact.yaml city cannot go into the cover letter (${why})`);
  }
  return renderP4(place === '' ? undefined : place, notice);
}

/** The cover plan with its last paragraph filled; every other paragraph, and the resume, unchanged. */
export function fillCover(cover: CoverPlan, answers: Readonly<Record<string, unknown>>, city: string): CoverPlan {
  const last = cover.paragraphs.length - 1;
  if (last < 0) throw new Error('the cover plan has no paragraphs');
  return {
    ...cover,
    paragraphs: cover.paragraphs.map((p, i) => (i === last ? { text: fillP4(p.text, answers, city), factIds: [...p.factIds] } : { text: p.text, factIds: [...p.factIds] })),
  };
}

/** Whether a text still holds a placeholder brace. */
export const hasBrace = (s: string): boolean => /[{}]/.test(s);

/** What the renderer (and G-FILL) read from the full pack. */
export const RenderPack = z.object({
  contact: z.object({ name: z.string().min(1), email: z.string(), phone: z.string(), city: z.string(), links: z.array(z.string()) }),
  answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  naming: z.object({ forbiddenTerms: z.array(z.string()) }),
});
export type RenderPack = z.infer<typeof RenderPack>;

/**
 * The filled plan and both document models: what the renderer draws, and what G-FILL re-derives. Pure (no render
 * library), so the guardrail module never loads pdfkit or docx.
 */
export function renderModels(cover: CoverPlan, pack: RenderPack): { plan: CoverPlan; resume: DocModel; cover: DocModel } {
  const plan = fillCover(cover, pack.answers, pack.contact.city);
  return { plan, resume: resumeModel(plan.resume, pack.contact), cover: coverModel(plan, pack.contact) };
}
