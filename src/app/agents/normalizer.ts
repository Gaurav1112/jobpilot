import { defineAgent } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { KernelError } from '../../kernel/errors.js';
import { parseComp } from '../comp/parse.js';
import { decodeEntities, htmlToText, plainToText } from '../text/html.js';
import { countriesIn, dedupeKey, excludedParts, excludedPlaces, jobKey, placeOf, postedAtOf, remoteTextSignals, withoutExcluded, yearsRequired } from '../text/norm.js';
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
 * - careers: `{url, jsonLd: JobPosting | null, title, text}` from the career-site source;
 * - workday: `{title, url, externalPath, locationsText, reqId, detail}` (platforms/workday.ts). With a detail: its
 *   title, `location` plus `additionalLocations` (joined by `; `), the requisition country (ISO-2), `remoteType`
 *   (structured: a value naming remote is `remote`, hybrid or flexible `hybrid`, office or on-site `onsite`; any
 *   other value is kept only as the signal `remoteType:<value>`), `timeType` ("Full time") and the HTML description.
 *   Without one (past the per-company detail budget, or a title the pre-filter skips): the listed `locationsText`
 *   ("India, Bengaluru", or a bare "2 Locations", which eligibility treats as a generic location field) and an empty
 *   description; a job the adapter saw under an office city's location facet value appends those values
 *   (`officeLocations`: "2 Locations; India, Bengaluru"). Workday dates are relative ("Posted Today"): `postedAt` is
 *   always null;
 * - eightfold: `{api, title, url, id, locations, standardizedLocations, workLocationOption, department, postedTs,
 *   detail}` (platforms/eightfold.ts). The location text is every listed location joined by `; ` ("India, Karnataka,
 *   Bangalore; India, Telangana, Hyderabad"); countries from it and from PCSX's standardized locations ("Bengaluru,
 *   KA, IN": the ISO-2 last part). The arrangement: the detail's work site when it says one ("0 days / week in-office
 *   – remote" remote, "3 days / week in-office" hybrid, "fully on-site" onsite), else `workLocationOption` (`remote`,
 *   `remote_local` remote; `hybrid`; `onsite`); both kept as signals. `postedAt` from the epoch seconds `postedTs`
 *   (absent → null). Without a detail the description is empty;
 * - oracle: `{title, url, id, primaryLocation, primaryCountry, secondaryLocations, postedDate, workplaceTypeCode,
 *   shortDescription, detail}` (platforms/oracle.ts). The location text is the primary then the secondary locations
 *   joined by `; `; countries from it and the ISO-2 country codes. `WorkplaceTypeCode` `ORA_REMOTE` is remote,
 *   `ORA_HYBRID` hybrid, `ORA_ON_SITE` onsite (the detail's wins). `postedAt` = `PostedDate` (YYYY-MM-DD; absent →
 *   null). The description is the detail's (description, responsibilities, qualifications), else the list's short
 *   description; `employmentType` the detail's `JobSchedule` ("Full time").
 *
 * - icims, smartrecruiters, jsonld-sitemap (Task 8, platforms/icims.ts, smartrecruiters.ts, jsonld-sitemap.ts):
 *   `{url, title, jsonLd}`, the kept JobPosting of a job page: mapped exactly as careers (location from `jobLocation`,
 *   remote from `jobLocationType: TELECOMMUTE`, the remote scope from `applicantLocationRequirements`);
 * - successfactors (platforms/successfactors.ts): `{title, url, id, location, employer, description, jsonLd}`; with
 *   `jsonLd`, as careers; without, the `sitemal.xml` item (see `successfactors` below).
 *
 * - Task 9, the small platforms (platforms/workable.ts, recruitee.ts, teamtailor.ts, personio.ts, bamboohr.ts, breezy.ts,
 *   pinpoint.ts, rippling.ts, gem.ts): each raw is that platform's kept feed fields (documented in its module). The
 *   location text is the platform's own place fields, never invented (Rippling's label may be only a state code, Personio's
 *   offices have no country). A job the platform flags REMOTE (Workable `telecommuting`, Recruitee `remote`, Teamtailor
 *   `remoteStatus: fully`, BambooHR `isRemote`, Breezy `is_remote`, Pinpoint `workplace_type`, Gem `location_type`) is
 *   structured remote with no country but India, if its own location names it (an office or hiring country elsewhere
 *   is not a restriction, so eligibility says review, never reject); any other keeps its office's countries. Hybrid and on-site are mapped where the platform states
 *   them (Recruitee, Teamtailor `hybrid`, Pinpoint, Gem); Teamtailor `none` (no remote work) stays a signal only.
 *   Descriptions are the feeds' HTML (Breezy, BambooHR and Rippling publish none in the list); pay is the platform's
 *   own range where it has one (Recruitee, Pinpoint), else read from the text.
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
/** Indian annual pay figures: LPA and CTC are read as base for the floor, whatever word introduces them. */
const INDIA_ANNUAL = /\b(?:ctc|lpa)\b/i;
/** Salary wording that states base pay when nothing else is named. */
const SALARY_TEXT = /\b(?:salary|salaries|pay range)\b/i;
/** Wording that may bundle more than base: it stays unknown unless base (or LPA/CTC) is stated. */
const PACKAGE_TEXT = /\b(?:compensation|package|total)\b/i;
/**
 * The basis of a sentence in the description (task 7 fix round 1): `base` when it names no variable, total, bonus,
 * equity or OTE pay, and it says base, fixed, CTC or LPA, or it says salary or pay range without compensation,
 * package or total.
 */
