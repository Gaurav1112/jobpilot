import { refuseRealNetwork } from '../../kernel/no-network.js';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Agent } from '../../kernel/agent.js';
import { createHostPacer, freezePack, HTTP_HEADERS, issueContext, type HostPacer } from '../../kernel/broker.js';
import type { Clock } from '../../kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../kernel/policy.js';
import { nodeFetch, type FetchLike } from '../../kernel/providers.js';
import { ensureHome } from '../home.js';
import type { RunPack } from '../kernel.js';
import { loadRunPack } from '../kernel.js';
import { withLock } from '../lock.js';
import { packOf as scorerPackOf, scoreText } from '../agents/scorer-lexicon.js';
import { homePaths } from '../pack/paths.js';
import { istDate, istMonth } from '../run.js';
import { AppStore } from '../store/app-store.js';
import { hoursOutcome, locationOutcome } from './gig-eligibility.js';
import { gigNormalizer } from './gig-normalizer.js';
import { gigRisk } from './gig-risk.js';
import { gigScorer } from './gig-scorer.js';
import { isoWeek } from './health.js';
import { isoMs } from './rank.js';
import { rateNormalizer } from './rate.js';
import { gigEligibility } from './gig-eligibility.js';
import { mergeGigs } from './sources/common.js';
import { freelancerUrl, srcFreelancer } from './sources/freelancer.js';
import { srcHn } from './sources/hn.js';
import { srcRemotive } from './sources/remotive.js';
import type { Gig, GigRequest, RatedGig, RawGig, ScoredGig } from './types.js';

/**
 * `jobpilot sources probe` (spec §4.6): a live, read-only measurement of what each freelance source yields, scored by a
 * fixed formula so the user can see which sources are worth keeping. It never runs inside `verify` (only the CLI imports
 * this file, and the command asks the network).
 *
 * Kept sources (Freelancer.com, Remotive, HN freelancer, HN hiring) go through the REAL modules: the source agents'
 * parsing, `gig-normalizer`, `rate-normalizer`, `gig-eligibility` (the hours rule included), `gig-risk` and `gig-scorer`
 * with `pack.freelance.fitFloor`, so "relevant", "eligible" and "≥ floor" mean what a run would produce. Parked sources
 * (RemoteOK, We Work Remotely, Working Nomads, Golang Projects, Arbeitnow DE/UK) keep lightweight readers here; bounties
 * and Algora were dropped by the spec and are absent.
 *
 * Score = access + volume + India + pay, one decimal:
 *   access: ok 30, partial 22, key 20, email 10, failed 0
 *   volume: 30 · log(1 + relevant) / log(51), at most 30 (the spec's own table saturates it at 50 relevant gigs)
 *   India:  20 · (open + ½ · unknown) / relevant, from the real eligibility location result
 *   pay:    20 · (at or above the rate floor + ¼ · unknown) / relevant, from the real rate output
 * "Relevant" = fresh (14 days or undated), kind contract or gig, at least two strong or medium lexicon terms, and not
 * rejected by the hours rule. Polite: sequential, per-host pacing from `platform-rules.yaml`, the honest user-agent,
 * Remotive asked once. Each failed source adds one to `source_health.probe_failures` for the current ISO week.
 */

export type Access = 'ok' | 'partial' | 'key' | 'email' | 'failed';
export const ACCESS_POINTS: Readonly<Record<Access, number>> = { ok: 30, partial: 22, key: 20, email: 10, failed: 0 };

export const KEPT_IDS = ['freelancer', 'remotive', 'hn-freelancer', 'hn-hiring'] as const;
export const PARKED_IDS = ['arbeitnow', 'golangprojects', 'remoteok', 'workingnomads', 'wwr'] as const;
export const PROBE_SOURCE_IDS: readonly string[] = [...KEPT_IDS, ...PARKED_IDS];
const NAMES: Readonly<Record<string, string>> = {
  freelancer: 'Freelancer.com',
  remotive: 'Remotive',
  'hn-freelancer': 'HN Freelancer? Seeking freelancer?',
  'hn-hiring': 'HN Who is hiring? (contract)',
  arbeitnow: 'Arbeitnow DE/UK',
  golangprojects: 'Golang Projects',
  remoteok: 'RemoteOK',
  workingnomads: 'Working Nomads',
  wwr: 'We Work Remotely',
};

const FRESH_DAYS = 14;
const DAY_MS = 86_400_000;
const PARKED_INTERVAL_MS = 1500;
const KEPT_STEP_MS = 90_000;
/** A parked source is promoted when its relevant count is at least this in two consecutive monthly probes. */
export const PROMOTE_RELEVANT = 5;
const HISTORY_KEY = 'probe.history';

