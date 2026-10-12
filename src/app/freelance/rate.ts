import { z } from 'zod';
import { defineAgent } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { KernelError } from '../../kernel/errors.js';
import type { Fx } from '../pack/schema.js';
import { Gig, RatedGig } from './types.js';

/**
 * The rate normalizer: any pay in USD per hour, labelled by how it was reached, or `unknown`. It never guesses.
 *
 * - `hourly` with a minimum or maximum: `stated`.
 * - `fixed`: with `hoursPerWeek.max` and `duration.weeks`, budget / (hours x weeks), `fixed÷stated-hours`; else with
 *   exactly one total-hours figure in the description (TOTAL_HOURS), budget / hours, `fixed÷stated-hours`; else with
 *   `duration.weeks` only, budget / (weeks x maxHoursPerWeek), `derived-from-duration`; else `unknown`.
 * - `monthly` with `hoursPerWeek.max`: monthly / (hours x 4.33), `monthly÷hours`; else `unknown`.
 * - A budget of type `unknown` (every boards gig, whose pay is an annual salary) is `unknown`.
 * - A bound that is not a finite number above zero, or min above max, makes the whole rate `unknown` with no budget.
 * - Money converts with the pack table: USD per unit is `toINR[c] / toINR.USD`. CAD and AUD are not in the table and
 *   Gig@1 does not carry the platform's own rate, so they are `unknown` with no budget.
 * - `fxDate` is the table's `asOf` whenever a converted (non-USD) figure is returned, else null.
 * - `budgetUsd` is the fixed or monthly budget's maximum (its minimum when there is no maximum) in USD; hourly pay has
 *   none. It is set even when the rate is `unknown`, as long as the money converted.
 * - Every figure is rounded to 2 decimals, half up.
 */

type Rate = RatedGig['rate'];

const UNKNOWN: Rate = { minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, budgetUsd: null };
const WEEKS_PER_MONTH = 4.33;

/** A total-hours phrase: "~60 hours", "80 hrs". "40 hours per week" and "20 hrs/week" are rates of work, not totals. */
const TOTAL_HOURS = /~?\s?(\d{2,4})\s?(?:hours|hrs)\b(?!\s?(?:\/|per|a)\s?week)/gi;

const round2 = (x: number): number => Math.round(x * 100 + Number.EPSILON) / 100;
const valid = (x: number | null): boolean => x === null || (Number.isFinite(x) && x > 0);

function usdPerUnit(currency: string | null, fx: Fx): number | null {
  if (currency === 'USD' || currency === 'EUR' || currency === 'GBP' || currency === 'INR') return fx.toINR[currency] / fx.toINR.USD;
  return null;
}

/** The one total-hours figure the description states, or null when it states none or several. */
function totalHours(description: string): number | null {
  const figures = new Set([...description.matchAll(TOTAL_HOURS)].map((m) => Number(m[1])).filter((n) => n > 0));
  return figures.size === 1 ? ([...figures][0] ?? null) : null;
}

export function rateOf(gig: Gig, fx: Fx, maxHoursPerWeek: number): Rate {
  const { type, min, max, currency } = gig.budget;
  if (type === 'unknown') return UNKNOWN;
  if (!valid(min) || !valid(max) || (min === null && max === null) || (min !== null && max !== null && min > max)) return UNKNOWN;
  const per = usdPerUnit(currency, fx);
  if (per === null) return UNKNOWN;
  const fxDate = currency === 'USD' ? null : fx.asOf;
  const usd = (v: number | null, divisor = 1): number | null => (v === null ? null : round2((v * per) / divisor));
  const make = (method: Rate['method'], divisor: number, budgetUsd: number | null): Rate => ({ minUsdH: usd(min, divisor), maxUsdH: usd(max, divisor), method, fxDate, budgetUsd });
  if (type === 'hourly') return make('stated', 1, null);

  const top = usd(max ?? min);
  const noRate: Rate = { minUsdH: null, maxUsdH: null, method: 'unknown', fxDate, budgetUsd: top };
  const hours = gig.hoursPerWeek.max;
  const weeks = gig.duration.weeks;
  if (type === 'monthly') return hours !== null && hours > 0 ? make('monthly÷hours', hours * WEEKS_PER_MONTH, top) : noRate;

  if (hours !== null && hours > 0 && weeks !== null && weeks > 0) return make('fixed÷stated-hours', hours * weeks, top);
  const total = totalHours(gig.description);
  if (total !== null) return make('fixed÷stated-hours', total, top);
  if (weeks !== null && weeks > 0 && Number.isFinite(maxHoursPerWeek) && maxHoursPerWeek > 0) return make('derived-from-duration', weeks * maxHoursPerWeek, top);
  return noRate;
}

/** The parts of the pack this agent reads; anything else in it is ignored. */
const PackView = z.object({
  fx: z.object({ asOf: z.string(), toINR: z.object({ USD: z.number().positive(), EUR: z.number().positive(), GBP: z.number().positive(), INR: z.number().positive() }) }),
  freelance: z.object({ maxHoursPerWeek: z.number().positive() }),
});

export const rateNormalizerContract = defineContract({
  id: 'rate-normalizer',
  version: '1.0.0',
  description: 'Turns a gig budget into dollars per hour with a method label',
  skills: ['rate-normalization'],
  team: 'understanding',
  kind: 'deterministic',
  consumes: Gig,
  produces: RatedGig,
  capabilities: { pack: true },
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
});

export const rateNormalizer = defineAgent(rateNormalizerContract, async (gig, ctx) => {
  const view = PackView.safeParse(ctx.pack);
  if (!view.success) throw new KernelError('invalid_output', 'rate-normalizer: the pack lacks fx or freelance.maxHoursPerWeek');
  return [{ gig, rate: rateOf(gig, view.data.fx as Fx, view.data.freelance.maxHoursPerWeek) }];
});
