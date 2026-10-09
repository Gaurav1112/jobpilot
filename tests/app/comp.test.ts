import { describe, it, expect } from 'vitest';
import type { Fx, Offers } from '../../src/app/pack/schema.js';
import { belowFloor, toInrPerYear } from '../../src/app/comp/floor.js';
import { degroup, parseComp, parseCompRange, meetsFloor, type CompResult, type Currency } from '../../src/app/comp/parse.js';

function parsed(min: number, max: number, currency: Currency): CompResult {
  return { kind: 'parsed', range: { min, max, currency, period: 'year' } };
}

/** Asserts `result` is a refusal whose reason names the given cause — not
 * just that some refusal happened, which would pass no matter which of the
 * ten distinct refusal causes actually fired. */
function expectRefused(result: CompResult, reasonContains: string): void {
  expect(result.kind).toBe('refused');
  if (result.kind === 'refused') {
    expect(result.reason).toContain(reasonContains);
  }
}

function expectAbsent(result: CompResult): void {
  expect(result).toEqual({ kind: 'absent' });
}

describe('degroup', () => {
  it('reads Indian 2,2,3 grouping', () => {
    expect(degroup('18,00,000')).toBe(1800000);
    expect(degroup('1,50,00,000')).toBe(15000000);
  });

  it('reads western 3-digit grouping', () => {
    expect(degroup('150,000')).toBe(150000);
    expect(degroup('1,200,000')).toBe(1200000);
  });

  it('returns null for grouping that matches neither shape', () => {
    // This is the exact corruption upstream produces internally.
    expect(degroup('18,00000')).toBeNull();
    expect(degroup('1,2,3')).toBeNull();
  });

  it('reads ungrouped digits and decimals', () => {
    expect(degroup('2500000')).toBe(2500000);
    expect(degroup('1.2')).toBe(1.2);
  });
});

