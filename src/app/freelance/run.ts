import type { Clock } from '../../kernel/clock.js';
import type { HostPacer } from '../../kernel/broker.js';
import type { PacerFactory } from '../pacer.js';
import type { FetchLike } from '../../kernel/providers.js';
import type { RunReport } from '../../kernel/supervisor.js';
import { diskDocCheck } from '../docs-check.js';
import { ensureHome } from '../home.js';
import { freelanceKernel, loadRunPack, resolvePdftotext } from '../kernel.js';
import { withLock } from '../lock.js';
import type { Notifier } from '../notify.js';
import { homePaths } from '../pack/paths.js';
import { forbiddenTermStrict } from '../pack/rules.js';
import type { Naming } from '../pack/schema.js';
import { runProblems, safeLine, skipNoteProblems, sourceSkipWarnings, type Problem } from '../problems.js';
import { runCounts, type AgentCounts, type RunCounts } from '../project.js';
import { exitCodeOf, istDate, istMonth, nonceOf, pickRunId, sourcesAllReplayed } from '../run.js';
import { AppStore, BOARD_SEED_DAYS, type GigView } from '../store/app-store.js';
import { foreignSourceStep, recordSourceHealth } from './health.js';
import { GMAIL_LABEL_MISSING } from './mail/google.js';
import { GMAIL_OFF, type GmailRunAccess } from './mail/oauth.js';
import { presetTierUsd } from './gig-eligibility.js';
import { freelanceSeeds } from './pipeline.js';
import { projectFreelanceRun, type GigProjectResult } from './project.js';
import { rankGigs, RED } from './rank.js';
import type { Platform, ScoredGig } from './types.js';

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const IST_OFFSET_MS = 330 * 60_000;
/** The pm window's start (IST); the same instant `FREELANCE_DUE` uses. */
const PM_FROM_MINUTES = 19 * 60 + 30;

/** The half of the IST day at `now`: `pm` from 19:30 IST, else `am` (before 07:30 is that day's am, as a manual run). */
export function halfOf(now: string): 'am' | 'pm' {
  const t = Date.parse(now);
  if (Number.isNaN(t)) throw new Error(`not an ISO time: ${now}`);
  const minutes = new Date(t + IST_OFFSET_MS).getUTCHours() * 60 + new Date(t + IST_OFFSET_MS).getUTCMinutes();
  return minutes >= PM_FROM_MINUTES ? 'pm' : 'am';
}

export const FREELANCE_REPLAY_HINT = 'All gig sources were already fetched in this half; the next half fetches again';

export interface FreelanceRunOptions {
  readonly home: string;
  readonly clock: Clock;
  readonly fetch: FetchLike;
  /** Posts the notification. Absent (`--no-notify`): nothing is posted and no gig is marked announced. */
  readonly notifier?: Notifier;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pdftotext?: string;
  readonly afterStep?: (count: number) => void;
  readonly afterProject?: () => void;
  readonly onLocked?: () => void;
  readonly codeHash?: string;
  /**
   * Gmail for this run (`gmailRunAccess` over the Keychain in the CLI), asked only when `platforms.gmail` is enabled.
   * Absent, not connected or a Keychain error: the gmail source is not seeded and a warning names the reason; the run
   * goes on.
   */
  readonly gmail?: () => GmailRunAccess;
  /**
   * The HTTPS online check (`pacedHttpsOnline`), given the supervisor's per-host pacer, which its probes must wait on: a
   * network failure while it says offline is not final; the step is re-queued once it passes (the supervisor's wake
   * rule). Absent (tests, fixtures): only failures just after a detected wake are re-queued.
   */
  readonly online?: (pacer: HostPacer) => Promise<boolean>;
  /** The machine-wide pacer factory (`machinePacerFactory`) of a live run; absent (tests, offline fixtures): in-memory pacers. */
  readonly pacerFactory?: PacerFactory;
}

