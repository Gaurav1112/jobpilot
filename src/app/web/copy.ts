import { RED } from '../freelance/rank.js';
import { totalHours } from '../freelance/rate.js';
import type { JobView } from '../store/app-store.js';
import { usdText } from './format.js';

/**
 * Plain-language copy for the dashboard (Task 13), as strings: the views escape them through `html`. Written from the
 * user's side ("documents you can send"), never in pipeline terms.
 */

export type Tone = 'good' | 'warn' | 'critical' | 'neutral' | 'muted' | 'accent';

const SOURCE_NAME: Readonly<Record<string, string>> = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', himalayas: 'Himalayas', jobicy: 'Jobicy', careers: 'a careers site',
  feed: 'a job feed', workday: 'Workday', icims: 'iCIMS', smartrecruiters: 'SmartRecruiters', taleo: 'Taleo',
};
/** A source or ATS id as the user reads it mid-sentence: "Greenhouse", "Himalayas", "a careers site". */
export const sourceName = (id: string): string => SOURCE_NAME[id] ?? id;

const titleCase = (s: string): string => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** The remote verdict of a posting as a pill label, tone and the evidence behind it. */
export function remoteText(remote: JobView['remote']): { label: string; tone: Tone; title?: string } {
  if (remote === null) return { label: 'Location unclear', tone: 'warn' };
  const where = remote.countries.slice(0, 2).map(titleCase).join(', ');
  const title = remote.signals.join(', ');
  switch (remote.structured) {
    case 'remote':
      return { label: where === '' ? 'Remote' : `Remote · ${where}`, tone: 'good', title };
    case 'hybrid':
      return { label: 'Hybrid', tone: 'warn', title };
    case 'onsite':
      return { label: 'On-site', tone: 'critical', title };
    default:
      return { label: where === '' ? 'Remote unclear' : `Remote? · ${where}`, tone: 'warn', title };
  }
}

/** Why a job has no documents to send, in plain words. */
export function docsReason(j: Pick<JobView, 'docsState' | 'docsDetail' | 'company' | 'title' | 'location'>): string | null {
  const d = j.docsDetail ?? '';
  switch (j.docsState) {
    case 'ready':
      return null;
    case 'below-floor':
      return 'No documents: this job scored under your minimum fit, so none were made.';
    case 'missing':
      return `Documents are missing on disk (${d.replace(/^documents missing:\s*/, '')}). Run "jobpilot docs rebuild" to make them again.`;
    case 'stale':
      return "These documents cite a fact you rejected; they'll be rebuilt next time the posting is seen";
    case 'none':
      return d === '' ? 'No documents yet: the next run makes them if this job qualifies.' : `No documents yet: ${d}`;
    case 'blocked':
      break;
  }
  const glyph = /unrenderable-glyph:U\+([0-9A-F]{4,6})/.exec(d);
  if (glyph) {
    const hex = glyph[1] as string;
    const ch = String.fromCodePoint(Number.parseInt(hex, 16));
    const where = j.company.includes(ch) ? ' in the company name' : j.title.includes(ch) ? ' in the job title' : j.location.includes(ch) ? ' in the location' : ' in the posting';
    return `documents blocked: unrenderable character U+${hex}${where}`;
  }
  if (d.includes('unsafe-posting-text')) return 'documents blocked: the posting text has markup or characters that cannot go into a document safely';
  const naming = /G-NAMING: forbidden term #(\d+)/.exec(d);
  if (naming) return `documents blocked: a forbidden term (#${naming[1] as string} in naming.yaml) would have appeared`;
  if (d.startsWith('qa failed: ')) return `documents blocked: a quality check failed (${d.slice('qa failed: '.length)})`;
  const q = /^(\S+) quarantined: (.*)$/.exec(d);
  if (q) return `documents blocked: a safety check stopped the ${q[1] as string} step (${q[2] as string})`;
  return d === '' ? 'documents blocked' : `documents blocked: ${d}`;
}

/** Readable eligibility reason codes; the code itself is shown beside it. */
export function reasonText(code: string): string {
  if (code === 'remote-unclear') return 'The posting does not say clearly where remote work is allowed';
  if (code === 'onsite-only') return 'On-site only, outside the cities you accept';
  if (code.startsWith('remote-excludes-india')) return 'Remote, but not open to people in India';
  if (code === 'location-outside-india') return 'The posting names only places outside India';
  if (code === 'timezone-excludes-india') return 'Working hours are limited to time zones that exclude India';
  if (code.startsWith('role:')) return 'The title matches a role you filtered out';
  if (code.startsWith('company:')) return 'A company you filtered out';
  if (code.startsWith('employment:')) return 'Not a full-time job';
  if (code.startsWith('years')) return 'Asks for more years than you set as your limit';
  return code;
}

