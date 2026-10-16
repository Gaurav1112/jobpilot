import { describe, expect, it } from 'vitest';
import { billedMinutes, cycleMonth, daysLeft, govern, levelRose, type LedgerEntry, ledgerPath, LedgerEntry as LedgerSchema, minutesUntil0700Ist, p90, parseLedger } from '../../src/app/hosted/budget.js';

const budget = { monthlyMinutes: 2000, safetyMinutes: 100, cycleStartDay: 1, dailyEstimateMinutes: 46 };
const NOW = '2026-11-01T02:07:00.000Z';
const entry = (o: Partial<LedgerEntry> & { startedAt: string; billedMinutes: number }): LedgerEntry => ({
  runId: '1', workflow: 'daily', outcome: 'committed', ...o,
});
const dEntries = (d: number): LedgerEntry[] =>
  Array.from({ length: 14 }, (_, i) => entry({ runId: String(i + 1), startedAt: `2026-10-${String(10 + i).padStart(2, '0')}T02:00:00.000Z`, billedMinutes: d }));
const uEntry = (u: number): LedgerEntry[] => (u === 0 ? [] : [entry({ runId: '99', workflow: 'maintenance', startedAt: '2026-11-01T01:00:00.000Z', billedMinutes: u, outcome: 'nothing-owed' })]);

describe('govern', () => {
  // billedMinutes max is 400 per entry, so large U is split into several entries
  const split = (u: number): LedgerEntry[] => {
    const out: LedgerEntry[] = [];
    let left = u;
    let n = 0;
    while (left > 0) {
      const b = Math.min(left, 400);
      out.push(entry({ runId: String(100 + n++), workflow: 'maintenance', startedAt: '2026-11-01T01:00:00.000Z', billedMinutes: b, outcome: 'nothing-owed' }));
      left -= b;
    }
    return out;
  };
  const rows: [number | null, number, string, number | null][] = [
    [null, 0, 'L0', 330],
    [null, 440, 'L1', null],
    [null, 500, 'L2', null],
    [null, 540, 'L3', null],
    [null, 1900, 'L4', null],
    [30, 0, 'L0', 330],
    [60, 0, 'L0', 60],
    [60, 20, 'L1', null],
  ];
  it.each(rows)('d=%s U=%s -> %s slice %s', (d, u, level, slice) => {
    const r = govern({ now: NOW, entries: [...(d === null ? [] : dEntries(d)), ...split(u)], budget });
    expect(r.level).toBe(level);
    expect(r.coverageSlice).toBe(slice);
    expect(r.used).toBe(u);
  });
  it('reports A=490 for the empty ledger and 70 for d=60', () => {
    expect(govern({ now: NOW, entries: [], budget }).available).toBe(490);
    expect(govern({ now: NOW, entries: dEntries(60), budget }).available).toBe(70);
  });
  it('previous month does not count in U; coverage counts in U but not d', () => {
    const r = govern({ now: NOW, entries: [...dEntries(30), entry({ runId: '5', workflow: 'coverage', startedAt: '2026-11-01T00:30:00.000Z', billedMinutes: 100, outcome: 'committed' })], budget });
    expect(r.used).toBe(100);
    expect(r.d).toBe(30);
  });
  it('allowed flags by level', () => {
    const at = (u: number) => govern({ now: NOW, entries: uEntry(u), budget });
    expect(at(0)).toMatchObject({ dailyAllowed: true, freelanceAllowed: true, catchUpAllowed: true });
    expect(at(500)).toMatchObject({ dailyAllowed: true, freelanceAllowed: true, catchUpAllowed: false });
    expect(at(540)).toMatchObject({ dailyAllowed: true, freelanceAllowed: false, catchUpAllowed: false });
  });
  it('L4 forbids daily', () => {
    const r = govern({ now: NOW, entries: [entry({ runId: '7', workflow: 'maintenance', startedAt: '2026-11-01T01:00:00.000Z', billedMinutes: 400, outcome: 'nothing-owed' }), ...Array.from({ length: 4 }, (_, i) => entry({ runId: String(8 + i), workflow: 'maintenance', startedAt: '2026-11-01T01:00:00.000Z', billedMinutes: 400, outcome: 'nothing-owed' })).concat([entry({ runId: '20', workflow: 'maintenance', startedAt: '2026-11-01T01:00:00.000Z', billedMinutes: 100, outcome: 'nothing-owed' })])], budget });
    expect(r.level).toBe('L4');
    expect(r.dailyAllowed).toBe(false);
  });
});

