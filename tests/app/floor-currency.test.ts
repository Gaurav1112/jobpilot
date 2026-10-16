import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideEligibility } from '../../src/app/agents/eligibility.js';
import { homeCurrencyOf, pivotToHome } from '../../src/app/comp/currencies.js';
import { loadPack, PackError } from '../../src/app/pack/load.js';
import { reasonText } from '../../src/app/web/copy.js';
import { homeCompText } from '../../src/app/web/format.js';
import { compCell } from '../../src/app/web/views/common.js';
import type { Posting } from '../../src/app/types.js';

const repo = join(import.meta.dirname, '../..');
let pack: string;
beforeEach(() => {
  pack = mkdtempSync(join(tmpdir(), 'jobpilot-floor-'));
  cpSync(join(repo, 'tests/fixtures/pack'), pack, { recursive: true });
});
afterEach(() => rmSync(pack, { recursive: true, force: true }));

const withFloor = (amount: number, currency: string, extraFx = '') => {
  writeFileSync(join(pack, 'offers.yaml'), `floor:\n  amount: ${amount}\n  currency: ${currency}\n  period: year\n  basis: base\n`);
  writeFileSync(join(pack, 'fx.yaml'), `asOf: "2026-10-01"\ntoINR:\n  USD: 83.5\n  EUR: 90.2\n  GBP: 106.4\n  INR: 1\n${extraFx}`);
  return loadPack(pack).pack;
};
const posting = (comp: Posting['comp']): Posting => ({
  jobKey: '0123456789abcdef', dedupeKey: 'fedcba9876543210', source: 'greenhouse', sourceId: 's1', company: 'Unlisted Co', slug: 'unlisted', ats: 'greenhouse',
  title: 'Senior Backend Engineer', url: 'https://jobs.example.com/1', locationText: 'Remote - Germany', remote: { structured: 'remote', countries: ['germany'], signals: [] },
  employmentType: null, descriptionText: 'Build interfaces.', postedAt: null, comp, yearsRequired: null,
});

describe('a floor in any currency', () => {
  it('the fixture INR pack loads exactly as before (same hash)', () => {
    const before = loadPack(join(repo, 'tests/fixtures/pack')).hash;
    expect(loadPack(pack).hash).toBe(before);
  });
  it('an EUR floor compares through the fixed rates', () => {
    const p = withFloor(60000, 'EUR');
    const { contact: _c, answers: _a, ...pub } = { ...p, eligibility: { ...p.eligibility, residence: 'DE' } };
    expect(homeCurrencyOf(p)).toBe('EUR');
    const d = decideEligibility(posting({ min: 50000, max: 60000, currency: 'USD', period: 'year', basis: 'base' }), pub);
    expect(d.reasons).toEqual([`below-floor:${60000 * 83.5}`]);
    expect(decideEligibility(posting({ min: 60000, max: 70000, currency: 'EUR', period: 'year', basis: 'base' }), pub).verdict).toBe('eligible');
  });
  it('a CAD floor needs a CAD rate', () => {
    expect(() => withFloor(110000, 'CAD')).toThrow(/fx.yaml has no toINR rate for CAD/);
    expect(withFloor(110000, 'CAD', '  CAD: 61.2\n').fx.toINR['CAD']).toBe(61.2);
  });
  it('an unknown currency code is refused', () => {
    expect(() => withFloor(1, 'XYZ')).toThrow(PackError);
  });
  it('dashboard pay for an EUR home: euros, with an equivalent for other currencies', () => {
    const fx = { asOf: '2026-10-01', toINR: { USD: 83.5, EUR: 90.2, GBP: 106.4, INR: 1 } };
    const sp = (t: string | null | undefined): string => (t ?? '').replace(/[\u00a0\u202f]/g, ' '); // Intl uses no-break spaces
    const eur = homeCompText({ min: 70000, max: 80000, currency: 'EUR', period: 'year', basis: 'base' }, 70000 * 90.2, 80000 * 90.2, 'EUR', fx);
    expect([sp(eur.main), eur.equivalent]).toEqual(['70.000 € – 80.000 €', null]);
    expect(sp(homeCompText({ min: 80000, max: 90000, currency: 'USD', period: 'year', basis: 'base' }, 80000 * 83.5, 90000 * 83.5, 'EUR', fx).equivalent)).toBe('≈ 74.000 € – 83.000 €');
    expect(pivotToHome(90.2 * 1000, 'EUR', fx)).toBe(1000);
  });
  it('a below-floor reason reads in the home currency; an INR home keeps the code', () => {
    const fx = { asOf: '2026-10-01', toINR: { USD: 83.5, EUR: 90.2, GBP: 106.4, INR: 1 } };
    const sp = (t: string): string => t.replace(/[\u00a0\u202f]/g, ' ');
    expect(sp(reasonText(`below-floor:${54000 * 90.2}`, { home: 'EUR', fx }))).toBe('Pay below your floor (max ≈ 54.000 € a year)');
    expect(reasonText('below-floor:4870800')).toBe('below-floor:4870800');
    expect(reasonText('onsite', { home: 'EUR', fx })).toBe('On-site only');
  });
  it('the pay cell: unchanged for an INR home, home-currency equivalent otherwise', () => {
    const fx = { asOf: '2026-10-01', toINR: { USD: 83.5, EUR: 90.2, GBP: 106.4, INR: 1 } };
    const j = { comp: { min: 120000, max: 120000, currency: 'USD' as const, period: 'year' as const, basis: 'base' as const }, compMinInr: 120000 * 83.5, compMaxInr: 120000 * 83.5 };
    expect(compCell(j).value).toContain('≈ ₹1 Cr');
    const eur = compCell(j, { home: 'EUR', fx }).value.replace(/[\u00a0\u202f]/g, ' ');
    expect(eur).toContain('$120,000');
    expect(eur).toContain('≈ 111.000 €');
    expect(eur).not.toContain('₹');
  });
});