/** A score breakdown label in words. `display` maps a lexicon key to its display name. */
export function breakdownText(label: string, display: (key: string) => string): string {
  if (label === 'base') return 'Starting points';
  if (label === 'title:seniority') return 'Seniority in the title';
  if (label === 'title:family') return 'Job family in the title';
  if (label === 'years>max') return 'Asks for more years than your limit';
  const m = /^(strong|medium|gap):(.+)$/.exec(label);
  if (m) {
    const term = display(m[2] as string);
    return m[1] === 'strong' ? `Core skill: ${term}` : m[1] === 'medium' ? `Skill: ${term}` : `Asks for ${term}, which you don't list`;
  }
  return label;
}

// ---- Freelance (Task 10) ------------------------------------------------------------------------------------------

/** A stored gig rate (RatedGig `rate`), as the dashboard reads it from the row. */
export interface GigRate {
  readonly minUsdH: number | null;
  readonly maxUsdH: number | null;
  readonly method: string;
  readonly fxDate: string | null;
  readonly fxSource: string | null;
  readonly budgetUsd: number | null;
}

/** What a rate label needs besides the rate: the gig's text, duration, stated hours per week and budget type. */
export interface RateBasis {
  readonly description: string;
  readonly weeks: number | null;
  readonly hours: number | null;
  readonly budgetType: string;
}

const num1 = (n: number): string => n.toFixed(1).replace(/\.0$/, '');
const plural = (n: number, one: string, many: string): string => `${num1(n)} ${n === 1 ? one : many}`;

/** "$50/h", "$43.80–49.64/h": the minimum and maximum in US dollars per hour, one figure when they agree. */
function perHour(r: GigRate): string {
  const lo = r.minUsdH;
  const hi = r.maxUsdH;
  if (lo !== null && hi !== null && lo !== hi) return `${usdText(lo)}–${usdText(hi).slice(1)}/h`;
  return `${usdText((hi ?? lo) as number)}/h`;
}

/**
 * The rate as the user reads it, always with how it was reached (spec §5: a derived rate is never shown without its
 * label). `stated`: "$50/h stated"; `derived-from-duration`: "$75/h derived from 2 weeks (the basis is not on record)" (the hours cap the run used is not stored); `fixed÷stated-hours`:
 * "$50/h from ~60 hours stated" or "$25/h from 3 weeks × 20 h stated"; `monthly÷hours`: "$46.19/h from a monthly
 * $4,000 at 20 h/week stated"; `unknown`: "rate unknown - fixed budget $750" (or just "rate unknown"). A rate the
 * platform's own exchange rate converted ends with " · via platform FX". When a derived rate's basis is not on record
 * the label says so instead of guessing it.
 */
export function rateLabel(rate: GigRate | null, basis: RateBasis): string {
  const fx = rate?.fxSource === 'platform' ? ' · via platform FX' : '';
  if (rate === null || rate.method === 'unknown' || (rate.minUsdH === null && rate.maxUsdH === null)) {
    const b = rate?.budgetUsd ?? null;
    const kind = basis.budgetType === 'monthly' ? 'monthly' : basis.budgetType === 'fixed' ? 'fixed' : null;
    return b !== null && kind !== null ? `rate unknown - ${kind} budget ${usdText(b)}${fx}` : `rate unknown${fx}`;
  }
  const pay = perHour(rate);
  const missing = ' (the basis is not on record)';
  switch (rate.method) {
    case 'stated':
      return `${pay} stated${fx}`;
    case 'derived-from-duration': {
      // The run divided the budget by weeks × the pack's weekly hours cap at that time. The stored rate keeps neither
      // figure, and the cap is never recomputed from the rate or read from today's pack: only the weeks (from the
      // run's own Gig@1) are shown, with the honest note.
      const w = basis.weeks;
      return w === null || w <= 0 ? `${pay} derived from the duration${missing}${fx}` : `${pay} derived from ${plural(w, 'week', 'weeks')}${missing}${fx}`;
    }
    case 'fixed÷stated-hours': {
      if (basis.hours !== null && basis.hours > 0 && basis.weeks !== null && basis.weeks > 0) return `${pay} from ${plural(basis.weeks, 'week', 'weeks')} × ${num1(basis.hours)} h stated${fx}`;
      const t = totalHours(basis.description);
      if (t === null || t === 'refused') return `${pay} from stated hours${missing}${fx}`;
      return `${pay} from ~${t.lo === t.hi ? String(t.hi) : `${t.lo}–${t.hi}`} hours stated${fx}`;
    }
    case 'monthly÷hours':
      if (rate.budgetUsd === null || basis.hours === null) return `${pay} from a monthly budget${missing}${fx}`;
      return `${pay} from a monthly ${usdText(rate.budgetUsd)} at ${num1(basis.hours)} h/week stated${fx}`;
    default:
      return `${pay} (${rate.method})${fx}`;
  }
}