const textBasisIsBase = (s: string): boolean =>
  !NOT_BASE.test(s) && (BASE.test(s) || INDIA_ANNUAL.test(s) || (SALARY_TEXT.test(s) && !PACKAGE_TEXT.test(s)));
/** For a Greenhouse blurb, only these make a base title doubtful (blurbs routinely say "plus equity"). */
const BLURB_NOT_BASE = /\b(?:ote|on[- ]target|total\s+comp\w*|tc)\b/i;

/** Sentences that may state pay. */
const PAY_WORD =
  /\b(?:salary|salaries|base|pay|pays|compensation|ctc|lpa|remuneration|ote|tc|on[- ]target)\b|\bper annum\b|\bp\.a\.|\/\s*(?:yr|year)\b|\bper year\b|\ba year\b|\bannually\b/i;
/** Sentences about money that is not pay. */
const NOT_PAY =
  /\b(?:raised|raising|funding|funded|valuation|revenue|arr|series|saved|save|saves|savings|budget|customers|users|clients|investors?|market cap)\b/i;
/**
 * Final fix I5: perk and benefit wording. A sentence with any of these states a perk budget, never pay, whatever else
 * it says ("Learning and development: $1,500 per year", "$2,000 a year for your home office", "₹2,00,000 annually for
 * wellness", "we pay up to $3,000 per year" for conferences): it is never read, so a perk figure can never reject a
 * job below the floor.
 */
const PERK =
  /\b(?:learning|education(?:al)?|training|conferences?|wellness|wellbeing|gym|home[\s-]+office|equipment|internet|(?:tele)?phones?|stipends?|budgets?|allowances?|reimburse\w*|relocation|sign[\s-]*on|joining\s+bonus(?:es)?)\b|\bper\s+year\s+for\b|\bannual\b[^.;\n]*\bbudget\b/i;
/** "Base salary incl. allowances ₹20 LPA": allowances that the salary includes are part of it, not a perk figure. */
const INCLUDED_ALLOWANCES = /\b(?:incl\.?|including|inclusive of)\s+(?:all\s+)?allowances?\b/gi;
const isPerk = (sentence: string): boolean => PERK.test(sentence.replace(INCLUDED_ALLOWANCES, ' '));
/**
 * Pay components that are not salary: a sentence that names only these (no base, salary, fixed, CTC or total-type
 * wording) states no salary.
 */
const OTHER_PAY =
  /\b(?:equity|rsus?|stocks?|options|esops?|shares|bonus(?:es)?|commissions?|joining|sign[- ]on|relocation|stipend|allowance|referral|reimburse\w*|perks?|hra|pf|epf|esic|gratuity|da|lta|allowances?|reimbursements?|insurance|meal|flexi|variable|incentives?)\b/i;
/**
 * Total-type pay (OTE, on-target, TC, target cash, total comp/cash/pay/package): never base, but always at least base,
 * so its figure is kept with an `unknown` basis (task 7 fix round 2: eligibility rejects a total whose max is below
 * the floor, because the base under it is lower still).
 */