/* ------------------------------------------------------------------ the score */

export interface ScoreInput {
  readonly relevant: number;
  readonly indiaOpen: number;
  readonly indiaUnknown: number;
  readonly payKnown: number;
  readonly payOk: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The §4.6 score, to one decimal. With nothing relevant only the access points count. */
export function probeScore(access: Access, m: ScoreInput): number {
  const base = ACCESS_POINTS[access];
  if (m.relevant <= 0) return round1(base);
  const volume = Math.min(30, (30 * Math.log(1 + m.relevant)) / Math.log(51));
  const india = (20 * (m.indiaOpen + 0.5 * m.indiaUnknown)) / m.relevant;
  const pay = (20 * (m.payOk + 0.25 * (m.relevant - m.payKnown))) / m.relevant;
  return round1(base + volume + india + pay);
}

/* ------------------------------------------------------------------ kept sources: the real chain */

export interface GigOutcome {
  readonly gig: Gig;
  readonly rate: RatedGig['rate'];
  readonly verdict: 'eligible' | 'review' | 'rejected';
  readonly reasons: readonly string[];
  /** The scorer's fit, null for a rejected gig (the scorer returns nothing for it). */
  readonly fit: number | null;
  /** Distinct strong plus medium lexicon terms in the gig, counted as the scorer reads it. */
  readonly skills: number;
  readonly hoursRejected: boolean;
  readonly india: 'open' | 'unknown' | 'closed';
}

const refuse: FetchLike = async () => {
  throw new Error('offline: the chain makes no request');
};

/** Runs one agent with a context whose only door to the world is closed. */
async function once<I, O>(agent: Agent<I, O>, input: I, loaded: RunPack, clock: Clock): Promise<readonly O[]> {
  const ctx = issueContext({
    contract: agent.contract,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: { fetch: refuse },
    clock,
    signal: new AbortController().signal,
    pack: freezePack(loaded.publicPack),
  });
  return agent.run(input, ctx);
}

/**
 * Raw gigs through the real normalizer, rate normalizer, eligibility, risk and scorer. A raw the normalizer refuses is
 * left out (a source that cannot be parsed is the source agent's failure, not a measurement). Order follows the input.
 */
export async function judgeGigs(raws: readonly RawGig[], loaded: RunPack, clock: Clock): Promise<GigOutcome[]> {
  return (await judgeGigsCounted(raws, loaded, clock)).outcomes;
}

/** Like `judgeGigs`, and also counts the raws the normalizer refused (never dropped silently). */
export async function judgeGigsCounted(raws: readonly RawGig[], loaded: RunPack, clock: Clock): Promise<{ outcomes: GigOutcome[]; rejectedByNormalizer: number }> {
  let rejectedByNormalizer = 0;
  const rules = loaded.pack.freelance;
  const scorerPack = scorerPackOf(loaded.publicPack);
  const out: GigOutcome[] = [];
  for (const r of raws) {
    let gig: Gig | undefined;
    try {
      gig = (await once(gigNormalizer, r, loaded, clock))[0];
    } catch {
      rejectedByNormalizer += 1;
      continue;
    }
    if (gig === undefined) continue;
    const rated = (await once(rateNormalizer, gig, loaded, clock))[0];
    if (rated === undefined) continue;
    const verdict = (await once(gigEligibility, rated, loaded, clock))[0];
    if (verdict === undefined) continue;
    const risked = (await once(gigRisk, verdict, loaded, clock))[0];
    if (risked === undefined) continue;
    const scored: ScoredGig | undefined = (await once(gigScorer, risked, loaded, clock))[0];
    const text = gig.skills.length === 0 ? gig.description : `${gig.description}\n${gig.skills.join(', ')}`;
    const terms = scoreText(gig.title, text, null, scorerPack).jdTerms;
    const where = locationOutcome(gig);
    out.push({
      gig,
      rate: rated.rate,
      verdict: verdict.verdict,
      reasons: verdict.reasons,
      fit: scored?.fit ?? null,
      skills: terms.strong.length + terms.medium.length,
      hoursRejected: hoursOutcome(gig, rules.maxHoursPerWeek).reject !== null,
      india: where.reject !== null ? 'closed' : where.review !== null ? 'unknown' : 'open',
    });
  }
  return { outcomes: out, rejectedByNormalizer };
}

export interface Tally extends ScoreInput {
  readonly items: number;
  readonly fresh: number;
  readonly skillMatched: number;
  readonly fullTimeExcluded: number;
  readonly eligible: number;
  readonly review: number;
  readonly aboveFloor: number;
}

/** The counts of the table for judged gigs. `payFloor` is `rateFloorUsdHour`. */
export function tallyGigs(outcomes: readonly GigOutcome[], o: { readonly now: string; readonly fitFloor: number; readonly payFloor?: number }): Tally {
  const now = Date.parse(o.now);
  const payFloor = o.payFloor ?? 40;
  const fresh = outcomes.filter((x) => {
    const at = isoMs(x.gig.postedAt);
    return at === null || now - at <= FRESH_DAYS * DAY_MS;
  });
  const skilled = fresh.filter((x) => (x.gig.kind === 'contract' || x.gig.kind === 'gig') && x.skills >= 2);
  const rel = skilled.filter((x) => !x.hoursRejected);
  const known = rel.filter((x) => x.rate.maxUsdH !== null);
  return {
    items: outcomes.length,
    fresh: fresh.length,
    skillMatched: skilled.length,
    relevant: rel.length,
    fullTimeExcluded: skilled.length - rel.length,
    eligible: rel.filter((x) => x.verdict === 'eligible').length,
    review: rel.filter((x) => x.verdict === 'review').length,
    aboveFloor: rel.filter((x) => x.verdict !== 'rejected' && x.fit !== null && x.fit >= o.fitFloor).length,
    indiaOpen: rel.filter((x) => x.india === 'open').length,
    indiaUnknown: rel.filter((x) => x.india === 'unknown').length,
    payKnown: known.length,
    payOk: known.filter((x) => (x.rate.maxUsdH ?? 0) >= payFloor).length,
  };
}

/* ------------------------------------------------------------------ parked sources: lightweight readers */

type ParkedKind = 'contract' | 'freelance' | 'part-time' | 'full-time' | 'unknown';
export interface ParkedItem {
  readonly title: string;
  readonly text: string;
  readonly kind: ParkedKind;
  readonly location: string | null;
  readonly postedAt: number | null;
  readonly usdHourMax: number | null;
  /** The pay was an annual figure divided by 2080: a salary, so the role is taken as full-time. */
  readonly annual: boolean;
}

const stripHtml = (s: string): string =>
  s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/g, '/').replace(/\s+/g, ' ').trim();
