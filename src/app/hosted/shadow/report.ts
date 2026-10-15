import { canonicalJson } from '../../../kernel/canonical.js';
import { p90, type LedgerEntry } from '../budget.js';
import type { VerifyRecord } from '../generations.js';
import { dates, type Counts, type DayRow } from './compare.js';

export type Status = 'PASS' | 'FAIL' | 'NOT EVALUATED';
export interface Criterion {
  readonly id: 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8';
  readonly name: string;
  readonly status: Status;
  readonly numbers: string;
}
export interface Report {
  readonly v: 1;
  readonly from: string;
  readonly to: string;
  readonly days: readonly DayRow[];
  readonly minutes: readonly { readonly date: string; readonly billed: number | null; readonly committedIst: string | null }[];
  readonly criteria: readonly Criterion[];
  readonly overall: 'PASS' | 'FAIL';
  readonly failed: readonly string[];
  readonly proposedSkipSources: readonly string[];
}

const NEED = 7;
const IST_MS = 19_800_000;
const f3 = (n: number): string => n.toFixed(3);
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const grp = (n: number): string => n.toLocaleString('en-US');
const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);
const sum = (xs: readonly number[]): number => xs.reduce((n, x) => n + x, 0);
/** ISO text of the IST wall clock ("YYYY-MM-DDTHH:MM:SS.sssZ"). */
const istOf = (iso: string): string => new Date(Date.parse(iso) + IST_MS).toISOString();

const NAMES: Record<Criterion['id'], string> = {
  C1: 'Hosted daily+freelance committed state',
  C2: 'Eligible recall',
  C3: 'Per-source volume (Mac mean ≥ 5/day)',
  C4: 'Gig recall (am)',
  C5: 'Projected minutes',
  C6: 'Privacy',
  C7: 'State',
  C8: 'Triage',
};
const crit = (id: Criterion['id'], status: Status, numbers: string): Criterion => ({ id, name: NAMES[id], status, numbers });

export function evaluate(days: readonly DayRow[], ledger: readonly LedgerEntry[], verify: readonly VerifyRecord[], window: { readonly from: string; readonly days: number }): Report {
  const span = dates(window.from, window.days);
  const from = window.from;
  const to = span[span.length - 1] ?? window.from;
  const inWeek = new Set(span);
  const committed = ledger
    .filter((e) => e.workflow === 'daily' && e.outcome === 'committed' && e.date !== undefined && inWeek.has(e.date))
    .sort((a, b) => ((a.committedAt ?? '') < (b.committedAt ?? '') ? -1 : 1));
  const pick = (date: string): LedgerEntry | undefined => committed.filter((e) => e.date === date).pop();
  const minutes = days.map((d) => {
    const e = pick(d.date);
    return { date: d.date, billed: e?.billedMinutes ?? null, committedIst: e?.committedAt === undefined ? null : istOf(e.committedAt).slice(11, 16) };
  });
  const base = { v: 1 as const, from, to, days, minutes };

  if (window.days !== NEED) {
    const msg = `the window is ${window.days} days; the criteria need ${NEED}`;
    const criteria = (Object.keys(NAMES) as Criterion['id'][]).map((id) => crit(id, 'NOT EVALUATED', msg));
    return { ...base, criteria, overall: 'FAIL', failed: [], proposedSkipSources: [] };
  }

  // C1
  const good = span.filter((date) => {
    const e = pick(date);
    return e !== undefined && e.pipelines !== undefined && [e.pipelines.daily, e.pipelines.freelance].every((x) => x === 0 || x === 1);
  });
  const early = good.filter((date) => {
    const at = pick(date)?.committedAt;
    return at !== undefined && istOf(at).slice(0, 19) <= `${date}T10:00:00`;
  });
  const c1 = crit('C1', good.length === NEED && early.length >= 6 ? 'PASS' : 'FAIL', `${good.length} of ${NEED} days; ${early.length} of ${NEED} by 10:00 IST`);

  // criteria that compare need every date comparable
  const comparable = days.filter((d) => d.comparable).length;
  const notComparable = comparable < NEED ? `only ${comparable} of ${NEED} days comparable` : null;
  const cmp = (id: Criterion['id'], f: () => { ok: boolean; numbers: string }): Criterion => {
    if (notComparable !== null) return crit(id, 'FAIL', notComparable);
    const r = f();
    return crit(id, r.ok ? 'PASS' : 'FAIL', r.numbers);
  };
  const weekRecall = (of: (d: DayRow) => Counts): number | null => ratio(sum(days.map((d) => of(d).both)), sum(days.map((d) => of(d).mac)));

  const c2 = cmp('C2', () => {
    const met = days.filter((d) => d.eligible.recall === null || d.eligible.recall >= 0.95).length;
    const week = weekRecall((d) => d.eligible);
    return { ok: met >= 6 && (week === null || week >= 0.97), numbers: `≥ 0.95 on ${met} of ${NEED} days; week ${week === null ? 'n/a' : f3(week)}` };
  });

  let proposed: string[] = [];
  const c3 = cmp('C3', () => {
    const ids = [...new Set(days.flatMap((d) => d.sources.map((s) => s.source)))].sort();
    const stats = ids
      .map((id) => {
        const rows = days.flatMap((d) => d.sources.filter((s) => s.source === id));
        return { id, mac: sum(rows.map((s) => s.mac)), hosted: sum(rows.map((s) => s.hosted)), macEligible: sum(rows.map((s) => s.macEligible)) };
      })
      .filter((s) => s.mac / NEED >= 5);
    const failing = stats.filter((s) => s.hosted / s.mac < 0.9);
    if (failing.length === 0) {
      return { ok: true, numbers: stats.length === 0 ? 'no source with a Mac mean of 5/day or more' : `${stats.map((s) => `${s.id} ${f3(s.hosted / s.mac)}`).join(', ')}; none under 0.900` };
    }
    proposed = failing.map((s) => s.id);
    const total = sum(days.map((d) => d.eligible.mac));
    const share = total === 0 ? 0 : sum(failing.map((s) => s.macEligible)) / total;
    const ok = share <= 0.03;
    const names = failing.map((s) => `${s.id} ${f3(s.hosted / s.mac)}`).join(', ');
    return { ok, numbers: `${names}; ${ok ? 'allowed with skipSources, failing' : 'failing'} sources held ${pct(share)} of Mac eligible (limit 3.0%)` };
  });

  const c4 = cmp('C4', () => {
    const week = weekRecall((d) => d.gigs);
    return { ok: week !== null && week >= 0.95, numbers: `week ${week === null ? 'n/a' : f3(week)}` };
  });

  const billed = committed.map((e) => e.billedMinutes);
  const c5 =
    billed.length === 0
      ? crit('C5', 'FAIL', 'no committed daily runs in the window')
      : (() => {
          const p = p90(billed);
          const total = 31 * (p + 1);
          return crit('C5', total <= 1750 ? 'PASS' : 'FAIL', `31 × (${p} + 1) = ${grp(total)} (limit ${grp(1750)})`);
        })();

  const dateOf = (e: LedgerEntry): string => e.date ?? e.startedAt.slice(0, 10);
  const weekEntries = ledger.filter((e) => inWeek.has(dateOf(e)));
  const hits = sum(weekEntries.map((e) => e.audit?.hits ?? 0));
  const lines = sum(weekEntries.map((e) => e.audit?.nonTemplateLines ?? 0));
  const c6 = crit('C6', hits === 0 && lines === 0 ? 'PASS' : 'FAIL', `${hits} log-audit hits, ${lines} non-template lines; snapshot leak scan not evaluated (H3)`);

  const gens = [...new Set(committed.flatMap((e) => (e.gen === undefined ? [] : [e.gen])))];
  const verified = gens.filter((g) => verify.some((v) => v.gen === g && v.ok));
  const c7 = crit('C7', gens.length > 0 && verified.length === gens.length ? 'PASS' : 'FAIL', `${verified.length} of ${gens.length} generations verified`);

  const criteria = [c1, c2, c3, c4, c5, c6, c7, crit('C8', 'NOT EVALUATED', 'needs H4')];
  const failed = criteria.filter((c) => c.status === 'FAIL').map((c) => c.id);
  const overall = criteria.slice(0, 7).every((c) => c.status === 'PASS') ? 'PASS' : 'FAIL';
  return { ...base, criteria, overall, failed, proposedSkipSources: proposed };
}

