import { z } from 'zod';
import type { HostedConfig } from './config.js';

export const LedgerEntry = z.strictObject({
  runId: z.string().regex(/^(?:\d{1,20}|laptop:[0-9a-f]{8}:\d{8}T\d{4}Z)$/),
  workflow: z.enum(['daily', 'coverage', 'maintenance']),
  startedAt: z.iso.datetime(),
  billedMinutes: z.number().int().min(0).max(400),
  outcome: z.enum(['committed', 'nothing-owed', 'catch-up-off', 'busy', 'refused', 'failed', 'killed']),
  // optional (P13): what the comparator needs
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  gen: z.number().int().min(1).optional(),
  committedAt: z.iso.datetime().optional(),
  pipelines: z
    .strictObject({ daily: z.number().int().min(0).max(2).nullable(), freelance: z.number().int().min(0).max(2).nullable() })
    .optional(),
  audit: z
    .strictObject({ runId: z.string().regex(/^\d{1,20}$/), hits: z.number().int().min(0), nonTemplateLines: z.number().int().min(0) })
    .optional(),
  level: z.enum(['L0', 'L1', 'L2', 'L3', 'L4']).optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;
export type Level = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export const ledgerPath = (month: string): string => `ledger/${month}.jsonl`;

/** One JSON object per line; blank lines are skipped; a bad line throws naming its (1-based) line number. */
export function parseLedger(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`ledger line ${i + 1}: not valid JSON`);
    }
    const r = LedgerEntry.safeParse(raw);
    if (!r.success) throw new Error(`ledger line ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`).join('; ')}`);
    out.push(r.data);
  });
  return out;
}

const DAY = 86_400_000;
/** The budget month (UTC) holding `now`, starting on `startDay`: "YYYY-MM" of its first day. */
export function cycleMonth(now: string, startDay: number): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const first = d.getUTCDate() >= startDay ? Date.UTC(y, m, 1) : Date.UTC(y, m - 1, 1);
  return new Date(first).toISOString().slice(0, 7);
}
/** Days left in the cycle, today (UTC) included. */
export function daysLeft(now: string, startDay: number): number {
  const [y, m] = cycleMonth(now, startDay).split('-').map(Number) as [number, number];
  const next = Date.UTC(y, m, startDay); // the next cycle's first day
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return Math.round((next - today) / DAY);
}
/** Nearest-rank p90. */
export function p90(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.9 * s.length) - 1)] as number;
}

export interface Decision {
  readonly level: Level;
  readonly used: number; // U
  readonly d: number;
  readonly daysLeft: number; // Rd
  readonly available: number; // A
  readonly coverageSlice: number | null;
  readonly dailyAllowed: boolean;
  readonly freelanceAllowed: boolean;
  readonly catchUpAllowed: boolean;
}

/** Minutes from `now` to the next 07:00 IST (01:30 UTC), rounded up; exactly at 07:00 IST it is a full day. */
export function minutesUntil0700Ist(now: string): number {
  const t = Date.parse(now);
  const d = new Date(t);
  let next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 1, 30);
  if (next <= t) next += DAY;
  return Math.ceil((next - t) / 60_000);
}

export function govern(i: { readonly now: string; readonly entries: readonly LedgerEntry[]; readonly budget: HostedConfig['budget'] }): Decision {
  const M = i.budget.monthlyMinutes;
  const S = i.budget.safetyMinutes;
  const month = cycleMonth(i.now, i.budget.cycleStartDay);
  const U = i.entries.filter((e) => cycleMonth(e.startedAt, i.budget.cycleStartDay) === month).reduce((n, e) => n + e.billedMinutes, 0);
  const runs = i.entries
    .filter((e) => e.workflow === 'daily' && (e.outcome === 'committed' || e.outcome === 'failed' || e.outcome === 'killed'))
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
    .slice(-14);
  const d = runs.length === 0 ? i.budget.dailyEstimateMinutes : p90(runs.map((e) => e.billedMinutes));
  const Rd = daysLeft(i.now, i.budget.cycleStartDay);
  const reserve = Rd * (d + 1);
  const A = M - S - U - reserve;
  const level: Level = U >= M - S ? 'L4' : U + Rd * d > M - S ? 'L3' : U + reserve > M - S ? 'L2' : A < 60 ? 'L1' : 'L0';
  const slice = level === 'L0' ? Math.min(A - 10, 330, minutesUntil0700Ist(i.now) - 20) : null;
  return {
    level,
    used: U,
    d,
    daysLeft: Rd,
    available: A,
    coverageSlice: slice !== null && slice >= 10 ? slice : null,
    dailyAllowed: level !== 'L4',
    freelanceAllowed: level === 'L0' || level === 'L1' || level === 'L2',
    catchUpAllowed: level === 'L0' || level === 'L1',
  };
}

/** Whether moving from `prev` to `level` opens an alert: only a rise within the same month (a new month starts at its own level). */
export function levelRose(prev: { readonly month: string; readonly level: Level } | null, month: string, level: Level): boolean {
  if (prev === null || prev.month !== month) return false;
  return Number(level.slice(1)) > Number(prev.level.slice(1));
}

/** Billed minutes of a finished job: ceil((end − startedAt) / 1 min) + 1 for teardown (spec §4); never below 0. */
export const billedMinutes = (startedAt: string, end: string): number => Math.max(0, Math.ceil((Date.parse(end) - Date.parse(startedAt)) / 60_000) + 1);