const KIND_RE = /\b(contract(?:or)?|freelanc(?:e|er|ing)|part[- ]time|hourly)\b/i;
function kindFromText(s: string): ParkedKind {
  const m = KIND_RE.exec(s)?.[1]?.toLowerCase();
  if (m === undefined) return 'unknown';
  return m.startsWith('contract') || m === 'hourly' ? 'contract' : m.startsWith('freelanc') ? 'freelance' : 'part-time';
}
/** Rough fixed conversions: parked sources are only ever ranked by them, never shortlisted. */
const FX: Readonly<Record<string, number>> = { $: 1, '€': 1.12, '£': 1.32, '₹': 0.0103 };
function payFromText(s: string): { usdHourMax: number | null; annual: boolean } {
  const h = /([$€£₹])\s?(\d{2,3}(?:\.\d+)?)(?:\s?(?:-|–|to)\s?[$€£₹]?\s?(\d{2,3}(?:\.\d+)?))?\s?(?:\/\s?|per\s|an\s)(?:h\b|hr\b|hrs\b|hour)/i.exec(s);
  if (h !== null) return { usdHourMax: Number(h[3] ?? h[2]) * (FX[h[1] as string] ?? 1), annual: false };
  const y = /([$€£₹])\s?(\d{2,3})(?:[,.](\d{3}))?\s?(k)?(?:\s?(?:-|–|to)\s?[$€£₹]?\s?(\d{2,3})(?:[,.](\d{3}))?\s?(k)?)?\s?(?:\/\s?(?:yr|year)|per\s(?:year|annum)|annual|a\syear|\s?(?:USD|EUR|GBP)?\s?(?:base|salary|OTE))/i.exec(s);
  if (y !== null && (y[3] !== undefined || y[4] !== undefined)) {
    const top = Number(y[5] ?? y[2]) * 1000 * (FX[y[1] as string] ?? 1);
    if (top >= 10_000) return { usdHourMax: top / 2080, annual: true };
  }
  return { usdHourMax: null, annual: false };
}
const OPEN_RE = /\b(india|worldwide|anywhere|global(?:ly)?|apac|asia|international|remote\s*-\s*any)\b/i;
const CLOSED_HINT = /\b(us only|usa only|united states|u\.s\.|canada|uk only|united kingdom|europe|eu only|emea|germany|latam|north america|americas|brazil|mexico|est\b|pst\b|cet\b|us\/canada|usa)\b/i;
function parkedIndia(it: ParkedItem): 'open' | 'closed' | 'unknown' {
  const loc = (it.location ?? '').trim();
  if (OPEN_RE.test(loc)) return 'open';
  if (loc !== '' && CLOSED_HINT.test(loc)) return 'closed';
  if (loc !== '') return /remote/i.test(loc) && loc.length <= 8 ? 'unknown' : 'closed';
  return OPEN_RE.test(it.text.slice(0, 3000)) ? 'open' : 'unknown';
}
/** The hours rule on a parked item: a stated part-time or short week keeps it, full-time wording or a salary drops it. */
function parkedFullTime(it: ParkedItem): boolean {
  const t = it.text.slice(0, 6000);
  if (/\bpart[- ]time\b|\b(?:5|10|15|20)(?:\s?-\s?\d{1,2})?\s?(?:h|hrs|hours)\s?(?:\/|per|a)\s?(?:week|wk)\b/i.test(t)) return false;
  return /\bfull[- ]time\b|\b(?:35|40)\+?\s?(?:h|hrs|hours)\b|\bdedicated\b|\bcontract type:\s*b2b\b/i.test(t) || it.annual;
}

