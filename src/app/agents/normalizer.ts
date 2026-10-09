import { defineAgent } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { KernelError } from '../../kernel/errors.js';
import { parseComp } from '../comp/parse.js';
import { decodeEntities, htmlToText, plainToText } from '../text/html.js';
import { countriesIn, excludedParts, excludedPlaces, jobKey, placeOf, postedAtOf, remoteTextSignals, withoutExcluded, yearsRequired } from '../text/norm.js';
import { Posting, RawPosting } from '../types.js';

/**
 * The normalizer: one RawPosting@1 in, exactly one Posting@1 out, by a fixed mapping per source (spec §5.1). It never
 * invents a value: a field the source does not state is null (or empty), and every list item and table cell of the
 * description survives into `descriptionText`.
 *
 * Per source, `raw` is what the adapter documents (src/app/agents/sources/*.ts):
 * - greenhouse: the job object; `content` is HTML-escaped HTML, `pay_input_ranges` are in cents, `location.name` is
 *   free text, there is no structured remote flag (`remote.structured` is null) and employment type only in a
 *   board's custom `metadata`;
 * - lever: the posting; full text = `description` + each `lists[]` (heading, items) + `additional` +
 *   `salaryDescription`; `workplaceType`, `categories.commitment`, `country` (ISO-2), `createdAt` (epoch ms),
 *   `salaryRange` (a 0/0 placeholder was already dropped by the adapter);
 * - ashby: the job; `isRemote`, `workplaceType`, `employmentType`, addresses, `compensation.summaryComponents`;
 * - himalayas: the job without `expiryDate`; `locationRestrictions` (empty = worldwide), `pubDate` in epoch seconds,
 *   `minSalary`/`maxSalary`/`currency`/`salaryPeriod`; a remote-only feed;
 * - jobicy: the job; `jobGeo` (a comma list), `jobType` (a list), `pubDate`, `salary*` fields; a remote-only feed;
 * - careers: `{url, jsonLd: JobPosting | null, title, text}` from the career-site source.
 *
 * A raw posting with no title or no http(s) URL cannot be a Posting: that one posting fails with `invalid_output`
 * (its own step only); nothing is emitted for it.
 */

type Comp = NonNullable<Posting['comp']>;
type Currency = Comp['currency'];
type Remote = Posting['remote'];
type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(v) ? Number(v) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
const oneLine = (s: string): string => decodeEntities(s).replace(/\s+/g, ' ').trim();
/** A list of strings (or one string) as one display string; null when there is nothing. */
const listText = (v: unknown, sep = ', '): string | null => {
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === 'string' && x.trim() !== '' ? [oneLine(x)] : []));
  return parts.length > 0 ? parts.join(sep) : null;
};
/** Plain-text description parts joined by a blank line, empty parts dropped. */
const joinParts = (parts: readonly string[]): string => parts.map((p) => p.trim()).filter((p) => p !== '').join('\n\n');
const REAL_TAG = /<\/?[a-z][a-z0-9]*\b[^>]*>/i;
/**
 * A description that may be HTML, HTML escaped once more, or plain text (schema.org allows all three): escaped HTML
 * is decoded first; plain text keeps its lines and bullets (`plainToText`).
 */
function htmlish(s: string): string {
  if (REAL_TAG.test(s)) return htmlToText(s);
  if (/&lt;\/?[a-z]/i.test(s)) return htmlToText(decodeEntities(s));
  return plainToText(s);
}

const fail = (raw: RawPosting, why: string): KernelError => new KernelError('invalid_output', `normalizer ${raw.source} ${raw.sourceId}: ${why}`);

// ---------------------------------------------------------------------------
// Compensation
// ---------------------------------------------------------------------------

const CURRENCIES: ReadonlySet<string> = new Set(['INR', 'USD', 'EUR', 'GBP']);

/**
 * A figure outside these bounds per year is not a salary: about ₹1 lakh to ₹10 crore. The normalizer reads no fx
 * table (it has no pack), so the bounds are a fixed table per currency. Each zone or component is judged alone: an
 * implausible one is dropped, the others stay.
 */
