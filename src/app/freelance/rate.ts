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
 *   exactly one total-hours figure or range with an effort cue in the description (see `totalHours`), budget / hours, `fixed÷stated-hours`
 *   (a range "N-M hours" gives minUsdH = min budget / M and maxUsdH = max budget / N); else with `duration.weeks` only,
 *   budget / (weeks x maxHoursPerWeek), `derived-from-duration`; else `unknown`.
 * - `monthly` with `hoursPerWeek.max`: monthly / (hours x 4.33), `monthly÷hours`; else `unknown`.
 * - A budget of type `unknown` (every boards gig, whose pay is an annual salary) is `unknown`, and so is any gig whose
 *   description says the bidder sets the price (NO_BUDGET): the platform's bracket is then not an offer.
 * - A bound that is not a finite number above zero, or min above max, makes the whole rate `unknown` with no budget.
 * - Money converts with the pack table first (USD per unit is `toINR[c] / toINR.USD`, `fxSource: 'pack'`, `fxDate` the
 *   table's `asOf`). A currency the table lacks (CAD, AUD, SGD, NZD, HKD) converts with the platform's own
 *   `budget.usdPerUnit` when it is a finite number above zero (`fxSource: 'platform'`, no `fxDate`), else it is
 *   `unknown` with no budget. USD needs no conversion (`fxSource` null).
 * - `budgetUsd` is the fixed or monthly budget's maximum (its minimum when there is no maximum) in USD; hourly pay has
 *   none. It is set even when the rate is `unknown`, as long as the money converted.
 * - Every figure is rounded to 2 decimals, half up (`round2`).
 */

type Rate = RatedGig['rate'];

const UNKNOWN: Rate = { minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, fxSource: null, budgetUsd: null };
const WEEKS_PER_MONTH = 4.33;

/**
 * Every "N hours" or "N-M hours" figure (two to four digits, or one to four for the lower end of a range; not part of a longer number). Which of them are work scope
 * is decided in `totalHours`.
 */
const TOTAL_HOURS = /(?<![\w.,\-–—])~?\s?(?:(\d{1,4})\s?(?:-|–|—|to)\s?)?(\d{2,4})\s?(?:hours|hrs)\b/gi;
/** The posting says the price is the bidder's to set: the platform's bracket is then not an offer. */
const NO_BUDGET =
  /no budget (?:is )?disclosed|you set the price|set (?:their|your) own price|quote your (?:own )?price|name your price|budget (?:is )?(?:open|negotiable|tbd)/i;
/** After the figure: a per-period rate of work ("per week", "/day", "weekly", "a day"), a cap, or an amount of material. */
const NOT_SCOPE_AFTER =
  /^(?:\s?(?:\/|per|a|an|each|every)\s?(?:week|wk|day|month|mo)\b|\s?(?:weekly|daily|monthly)\b|\s?\/\s?(?:wk|day|mo)\b|\s+(?:or\s+less|max(?:imum)?\b|of\s+(?:video|footage|audio|content|recordings?|support)\b))/i;
/** Within about 25 characters before the figure: a deadline, response time, uptime, support or a bound, not work scope. */
const NOT_SCOPE_BEFORE =
  /\b(?:within|in under|under|turnaround|respond(?:s|ing)?|response|reply|resolution|resolve|deadline|available|availability|uptime|support|sla|deliver(?:y|ed)?|up to|at most|at least|minimum|maximum|max|over|more than|less than|no more than|every|each|online|present|on call|overlap)\b/i;
/** Effort cues: before the figure in its clause, or right after it. Without one a figure is unconfirmed and unused. */
const EFFORT_BEFORE =
  /\b(?:about|approx(?:\.|imately)?|estimated?|roughly|around|effort|scope|total|expect(?:s|ed)?|plan on|budgeted|takes?|need(?:s|ed)?|requires?)\b|~/i;
const EFFORT_AFTER = /^\s*(?:of\s+(?:work|development|dev|coding|effort|engineering)\b|(?:in\s+)?total\b)/i;

const round2 = (x: number): number => Math.round(Number((x * 100).toPrecision(15))) / 100;
const valid = (x: number | null): boolean => x === null || (Number.isFinite(x) && x > 0);

interface Unit {
  readonly perUsd: number;
  readonly source: 'pack' | null | 'platform';
}

function unitOf(gig: Gig, fx: Fx): Unit | null {
  const { currency, usdPerUnit } = gig.budget;
  if (currency === 'USD') return { perUsd: 1, source: null };
  if (currency === 'EUR' || currency === 'GBP' || currency === 'INR') return { perUsd: fx.toINR[currency] / fx.toINR.USD, source: 'pack' };
  if (currency !== null && usdPerUnit !== null && Number.isFinite(usdPerUnit) && usdPerUnit > 0) return { perUsd: usdPerUnit, source: 'platform' };
  return null;
}

/**
 * The part of `window` (the text just before a figure) that can hold the figure's own deadline word: it starts after
 * the last `.` or `;`, and after a comma only when a number precedes that comma in the clause ("Deliver within 2
 * weeks, about 60 hours" ends the deadline at the comma; "Deadline, 48 hours" and "Must be available Mon-Fri, 40
 * hours" do not, because the comma separates a label from its own figure).
 */
function clauseBefore(window: string): string {
  const rest = window.slice(Math.max(window.lastIndexOf('.'), window.lastIndexOf(';')) + 1);
  for (let i = rest.lastIndexOf(','); i >= 0; i = rest.lastIndexOf(',', i - 1)) if (/\d/.test(rest.slice(0, i))) return rest.slice(i + 1);
  return rest;
}

/**
 * The work hours a description states for the whole job: `{lo, hi}` for "about 27 hours" (lo = hi) or "15-25 hours",
 * `null` when it states no hours figure at all, `'refused'` when it does but none can be used. A refused result is
 * `unknown`: it never falls through to the duration row.
 *
 * Allow-list: a figure is work scope only with an effort cue in its own clause (EFFORT_BEFORE: about, ~, estimated,
 * roughly, effort, scope, total, expect, plan on, budgeted, takes, needs, requires; or EFFORT_AFTER: "of work",
 * "of development", "total", "in total"). A figure without a cue is unconfirmed and unused.
 * Deny-list on top, which wins over a cue: a figure before which (within 25 characters, in the same clause: see
 * `clauseBefore`; a colon keeps the label with its figure) a deadline, response, availability, presence, support or
 * bound word stands (NOT_SCOPE_BEFORE), or after which a per-period unit, "or less", "max" or an amount of material
 * follows (NOT_SCOPE_AFTER), or a reversed range ("25-15 hours"); a figure denied in one place is denied everywhere.
 * Refused: no confirmed figure left, more than one confirmed figure, or a confirmed figure beside an unconfirmed
 * different one ("About 50 hours, maybe 80 hours").
 */
function totalHours(description: string): { lo: number; hi: number } | 'refused' | null {
  const confirmed = new Map<string, { lo: number; hi: number }>();
  const unconfirmed = new Set<string>();
  const denied = new Set<string>();
  for (const m of description.matchAll(TOTAL_HOURS)) {
    const hi = Number(m[2]);
    const lo = m[1] === undefined ? hi : Number(m[1]);
    const start = m.index ?? 0;
    const key = `${lo}-${hi}`;
    const window = description.slice(Math.max(0, start - 25), start);
    const clause = clauseBefore(window);
    const rest = description.slice(start + m[0].length);
    if (!(lo > 0 && hi >= lo) || NOT_SCOPE_AFTER.test(rest) || NOT_SCOPE_BEFORE.test(clause)) denied.add(key);
    else if (m[0].includes('~') || EFFORT_BEFORE.test(clause) || /approx\.\s*$/i.test(window) || EFFORT_AFTER.test(rest)) confirmed.set(key, { lo, hi });
    else unconfirmed.add(key);
  }
  const found = [...confirmed.entries()].filter(([k]) => !denied.has(k));
  if (found.length > 1) return 'refused';
  const only = found[0];
  if (only === undefined) return denied.size > 0 || unconfirmed.size > 0 ? 'refused' : null;
  return [...unconfirmed].some((k) => k !== only[0] && !denied.has(k)) ? 'refused' : only[1];
}

export function rateOf(gig: Gig, fx: Fx, maxHoursPerWeek: number): Rate {
  const { type, min, max } = gig.budget;
  if (type === 'unknown' || NO_BUDGET.test(gig.description)) return UNKNOWN;
  if (!valid(min) || !valid(max) || (min === null && max === null) || (min !== null && max !== null && min > max)) return UNKNOWN;
  const unit = unitOf(gig, fx);
  if (unit === null) return UNKNOWN;
  const fxDate = unit.source === 'pack' ? fx.asOf : null;
  const usd = (v: number | null, divisor = 1): number | null => (v === null ? null : round2((v * unit.perUsd) / divisor));
  const make = (method: Rate['method'], divisorForMin: number, divisorForMax: number, budgetUsd: number | null): Rate => ({
    minUsdH: usd(min, divisorForMin),
    maxUsdH: usd(max, divisorForMax),
    method,
    fxDate,
    fxSource: unit.source,
    budgetUsd,
  });
  if (type === 'hourly') return make('stated', 1, 1, null);

  const top = usd(max ?? min);
  const noRate: Rate = { minUsdH: null, maxUsdH: null, method: 'unknown', fxDate, fxSource: unit.source, budgetUsd: top };
  const hours = gig.hoursPerWeek.max;
  const weeks = gig.duration.weeks;
  if (type === 'monthly') return hours !== null && hours > 0 ? make('monthly÷hours', hours * WEEKS_PER_MONTH, hours * WEEKS_PER_MONTH, top) : noRate;

  if (hours !== null && hours > 0 && weeks !== null && weeks > 0) return make('fixed÷stated-hours', hours * weeks, hours * weeks, top);
  const total = totalHours(gig.description);
  if (total === 'refused') return noRate;
  if (total !== null) return make('fixed÷stated-hours', total.hi, total.lo, top);
  if (weeks !== null && weeks > 0 && Number.isFinite(maxHoursPerWeek) && maxHoursPerWeek > 0) return make('derived-from-duration', weeks * maxHoursPerWeek, weeks * maxHoursPerWeek, top);
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
