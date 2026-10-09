import { defineAgent } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { KernelError } from '../../kernel/errors.js';
import { parseComp } from '../comp/parse.js';
import { decodeEntities, htmlToText } from '../text/html.js';
import { countriesIn, jobKey, placeOf, postedAtOf, remoteTextSignals, yearsRequired } from '../text/norm.js';
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
const oneLine = (s: string): string => decodeEntities(s).replace(/\s+/g, ' ').trim();
const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
/** A list of strings (or one string) as one display string; null when there is nothing. */
const listText = (v: unknown, sep = ', '): string | null => {
  const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === 'string' && x.trim() !== '' ? [oneLine(x)] : []));
  return parts.length > 0 ? parts.join(sep) : null;
};
/** Plain-text description parts joined by a blank line, empty parts dropped. */
const joinParts = (parts: readonly string[]): string => parts.map((p) => p.trim()).filter((p) => p !== '').join('\n\n');
/** An HTML field that a site may have escaped once more: decode first only when it carries no real tag. */
const htmlish = (s: string): string => htmlToText(/&lt;\/?[a-z]/i.test(s) && !/<\/?[a-z][^>]*>/i.test(s) ? decodeEntities(s) : s);

const fail = (raw: RawPosting, why: string): KernelError => new KernelError('invalid_output', `normalizer ${raw.source} ${raw.sourceId}: ${why}`);

// ---------------------------------------------------------------------------
// Compensation
// ---------------------------------------------------------------------------

const CURRENCIES: ReadonlySet<string> = new Set(['INR', 'USD', 'EUR', 'GBP']);

/**
 * Below this many units a year a figure is not a salary (₹1 LPA; 1,000 of a foreign currency, which is under
 * ₹1.2 LPA at any recent rate). The normalizer reads no fx table (it has no pack), so the bound is per currency.
 */
export const PLAUSIBLE_MIN_PER_YEAR: Readonly<Record<Currency, number>> = { INR: 100_000, USD: 1_000, EUR: 1_000, GBP: 1_000 };

/** One disclosed range, already annualised, in a currency that may be unsupported. */
interface Range {
  min: number;
  max: number;
  currency: string;
  base: boolean;
}

/** A range from raw bounds, or null when a bound is missing, negative or inverted, or the period cannot be annualised. */
function rangeOf(min: unknown, max: unknown, currency: unknown, perYear: number | null, base: boolean): Range | null {
  const lo = num(min);
  const hi = num(max);
  const cur = str(currency)?.trim().toUpperCase();
  if (lo === null || hi === null || cur === undefined || perYear === null || lo < 0 || lo > hi) return null;
  return { min: lo * perYear, max: hi * perYear, currency: cur, base };
}

/**
 * The comp of a set of disclosed ranges: an INR range is the one that applies in India, so INR ranges win; otherwise
 * every range must share one currency. The result is their union, `base` only if every range is base pay. It is
 * null for no ranges, mixed currencies, an unsupported currency, or a figure below the plausibility minimum.
 */
function compOf(ranges: readonly Range[]): Comp | null {
  if (ranges.length === 0) return null;
  const inr = ranges.filter((r) => r.currency === 'INR');
  const use = inr.length > 0 ? inr : ranges;
  const currency = use[0]?.currency ?? '';
  if (!CURRENCIES.has(currency) || use.some((r) => r.currency !== currency)) return null;
  const c = currency as Currency;
  const min = Math.min(...use.map((r) => r.min));
  const max = Math.max(...use.map((r) => r.max));
  if (min < PLAUSIBLE_MIN_PER_YEAR[c]) return null;
  return { min, max, currency: c, period: 'year', basis: use.every((r) => r.base) ? 'base' : 'unknown' };
}

/** Lines that may state pay (spec: salary, base, CTC, LPA, compensation or pay). */
const COMP_LINE = /\b(?:salary|salaries|base|ctc|lpa|compensation|pay)\b/i;
/** Pay that is not base salary; such a line counts only when it also says base or salary. */
const NOT_SALARY = /\b(?:equity|rsus?|stock|options?|esops?|shares|bonus(?:es)?|commission|ote|on[- ]target|joining|sign[- ]on|relocation|stipend|allowance|referral|reimburse\w*|budget|perks?)\b/i;
const SALARY_WORD = /\b(?:base|salary|salaries)\b/i;
/** Dollars that are not US dollars, and currency codes the Posting cannot carry: the parser would read `CA$` as USD. */
const FOREIGN_MONEY =
  /(?<![A-Za-z])(?:CA|C|A|AU|NZ|S|SG|HK|NT|R|MX|COL)\$|\b(?:CAD|AUD|SGD|NZD|HKD|JPY|CNY|RMB|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|BRL|MXN|ARS|CLP|COP|PHP|IDR|MYR|THB|VND|KRW|TWD|ZAR|AED|SAR|QAR|ILS|TRY|NGN|KES|PKR|BDT|LKR|NPR|EGP|UAH)\b|[₱฿₩₺₪₦]/;

/**
 * Comp stated in the description: each line that mentions pay is parsed on its own with `parseComp`. A line is
 * skipped when it names non-salary pay (equity, bonus, ...) without saying base or salary, names a currency the
 * Posting cannot carry, cannot be parsed with confidence, or gives a figure below the plausibility minimum. The
 * remaining ranges combine as in `compOf`. The basis is `base` only when every contributing line says "base".
 */
export function compFromText(text: string): Comp | null {
  const ranges: Range[] = [];
  for (const line of text.split('\n')) {
    if (!COMP_LINE.test(line)) continue;
    if (NOT_SALARY.test(line) && !SALARY_WORD.test(line)) continue;
    if (FOREIGN_MONEY.test(line)) continue;
    const r = parseComp(line);
    if (r.kind !== 'parsed') continue;
    const range: Range = { ...r.range, base: /\bbase\b/i.test(line) };
    if (range.min < PLAUSIBLE_MIN_PER_YEAR[r.range.currency]) continue;
    ranges.push(range);
  }
  return compOf(ranges);
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
      countries: sortedUnique(m.countries),
      signals: [...new Set([...m.signals, ...remoteTextSignals('location', locationText), ...remoteTextSignals('title', title)])],
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
    const p = name === null ? null : placeOf(name);
    return p === null ? [] : [p];
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
        const label = `${str(p.title) ?? ''} ${htmlToText(str(p.blurb) ?? '')}`;
        if (/\bhour(?:ly)?\b|\bper hour\b/i.test(label)) return [];
        const base = SALARY_WORD.test(label) && !/\bOTE\b|on[- ]target/i.test(label);
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
    const range = rangeOf(s.min, s.max, s.currency, perYearOf(s.interval), true);
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
    const components = Array.isArray(comp.summaryComponents) ? comp.summaryComponents : arr(comp.compensationTiers).flatMap((t) => (isRec(t) ? arr(t.components) : []));
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
  const geo = str(r.jobGeo) ?? '';
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