export const PLAUSIBLE_PER_YEAR: Readonly<Record<Currency, { readonly min: number; readonly max: number }>> = {
  INR: { min: 100_000, max: 100_000_000 },
  USD: { min: 1_200, max: 1_200_000 },
  EUR: { min: 1_100, max: 1_100_000 },
  GBP: { min: 1_000, max: 1_000_000 },
};

/** One disclosed range, already annualised, in a currency that may be unsupported. A null bound is not stated. */
interface Range {
  min: number | null;
  max: number | null;
  currency: string;
  base: boolean;
}

/**
 * A range from raw bounds, or null when neither bound is stated, a bound is negative, the bounds are inverted, there
 * is no currency, or the period cannot be annualised. A one-sided range keeps its known bound.
 */
function rangeOf(min: unknown, max: unknown, currency: unknown, perYear: number | null, base: boolean): Range | null {
  const lo = num(min);
  const hi = num(max);
  const cur = str(currency)?.trim().toUpperCase();
  if (cur === undefined || perYear === null || (lo === null && hi === null)) return null;
  if ((lo !== null && lo < 0) || (hi !== null && hi < 0) || (lo !== null && hi !== null && lo > hi)) return null;
  return { min: lo === null ? null : lo * perYear, max: hi === null ? null : hi * perYear, currency: cur, base };
}

const plausible = (r: Range): boolean => {
  const b = CURRENCIES.has(r.currency) ? PLAUSIBLE_PER_YEAR[r.currency as Currency] : undefined;
  return b === undefined || [r.min, r.max].every((v) => v === null || (v >= b.min && v <= b.max));
};

/**
 * The comp of a set of disclosed ranges. Implausible ranges are dropped one by one. An INR range is the one that
 * applies in India, so INR ranges win; otherwise every range must share one supported currency. The result is their
 * union (a bound is null when any range leaves it open), `base` only if every range is base pay. It is null for no
 * ranges, mixed or unsupported currencies, or a union open at both ends.
 */
function compOf(all: readonly Range[]): Comp | null {
  const ranges = all.filter(plausible);
  if (ranges.length === 0) return null;
  const inr = ranges.filter((r) => r.currency === 'INR');
  const use = inr.length > 0 ? inr : ranges;
  const currency = use[0]?.currency ?? '';
  if (!CURRENCIES.has(currency) || use.some((r) => r.currency !== currency)) return null;
  const mins = use.map((r) => r.min);
  const maxs = use.map((r) => r.max);
  const min = mins.some((v) => v === null) ? null : Math.min(...(mins as number[]));
  const max = maxs.some((v) => v === null) ? null : Math.max(...(maxs as number[]));
  if (min === null && max === null) return null;
  return { min, max, currency: currency as Currency, period: 'year', basis: use.every((r) => r.base) ? 'base' : 'unknown' };
}

/** Pay that is not base salary: its presence makes the basis `unknown`. */
const NOT_BASE =
  /\b(?:ote|on[- ]target|total\s+(?:comp\w*|cash|pay|rewards?|package|remuneration)|tc|commissions?|bonus(?:es)?|equity|rsus?|stocks?|esops?|options|variable|incentives?|target\s+(?:cash|comp\w*|earnings))\b/i;
/** Explicit base pay. CTC counts as base in India for floor purposes. */
const BASE = /\b(?:base|fixed|ctc)\b/i;
/** `base` iff the wording says base, fixed or CTC and names no other kind of pay. */
const basisIsBase = (s: string): boolean => BASE.test(s) && !NOT_BASE.test(s);
/** For a Greenhouse blurb, only these make a base title doubtful (blurbs routinely say "plus equity"). */
const BLURB_NOT_BASE = /\b(?:ote|on[- ]target|total\s+comp\w*|tc)\b/i;

/** Sentences that may state pay. */
const PAY_WORD =
  /\b(?:salary|salaries|base|pay|pays|compensation|ctc|lpa|remuneration)\b|\bper annum\b|\bp\.a\.|\/\s*(?:yr|year)\b|\bper year\b|\ba year\b|\bannually\b/i;
