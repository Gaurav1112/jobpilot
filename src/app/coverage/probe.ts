import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Clock } from '../../kernel/clock.js';
import { PLATFORM_NOTE_PREFIXES, residenceSkipLabel } from '../agents/sources/platforms/shared.js';
import { eightfoldMaxRequests } from '../agents/sources/platforms/eightfold.js';
import { FEED_MAX_REQUESTS } from '../agents/sources/platforms/feed-board.js';
import { ORACLE_MAX_PAGES } from '../agents/sources/platforms/oracle.js';
import { PAGE_LEDGER_PREFIX, PAGE_MAX_FETCHES } from '../agents/sources/platforms/pages.js';
import { SMALL_PLATFORM_NAMES } from '../agents/sources/platforms/small.js';
import { WORKDAY_MAX_REQUESTS } from '../agents/sources/platforms/workday.js';
import { ensureHome } from '../home.js';
import { loadRunPack } from '../kernel.js';
import { withLock } from '../lock.js';
import { homePaths } from '../pack/paths.js';
import { registryBoards } from '../pipeline.js';
import { safeLine } from '../problems.js';
import { istDate, istMonth, leadsSince } from '../run.js';
import { AppStore } from '../store/app-store.js';
import { coverageWeek } from '../due.js';
import { CATALOGUE_SEED, loadCatalogue, boardKey, type CatalogueEntry } from './catalogue.js';

/**
 * `jobpilot coverage probe` (spec §7): what the career-site coverage adds, read from the DB alone (no network, nothing
 * written). It takes the run lock so it never reads while a run is writing.
 *
 * - **Companies**: the registry by status and platform, and the companies the latest coverage run of this coverage week
 *   deferred (a disabled host; they are not in the registry, so only a count and the stages are known).
 * - **New jobs**: visible primary job rows (not duplicates) first seen inside the window whose source is a platform
 *   adapter (Workday, Eightfold, Oracle, iCIMS, SuccessFactors, SmartRecruiters, jsonld-sitemap, the nine small
 *   platforms, and Greenhouse, Lever or Ashby for a board that is NOT on the watchlist) and that have NO duplicate row
 *   from an existing source (the watchlist's ATS boards, feeds, company pages): the number that decides whether each
 *   platform adapter earns its place. "Passes the rules" = eligible, or review with a score at or above the pack's
 *   `targets.minFit`, from the stored verdict and score. A Greenhouse, Lever or Ashby row whose board cannot be told
 *   (no ATS id stored) counts as an existing source, never as new.
 * - **Per platform**: today's requests against the budget (the page ledgers where they exist: Oracle list pages and the
 *   page adapters' job pages, per board; otherwise the boards the latest daily run read against the registry's boards),
 *   and the latest daily run's problems and named skips with their reasons.
 */

export const PROBE_VERSION = 1;
export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 90;

/** Statuses in the order the table prints them (`failed`: a candidate that never verified). */
export const COMPANY_STATUS_ORDER = ['verified', 'proposed', 'failing', 'rejected', 'failed'] as const;