describe('parseComp', () => {
  it('parses rupee amounts written in full', () => {
    expect(parseComp('₹18,00,000')).toEqual(parsed(1800000, 1800000, 'INR'));
  });

  it('parses lakh and crore shorthand', () => {
    expect(parseComp('25 LPA')).toEqual(parsed(2500000, 2500000, 'INR'));
    expect(parseComp('₹25L')).toEqual(parsed(2500000, 2500000, 'INR'));
    expect(parseComp('25 lakh')).toEqual(parsed(2500000, 2500000, 'INR'));
    expect(parseComp('1.2 Cr')).toEqual(parsed(12000000, 12000000, 'INR'));
    expect(parseComp('1.2 crore')).toEqual(parsed(12000000, 12000000, 'INR'));
  });

  it('parses ranges', () => {
    expect(parseComp('₹50-70 LPA')).toEqual(parsed(5000000, 7000000, 'INR'));
    expect(parseComp('$150K-200K')).toEqual(parsed(150000, 200000, 'USD'));
  });

  it('applies a trailing magnitude to both ends of a range', () => {
    expect(parseComp('₹50-70 LPA')).toEqual(parsed(5000000, 7000000, 'INR'));
  });

  it('parses a trailing currency code', () => {
    expect(parseComp('2500000 INR')).toEqual(parsed(2500000, 2500000, 'INR'));
  });

  it('refuses rather than guessing when currency is unknown', () => {
    // Upstream returns 18 here. A wrong number is worse than no number. Both
    // strings carry a plausible, well-grouped figure with no currency
    // symbol, code, or magnitude word anywhere to anchor it — a human needs
    // to look, so this is `refused`, not the neutral `absent`.
    expectRefused(parseComp('18,00,000'), 'currency unknown');
    expectRefused(parseComp('150,000'), 'currency unknown');
  });

  it('refuses an ambiguous yen/yuan symbol', () => {
    expectRefused(parseComp('¥8,000,000'), 'ambiguous currency symbol');
  });

  it('is absent for text carrying no figure at all', () => {
    // No digit run anywhere — there is nothing here for a human to review,
    // unlike the bare-number case above.
    expectAbsent(parseComp('competitive salary'));
    expectAbsent(parseComp(''));
  });

  describe('anchoring — a figure only counts when tied to a compensation signal', () => {
    it('does not fold unrelated figures (equity, job IDs, bonus periods) into the range', () => {
      // Equity is not salary. Two unjoined anchored figures are ambiguous —
      // a human must look, so this is `refused`, not a silent pass.
      expectRefused(parseComp('$80K base + $150K equity over 4 years'), 'multiple anchored figures');
      // The job ID is unanchored — it must be ignored, not become the max.
      expect(parseComp('$50K Job ID 999999')).toEqual(parsed(50000, 50000, 'USD'));
      // "12 months" is unanchored — it must not become a ₹12 minimum.
      expect(parseComp('₹45 LPA + 12 months bonus')).toEqual(parsed(4500000, 4500000, 'INR'));
    });

    it('refuses rather than silently relabelling currency between two figures', () => {
      expectRefused(parseComp('$100K or ₹80L'), 'multiple anchored figures');
    });

    it('refuses when a magnitude word and a currency symbol disagree', () => {
      // "L" implies INR; "$" says USD. Self-contradictory — never guess.
      expectRefused(parseComp('$50L'), 'implies INR but a different currency symbol');
      expectRefused(parseComp('€25 LPA'), 'implies INR but a different currency symbol');
    });

    it('annualises a monthly figure and reports it as year', () => {
      // 4,50,000/month is not 4,50,000/year — that is a 12x understatement.
      expect(parseComp('₹4,50,000/month')).toEqual(parsed(5400000, 5400000, 'INR'));
    });
  });

  describe('range connectors', () => {
    it('accepts an en dash as a range connector', () => {
      expect(parseComp('₹50–70 LPA')).toEqual(parsed(5000000, 7000000, 'INR'));
    });

    it('accepts the word "to" as a range connector', () => {
      expect(parseComp('$100K to $150K')).toEqual(parsed(100000, 150000, 'USD'));
    });
  });

  describe('period detection', () => {
    it('refuses hourly, weekly, and daily figures — annualising would guess hours worked', () => {
      expectRefused(parseComp('$50/hour'), 'unsupported pay period');
      expectRefused(parseComp('$50 per hour'), 'unsupported pay period "per hour"');
      expectRefused(parseComp('₹5000 per week'), 'unsupported pay period "per week"');
      expectRefused(parseComp('₹5000/day'), 'unsupported pay period');
    });

    it('accepts "Rs." as a currency prefix', () => {
      expect(parseComp('Rs. 25,00,000')).toEqual(parsed(2500000, 2500000, 'INR'));
    });
  });

  describe('period detection — three outcomes, not two', () => {
    it('refuses to guess for recognised-but-unsupported periods (biweekly, quarterly, ...), naming the marker', () => {
      // Biweekly can't be annualised without assuming a pay-period count.
      expectRefused(parseComp('$3000 biweekly'), 'unsupported pay period "biweekly"');
      expectRefused(parseComp('₹50,000 quarterly'), 'unsupported pay period "quarterly"');
      expectRefused(parseComp('₹50,00,000 fortnightly'), 'unsupported pay period "fortnightly"');
      expectRefused(parseComp('$50K semi-monthly'), 'unsupported pay period "semi-monthly"');
    });

    it('annualises bare "pm" — the commonest Indian monthly shorthand', () => {
      expect(parseComp('₹50,000 pm')).toEqual(parsed(600000, 600000, 'INR'));
    });

    it('recognises "pa" and "p.a." as an explicit annual marker', () => {
      expect(parseComp('₹50,00,000 pa')).toEqual(parsed(5000000, 5000000, 'INR'));
      expect(parseComp('₹50,00,000 p.a.')).toEqual(parsed(5000000, 5000000, 'INR'));
    });

    it('reads a leading period marker before the figure', () => {
      expect(parseComp('Monthly salary: ₹1,00,000')).toEqual(parsed(1200000, 1200000, 'INR'));
      expect(parseComp('Monthly CTC - ₹50,000')).toEqual(parsed(600000, 600000, 'INR'));
    });

    it('refuses when a leading and a trailing marker disagree, naming both', () => {
      expectRefused(
        parseComp('Monthly salary: ₹1,00,000 per annum'),
        'conflicting pay-period markers: "Monthly" before the figure vs "per annum" after it',
      );
    });

    it('does not let a period word far away in unrelated prose set the period', () => {
      expect(parseComp('Weekly team standup happens every Monday. Salary: $150K')).toEqual(
        parsed(150000, 150000, 'USD'),
      );
    });

    it('does not let a clock time after the figure be read as a monthly marker', () => {
      // This is the regression the trailing-only design exists to protect:
      // the unanchored "5" is dropped, and "p.m." here is a clock time, not
      // a period marker immediately following the figure.
      expect(parseComp('$150K, interview at 5 p.m.')).toEqual(parsed(150000, 150000, 'USD'));
    });

    it('does not let a bare period abbreviation fire inside an unrelated word', () => {
      // "pm" inside "PMP", "pa" inside "package", "ph" inside "Ph.D." must
      // not be misread as period markers.
      expect(parseComp('$150K, PMP certified')).toEqual(parsed(150000, 150000, 'USD'));
      expect(parseComp('$150K, package includes relocation')).toEqual(parsed(150000, 150000, 'USD'));
      expect(parseComp('$150K, Ph.D. required')).toEqual(parsed(150000, 150000, 'USD'));
    });

    it('does not let a compound word be misread as the shorter marker it contains', () => {
      // "semi-monthly" contains "monthly" after a hyphen (a real \b there),
      // so a naive check must not read it as plain "monthly" and silently
      // multiply by 12 — it is an unsupported period, not a monthly one.
      expectRefused(parseComp('Semi-monthly compensation: $50,000'), 'unsupported pay period "Semi-monthly"');
      expectRefused(parseComp('Fortnightly compensation: $50,000'), 'unsupported pay period "Fortnightly"');
    });

    it('does not let a glued run of letters manufacture a false leading marker', () => {
      // A naive fixed-width backward slice can truncate a glued prefix
      // exactly at the marker's first letter, and start-of-string always
      // counts as a word boundary — manufacturing a "monthly" that was never
      // actually a separate word.
      expect(parseComp('XXXmonthly salary: $100K')).toEqual(parsed(100000, 100000, 'USD'));
    });
  });
});

