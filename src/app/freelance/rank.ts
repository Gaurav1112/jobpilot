import { canonicalJson } from '../../kernel/canonical.js';
import { IsoDateOrDateTime } from '../types.js';
import type { ScoredGig } from './types.js';

/**
 * Milliseconds of an ISO date or datetime (a datetime with no zone is UTC), or null for null or anything else.
 * `Date.parse` never sees text that is not ISO-shaped.
 */
export function isoMs(s: string | null): number | null {
  if (s === null || !IsoDateOrDateTime.safeParse(s).success) return null;
  const t = Date.parse(/T[0-9:.]+$/.test(s) ? `${s}Z` : s);
  return Number.isNaN(t) ? null : t;
}

/**
 * The deterministic order of the three lists (pure; the projector and the dashboard both call it). Within a list:
 * 1. a gig without a red flag (`off-platform`, `unusual-payment`, `upfront-fee`) before one with;
 * 2. `maxUsdH` descending, null last;
 * 3. `fit` descending;
 * 4. `postedAt` descending, null last;
 * 5. `gigKey` ascending;
 * 6. the row's canonical JSON ascending (only between rows of one gigKey, so "first wins" is independent of input order).
 *
 * A row with `fit` below `fitFloor` (`pack.freelance.fitFloor`, passed by the caller; 45 by default in the pack) is left out of `contracts` and `gigs` but kept in `review`.
 * Several rows with one `gigKey` in a list keep only the first by this order. The input is not changed.
 */
const RED = new Set(['off-platform', 'unusual-payment', 'upfront-fee']);

export interface Ranked {
  contracts: ScoredGig[];
  gigs: ScoredGig[];
  review: ScoredGig[];
}

const redFlagged = (r: ScoredGig): boolean => r.risked.flags.some((f) => RED.has(f.id));
const rateOf = (r: ScoredGig): number | null => r.risked.verdict.rated.rate.maxUsdH;
const postedMs = (r: ScoredGig): number | null => isoMs(r.risked.verdict.rated.gig.postedAt);

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
  if (ka !== kb) return ka < kb ? -1 : 1;
  // Same gigKey and every key tied (a project returned by several queries with a changed bid count): the canonical
  // JSON of the row decides, so the survivor does not depend on the input order.
  const ca = canonicalJson(a);
  const cb = canonicalJson(b);
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

export function rankGigs(rows: readonly ScoredGig[], fitFloor: number): Ranked {
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
