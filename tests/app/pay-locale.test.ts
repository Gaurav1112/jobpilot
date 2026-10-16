import { describe, expect, it } from 'vitest';
import { effectiveComp, localNumber, parsePay } from '../../src/app/comp/locale.js';
import type { Posting } from '../../src/app/types.js';

// Fictional fixed rates (the fixture pack's four, plus made-up rates for the extra currencies these cases use).
const fx = { toINR: { USD: 83.5, EUR: 90.2, GBP: 106.4, INR: 1, CAD: 61.2 } };
const de = { locale: 'de' as const, home: 'EUR' as const, fx };
const ca = { locale: 'en' as const, home: 'CAD' as const, fx };

describe('parsePay', () => {
  it.each([
    ['Gehalt: 60.000 – 75.000 € brutto pro Jahr', de, { min: 60000, max: 75000, currency: 'EUR' }],
    ['Salary €60k - €75k per year', de, { min: 60000, max: 75000, currency: 'EUR' }],
    ['Gehalt 60.000,00 € jährlich', de, { min: 60000, max: 60000, currency: 'EUR' }],
    ['Gehalt bis zu 75.000 €', de, { min: null, max: 75000, currency: 'EUR' }],
    ['Gehalt ab 60.000 €', de, { min: 60000, max: null, currency: 'EUR' }],
    ['5.000 € brutto monatlich', de, { min: 60000, max: 60000, currency: 'EUR' }],
    ['Salary CA$110,000 - CA$130,000 annually', ca, { min: 110000, max: 130000, currency: 'CAD' }],
    ['Salary $110,000 - $130,000', ca, { min: 110000, max: 130000, currency: 'CAD' }],
    ['Salary $110,000 - $130,000', de, { min: 110000, max: 130000, currency: 'USD' }],
  ])('%s', (text, o, want) => {
    expect(parsePay(text, o)).toMatchObject({ ...want, period: 'year', basis: 'base' });
  });
  it.each([
    ['45 € pro Stunde', de],
    ['60.000 Mitarbeiter weltweit', de],
    ['up to €5', de],
    ['¥8,000,000', de],
    // Fix round 1 (C1): a figure with no salary wording in its sentence is not pay, whatever its shape
    ['60.000,00 € jährlich', de],
    ['bis zu 75.000 €', de],
    ['ab 60.000 €', de],
    ['5.000 € monatlich', de],
    ['CA$110,000 - CA$130,000 annually', ca],
    ['$110,000 - $130,000', ca],
  ])('no comp: %s', (text, o) => {
    expect(parsePay(text, o)).toBeNull();
  });
  it('OTE wording makes the basis unknown', () => {
    expect(parsePay('OTE 90.000 € pro Jahr', de)?.basis).toBe('unknown');
  });
});

// Adversarial cases. Every figure is fictional; the rates below are made up.
const fx2 = { toINR: { ...fx.toINR, CHF: 94.1, JPY: 0.56, SEK: 7.9, PLN: 21, BRL: 16.5, DKK: 12.1, ZAR: 4.6 } };
const opt = (locale: 'en' | 'de' | 'fr' | 'nl' | 'es' | 'it' | 'pl' | 'sv', home: string) => ({ locale, home: home as never, fx: fx2 });

