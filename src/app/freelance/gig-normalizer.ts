import { defineAgent } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { KernelError } from '../../kernel/errors.js';
import { htmlToText } from '../text/html.js';
import { countriesIn, postedAtOf } from '../text/norm.js';
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
 * week", "20h a wk", "between 10 and 20 hours a week". A phrase without a per-week unit is not hours per week.
 * (freelance-boost: before, only "-" joined a range, so "10–39 hours" read as 39; research A7.1.)
 */
export const HOURS_PER_WEEK = /\b(?:between\s+(\d{1,2})\s+and\s+(\d{1,2})|(\d{1,2})(?:\s?(?:-|–|—|to)\s?(\d{1,2}))?)\s?(?:h|hrs|hours)\s?(?:\/|per|a)\s?(?:week|wk)\b/gi;

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
    if (!ceiling && QUALIFIED.test(before)) return UNKNOWN_BUDGET;
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
    budget: known ? { type: o.type as 'hourly' | 'fixed', min: finite(budget.minimum), max: finite(budget.maximum), currency: code, usdPerUnit: code === null ? null : positive(rateOfCurrency) } : UNKNOWN_BUDGET,
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

/** Maps one RawGig; throws `invalid_output` naming the field for a missing title or url, an unsupported platform or a raw of the wrong shape. */
export function normalizeGig(r: RawGig): Gig {
  if (r.platform !== 'freelancer' && r.platform !== 'remotive' && r.platform !== 'hn-freelancer' && r.platform !== 'hn-hiring' && r.platform !== 'boards' && r.platform !== 'gmail') {
    throw new KernelError('invalid_output', `gig-normalizer: unsupported platform ${r.platform}`);
  }
  if (r.platform !== 'boards' && !isRec(r.raw)) throw fail(r, 'raw is not an object');
  const o = r.raw as Rec;
  const d =
    r.platform === 'freelancer' ? freelancer(r, o) : r.platform === 'remotive' ? remotive(r, o) : r.platform === 'boards' ? boards(r, r.raw) : r.platform === 'gmail' ? gmail(r, o) : hn(r, o);
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
    hoursPerWeek: hoursOf(text),
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
