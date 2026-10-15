import { defineAgent } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { KernelError } from '../../kernel/errors.js';
import { htmlToText } from '../text/html.js';
import { countriesIn, postedAtOf } from '../text/norm.js';
import { bountyAmount } from './sources/prime-intellect.js';
import { Posting } from '../types.js';
import { gigDedupeKey, gigKey } from './keys.js';
import { Gig, RawGig } from './types.js';

/**
 * The gig normalizer: one RawGig@1 in, exactly one Gig@1 out, by a fixed mapping per platform. Every field is copied
 * from the source or null; nothing is inferred. The description is HTML-stripped and whitespace-collapsed.
 *
 * - freelancer: `type` hourly is `contract`, fixed is `gig` (any other type is a `gig` with an `unknown` budget);
 *   `budget` is `budget.minimum/maximum` with `currency.code` (a code outside GigCurrency is null); `worldwide` is
 *   `!local`; `usdPerUnit` is `currency.exchange_rate` copied (Freelancer's own rate; null elsewhere); `bids` is `bid_stats.bid_count`; `skills` are `jobs[].name`; `postedAt` is `time_submitted` (epoch
 *   seconds). `hourly_project_info.commitment` is Freelancer's default and is never read.
 * - remotive: `contract` or `part_time` is a `contract`, `freelance` a `gig`, anything else is `invalid_output`.
 *   `publication_date` carries no zone and is read as UTC. Pay is read from `salary` and the description.
 * - hn-freelancer, hn-hiring: `title` is the comment's first line (at most 120 characters), `kind` is `contract`,
 *   `postedAt` is `created_at_i`. Pay is read from the text.
 * - boards: a daily Posting@1. `kind` is `contract`. The budget is read from the title and description text by PAY
 *   (freelance-boost; before, it was always `unknown`) and labelled `from: 'description'`; the Posting's annual `comp`
 *   is never read: an annual salary is not a freelance budget.
 * - himalayas (freelance-boost, `src-himalayas-gigs`): `url` is the job's himalayas.app page (`guid`, the attribution
 *   link), `kind` is `contract` (employment types Contractor, Part Time, Temporary; any other is `invalid_output`),
 *   `postedAt` is `pubDate` (epoch seconds). Pay: the structured `hourly`/`monthly` salary with a known currency,
 *   labelled `from: 'platform'` (`himalayasPay`; a figure the text states per task or project voids it), else the text
 *   by PAY, labelled `from: 'description'`. Location: `locationRestrictions` names (none: worldwide), and time zones
 *   that leave out IST make it not worldwide, said in `location.text`.
 * - draftdev (sources-expansion, `src-draftdev`): a Draft.dev writer role from its public GitHub repo. `kind` is `gig` for
 *   per-post/per-article pay, else `contract`. Pay: "$300+ per blog post" is a fixed budget (min 300, no max, USD,
 *   `from: 'description'`; no hours, so no rate: review); a yearly salary is `unknown`; else the text by PAY. Hours: "<n>[+]
 *   hours/week" (`min` n, `max` null), "no monthly minimums" is unknown, else the text by HOURS_PER_WEEK. Location:
 *   "Remote (Global|Worldwide|Anywhere)" in the summary is worldwide; a README bullet is worldwide only when the README
 *   says "remote, global team"; else the countries the summary names, nothing: not stated (review). Client Draft.dev,
 *   `postedAt` null (the API gives no date).
 * - prime-intellect (sources-expansion, `src-prime-intellect`): an open bounty issue of the PrimeIntellect-ai org. `kind` is
 *   `bounty`. Budget: a fixed budget of exactly the one distinct amount the title/body states next to the word bounty
 *   (`bountyAmount`: min = max, USD, `from: 'description'`), else `unknown`. Hours are never stated (unknown). Location:
 *   worldwide only when the issue text says anyone, open access, worldwide or anywhere (the program's own words), else not
 *   stated (review). Client Prime Intellect, `postedAt` the issue's `created_at` date.
 * - gmail: one job of an alert email as its sender's parser read it (`mail/parsers`): `title`, `url`, `description`,
 *   `company`, `location`, `pay`, `postedAt` and `kind` (`contract`, `gig` or `network-alert`), each copied. Pay is
 *   read from `pay` and the description by the same rule.
 *
 * Hours come from text only (HOURS_PER_WEEK). Pay in text counts only when exactly one distinct, unqualified figure
 * is stated (PAY): two different rates, "from $50/h" or "about $50/h" leave the budget `unknown`. An hourly "up to
 * $90/h" (or "Upto $90/hr") is a stated ceiling (freelance-boost): `min` null, `max` 90, `bound: 'ceiling'`.
 * A raw with no title or no url, from a platform with no mapping, or that is not the platform's shape, fails with
 * `invalid_output` naming the field.
 */