const item = (title: string, body: string, kind: ParkedKind, location: string | null, postedAt: number | null, pay: { usdHourMax: number | null; annual: boolean }): ParkedItem => ({
  title, text: `${title} ${body}`, kind, location, postedAt, ...pay,
});
const dateMs = (v: unknown): number | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function rssItems(xml: string): { title: string; link: string; description: string; pubDate: string; region: string | null; type: string | null }[] {
  const tag = (s: string, t: string): string | null => {
    const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i').exec(s);
    return m?.[1] === undefined ? null : m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
  };
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => ({
    title: stripHtml(tag(m[1] ?? '', 'title') ?? ''), link: tag(m[1] ?? '', 'link') ?? '', description: stripHtml(tag(m[1] ?? '', 'description') ?? ''),
    pubDate: tag(m[1] ?? '', 'pubDate') ?? '', region: tag(m[1] ?? '', 'region'), type: tag(m[1] ?? '', 'type'),
  }));
}

export function readRemoteOk(body: string): ParkedItem[] {
  const json: unknown = JSON.parse(body);
  if (!Array.isArray(json)) throw new Error('not an array');
  return json.slice(1).map((j: unknown) => {
    const o = rec(j);
    const tags = (Array.isArray(o['tags']) ? o['tags'] : []).map((t) => str(t).toLowerCase());
    const text = `${str(o['description'])}`;
    const kind: ParkedKind = tags.includes('contract') || tags.includes('contractor') ? 'contract' : tags.includes('freelance') ? 'freelance' : tags.includes('part time') || tags.includes('part-time') ? 'part-time' : kindFromText(str(o['position']));
    const min = typeof o['salary_min'] === 'number' && o['salary_min'] > 0 ? o['salary_min'] : null;
    const max = typeof o['salary_max'] === 'number' && o['salary_max'] > 0 ? o['salary_max'] : min;
    const pay = min !== null && max !== null ? { usdHourMax: max / 2080, annual: true } : payFromText(stripHtml(text).slice(0, 4000));
    return item(str(o['position']), `${stripHtml(text)} ${tags.join(' ')}`, kind, str(o['location']) || null, typeof o['epoch'] === 'number' ? o['epoch'] * 1000 : null, pay);
  });
}

export function readWwr(xml: string): ParkedItem[] {
  return rssItems(xml).map((it) => {
    const text = `${it.title} ${it.description}`;
    const kind: ParkedKind = it.type !== null ? (/contract/i.test(it.type) ? 'contract' : /part/i.test(it.type) ? 'part-time' : /full/i.test(it.type) ? 'full-time' : kindFromText(text.slice(0, 600))) : kindFromText(text.slice(0, 600));
    return item(it.title, it.description, kind, it.region, dateMs(it.pubDate), payFromText(text.slice(0, 4000)));
  });
}

export function readWorkingNomads(body: string): ParkedItem[] {
  const json: unknown = JSON.parse(body);
  if (!Array.isArray(json)) throw new Error('not an array');
  return json.map((j: unknown) => {
    const o = rec(j);
    const body2 = `${stripHtml(str(o['description']))} ${str(o['tags'])}`;
    return item(str(o['title']), body2, kindFromText(`${str(o['title'])} ${str(o['tags'])}`), str(o['location']) || null, dateMs(o['pub_date']), payFromText(`${str(o['title'])} ${body2}`.slice(0, 4000)));
  });
}

