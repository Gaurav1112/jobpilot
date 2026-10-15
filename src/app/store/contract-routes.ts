/**
 * Which daily rejections the freelance run re-reads as gigs (`AppStore.contractPostings`, then `src-board-contracts`):
 * a closed allow-list of `employment:<word>` reasons, the words the daily eligibility can name for contract-shaped
 * work (its canonical kinds, its phrases, and the pack's own `filters.employmentDeny` title words), plus one fixed
 * duration shape ("6 months", "12-month contract"). Routing only ADDS freelance inputs: nothing in the daily run reads
 * it. Freelance-boost (2026-10-15): before, only contract, freelance and part-time were routed.
 */
export const CONTRACT_REASONS: readonly string[] = ['contract', 'contractor', 'freelance', 'part-time', 'temporary', 'temp', 'fixed-term', 'contract-to-hire', 'c2h'];

/** "6 months", "6-month", "12 month contract", "3-months engagement": a fixed-length engagement (1 to 24 months). */
const DURATION = /^(?:[1-9]|1\d|2[0-4])[\s-]?months?(?:[\s-](?:contract|engagement|assignment|project))?$/;

/** Whether a daily reason routes the job to the freelance run. Case and spacing ("fixed term") are folded. */
export function routesToFreelance(reason: string): boolean {
  const m = /^employment:(.+)$/i.exec(reason.trim());
  if (m === null) return false;
  const word = (m[1] as string).trim().toLowerCase().replace(/\s+/g, ' ');
  return CONTRACT_REASONS.includes(word.replace(/ /g, '-')) || DURATION.test(word);
}