/** Sentences about money that is not pay. */
const NOT_PAY =
  /\b(?:raised|raising|funding|funded|valuation|revenue|arr|series|saved|save|saves|savings|budget|customers|users|clients|investors?|market cap)\b/i;
/** Pay that is not salary; a sentence that names only these (no base, salary, fixed or CTC) states no salary. */
const OTHER_PAY =
  /\b(?:equity|rsus?|stocks?|options|esops?|shares|bonus(?:es)?|commissions?|joining|sign[- ]on|relocation|stipend|allowance|referral|reimburse\w*|perks?|hra|pf|epf|esic|gratuity|da|lta|allowances?|reimbursements?|insurance|meal|flexi|variable|incentives?|ote|on[- ]target|tc|target\s+(?:cash|comp\w*|earnings)|total\s+(?:comp\w*|cash|pay|rewards?|package|remuneration))\b/i;
const SALARY_WORD = /\b(?:base|salary|salaries|fixed|ctc)\b/i;
/** Dollars that are not US dollars, and currency codes the Posting cannot carry: the parser would read `CA$` as USD. */
const FOREIGN_MONEY =
  /(?<![A-Za-z])(?:CA|C|A|AU|NZ|S|SG|HK|NT|R|MX|COL)\$|\b(?:CAD|AUD|SGD|NZD|HKD|JPY|CNY|RMB|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|BRL|MXN|ARS|CLP|COP|PHP|IDR|MYR|THB|VND|KRW|TWD|ZAR|AED|SAR|QAR|ILS|TRY|NGN|KES|PKR|BDT|LKR|NPR|EGP|UAH)\b|[₱฿₩₺₪₦]/;
/** A bare `$` beside a dollar country other than the US, with no USD or US$, is that country's dollar. */
const DOLLAR_COUNTRY = /\b(?:canada|canadian|australia|australian|singapore|hong kong|new zealand|mexico|taiwan)\b/i;
const US_DOLLAR = /\bUSD\b|US\$/;
/**
 * Sentence ends, plus `;` clauses. "Rs.", "No.", "min.", "max.", "i.e.", "incl." and "e.g." never end a sentence
 * ("incl." and "e.g." introduce a part or an example of the figure). "p.a." and "approx." end one only before a
 * capitalised word that does not start an amount (`US$150,000`, `CA$`, `INR 20,00,000`, `Rs. 5`): "₹12 LPA p.a.
 * Equity ..." splits, so the equity sentence cannot touch the salary or its basis, while "approx. US$150,000"
 * stays one sentence with the figure it introduces.
 */
const PAY_SENTENCE_SPLIT =
  /\n+|;\s*|(?<=[.!?])(?<!\b(?:[Rr][Ss]|[Nn]o|[Aa]pprox|e\.g|i\.e|[Ii]ncl|[Mm]in|[Mm]ax|vs|etc|[Mm]r|[Mm]s|[Dd]r|[Pp]\.[Aa])\.)\s+|(?<=\b(?:[Pp]\.[Aa]|[Aa]pprox)\.)\s+(?=[A-Z])(?![A-Z]{1,3}\$|(?:[A-Z]{3}|R[Ss])\.?\s*\d)/;
/** Where a money figure starts: a currency sign or code before digits, or digits with a magnitude word. */
const FIGURE = /(?:[₹$€£]|\b(?:rs\.?|inr|usd|eur|gbp)\s*)\s*\d[\d,]*(?:\.\d+)?\s*(?:lpa|lakhs?|lacs?|crores?|cr|k|m|l)?\b|\d[\d,]*(?:\.\d+)?\s*(?:lpa|lakhs?|lacs?|crores?|cr)\b/i;
const UP_TO = /\b(?:up ?to|upto|max(?:imum)?\.?(?: of)?|as high as|not exceeding|no more than)\s*:?\s*$/i;
const FROM = /\b(?:from|starting(?: at| from)?|starts at|at least|min(?:imum)?\.?(?: of)?|no less than)\s*:?\s*$/i;
const OR_MORE = /^\s*(?:\+|or more\b|and above\b|or higher\b|onwards\b)/i;

