import { COVER_P4, COVER_P4_AVAILABILITY, COVER_P4_THANKS, RENDER_PLACEHOLDERS, sanitisePostingText, unsafePostingText } from '../agents/writing/templates.js';
import type { CoverPlan } from '../types.js';

/**
 * The cover letter's p4 fill (spec §3 answers.yaml, §5.4 cover-writer). Only the renderer calls it, and only on the
 * last paragraph: `{availableFrom}` and `{notice}` come from `answers.yaml` `available_from` and `notice_period`,
 * verbatim. When either answer is missing (or empty, or not a string or number) the availability sentence is dropped
 * and only "Thank you for your time." stays. G-FILL re-runs this from the full pack and compares. Pure.
 */

/** The answer keys the fill reads; no other answer may reach a document. */
export const FILL_KEYS = { availableFrom: 'available_from', notice: 'notice_period' } as const;

/** An answer as fill text: a non-empty string or a number, trimmed; anything else counts as missing. */
function answerText(answers: Readonly<Record<string, unknown>>, key: string): string | undefined {
  if (!Object.hasOwn(answers, key)) return undefined;
  const v = answers[key];
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
  return s === undefined || s === '' ? undefined : s;
}

/**
 * The filled p4 text. Throws when p4 is not the template (the cover-writer's output was changed) or when an answer is
 * unsafe for a document: it must be its own sanitised form and pass the posting-slot rules (no markup, braces, URL,
 * pronoun, sentence break, or more than 14 words).
 */
export function fillP4(p4: string, answers: Readonly<Record<string, unknown>>): string {
  if (p4 !== COVER_P4) throw new Error('the last cover paragraph is not the availability template, so it cannot be filled');
  const availableFrom = answerText(answers, FILL_KEYS.availableFrom);
  const notice = answerText(answers, FILL_KEYS.notice);
  if (availableFrom === undefined || notice === undefined) return COVER_P4_THANKS;
  for (const [key, value] of [[FILL_KEYS.availableFrom, availableFrom], [FILL_KEYS.notice, notice]] as const) {
    const why = sanitisePostingText(value) !== value ? 'it changes when sanitised' : unsafePostingText(value);
    if (why !== null || /[{}]/.test(value)) throw new Error(`answers.yaml ${key} cannot go into a document (${why ?? 'it has a brace'})`);
  }
  const [from, note] = RENDER_PLACEHOLDERS;
  return `${COVER_P4_AVAILABILITY.replace(from, () => availableFrom).replace(note, () => notice)} ${COVER_P4_THANKS}`;
}

/** The cover plan with its last paragraph filled; every other paragraph, and the resume, unchanged. */
export function fillCover(cover: CoverPlan, answers: Readonly<Record<string, unknown>>): CoverPlan {
  const last = cover.paragraphs.length - 1;
  if (last < 0) throw new Error('the cover plan has no paragraphs');
  return {
    ...cover,
    paragraphs: cover.paragraphs.map((p, i) => (i === last ? { text: fillP4(p.text, answers), factIds: [...p.factIds] } : { text: p.text, factIds: [...p.factIds] })),
  };
}

/** Whether a text still holds a placeholder brace. */
export const hasBrace = (s: string): boolean => /[{}]/.test(s);