export interface FreelanceSummary {
  readonly runId: string;
  readonly runDate: string;
  readonly half: 'am' | 'pm';
  readonly asOf: string;
  readonly resumed: boolean;
  readonly report: RunReport;
  readonly counts: RunCounts;
  readonly projection: Omit<GigProjectResult, 'rows'>;
  readonly problems: readonly Problem[];
  readonly notification: string;
  readonly notified: boolean;
  readonly packHash: string;
  readonly fullPackHash: string;
  readonly policyHash: string;
  readonly warnings: string[];
  readonly exitCode: 0 | 1;
}

const PLATFORM_NAME: Readonly<Record<Platform, string>> = {
  freelancer: 'Freelancer',
  remotive: 'Remotive',
  'hn-freelancer': 'HN',
  'hn-hiring': 'HN',
  boards: 'Boards',
  gmail: 'Gmail',
  upwork: 'Upwork',
  reddit: 'Reddit',
  himalayas: 'Himalayas',
  draftdev: 'Draft.dev',
  'prime-intellect': 'Prime Intellect',
  'fractional-jobs': 'Fractional Jobs',
};

const TITLE_MAX = 40;
const oneLine = (s: string): string => s.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
/** At most TITLE_MAX characters; a longer title is cut to TITLE_MAX - 1 and ends with an ellipsis. */
const shortTitle = (t: string): string => {
  const cps = [...oneLine(t)];
  return cps.length <= TITLE_MAX ? cps.join('') : `${cps.slice(0, TITLE_MAX - 1).join('').trimEnd()}…`;
};
/** Whole US dollars, rounded down, so the banner never overstates the pay. */
const dollars = (n: number): string => String(Math.floor(n));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

type RateLike = { maxUsdH: number | null; minUsdH: number | null; budgetUsd: number | null; method: string };

/**
 * A ranking stand-in for a stored row: exactly the fields `rankGigs` orders by (red flags, maxUsdH, fit, postedAt,
 * gigKey) and the list it is in, so the notification and the dashboard order rows the same way. Cast: rankGigs reads
 * nothing else.
 */
export function rankable(g: GigView, list: ScoredGig['list'] = 'gigs'): ScoredGig {
  const rate = (g.rate ?? { maxUsdH: null }) as RateLike;
  return {
    risked: { flags: g.flags, verdict: { rated: { rate, gig: { gigKey: g.gigKey, postedAt: g.postedAt } } } },
    fit: g.fit ?? 0,
    list,
    breakdown: {},
  } as unknown as ScoredGig;
}

/**
 * The notification text (spec §1, Task 9): `<N> new gigs, <K> at ≥$<floor>/h · top: $<maxUsdH>/h <title ≤ 40>
 * (<Platform>)` (`1 new gig`), where `, <K> at ≥$<floor>/h` counts the gigs whose known hourly maximum is at least the
 * floor and is left out when there are none (final review M6: an unknown rate is never claimed to be above it), where the gigs are the newly shortlisted ones (Contracts or Gigs, documents ready, never announced)
 * and the top is the first of them in `rankGigs` order that has no red flag. When the top's hourly rate is unknown (an
 * eligible fixed-price gig) it shows `budget $<budgetUsd>` instead, or `preset tier $<lo>–<hi>` when the gig was
 * posted in a platform's preset tier (final review I1), and `$?/h` when the budget is unknown too. None:
 * `No new gigs this morning` (am) or `… this evening` (pm). Then ` · <k> problems` when the run had any. One line,
 * never a forbidden term: if the top holds one only the count is shown, and if even that would, `jobpilot freelance
 * run finished`.
 */