export function readGolangProjects(xml: string): ParkedItem[] {
  const items = rssItems(xml);
  if (items.length === 0) throw new Error('no <item> in the feed');
  return items.map((it) => {
    const text = `Golang ${it.title} ${it.description}`;
    return item(`Golang ${it.title}`, it.description, kindFromText(text.slice(0, 600)), /remote/i.test(it.title) ? it.title : null, dateMs(it.pubDate), payFromText(text));
  });
}

export function readArbeitnow(body: string): ParkedItem[] {
  const json = rec(JSON.parse(body));
  const data = Array.isArray(json['data']) ? json['data'] : [];
  return data.map((j: unknown) => {
    const o = rec(j);
    const types = (Array.isArray(o['job_types']) ? o['job_types'] : []).map(str).join(' ');
    const text = `${str(o['title'])} ${stripHtml(str(o['description']))} ${(Array.isArray(o['tags']) ? o['tags'] : []).map(str).join(' ')}`;
    const kind: ParkedKind = /contract|freelance/i.test(types) ? kindFromText(types) : /part/i.test(types) ? 'part-time' : /full/i.test(types) ? 'full-time' : kindFromText(str(o['title']));
    const loc = o['remote'] === true ? `remote; ${str(o['location'])}` : `onsite ${str(o['location'])}`;
    return item(str(o['title']), text, kind, loc, typeof o['created_at'] === 'number' ? o['created_at'] * 1000 : null, payFromText(text.slice(0, 4000)));
  });
}

/** The table counts of a parked source's items, under the same relevance rules (lexicon via the real scorer's `scoreText`). */
export function tallyParked(items: readonly ParkedItem[], o: { readonly now: string; readonly loaded: RunPack }): Tally {
  const now = Date.parse(o.now);
  const pack = scorerPackOf(o.loaded.publicPack);
  const payFloor = o.loaded.pack.freelance.rateFloorUsdHour;
  const fresh = items.filter((x) => x.postedAt === null || now - x.postedAt <= FRESH_DAYS * DAY_MS);
  const skilled = fresh.filter((x) => {
    if (x.kind !== 'contract' && x.kind !== 'freelance' && x.kind !== 'part-time') return false;
    const t = scoreText(x.title, x.text, null, pack).jdTerms;
    return t.strong.length + t.medium.length >= 2;
  });
  const rel = skilled.filter((x) => !parkedFullTime(x));
  const known = rel.filter((x) => x.usdHourMax !== null);
  return {
    items: items.length,
    fresh: fresh.length,
    skillMatched: skilled.length,
    relevant: rel.length,
    fullTimeExcluded: skilled.length - rel.length,
    eligible: 0,
    review: 0,
    aboveFloor: 0,
    indiaOpen: rel.filter((x) => parkedIndia(x) === 'open').length,
    indiaUnknown: rel.filter((x) => parkedIndia(x) === 'unknown').length,
    payKnown: known.length,
    payOk: known.filter((x) => (x.usdHourMax ?? 0) >= payFloor).length,
  };
}

/* ------------------------------------------------------------------ promote rule */

export type ProbeHistory = Readonly<Record<string, Readonly<Record<string, number>>>>;

const previousMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/** True when the source's relevant count is at least PROMOTE_RELEVANT in `month` and in the month before it. */
export function promoteDue(history: ProbeHistory, id: string, month: string): boolean {
  const h = history[id] ?? {};
  const now = h[month];
  const before = h[previousMonth(month)];
  return now !== undefined && before !== undefined && now >= PROMOTE_RELEVANT && before >= PROMOTE_RELEVANT;
}

function readHistory(app: AppStore): Record<string, Record<string, number>> {
  const raw = app.getSetting(HISTORY_KEY);
  if (raw === undefined) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, Record<string, number>>) : {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ record + guard */

/** The real path of `p`: the nearest existing ancestor is resolved through symlinks, the rest is re-appended. */
function realish(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur) && dirname(cur) !== cur) {
    rest.unshift(basename(cur));
    cur = dirname(cur);
  }
  let real = cur;
  try {
    real = realpathSync(cur);
  } catch {
    // an unreadable ancestor: compare the lexical path
  }
  return join(real, ...rest);
}

const inside = (path: string, base: string): boolean => {
  const r = relative(realish(base), realish(path));
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};

