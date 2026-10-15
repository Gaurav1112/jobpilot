import type { Posting } from '../types.js';
import { istDay } from '../triage.js';

/**
 * Number and date formatting for the dashboard (Task 13). INR is written the Indian way: lakh and crore per year
 * (`₹12.5 LPA`, `₹1.2 Cr`); foreign pay keeps its own currency and adds an INR equivalent at the pack's rates.
 * Locale-free: the same input always gives the same text.
 */

const LAKH = 100_000;
const CRORE = 10_000_000;

/** Up to `digits` decimals, trailing zeros dropped: 1.20 → "1.2", 60.0 → "60". */
function trim(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.?0+$/, '');
}

/** A count shown on a page, en-IN grouped: 570418 → "5,70,418". */
export const countText = (n: number): string => groupIndian(n);

/** Indian digit grouping: 1234567 → "12,34,567". */
export function groupIndian(n: number): string {
  const s = String(Math.round(Math.abs(n)));
  const head = s.slice(0, -3);
  const tail = s.slice(-3);
  const grouped = head === '' ? tail : `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
  return `${n < 0 ? '-' : ''}${grouped}`;
}

type Unit = 'Cr' | 'LPA' | '';
const unitOf = (n: number): Unit => (n >= CRORE ? 'Cr' : n >= LAKH ? 'LPA' : '');
const inUnit = (n: number, u: Unit): string => (u === 'Cr' ? trim(n / CRORE, 2) : u === 'LPA' ? trim(n / LAKH, 1) : groupIndian(n));
const withUnit = (body: string, u: Unit): string => (u === '' ? `₹${body}` : `₹${body} ${u}`);

/** One annual INR amount: `₹12.5 LPA`, `₹1.2 Cr`, `₹85,000`. */
export function inr(n: number): string {
  const u = unitOf(n);
  return withUnit(inUnit(n, u), u);
}

/** An annual INR range; one unit when both ends share it (`₹12–15 LPA`), else both spelled out. */
export function inrRange(min: number | null, max: number | null): string {
  if (min !== null && max !== null) {
    if (min === max) return inr(max);
    const u = unitOf(min);
    if (u === unitOf(max)) return withUnit(`${inUnit(min, u)}–${inUnit(max, u)}`, u);
    return `${inr(min)} – ${inr(max)}`;
  }
  if (max !== null) return `up to ${inr(max)}`;
  if (min !== null) return `from ${inr(min)}`;
  return '';
}

const SYMBOL: Readonly<Record<string, string>> = { USD: '$', EUR: '€', GBP: '£', INR: '₹' };

/** A foreign annual amount, compact: 180000 → "180k", 1250000 → "1.25M". */
function compact(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000, 2)}M`;
  if (n >= 1_000) return `${trim(n / 1_000, 1)}k`;
  return trim(n, 0);
}

function foreignRange(c: NonNullable<Posting['comp']>): string {
  const sym = SYMBOL[c.currency] ?? `${c.currency} `;
  if (c.min !== null && c.max !== null) return c.min === c.max ? `${sym}${compact(c.max)}` : `${sym}${compact(c.min)}–${compact(c.max)}`;
  if (c.max !== null) return `up to ${sym}${compact(c.max)}`;
  return `from ${sym}${compact(c.min as number)}`;
}

export interface CompText {
  /** The pay as stated (`₹12–15 LPA`, `$150k–180k`), or "Pay not disclosed". */
  readonly main: string;
  /** For foreign pay: the INR equivalent at the pack's rates (`≈ ₹1.25–1.5 Cr`). */
  readonly inr: string | null;
  /** When the posting does not say the figure is base pay. */
  readonly caveat: string | null;
}

export function compText(comp: Posting['comp'] | null, minInr: number | null, maxInr: number | null): CompText {
  if (comp === null) return { main: 'Pay not disclosed', inr: null, caveat: null };
  const caveat = comp.basis === 'unknown' ? 'may include bonus or equity' : null;
  if (comp.currency === 'INR') return { main: inrRange(comp.min, comp.max), inr: null, caveat };
  const eq = inrRange(minInr, maxInr);
  return { main: foreignRange(comp), inr: eq === '' ? null : `≈ ${eq}`, caveat };
}

/** Whole days from the calendar date `from` (YYYY-MM-DD) to `to` (YYYY-MM-DD); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-09" or an ISO time → "9 Oct 2026" (the date part as written, no time zone shift). */
export function dateText(isoOrDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoOrDate);
  if (!m) return isoOrDate;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** A fact period "2022-03..present" → "Mar 2022 – present". */
export function periodText(period: string): string {
  const ym = (s: string): string => (s === 'present' ? 'present' : `${MONTHS[Number(s.slice(5, 7)) - 1] ?? s.slice(5, 7)} ${s.slice(0, 4)}`);
  const [a, b] = period.split('..');
  return a === undefined || b === undefined ? period : `${ym(a)} – ${ym(b)}`;
}

/** A score for display: whole numbers as is, else one decimal. */
export const scoreText = (n: number): string => trim(n, 1);

/** "9 Oct 2026, 07:00 IST". */
export function istTimeText(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const ist = new Date(t + 330 * 60_000).toISOString();
  return `${dateText(ist)}, ${ist.slice(11, 16)} IST`;
}

/** Western digit grouping (dollars, character counts): 1214 → "1,214". */
export function groupWestern(n: number): string {
  const s = String(Math.round(Math.abs(n)));
  return `${n < 0 ? '-' : ''}${s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** US dollars as stored (2 decimals at most): whole dollars grouped ("$1,500"), else cents ("$43.80"). */
export function usdText(n: number): string {
  if (Number.isInteger(n)) return `$${groupWestern(n)}`;
  const [whole, cents] = Math.abs(n).toFixed(2).split('.') as [string, string];
  return `${n < 0 ? '-' : ''}$${groupWestern(Number(whole))}.${cents}`;
}

/** How long ago `iso` was at `now`: "posted 5 h ago", "posted 3 days ago", "posted just now"; null when unknown. */
export function ageText(iso: string | null, now: string): string | null {
  if (iso === null) return null;
  const t = Date.parse(/T[0-9:.]+$/.test(iso) ? `${iso}Z` : iso);
  if (Number.isNaN(t)) return null;
  const hours = Math.max(0, (Date.parse(now) - t) / 3_600_000);
  if (hours < 1) return 'posted just now';
  if (hours < 48) return `posted ${Math.floor(hours)} h ago`;
  return `posted ${Math.floor(hours / 24)} days ago`;
}

/** A14: how long ago something was applied for, by IST calendar date: "today", "yesterday", "27 days ago". */
export function appliedAgo(appliedAt: string, now: string): string {
  const d = daysBetween(istDay(appliedAt), istDay(now));
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${countText(d)} days ago`;
}
