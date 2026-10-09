import type { Fx, Offers } from '../pack/schema.js';
import type { CompRange } from './parse.js';

export interface InrRange {
  min: number;
  max: number;
}

/** Convert an annual range into whole INR per year using the pack's fx table. */
export function toInrPerYear(range: CompRange, fx: Fx): InrRange {
  const rate = fx.toINR[range.currency];
  return { min: Math.round(range.min * rate), max: Math.round(range.max * rate) };
}

/**
 * True iff the range's upper bound is strictly below the floor. The floor is
 * an INR base-per-year amount; a non-INR floor is converted with `fx` (required then).
 */
export function belowFloor(rangeInr: InrRange, floor: NonNullable<Offers['floor']>, fx?: Fx): boolean {
  let amount = floor.amount;
  if (floor.currency !== 'INR') {
    if (fx === undefined) throw new Error(`fx is required to compare against a ${floor.currency} floor`);
    amount *= fx.toINR[floor.currency];
  }
  return rangeInr.max < amount;
}