/** Refuses a record folder inside ~/.jobpilot, the active jobpilot home or the repo's tests/ (symlinks resolved), unless `force`. */
export function assertRecordDir(dir: string, o: { readonly home: string; readonly repoRoot: string; readonly force: boolean }): void {
  if (o.force) return;
  if (inside(dir, join(homedir(), '.jobpilot'))) throw new Error(`refusing to record inside ~/.jobpilot (${dir}); pick another folder or pass --force`);
  if (inside(dir, o.home)) throw new Error(`refusing to record inside the jobpilot home (${o.home}); pick another folder or pass --force`);
  if (inside(dir, join(o.repoRoot, 'tests'))) throw new Error(`refusing to record inside the repo's tests/ folder (${dir}); copy trimmed fixtures there by hand, or pass --force`);
}

/** A recorder that writes each raw response into `dir` (created on first use). */
export function fileRecorder(dir: string): (name: string, text: string) => void {
  return (name, text) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), text);
  };
}

/** `<host>__<path>` as a file name, `.xml` for a feed, else `.json`. */
function recordName(url: string, text: string, taken: Set<string>): string {
  const u = new URL(url);
  const slug = `${u.hostname.replace(/^www\./, '')}${u.pathname}${u.search}`.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 110);
  const ext = text.trimStart().startsWith('<') ? 'xml' : 'json';
  let name = `${slug}.${ext}`;
  for (let n = 2; taken.has(name); n++) name = `${slug}-${n}.${ext}`;
  taken.add(name);
  return name;
}

/* ------------------------------------------------------------------ the probe */

export type ParkedGet = (url: string) => Promise<{ readonly status: number; readonly text: string }>;

export interface ProbeDeps {
  readonly loaded: RunPack;
  readonly app: AppStore;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  /** The kept sources' door (the broker adds the honest user-agent, pacing and the egress check). */
  readonly fetch: FetchLike;
  /** The parked readers' door. */
  readonly get: ParkedGet;
  /** Receives every raw response as a fixture candidate. */
  readonly record?: (name: string, text: string) => void;
}

export interface ProbeRow extends Tally {
  readonly id: string;
  readonly name: string;
  readonly kept: boolean;
  readonly access: Access;
  readonly requests: number;
  readonly errors: readonly string[];
  readonly notes: readonly string[];
  /** Raw gigs the real normalizer refused (counted, not dropped silently). */
  readonly rejectedByNormalizer: number;
  readonly score: number;
  readonly verdict: string;
}

export interface ProbeReport {
  readonly at: string;
  readonly week: string;
  readonly month: string;
  readonly rows: readonly ProbeRow[];
  readonly promote: readonly string[];
}

const EMPTY: Tally = { items: 0, fresh: 0, skillMatched: 0, relevant: 0, fullTimeExcluded: 0, eligible: 0, review: 0, aboveFloor: 0, indiaOpen: 0, indiaUnknown: 0, payKnown: 0, payOk: 0 };