describe('parsePay: locale readings', () => {
  it.each([
    // "1.200" is 1200 in de (a group), so a month of it is 14,400 a year
    ['Gehalt 1.200 € pro Monat, Teilzeit', opt('de', 'EUR'), { min: 14400, max: 14400, currency: 'EUR' }],
    // "12,5k" is 12,500 in de (decimal comma, then k)
    ['Gehalt 12,5k € pro Jahr', opt('de', 'EUR'), { min: 12500, max: 12500, currency: 'EUR' }],
    ['Gehalt 3.000-4.000 €/Monat', opt('de', 'EUR'), { min: 36000, max: 48000, currency: 'EUR' }],
    ['Salary CHF 120\'000 - 140\'000', opt('de', 'CHF'), { min: 120000, max: 140000, currency: 'CHF' }],
    ['Lohn: CHF 120’000.– pro Jahr', opt('de', 'CHF'), { min: 120000, max: 120000, currency: 'CHF' }],
    ['Salário R$ 15.000 por mês', opt('es', 'BRL'), { min: 180000, max: 180000, currency: 'BRL' }],
    ['Salary ¥8,000,000', opt('en', 'JPY'), { min: 8000000, max: 8000000, currency: 'JPY' }],
    ['Rémunération : 55 000 € à 65 000 € par an', opt('fr', 'EUR'), { min: 55000, max: 65000, currency: 'EUR' }],
    ['Salaire 55 000 € brut annuel', opt('fr', 'EUR'), { min: 55000, max: 55000, currency: 'EUR' }],
    ['Salaris: € 4.500 per maand', opt('nl', 'EUR'), { min: 54000, max: 54000, currency: 'EUR' }],
    ['Retribución: 40.000 - 50.000 € brutos al año', opt('es', 'EUR'), { min: 40000, max: 50000, currency: 'EUR' }],
    ['RAL 35.000 - 45.000 € annui', opt('it', 'EUR'), { min: 35000, max: 45000, currency: 'EUR' }],
    ['Wynagrodzenie 8 500 - 10 000 zł brutto miesięcznie', opt('pl', 'PLN'), { min: 102000, max: 120000, currency: 'PLN' }],
    ['Lön 45 000 kr/mån', opt('sv', 'SEK'), { min: 540000, max: 540000, currency: 'SEK' }],
    ['Gehalt zwischen 60.000 und 75.000 EUR', opt('de', 'EUR'), { min: 60000, max: 75000, currency: 'EUR' }],
    ['Gehalt 60.000,– € jährlich', opt('de', 'EUR'), { min: 60000, max: 60000, currency: 'EUR' }],
    ['Gehalt EUR 60.000 bis 75.000', opt('de', 'EUR'), { min: 60000, max: 75000, currency: 'EUR' }],
    // a figure in en grouping on a de profile is read once more in en
    ['Salary $95,000 per year', opt('de', 'EUR'), { min: 95000, max: 95000, currency: 'USD' }],
    // years of experience next to a salary are not read as pay
    ['Mindestens 5 Jahre Erfahrung, Gehalt 60.000 €', opt('de', 'EUR'), { min: 60000, max: 60000, currency: 'EUR' }],
    ['Salary €60k+', opt('en', 'EUR'), { min: 60000, max: null, currency: 'EUR' }],
  ])('%s', (text, o, want) => {
    expect(parsePay(text, o)).toMatchObject({ ...want, period: 'year', basis: 'base' });
  });

  it.each([
    // en has no "." group, and 1.200 as a decimal is not a salary
    ['CA$1.200 per month', opt('en', 'CAD')],
    ['€60.000 per year', opt('en', 'CAD')],
    ['₩60,000,000', opt('en', 'EUR')],
    ['NT$1,200,000 per year', opt('en', 'CAD')],
    ['Version 2.10.300 kostet 49 €', opt('de', 'EUR')],
    ['Release 1.2.3 €', opt('de', 'EUR')],
    ['Start am 01.10.2026, € 15.10.2026', opt('de', 'EUR')],
    ['Tel. +49 30 123 456 78, Gehalt nach Vereinbarung', opt('de', 'EUR')],
    ['401(k) matching up to $6,000 per year', opt('en', 'CAD')],
    ['24/7 support rota, €60 per hour', opt('en', 'EUR')],
    ['5+ years of experience in € markets', opt('en', 'EUR')],
    ['Tagessatz 600 €', opt('de', 'EUR')],
    ['€500 per day', opt('en', 'EUR')],
    ['€1,500 per week', opt('en', 'EUR')],
    ['2.000 € Weiterbildungsbudget pro Jahr', opt('de', 'EUR')],
    ['Urlaubsgeld 2.000 €', opt('de', 'EUR')],
    ['Signing bonus €10,000', opt('en', 'EUR')],
    ['Wir haben 5.000.000 € Finanzierung eingesammelt', opt('de', 'EUR')],
    ['45 000 kr per månad', opt('sv', 'EUR')],
    ['60.000 € – 50.000 €', opt('de', 'EUR')],
    ['Gehalt 60.000', opt('de', 'EUR')],
    ['bis zu 60.000 € oder mehr', opt('de', 'EUR')],
    ['Salary v60000 €', opt('en', 'EUR')],
    ['Salary 60000kg €', opt('en', 'EUR')],
    ['R 650 000 per year', opt('en', 'EUR')],
  ])('no comp: %s', (text, o) => {
    expect(parsePay(text, o)).toBeNull();
  });

  it('basis: a bonus beside the salary makes it unknown; a bare total is unknown', () => {
    expect(parsePay('Gehalt 60.000 € plus Bonus', opt('de', 'EUR'))).toMatchObject({ min: 60000, max: 60000, basis: 'unknown' });
    expect(parsePay('Total compensation €90k per year', opt('en', 'EUR'))?.basis).toBe('unknown');
  });

  it('kr is the home krone only, and ZAR R only for a ZAR home', () => {
    expect(parsePay('Løn 45.000 kr. om måneden', opt('de', 'DKK'))).toMatchObject({ min: 540000, currency: 'DKK' });
    expect(parsePay('Salary R 650 000 per year', opt('fr', 'ZAR'))).toMatchObject({ min: 650000, currency: 'ZAR' });
  });

  it('several figures: the home currency wins, ranges of one currency are joined', () => {
    expect(parsePay('Gehalt 60.000 € (ca. CHF 58\'000). Senior-Gehalt: bis 80.000 €', opt('de', 'EUR'))).toMatchObject({ min: null, max: 80000, currency: 'EUR' });
    expect(parsePay('Gehalt Junior 50.000 €. Gehalt Senior 70.000 €', opt('de', 'EUR'))).toMatchObject({ min: 50000, max: 70000, currency: 'EUR' });
  });

  it('a currency without a rate gives no comp', () => {
    expect(parsePay('Salary SGD 120,000', opt('en', 'CAD'))).toBeNull();
  });

  // Measured alone the worst case is about 60 ms (a 1 MB run of ". A" sentences); 200 ms leaves room for the load of
  // the full suite running in parallel.
  it('is linear on 1 MB adversarial text (< 200 ms each)', () => {
    const mb = 1 << 20;
    const cases = [
      '1.'.repeat(mb / 2),
      `${'€'.repeat(mb)}1`,
      `${'–'.repeat(mb)}1`,
      `${'₩'.repeat(mb)}1`,
      `${'CA$'.repeat(mb / 3)}1`,
      `1${'€'.repeat(mb)}`,
      `Gehalt ${'€1-'.repeat(mb / 3)}`,
      '€1 '.repeat(mb / 3),
      'Gehalt 60.000 € pro Jahr. '.repeat(mb / 26),
      `${'annual '.repeat(mb / 7)}€60,000`,
      '1 '.repeat(mb / 2),
      'CA$'.repeat(mb / 3),
      `${'9'.repeat(mb)} €`,
    ];
    parsePay(cases[0] as string, opt('fr', 'EUR')); // warm up
    for (const text of cases) {
      for (const o of [opt('de', 'EUR'), opt('fr', 'EUR'), opt('en', 'CAD')]) {
        const t = performance.now();
        parsePay(text, o);
        expect(performance.now() - t, `${text.slice(0, 12)}… ${o.locale}`).toBeLessThan(200);
      }
    }
  });
});