/** "incl. HRA ₹5 LPA", "including PF ...": a part of the figure before it, named only as non-salary pay. */
const INCLUDED_PART = /\s*\(?\b(?:incl\.?|including|inclusive of|includes)\s+[^;()]*\)?$/i;

/**
 * The sentence without a trailing "incl./including ..." part that names only non-salary pay (HRA, PF, gratuity ...)
 * and carries its own figure, when a figure remains: "Salary ₹20 LPA incl. HRA ₹5 LPA" is read as "Salary ₹20 LPA",
 * so the included part never becomes a bound. "Salary incl. HRA: ₹20 LPA" keeps its only figure.
 */
function withoutIncluded(sentence: string): string {
  const m = INCLUDED_PART.exec(sentence);
  if (m === null) return sentence;
  const part = m[0];
  const rest = sentence.slice(0, m.index);
  return OTHER_PAY.test(part) && !SALARY_WORD.test(part) && FIGURE.test(part) && FIGURE.test(rest) ? rest : sentence;
}

/**
 * Comp stated in the description, read one sentence (and `;` clause) at a time with `parseComp`. A sentence counts only when it has a
 * pay word (salary, base, pay, compensation, CTC, LPA, per annum, /yr, per year, a year) and no funding or revenue
 * word (raised, funding, valuation, revenue, ARR, series, saved, budget, customers, users ...). It is skipped when it
 * names only non-salary pay (equity, bonus ...), a currency the Posting cannot carry, a bare `$` beside Canada or
 * another dollar country, or cannot be parsed with confidence. A single figure after "up to" keeps only the max; after
 * "from", "starting at", "at least" or before "+" / "or more" only the min. Implausible figures are dropped. The
 * basis is `base` only when every contributing sentence says base, fixed or CTC and names no other kind of pay; when
 * any sentence states base explicitly, only those base figures are used. A clause whose only pay words are
 * variable, incentive, OTE, commission, bonus or equity is skipped.
 */
export function compFromText(text: string): Comp | null {
  const ranges: Range[] = [];
  for (const sentence of text.split(PAY_SENTENCE_SPLIT)) {
    // A clause whose only pay words are variable, incentive, OTE, commission, bonus or equity states no salary.
    if (!PAY_WORD.test(sentence) || NOT_PAY.test(sentence)) continue;
    const core = withoutIncluded(sentence);
    if (OTHER_PAY.test(core) && !SALARY_WORD.test(core)) continue;
    if (FOREIGN_MONEY.test(sentence) || (sentence.includes('$') && DOLLAR_COUNTRY.test(sentence) && !US_DOLLAR.test(sentence))) continue;
    const r = parseComp(core);
    if (r.kind !== 'parsed') continue;
    let { min, max } = r.range as { min: number | null; max: number | null };
    if (min === max) {
      const fig = FIGURE.exec(sentence);
      const before = fig === null ? '' : sentence.slice(0, fig.index);
      const after = fig === null ? '' : sentence.slice(fig.index + fig[0].length);
      const up = UP_TO.test(before);
      const from = FROM.test(before) || OR_MORE.test(after);
      if (up && from) continue;
      if (up) min = null;
      if (from) max = null;
    }
    ranges.push({ min, max, currency: r.range.currency, base: basisIsBase(sentence) });
  }
  // Explicit base figures are the salary; other salary mentions next to them are not unioned in.
  const base = ranges.filter((r) => r.base);
  return compOf(base.length > 0 ? base : ranges);
}

/** Structured comp when the source states some, else comp from the text. `undefined` means the source states none. */
const compOrText = (structured: Comp | null | undefined, text: string): Comp | null => (structured === undefined ? compFromText(text) : structured);

/** Annualising factor of a period word: a year or a month; anything else (hour, week, day, one-time) cannot be annualised honestly. */
function perYearOf(period: unknown): number | null {
  const p = str(period)?.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (p === undefined) return null;
  if (/^(?:1 )?(?:year|yearly|annual|annually|per year|per year salary|per annum)$/.test(p)) return 1;
  if (/^(?:1 )?(?:month|monthly|per month|per month salary)$/.test(p)) return 12;
  return null;
}