const accessOf = (requests: number, errors: number): Access => (requests === 0 || errors >= requests ? 'failed' : errors > 0 ? 'partial' : 'ok');
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runProbe(d: ProbeDeps): Promise<ProbeReport> {
  const at = d.clock.now();
  const runDate = istDate(at);
  const month = istMonth(at);
  const week = isoWeek(runDate);
  const rules = d.loaded.pack.freelance;
  const taken = new Set<string>();
  const record = (url: string, text: string): void => d.record?.(recordName(url, text, taken), text);

  const pacers = new Map<number, HostPacer>();
  const pacer = (ms: number): HostPacer => {
    const p = pacers.get(ms) ?? createHostPacer(ms, d.clock, d.sleep);
    pacers.set(ms, p);
    return p;
  };
  const recording: FetchLike = async (url, init) => {
    const res = await d.fetch(url, init);
    const text = await res.text();
    record(url, text);
    return { status: res.status, text: async () => text };
  };

  // One kept source agent call (one request id) with the real broker door, pacing and honest headers.
  async function callAgent<I extends GigRequest>(agent: Agent<I, RawGig>, req: I, platform: keyof typeof rulesInterval): Promise<readonly RawGig[]> {
    const ctx = issueContext({
      contract: agent.contract,
      policy: PRODUCT_POLICY_V1,
      inputClass: 'P0',
      providers: { fetch: recording },
      clock: d.clock,
      signal: AbortSignal.timeout(KEPT_STEP_MS),
      hostPacer: pacer(rulesInterval[platform]),
    });
    const gigs = await agent.run(req, ctx);
    keptSkips.push(...ctx.skips());
    return gigs;
  }
  const rulesInterval = {
    freelancer: d.loaded.pack.platformRules.freelancer.minIntervalMs,
    remotive: d.loaded.pack.platformRules.remotive.minIntervalMs,
    'hn-freelancer': d.loaded.pack.platformRules['hn-freelancer'].minIntervalMs,
    'hn-hiring': d.loaded.pack.platformRules['hn-hiring'].minIntervalMs,
  };
  const keptSkips: string[] = [];

  interface Raw {
    readonly id: string;
    requests: number;
    readonly errors: string[];
    readonly gigs: RawGig[];
    readonly notes: string[];
  }
  const kept: Raw[] = [];
  const at0 = { runDate, half: 'am' as const };

  // Freelancer.com: one request per pack query, merged by id.
  {
    const r: Raw = { id: 'freelancer', requests: 0, errors: [], gigs: [], notes: [] };
    const batches: RawGig[][] = [];
    for (const query of [...new Set(rules.platforms.freelancer.queries)]) {
      r.requests += 1;
      try {
        batches.push([...(await callAgent(srcFreelancer, { platform: 'freelancer', query, ...at0 }, 'freelancer'))]);
      } catch (e) {
        r.errors.push(`${query}: ${errText(e)} (${freelancerUrl(query)})`);
      }
    }
    r.gigs.push(...mergeGigs(batches));
    kept.push(r);
  }
  // Remotive: exactly one request in the whole run.
  {
    const r: Raw = { id: 'remotive', requests: 1, errors: [], gigs: [], notes: [] };
    try {
      r.gigs.push(...(await callAgent(srcRemotive, { platform: 'remotive', query: '', ...at0 }, 'remotive')));
    } catch (e) {
      r.errors.push(errText(e));
    }
    kept.push(r);
  }
  for (const platform of ['hn-freelancer', 'hn-hiring'] as const) {
    const r: Raw = { id: platform, requests: 1, errors: [], gigs: [], notes: [] };
    const before = keptSkips.length;
    try {
      r.gigs.push(...(await callAgent(srcHn, { platform, query: '', ...at0 }, platform)));
    } catch (e) {
      r.errors.push(errText(e));
    }
    r.notes.push(...keptSkips.slice(before));
    kept.push(r);
  }

  const rows: ProbeRow[] = [];
  for (const r of kept) {
    const access = accessOf(r.requests, r.errors.length);
    const judged = await judgeGigsCounted(r.gigs, d.loaded, d.clock);
    const tally = r.gigs.length === 0 ? EMPTY : tallyGigs(judged.outcomes, { now: at, fitFloor: rules.fitFloor, payFloor: rules.rateFloorUsdHour });
    rows.push({ id: r.id, name: NAMES[r.id] ?? r.id, kept: true, access, requests: r.requests, errors: r.errors, notes: r.notes, rejectedByNormalizer: judged.rejectedByNormalizer, ...tally, items: Math.max(tally.items, r.gigs.length), score: probeScore(access, tally), verdict: access === 'failed' ? 'keep (failed this probe)' : 'keep' });
  }

  // Parked sources: one lightweight reader each, sequential and paced.
  const parkedPacer = pacer(PARKED_INTERVAL_MS);
  async function fetchText(url: string): Promise<string> {
    await parkedPacer.wait(new URL(url).hostname);
    const res = await d.get(url);
    record(url, res.text);
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    return res.text;
  }
  const parked: { id: string; urls: string[]; read: (body: string) => ParkedItem[] }[] = [
    { id: 'remoteok', urls: ['https://remoteok.com/api'], read: readRemoteOk },
    { id: 'wwr', urls: ['remote-programming-jobs', 'remote-back-end-programming-jobs', 'remote-full-stack-programming-jobs', 'remote-devops-sysadmin-jobs'].map((c) => `https://weworkremotely.com/categories/${c}.rss`), read: readWwr },
    { id: 'workingnomads', urls: ['https://www.workingnomads.com/api/exposed_jobs/'], read: readWorkingNomads },
    { id: 'golangprojects', urls: ['https://www.golangprojects.com/rss.xml'], read: readGolangProjects },
    { id: 'arbeitnow', urls: ['https://www.arbeitnow.com/api/job-board-api', 'https://www.arbeitnow.co.uk/api/job-board-api'], read: readArbeitnow },
  ];
  const history = readHistory(d.app);
  for (const p of parked) {
    const errors: string[] = [];
    const items: ParkedItem[] = [];
    for (const url of p.urls) {
      try {
        items.push(...p.read(await fetchText(url)));
      } catch (e) {
        errors.push(`${new URL(url).hostname}: ${errText(e)}`);
      }
    }
    const access = accessOf(p.urls.length, errors.length);
    const tally = tallyParked(items, { now: at, loaded: d.loaded });
    if (access !== 'failed') history[p.id] = { ...(history[p.id] ?? {}), [month]: tally.relevant };
    rows.push({ id: p.id, name: NAMES[p.id] ?? p.id, kept: false, access, requests: p.urls.length, errors, notes: [], rejectedByNormalizer: 0, ...tally, score: probeScore(access, tally), verdict: 'park' });
  }
  d.app.setSetting(HISTORY_KEY, JSON.stringify(history));

  const promote = rows.filter((r) => !r.kept && promoteDue(history, r.id, month)).map((r) => r.id);
  const final = rows
    .map((r) => (promote.includes(r.id) ? { ...r, verdict: 'promote: add an adapter' } : r))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  // A failed source is a probe failure for this ISO week; nothing is removed or promoted by it.
  for (const r of final) if (r.access === 'failed') d.app.addProbeFailure(r.id, week);
  return { at, week, month, rows: final, promote };
}