type Rec = Record<string, unknown>;
type Budget = Gig['budget'];
type Currency = NonNullable<Budget['currency']>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const nonBlank = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const CURRENCIES: readonly string[] = ['USD', 'INR', 'EUR', 'GBP', 'CAD', 'AUD', 'SGD', 'NZD', 'HKD'];
const currencyOf = (v: unknown): Currency | null => (typeof v === 'string' && CURRENCIES.includes(v.toUpperCase()) ? (v.toUpperCase() as Currency) : null);
const stripped = (v: unknown): string => (typeof v === 'string' ? collapse(htmlToText(v)) : '');

const fail = (r: RawGig, why: string): KernelError => new KernelError('invalid_output', `gig-normalizer: ${r.platform} ${r.sourceId}: ${why}`);

/**
 * "10 hours per week", "15-30 hrs/week", "10–39 hours per week" (en dash), "10—39" (em dash), "10 to 39 hours a
 * week", "20h a wk", "10 hours weekly", "between 10 and 20 hours a week". A phrase without a per-week unit is not hours per week.
 * (freelance-boost: before, only "-" joined a range, so "10–39 hours" read as 39; research A7.1.)
 */
export const HOURS_PER_WEEK = /\b(?:between\s+(\d{1,2})\s+and\s+(\d{1,2})|(\d{1,2})(?:\s?(?:-|–|—|to)\s?(\d{1,2}))?)\s?(?:h|hrs|hours)\s?(?:(?:\/|per|a)\s?(?:week|wk)|weekly)\b/gi;

/** The stated hours per week; several distinct figures ("not 40 h/week, just 10 h/week") are ambiguous, so null. */
function hoursOf(text: string): Gig['hoursPerWeek'] {
  const none = { min: null, max: null, source: null } as const;
  const found = new Map<string, { min: number; max: number }>();
  for (const m of text.matchAll(HOURS_PER_WEEK)) {
    const min = Number(m[1] ?? m[3]);
    const max = Number(m[2] ?? m[4] ?? min);
    if (!(min > 0 && max >= min)) return none;
    found.set(`${min}-${max}`, { min, max });
  }
  const only = found.size === 1 ? [...found.values()][0] : undefined;
  return only === undefined ? none : { ...only, source: 'text' };
}

/**
 * A duration in weeks: "2 weeks", "6-week". A range ("2-4 weeks") keeps its text and leaves `weeks` null, and so does
 * more than one distinct phrase. These are not a project length: "every/each/per/after/past/last/first N weeks",
 * "N weeks after/ago/later/notice", and N weeks of support, warranty, training, vacation or notice, or a sprint,
 * cycle, trial or probation.
 */
