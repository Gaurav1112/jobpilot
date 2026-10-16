/**
 * The currencies a profile's pay floor may be in (profiles Task 17). INR is the internal pivot: every posting's pay is
 * converted to INR with the pack's fixed `fx.toINR` rates and compared there, so reason codes and step outputs keep
 * INR units. A profile's home currency (the floor's) is what the dashboard shows; INR is never shown to a non-INR
 * profile. Pure: no imports.
 */
export const CURRENCY_CODES = ['INR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'AED', 'BRL', 'MXN', 'ZAR', 'ILS'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

/** Each currency's symbol, its decimals (JPY 0, others 2) and the locale its amounts are written in. */
export const CURRENCIES: Readonly<Record<CurrencyCode, { symbol: string; decimals: number; locale: string }>> = {
  INR: { symbol: '₹', decimals: 2, locale: 'en-IN' }, USD: { symbol: '$', decimals: 2, locale: 'en-US' }, EUR: { symbol: '€', decimals: 2, locale: 'de-DE' },
  GBP: { symbol: '£', decimals: 2, locale: 'en-GB' }, CAD: { symbol: 'CA$', decimals: 2, locale: 'en-CA' }, AUD: { symbol: 'A$', decimals: 2, locale: 'en-AU' },
  NZD: { symbol: 'NZ$', decimals: 2, locale: 'en-NZ' }, SGD: { symbol: 'S$', decimals: 2, locale: 'en-SG' }, HKD: { symbol: 'HK$', decimals: 2, locale: 'en-HK' },
  JPY: { symbol: '¥', decimals: 0, locale: 'ja-JP' }, CHF: { symbol: 'CHF', decimals: 2, locale: 'de-CH' }, SEK: { symbol: 'kr', decimals: 2, locale: 'sv-SE' },
  NOK: { symbol: 'kr', decimals: 2, locale: 'nb-NO' }, DKK: { symbol: 'kr.', decimals: 2, locale: 'da-DK' }, PLN: { symbol: 'zł', decimals: 2, locale: 'pl-PL' },
  CZK: { symbol: 'Kč', decimals: 2, locale: 'cs-CZ' }, AED: { symbol: 'AED', decimals: 2, locale: 'en-AE' }, BRL: { symbol: 'R$', decimals: 2, locale: 'pt-BR' },
  MXN: { symbol: 'MX$', decimals: 2, locale: 'es-MX' }, ZAR: { symbol: 'R', decimals: 2, locale: 'en-ZA' }, ILS: { symbol: '₪', decimals: 2, locale: 'he-IL' },
};

export const isCurrencyCode = (c: string): c is CurrencyCode => (CURRENCY_CODES as readonly string[]).includes(c);

/** The profile's home currency: the floor's, else INR (no floor). */
export const homeCurrencyOf = (pack: { offers: { floor: { currency: string } | null } }): CurrencyCode => {
  const c = pack.offers.floor?.currency ?? 'INR';
  return isCurrencyCode(c) ? c : 'INR';
};

/** A pivot (INR) amount in the home currency, whole units, at the pack's fixed rates. */
export function pivotToHome(inr: number, home: CurrencyCode, fx: { toINR: Readonly<Record<string, number>> }): number {
  const rate = fx.toINR[home];
  if (rate === undefined) throw new Error(`fx.yaml has no toINR rate for ${home}`);
  return Math.round(inr / rate);
}

/**
 * How a profile's postings write pay (profiles Task 18): `offers.payLocale`, read by `comp/locale.ts`. Here, in this
 * import-free module, so the pack schema can name them without importing the pay reader (which imports the normalizer).
 */
export const PAY_LOCALES = ['en', 'de', 'fr', 'nl', 'es', 'it', 'pl', 'sv'] as const;
export type PayLocale = (typeof PAY_LOCALES)[number];
