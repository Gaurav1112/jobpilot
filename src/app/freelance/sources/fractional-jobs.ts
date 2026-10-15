import { defineAgent, type Agent } from '../../../kernel/agent.js';
import { defineContract, type Contract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import { SOURCE_TIMEOUT_MS } from '../../agents/sources/common.js';
import { hasChallengeMarker, isChallenge } from '../../challenge.js';
import { robotsAllows, robotsVerdictOf, type Robots } from '../../coverage/robots.js';
import { htmlToText } from '../../text/html.js';
import { GigRequest, RawGig } from '../types.js';
import { finishGigs } from './common.js';

/**
 * `src-fractional-jobs`: the roles on fractionaljobs.io's public homepage, ONE page request per run (plus robots.txt
 * once), the himalayas-gigs host rules: robots.txt read first and applied (a disallow of `/` is the named skip
 * `robots-disallow www.fractionaljobs.io`); ≥ 2000 ms apart; 401/403/challenge → `challenged`, 429 → `rate_limit`, both
 * disable the host for the run, never retried, Retry-After never read; 5xx → `overloaded`.
 * Seen live 2026-10-15: robots.txt names only a sitemap (no disallow), /terms has no clause about automated access, the
 * homepage (HTTP 200 to the honest UA) lists the newest roles as Webflow cards. GoFractional answers 403 to the honest
 * UA and is NOT read.
 * Caps (loud): a body over FJ_MAX_BYTES or more than FJ_MAX_CARDS cards → `input_rejected`, nothing read.
 * Parse (linear: `indexOf` from one `job-item w-dyn-item` marker to the next; inside a card, the `<h3>` texts, the
 * `job-item_more-info` `text-inline` values and the hidden `fs-cmsfilter-field="function"`, `date` and `job-id` divs,
 * each found by a forward search within the card): `{ jobId, company, title, companySite, hours, pay, location, function, date }`.
 * The more-info values are, in order, hours, pay, location; a value Webflow marks `w-condition-invisible` (the
 * "Unknown" pay) is absent (null). "hrs" are hours PER WEEK (decision D10). Only FJ_FUNCTIONS are kept; the rest are
 * counted in one note `fractional-jobs: N of M roles in other functions`. A card without a job id (a plain slug) or
 * title is a named malformed entry; every card malformed is schema drift (`invalid_output`).
 * sourceId = jobId; url = `https://www.fractionaljobs.io/jobs/<jobId>`.
 */
export const FJ_HOST = 'www.fractionaljobs.io';
export const FJ_MAX_BYTES = 2 * 1024 * 1024;
export const FJ_MAX_CARDS = 200;
export const FJ_FUNCTIONS: readonly string[] = ['Engineering', 'Data', 'Product'];
export const FJ_MIN_INTERVAL_MS = 2000;
export const FJ_HOME_URL = `https://${FJ_HOST}/`;
export const FJ_ROBOTS_URL = `https://${FJ_HOST}/robots.txt`;

/** One card as the page states it; a value the page hides or lacks is null. */
export interface FjCard {
  readonly jobId: string;
  readonly company: string | null;
  readonly title: string;
  readonly companySite: string | null;
  readonly hours: string | null;
  readonly pay: string | null;
  readonly location: string | null;
  readonly function: string | null;
  readonly date: string | null;
}

const CARD = 'job-item w-dyn-item';
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/;
/** A card is some KB; one this long is not a card. */
const CARD_MAX_CHARS = 200_000;
const FIELD_MAX = 300;

const clean = (s: string): string => htmlToText(s).replace(/\s+/g, ' ').trim();

/** The text of the first element whose opening tag contains `marker` (ends with `>`), within `seg`, from `from`. */
function textAfter(seg: string, marker: string, from = 0): string | null {
  const at = seg.indexOf(marker, from);
  if (at === -1) return null;
  const start = at + marker.length;
  const end = seg.indexOf('<', start);
  if (end === -1) return null;
  const t = clean(seg.slice(start, Math.min(end, start + FIELD_MAX)));
  return t === '' ? null : t;
}

/** The `<h3>` texts of the card, the lone " - " separator left out. */
function headings(seg: string): string[] {
  const out: string[] = [];
  let p = 0;
  for (;;) {
    const open = seg.indexOf('<h3', p);
    if (open === -1) break;
    const gt = seg.indexOf('>', open);
    if (gt === -1) break;
    const close = seg.indexOf('</h3>', gt);
    if (close === -1) break;
    const t = clean(seg.slice(gt + 1, Math.min(close, gt + 1 + FIELD_MAX)));
    if (t !== '' && t !== '-') out.push(t);
    p = close + 5;
  }
  return out;
}

/** The more-info values in page order, the " | " separators left out; a hidden value is null. */
function moreInfo(seg: string): (string | null)[] {
  const mi = seg.indexOf('job-item_more-info');
  if (mi === -1) return [];
  const hide = seg.indexOf('class="hide"', mi);
  const end = hide === -1 ? seg.length : hide;
  const values: (string | null)[] = [];
  const tag = '<div class="text-inline';
  let p = mi;
  for (;;) {
    const open = seg.indexOf(tag, p);
    if (open === -1 || open >= end) break;
    const q = seg.indexOf('"', open + tag.length);
    const gt = q === -1 ? -1 : seg.indexOf('>', q);
    if (gt === -1) break;
    const hidden = seg.slice(open + tag.length, q).includes('w-condition-invisible');
    const lt = seg.indexOf('<', gt);
    const text = lt === -1 ? '' : clean(seg.slice(gt + 1, Math.min(lt, gt + 1 + FIELD_MAX)));
    p = gt + 1;
    if (text === '|') continue;
    values.push(hidden || text === '' ? null : text);
  }
  return values;
}

function hrefAfter(seg: string, marker: string): string | null {
  const at = seg.indexOf(marker);
  if (at === -1) return null;
  // The attribute order is the page's: `<a ... href="..." class="job-item_company-link ...">`, so the tag opens before the marker.
  const open = seg.lastIndexOf('<a ', at);
  if (open === -1) return null;
  const h = seg.indexOf('href="', open);
  if (h === -1 || h > at) return null;
  const start = h + 6;
  const end = seg.indexOf('"', start);
  const v = end === -1 ? '' : seg.slice(start, Math.min(end, start + 500));
  return v.startsWith('https://') ? v : null;
}

export function parseFractionalCards(html: string): { cards: FjCard[]; malformed: string[] } {
  const cards: FjCard[] = [];
  const malformed: string[] = [];
  let at = html.indexOf(CARD);
  let n = 0;
  while (at !== -1) {
    const from = at + CARD.length;
    const next = html.indexOf(CARD, from);
    const seg = html.slice(from, next === -1 ? Math.min(html.length, from + CARD_MAX_CHARS) : Math.min(next, from + CARD_MAX_CHARS));
    n += 1;
    const hs = headings(seg);
    const jobId = textAfter(seg, 'class="job-id">');
    const title = hs[1] ?? null;
    if (jobId === null || !JOB_ID.test(jobId) || title === null) {
      malformed.push(`card ${n}: missing job id or title`);
    } else {
      const info = moreInfo(seg);
      cards.push({
        jobId,
        company: hs[0] ?? null,
        title,
        companySite: hrefAfter(seg, 'job-item_company-link'),
        hours: info[0] ?? null,
        pay: info[1] ?? null,
        location: info[2] ?? null,
        function: textAfter(seg, 'fs-cmsfilter-field="function">'),
        date: textAfter(seg, 'class="date">'),
      });
    }
    at = next;
  }
  return { cards, malformed };
}

/** The run's view of the host: robots.txt once, and whether the host was disabled in this run. */
export interface FractionalJobsHosts {
  robots(): Robots | 'allow-all' | undefined;
  setRobots(v: Robots | 'allow-all'): void;
  disabledWhy(): string | undefined;
  disable(why: string): void;
}

/** Fresh host state for one run (the freelance wiring builds one per run, so nothing outlives it). */
export function fractionalJobsHosts(): FractionalJobsHosts {
  let robots: Robots | 'allow-all' | undefined;
  let disabled: string | undefined;
  return {
    robots: () => robots,
    setRobots: (v) => {
      robots = v;
    },
    disabledWhy: () => disabled,
    disable: (why) => {
      disabled ??= why;
    },
  };
}

export function srcFractionalJobsContract(): Contract<GigRequest, RawGig> {
  return defineContract({
    id: 'src-fractional-jobs',
    version: '1.0.0',
    description: 'Reads fractional roles from the Fractional Jobs public homepage, one page a run, robots-checked',
    skills: ['gig-sourcing'],
    // A team of its own: its breaker opens on its own failures only (pipeline.ts).
    team: 'sourcing-fractional-jobs',
    kind: 'io',
    consumes: GigRequest,
    produces: RawGig,
    capabilities: { http: true },
    egress: [FJ_HOST],
    dataClasses: { in: ['P0'], out: ['P0'] },
    budget: { usdPerCall: 0, usdPerRun: 0 },
    timeoutMs: SOURCE_TIMEOUT_MS,
    // Never `rate_limit`: a 429 disables the host for the run instead (no retry around a refusal).
    retry: { max: 2, on: ['overloaded', 'network', 'timeout'], backoffMs: [2000, 8000] },
  });
}

/** A refusal: the host is disabled for the run and the step fails with the named code. */
function refuse(hosts: FractionalJobsHosts, why: string, code: 'challenged' | 'rate_limit', detail: string): never {
  hosts.disable(why);
  throw new KernelError(code, `${FJ_HOST} ${detail}: the host is disabled for this run, never retried around`);
}

function checkStatus(hosts: FractionalJobsHosts, status: number, body: string, what: string): void {
  if (isChallenge(status, body)) refuse(hosts, 'challenge', 'challenged', `answered ${what} with a challenge page (${status})`);
  if (status === 429) refuse(hosts, 'http-429', 'rate_limit', `answered ${what} with 429`);
  if (status === 401 || status === 403) refuse(hosts, `http-${status}`, 'challenged', `answered ${what} with ${status}`);
  if (status >= 500) throw new KernelError('overloaded', `${FJ_HOST} answered ${what} with ${status}`);
}

export function makeSrcFractionalJobs(hosts: FractionalJobsHosts = fractionalJobsHosts()): Agent<GigRequest, RawGig> {
  return defineAgent(srcFractionalJobsContract(), async (req, ctx) => {
    if (req.platform !== 'fractional-jobs') return [];
    if (!ctx.http) throw new KernelError('policy_denied', 'no http capability issued');
    const http = ctx.http;
    const why = hosts.disabledWhy();
    if (why !== undefined) throw new KernelError('input_rejected', `host-disabled:${why} on ${FJ_HOST}; fractional-jobs deferred to the next run, never retried around`);
    let robots = hosts.robots();
    if (robots === undefined) {
      const r = await http.getPage(FJ_ROBOTS_URL, { minIntervalMs: FJ_MIN_INTERVAL_MS });
      checkStatus(hosts, r.status, r.body, 'its robots.txt');
      if (r.status >= 300 && r.status < 400) refuse(hosts, 'robots-unavailable', 'challenged', `redirected its robots.txt (${r.status})`);
      const v = robotsVerdictOf(r.status, r.body);
      if (v.kind === 'disallow-all') refuse(hosts, 'robots-unavailable', 'challenged', `answered its robots.txt with ${r.status}`);
      robots = v.kind === 'rules' ? v.robots : 'allow-all';
      hosts.setRobots(robots);
    }
    const u = new URL(FJ_HOME_URL);
    if (robots !== 'allow-all' && !robotsAllows(robots, u.pathname + u.search)) {
      ctx.skipped([`robots-disallow ${FJ_HOST}: fractional-jobs not read today (robots-disallow ${u.pathname})`]);
      return [];
    }
    const r = await http.getPage(FJ_HOME_URL, { minIntervalMs: FJ_MIN_INTERVAL_MS });
    checkStatus(hosts, r.status, r.body, 'the homepage');
    if (r.status === 404) throw new KernelError('gone', 'fractional-jobs homepage not found');
    if (r.status < 200 || r.status >= 300) throw new KernelError('invalid_output', `${FJ_HOST} returned ${r.status} for the homepage`);
    const bytes = Buffer.byteLength(r.body, 'utf8');
    if (bytes > FJ_MAX_BYTES) throw new KernelError('input_rejected', `fractional-jobs: the page is ${bytes} bytes, over the ${FJ_MAX_BYTES}-byte cap; nothing read`);
    const { cards, malformed } = parseFractionalCards(r.body);
    const total = cards.length + malformed.length;
    if (total > FJ_MAX_CARDS) throw new KernelError('input_rejected', `fractional-jobs: ${total} cards, over the ${FJ_MAX_CARDS}-card cap; nothing read`);
    if (total === 0 && hasChallengeMarker(r.body)) refuse(hosts, 'challenge', 'challenged', 'answered the homepage with a challenge page');
    if (total === 0) throw new KernelError('invalid_output', 'fractional-jobs: no role cards on the page (the markup changed?)');
    if (cards.length === 0) throw new KernelError('invalid_output', `fractional-jobs: all ${total} cards failed to parse`);
    const notes = malformed.map((m) => `fractional-jobs ${m}`);
    const kept = cards.filter((c) => c.function !== null && FJ_FUNCTIONS.includes(c.function));
    if (kept.length < cards.length) notes.push(`fractional-jobs: ${cards.length - kept.length} of ${cards.length} roles in other functions`);
    if (notes.length > 0) ctx.skipped(notes);
    return finishGigs(kept.map((c) => ({ platform: 'fractional-jobs' as const, sourceId: c.jobId, raw: { ...c } })));
  });
}

/** The agent for exports and tests; the run builds its own with fresh host state (`freelanceAgents`). */
export const srcFractionalJobs = makeSrcFractionalJobs();