describe('meetsFloor', () => {
  const floor = { INR: 5000000, USD: 110000 };

  it('passes a role at or above the floor', () => {
    expect(meetsFloor(parseComp('₹55 LPA'), floor)).toBe('pass');
    expect(meetsFloor(parseComp('$120K'), floor)).toBe('pass');
  });

  it('fails a role whose whole range sits below the floor', () => {
    expect(meetsFloor(parseComp('₹30-40 LPA'), floor)).toBe('fail');
  });

  it('passes a range that straddles the floor', () => {
    expect(meetsFloor(parseComp('₹45-12 LPA'), floor)).toBe('pass');
  });

  it('passes when compensation is absent — never penalise missing data', () => {
    expect(meetsFloor(parseComp('competitive salary'), floor)).toBe('pass');
    expect(meetsFloor(parseComp(''), floor)).toBe('pass');
  });

  it('sends a refusal to review rather than silently passing it', () => {
    // The motivating regression: "₹30 LPA + ₹20L joining bonus" has two
    // unjoined anchored figures. Read loosely it looks like a clear reject
    // against a ₹50L floor (the base alone is ₹30L), but the old boolean
    // API mapped every null — refusal included — to `true`, silently
    // passing a posting that never should have cleared the bar.
    const floor50L = { INR: 5000000, USD: 110000 };
    expect(meetsFloor(parseComp('₹30 LPA + ₹20L joining bonus'), floor50L)).toBe('review');
    // Contrast: the same base alone, with nothing to refuse over, correctly
    // fails outright.
    expect(meetsFloor(parseComp('₹30 LPA'), floor50L)).toBe('fail');
  });

  it('passes a monthly figure that clears the floor only after annualisation', () => {
    // ₹4,50,000/month = ₹54L/year, which clears the ₹50L floor.
    // Read as a flat ₹4,50,000 annual figure it would wrongly fail.
    expect(meetsFloor(parseComp('₹4,50,000/month'), floor)).toBe('pass');
  });
});