const TOTAL_PAY =
  /\b(?:ote|on[- ]target|tc|target\s+(?:cash|comp\w*|earnings)|total\s+(?:comp\w*|cash|pay|rewards?|package|remuneration))\b/i;
/** A total followed (in its sentence) by include/including/comprises/consists of: what it includes is not stated as a figure of its own. */
const TOTAL_INCLUDES = new RegExp(`${TOTAL_PAY.source}[^.;]*?\\b(?:includ(?:e|es|ed|ing)|comprises?|consists? of)\\b`, 'i');
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
/** "+" right after the figure means "or more", unless a word follows it ("₹30 LPA + equity" is an add-on). */
const OR_MORE = /^\s*(?:\+(?!\s*\p{L})|or more\b|and above\b|or higher\b|onwards\b)/iu;

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
 * word (raised, funding, valuation, revenue, ARR, series, saved, budget, customers, users ...) and no perk or benefit
 * word (`PERK`: learning, education, training, conference, wellness, gym, home office, equipment, internet, phone,
 * stipend, budget, allowance, reimbursement, relocation, sign-on, joining bonus, "per year for"). It is skipped when it
 * names only non-salary pay (equity, bonus ...), a currency the Posting cannot carry, a bare `$` beside Canada or
 * another dollar country, or cannot be parsed with confidence. A single figure after "up to" keeps only the max; after
 * "from", "starting at", "at least" or before "+" / "or more" only the min. Implausible figures are dropped. The
 * basis is `base` only when every contributing sentence is base by `textBasisIsBase`; when
 * any sentence states base explicitly, only those base figures are used. A clause whose only pay words are
 * variable, incentive, OTE, commission, bonus or equity is skipped.
 */