describe('localNumber', () => {
  it.each([
    ['60.000,50', 'de', 60000.5],
    ['60,000.50', 'en', 60000.5],
    ['60k', 'en', 60000],
    ['1.200', 'de', 1200],
    ['1.200', 'en', null],
    ['1,200', 'de', null],
    ['12,5k', 'de', 12500],
    ['60 000', 'fr', 60000],
    ['60 000', 'de', null],
    ["120'000", 'de', 120000],
    ['1.2.3', 'de', null],
    ['01.10', 'de', null],
    ['0800', 'en', null],
    ['1.000.000', 'it', 1000000],
    ['1.000,000', 'de', null],
  ] as const)('%s (%s) is %s', (token, locale, want) => {
    expect(localNumber(token, locale)).toBe(want);
  });
});

describe('effectiveComp', () => {
  const posting = (text: string, comp: Posting['comp'] = null): Posting => ({
    jobKey: '0123456789abcdef', dedupeKey: 'fedcba9876543210', source: 'greenhouse', sourceId: 's1', company: 'Unlisted Co', slug: 'unlisted', ats: 'greenhouse',
    title: 'Senior Backend Engineer', url: 'https://jobs.example.com/1', locationText: 'Remote', remote: { structured: 'remote', countries: [], signals: [] },
    employmentType: null, descriptionText: text, postedAt: null, comp, yearsRequired: null,
  });
  const packOf = (currency: string, payLocale?: 'de' | 'en') => ({
    offers: { floor: { amount: 1, currency }, ...(payLocale === undefined ? {} : { payLocale }) },
    fx: fx2,
  });
  const text = 'Gehalt: 45.000 – 50.000 € brutto pro Jahr';
  it('the default currencies without a payLocale keep the posting comp, untouched', () => {
    for (const c of ['INR', 'USD', 'EUR', 'GBP']) expect(effectiveComp(posting(text), packOf(c))).toBeNull();
    const comp = { min: 1, max: 2, currency: 'USD', period: 'year', basis: 'base' } as const;
    const p = posting(text, comp);
    expect(effectiveComp(p, packOf('EUR', 'de'))).toBe(comp);
    expect(effectiveComp(p, packOf('INR'))).toBe(comp);
  });
  it('a payLocale or a currency outside the four parses the description', () => {
    expect(effectiveComp(posting(text), packOf('EUR', 'de'))).toMatchObject({ min: 45000, max: 50000, currency: 'EUR' });
    expect(effectiveComp(posting('Salary CA$110,000 - CA$130,000'), packOf('CAD'))).toMatchObject({ min: 110000, max: 130000, currency: 'CAD' });
    expect(effectiveComp(posting('Lohn 45.000 kr. om måneden'), { offers: { floor: null }, fx: fx2 })).toBeNull();
  });
});