export function gigNotificationFor(fresh: readonly GigView[], o: { readonly rateFloor: number; readonly half: 'am' | 'pm'; readonly naming: Pick<Naming, 'forbiddenTerms'>; readonly problems: number }): string {
  const tail = o.problems > 0 ? ` · ${plural(o.problems, 'problem', 'problems')}` : '';
  const clean = (s: string): string | undefined => (forbiddenTermStrict(s, o.naming) === undefined ? s : undefined);
  const fallback = 'jobpilot freelance run finished';
  if (fresh.length === 0) return clean(`No new gigs this ${o.half === 'am' ? 'morning' : 'evening'}${tail}`) ?? fallback;
  // Final review M6: only gigs with a known hourly maximum at or above the floor are counted as "at ≥$X/h".
  const atFloor = fresh.filter((g) => {
    const max = (g.rate as RateLike | null)?.maxUsdH ?? null;
    return max !== null && max >= o.rateFloor;
  }).length;
  const count = `${plural(fresh.length, 'new gig', 'new gigs')}${atFloor > 0 ? `, ${atFloor} at ≥$${dollars(o.rateFloor)}/h` : ''}`;
  const byKey = new Map(fresh.map((g) => [g.gigKey, g]));
  const candidates = rankGigs(fresh.map((g) => rankable(g)), 0).gigs.filter((s) => s.risked.flags.every((f) => !RED.has(f.id)));
  const topRow = candidates[0];
  const top = topRow === undefined ? undefined : byKey.get(topRow.risked.verdict.rated.gig.gigKey);
  if (top === undefined) return clean(`${count}${tail}`) ?? fallback;
  const rate = (top.rate ?? { maxUsdH: null, budgetUsd: null }) as RateLike;
  const tier = rate.maxUsdH === null ? presetTierUsd(top) : null;
  const pay =
    rate.maxUsdH !== null ? `$${dollars(rate.maxUsdH)}/h`
    : tier !== null ? `preset tier $${dollars(Math.round(tier.lo))}–${dollars(Math.round(tier.hi))}`
    : rate.budgetUsd !== null ? `budget $${dollars(rate.budgetUsd)}`
    : '$?/h';
  const full = oneLine(`${count} · top: ${pay} ${shortTitle(top.title)} (${PLATFORM_NAME[top.platform as Platform] ?? top.platform})${tail}`);
  return clean(full) ?? clean(`${count}${tail}`) ?? fallback;
}

/**
 * The newly shortlisted gigs: Contracts or Gigs, documents ready, not yet announced, still `new` (final review M7: a
 * gig the user already applied to, skipped or otherwise moved on is never announced), duplicate listings excluded.
 */
export const freshGigs = (app: AppStore): GigView[] =>
  app.listGigs().filter((g) => (g.list === 'contracts' || g.list === 'gigs') && g.docsState === 'ready' && g.notifiedAt === null && g.status === 'new');

/**
 * `jobpilot run-freelance`: one freelance run under the run lock (spec §3, §8), the freelance counterpart of `runDaily`:
 * 1. load the pack (overrides, `experience.asOf` = the IST month, the kept `render.nonce`) and wire
 *    `jobpilot-freelance@1.0.0` (`freelanceKernel`);
 * 2. seed (`freelanceSeeds`): Freelancer one request per query, Remotive one, HN two, Gmail one when connected (else
 *    a warning names why it is off), and one `boards` request per stored daily contract posting seen in the last BOARD_SEED_DAYS (14) days and not skipped or rejected
 *    (`AppStore.contractPostings`), all dated with the IST date and half;
 * 3. run as `freelance-<date>-<am|pm>` (a completed one moves to `-2`, a crashed one is resumed), project into the gig
 *    tables, count source health and name every problem (a dead source and each quarantined alert email included);
 * 4. notify once per newly shortlisted gig (`notified_at`; only a posted notification announces);
 * 5. record the run in `gig_runs_summary`.
 * A second run in the same half replays every step at $0 (the seeds carry the date and half).
 */