const REGISTRY_ONLY = ['workday', 'eightfold', 'oracle', 'icims', 'successfactors', 'smartrecruiters', 'jsonld-sitemap', ...SMALL_PLATFORM_NAMES] as const;
const API_BOARDS = ['greenhouse', 'lever', 'ashby'] as const;
/** Every platform the probe reports, in the order it prints them. */
export const PROBE_PLATFORMS: readonly string[] = [...REGISTRY_ONLY, ...API_BOARDS];
const PLATFORM_ONLY: ReadonlySet<string> = new Set(REGISTRY_ONLY);
const API_BOARD_SET: ReadonlySet<string> = new Set(API_BOARDS);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The IST date `n` days before `day`. */
function daysBefore(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

export interface PlatformJobs {
  readonly platform: string;
  readonly found: number;
  readonly passing: number;
}

export interface NewJob {
  readonly platform: string;
  readonly company: string;
  readonly title: string;
  readonly verdict: string | null;
  readonly fit: number | null;
  readonly passes: boolean;
}

export interface ProblemCount {
  readonly reason: string;
  readonly count: number;
  /** One example line, redacted. */
  readonly example: string;
}

export interface RequestUse {
  /** `ledger`: counted requests (pages) from the day's page ledger; `boards`: boards the latest daily run read; `none`: no board. */
  readonly kind: 'ledger' | 'boards' | 'none';
  readonly unit: 'pages' | 'boards';
  readonly used: number;
  readonly budget: number;
  /** The registry's boards on this platform. */
  readonly boards: number;
  /** The most requests one board may cost in a run, where the adapter states it; else null. */
  readonly perBoardRequestCap: number | null;
}

export interface PlatformReport {
  readonly platform: string;
  readonly requests: RequestUse;
  readonly problems: readonly ProblemCount[];
}

export interface CoverageProbeReport {
  readonly version: typeof PROBE_VERSION;
  readonly today: string;
  readonly window: { readonly days: number; readonly from: string; readonly to: string };
  readonly companies: {
    readonly statuses: readonly string[];
    readonly platforms: readonly string[];
    /** status -> platform ('none' for a company with no platform yet) -> count. */
    readonly counts: Readonly<Record<string, Readonly<Record<string, number>>>>;
    readonly totals: Readonly<Record<string, number>>;
    readonly deferredThisWeek: { readonly week: string; readonly runId: string | null; readonly total: number; readonly byStage: Readonly<Record<string, number>> };
  };
  readonly newJobs: {
    readonly minFit: number;
    readonly platforms: readonly PlatformJobs[];
    readonly total: { readonly found: number; readonly passing: number };
    readonly jobs: readonly NewJob[];
  };
  /** Sources expansion, Task 13 (additive): the freehire catalogue and discovery, from the DB and the vendored seed alone. */
  readonly freehire: {
    /** Registry rows from the vendored catalogue by status (verified, proposed; the rest are neither), and the seed entries no registry row holds yet. */
    readonly catalogue: { readonly verified: number; readonly proposed: number; readonly left: number };
    /** Boards the weekly discovery added to the registry, and the leads stored since the week before this one. */
    readonly discovery: { readonly boards: number; readonly leads: number };
  };
  readonly platforms: readonly PlatformReport[];
  readonly latestDailyRun: { readonly runId: string; readonly at: string } | null;
}

interface JobRow {
  job_key: string;
  source: string;
  company: string;
  title: string;
  verdict: string | null;
  score: number | null;
  first_seen: string;
  duplicate_of: string | null;
  board: string | null;
}

/**
 * The reason label of a problem or skip text: a named platform skip (the residence-named ones for any residence:
 * `no-germany-or-remote-facet`, `not-germany`), `host-disabled`, `listing-cap`, else the kind.
 */
export function reasonLabel(text: string, fallback: string): string {
  for (const p of PLATFORM_NOTE_PREFIXES) if (text.startsWith(p)) return p.trim();
  const residence = residenceSkipLabel(text);
  if (residence !== null) return residence;
  const m = /(?:^|[\s:(])(host-disabled|listing-cap|robots-disallow|scope-not-applied)\b/u.exec(text);
  return m === null ? fallback : (m[1] as string);
}

export interface ProbeInput {
  readonly app: AppStore;
  readonly now: string;
  readonly days: number;
  readonly minFit: number;
  /** The watchlist's ATS boards, `<ats> <slug lower-cased>`: a Greenhouse, Lever or Ashby row on one is an existing source. */
  readonly watchlist: ReadonlySet<string>;
  readonly naming: { readonly forbiddenTerms: string[] };
  /** The vendored catalogue (default: the seed shipped in assets/freehire). */
  readonly catalogue?: readonly CatalogueEntry[];
}

/** The vendored seed, parsed. */
const seedEntries = (): CatalogueEntry[] => loadCatalogue(readFileSync(fileURLToPath(CATALOGUE_SEED), 'utf8'));

/** The freehire line's numbers: SELECT only. */
function freehireOf(app: AppStore, now: string, entries: readonly CatalogueEntry[]): CoverageProbeReport['freehire'] {
  const companies = app.listCompanies();
  const by = (source: string, status: string): number => companies.filter((c) => c.source === source && c.status === status).length;
  const known = app.registryBoardKeys();
  const left = new Set(entries.map((e) => boardKey(e.platform, e.ref)).filter((k) => !known.has(k))).size;
  return {
    catalogue: { verified: by('freehire', 'verified'), proposed: by('freehire', 'proposed'), left },
    discovery: { boards: companies.filter((c) => c.source === 'freehire-discovery').length, leads: app.freehireLeads(leadsSince(now)).length },
  };
}

/** Builds the report from the DB. Reads only. */
export function buildReport(i: ProbeInput): CoverageProbeReport {
  const { app } = i;
  const db = app.kernel.db;
  const today = istDate(i.now);
  const from = daysBefore(today, i.days - 1);
  const safe = (t: string): string => safeLine(t, i.naming);

  // ---- companies
  const counts: Record<string, Record<string, number>> = {};
  const totals: Record<string, number> = {};
  const platformsSeen = new Set<string>();
  for (const c of app.listCompanies()) {
    const p = c.platform ?? 'none';
    platformsSeen.add(p);
    (counts[c.status] ??= {})[p] = ((counts[c.status] ?? {})[p] ?? 0) + 1;
    totals[c.status] = (totals[c.status] ?? 0) + 1;
  }
  const platformOrder = (p: string): number => (p === 'none' ? 1000 : PROBE_PLATFORMS.indexOf(p) < 0 ? 999 : PROBE_PLATFORMS.indexOf(p));
  const companyPlatforms = [...platformsSeen].sort((a, b) => platformOrder(a) - platformOrder(b) || cmp(a, b));
  const week = coverageWeek(i.now);
  const deferred = deferredThisWeek(app, week);

  // ---- new jobs
  const rows = db
    .prepare(
      `SELECT j.job_key, j.source, j.company, j.title, j.verdict, j.score, j.first_seen, j.duplicate_of, COALESCE(a.board, a.slug) AS board
       FROM jobs j LEFT JOIN job_ats a ON a.job_key = j.job_key ORDER BY j.job_key`,
    )
    .all() as JobRow[];
  // a Greenhouse/Lever/Ashby row is a platform (registry-only) row only when its board is known and off the watchlist
  const registryOnly = (r: JobRow): boolean => {
    if (PLATFORM_ONLY.has(r.source)) return true;
    if (!API_BOARD_SET.has(r.source) || r.board === null || r.board === '') return false;
    return !i.watchlist.has(`${r.source} ${r.board.toLowerCase()}`);
  };
  const existingDup = new Set<string>();
  for (const r of rows) if (r.duplicate_of !== null && !registryOnly(r)) existingDup.add(r.duplicate_of);
  const found = new Map<string, { found: number; passing: number }>();
  const jobs: NewJob[] = [];
  for (const r of rows) {
    if (r.duplicate_of !== null || !registryOnly(r) || existingDup.has(r.job_key)) continue;
    const seen = istDate(r.first_seen);
    if (seen < from || seen > today) continue;
    const passes = r.verdict === 'eligible' || (r.verdict === 'review' && r.score !== null && r.score >= i.minFit);
    const t = found.get(r.source) ?? { found: 0, passing: 0 };
    found.set(r.source, { found: t.found + 1, passing: t.passing + (passes ? 1 : 0) });
    jobs.push({ platform: r.source, company: safe(r.company), title: safe(r.title), verdict: r.verdict, fit: r.score, passes });
  }
  jobs.sort((a, b) => platformOrder(a.platform) - platformOrder(b.platform) || Number(b.passes) - Number(a.passes) || (b.fit ?? -1) - (a.fit ?? -1) || cmp(a.company, b.company) || cmp(a.title, b.title));
  const jobPlatforms = [...found.entries()].map(([platform, v]) => ({ platform, ...v })).sort((a, b) => platformOrder(a.platform) - platformOrder(b.platform));

  // ---- per platform
  const boards = registryBoards(app.verifiedCompanies());
  const run = app.latestRun('daily-');
  const runProblems = run === undefined ? [] : problemLines(run, safe);
  const ledger = ledgerOf(app, today);
  const readBoards = run === undefined ? new Map<string, number>() : boardsRead(app, run.runId);
  const platforms: PlatformReport[] = [];
  for (const platform of PROBE_PLATFORMS) {
    const mine = boards.filter((b) => b.platform === platform).length;
    const used = ledger(platform);
    const read = readBoards.get(platform) ?? 0;
    const probs = problemCounts(runProblems.filter((p) => p.agent === `src-${platform}`));
    if (mine === 0 && used === null && read === 0 && probs.length === 0 && !companyPlatforms.includes(platform) && !found.has(platform)) continue;
    platforms.push({ platform, requests: requestUse(platform, mine, used, read), problems: probs });
  }

  return {
    version: PROBE_VERSION,
    today,
    window: { days: i.days, from, to: today },
    companies: { statuses: COMPANY_STATUS_ORDER, platforms: companyPlatforms, counts, totals, deferredThisWeek: deferred },
    newJobs: { minFit: i.minFit, platforms: jobPlatforms, total: { found: jobs.length, passing: jobs.filter((j) => j.passes).length }, jobs },
    freehire: freehireOf(app, i.now, i.catalogue ?? seedEntries()),
    platforms,
    latestDailyRun: run === undefined ? null : { runId: run.runId, at: run.at },
  };
}

/** The latest coverage run of this coverage week and what it deferred (from its `coverage.summary` event). */
function deferredThisWeek(app: AppStore, week: string): CoverageProbeReport['companies']['deferredThisWeek'] {
  const empty = { week, runId: null, total: 0, byStage: {} };
  const run = app.latestRun('coverage-');
  const date = run === undefined ? undefined : /^coverage-(\d{4}-\d{2}-\d{2})/u.exec(run.runId)?.[1];
  if (run === undefined || date === undefined || date < week) return empty;
  for (const ev of [...app.kernel.events(run.runId)].reverse()) {
    if (ev.kind !== 'coverage.summary') continue;
    const d = (JSON.parse(ev.data) as { deferred?: { total?: unknown; byStage?: Record<string, unknown> } }).deferred;
    const byStage: Record<string, number> = {};
    for (const [k, v] of Object.entries(d?.byStage ?? {})) if (typeof v === 'number') byStage[k] = v;
    return { week, runId: run.runId, total: typeof d?.total === 'number' ? d.total : 0, byStage };
  }
  return { ...empty, runId: run.runId };
}

interface Line {
  readonly agent: string;
  readonly label: string;
  readonly text: string;
}

/** The latest daily run's problems (agent, kind, reason) and named-skip warnings (`src-x: note`), redacted. */
function problemLines(run: { readonly warnings?: readonly string[]; readonly problems?: readonly unknown[] }, safe: (t: string) => string): Line[] {
  const out: Line[] = [];
  for (const p of run.problems ?? []) {
    const o = p as { agent?: unknown; kind?: unknown; reason?: unknown; item?: unknown };
    if (typeof o.agent !== 'string' || !o.agent.startsWith('src-')) continue;
    const reason = typeof o.reason === 'string' ? o.reason : '';
    const kind = typeof o.kind === 'string' ? o.kind : 'problem';
    out.push({ agent: o.agent, label: reasonLabel(reason, kind), text: safe(`${kind}: ${typeof o.item === 'string' ? `${o.item}: ` : ''}${reason}`) });
  }
  for (const w of run.warnings ?? []) {
    const m = /^(src-[a-z0-9-]+): (.*)$/su.exec(w);
    if (m === null) continue;
    out.push({ agent: m[1] as string, label: reasonLabel(m[2] as string, 'warning'), text: safe(w) });
  }
  return out;
}

function problemCounts(lines: readonly Line[]): ProblemCount[] {
  const by = new Map<string, { count: number; example: string }>();
  for (const l of lines) {
    const t = by.get(l.label);
    by.set(l.label, t === undefined ? { count: 1, example: l.text } : { count: t.count + 1, example: t.example });
  }
  return [...by.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => cmp(a.reason, b.reason));
}

/** Today's page ledgers: pages used for a platform, or null when it keeps none. Stale-refetch keys are a sub-count, never added. */
function ledgerOf(app: AppStore, today: string): (platform: string) => number | null {
  const db = app.kernel.db;
  const rows = db
    .prepare(`SELECT key, value FROM app_settings WHERE substr(key, 1, ?) = ? OR substr(key, 1, ?) = ? ORDER BY key`)
    .all(PAGE_LEDGER_PREFIX.length + today.length + 1, `${PAGE_LEDGER_PREFIX}${today}.`, 'oracle.pages.'.length + today.length + 1, `oracle.pages.${today}.`) as { key: string; value: string }[];
  const used = new Map<string, number>();
  for (const r of rows) {
    const n = Number(r.value);
    if (!Number.isSafeInteger(n) || n < 0) continue;
    if (r.key.startsWith('oracle.pages.')) {
      used.set('oracle', (used.get('oracle') ?? 0) + n);
      continue;
    }
    const board = r.key.slice(PAGE_LEDGER_PREFIX.length + today.length + 1);
    if (board.endsWith(' stale')) continue;
    const platform = board.slice(0, Math.max(0, board.indexOf(' ')));
    if (platform !== '') used.set(platform, (used.get(platform) ?? 0) + n);
  }
  return (platform) => used.get(platform) ?? null;
}

/** The boards each platform's adapter read (done) in the run: its done steps whose seed names the platform. */
function boardsRead(app: AppStore, runId: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const q of app.kernel.queueItems(runId)) {
    if (q.status !== 'done' || !q.agent_id.startsWith('src-')) continue;
    const platform = q.agent_id.slice(4);
    const payload = (app.kernel.getEnvelope(q.envelope_id) as { payload?: { ats?: unknown } }).payload;
    if (payload?.ats === platform) out.set(platform, (out.get(platform) ?? 0) + 1);
  }
  return out;
}

const REQUEST_CAP: Readonly<Record<string, number>> = {
  workday: WORKDAY_MAX_REQUESTS,
  eightfold: Math.max(eightfoldMaxRequests('v2'), eightfoldMaxRequests('pcsx')),
  ...Object.fromEntries(SMALL_PLATFORM_NAMES.map((p) => [p, FEED_MAX_REQUESTS])),
};

function requestUse(platform: string, boards: number, pages: number | null, read: number): RequestUse {
  if (platform === 'oracle' || ['icims', 'successfactors', 'smartrecruiters', 'jsonld-sitemap'].includes(platform)) {
    const per = platform === 'oracle' ? ORACLE_MAX_PAGES : PAGE_MAX_FETCHES;
    return { kind: 'ledger', unit: 'pages', used: pages ?? 0, budget: boards * per, boards, perBoardRequestCap: null };
  }
  return { kind: boards === 0 && read === 0 ? 'none' : 'boards', unit: 'boards', used: read, budget: boards, boards, perBoardRequestCap: REQUEST_CAP[platform] ?? null };
}

// ---------------------------------------------------------------------------------------------------- the table

const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length));
const padL = (s: string, n: number): string => ' '.repeat(Math.max(0, n - s.length)) + s;

