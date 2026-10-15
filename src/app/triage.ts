/**
 * The daily loop's shared rules (UX spec U9), in ONE place: what "To decide" means and when a follow-up is due. The
 * store's SQL (`listJobsPage`) implements the same predicate and is pinned to `isToDecideFrom` by
 * tests/app/jobs-page.test.ts; Today and the nav counts (Phase B) call these too. IST calendar dates throughout.
 */
export const TO_DECIDE_DAYS = 7;
export const FOLLOW_UP_DAYS = 5;
/** Eligible (pay at or above the minimum, or not listed) or check first. */
export const DECIDE_BANDS: readonly string[] = ['disclosed', 'undisclosed', 'review'];

const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

export const istDay = (iso: string): string => new Date(Date.parse(iso) + IST_MS).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** IST midnight, TO_DECIDE_DAYS - 1 days before today (IST), as a UTC instant. */
export function toDecideFrom(now: string): string {
  return new Date(Date.parse(`${addDays(istDay(now), -(TO_DECIDE_DAYS - 1))}T00:00:00Z`) - IST_MS).toISOString();
}

export function isToDecideFrom(j: { readonly status: string; readonly band: string; readonly firstSeen: string }, fromIso: string): boolean {
  return j.status === 'new' && DECIDE_BANDS.includes(j.band) && Date.parse(j.firstSeen) >= Date.parse(fromIso);
}

export const isToDecide = (j: { readonly status: string; readonly band: string; readonly firstSeen: string }, now: string): boolean => isToDecideFrom(j, toDecideFrom(now));

/** `due = next_followup ?? applied_at + 5 d` (IST dates). `nextFollowup` is null until B7 adds the column. */
export function followUpDue(appliedAt: string, nextFollowup: string | null): string {
  return nextFollowup ?? addDays(istDay(appliedAt), FOLLOW_UP_DAYS);
}

export function isFollowUpDue(appliedAt: string | null, nextFollowup: string | null, now: string): boolean {
  return appliedAt !== null && followUpDue(appliedAt, nextFollowup) <= istDay(now);
}