export function runFreelance(o: FreelanceRunOptions): Promise<FreelanceSummary> {
  return withLock(o.home, 'run-freelance', async () => {
    o.onLocked?.();
    const paths = homePaths(o.home);
    ensureHome(paths.home);
    const pdftotext = o.pdftotext ?? resolvePdftotext();
    const app = AppStore.open(paths.db, { schema: 'migrate' }); // inside the run lock
    try {
      const now = o.clock.now();
      const runDate = istDate(now);
      const half = halfOf(now);
      const loaded = loadRunPack(paths.pack, app.factOverrides(), istMonth(now), nonceOf(app), 'freelance');
      const rules = loaded.pack.freelance;
      let gmail: GmailRunAccess = GMAIL_OFF;
      if (rules.platforms.gmail.enabled && o.gmail !== undefined) {
        try {
          gmail = o.gmail();
        } catch (e) {
          gmail = { ...GMAIL_OFF, reason: `Gmail could not be prepared (${e instanceof Error ? e.message : String(e)}); Gmail skipped` };
        }
      }
      const k = freelanceKernel({ store: app.kernel, loaded, outDir: paths.out, clock: o.clock, sleep: o.sleep ?? realSleep, fetch: gmail.wrap(o.fetch), pdftotext, ...(o.afterStep ? { afterStep: o.afterStep } : {}), ...(o.codeHash !== undefined ? { codeHash: o.codeHash } : {}), ...(o.online !== undefined ? { online: o.online } : {}), ...(o.pacerFactory !== undefined ? { pacerFactory: o.pacerFactory } : {}) });
      const prefix = `freelance-${runDate}-${half}`;
      const { runId, resume, skipped } = pickRunId(app.kernel, prefix, k.policyHash);
      const warnings = [...loaded.warnings, ...skipped.map((id) => `run ${id} did not complete and used another policy, so it was not resumed; it stays incomplete`)];
      warnings.push(
        ...app.kernel
          .incompleteRuns()
          .filter((r) => r.run_id.startsWith('freelance-') && !r.run_id.startsWith(prefix) && !skipped.includes(r.run_id))
          .map((r) => `run ${r.run_id} never completed and is from an earlier half; it will not be resumed`),
      );
      const boards = rules.platforms.boards.enabled ? app.contractPostings(new Date(Date.parse(now) - BOARD_SEED_DAYS * 86_400_000).toISOString()) : { postings: [], missing: [] };
      if (boards.missing.length > 0) warnings.push(`${plural(boards.missing.length, 'stored contract job has', 'stored contract jobs have')} no stored posting (a Desk import) and ${boards.missing.length === 1 ? 'is' : 'are'} not seeded`);
      if (rules.platforms.gmail.enabled && !gmail.connected) warnings.push(gmail.reason ?? GMAIL_OFF.reason ?? 'Gmail is off');
      const seeds = freelanceSeeds(rules, runDate, half, boards.postings.map((p) => p.posting), { gmailConnected: gmail.connected });
      if (seeds.length === 0) warnings.push('no gig platform is enabled: nothing was fetched');
      const report = resume ? await k.supervisor.resume(runId) : await k.supervisor.start(runId, seeds);
      // One transaction: the gig rows and the run's source health are written together, or neither is.
      const { projected, health } = app.tx(() => {
        const p = projectFreelanceRun(app.kernel, app, runId, { fitFloor: rules.fitFloor, docOnDisk: diskDocCheck(paths.out) });
        return { projected: p, health: recordSourceHealth(app.kernel, app, runId, { runDate, half, fitFloor: rules.fitFloor, rows: p.rows }) };
      });
      const { rows: _rows, ...projection } = projected;
      const counts = runCounts(app.kernel, runId);
      if (sourcesAllReplayed(counts)) warnings.push(FREELANCE_REPLAY_HINT);
      // The Gmail source's notes are quarantined alerts (problems, below) or a missing label (a warning), never
      // malformed postings.
      warnings.push(...sourceSkipWarnings(app.kernel, runId, loaded.pack.naming, ['src-gig-mail']));
      const mailNotes = skipNoteProblems(app.kernel, runId, 'src-gig-mail', loaded.pack.naming);
      if (mailNotes.some((p) => p.reason === GMAIL_LABEL_MISSING)) warnings.push(GMAIL_LABEL_MISSING);
      const foreignSkip = (agent: string, input: { type: string; payload: unknown }, status: string) => status === 'skipped' && foreignSourceStep(agent, input);
      const problems = [
        ...runProblems(app.kernel, runId, loaded.pack.naming, foreignSkip),
        ...mailNotes.filter((p) => p.reason !== GMAIL_LABEL_MISSING),
        ...health.map((p) => ({ ...p, item: safeLine(p.item, loaded.pack.naming), reason: safeLine(p.reason, loaded.pack.naming) })),
      ];
      o.afterProject?.();
      const fresh = freshGigs(app);
      const notification = gigNotificationFor(fresh, { rateFloor: rules.rateFloorUsdHour, half, naming: loaded.pack.naming, problems: problems.length });
      let notified = false;
      if (o.notifier === undefined) {
        if (fresh.length > 0) warnings.push(`not announced (--no-notify): ${fresh.length}`);
      } else {
        try {
          await o.notifier(notification);
          notified = true;
        } catch (e) {
          warnings.push(`the notification could not be posted: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (notified) app.markGigsNotified(fresh.map((g) => g.gigKey), now);
      }
      app.recordGigRun({ runId, at: now, counts, packHash: loaded.freelancePackHash, policyHash: k.policyHash, warnings, problems });
      return {
        runId, runDate, half, asOf: loaded.asOf, resumed: resume, report, counts, projection, problems, notification, notified,
        packHash: loaded.freelancePackHash, fullPackHash: loaded.freelanceFullPackHash, policyHash: k.policyHash, warnings, exitCode: exitCodeOf(report, problems),
      };
    } finally {
      app.close();
    }
  });
}

const COLUMNS = ['done', 'replayed', 'failed', 'gone', 'inputRejected', 'skipped', 'quarantined'] as const satisfies readonly (keyof AgentCounts)[];
const HEAD: Readonly<Record<(typeof COLUMNS)[number], string>> = {
  done: 'done', replayed: 'replayed', failed: 'failed', gone: 'gone', inputRejected: 'rejected', skipped: 'skipped', quarantined: 'quarantined',
};

/** The freelance run summary as the CLI prints it. */
export function formatFreelanceSummary(s: FreelanceSummary): string {
  const lines = [`run ${s.runId} for ${s.runDate} ${s.half} (experience as of ${s.asOf})${s.resumed ? ', resumed' : ''}: ${s.report.status}`];
  const agents = Object.keys(s.counts.byAgent);
  const w = Math.max(5, ...agents.map((a) => a.length));
  lines.push(`${'agent'.padEnd(w)}  ${COLUMNS.map((c) => HEAD[c]).join('  ')}`);
  const row = (name: string, c: AgentCounts) => `${name.padEnd(w)}  ${COLUMNS.map((k) => String(c[k]).padStart(HEAD[k].length)).join('  ')}`;
  for (const a of agents) lines.push(row(a, s.counts.byAgent[a] as AgentCounts));
  lines.push(row('total', s.counts.totals));
  const p = s.projection;
  const l = p.lists;
  lines.push(`gigs: ${p.gigs} written (${p.inserted} new, ${p.stale} stale skipped); contracts ${l.contracts}, gigs ${l.gigs}, review ${l.review}, below-floor ${l['below-floor']}, rejected ${l.rejected}, unscored ${l.unscored}`);
  lines.push(`docs ready ${p.docs.ready}, blocked ${p.docs.blocked}, missing ${p.docs.missing}, none ${p.docs.none}`);
  if (s.problems.length > 0) {
    lines.push(`problems: ${s.problems.length}`);
    for (const q of s.problems) lines.push(`  ${q.kind.padEnd(14)} ${q.agent}  ${q.item}: ${q.reason}`);
  }
  lines.push(`notification: ${s.notification}`);
  lines.push(`pack ${s.packHash.slice(0, 12)}, full pack ${s.fullPackHash.slice(0, 12)}, policy ${s.policyHash.slice(0, 12)}`);
  for (const warning of s.warnings) lines.push(`warning: ${warning}`);
  return lines.join('\n');
}