describe('the pay-locale eval', () => {
  it('has at least 40 cases, every locale, and passes its gate of 1.0', async () => {
    const { join } = await import('node:path');
    const { appEvalSpecs } = await import('../../src/app/evals.js');
    const { runEval } = await import('../../src/evals/runner.js');
    const { PRODUCT_POLICY_V1 } = await import('../../src/kernel/policy.js');
    const root = join(import.meta.dirname, '../..');
    const spec = appEvalSpecs(join(root, 'evals/datasets'), join(root, 'tests/fixtures/pack')).find((s) => s.name === 'pay-locale')!;
    expect(spec.cases.length).toBeGreaterThanOrEqual(40);
    expect(new Set(spec.cases.map((c) => (c.input as { locale: string }).locale))).toEqual(new Set(['en', 'de', 'fr', 'nl', 'es', 'it', 'pl', 'sv']));
    const r = await runEval(spec, { providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, policy: PRODUCT_POLICY_V1 });
    expect(r.failures).toEqual([]);
    expect(r).toMatchObject({ name: 'pay-locale', score: 1, pass: true });
  });
});

describe('fix round 1', () => {
  const de = opt('de', 'EUR');
  const en = opt('en', 'CAD');
  // C1: money that is not salary, with no salary wording beside it (fictional figures)
  const notPay: Array<[string, ReturnType<typeof opt>]> = [
    ['There is a $5k bounty for a working port.', en],
    ['$4000/month for the team lunch fund', en],
    ['We spend $250,000 on cloud every year.', en],
    ['The winner gets a $10,000 prize.', en],
    ['Our product costs $12,000 a year.', en],
    ['Hardware im Wert von 3.000 €', de],
    ['Firmenwagen im Wert von 45.000 €', de],
    ['Empfehlungsbonus: 2.000 €', de],
    ['Inflationsausgleich 3.000 €', de],
    ['Lizenzkosten 20.000 € pro Jahr', de],
    ['Marketingetat 500.000 €', de],
    ['Wir spenden 10.000 € im Jahr.', de],
    ['Preis der Lizenz: 9.900 €', de],
    ['Unsere Kunden sparen bis zu 120.000 €.', de],
    ['Fahrtkostenerstattung bis 150 € monatlich', de],
    ["Ordinateur portable d'une valeur de 2 500 €", opt('fr', 'EUR')],
    ['Laptop ter waarde van € 2.500', opt('nl', 'EUR')],
    ['Portátil valorado en 2.500 €', opt('es', 'EUR')],
    ['Laptop del valore di 2.500 €', opt('it', 'EUR')],
  ];
  it.each(notPay)('C1 no comp: %s', (text, o) => {
    expect(parsePay(text, o)).toBeNull();
  });

  it.each([
    // I1: a period word right after a letter or "/"
    ['Gehalt 4.500 € brutto/Monat', de, { min: 54000, max: 54000, currency: 'EUR' }],
    ['Salaire 3 800 € brut/mois', opt('fr', 'EUR'), { min: 45600, max: 45600, currency: 'EUR' }],
    ['Salary: $3,500-$5,000 USD/month', opt('en', 'USD'), { min: 42000, max: 60000, currency: 'USD' }],
    ['Gehalt: 13 Monatsgehälter à 5.000 €', de, { min: 60000, max: 60000, currency: 'EUR' }],
    // I2: an explicit code beside a bare $ wins over the home dollar
    ['Salary $90,000 - $110,000 USD', en, { min: 90000, max: 110000, currency: 'USD' }],
    ['Base salary: $100k–$175k usd per year.', opt('en', 'SGD'), { min: 100000, max: 175000, currency: 'USD' }],
    ['Base salary USD $95,000', en, { min: 95000, max: 95000, currency: 'USD' }],
    // a perk in another clause of the salary sentence vetoes only itself
    ['Base salary: $120,000 - $150,000, health insurance, $2,000 learning stipend', en, { min: 120000, max: 150000, currency: 'CAD' }],
    ['Gehalt 60.000 € brutto, plus 1.000 € Weiterbildungsbudget', de, { min: 60000, max: 60000, currency: 'EUR' }],
    ['Gehalt 60.000 € brutto, 13. Gehalt 2.000 €', de, { min: 60000, max: 60000, currency: 'EUR' }],
    // French k€, Portuguese "mensais"
    ['Salaire 45-55 k€ brut annuel', opt('fr', 'EUR'), { min: 45000, max: 55000, currency: 'EUR' }],
    ['Salaire 45 k€ - 55 k€', opt('fr', 'EUR'), { min: 45000, max: 55000, currency: 'EUR' }],
    ['Salário R$ 12.000 mensais', opt('es', 'BRL'), { min: 144000, max: 144000, currency: 'BRL' }],
  ] as const)('%s', (text, o, want) => {
    expect(parsePay(text, o)).toMatchObject({ ...want, basis: 'base' });
  });

  it('an ambiguous pair of codes after a bare $ is no currency', () => {
    expect(parsePay('Salary $160,000–$200,000 CAD/USD', en)).toBeNull();
  });

  it('a 13th-month payment alone is a component, not base pay', () => {
    expect(parsePay('13. Gehalt 2.000 €', de)).toBeNull();
  });

  it('CHF with a dot group needs a payLocale that groups with dots', () => {
    expect(parsePay('Salary CHF 120.000', opt('en', 'CHF'))).toBeNull();
    expect(parsePay('Salary CHF 120.000', opt('de', 'CHF'))).toMatchObject({ min: 120000, currency: 'CHF' });
  });
});
