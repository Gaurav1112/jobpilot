/**
 * The only prose in jobpilot's documents that is not a verbatim fact claim (spec §5.4, Task 9 brief). Every slot is
 * computed from the pack and the posting, and G-GROUND re-renders these templates from recomputed slots and compares.
 * Pure: no imports.
 */

/** Summary. Fewer than four covered terms drop the missing slots; none drops the "building" clause. */
export const SUMMARY_TEMPLATE = '{title} with {years}+ years building {top1}, {top2}, {top3} and {top4} systems. Currently at {employer}.';
/** Cover paragraph 1. */
export const COVER_P1 = 'I am applying for the {title} role at {company}. I am a {targetTitle} with {years}+ years of backend experience, and I work fully remote from India.';
/** Cover paragraph 2: this lead-in, then the two top-ranked facts verbatim, each its own sentence. */
export const COVER_P2_LEAD = 'Relevant work:';
/** Cover paragraph 3: the third fact verbatim, then this sentence. */
export const COVER_P3_TAIL = 'The role asks for {coveredList}; each appears in the work above.';
/**
 * Cover paragraph 4. The cover-writer reads only the public pack, and `answers.yaml` (P1/P2) is not in it, so it
 * leaves `{availableFrom}` and `{notice}` as literal placeholders. The renderer (Task 10, full pack) fills them from
 * `answers.yaml` keys `available_from` and `notice_period`; when either key is missing it omits the first sentence
 * ("I am available ... {notice}.") and keeps "Thank you for your time." G-GROUND checks the placeholders are intact.
 */
export const COVER_P4 = 'I am available from {availableFrom}, with a notice period of {notice}. Thank you for your time.';

/** The words of `COVER_P4` the renderer fills, as they appear in the plan. */
export const RENDER_PLACEHOLDERS = ['{availableFrom}', '{notice}'] as const;

/** "a", "a and b", "a, b and c": items joined with ", " and a final " and ". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`;
}

/** Replaces each `{name}` with its slot; a slot that is not given is an error (templates never render half-filled). */
export function fill(template: string, slots: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([A-Za-z0-9]+)\}/g, (_m, name: string) => {
    if (!Object.hasOwn(slots, name)) throw new Error(`template slot {${name}} has no value`);
    return String(slots[name]);
  });
}

/** The summary slots: `top1`..`top4` hold up to four covered terms in order; `employer` only when a role is ongoing. */
export interface SummarySlots {
  readonly title: string;
  readonly years: number;
  readonly top1?: string;
  readonly top2?: string;
  readonly top3?: string;
  readonly top4?: string;
  readonly employer?: string;
}

/**
 * Renders `SUMMARY_TEMPLATE`. With fewer than four terms the missing slots are dropped and the rest joined with ", "
 * and " and " (one term: "building java systems"); with none the clause " building ... systems" is dropped. Without
 * an `employer` slot (no ongoing role) the sentence " Currently at ..." is dropped, since it would be untrue.
 */
export function renderSummary(s: Readonly<SummarySlots>): string {
  const terms = [s.top1, s.top2, s.top3, s.top4].filter((t): t is string => t !== undefined);
  const building = terms.length > 0 ? ` building ${joinList(terms)} systems` : '';
  const current = s.employer !== undefined ? ` ${fill('Currently at {employer}.', { employer: s.employer })}` : '';
  return `${fill('{title} with {years}+ years', { title: s.title, years: s.years })}${building}.${current}`;
}

/** A claim as its own sentence: verbatim, with a full stop added only when it has no closing punctuation. */
export const asSentence = (claim: string): string => (/[.!?]["')\]]?$/.test(claim) ? claim : `${claim}.`);
