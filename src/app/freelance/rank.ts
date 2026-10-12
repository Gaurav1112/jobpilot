import type { ScoredGig } from './types.js';

/**
 * The deterministic order of the three lists (pure; the projector and the dashboard both call it). Within a list:
 * 1. a gig without a red flag (`off-platform`, `unusual-payment`, `upfront-fee`) before one with;
 * 2. `maxUsdH` descending, null last;
 * 3. `fit` descending;
 * 4. `postedAt` descending, null last;
 * 5. `gigKey` ascending.
 *
 * A row with `fit` below `fitFloor` (the spec's 60) is left out of `contracts` and `gigs` but kept in `review`.
 * Several rows with one `gigKey` in a list keep only the first by this order. The input is not changed.
 */
const RED = new Set(['off-platform', 'unusual-payment', 'upfront-fee']);

export const FIT_FLOOR = 60;

export interface Ranked {
  contracts: ScoredGig[];
  gigs: ScoredGig[];
  review: ScoredGig[];
}

const redFlagged = (r: ScoredGig): boolean => r.risked.flags.some((f) => RED.has(f.id));
const rateOf = (r: ScoredGig): number | null => r.risked.verdict.rated.rate.maxUsdH;
const postedMs = (r: ScoredGig): number | null => {
  const p = r.risked.verdict.rated.gig.postedAt;
  if (p === null) return null;
  const t = Date.parse(p);
  return Number.isNaN(t) ? null : t;
};

/** Descending on a nullable number, null last. */
function descNullLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function compare(a: ScoredGig, b: ScoredGig): number {
  const red = Number(redFlagged(a)) - Number(redFlagged(b));
  if (red !== 0) return red;
  const rate = descNullLast(rateOf(a), rateOf(b));
  if (rate !== 0) return rate;
  if (a.fit !== b.fit) return b.fit - a.fit;
  const posted = descNullLast(postedMs(a), postedMs(b));
  if (posted !== 0) return posted;
  const ka = a.risked.verdict.rated.gig.gigKey;
  const kb = b.risked.verdict.rated.gig.gigKey;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function rankGigs(rows: readonly ScoredGig[], fitFloor: number = FIT_FLOOR): Ranked {
  const out: Ranked = { contracts: [], gigs: [], review: [] };
  for (const list of ['contracts', 'gigs', 'review'] as const) {
    const kept = rows.filter((r) => r.list === list && (list === 'review' || r.fit >= fitFloor)).sort(compare);
    const seen = new Set<string>();
    for (const r of kept) {
      const k = r.risked.verdict.rated.gig.gigKey;
      if (seen.has(k)) continue;
      seen.add(k);
      out[list].push(r);
    }
  }
  return out;
}