function table(head: readonly string[], rows: readonly (readonly string[])[], right: readonly number[] = []): string[] {
  const w = head.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? '').length)));
  const line = (r: readonly string[]): string => r.map((v, c) => (right.includes(c) ? padL(v, w[c] as number) : pad(v, w[c] as number))).join('  ').trimEnd();
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...rows.map(line)];
}

/** The readable report. */
export function formatReport(r: CoverageProbeReport): string {
  const out: string[] = [];
  out.push(`Coverage probe, ${r.today} (reads the DB only; nothing was requested)`);
  out.push(`Window: first seen ${r.window.from} to ${r.window.to} IST (last ${r.window.days} ${r.window.days === 1 ? 'day' : 'days'})`);
  out.push('', 'Companies by status and platform');
  const c = r.companies;
  if (c.platforms.length === 0) out.push('  none in the registry');
  else {
    out.push(...table(['platform', ...c.statuses], [...c.platforms.map((p) => [p, ...c.statuses.map((s) => String(c.counts[s]?.[p] ?? 0))]), ['total', ...c.statuses.map((s) => String(c.totals[s] ?? 0))]], c.statuses.map((_, k) => k + 1)).map((l) => `  ${l}`));
  }
  const d = c.deferredThisWeek;
  const stages = Object.entries(d.byStage).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
  out.push(`  deferred this week (coverage week of ${d.week}): ${d.total}${stages === '' ? '' : ` (${stages})`}${d.runId === null ? ' (no coverage run this week)' : ''}`);
  out.push(`  catalogue: ${r.freehire.catalogue.verified} verified, ${r.freehire.catalogue.proposed} proposed, ${r.freehire.catalogue.left} left · discovery: boards ${r.freehire.discovery.boards}, leads ${r.freehire.discovery.leads} (last week)`);
  out.push('', `New jobs only the platform adapters found (no copy on an existing source), passing = eligible or review with fit >= ${r.newJobs.minFit}`);
  if (r.newJobs.platforms.length === 0) out.push('  none');
  else out.push(...table(['platform', 'new', 'passing'], [...r.newJobs.platforms.map((p) => [p.platform, String(p.found), String(p.passing)]), ['total', String(r.newJobs.total.found), String(r.newJobs.total.passing)]], [1, 2]).map((l) => `  ${l}`));
  out.push('  Note: "new" counts every job the adapters found in the window, including ones you have since skipped or rejected and ones no longer listed.');
  if (r.newJobs.jobs.length > 0) {
    out.push('', '  Jobs');
    out.push(...table(['platform', 'verdict', 'fit', 'company', 'title'], r.newJobs.jobs.map((j) => [j.platform, `${j.verdict ?? '-'}${j.passes ? ' *' : ''}`, j.fit === null ? '-' : String(Math.round(j.fit)), j.company, j.title]), [2]).map((l) => `  ${l}`), '  (* passes the rules)');
  }
  out.push('', r.latestDailyRun === null ? 'Requests today and problems per platform (no daily run recorded)' : `Requests today and problems per platform (latest daily run ${r.latestDailyRun.runId})`);
  if (r.platforms.length === 0) out.push('  none');
  for (const p of r.platforms) {
    const q = p.requests;
    const used = q.kind === 'none' ? 'no boards' : `${q.used}/${q.budget} ${q.unit}${q.perBoardRequestCap === null ? '' : ` (up to ${q.perBoardRequestCap} requests per board)`}`;
    out.push(`  ${p.platform}: ${used}`);
    for (const pr of p.problems) out.push(`    ${pr.count} x ${pr.reason}: ${pr.example}`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------- the command

export interface CoverageProbeOptions {
  readonly home: string;
  readonly json: boolean;
  readonly days?: number;
  readonly clock: Clock;
  readonly out: (line: string) => void;
}

/** Validates `--days`: a whole number from 1 to 90. */
export function parseDays(v: string): number {
  if (!/^\d+$/u.test(v) || Number(v) < 1 || Number(v) > MAX_DAYS) throw new Error(`--days must be a whole number from 1 to ${MAX_DAYS}`);
  return Number(v);
}

/** `jobpilot coverage probe`: takes the run lock (a held lock refuses with the holder named), reads, prints. Exit 0. */
export async function coverageProbeCommand(o: CoverageProbeOptions): Promise<number> {
  const days = o.days ?? DEFAULT_DAYS;
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`--days must be a whole number from 1 to ${MAX_DAYS}`);
  return withLock(o.home, 'coverage probe', async () => {
    const paths = homePaths(o.home);
    ensureHome(paths.home);
    if (!existsSync(paths.db)) throw new Error(`no database at ${paths.db}: run jobpilot first`);
    // A schema behind this code is refused (SchemaBehindError: run `jobpilot facts list`), never migrated here. The
    // probe itself only reads; the lock above keeps a run from writing meanwhile.
    const app = AppStore.open(paths.db);
    try {
      const loaded = loadRunPack(paths.pack, app.factOverrides(), istMonth(o.clock.now()), undefined, 'daily');
      const watchlist = new Set(loaded.pack.watchlist.map((w) => `${w.ats} ${w.slug.toLowerCase()}`));
      const report = buildReport({ app, now: o.clock.now(), days, minFit: loaded.pack.targets.minFit, watchlist, naming: loaded.pack.naming });
      o.out(o.json ? JSON.stringify(report, null, 2) : formatReport(report));
      return 0;
    } finally {
      app.close();
    }
  });
}