export function compFromText(text: string): Comp | null {
  const ranges: Range[] = [];
  for (const sentence of text.split(PAY_SENTENCE_SPLIT)) {
    // A clause whose only pay words are components (variable, incentive, commission, bonus, equity ...) states no salary.
    if (!PAY_WORD.test(sentence) || NOT_PAY.test(sentence) || isPerk(sentence)) continue;
    const core = withoutIncluded(sentence);
    // A total word beside a component, or a total that "includes" something: the figure may be the component, so the
    // sentence is not read (task 7 fix round 3, I-R1). An unread figure only costs a note, never a rejection.
    if (TOTAL_PAY.test(core) && (OTHER_PAY.test(core) || TOTAL_INCLUDES.test(core))) continue;
    if (OTHER_PAY.test(core) && !SALARY_WORD.test(core) && !TOTAL_PAY.test(core)) continue;
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
    ranges.push({ min, max, currency: r.range.currency, base: textBasisIsBase(sentence) });
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
    jobKey: jobKey(raw.source, raw.sourceId),
    dedupeKey: dedupeKey(raw.company, title, locationText),
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
  return jsonLdPosting(raw, r, 'careers');
}

/**
 * The careers mapping of a `{url, jsonLd, title, text}` raw, under `ats`: the careers source, and the platform page
 * adapters that read JobPosting JSON-LD (Task 8: icims, smartrecruiters, jsonld-sitemap, and successfactors' page
 * postings), so their location, remote and scope fields map exactly as the careers source's do.
 */
function jsonLdPosting(raw: RawPosting, r: Rec, ats: Posting['ats']): Posting {
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
  return assemble(raw, ats, {
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

/** Workday `remoteType` (tenant-defined wording: "Remote", "Hybrid", "Office - Based", "Office Tech-Flexible"). */
function workdayArrangement(v: string | null): Remote['structured'] {
  if (v === null) return null;
  if (/\bremote\b/i.test(v)) return 'remote';
  if (/\b(?:hybrid|flexible)\b/i.test(v)) return 'hybrid';
  if (/\b(?:office|on[- ]?site|in[- ]office)\b/i.test(v)) return 'onsite';
  return null;
}

function workday(raw: RawPosting, r: Rec): Posting {
  const d = isRec(r.detail) ? r.detail : null;
  const located = d === null ? [] : [str(d.location), ...arr(d.additionalLocations).map(str)].filter((x): x is string => x !== null).map((x) => x.trim());
  // without a detail, an office-city location value the job is listed under ("India, Bengaluru") joins the listed text
  const listed = str(r.locationsText) ?? '';
  const offices = arr(r.officeLocations).filter((x): x is string => typeof x === 'string' && x.trim() !== '' && !listed.includes(x));
  const locationText = located.length > 0 ? [...new Set(located)].join('; ') : [listed, ...new Set(offices)].filter((x) => x !== '').join('; ');
  const remoteType = d === null ? null : str(d.remoteType);
  const country = d === null ? null : str(d.country);
  const descriptionText = d === null ? '' : htmlToText(str(d.description) ?? '');
  return assemble(raw, 'workday', {
    title: (d === null ? null : str(d.title)) ?? str(r.title),
    url: str(r.url),
    locationText,
    structured: workdayArrangement(remoteType),
    countries: [...countriesIn(locationText), ...(country === null ? [] : places([country]))],
    signals: remoteType === null ? [] : [`remoteType:${oneLine(remoteType)}`],
    employmentType: d === null ? null : str(d.timeType),
    descriptionText,
    postedAt: null,
    comp: compFromText(descriptionText),
  });
}

/** Eightfold work arrangement: PCSX's work-site text ("3 days / week in-office") first, else `workLocationOption`. */
function eightfoldArrangement(workSite: string | null, option: string | null): Remote['structured'] {
  if (workSite !== null) {
    if (/\bremote\b/i.test(workSite)) return 'remote';
    if (/\bfully\s+on[- ]?site\b|\b5 days\b/i.test(workSite)) return 'onsite';
    if (/\b[1-4] days?\b.*\bin[- ]office\b|\bhybrid\b/i.test(workSite)) return 'hybrid';
  }
  if (option === null) return null;
  if (/^remote/i.test(option)) return 'remote';
  if (/^hybrid/i.test(option)) return 'hybrid';
  if (/^on[-_ ]?site$/i.test(option)) return 'onsite';
  return null;
}

/**
 * An ISO-2 code as a standardized location's country: the whole value ("SG") or the last of three or more parts
 * ("Bengaluru, KA, IN"); a two-part "Indianapolis, IN" ends with a US state, not a country.
 */
const isoTail = (s: string): string[] => {
  const parts = s.split(',').map((p) => p.trim());
  const last = parts[parts.length - 1] ?? '';
  return (parts.length === 1 || parts.length >= 3) && /^[A-Z]{2}$/u.test(last) ? [last] : [];
};

function eightfold(raw: RawPosting, r: Rec): Posting {
  const d = isRec(r.detail) ? r.detail : null;
  const locations = arr(r.locations).map(str).filter((x): x is string => x !== null).map((x) => x.trim());
  const standardized = arr(r.standardizedLocations).map(str).filter((x): x is string => x !== null);
  const locationText = [...new Set(locations)].join('; ');
  const workSite = d === null ? null : str(d.workSite);
  const option = str(r.workLocationOption);
  const descriptionText = d === null ? '' : htmlish(str(d.description) ?? '');
  return assemble(raw, 'eightfold', {
    title: (d === null ? null : str(d.title)) ?? str(r.title),
    url: str(r.url),
    locationText,
    structured: eightfoldArrangement(workSite, option),
    countries: [...countriesIn(locationText), ...places(standardized.flatMap(isoTail))],
    signals: [...(option === null ? [] : [`workLocationOption:${oneLine(option)}`]), ...(workSite === null ? [] : [`workSite:${oneLine(workSite)}`])],
    employmentType: d === null ? null : str(d.employmentType),
    descriptionText,
    postedAt: postedAtOf(r.postedTs, 's'),
    comp: compFromText(descriptionText),
  });
}

const ORACLE_WORKPLACE: Readonly<Record<string, Remote['structured']>> = { ORA_REMOTE: 'remote', ORA_HYBRID: 'hybrid', ORA_ON_SITE: 'onsite' };

function oracle(raw: RawPosting, r: Rec): Posting {
  const d = isRec(r.detail) ? r.detail : null;
  const secondary = arr(r.secondaryLocations).filter(isRec);
  const names = [str(r.primaryLocation), ...secondary.map((x) => str(x.name))].filter((x): x is string => x !== null).map((x) => x.trim());
  const codes = [str(r.primaryCountry), ...secondary.map((x) => str(x.country))].filter((x): x is string => x !== null);
  const locationText = [...new Set(names)].join('; ');
  const code = (d === null ? null : str(d.workplaceTypeCode)) ?? str(r.workplaceTypeCode);
  const descriptionText = d !== null ? htmlish(str(d.description) ?? '') : htmlish(str(r.shortDescription) ?? '');
  return assemble(raw, 'oracle', {
    title: (d === null ? null : str(d.title)) ?? str(r.title),
    url: str(r.url),
    locationText,
    structured: code === null ? null : (ORACLE_WORKPLACE[code] ?? null),
    countries: [...countriesIn(locationText), ...places(codes)],
    signals: code === null ? [] : [`workplaceType:${oneLine(code)}`],
    employmentType: d === null ? null : str(d.schedule),
    descriptionText,
    postedAt: postedAtOf(r.postedDate),
    comp: compFromText(descriptionText),
  });
}

/**
 * SuccessFactors (Task 8): a page posting (`jsonLd` set) maps as the careers source; a feed posting from `sitemal.xml`
 * keeps its `g:location` as the location text (a country code such as `IN`, or a place), its country from that (an
 * ISO-2 code alone or as the last of three or more parts, or a named place), and the item's description HTML. The feed
 * states no arrangement, employment type or date: `structured`, `employmentType` and `postedAt` are null.
 */
function successfactors(raw: RawPosting, r: Rec): Posting {
  if (isRec(r.jsonLd)) return jsonLdPosting(raw, r, 'successfactors');
  const locationText = str(r.location)?.trim() ?? '';
  const descriptionText = htmlish(str(r.description) ?? '');
  return assemble(raw, 'successfactors', {
    title: str(r.title),
    url: str(r.url),
    locationText,
    structured: null,
    countries: [...countriesIn(locationText), ...places(isoTail(locationText))],
    signals: [],
    employmentType: null,
    descriptionText,
    postedAt: null,
    comp: compFromText(descriptionText),
  });
}

// ---------------------------------------------------------------------------
// Task 9: the small platforms (platforms/workable.ts … gem.ts), one feed each
// ---------------------------------------------------------------------------

/** Unique, trimmed, non-empty parts joined by `sep`. */
const joinUnique = (parts: readonly unknown[], sep: string): string => [...new Set(parts.map(str).filter((x): x is string => x !== null).map(oneLine).filter((x) => x !== ''))].join(sep);

/**
 * The countries of a small-platform job. A job flagged REMOTE keeps only India among its countries: an office or hiring
 * country elsewhere is not a restriction on where applicants live (as the careers mapping reads TELECOMMUTE), so it
 * must not make the unchanged eligibility reject the job as `remote-excludes-india` (it says review, `remote-unclear`);
 * India named by the platform's own location fields is a stated place and counts. Any other job keeps all its countries.
 */
const remoteScope = (structured: Remote['structured'], countries: readonly string[]): string[] => (structured === 'remote' ? countries.filter((c) => c === 'india') : [...countries]);

/**
 * What the small platforms share: a location text from the platform's own place fields (never invented), the countries
 * from that text and the platform's ISO codes (`remoteScope`), and the arrangement the platform states.
 */
function smallPosting(
  raw: RawPosting,
  ats: Posting['ats'],
  m: { title: unknown; url: unknown; places: readonly string[]; codes?: readonly (string | null)[]; structured: Remote['structured']; signals?: readonly string[]; employmentType: unknown; description: string; postedAt: unknown; structuredComp?: Comp | null | undefined },
): Posting {
  const locationText = [...new Set(m.places.filter((x) => x !== ''))].join('; ');
  const descriptionText = htmlish(m.description);
  return assemble(raw, ats, {
    title: str(m.title),
    url: str(m.url),
    locationText,
    structured: m.structured,
    countries: remoteScope(m.structured, [...countriesIn(locationText), ...places((m.codes ?? []).filter((c): c is string => c !== null))]),
    signals: m.signals ?? [],
    employmentType: str(m.employmentType),
    descriptionText,
    postedAt: postedAtOf(m.postedAt),
    comp: compOrText(m.structuredComp, descriptionText),
  });
}

/** Workable: `{shortcode, title, url, city, state, country, locations, telecommuting, employmentType, department, publishedOn, description}`; `telecommuting` is remote. */
function workable(raw: RawPosting, r: Rec): Posting {
  const locs = arr(r.locations).filter(isRec);
  const named = locs.map((l) => joinUnique([l.city, l.region, l.country], ', ')).filter((x) => x !== '');
  const remote = r.telecommuting === true;
  return smallPosting(raw, 'workable', {
    title: r.title,
    url: r.url,
    places: named.length > 0 ? named : [joinUnique([r.city, r.state, r.country], ', ')],
    codes: [...locs.map((l) => str(l.countryCode)), str(r.country)],
    structured: remote ? 'remote' : null,
    signals: remote ? ['telecommuting:true'] : [],
    employmentType: r.employmentType,
    description: str(r.description) ?? '',
    postedAt: r.publishedOn,
  });
}

/** Recruitee: `remote`/`hybrid`/`onSite` flags (remote wins), the offer's `locations` (else `location`), `salary`, description + requirements. */
function recruitee(raw: RawPosting, r: Rec): Posting {
  const locs = arr(r.locations).filter(isRec);
  const named = locs.map((l) => joinUnique([l.name, l.state, l.country], ', ')).filter((x) => x !== '');
  const flag = r.remote === true ? 'remote' : r.hybrid === true ? 'hybrid' : r.onSite === true ? 'onsite' : null;
  const sal = isRec(r.salary) ? r.salary : null;
  const description = [str(r.description), str(r.requirements)].filter((x): x is string => x !== null).join('\n');
  return smallPosting(raw, 'recruitee', {
    title: r.title,
    url: r.url,
    places: named.length > 0 ? named : [joinUnique([str(r.location) ?? joinUnique([r.city, r.country], ', ')], ', ')],
    codes: [...locs.map((l) => str(l.countryCode)), str(r.countryCode)],
    structured: flag,
    employmentType: str(r.employmentType)?.replace(/_/g, ' ') ?? null,
    description,
    postedAt: r.publishedAt,
    structuredComp: sal === null ? undefined : feedComp(sal.min, sal.max, sal.currency, sal.period),
  });
}

/** Teamtailor: `remoteStatus` `fully` is remote and `hybrid` hybrid; `none` states no remote work, which is not "on-site", so it is a signal only. */
function teamtailor(raw: RawPosting, r: Rec): Posting {
  const status = str(r.remoteStatus)?.toLowerCase() ?? null;
  const locs = arr(r.locations).filter(isRec);
  return smallPosting(raw, 'teamtailor', {
    title: r.title,
    url: r.url,
    places: locs.map((l) => joinUnique([l.city ?? l.name, l.country], ', ')).filter((x) => x !== ''),
    structured: status === 'fully' || status === 'remote' ? 'remote' : status === 'hybrid' ? 'hybrid' : null,
    signals: status === null ? [] : [`remoteStatus:${status}`],
    employmentType: null,
    description: str(r.description) ?? '',
    postedAt: r.pubDate,
  });
}

/** Personio: offices are city names without a country and the feed has no remote flag, so the arrangement comes from the text only. */
function personio(raw: RawPosting, r: Rec): Posting {
  return smallPosting(raw, 'personio', {
    title: r.title,
    url: r.url,
    places: arr(r.offices).map(str).filter((x): x is string => x !== null).map(oneLine),
    structured: null,
    employmentType: joinUnique([r.employmentType, r.schedule], ', ') || null,
    description: str(r.description) ?? '',
    postedAt: r.createdAt,
  });
}

/** BambooHR: `atsLocation` city, state, country; `isRemote` true is remote. The list has no description or date. */
function bamboohr(raw: RawPosting, r: Rec): Posting {
  return smallPosting(raw, 'bamboohr', {
    title: r.title,
    url: r.url,
    places: [joinUnique([r.city, r.state, r.country], ', ')],
    structured: r.isRemote === true ? 'remote' : null,
    signals: r.isRemote === true ? ['isRemote:true'] : [],
    employmentType: r.employmentStatus,
    description: '',
    postedAt: null,
  });
}

/** Breezy: each location's name (city, state) with its country; `is_remote` true on any location is remote. No description. */
function breezy(raw: RawPosting, r: Rec): Posting {
  const locs = arr(r.locations).filter(isRec);
  const remote = locs.some((l) => l.isRemote === true);
  return smallPosting(raw, 'breezy', {
    title: r.title,
    url: r.url,
    places: locs.map((l) => joinUnique([l.name ?? joinUnique([l.city, l.state], ', '), l.country], ', ')).filter((x) => x !== ''),
    codes: locs.map((l) => str(l.countryCode)),
    structured: remote ? 'remote' : null,
    signals: remote ? ['is_remote:true'] : [],
    employmentType: r.type,
    description: '',
    postedAt: r.publishedDate,
  });
}

const PINPOINT_WORKPLACE: Readonly<Record<string, Remote['structured']>> = { remote: 'remote', hybrid: 'hybrid', onsite: 'onsite', 'on-site': 'onsite' };

/** Pinpoint: `workplace_type` (remote, hybrid, onsite), the location's name and city/province, the shown compensation. */
function pinpoint(raw: RawPosting, r: Rec): Posting {
  const wp = str(r.workplaceType)?.toLowerCase() ?? null;
  const comp = isRec(r.compensation) ? r.compensation : null;
  const description = str(r.description) ?? '';
  return smallPosting(raw, 'pinpoint', {
    title: r.title,
    url: r.url,
    places: [joinUnique([r.locationName, r.city, r.province], ', ')],
    structured: wp === null ? null : (PINPOINT_WORKPLACE[wp] ?? null),
    signals: wp === null ? [] : [`workplaceType:${wp}`],
    employmentType: r.employmentType,
    description,
    postedAt: null,
    structuredComp: comp === null ? undefined : feedComp(comp.min, comp.max, comp.currency, comp.frequency),
  });
}

/** Rippling: only the `workLocation.label` (a state code, a city, "Remote (Dallas, Texas, US)"); a country is never invented from it. */
function rippling(raw: RawPosting, r: Rec): Posting {
  return smallPosting(raw, 'rippling', { title: r.title, url: r.url, places: [joinUnique([r.location], ', ')], structured: null, employmentType: null, description: '', postedAt: null });
}

const GEM_WORKPLACE: Readonly<Record<string, Remote['structured']>> = { remote: 'remote', hybrid: 'hybrid', onsite: 'onsite', 'on-site': 'onsite', in_office: 'onsite' };

/** Gem: `location_type` (remote, hybrid, in_office), the post's location then its offices'. */
function gem(raw: RawPosting, r: Rec): Posting {
  const lt = str(r.locationType)?.toLowerCase() ?? null;
  return smallPosting(raw, 'gem', {
    title: r.title,
    url: r.url,
    places: arr(r.locations).map(str).filter((x): x is string => x !== null).map(oneLine),
    structured: lt === null ? null : (GEM_WORKPLACE[lt] ?? null),
    signals: lt === null ? [] : [`locationType:${lt}`],
    employmentType: str(r.employmentType)?.replace(/_/g, ' ') ?? null,
    description: str(r.content) ?? '',
    postedAt: r.firstPublishedAt,
  });
}

const BY_SOURCE: Readonly<Record<string, (raw: RawPosting, r: Rec) => Posting>> = {
  greenhouse,
  lever,
  ashby,
  himalayas,
  jobicy,
  careers,
  workday,
  eightfold,
  oracle,
  icims: (raw, r) => jsonLdPosting(raw, r, 'icims'),
  smartrecruiters: (raw, r) => jsonLdPosting(raw, r, 'smartrecruiters'),
  'jsonld-sitemap': (raw, r) => jsonLdPosting(raw, r, 'jsonld-sitemap'),
  successfactors,
  workable,
  recruitee,
  teamtailor,
  personio,
  bamboohr,
  breezy,
  pinpoint,
  rippling,
  gem,
};

/** Maps one raw posting; throws `invalid_output` for an unknown source, a raw that is not an object, no title or no URL. */
export function normalize(raw: RawPosting): Posting {
  const map = Object.hasOwn(BY_SOURCE, raw.source) ? BY_SOURCE[raw.source] : undefined;
  if (map === undefined) throw fail(raw, 'unknown source');
  if (!isRec(raw.raw)) throw fail(raw, 'raw is not an object');
  return map(raw, raw.raw);
}

export const normalizerContract = defineContract({
  id: 'normalizer',
  version: '1.4.0',
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
