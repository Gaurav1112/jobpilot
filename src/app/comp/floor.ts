import type { CompRange } from './parse.js';

/**
 * Pure (it imports only a type from `parse.ts`), so agent code may use it: the containment scan reads this file like
 * agent code. The pack's `Fx` and `Offers['floor']` fit these shapes structurally.
 */
type Currency = CompRange['currency'];

/** Pinned rates to INR (the pack's `fx.toINR`): the posting currencies always, any other floor currency optionally. */
export interface FxRates {
  readonly toINR: Readonly<Record<Currency, number>> & Readonly<Record<string, number>>;
}

/** The comp floor (the pack's `offers.floor`): base salary per year, in any currency `fx.toINR` has a rate for. */
export interface CompFloor {
  readonly amount: number;
  readonly currency: string;
}

export interface InrRange {
  min: number;
  max: number;
}

/** Convert an annual range into whole INR per year using the pack's fx table. */
export function toInrPerYear(range: CompRange, fx: FxRates): InrRange {
  const rate = fx.toINR[range.currency];
  return { min: Math.round(range.min * rate), max: Math.round(range.max * rate) };
}

/**
 * True iff the range's upper bound is strictly below the floor. The floor is
 * an INR base-per-year amount; a non-INR floor is converted with `fx` (required then).
 */
export function belowFloor(rangeInr: InrRange, floor: CompFloor, fx?: FxRates): boolean {
  let amount = floor.amount;
  if (floor.currency !== 'INR') {
    if (fx === undefined) throw new Error(`fx is required to compare against a ${floor.currency} floor`);
    const rate = fx.toINR[floor.currency];
    if (rate === undefined) throw new Error(`fx has no toINR rate for ${floor.currency}, the floor's currency`);
    amount *= rate;
  }
  return rangeInr.max < amount;
}