const cell = (c: Counts): string => `${c.recall === null ? 'n/a' : f3(c.recall)} (${c.both} of ${c.mac})`;
const list = (xs: readonly string[]): string => (xs.length === 0 ? 'none' : xs.join(', '));

export function renderMarkdown(r: Report): string {
  const comparable = r.days.filter((d) => d.comparable).length;
  const out: string[] = [
    `# jobpilot side-by-side report: ${r.from} to ${r.to}`,
    '',
    `Comparable days: ${comparable} of ${r.days.length}. Code differs on: ${list(r.days.filter((d) => d.codeDiffers).map((d) => d.date))}.`,
  ];
  const bad = r.days.filter((d) => !d.comparable);
  if (bad.length > 0) out.push('', `Not comparable: ${bad.map((d) => `${d.date} (${d.why})`).join(', ')}`);
  out.push(
    '',
    '## Per day and source (daily)',
    '',
    '| Date | Source | Mac | Hosted | Both | Mac only | Hosted only | Recall | Problems (Mac / hosted) |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const d of r.days) {
    for (const s of d.sources) {
      out.push(`| ${d.date} | ${s.source} | ${s.mac} | ${s.hosted} | ${s.both} | ${s.macOnly} | ${s.hostedOnly} | ${s.recall === null ? 'n/a' : f3(s.recall)} | ${list(s.problems.mac)} / ${list(s.problems.hosted)} |`);
    }
  }
  out.push('', '## Recall per day', '', '| Date | Eligible | To decide | Gigs (am) |', '|---|---|---|---|');
  for (const d of r.days) out.push(`| ${d.date} | ${cell(d.eligible)} | ${cell(d.toDecide)} | ${cell(d.gigs)} |`);
  out.push('', '## Minutes', '', '| Date | Billed minutes | Committed (IST) |', '|---|---|---|');
  for (const m of r.minutes) out.push(`| ${m.date} | ${m.billed === null ? 'none' : m.billed} | ${m.committedIst ?? 'none'} |`);
  out.push('', '## Criteria', '', '| # | Criterion | Result | Numbers |', '|---|---|---|---|');
  for (const c of r.criteria) out.push(`| ${c.id} | ${c.name} | ${c.status} | ${c.numbers} |`);
  const why = r.failed.length > 0 ? r.failed.join(', ') : 'window';
  out.push('', `Overall: ${r.overall === 'PASS' ? 'PASS' : `FAIL (${why})`}. Proposed skipSources: ${list(r.proposedSkipSources)}`, '');
  return out.join('\n');
}

export const renderJson = (r: Report): string => `${canonicalJson(r)}\n`;
