import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareDay } from '../../src/app/hosted/shadow/compare.js';
import { evaluate, renderJson, renderMarkdown, type Report } from '../../src/app/hosted/shadow/report.js';
import { DAYS, baseFixture, key, type ShadowFixture } from '../support/shadow-fixture.js';

const GOLD = join(import.meta.dirname, '..', 'fixtures', 'hosted', 'shadow');
const run = (mutate?: (fx: ShadowFixture) => void, days = 7): Report => {
  const fx = baseFixture();
  mutate?.(fx);
  const rows = DAYS.slice(0, days).map((d) =>
    compareDay(d, { mac: fx.mac.get(d)?.daily, hosted: fx.hosted.get(d)?.daily, macGigs: fx.mac.get(d)?.freelance, hostedGigs: fx.hosted.get(d)?.freelance }),
  );
  return evaluate(rows, fx.ledger, fx.verify, { from: DAYS[0], days });
};
const crit = (r: Report, id: string) => r.criteria.find((c) => c.id === id)!;
type Mut<T> = { -readonly [K in keyof T]: Mut<T[K]> };
const m = <T>(x: T): Mut<T> => x as Mut<T>;
const keys = (...xs: string[]): string[] => xs.map(key).sort();

describe('shadow report', () => {
  it('BASE matches the goldens and is byte-identical across runs', () => {
    const r = run();
    expect(renderMarkdown(r)).toBe(readFileSync(join(GOLD, 'report-base.md'), 'utf8'));
    expect(renderJson(r)).toBe(readFileSync(join(GOLD, 'report-base.json'), 'utf8'));
    expect(renderJson(run())).toBe(renderJson(r));
    expect(renderMarkdown(run())).toBe(renderMarkdown(r));
    expect(r.overall).toBe('FAIL');
    expect(r.failed).toEqual(['C3']);
    expect(r.proposedSkipSources).toEqual(['himalayas']);
  });

  it('C1', () => {
    expect(crit(run((fx) => { fx.ledger[4]!.outcome = 'failed'; }), 'C1')).toMatchObject({ status: 'FAIL', numbers: '6 of 7 days; 5 of 7 by 10:00 IST' });
    const ok = run((fx) => { fx.ledger[2]!.committedAt = '2026-11-04T04:20:00.000Z'; });
    expect(crit(ok, 'C1')).toMatchObject({ status: 'PASS', numbers: '7 of 7 days; 7 of 7 by 10:00 IST' });
    expect(crit(run((fx) => { fx.ledger[0]!.pipelines = { daily: 2, freelance: 0 }; }), 'C1').status).toBe('FAIL');
  });

  it('C2', () => {
    const bad = run((fx) => { m(fx.hosted.get(DAYS[5])!.daily!).eligible = keys('g1', 'g2', 'g3', 'g4'); });
    expect(crit(bad, 'C2')).toMatchObject({ status: 'FAIL', numbers: '≥ 0.95 on 5 of 7 days; week 0.943' });
    expect(crit(run(), 'C2').status).toBe('PASS');
  });

  it('C3', () => {
    const full = run((fx) => { for (const d of DAYS) m(fx.hosted.get(d)!.daily!).sources['himalayas']!.postings = keys('h1', 'h2', 'h3', 'h4', 'h5', 'h6'); });
    expect(crit(full, 'C3').status).toBe('PASS');
    expect(full.proposedSkipSources).toEqual([]);
    const allowed = run((fx) => {
      for (const d of DAYS) {
        m(fx.mac.get(d)!.daily!).eligible = keys('g1', 'g2', 'g3', 'g4');
        m(fx.mac.get(d)!.daily!).toDecide = keys('g1', 'g2', 'g3', 'g4');
      }
    });
    expect(crit(allowed, 'C3')).toMatchObject({ status: 'PASS' });
    expect(crit(allowed, 'C3').numbers).toContain('allowed with skipSources');
    expect(allowed.proposedSkipSources).toEqual(['himalayas']);
    expect(allowed.overall).toBe('PASS');
  });

  it('C4', () => {
    const bad = run((fx) => { for (const d of DAYS) m(fx.hosted.get(d)!.freelance!).gigs = { remotive: keys('r1', 'r2'), hn: keys('n1') }; });
    expect(crit(bad, 'C4')).toMatchObject({ status: 'FAIL', numbers: 'week 0.750' });
  });

  it('C5', () => {
    const bad = run((fx) => { for (const e of fx.ledger) e.billedMinutes = 60; });
    expect(crit(bad, 'C5')).toMatchObject({ status: 'FAIL', numbers: '31 × (60 + 1) = 1,891 (limit 1,750)' });
    expect(crit(run(), 'C5').status).toBe('PASS');
  });

  it('C6', () => {
    const bad = run((fx) => { fx.ledger[3]!.audit = { runId: '1003', hits: 1, nonTemplateLines: 0 }; });
    expect(crit(bad, 'C6')).toMatchObject({ status: 'FAIL' });
    expect(crit(bad, 'C6').numbers).toContain('1 log-audit hits');
    expect(crit(run((fx) => { fx.ledger[3]!.audit = { runId: '1003', hits: 0, nonTemplateLines: 2 }; }), 'C6').status).toBe('FAIL');
  });

  it('C7', () => {
    expect(crit(run((fx) => { m(fx.verify[2]!).ok = false; }), 'C7')).toMatchObject({ status: 'FAIL', numbers: '6 of 7 generations verified' });
    expect(crit(run((fx) => { fx.verify.splice(2, 1); }), 'C7').status).toBe('FAIL');
  });

  it('C8 is never evaluated', () => {
    expect(crit(run(), 'C8')).toMatchObject({ status: 'NOT EVALUATED', numbers: 'needs H4' });
  });

  it('a day that is not comparable fails C2, C3, C4', () => {
    const r = run((fx) => { fx.hosted.get(DAYS[3])!.daily = { ...fx.hosted.get(DAYS[3])!.daily!, packHash: 'c'.repeat(64) }; });
    for (const id of ['C2', 'C3', 'C4']) expect(crit(r, id)).toMatchObject({ status: 'FAIL', numbers: 'only 6 of 7 days comparable' });
    expect(renderMarkdown(r)).toContain('Not comparable: 2026-11-05 (pack-differs)');
    expect(r.overall).toBe('FAIL');
  });

  it('a window other than 7 days evaluates nothing', () => {
    const r = run(undefined, 2);
    expect(r.criteria.every((c) => c.status === 'NOT EVALUATED' && c.numbers === 'the window is 2 days; the criteria need 7')).toBe(true);
    expect(r.overall).toBe('FAIL');
    expect(r.days).toHaveLength(2);
    expect(renderMarkdown(r)).toContain('Overall: FAIL (window)');
  });
});
