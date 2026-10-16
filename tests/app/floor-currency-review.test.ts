import { describe, expect, it } from 'vitest';
// Intl writes a no-break space before €; compared with plain spaces.
import { belowFloor } from '../../src/app/comp/floor.js';
import { reasonText } from '../../src/app/web/copy.js';
import { homeCompText } from '../../src/app/web/format.js';

// Task 17 probe review. Fictional values and rates only.
const fx = { toINR: { USD: 83.5, EUR: 90.2, GBP: 105.4, INR: 1, CAD: 61.2 } };
const usdJob = { min: 100_000, max: 100_000, currency: 'USD', period: 'year', basis: 'base' } as never;

describe('two currencies never share a sign', () => {
  it('a CAD home reads a USD posting as US$, and its own equivalent as $', () => {
    const t = homeCompText(usdJob, 8_350_000, 8_350_000, 'CAD', fx);
    expect(t.main).toMatch(/US\$/);
    expect(t.equivalent).not.toMatch(/US\$/);
    expect(t.equivalent).toMatch(/\$/);
  });
  it('a EUR home still reads its own currency as €', () => {
    const eur = { min: 70_000, max: 80_000, currency: 'EUR', period: 'year', basis: 'base' } as never;
    expect(homeCompText(eur, 6_314_000, 7_216_000, 'EUR', fx).main.replace(/\s/g, ' ')).toBe('70.000 € – 80.000 €');
  });
});

describe('a job at the floor is never below it', () => {
  it('a floor whose INR amount has float noise compares as whole rupees, like the job', () => {
    const rate = 41.4395; // made-up rate: 50000 * 41.4395 = 2071975.0000000002
    expect(belowFloor({ min: 2_071_975, max: 2_071_975 }, { amount: 50_000, currency: 'EUR', period: 'year' } as never, { toINR: { EUR: rate, USD: 1, GBP: 1, INR: 1 } } as never)).toBe(false);
  });
});

describe('a below-floor reason never reads as at the floor', () => {
  it('a job just under a EUR floor shows an amount under it', () => {
    // 59,999 EUR in INR at 90.2
    const text = reasonText(`below-floor:${Math.round(59_999 * 90.2)}`, { home: 'EUR', fx });
    expect(text.replace(/\s/g, ' ')).toBe('Pay below your floor (max ≈ 59.000 € a year)');
  });
});