const WEEKS =
  /(?<!\b(?:every|each|per|after|past|last|first)\s)\b(?:(\d{1,2})\s?(?:-|–|—|to)\s?)?(\d{1,2})[\s-]?(?:weeks?|wks?)\b(?!(?:['’]s?)?\s+(?:after|ago|later|old|notice|before|prior|sprints?|cycles?|trials?|probation|vacation|leave|of\s+(?:support|hypercare|bug|warranty|maintenance|training|vacation|notice))\b)/gi;

function durationOf(text: string): Gig['duration'] {
  const found = [...text.matchAll(WEEKS)].filter((m) => Number(m[2]) > 0);
  const phrases = new Set(found.map((m) => m[0].toLowerCase()));
  const first = found[0];
  if (first === undefined || phrases.size !== 1) return { weeks: null, text: null };
  return { weeks: first[1] === undefined ? Number(first[2]) : null, text: first[0] };
}

const CODES = 'USD|EUR|GBP|INR|CAD|AUD|NZD|SGD|HKD';
const SYMBOL: Readonly<Record<string, Currency>> = {
  'US$': 'USD', 'C$': 'CAD', 'CA$': 'CAD', 'A$': 'AUD', 'AU$': 'AUD', 'NZ$': 'NZD', 'HK$': 'HKD', 'S$': 'SGD', 'SG$': 'SGD',
  '€': 'EUR', '£': 'GBP', '₹': 'INR', USD: 'USD', EUR: 'EUR', GBP: 'GBP', INR: 'INR', CAD: 'CAD', AUD: 'AUD', NZD: 'NZD', SGD: 'SGD', HKD: 'HKD',
};
/**
 * A stated pay: a currency sign or code, one figure or a range, then a per-hour or per-month unit. A bare "$" is USD
 * unless a code sits directly before the sign ("AUD $120", "SGD$60"), directly after the figure ("$90 CAD/hr") or
 * directly after the unit ("$90/hr CAD"); a prefixed sign (C$, CA$, A$, AU$, NZ$, HK$, S$, SG$, US$) names its own
 * currency; two different currencies in one pay are a conflict ("C$90 AUD"), and a letter glued before the sign
 * ("XC$90", "R$100") is no currency at all.
 */
const PAY = new RegExp(
  '(?<![A-Za-z])(?:(?<c0>' + CODES + ')\\s?)?(?<sym>(?:US|CA|AU|NZ|HK|SG|C|A|S)?\\$|[€£₹]|\\b(?:' + CODES + ')\\b)\\s?' +
    '(?<lo>\\d[\\d,]*(?:\\.\\d+)?)(?<klo>k)?(?:\\s?[-–]\\s?(?:(?:(?:US|CA|AU|NZ|HK|SG|C|A|S)?\\$|[€£₹])\\s?|(?:' + CODES + ')\\s?)?(?<hi>\\d[\\d,]*(?:\\.\\d+)?)(?<khi>k)?)?' +
    '(?:\\s?(?<c1>' + CODES + '))?\\s?(?:\\/|per\\s|an?\\s)\\s?(?<unit>hours?|hrs?|h|months?|mo)\\b(?:\\s?(?<c2>' + CODES + ')\\b)?',
  'giu',
);
/** "up to" / "upto" just before a figure: a stated ceiling (freelance-boost), kept as `max` with `bound: 'ceiling'`. */
const UP_TO = /\bup\s?to\s*$/i;
/** "from" just before a figure: a lower bound, unless the figure is itself a closed range ("from $80–$100/hr"). */
const FROM = /\bfrom\s*$/i;
/** Words just before a figure that make it a bound or one end of a range, not the rate. */
const QUALIFIED =
  /\b(?:up\s?to|from|starting(?:\s+at)?|at\s+least|min(?:imum)?|max(?:imum)?|over|under|below|above|less\s+than|more\s+than|estimated|approx(?:imately|\.)?|about|around|roughly|potential(?:\s+of)?|\d\s*(?:to|-|–))\s*$/i;
/** A monthly figure is pay only next to a pay word or as a "| field |" of a header line; near one of these it is a perk or a price. */
const PAY_WORD = /\b(?:rate|pay|paid|paying|salary|compensation|budget|retainer|fee)\b/i;
const NOT_PAY_WORD = /\b(?:stipend|allowance|subscription|internet|per\s+seat|wellness|benefits?|costs?|price[sd]?)\b/i;
const HEADER_CHARS = 300;

const UNKNOWN_BUDGET: Budget = { type: 'unknown', min: null, max: null, currency: null, usdPerUnit: null };

/** True when the match is a whole `|`-delimited field of the first line, within the first HEADER_CHARS characters ("... | $4000/month |"). */
function isHeaderField(text: string, at: number, end: number): boolean {
  const before = text.slice(0, at);
  if (at >= HEADER_CHARS || before.includes('\n')) return false;
  const after = text.slice(end);
  return /\|[^\S\n]*$/.test(before) && /^[^\S\n]*(?:\||\n|$)/.test(after);
}

function payOf(text: string): Budget {
  const seen = new Map<string, Budget>();
  for (const m of text.matchAll(PAY)) {
    const g = m.groups ?? {};
    const at = m.index ?? 0;
    const unit = (g.unit ?? '').toLowerCase();
    const type = unit.startsWith('mo') ? 'monthly' : 'hourly';
    if (type === 'monthly') {
      const field = isHeaderField(text, at, at + m[0].length);
      const around = field ? m[0] : text.slice(Math.max(0, at - 40), at + m[0].length + 40);
      if (NOT_PAY_WORD.test(around) || !(field || PAY_WORD.test(around))) continue;
    }
    const before = text.slice(Math.max(0, at - 40), at);
    // An hourly "up to $X" is a stated ceiling; any other qualified figure (a monthly ceiling too) is no rate.
    const ceiling = type === 'hourly' && UP_TO.test(before);
    // "(ranges) from $80–$100 per hour" names both ends: a closed range, not a lower bound.
    const closedRange = g.hi !== undefined && FROM.test(before);
    if (!ceiling && !closedRange && QUALIFIED.test(before)) return UNKNOWN_BUDGET;
    const k = (s: string | undefined): number => (s === undefined ? 1 : 1000);
    if (g.hi !== undefined && (g.klo === undefined) !== (g.khi === undefined)) return UNKNOWN_BUDGET;
    const lo = Number((g.lo ?? '').replace(/,/g, '')) * k(g.klo);
    const hi = g.hi === undefined ? lo : Number(g.hi.replace(/,/g, '')) * k(g.khi);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return UNKNOWN_BUDGET;
    const sym = (g.sym ?? '').toUpperCase();
    const named = [SYMBOL[sym], ...[g.c0, g.c1, g.c2].map((c) => (c === undefined ? undefined : SYMBOL[c.toUpperCase()]))].filter((c): c is Currency => c !== undefined);
    const currencies = new Set(named);
    // A bare "$" agrees with another dollar's code ("$90 CAD/hr") but not with EUR, GBP or INR ("$90/hr EUR").
    const nonDollar = sym === '$' && named.some((c) => c === 'EUR' || c === 'GBP' || c === 'INR');
    if (currencies.size > 1 || nonDollar || (named.length === 0 && sym !== '$')) return UNKNOWN_BUDGET;
    const currency = [...currencies][0] ?? 'USD';
    if (ceiling) seen.set(`${type}|${currency}|ceiling|${hi}`, { type, min: null, max: hi, currency, usdPerUnit: null, bound: 'ceiling' });
    else seen.set(`${type}|${currency}|${lo}|${hi}`, { type, min: lo, max: hi, currency, usdPerUnit: null });
  }
  // A ceiling that only repeats the top of a stated range ("Upto $130/hr" in a title, "$80–$130/hour" in the text) adds
  // nothing: the range is kept. A ceiling with any other top stays a conflict (unknown).
  const plain = [...seen.values()].filter((b) => b.bound === undefined);
  for (const [key, b] of seen) {
    if (b.bound === 'ceiling' && plain.length === 1 && plain.some((p) => p.type === b.type && p.currency === b.currency && p.max === b.max)) seen.delete(key);
  }
  return seen.size === 1 ? ([...seen.values()][0] ?? UNKNOWN_BUDGET) : UNKNOWN_BUDGET;
}

/** A budget read from the posting's text, labelled so (an unknown budget stays the plain unknown). */
const fromText = (b: Budget): Budget => (b.type === 'unknown' ? b : { ...b, from: 'description' });

/** Countries named in free location text, `worldwide` split off into its flag. */
function placesOf(text: string | null): { countries: string[]; worldwide: boolean } {
  // "US$60" and "CA$100" name a currency, not a place.
  const all = text === null ? [] : countriesIn(text.replace(/(?<![A-Za-z])(?:US|CA|AU|NZ|HK|SG)\$/g, '$'));
  return { countries: all.filter((c) => c !== 'worldwide'), worldwide: all.includes('worldwide') };
}

interface Draft {
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly clientName: string | null;
  readonly kind: Gig['kind'];
  readonly budget: Budget;
  readonly location: Gig['location'];
  readonly skills: string[];
  readonly postedAt: string | null;
  readonly bids: number | null;
  /** A source's structured hours; absent: `hoursOf(text)`. */
  readonly hours?: Gig['hoursPerWeek'];
}

function freelancer(r: RawGig, o: Rec): Draft {
  const title = collapse(nonBlank(o.title) ?? '');
  if (title === '') throw fail(r, 'missing title');
  const seo = nonBlank(o.seo_url);
  if (seo === null) throw fail(r, 'missing url');
  const budget = isRec(o.budget) ? o.budget : {};
  const code = isRec(o.currency) ? currencyOf(o.currency.code) : null;
  const rateOfCurrency = isRec(o.currency) ? o.currency.exchange_rate : null;
  const known = o.type === 'hourly' || o.type === 'fixed';
  const description = nonBlank(o.description) ?? nonBlank(o.preview_description) ?? '';
  return {
    url: `https://www.freelancer.com/projects/${seo}`,
    title,
    description: stripped(description),
    clientName: null,
    kind: o.type === 'hourly' ? 'contract' : 'gig',
    budget: !known
      ? UNKNOWN_BUDGET
      : o.type === 'hourly' && finite(budget.minimum) === null && finite(budget.maximum) !== null
        // An hourly project with only a maximum states a ceiling (review round 2026-10-15): it can never pass alone.
        ? { type: 'hourly', min: null, max: finite(budget.maximum), currency: code, usdPerUnit: code === null ? null : positive(rateOfCurrency), bound: 'ceiling' }
        : { type: o.type as 'hourly' | 'fixed', min: finite(budget.minimum), max: finite(budget.maximum), currency: code, usdPerUnit: code === null ? null : positive(rateOfCurrency) },
    location: { countries: [], worldwide: !o.local, text: null },
    skills: Array.isArray(o.jobs) ? o.jobs.flatMap((j: unknown) => (isRec(j) && typeof j.name === 'string' ? [j.name] : [])) : [],
    postedAt: postedAtOf(o.time_submitted, 's'),
    bids: isRec(o.bid_stats) ? finite(o.bid_stats.bid_count) : null,
  };
}

const NO_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

function remotive(r: RawGig, o: Rec): Draft {
  const title = collapse(nonBlank(o.title) ?? '');
  if (title === '') throw fail(r, 'missing title');
  const url = nonBlank(o.url);
  if (url === null) throw fail(r, 'missing url');
  const type = o.job_type;
  if (type !== 'contract' && type !== 'part_time' && type !== 'freelance') throw fail(r, `unsupported job_type ${JSON.stringify(type ?? null)}`);
  const description = stripped(o.description);
  const date = typeof o.publication_date === 'string' && NO_ZONE.test(o.publication_date.trim()) ? `${o.publication_date.trim()}Z` : o.publication_date;
  const place = nonBlank(o.candidate_required_location);
  return {
    url,
    title,
    description,
    clientName: nonBlank(o.company_name),
    kind: type === 'freelance' ? 'gig' : 'contract',
    budget: payOf(`${stripped(o.salary)}\n${description}`),
    location: { ...placesOf(place), text: place === null ? null : collapse(place) },
    skills: Array.isArray(o.tags) ? o.tags.filter((t: unknown): t is string => typeof t === 'string') : [],
    postedAt: postedAtOf(date),
    bids: null,
  };
}

function hn(r: RawGig, o: Rec): Draft {
  const text = typeof o.text === 'string' ? htmlToText(o.text) : '';
  const first = text.split('\n').map(collapse).find((l) => l !== '');
  if (first === undefined) throw fail(r, 'missing title');
  const title = [...first].slice(0, 120).join('').trim();
  const description = collapse(text);
  return {
    url: `https://news.ycombinator.com/item?id=${r.sourceId}`,
    title,
    description,
    clientName: null,
    kind: 'contract',
    budget: payOf(text),
    location: { ...placesOf(first), text: null },
    skills: [],
    postedAt: postedAtOf(o.created_at_i, 's'),
    bids: null,
  };
}

function boards(r: RawGig, o: unknown): Draft {
  const p = Posting.schema.safeParse(o);
  if (!p.success) throw fail(r, 'raw is not a Posting@1');
  const posting = p.data;
  const title = collapse(posting.title);
  if (title === '') throw fail(r, 'missing title');
  const url = nonBlank(posting.url);
  if (url === null) throw fail(r, 'missing url');
  const place = nonBlank(posting.locationText);
  return {
    url,
    title,
    description: collapse(posting.descriptionText),
    clientName: nonBlank(posting.company),
    kind: 'contract',
    // freelance-boost (research A7.2): the posting's own stated pay, by the same PAY rule as the other text sources,
    // labelled `from: description`. The daily Posting's annual `comp` is still not a freelance budget, and PAY reads
    // only hourly and monthly units, so an annual salary in the text stays unknown.
    budget: fromText(payOf(`${title}\n${posting.descriptionText}`)),
    location: {
      countries: posting.remote.countries.filter((c) => c !== 'worldwide'),
      worldwide: posting.remote.countries.includes('worldwide'),
      text: place === null ? null : collapse(place),
    },
    skills: [],
    postedAt: postedAtOf(posting.postedAt),
    bids: null,
  };
}

const DRAFTDEV_PER_POST = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?\+?\s?(?:USD\s?)?(?:\/|per\s)\s?(?:blog\s+)?(?:post|article)\b/i;
const DRAFTDEV_ANY_PER_POST = /per\s+(?:blog\s+)?(?:post|article)/i;
const YEARLY = /(?:\/\s?(?:year|yr)\b|per\s+(?:year|annum)\b|\bannual(?:ly)?\b|\ba\s+year\b)/i;
const DRAFTDEV_HOURS = /\b(\d{1,3})\s?\+?\s?(?:hours?|hrs?)\s?(?:\/|per|a)\s?(?:week|wk)\b/i;
const NO_MINIMUMS = /\bno\s+monthly\s+minimums?\b/i;
const REMOTE_GLOBAL = /\bremote\s*\((?:global|worldwide|anywhere)\)/i;

function draftdev(r: RawGig, o: Rec): Draft {
  const title = collapse(nonBlank(o.title) ?? '');
  if (title === '') throw fail(r, 'missing title');
  const url = nonBlank(o.url);
  if (url === null) throw fail(r, 'missing url');
  const summary = nonBlank(o.summary) === null ? null : collapse(String(o.summary));
  const text = collapse(typeof o.text === 'string' ? o.text : '');
  // The role file's H1 (the title again) and its quote line (the terms) are replaced by one labelled terms sentence, so the
  // hours rule reads "Commitment and pay: ..., 40+ hours/week, ..." as a stated requirement, once.
  const body = typeof o.text === 'string' ? o.text.split('\n').filter((l) => !l.startsWith('# ') && !(summary !== null && collapse(l.replace(/^>\s*/, '')) === summary)).join('\n').replace(/\*\*/g, '').replace(/^#+\s*/gm, '') : '';
  const description = collapse(`${summary === null ? '' : `Commitment and pay: ${summary}.`} ${body}`);
  const stated = `${summary ?? ''}\n${text}`;
  const perPost = DRAFTDEV_PER_POST.exec(summary ?? '') ?? DRAFTDEV_PER_POST.exec(text);
  const budget: Budget = perPost
    ? { type: 'fixed', min: Number((perPost[1] ?? '').replace(/,/g, '')), max: null, currency: 'USD', usdPerUnit: null, from: 'description' }
    : YEARLY.test(stated)
      ? UNKNOWN_BUDGET
      : fromText(payOf(stated));
  const h = DRAFTDEV_HOURS.exec(stated);
  const hours: Gig['hoursPerWeek'] | undefined = h ? { min: Number(h[1]), max: null, source: 'text' } : NO_MINIMUMS.test(stated) ? { min: null, max: null, source: null } : undefined;
  const readme = r.sourceId.startsWith('readme:');
  const globalNote = REMOTE_GLOBAL.exec(summary ?? '');
  const where = placesOf(summary);
  const location: Gig['location'] = globalNote
    ? { countries: [], worldwide: true, text: 'Remote (Global)' }
    : readme && o.readmeRemoteGlobal === true
      ? { countries: [], worldwide: true, text: 'Remote, global team (README)' }
      : { ...where, text: readme || summary === null ? null : summary };
  return {
    url,
    title,
    description,
    clientName: 'Draft.dev',
    kind: DRAFTDEV_ANY_PER_POST.test(stated) ? 'gig' : 'contract',
    budget,
    location,
    skills: [],
    postedAt: null,
    bids: null,
    ...(hours === undefined ? {} : { hours }),
  };
}

const PI_OPEN_TO_ALL = /\b(?:anyone|open access|worldwide|anywhere)\b/i;

function primeIntellect(r: RawGig, o: Rec): Draft {
  const title = collapse(nonBlank(o.title) ?? '');
  if (title === '') throw fail(r, 'missing title');
  const url = nonBlank(o.url);
  if (url === null) throw fail(r, 'missing url');
  const body = typeof o.body === 'string' ? o.body : '';
  const amount = bountyAmount(`${title}\n${body}`);
  const open = PI_OPEN_TO_ALL.test(`${title}\n${body.slice(0, 64_000)}`);
  return {
    url,
    title,
    description: collapse(`${title}. ${body}`),
    clientName: 'Prime Intellect',
    kind: 'bounty',
    budget: amount === null ? UNKNOWN_BUDGET : { type: 'fixed', min: amount, max: amount, currency: 'USD', usdPerUnit: null, from: 'description' },
    location: open ? { countries: [], worldwide: true, text: 'Open to anyone (issue text)' } : { countries: [], worldwide: false, text: null },
    skills: [],
    postedAt: typeof o.created_at === 'string' ? postedAtOf(o.created_at.slice(0, 10)) : null,
    bids: null,
    hours: { min: null, max: null, source: null },
  };
}

const GMAIL_KINDS: readonly string[] = ['contract', 'gig', 'network-alert'];

function gmail(r: RawGig, o: Rec): Draft {
  const title = collapse(nonBlank(o.title) ?? '');
  if (title === '') throw fail(r, 'missing title');
  const url = nonBlank(o.url);
  if (url === null) throw fail(r, 'missing url');
  if (typeof o.kind !== 'string' || !GMAIL_KINDS.includes(o.kind)) throw fail(r, `unsupported kind ${JSON.stringify(o.kind ?? null)}`);
  const description = collapse(typeof o.description === 'string' ? o.description : '');
  const place = nonBlank(o.location);
  return {
    url,
    title,
    description,
    clientName: nonBlank(o.company),
    kind: o.kind as Gig['kind'],
    budget: payOf(`${nonBlank(o.pay) ?? ''}\n${description}`),
    location: { ...placesOf(place), text: place === null ? null : collapse(place) },
    skills: [],
    postedAt: postedAtOf(o.postedAt),
    bids: null,
  };
}

const HIMALAYAS_KINDS: readonly string[] = ['Contractor', 'Part Time', 'Temporary'];
/** A figure followed by a unit that is not time-based work ("$500/task"): the platform's `hourly` label is then wrong. */
const NOT_HOURLY_UNIT =
  /^\s?(?:(?:\/|per\s|an?\s|each\s)\s?(?:task|project|item|word|page|unit|submission|annotation|piece|video|image|deliverable|article|day|week|month|year|annum|milestone)s?\b|(?:total|flat|fixed|in\s+total|lump\s+sum)\b)/i;

/** Whether the text names `figure` (as money) with a non-time unit: "$500/task", "$500 per project". */
function statedPerTask(text: string, figure: number): boolean {
  // "$500/task", "USD 400 per day", and the code after the figure: "400 USD per task", "250 USD/day".
  const money = /(?:[$€£₹]|\b(?:USD|EUR|GBP|INR)\s?)\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(?:USD|EUR|GBP|INR)\b)?|\b(\d[\d,]*(?:\.\d+)?)\s?(?:USD|EUR|GBP|INR)\b/gi;
  for (const m of text.matchAll(money)) {
    if (Number((m[1] ?? m[2] ?? '').replace(/,/g, '')) !== figure) continue;
    if (NOT_HOURLY_UNIT.test(text.slice((m.index ?? 0) + m[0].length))) return true;
  }
  return false;
}

/**
 * Himalayas' structured pay (`minSalary`, `maxSalary`, `salaryPeriod`, `currency`): `hourly` or `monthly` with a
 * figure and a known currency is the budget, labelled `from: 'platform'`: both ends a stated range, a maximum alone a
 * ceiling (`bound: 'ceiling'`), a minimum alone no budget. Contradicted by the text (the figure stated per task,
 * project, item, day, week, month, or as a total, flat or fixed sum, the currency before or after it: the platform's
 * period is wrong, live 2026-10-14 "Up to $500/task" filed as hourly 500), it is no budget at all. Anything else (an `annual` salary, no figure) is null: the text is read instead.
 */
function himalayasPay(o: Rec, text: string): Budget | 'contradicted' | null {
  const period = o.salaryPeriod;
  if (period !== 'hourly' && period !== 'monthly') return null;
  const min = positive(o.minSalary);
  const max = positive(o.maxSalary);
  const currency = currencyOf(o.currency);
  if ((min === null && max === null) || currency === null) return null;
  if ([min, max].some((f) => f !== null && statedPerTask(text, f))) return 'contradicted';
  // Review round 2026-10-15: a stated range needs both ends; a maximum alone is a ceiling (it can never pass alone);
  // a minimum alone is no rate at all (review).
  if (max === null) return 'contradicted';
  if (min === null) return { type: period, min: null, max, currency, usdPerUnit: null, from: 'platform', bound: 'ceiling' };
  return { type: period, min, max, currency, usdPerUnit: null, from: 'platform' };
}

/** `locationRestrictions` as place names: live strings, or the documented `{name}` objects. */
const restrictionNames = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap((x) => (typeof x === 'string' && x.trim() !== '' ? [x.trim()] : isRec(x) && typeof x.name === 'string' ? [x.name.trim()] : [])) : [];

function himalayas(r: RawGig, o: Rec): Draft {
  const title = collapse(nonBlank(o.title) ?? '');
  if (title === '') throw fail(r, 'missing title');
  const url = nonBlank(o.guid);
  if (url === null) throw fail(r, 'missing url');
  if (typeof o.employmentType !== 'string' || !HIMALAYAS_KINDS.includes(o.employmentType)) throw fail(r, `unsupported employmentType ${JSON.stringify(o.employmentType ?? null)}`);
  const description = stripped(o.description);
  const text = `${title}\n${description}`;
  const pay = himalayasPay(o, text);
  const names = restrictionNames(o.locationRestrictions);
  const zones = Array.isArray(o.timezoneRestrictions) ? o.timezoneRestrictions.filter((z): z is number => typeof z === 'number' && Number.isFinite(z)) : [];
  // Time zones that leave out IST exactly (no +5.5 in the list; +5 and +6 are other zones): not worldwide, said so in
  // the location text. Review round 2026-10-15: the rule is exact, a near zone is no IST.
  const zonesExcludeIst = zones.length > 0 && !zones.includes(IST_OFFSET_H);
  const zoneText = zonesExcludeIst ? `time zones UTC${fmtZone(Math.min(...zones))} to UTC${fmtZone(Math.max(...zones))} only` : null;
  const place = [names.join(', '), zoneText].filter((x) => x !== null && x !== '').join('; ');
  const where = placesOf(names.join(', '));
  return {
    url,
    title,
    description,
    clientName: nonBlank(o.companyName),
    kind: 'contract',
    budget: pay === 'contradicted' ? UNKNOWN_BUDGET : (pay ?? fromText(payOf(text))),
    location: { countries: where.countries, worldwide: names.length === 0 ? !zonesExcludeIst : where.worldwide, text: place === '' ? null : place },
    skills: [],
    postedAt: postedAtOf(o.pubDate, 's'),
    bids: null,
  };
}

const IST_OFFSET_H = 5.5;
const fmtZone = (z: number): string => `${z >= 0 ? '+' : '−'}${Math.floor(Math.abs(z))}${Math.abs(z) % 1 === 0 ? '' : `:${String(Math.round((Math.abs(z) % 1) * 60)).padStart(2, '0')}`}`;

/** Maps one RawGig; throws `invalid_output` naming the field for a missing title or url, an unsupported platform or a raw of the wrong shape. */
export function normalizeGig(r: RawGig): Gig {
  if (r.platform !== 'freelancer' && r.platform !== 'remotive' && r.platform !== 'hn-freelancer' && r.platform !== 'hn-hiring' && r.platform !== 'boards' && r.platform !== 'gmail' && r.platform !== 'himalayas' && r.platform !== 'draftdev' && r.platform !== 'prime-intellect') {
    throw new KernelError('invalid_output', `gig-normalizer: unsupported platform ${r.platform}`);
  }
  if (r.platform !== 'boards' && !isRec(r.raw)) throw fail(r, 'raw is not an object');
  const o = r.raw as Rec;
  const d =
    r.platform === 'freelancer' ? freelancer(r, o)
    : r.platform === 'remotive' ? remotive(r, o)
    : r.platform === 'boards' ? boards(r, r.raw)
    : r.platform === 'gmail' ? gmail(r, o)
    : r.platform === 'himalayas' ? himalayas(r, o)
    : r.platform === 'draftdev' ? draftdev(r, o)
    : r.platform === 'prime-intellect' ? primeIntellect(r, o)
    : hn(r, o);
  const text = `${d.title}\n${d.description}`;
  return {
    gigKey: gigKey(r.platform, r.sourceId),
    dedupeKey: gigDedupeKey(d.clientName, d.title),
    platform: r.platform,
    sourceId: r.sourceId,
    url: d.url,
    title: d.title,
    description: d.description,
    client: { name: d.clientName, country: null, paymentVerified: null, hireRate: null, spendUsd: null, reviews: null, since: null },
    kind: d.kind,
    budget: d.budget,
    hoursPerWeek: d.hours ?? hoursOf(text),
    duration: durationOf(text),
    timezone: { required: null, overlapText: null },
    location: d.location,
    skills: d.skills,
    postedAt: d.postedAt,
    bids: d.bids,
  };
}

export const gigNormalizerContract = defineContract({
  id: 'gig-normalizer',
  version: '1.1.0',
  description: 'Maps one raw gig from any platform to the common gig shape',
  skills: ['gig-normalization'],
  team: 'understanding',
  kind: 'deterministic',
  consumes: RawGig,
  produces: Gig,
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
  // A failure here is one gig's data (no title or url), not a failing service; it must not stop the other gigs.
  breaker: { consecutiveFailures: 10_000 },
});

export const gigNormalizer = defineAgent(gigNormalizerContract, async (raw) => [normalizeGig(raw)]);