describe('brief cases via parseCompRange', () => {
  it('parses the headline shapes', () => {
    expect(parseCompRange('₹18,00,000')).toEqual({ min: 1800000, max: 1800000, currency: 'INR', period: 'year' });
    expect(parseCompRange('25 LPA')).toEqual({ min: 2500000, max: 2500000, currency: 'INR', period: 'year' });
    expect(parseCompRange('18-25 LPA')).toEqual({ min: 1800000, max: 2500000, currency: 'INR', period: 'year' });
    expect(parseCompRange('₹1.2 Cr')).toEqual({ min: 12000000, max: 12000000, currency: 'INR', period: 'year' });
    expect(parseCompRange('$150,000 - $180,000')).toEqual({ min: 150000, max: 180000, currency: 'USD', period: 'year' });
    expect(parseCompRange('€70k')).toEqual({ min: 70000, max: 70000, currency: 'EUR', period: 'year' });
  });
  it('returns null for absent and refused text', () => {
    expect(parseCompRange('competitive salary')).toBeNull();
    expect(parseCompRange('₹30 LPA + ₹20L joining bonus')).toBeNull();
  });
});

const fx: Fx = { asOf: '2026-10-01', toINR: { USD: 83.5, EUR: 90.2, GBP: 106.4, INR: 1 } };

describe('toInrPerYear', () => {
  it('leaves INR unchanged', () => {
    expect(toInrPerYear({ min: 1800000, max: 2500000, currency: 'INR', period: 'year' }, fx)).toEqual({
      min: 1800000,
      max: 2500000,
    });
  });
  it('converts USD with the fixture fx', () => {
    expect(toInrPerYear({ min: 100000, max: 200000, currency: 'USD', period: 'year' }, fx)).toEqual({
      min: 8350000,
      max: 16700000,
    });
  });
  it('converts EUR and GBP', () => {
    expect(toInrPerYear({ min: 70000, max: 70000, currency: 'EUR', period: 'year' }, fx).max).toBeCloseTo(6314000);
    expect(toInrPerYear({ min: 10, max: 20, currency: 'GBP', period: 'year' }, fx).max).toBeCloseTo(2128);
  });
});

describe('belowFloor', () => {
  const floor: NonNullable<Offers['floor']> = { amount: 1200000, currency: 'INR', period: 'year', basis: 'base' };
  it('is true when max is under the floor', () => {
    expect(belowFloor({ min: 1000000, max: 1199999 }, floor)).toBe(true);
  });
  it('is false at exactly the floor', () => {
    expect(belowFloor({ min: 1000000, max: 1200000 }, floor)).toBe(false);
  });
  it('is false above the floor', () => {
    expect(belowFloor({ min: 1000000, max: 1200001 }, floor)).toBe(false);
  });
  it('converts a non-INR floor with fx', () => {
    const usd = { ...floor, amount: 100000, currency: 'USD' as const };
    expect(belowFloor({ min: 0, max: 8349999 }, usd, fx)).toBe(true);
    expect(belowFloor({ min: 0, max: 8350000 }, usd, fx)).toBe(false);
  });
});