/* ------------------------------------------------------------------ output */

const HEAD = ['Source', 'Score', 'Skill-matched', 'Relevant (hours ok)', 'Pass all rules', 'Review', '≥ floor', 'Verdict'] as const;

/** The §4.6 table, plus a ≥ floor column, as aligned text; then each source's errors. */
export function formatProbeTable(report: ProbeReport): string {
  const dash = (r: ProbeRow, n: number): string => (r.kept ? String(n) : '-');
  const body = report.rows.map((r) => [
    r.name,
    r.score.toFixed(1),
    String(r.skillMatched),
    r.fullTimeExcluded > 0 ? `${r.relevant} (${r.fullTimeExcluded} full-time excluded)` : String(r.relevant),
    dash(r, r.eligible),
    dash(r, r.review),
    dash(r, r.aboveFloor),
    r.verdict,
  ]);
  const w = HEAD.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] as string).length)));
  const line = (cells: readonly string[]): string => cells.map((c, i) => c.padEnd(w[i] as number)).join('  ').trimEnd();
  const lines = [`sources probe ${report.at} (week ${report.week})`, line(HEAD), line(w.map((n) => '-'.repeat(n))), ...body.map(line)];
  for (const r of report.rows) {
    if (r.access !== 'ok') lines.push(`${r.name}: access ${r.access}`);
    for (const e of r.errors) lines.push(`  ${r.id}: ${e}`);
    for (const n of r.notes) lines.push(`  ${r.id}: ${n}`);
    if (r.rejectedByNormalizer > 0) lines.push(`  ${r.id}: ${r.rejectedByNormalizer} raw gig(s) refused by the normalizer`);
  }
  if (report.promote.length > 0) lines.push(`promote (add an adapter, a code change; nothing is promoted automatically): ${report.promote.join(', ')}`);
  return lines.join('\n');
}

export interface ProbeCommandOptions {
  readonly home: string;
  readonly repoRoot: string;
  readonly json: boolean;
  readonly record?: string;
  readonly force: boolean;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  readonly fetch?: FetchLike;
  readonly get?: ParkedGet;
  readonly out: (line: string) => void;
}

/** The parked readers' real door: the honest user-agent, redirects followed, 45 s timeout. */
export const liveGet: ParkedGet = async (url) => {
  refuseRealNetwork(url);
  const res = await fetch(url, { headers: { ...HTTP_HEADERS, accept: 'application/json, application/rss+xml, application/xml, */*;q=0.1' }, signal: AbortSignal.timeout(45_000), redirect: 'follow' });
  return { status: res.status, text: await res.text() };
};

/**
 * `jobpilot sources probe [--json] [--record <dir>] [--force]`. Returns the exit code (0). Under the run lock (final
 * review M9), like every command that writes the DB: it records probe failures in source health, so it never writes
 * while a run is running (a held lock is a `LockError`).
 */
export async function probeCommand(o: ProbeCommandOptions): Promise<number> {
  if (o.record !== undefined) assertRecordDir(o.record, { home: o.home, repoRoot: o.repoRoot, force: o.force });
  return withLock(o.home, 'sources probe', async () => {
    const paths = homePaths(o.home);
    ensureHome(paths.home);
    const loaded = loadRunPack(paths.pack, {}, istMonth(o.clock.now()), undefined, 'freelance');
    const app = AppStore.open(paths.db);
    try {
      const report = await runProbe({
        loaded, app, clock: o.clock, sleep: o.sleep, fetch: o.fetch ?? nodeFetch, get: o.get ?? liveGet,
        ...(o.record !== undefined ? { record: fileRecorder(resolve(o.record)) } : {}),
      });
      o.out(o.json ? JSON.stringify(report, null, 2) : formatProbeTable(report));
      return 0;
    } finally {
      app.close();
    }
  });
}
