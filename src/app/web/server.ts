import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { parse as parseYaml } from 'yaml';
import type { Clock } from '../../kernel/clock.js';
import { MIGRATIONS } from '../../kernel/store/migrations.js';
import { Store } from '../../kernel/store/store.js';
import { schemaState } from '../upgrade.js';
import { chainStatus } from '../chain-status.js';
import { coverNoteShort } from '../agents/writing/grounded.js';
import { profileFor } from '../ats-profiles.js';
import { CoverPlan } from '../types.js';
import { DEFAULT_FX } from '../pack/defaults.js';
import { loadPack } from '../pack/load.js';
import { homePaths } from '../pack/paths.js';
import { employerDisplay, forbiddenTermStrict, redactText, type NamingRules } from '../pack/rules.js';
import { NamingSchema, type Fact, type Pack } from '../pack/schema.js';
import { diskDocCheck } from '../docs-check.js';
import { overrideFact } from '../project.js';
import { istDate, istMonth } from '../run.js';
import { AppStore, SchemaBehindError, type Band, type JobFilter, type JobsPage, type JobStatus } from '../store/app-store.js';
import { JOB_STATUSES } from '../store/schema.js';
import { dateText, daysBetween, istTimeText } from './format.js';
import { readRecorded, snapshotApplied, type ReadResult } from './files.js';
import { COMPANY_KEY, companyJobsOf, mountCompanies, type ResolveDeps } from './companies.js';
import type { CompanyJobs } from '../coverage/company-jobs.js';
import { liveHolder } from '../lock.js';
import { SharedStore, UpgradePending } from './connection.js';
import { mountFreelance } from './freelance.js';
import { html, type Html } from './html.js';
import { CSRF_FIELD, CSRF_HEADER, FILE_CSP, allowedHosts, PAGE_CSP, PREVIEW_CSP, sameOrigin, SESSION_COOKIE, Sessions } from './security.js';
import { factRow, factsBody, type FactRow } from './views/facts.js';
import { jobBody, noteSection, sentSection, statusSection, type Recommended, type SentData } from './views/job.js';
import { jobsBody, type ListedJob } from './views/jobs.js';
import { layout, type Banner, type Nav } from './views/layout.js';
import { FULL_CHECK_STALE_DAYS, runsBody } from './views/runs.js';

/**
 * The local dashboard (Task 13, spec §7): Hono on 127.0.0.1, server-rendered HTML that reads fully with JavaScript
 * off, enhanced by the vendored htmx. Every request reads the app DB through one long-lived connection that never
 * holds a transaction (`connection.ts`: it sees what a daily run committed since, and is reopened when the schema or
 * the file changes) and reads the pack as today's run would (this IST month), so what it shows is what the next run
 * will use.
 *
 * Routes: `GET /` jobs, `GET /jobs/:key` one job, `POST /jobs/:key/status`, `POST /jobs/:key/note`,
 * `GET /jobs/:key/files/:name` a current document, `GET /jobs/:key/sent/:day/:name` an applied snapshot file,
 * `GET /facts`, `POST /facts/:id/verify|reject`, `GET /runs`, `GET /static/*`, the freelance tab under `/freelance`
 * (`freelance.ts`, Task 10) and the Companies tab under `/companies` (`companies.ts`, career-sites Task 11). `GET /`
 * takes `companyKey=<registry key>` to list one company's jobs (the Companies tab's links). Security rules: `security.ts`.
 *
 * Forbidden terms: the dashboard is generated output, so every text it shows from the store or the pack is checked
 * against the pack's `naming.forbiddenTerms` and replaced with "[hidden]" when it names one.
 */

export interface DashboardDeps {
  /** JOBPILOT_HOME: the pack, the DB and the documents. */
  readonly home: string;
  readonly clock: Clock;
  /** Default: the secret kept in app_settings (`dashboard.csrf_secret`), created on first start. */
  readonly sessions?: Sessions;
  /**
   * The port the server listens on (a function when it is known only after listening). With a port, only
   * `127.0.0.1:<port>`, `localhost:<port>` and `[::1]:<port>` are accepted as Host; without one, only the bare names.
   */
  readonly port?: number | (() => number | undefined);
  /** How long a write waits for a run's lock before answering 503 (SQLite busy_timeout). Default 10 s. */
  readonly busyTimeoutMs?: number;
  /** Whether Gmail is connected, for the freelance Sources page (the CLI checks the Keychain). Absent: not connected. */
  readonly gmailConnected?: () => boolean;
  /**
   * Called when the database's schema is newer than this code (a newer jobpilot's run migrated it). `jobpilot serve`
   * exits, so launchd's KeepAlive restarts the dashboard on the checkout's (newer) code. Absent: the error page only.
   */
  readonly onSchemaNewer?: () => void;
  /** What the Companies tab's "Resolve now" fetches with (the CLI: the real fetcher). Absent: Resolve now is not offered. */
  readonly resolve?: ResolveDeps;
}

/** Tests only (reached through `server-testing.ts`): runs just before an applied snapshot is recorded. */
export interface DashboardTestHooks {
  readonly beforeSnapshot?: () => void;
  /** Runs before every route; throwing reaches the error page. */
  readonly beforeRoute?: () => void;
  /** Called each time the dashboard opens its (shared) database connection. */
  readonly onOpen?: () => void;
  /** Replaces `listJobsPage` for `GET /` (the equivalence test runs the pre-fix-2 JS path through the real route). */
  readonly jobsPage?: (s: AppStore, filter: JobFilter, opts: { readonly page: number; readonly size: number; readonly newAfterMs: number }) => JobsPage;
}