// ---------------------------------------------------------------------------
// Shared assembly
// ---------------------------------------------------------------------------

interface Mapped {
  title: string | null;
  url: string | null;
  locationText: string;
  structured: Remote['structured'];
  countries: readonly string[];
  /** Structured signals only; text signals are added from the location and the title. */
  signals: readonly string[];
  employmentType: string | null;
  descriptionText: string;
  postedAt: string | null;
  comp: Comp | null;
}

function httpUrl(v: string | null): string | null {
  if (v === null) return null;
  const t = v.trim();
  if (!/^https?:\/\//i.test(t)) return null;
  try {
    return new URL(t).protocol.startsWith('http') ? t : null;
  } catch {
    return null;
  }
}

function assemble(raw: RawPosting, ats: Posting['ats'], m: Mapped): Posting {
  const title = m.title === null ? '' : oneLine(m.title);
  if (title === '') throw fail(raw, 'no title');
  const url = httpUrl(m.url);
  if (url === null) throw fail(raw, `no http(s) url (${String(m.url).slice(0, 80)})`);
  const locationText = m.locationText.replace(/\s+/g, ' ').trim();
  const excluded = excludedPlaces(locationText);
  return {
    jobKey: jobKey(raw.company, title, locationText),
    source: raw.source,
    sourceId: raw.sourceId,
    company: raw.company,
    slug: raw.slug,
    ats,
    title,
    url,
    locationText,
    remote: {
      structured: m.structured,
      // A place the location text excludes is never a country, whichever field named it.
      countries: withoutExcluded(m.countries, excluded),
      signals: [
        ...new Set([
          ...m.signals,
          ...remoteTextSignals('location', locationText),
          ...sortedUnique([...excluded, ...excludedParts(locationText)]).map((p) => `location:excludes:${p}`),
          ...remoteTextSignals('title', title),
        ]),
      ],
    },
    employmentType: m.employmentType === null ? null : oneLine(m.employmentType) || null,
    descriptionText: m.descriptionText,
    postedAt: m.postedAt,
    comp: m.comp,
    yearsRequired: yearsRequired(m.descriptionText),
  };
}

const places = (entries: readonly unknown[]): string[] =>
  entries.flatMap((e) => {
    const name = typeof e === 'string' ? e : isRec(e) ? (str(e.alpha2) ?? str(e.name)) : null;
    return name === null ? [] : placeOf(name);
  });

// ---------------------------------------------------------------------------
// Per source
// ---------------------------------------------------------------------------

function greenhouse(raw: RawPosting, r: Rec): Posting {
  const locationText = isRec(r.location) ? (str(r.location.name) ?? '') : '';
  const offices = arr(r.offices).flatMap((o) => (isRec(o) ? [str(o.name), str(o.location)].filter((x): x is string => x !== null) : []));
  const employment = arr(r.metadata).find((md) => isRec(md) && /employment|job type|commitment|work type|contract type/i.test(String(md.name)));
  const descriptionText = htmlToText(decodeEntities(str(r.content) ?? ''));

  let structuredComp: Comp | null | undefined;
  const ranges = arr(r.pay_input_ranges).filter(isRec);
  if (ranges.length > 0) {
    structuredComp = compOf(
      ranges.flatMap((p) => {
        const title = str(p.title) ?? '';
        const blurb = htmlToText(str(p.blurb) ?? '');
        if (/\bhour(?:ly)?\b|\bper hour\b/i.test(`${title} ${blurb}`)) return [];
        // The title decides first; a neutral title ("Zone 3 Pay Range") defers to an explicit base in the blurb.
        const base = !NOT_BASE.test(title) && !BLURB_NOT_BASE.test(blurb) && (BASE.test(title) || BASE.test(blurb));
        const min = num(p.min_cents);
        const max = num(p.max_cents);
        const range = rangeOf(min === null ? null : min / 100, max === null ? null : max / 100, p.currency_type, 1, base);
        return range === null ? [] : [range];
      }),
    );
  }
  return assemble(raw, 'greenhouse', {
    title: str(r.title),
    url: str(r.absolute_url),
    locationText,
    structured: null,
    countries: [...countriesIn(locationText), ...offices.flatMap(countriesIn)],
    signals: [],
    employmentType: isRec(employment) ? listText(employment.value) : null,
    descriptionText,
    postedAt: postedAtOf(r.first_published),
    comp: compOrText(structuredComp, descriptionText),
  });
}

const LEVER_WORKPLACE: Readonly<Record<string, Remote['structured']>> = { remote: 'remote', hybrid: 'hybrid', onsite: 'onsite', 'on-site': 'onsite' };

function lever(raw: RawPosting, r: Rec): Posting {
  const cat = isRec(r.categories) ? r.categories : {};
  const all = arr(cat.allLocations).filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  const locationText = all.length > 0 ? all.join('; ') : (str(cat.location) ?? '');
  const workplace = str(r.workplaceType)?.trim();
  const country = str(r.country);
  // Each list as its heading with its items right under it.
  const lists = arr(r.lists).flatMap((l) => {
    if (!isRec(l)) return [];
    const heading = oneLine(str(l.text) ?? '');
    const items = htmlToText(`<ul>${str(l.content) ?? ''}</ul>`);
    return [heading !== '' && items !== '' ? `${heading}\n${items}` : heading + items];
  });
  const html = (k: string, plain: string): string => (str(r[k]) !== null ? htmlToText(str(r[k]) ?? '') : (str(r[plain]) ?? ''));
  const descriptionText = joinParts([html('description', 'descriptionPlain'), ...lists, html('additional', 'additionalPlain'), html('salaryDescription', 'salaryDescriptionPlain')]);

  let structuredComp: Comp | null | undefined;
  if (isRec(r.salaryRange)) {
    const s = r.salaryRange;
    // Lever's 0 is "not stated" (the adapter already drops a 0/0 placeholder).
    const range = rangeOf(s.min === 0 ? null : s.min, s.max === 0 ? null : s.max, s.currency, perYearOf(s.interval), true);
    structuredComp = compOf(range === null ? [] : [range]);
  }
  return assemble(raw, 'lever', {
    title: str(r.text),
    url: str(r.hostedUrl) ?? str(r.applyUrl),
    locationText,
    structured: workplace === undefined ? null : (LEVER_WORKPLACE[workplace.toLowerCase()] ?? null),
    countries: [...countriesIn(locationText), ...(country === null ? [] : places([country]))],
    signals: workplace === undefined ? [] : [`workplaceType:${workplace}`],
    employmentType: str(cat.commitment),
    descriptionText,
    postedAt: postedAtOf(r.createdAt, 'ms'),
    comp: compOrText(structuredComp, descriptionText),
  });
}

const ASHBY_WORKPLACE: Readonly<Record<string, Remote['structured']>> = { remote: 'remote', hybrid: 'hybrid', onsite: 'onsite', 'on-site': 'onsite' };

function ashby(raw: RawPosting, r: Rec): Posting {
  const secondary = arr(r.secondaryLocations).filter(isRec);
  const locationText = [str(r.location), ...secondary.map((s) => str(s.location))].filter((x): x is string => x !== null).map((x) => x.trim()).join('; ');
  const addressCountry = (a: unknown): unknown => (isRec(a) && isRec(a.postalAddress) ? a.postalAddress.addressCountry : undefined);
  const workplace = str(r.workplaceType)?.trim();
  const fromWorkplace = workplace === undefined ? undefined : ASHBY_WORKPLACE[workplace.toLowerCase()];
  const structured = fromWorkplace ?? (r.isRemote === true ? 'remote' : null);
  const signals = [...(workplace === undefined ? [] : [`workplaceType:${workplace}`]), ...(typeof r.isRemote === 'boolean' ? [`isRemote:${r.isRemote}`] : [])];
  const descriptionText = str(r.descriptionHtml) !== null ? htmlToText(str(r.descriptionHtml) ?? '') : (str(r.descriptionPlain) ?? '').trim();

  let structuredComp: Comp | null | undefined;
  const comp = isRec(r.compensation) ? r.compensation : null;
  if (comp !== null) {
    const summary = arr(comp.summaryComponents);
    const components = summary.length > 0 ? summary : arr(comp.compensationTiers).flatMap((t) => (isRec(t) ? arr(t.components) : []));
    // Only Salary is pay: equity (EquityCashValue, EquityPercentage), Bonus and Commission are never comp.
    const salary = components.filter((c): c is Rec => isRec(c) && c.compensationType === 'Salary');
    if (salary.length > 0) {
      structuredComp = compOf(salary.flatMap((c) => {
        const range = rangeOf(c.minValue, c.maxValue, c.currencyCode, perYearOf(c.interval), true);
        return range === null ? [] : [range];
      }));
    }
  }
  return assemble(raw, 'ashby', {
    title: str(r.title),
    url: str(r.jobUrl) ?? str(r.applyUrl),
    locationText,
    structured,
    countries: [...countriesIn(locationText), ...places([addressCountry(r.address), ...secondary.map((s) => addressCountry(s.address))])],
    signals,
    employmentType: str(r.employmentType),
    descriptionText,
    postedAt: postedAtOf(r.publishedAt),
    comp: compOrText(structuredComp, descriptionText),
  });
}

/** A feed's own salary fields: undefined when it states none, so the text decides. */
function feedComp(min: unknown, max: unknown, currency: unknown, period: unknown): Comp | null | undefined {
  if ((min === null || min === undefined) && (max === null || max === undefined)) return undefined;
  const range = rangeOf(min, max, currency, perYearOf(period), true);
  return compOf(range === null ? [] : [range]);
}

function himalayas(raw: RawPosting, r: Rec): Posting {
  const restrictions = arr(r.locationRestrictions);
  const names = restrictions.flatMap((x) => {
    const n = typeof x === 'string' ? x : isRec(x) ? (str(x.name) ?? str(x.alpha2)) : null;
    return n === null || n.trim() === '' ? [] : [n.trim()];
  });
  const descriptionText = htmlToText(str(r.description) ?? '');
  return assemble(raw, 'feed', {
    title: str(r.title),
    url: str(r.applicationLink) ?? str(r.guid),
    locationText: names.join(', '),
    structured: 'remote',
    // An empty restriction list is the feed's "worldwide".
    countries: restrictions.length === 0 ? ['worldwide'] : places(restrictions),
    signals: ['feed:remote-only'],
    employmentType: listText(r.employmentType),
    descriptionText,
    postedAt: postedAtOf(r.pubDate, 's'),
    comp: compOrText(feedComp(r.minSalary, r.maxSalary, r.currency, r.salaryPeriod), descriptionText),
  });
}

function jobicy(raw: RawPosting, r: Rec): Posting {
  const geo = decodeEntities(str(r.jobGeo) ?? '');
  const descriptionText = htmlToText(str(r.jobDescription) ?? '');
  return assemble(raw, 'feed', {
    title: str(r.jobTitle),
    url: str(r.url),
    locationText: geo,
    structured: 'remote',
    countries: places(geo.split(',')),
    signals: ['feed:remote-only'],
    employmentType: listText(r.jobType),
    descriptionText,
    postedAt: postedAtOf(r.pubDate),
    comp: compOrText(feedComp(r.salaryMin, r.salaryMax, r.salaryCurrency, r.salaryPeriod), descriptionText),
  });
}

/** `Locality, Region, Country` of a JSON-LD Place (or a bare address or string). */
function placeText(p: unknown): string | null {
  if (typeof p === 'string') return str(p);
  if (!isRec(p)) return null;
  const a = isRec(p.address) ? p.address : typeof p.address === 'string' ? { streetAddress: p.address } : p;
  const country = isRec(a.addressCountry) ? str(a.addressCountry.name) : str(a.addressCountry);
  const parts = [str(a.addressLocality), str(a.addressRegion), country].filter((x): x is string => x !== null).map((x) => x.trim());
  if (parts.length > 0) return parts.join(', ');
  return str(a.streetAddress) ?? str(p.name);
}

const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const nameOf = (v: unknown): string | null => (typeof v === 'string' ? str(v) : isRec(v) ? (str(v.name) ?? (isRec(v.address) ? str(v.address.addressCountry) : null)) : null);

/** JSON-LD `baseSalary`: undefined when absent; null when present but not a yearly or monthly range in a supported currency. */
function baseSalaryComp(v: unknown): Comp | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isRec(v)) return null;
  const value = v.value;
  const q = isRec(value) ? value : {};
  const point = num(isRec(value) ? value.value : value);
  const min = num(q.minValue) ?? point;
  const max = num(q.maxValue) ?? point;
  const unit = str(q.unitText) ?? str(v.unitText);
  const range = rangeOf(min, max, v.currency, unit === null ? null : perYearOf(unit), true);
  return compOf(range === null ? [] : [range]);
}