describe('helpers', () => {
  it('cycleMonth', () => {
    expect(cycleMonth('2026-11-30T23:59:59Z', 1)).toBe('2026-11');
    expect(cycleMonth('2026-11-14T00:00:00Z', 15)).toBe('2026-10');
    expect(cycleMonth('2026-11-15T00:00:00Z', 15)).toBe('2026-11');
  });
  it('daysLeft', () => {
    expect(daysLeft('2026-11-30T10:00:00Z', 1)).toBe(1);
    expect(daysLeft('2026-02-01T10:00:00Z', 1)).toBe(28);
    expect(daysLeft(NOW, 1)).toBe(30);
  });
  it('p90', () => {
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
    expect(p90([5])).toBe(5);
  });
  it('billedMinutes', () => {
    expect(billedMinutes('2026-11-01T02:00:00Z', '2026-11-01T02:41:10Z')).toBe(43);
  });
  it('billedMinutes is never negative (a clock that stepped back)', () => {
    expect(billedMinutes('2026-11-01T02:10:00Z', '2026-11-01T02:00:00Z')).toBe(0);
  });
  it('levelRose', () => {
    expect(levelRose(null, '2026-11', 'L0')).toBe(false);
    expect(levelRose({ month: '2026-11', level: 'L0' }, '2026-11', 'L2')).toBe(true);
    expect(levelRose({ month: '2026-11', level: 'L2' }, '2026-11', 'L1')).toBe(false);
    expect(levelRose({ month: '2026-10', level: 'L3' }, '2026-11', 'L0')).toBe(false);
    expect(levelRose({ month: '2026-10', level: 'L0' }, '2026-11', 'L3')).toBe(false);
    expect(levelRose({ month: '2026-11', level: 'L2' }, '2026-11', 'L2')).toBe(false);
  });
  it('minutesUntil0700Ist', () => {
    expect(minutesUntil0700Ist('2026-11-01T01:29:30.000Z')).toBe(1);
    expect(minutesUntil0700Ist('2026-11-01T01:30:00.000Z')).toBe(1440);
    expect(minutesUntil0700Ist(NOW)).toBe(1403);
  });
});

describe('ledger', () => {
  it('path and parse', () => {
    expect(ledgerPath('2026-11')).toBe('ledger/2026-11.jsonl');
    const e = { runId: 'laptop:0123abcd:20261101T0200Z', workflow: 'daily', startedAt: '2026-11-01T02:00:00.000Z', billedMinutes: 43, outcome: 'committed', level: 'L0' };
    expect(parseLedger(`${JSON.stringify(e)}\n${JSON.stringify({ ...e, runId: '12' })}\n`)).toHaveLength(2);
    expect(parseLedger('')).toEqual([]);
  });
  it('a bad line throws naming its number', () => {
    const e = { runId: '1', workflow: 'daily', startedAt: '2026-11-01T02:00:00.000Z', billedMinutes: 1, outcome: 'committed' };
    expect(() => parseLedger(`${JSON.stringify(e)}\n{nope`)).toThrow(/line 2/);
    expect(() => parseLedger(`${JSON.stringify({ ...e, extra: 1 })}`)).toThrow(/line 1/);
  });
  it('schema bounds', () => {
    const e = { runId: '1', workflow: 'daily', startedAt: '2026-11-01T02:00:00.000Z', billedMinutes: 401, outcome: 'committed' };
    expect(LedgerSchema.safeParse(e).success).toBe(false);
  });
});