/** A download record is best-effort: it waits this long for a lock, then is skipped. */
const DOWNLOAD_RECORD_TIMEOUT_MS = 200;

export const NO_DATABASE_MESSAGE = 'no database yet; the first run creates it';
export const UPGRADE_MESSAGE = 'jobpilot is being upgraded; the next run (or jobpilot facts list) applies it';
/** Idle time after the last request before the dashboard's -wal maintenance runs. */
const IDLE_MAINTENANCE_MS = 15_000;
export const BUSY_MESSAGE = "jobpilot is busy finishing today's run — try again in a moment";
const CSRF_SECRET_KEY = 'dashboard.csrf_secret';
const isBusy = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' && ((e as { code: string }).code).startsWith('SQLITE_BUSY');

export const DEFAULT_PORT = 4317;
export const HIDDEN = '[hidden: contains a forbidden term]';
const VISIT_COOKIE = 'jp_visit';
/** A visit more than this after the last request starts a new visit: "new since your last visit" moves on. */
const VISIT_GAP_MS = 30 * 60_000;
const JOB_KEY = /^[0-9a-f]{16}$/;
const DOC_NAME = /^(resume|cover)\.(pdf|docx|html)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FX_STALE_DAYS = 30;
const PAGE_SIZE = 100;

const STATIC_DIR = join(import.meta.dirname, 'static');
const require = createRequire(import.meta.url);

/** The vendored htmx (pinned in package.json), read from the installed package once: no CDN. */
function staticFiles(): Record<string, { body: string; type: string }> {
  return {
    'app.css': { body: readFileSync(join(STATIC_DIR, 'app.css'), 'utf8'), type: 'text/css; charset=utf-8' },
    'app.js': { body: readFileSync(join(STATIC_DIR, 'app.js'), 'utf8'), type: 'text/javascript; charset=utf-8' },
    'htmx.min.js': { body: readFileSync(require.resolve('htmx.org/dist/htmx.min.js'), 'utf8'), type: 'text/javascript; charset=utf-8' },
  };
}

interface PackState {
  /** Loaded without the user's overrides: `facts[].status` is the facts.yaml status. */
  readonly pack: Pack | undefined;
  readonly error: string | undefined;
  readonly naming: NamingRules;
}

/** The naming rules alone, when the rest of the pack does not load. Invalid naming.yaml: undefined (nothing is shown). */
function namingOnly(packDir: string): NamingRules | undefined {
  const path = join(packDir, 'naming.yaml');
  if (!existsSync(path)) return { employerDisplay: {}, forbiddenTerms: [] };
  try {
    const r = NamingSchema.safeParse(parseYaml(readFileSync(path, 'utf8')) ?? {});
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

class NamingUnreadable extends Error {
  override readonly name = 'NamingUnreadable';
}

function packState(home: string, now: string): PackState {
  const dir = homePaths(home).pack;
  try {
    const { pack } = loadPack(dir, {}, { asOf: istMonth(now), mode: 'daily' });
    return { pack, error: undefined, naming: pack.naming };
  } catch (e) {
    const naming = namingOnly(dir);
    if (naming === undefined) throw new NamingUnreadable('naming.yaml could not be read, so nothing can be shown safely; fix it and reload');
    // final I9: the load error goes through the one redactor before it is shown on any page
    return { pack: undefined, error: redactText(e instanceof Error ? e.message : String(e), naming), naming };
  }
}

/**
 * Replaces any string naming a forbidden term with HIDDEN, deeply (objects and arrays are copied). The strict check
 * (`forbiddenTermStrict`, final I8 and M-N4): glued, split, plural and look-alike spellings are hidden too.
 */
export function redactor(naming: Pick<NamingRules, 'forbiddenTerms'>): { text: (s: string) => string; deep: <T>(v: T) => T } {
  const text = (s: string): string => (naming.forbiddenTerms.length === 0 || forbiddenTermStrict(s, naming) === undefined ? s : HIDDEN);
  const deep = <T>(v: T): T => {
    if (typeof v === 'string') return text(v) as T;
    if (Array.isArray(v)) return v.map(deep) as T;
    if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) as T;
    return v;
  };
  return { text, deep };
}

/** The subject of "<X> reads PDF best", by ATS profile id. */
const ATS_SENTENCE: Readonly<Record<string, string>> = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workday: 'Workday', icims: 'iCIMS', taleo: 'Taleo',
  smartrecruiters: 'SmartRecruiters', careers: 'A careers site', feed: 'Most applicant systems', unknown: 'Most applicant systems',
};

const humanKey = (k: string): string => {
  const s = k.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** The answers.yaml key of the short cover note the job page shows. */
export const COVER_NOTE_KEY = 'cover_note_short';

/**
 * The screening answers for a job page (cover letter v2): when the letter behind the job's current documents is on
 * record, `cover_note_short` is that letter's opening sentence and top fact (`coverNoteShort`), so the note never says
 * more than the letter (a stale answers.yaml note could carry an old availability date); it is added when answers.yaml
 * has no such key. Without a letter, answers.yaml is shown as it is.
 */
export function withCoverNote(answers: Readonly<Record<string, unknown>>, plan: unknown): [string, unknown][] {
  const rows = Object.entries(answers);
  const cover = CoverPlan.schema.safeParse(plan);
  const note = cover.success ? coverNoteShort(cover.data) : undefined;
  if (note === undefined) return rows;
  return rows.some(([k]) => k === COVER_NOTE_KEY) ? rows.map(([k, v]) => [k, k === COVER_NOTE_KEY ? note : v]) : [...rows, [COVER_NOTE_KEY, note]];
}

const CONTENT_TYPE: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html; charset=utf-8',
};