function careers(raw: RawPosting, r: Rec): Posting {
  const ld = isRec(r.jsonLd) ? r.jsonLd : null;
  const ldDescription = ld === null ? null : str(ld.description);
  const descriptionText = ldDescription !== null ? htmlish(ldDescription) : (typeof r.text === 'string' ? r.text : '').trim();
  const types = ld === null ? [] : listOf(ld.jobLocationType).flatMap((t) => (typeof t === 'string' && t.trim() !== '' ? [t.trim()] : []));
  const telecommute = types.some((t) => t.toUpperCase() === 'TELECOMMUTE');
  const applicants = ld === null ? [] : listOf(ld.applicantLocationRequirements).map(nameOf).filter((x): x is string => x !== null);
  const located = ld === null ? [] : listOf(ld.jobLocation).map(placeText).filter((x): x is string => x !== null);
  const locationText = located.length > 0 ? [...new Set(located)].join('; ') : applicants.join(', ');
  const officeCountries = ld === null ? [] : listOf(ld.jobLocation).map((p) => (isRec(p) && isRec(p.address) ? nameOf(p.address.addressCountry) : null));
  // A TELECOMMUTE job's jobLocation is an office, not a restriction on where applicants live.
  const countries = telecommute
    ? places(applicants)
    : [...places(applicants), ...places(officeCountries.filter((x): x is string => x !== null)), ...countriesIn(locationText)];
  return assemble(raw, 'careers', {
    title: str(r.title),
    url: str(r.url),
    locationText,
    structured: telecommute ? 'remote' : null,
    countries,
    signals: types.map((t) => `jobLocationType:${t}`),
    employmentType: ld === null ? null : listText(ld.employmentType),
    descriptionText,
    postedAt: ld === null ? null : postedAtOf(ld.datePosted),
    comp: compOrText(ld === null ? undefined : baseSalaryComp(ld.baseSalary), descriptionText),
  });
}

const BY_SOURCE: Readonly<Record<string, (raw: RawPosting, r: Rec) => Posting>> = { greenhouse, lever, ashby, himalayas, jobicy, careers };

/** Maps one raw posting; throws `invalid_output` for an unknown source, a raw that is not an object, no title or no URL. */
export function normalize(raw: RawPosting): Posting {
  const map = Object.hasOwn(BY_SOURCE, raw.source) ? BY_SOURCE[raw.source] : undefined;
  if (map === undefined) throw fail(raw, 'unknown source');
  if (!isRec(raw.raw)) throw fail(raw, 'raw is not an object');
  return map(raw, raw.raw);
}

export const normalizerContract = defineContract({
  id: 'normalizer',
  version: '1.0.0',
  description: 'Maps one raw posting to one normalised posting',
  skills: ['posting-normalisation'],
  team: 'understanding',
  kind: 'deterministic',
  consumes: RawPosting,
  produces: Posting,
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
  // A failure here is one posting's data (no title or URL), not a failing service, so it must not stop the
  // normalisation of every other posting in the run. 10,000 is above any run's posting count, i.e. never.
  breaker: { consecutiveFailures: 10_000 },
});

export const normalizer = defineAgent(normalizerContract, async (raw) => [normalize(raw)]);