const FLAG_TEXT: Readonly<Record<string, string>> = {
  'off-platform': 'asks to move off the platform',
  'unusual-payment': 'asks to pay in crypto, gift cards or a money transfer',
  'upfront-fee': 'asks you to pay a fee first',
  'payment-unverified': "client's payment method is not verified",
  'thin-brief': 'very short brief, client has no history',
  'unpaid-test': 'asks for free or long unpaid test work',
  'duplicate-text': 'same text as another post',
  repeat: 'your proposal opens like another one',
};

/** A risk flag in plain words, red for the RED ids (rank.ts), amber for every other; its detail is the tooltip. */
export function flagText(f: { readonly id: string; readonly detail: string }): { label: string; tone: Tone; title: string } {
  return { label: FLAG_TEXT[f.id] ?? f.id, tone: RED.has(f.id) ? 'critical' : 'warn', title: f.detail };
}

const PLATFORM_NAME: Readonly<Record<string, string>> = {
  freelancer: 'Freelancer.com', remotive: 'Remotive', 'hn-freelancer': 'HN freelancer thread', 'hn-hiring': 'HN who is hiring', boards: 'Job boards (contract roles)',
  gmail: 'Gmail', upwork: 'Upwork', reddit: 'Reddit',
};
/** A gig platform id as the user reads it. */
export const platformName = (id: string): string => PLATFORM_NAME[id] ?? id;

/**
 * The platforms with no working source in this build, and why (spec §9): shown on the Sources tab. A platform the
 * user turned off in freelance.yaml says so.
 */
export const DISABLED_REASON: Readonly<Record<string, string>> = {
  upwork: 'API key pending approval',
  reddit: 'needs your OAuth script app',
  gmail: 'not connected yet',
};

/** "covered 6/8 · missing: Kubernetes, Terraform" (display names); null when the gig has no plan on record. */
export function coverageText(covered: readonly string[], missing: readonly string[], display: (k: string) => string): string {
  const total = covered.length + missing.length;
  return `covered ${covered.length}/${total}${missing.length > 0 ? ` · missing: ${missing.map(display).join(', ')}` : ''}`;
}

/** Stated hours per week ("15 h/week", "10–20 h/week") or "hours not stated". */
export function hoursText(h: { readonly min: number | null; readonly max: number | null } | null): string {
  if (h === null || (h.min === null && h.max === null)) return 'hours not stated';
  if (h.min !== null && h.max !== null && h.min !== h.max) return `${num1(h.min)}–${num1(h.max)} h/week`;
  return `${num1((h.max ?? h.min) as number)} h/week`;
}

/** The client's signals, each only when the platform states it. */
export function clientSignals(c: Record<string, unknown> | null): string[] {
  if (c === null) return [];
  const out: string[] = [];
  if (c['paymentVerified'] === true) out.push('Payment verified');
  if (c['paymentVerified'] === false) out.push('Payment not verified');
  if (typeof c['hireRate'] === 'number') out.push(`hires ${Math.round(c['hireRate'] * 100)}% of the time`);
  if (typeof c['spendUsd'] === 'number') out.push(`spent ${usdText(Math.round(c['spendUsd']))}`);
  if (typeof c['reviews'] === 'number') out.push(`${c['reviews']} review${c['reviews'] === 1 ? '' : 's'}`);
  if (typeof c['country'] === 'string' && c['country'] !== '') out.push(c['country']);
  if (typeof c['since'] === 'string' && /^\d{4}/.test(c['since'])) out.push(`member since ${c['since'].slice(0, 4)}`);
  return out;
}

/** Why a gig has no documents to paste, in plain words; null when they are ready. */
export function gigDocsReason(state: string, detail: string | null, list: string | null): string | null {
  const d = detail ?? '';
  switch (state) {
    case 'ready':
      return null;
    case 'missing':
      return `Documents are missing on disk (${d.replace(/^documents missing:\s*/, '')}). The next run makes them again.`;
    case 'blocked':
      return d.startsWith('qa failed: ') ? `Documents blocked: a quality check failed (${d.slice('qa failed: '.length)})` : `Documents blocked${d === '' ? '' : `: ${d}`}`;
    default:
      if (d === 'below the fit floor' || list === 'below-floor') return 'No documents: this gig scored under your minimum fit, so none were made.';
      if (list === null) return 'No documents: this gig is not eligible.';
      return d === '' ? 'No documents yet: the next run makes them if this gig qualifies.' : `No documents yet: ${d}`;
  }
}