/** A preview gets a tooltip per bullet naming the fact it cites; the bytes on disk are unchanged. */
export function withFactTooltips(page: string): string {
  return page
    .replace(/<li data-fact="([^"<>]*)">/g, '<li data-fact="$1" title="Fact $1">')
    .replace(/<p data-facts="([^"<>]*)">/g, '<p data-facts="$1" title="Facts $1">');
}

const asciiSlug = (s: string): string =>
  s.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export type Env = { Variables: { sid: string } };

/** The pages a new dashboard renders once before serving (amendment 2): code compiled, the pack read, DB pages cached. */
export const WARM_PATHS: readonly string[] = ['/', '/jobs/0000000000000000', '/facts', '/runs', '/freelance', '/freelance?tab=review', '/freelance/networks', '/companies'];

/** Requests each of WARM_PATHS once with `host`; never throws. Returns the time it took in ms. */
export async function warmDashboard(app: Hono<Env>, host: string): Promise<number> {
  const t0 = performance.now();
  for (const path of WARM_PATHS) {
    try {
      await (await app.request(path, { headers: { host } })).text();
    } catch {
      // a page that cannot render now renders on its first real request instead
    }
  }
  return Math.max(performance.now() - t0, 0.001);
}

export function createDashboard(deps: DashboardDeps): Hono<Env> {
  return buildDashboard(deps, {});
}

