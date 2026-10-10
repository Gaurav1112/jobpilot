/**
 * The one label grammar for "more of this list" controls, shared by the browser provider (which clicks matching
 * buttons and reports matching controls it could not click) and by src-careers (which follows matching links).
 * Import-free, so agent code may use it; the containment scan checks it like agent code.
 */

/** "Load more", "Show 20 more", "View more jobs", "See more opportunities (12)". */
export const LOAD_MORE_LABEL = /^(load|show|view|see)\s+(\d+\s+)?more(\s+(jobs|results|openings|positions|roles|opportunities|vacancies))?(\s*\(\d+\))?$/i;

/** "Show all", "View all jobs", "See all openings (37)". */
export const SHOW_ALL_LABEL = /^(show|view|see)\s+all(\s+(jobs|openings|positions|roles|opportunities|vacancies))?(\s*\(\d+\))?$/i;

/** "Next", "Next page", "More jobs", "›", "»", ">" and "Next ›": a next-page control, never clicked, followed only as a link. */
export const NEXT_LABEL = /^(next(\s+page)?|more\s+jobs|[›»>]+)(\s*[›»>]+)?$/i;

const tidy = (label: string): string => label.replace(/\s+/g, ' ').trim();

/** A label the provider may click (load more, show all). */
export const isExpandLabel = (label: string): boolean => {
  const t = tidy(label);
  return LOAD_MORE_LABEL.test(t) || SHOW_ALL_LABEL.test(t);
};

/** A label that means "more of this list" in any form: expand labels plus next-page labels. */
export const isMoreLabel = (label: string): boolean => isExpandLabel(label) || NEXT_LABEL.test(tidy(label));