/** @internal The dashboard with test hooks; production code calls `createDashboard`. */
export function buildDashboard(deps: DashboardDeps, hooks: DashboardTestHooks): Hono<Env> {
  const paths = homePaths(deps.home);
  const timeoutMs = deps.busyTimeoutMs ?? 10_000;
  const sessions = deps.sessions ?? new Sessions(keptSecret(paths.db, timeoutMs));
  const files = staticFiles();
  const app = new Hono<Env>();
  if (hooks.beforeRoute !== undefined) {
    const before = hooks.beforeRoute;
    app.use(async (_c, next) => {
      before();
      await next();
    });
  }
  const portOf = (): number | undefined => (typeof deps.port === 'function' ? deps.port() : deps.port);

  const page = (c: Context<Env>, nav: Nav, title: string, banners: readonly Banner[], body: Html, status: 200 | 400 | 403 | 404 | 409 | 500 | 503 = 200) =>
    c.html(layout({ title, nav, banners, body }).value, status);

  // dashboard-perf fix 5: one long-lived connection per dashboard, never holding a transaction (`connection.ts`)
  const shared = new SharedStore(paths.db, timeoutMs, hooks.onOpen, deps.onSchemaNewer, () => liveHolder(deps.home) !== undefined);
  // idle maintenance (review): a TRUNCATE checkpoint of the -wal once no request has come for IDLE_MS; it never waits
  let idle: ReturnType<typeof setTimeout> | undefined;
  const scheduleIdle = (): void => {
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(() => shared.maintain(), IDLE_MAINTENANCE_MS);
    idle.unref();
  };
  const withStore = <T>(fn: (store: AppStore) => T): T => shared.use(fn);

  const commonBanners = (ps: PackState, today: string, overrides: Record<string, Fact['status']>): Banner[] => {
    const out: Banner[] = [];
    if (ps.error !== undefined) out.push({ tone: 'critical', text: `Your pack could not be read: ${ps.error}` });
    if (ps.pack) {
      const age = daysBetween(ps.pack.fx.asOf, today);
      if (ps.pack.fx.asOf === DEFAULT_FX.asOf) out.push({ tone: 'warn', text: 'Exchange rates are the built-in defaults; add fx.yaml' });
      else if (age > FX_STALE_DAYS) out.push({ tone: 'warn', text: `Exchange rates are ${age} days old — update fx.yaml` });
      const ids = new Set(ps.pack.facts.map((f) => f.id));
      const unknown = Object.keys(overrides).filter((id) => !ids.has(id));
      if (unknown.length > 0) out.push({ tone: 'critical', text: `A status change you made names a fact that is no longer in facts.yaml (${unknown.join(', ')}); the next run will refuse to start until it is back.` });
    }
    return out.map((b) => ({ ...b, text: typeof b.text === 'string' ? redactor(ps.naming).text(b.text) : b.text }));
  };

  // --- every request: loopback Host only, then the security headers --------------------------------------------
  app.use('*', async (c, next) => {
    // The raw Host header must be one of the dashboard's own names (with its port), and an absolute-form request
    // target must not name another host.
    const host = (c.req.header('host') ?? '').toLowerCase();
    if (!allowedHosts(portOf()).has(host) || new URL(c.req.url).host.toLowerCase() !== host) return c.text('This dashboard only answers on 127.0.0.1.', 403);
    await next();
    scheduleIdle();
    const h = c.res.headers;
    if (!h.has('content-security-policy')) h.set('content-security-policy', PAGE_CSP);
    h.set('x-content-type-options', 'nosniff');
    // same-origin, not no-referrer: under no-referrer a browser sends `Origin: null` on a plain form post, which the
    // origin check must refuse. Links out carry rel="noreferrer", so nothing leaks to other sites.
    h.set('referrer-policy', 'same-origin');
    h.set('cross-origin-opener-policy', 'same-origin');
    h.set('cross-origin-resource-policy', 'same-origin');
    if (!h.has('cache-control')) h.set('cache-control', 'no-store');
  });

  // --- session cookie --------------------------------------------------------------------------------------------
  app.use('*', async (c, next) => {
    let sid = getCookie(c, SESSION_COOKIE);
    if (!Sessions.validId(sid)) {
      if (c.req.method === 'POST') return c.text('Forbidden: no session. Reload the page and try again.', 403);
      sid = sessions.newId();
      setCookie(c, SESSION_COOKIE, sid, { httpOnly: true, sameSite: 'Strict', path: '/' });
    }
    c.set('sid', sid);
    await next();
  });

  // --- POST: same origin AND the session's CSRF token ---------------------------------------------------------------
  app.use('*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text('Request too large', 413) }));
  app.use('*', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const self = new URL(c.req.url).origin;
    if (!sameOrigin(self, c.req.header('origin'), c.req.header('referer'))) return c.text('Forbidden: this request did not come from the dashboard.', 403);
    const body = await c.req.parseBody();
    const field = body[CSRF_FIELD];
    const token = c.req.header(CSRF_HEADER) ?? (typeof field === 'string' ? field : undefined);
    if (!sessions.check(c.get('sid'), token)) return c.text('Forbidden: the form is out of date. Reload the page and try again.', 403);
    return next();
  });

  /** The "Documents you sent" data: the snapshots, a changed-since-download note per snapshot, and the keep offer. */
  const sentData = (s: AppStore, c: Context<Env>, key: string): SentData => {
    const job = s.getJob(key);
    const snapshots = s.snapshots(key);
    const downloads = s.downloads(key);
    const changedSince: Record<string, string> = {};
    for (const snap of snapshots) {
      for (const f of snap.files) {
        const last = downloads.filter((d) => d.file === `${f.kind}.${f.format}` && d.at <= snap.at).at(-1);
        if (last !== undefined && last.sha256 !== f.sha256 && (changedSince[snap.day] === undefined || last.at > (changedSince[snap.day] as string))) changedSince[snap.day] = last.at;
      }
    }
    return {
      jobKey: key, snapshots, changedSince, canKeep: job !== undefined && keepable(job, snapshots.length), csrf: csrf(c), istDay: istDate,
      appliedDay: job?.appliedAt ? istDate(job.appliedAt) : null,
    };
  };
  const keepable = (job: { status: string; docsState: string; docs: readonly { kind: string }[] }, snapshotCount: number): boolean =>
    job.status === 'applied' && snapshotCount === 0 && job.docsState === 'ready' && job.docs.some((d) => d.kind === 'resume' || d.kind === 'cover');

  const isHx = (c: Context<Env>): boolean => c.req.header('hx-request') === 'true';
  const csrf = (c: Context<Env>): string => sessions.token(c.get('sid'));
  const now = (): string => deps.clock.now();

  app.get('/static/:file', (c) => {
    const f = Object.hasOwn(files, c.req.param('file')) ? files[c.req.param('file')] : undefined;
    if (!f) return c.text('Not found', 404);
    return c.body(f.body, 200, { 'content-type': f.type, 'cache-control': 'no-cache' });
  });

  // --- jobs list ------------------------------------------------------------------------------------------------------
  app.get('/', (c) => {
    const at = now();
    const ps = packState(deps.home, at);
    const r = redactor(ps.naming);
    const statuses = c.req.queries('status')?.filter((s): s is JobStatus => (JOB_STATUSES as readonly string[]).includes(s)) ?? [];
    const ALL: readonly Band[] = ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'];
    const bands = c.req.queries('band')?.filter((b): b is Band => (ALL as readonly string[]).includes(b)) ?? [];
    const minRaw = c.req.query('min')?.trim() ?? '';
    const min = /^\d{1,3}(\.\d+)?$/.test(minRaw) ? Number(minRaw) : undefined;
    const q = (c.req.query('q') ?? '').trim().slice(0, 100);
    const keyRaw = (c.req.query('companyKey') ?? '').trim();
    const companyKey = COMPANY_KEY.test(keyRaw) ? keyRaw : '';
    // the registry company the link names, matched by key (never by the shown name); unknown: an empty list
    const registryCompany = companyKey === '' ? undefined : withStore((s) => s.getCompany(companyKey));
    const companyOf: CompanyJobs | undefined =
      companyKey === '' ? undefined : registryCompany === undefined ? { key: companyKey, name: '', board: null } : companyJobsOf(registryCompany);
    const pageRaw = c.req.query('page') ?? '1';
    const pageAsked = /^\d{1,6}$/.test(pageRaw) ? Math.max(1, Number(pageRaw)) : 1;
    const floor = ps.pack?.offers.floor;
    const floorInr = floor ? floor.amount * (floor.currency === 'INR' ? 1 : (ps.pack as Pack).fx.toINR[floor.currency]) : undefined;
    const filter: JobFilter = {
      ...(statuses.length > 0 ? { status: statuses } : {}),
      ...(bands.length > 0 ? { band: bands } : {}),
      ...(min !== undefined ? { minScore: min } : {}),
      ...(q !== '' ? { text: q } : {}),
      ...(companyOf !== undefined ? { companyOf } : {}),
      ...(floorInr !== undefined ? { floorInr } : {}),
    };
    // "New since your last visit": the previous visit's start, kept in a cookie (prev.last, epoch ms).
    const nowMs = Date.parse(at);
    const [prevRaw, lastRaw] = (getCookie(c, VISIT_COOKIE) ?? '').split('.');
    const last = Number(lastRaw);
    let prev = Number(prevRaw);
    if (!Number.isFinite(prev) || !Number.isFinite(last) || prevRaw === '' || lastRaw === undefined) prev = 0;
    else if (nowMs - last > VISIT_GAP_MS) prev = last;
    setCookie(c, VISIT_COOKIE, `${prev}.${nowMs}`, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 400 * 86_400 });

    // dashboard-perf fix 2: the page, its counts and the hidden count in SQL over the covering index (`listJobsPage`)
    const { jobs, hidden, overrides, total, newCount, pageNo, pages } = withStore((s) => {
      const opts = { page: pageAsked, size: PAGE_SIZE, newAfterMs: prev };
      const p = hooks.jobsPage !== undefined ? hooks.jobsPage(s, filter, opts) : s.listJobsPage(filter, opts);
      const hist = s.histories(p.jobs.map((j) => j.jobKey));
      return {
        // rereview R6: the list never shows the description, so it is dropped before the (strict, per-string) redaction
        jobs: p.jobs.map((j): ListedJob => ({ ...j, jdText: '', isNew: Date.parse(j.firstSeen) > prev, history: hist[j.jobKey] ?? [] })),
        hidden: bands.length === 0 ? p.hiddenCount : 0,
        overrides: s.factOverrides(),
        total: p.total,
        newCount: p.newCount,
        pageNo: p.page,
        pages: p.pages,
      };
    });
    const pageHref = (n: number): string => {
      const qs = new URLSearchParams();
      for (const v of statuses) qs.append('status', v);
      for (const v of bands) qs.append('band', v);
      if (min !== undefined) qs.set('min', String(min));
      if (q !== '') qs.set('q', q);
      if (companyKey !== '') qs.set('companyKey', companyKey);
      if (n > 1) qs.set('page', String(n));
      const t = qs.toString();
      return t === '' ? '/' : `/?${t}`;
    };
    const body = jobsBody({
      jobs: r.deep(jobs), filter: { status: statuses, band: bands, min, q, ...(companyKey !== '' ? { company: { key: companyKey, name: r.text(registryCompany?.name ?? companyKey) } } : {}) }, defaultBands: bands.length === 0, hiddenCount: hidden, istDay: istDate,
      page: pageNo, pages, total, newCount, pageHref,
    });
    return page(c, 'jobs', 'Jobs', commonBanners(ps, istDate(at), overrides), body);
  });

  // --- one job --------------------------------------------------------------------------------------------------------
  const notFound = (c: Context<Env>, what: string) => page(c, 'jobs', 'Not found', [], html`<h1>Not found</h1><p>${what}</p><p><a href="/">Back to your jobs</a></p>`, 404);

  const NOTICE: Readonly<Record<string, string>> = {
    nodocs: 'Marked applied. No documents were kept: this job had no ready documents.',
    keepfail: 'Marked applied, but the documents could not be kept as sent. They are unchanged; see the reason in the log.',
    keepbusy: "Status saved. Couldn't keep a copy of the documents just now; use 'Keep a copy' below.",
  };

  app.get('/jobs/:key', (c) => {
    const key = c.req.param('key');
    if (!JOB_KEY.test(key)) return notFound(c, 'No such job.');
    const at = now();
    const ps = packState(deps.home, at);
    const r = redactor(ps.naming);
    const data = withStore((s) => {
      const job = s.getJob(key);
      if (!job) return undefined;
      const pref = job.duplicateOf === null ? undefined : s.getJob(job.duplicateOf);
      return { job, sent: sentData(s, c, key), preferred: pref ? { jobKey: pref.jobKey, source: pref.source } : null, overrides: s.factOverrides(), plan: s.renderedPlanOf(key) };
    });
    if (!data) return notFound(c, 'No such job.');
    const job = r.deep(data.job);
    const groups = ps.pack ? [...ps.pack.lexicon.strong, ...ps.pack.lexicon.medium, ...ps.pack.lexicon.gap] : [];
    const displays = new Map(groups.map((g) => [g.key, g.display ?? g.key]));
    const display = (k: string): string => r.text(displays.get(k) ?? k);
    const profile = profileFor(data.job.ats, data.job.url);
    const recommended: Recommended = { format: data.job.recommendedFormat ?? profile.recommended, atsName: ATS_SENTENCE[profile.id] ?? 'Most applicant systems' };
    const answers = ps.pack ? withCoverNote(ps.pack.answers, data.plan).map(([k, v]) => [r.text(humanKey(k)), r.text(typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v))] as const) : null;
    const banners = commonBanners(ps, istDate(at), data.overrides);
    if (job.unplaced.length > 0) {
      banners.push({ tone: 'warn', text: `Some of your facts don't fall inside any role's dates — fix the dates in your pack: ${job.unplaced.join(', ')}` });
    }
    const notice = c.req.query('notice');
    const flash = notice !== undefined && Object.hasOwn(NOTICE, notice) ? NOTICE[notice] : undefined;
    const body = jobBody({ job, csrf: csrf(c), sent: data.sent, answers, display, recommended, preferred: data.preferred, istDay: istDate, ...(flash !== undefined ? { flash } : {}) });
    return page(c, 'jobs', job.title, banners, body);
  });

  app.post('/jobs/:key/status', async (c) => {
    const key = c.req.param('key');
    const body = await c.req.parseBody();
    const to = body['to'];
    if (!JOB_KEY.test(key) || typeof to !== 'string' || !(JOB_STATUSES as readonly string[]).includes(to)) return c.text('Bad request', 400);
    const at = now();
    const day = istDate(at);
    const result = withStore((s) => {
      const job = s.getJob(key);
      if (!job) return undefined;
      // The status first (its own transaction): a busy store answers 503 before any file is written.
      const changed = s.setStatus(key, to as JobStatus, 'user', at);
      let notice: 'nodocs' | 'keepfail' | 'keepbusy' | undefined;
      // A snapshot is "the documents you sent": made once, on a real transition INTO applied, for a job that has none.
      if (changed && to === 'applied' && job.status !== 'applied' && s.snapshots(key).length === 0) {
        const docs = job.docs.filter((d) => d.kind === 'resume' || d.kind === 'cover');
        if (job.docsState !== 'ready' || docs.length === 0) notice = 'nodocs';
        else {
          try {
            const files = snapshotApplied(paths.out, key, docs, day);
            hooks.beforeSnapshot?.();
            s.putSnapshot(key, day, files, at);
          } catch (e) {
            // The status is already saved: a busy store is a success with a pointer to Keep a copy, never a 503.
            if (isBusy(e)) notice = 'keepbusy';
            else notice = 'keepfail';
            console.error(`jobpilot dashboard: could not keep the applied documents of ${key}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      return { job: s.getJob(key), sent: sentData(s, c, key), notice };
    });
    if (!result?.job) return c.text('No such job', 404);
    if (!isHx(c)) return c.redirect(`/jobs/${key}${result.notice !== undefined ? `?notice=${result.notice}` : ''}#status`, 303);
    const flash = result.notice !== undefined ? NOTICE[result.notice] : undefined;
    return c.html(html`${statusSection(result.job, csrf(c), istDate, flash)}${sentSection(result.sent, true)}`.value);
  });

  // "Keep a copy of these documents now": the snapshot an apply could not make (applied elsewhere, or a failed copy).
  // Same confined helper, same rule: an applied job with ready documents and no snapshot yet.
  app.post('/jobs/:key/keep', (c) => {
    const key = c.req.param('key');
    if (!JOB_KEY.test(key)) return c.text('Bad request', 400);
    const at = now();
    const result = withStore((s) => {
      const job = s.getJob(key);
      if (!job) return { status: 404 as const, text: 'No such job' };
      if (!keepable(job, s.snapshots(key).length)) return { status: 409 as const, text: 'Nothing to keep: the job is not applied, its documents are not ready, or a copy is already kept.' };
      try {
        s.putSnapshot(key, istDate(at), snapshotApplied(paths.out, key, job.docs.filter((d) => d.kind === 'resume' || d.kind === 'cover'), istDate(at)), at);
      } catch (e) {
        if (isBusy(e)) throw e;
        return { status: 409 as const, text: `The documents could not be kept: ${e instanceof Error ? e.message : String(e)}` };
      }
      return { status: 200 as const, sent: sentData(s, c, key) };
    });
    if (result.status !== 200) return c.text(redactor(packState(deps.home, at).naming).text(result.text), result.status);
    if (!isHx(c)) return c.redirect(`/jobs/${key}#sent-h`, 303);
    return c.html(sentSection(result.sent).value);
  });

  app.post('/jobs/:key/note', async (c) => {
    const key = c.req.param('key');
    const note = (await c.req.parseBody())['note'];
    if (typeof note === 'string' && note.length > 4000) return c.text('Your note is longer than 4,000 characters', 400);
    if (!JOB_KEY.test(key) || typeof note !== 'string') return c.text('Bad request', 400);
    const ok = withStore((s) => {
      if (!s.getJob(key)) return false;
      s.setNote(key, note.replace(/\r\n/g, '\n'));
      return true;
    });
    if (!ok) return c.text('No such job', 404);
    if (!isHx(c)) return c.redirect(`/jobs/${key}#note-h`, 303);
    return c.html('Saved');
  });

  // --- files: only names the store recorded for this job --------------------------------------------------------------
  /** `exact`: serve the bytes as they are (sent snapshots); otherwise a current preview gets its fact tooltips. */
  const sendFile = (c: Context<Env>, read: ReadResult, name: string, downloadName: string, exact = false) => {
    if (!read.ok) {
      if (read.why === 'changed') return c.text('This file changed on disk after it was made, so it is not served. Run "jobpilot docs rebuild".', 409);
      if (read.why === 'absent') return c.text('This file is not on disk. Run "jobpilot docs rebuild".', 404);
      return c.text('This file is not served: it is not a plain file inside the documents folder.', 403);
    }
    const ext = name.slice(name.lastIndexOf('.') + 1);
    const headers: Record<string, string> = { 'content-type': CONTENT_TYPE[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' };
    if (ext === 'html') {
      headers['content-security-policy'] = PREVIEW_CSP;
      headers['content-disposition'] = 'inline';
      return c.body(exact ? new Uint8Array(read.bytes) : withFactTooltips(Buffer.from(read.bytes).toString('utf8')), 200, headers);
    }
    headers['content-security-policy'] = FILE_CSP;
    headers['content-disposition'] = `attachment; filename="${downloadName}"`;
    return c.body(new Uint8Array(read.bytes), 200, headers);
  };

  /**
   * Whether a GET came from a dashboard page (or was typed in): `Sec-Fetch-Site` is same-origin or none; a client
   * that sends no such header counts only with a same-origin Referer. A cross-site `<img src>` never records a download.
   */
  const fromDashboard = (c: Context<Env>): boolean => {
    const site = c.req.header('sec-fetch-site');
    if (site !== undefined) return site === 'same-origin' || site === 'none';
    return sameOrigin(new URL(c.req.url).origin, undefined, c.req.header('referer'));
  };

  const companySlug = (company: string, naming: NamingRules, key: string): string => {
    const shown = redactor(naming).text(company);
    const slug = shown === HIDDEN ? '' : asciiSlug(shown);
    return slug === '' ? key : slug;
  };

  app.get('/jobs/:key/files/:name', (c) => {
    const key = c.req.param('key');
    const name = c.req.param('name');
    if (!JOB_KEY.test(key) || !DOC_NAME.test(name)) return c.text('Not found', 404);
    const job = withStore((s) => s.getJob(key));
    const doc = job?.docs.find((d) => d.path === `${key}/${name}`);
    // Review I2: stale documents cite a fact the user rejected; they are never served.
    if (!job || !doc || job.docsState === 'stale') return c.text('Not found', 404);
    const naming = packState(deps.home, now()).naming;
    const read = readRecorded(paths.out, doc.path, doc.sha256);
    if (read.ok && doc.format !== 'html' && fromDashboard(c)) {
      // A download (not a preview) clicked on a dashboard page: remembered, so a later snapshot can say whether the kept
      // copy is what was downloaded. Best-effort: a short lock wait, and any failure only skips the record.
      try {
        const s = AppStore.open(paths.db, { timeoutMs: DOWNLOAD_RECORD_TIMEOUT_MS });
        try {
          s.recordDownload(key, name, doc.sha256, now());
        } finally {
          s.close();
        }
      } catch (e) {
        console.error(`jobpilot dashboard: download of ${key}/${name} not recorded: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return sendFile(c, read, name, `${doc.kind}-${companySlug(job.company, naming, key)}.${doc.format}`);
  });

  app.get('/jobs/:key/sent/:day/:name', (c) => {
    const { key, day, name } = c.req.param();
    if (!JOB_KEY.test(key) || !DAY.test(day) || !DOC_NAME.test(name)) return c.text('Not found', 404);
    const found = withStore((s) => {
      const job = s.getJob(key);
      const f = s.snapshots(key).find((x) => x.day === day)?.files.find((x) => x.path === `${key}/applied-${day}/${name}`);
      return job && f ? { job, f } : undefined;
    });
    if (!found) return c.text('Not found', 404);
    const naming = packState(deps.home, now()).naming;
    return sendFile(c, readRecorded(paths.out, found.f.path, found.f.sha256), name, `${found.f.kind}-${companySlug(found.job.company, naming, key)}-sent-${day}.${found.f.format}`, true);
  });

  // --- facts ----------------------------------------------------------------------------------------------------------
  const factRows = (ps: PackState, overrides: Record<string, Fact['status']>): FactRow[] => {
    if (!ps.pack) return [];
    const r = redactor(ps.naming);
    return ps.pack.facts.map((f) => {
      const over = Object.hasOwn(overrides, f.id) ? overrides[f.id] : undefined;
      let employer: string;
      try {
        employer = employerDisplay(f.employer, ps.naming);
      } catch {
        employer = HIDDEN;
      }
      return {
        id: f.id,
        idShown: r.text(f.id) === f.id,
        claim: r.text(f.claim),
        kind: f.kind,
        employer,
        period: f.period,
        status: over ?? f.status,
        packStatus: over !== undefined && over !== f.status ? f.status : null,
      };
    });
  };

  app.get('/facts', (c) => {
    const at = now();
    const ps = packState(deps.home, at);
    const overrides = withStore((s) => s.factOverrides());
    const body = factsBody({ facts: factRows(ps, overrides), csrf: csrf(c), packError: ps.error ?? null });
    return page(c, 'facts', 'Your facts', commonBanners(ps, istDate(at), overrides), body);
  });

  for (const [verb, status] of [['verify', 'verified'], ['reject', 'rejected']] as const) {
    app.post(`/facts/:id/${verb}`, (c) => {
      const id = c.req.param('id');
      const at = now();
      const ps = packState(deps.home, at);
      if (!ps.pack) return c.text('Your pack could not be read, so facts cannot be changed now.', 409);
      const fact = ps.pack.facts.find((f) => f.id === id);
      if (!fact || redactor(ps.naming).text(id) !== id) return c.text('No such fact', 404);
      // rereview R3: the override and the stale pass are one transaction, so a rejected claim is never served again
      const { overrides, changed } = withStore((s) => {
        const changed = overrideFact(s, ps.pack?.facts ?? [], id, status, at, diskDocCheck(paths.out));
        return { overrides: s.factOverrides(), changed };
      });
      if (!isHx(c)) return c.redirect(`/facts#fact-${encodeURIComponent(id)}`, 303);
      const row = factRows(ps, overrides).find((f) => f.id === id) as FactRow;
      const note = changed.stale.length > 0
        ? `Saved. The documents of ${changed.stale.length} ${changed.stale.length === 1 ? 'job cite' : 'jobs cite'} this fact; they are set aside now, and the next run makes them again.`
        : 'Saved. The next run makes the affected documents again.';
      return c.html(factRow(row, csrf(c), note).value);
    });
  }

  // --- runs -----------------------------------------------------------------------------------------------------------
  app.get('/runs', (c) => {
    const at = now();
    const ps = packState(deps.home, at);
    const r = redactor(ps.naming);
    // dashboard-perf fix 1: the events after the last full check's checkpoint, or (no or mismatched checkpoint) a full walk
    const { runs, chain, overrides } = withStore((s) => ({ runs: s.listRuns(14), chain: chainStatus(s.kernel, at), overrides: s.factOverrides() }));
    const banners = commonBanners(ps, istDate(at), overrides);
    if (!chain.ok) banners.unshift({ tone: 'critical', text: r.text(`The audit log is broken (${chain.reason}). Something changed the recorded history; run "jobpilot audit verify --db ${paths.db}" and keep a copy of the database before anything else.`) });
    if (chain.ok && chain.check.kind === 'since') {
      const age = daysBetween(istDate(chain.check.fullAt), istDate(at));
      if (age > FULL_CHECK_STALE_DAYS) {
        banners.push({ tone: 'warn', text: `The audit log's last full check was ${age} days ago (${dateText(istDate(chain.check.fullAt))}). Coverage runs it weekly; run "jobpilot audit verify" now.` });
      }
    }
    return page(c, 'runs', 'Runs', banners, runsBody({ runs: r.deep(runs), chain, istTime: istTimeText }));
  });

  // --- freelance (Task 10): same middleware, same helpers ----------------------------------------------------------------
  mountFreelance(app, {
    paths, now, withStore, packState: (at) => packState(deps.home, at), redactor, page, csrf, isHx, isBusy,
    ...(hooks.beforeSnapshot !== undefined ? { beforeSnapshot: hooks.beforeSnapshot } : {}),
    ...(deps.gmailConnected !== undefined ? { gmailConnected: deps.gmailConnected } : {}),
  });

  // --- companies (career-sites Task 11): same middleware, same helpers --------------------------------------------------
  mountCompanies(app, {
    home: deps.home, now, clock: deps.clock, withStore, packState: (at) => packState(deps.home, at), redactor, page, csrf,
    ...(deps.resolve !== undefined ? { resolve: deps.resolve } : {}),
  });

  app.notFound((c) => notFound(c, 'There is no page at this address.'));
  app.onError((err, c) => {
    if (err instanceof UpgradePending || err instanceof SchemaBehindError) {
      const missing = err instanceof UpgradePending && err.why === 'missing';
      if (c.req.method === 'POST' || c.req.header('hx-request') === 'true') return c.text(missing ? NO_DATABASE_MESSAGE : UPGRADE_MESSAGE, 503, { 'retry-after': '30' });
      c.header('retry-after', '30');
      return missing
        ? page(c, 'jobs', 'No database yet', [], html`<h1>Nothing to show yet</h1><p>There is no database yet; the first run creates it (<code>jobpilot run</code>, or wait for the scheduled one).</p>`, 503)
        : page(c, 'jobs', 'Upgrading', [], html`<h1>One moment</h1><p>jobpilot is being upgraded; the next run (or <code>jobpilot facts list</code>) applies it. This page works again as soon as it has.</p>`, 503);
    }
    if (isBusy(err)) {
      if (c.req.method === 'POST' || c.req.header('hx-request') === 'true') return c.text(BUSY_MESSAGE, 503, { 'retry-after': '5' });
      return page(c, 'jobs', 'Busy', [], html`<h1>One moment</h1><p>${BUSY_MESSAGE}</p>`, 503);
    }
    if (err instanceof NamingUnreadable) return page(c, 'jobs', 'Cannot show', [], html`<h1>Cannot show your data</h1><p>${err.message}</p>`, 500);
    // final I9: the message, on the page and in the log, goes through the one redactor; with no readable naming rules
    // it is not shown at all
    const naming = namingOnly(paths.pack);
    const message = naming === undefined ? 'the details are hidden: naming.yaml could not be read' : redactText(err instanceof Error ? err.message : String(err), naming);
    console.error(`jobpilot dashboard error: ${message}`);
    return page(c, 'jobs', 'Error', [], html`<h1>Something went wrong</h1><p>${message}</p>`, 500);
  });
  return app;
}

/**
 * The CSRF secret kept in app_settings: created once (random), so tokens survive a restart of the dashboard. The
 * dashboard never creates or migrates the database (review I2): with no database yet, or a kernel schema that is not
 * this code's, or no app_settings table, the secret is this process's own (tokens then do not survive a restart).
 */
function keptSecret(db: string, timeoutMs: number): Buffer {
  const state = schemaState(db);
  if (state !== 'current' && state !== 'behind') return ephemeralSecret();
  const peek = Store.openReadOnly(db);
  let usable: boolean;
  try {
    usable = (peek.db.pragma('user_version', { simple: true }) as number) === MIGRATIONS.length
      && peek.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'`).get() !== undefined;
  } finally {
    peek.close();
  }
  if (!usable) return ephemeralSecret();
  const k = Store.open(db, { timeoutMs });
  try {
    let hex = (k.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(CSRF_SECRET_KEY) as { value: string } | undefined)?.value;
    if (hex === undefined || !/^[0-9a-f]{64}$/.test(hex)) {
      hex = randomBytes(32).toString('hex');
      k.db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(CSRF_SECRET_KEY, hex);
    }
    return Buffer.from(hex, 'hex');
  } finally {
    k.close();
  }
}

function ephemeralSecret(): Buffer {
  console.error('jobpilot dashboard: no up-to-date database yet; this process keeps its own session secret until a restart');
  return randomBytes(32);
}

/** Serves the dashboard on 127.0.0.1 only (never all interfaces); Host must name this port. */
export function serveDashboard(deps: Omit<DashboardDeps, 'port'> & { readonly port?: number }, onListen?: (url: string) => void): ServerType {
  let bound: number | undefined = deps.port !== undefined && deps.port !== 0 ? deps.port : undefined;
  const app = createDashboard({ ...deps, port: () => bound ?? -1 });
  return serve({ fetch: app.fetch, hostname: '127.0.0.1', port: deps.port ?? DEFAULT_PORT }, (info) => {
    bound = info.port;
    onListen?.(`http://127.0.0.1:${info.port}/`);
    void warmDashboard(app, `127.0.0.1:${info.port}`).then((ms) => console.error(`jobpilot dashboard: warmed up in ${Math.round(ms)} ms`));
  });
}
