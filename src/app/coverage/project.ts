import type { AppStore, Company, CompanyStatus } from '../store/app-store.js';
import type { CareersSite, CompanyVerdict, PlatformGuess } from './types.js';

/**
 * The coverage run's projection into the `companies` registry (spec §3), and its weekly line. Coverage writes only
 * this table; the daily run reads it (`verifiedCompanies`) and never waits for it.
 *
 * - Every verdict is recorded with `upsertCompanyVerdict`: verified sets `last_verified` and resets `fail_weeks`; a
 *   failed verdict on a verified company adds a fail week and the third in a row makes it `failing` (never removed);
 *   the user's override always wins (a rejected company stays rejected, an approved one stays verified).
 * - A candidate whose careers site was not located (`method: none`) is recorded only when it matters: a user pick
 *   becomes Proposed with the locator's reasons (a pick is never dropped), and a company already verified or failing
 *   gets a failed verdict (its site stopped answering). Any other unlocated candidate is only counted in the summary,
 *   so a seed list's many unreachable sites do not flood the Proposed list.
 * - A candidate DEFERRED by a disabled host (its step failed `input_rejected`, `host-disabled:*`) is not projected at
 *   all: nothing is known about it this week.
 * - `countFailures: false` for a second coverage run in the same coverage week: its failed verdicts keep the fail count.
 * - A live company is never demoted by one week (`keepLive`). An APPROVED company still becomes `failing` after 3 failed
 *   weeks (accepted 2026-10-14): it stays readable by the daily run; the override decides membership, not health.
 */

export interface CoverageProjectInput {
  readonly verdicts: readonly CompanyVerdict[];
  /** Located nothing (`method: none`), not deferred. */
  readonly unlocated: readonly CareersSite[];
  readonly at: string;
  readonly countFailures: boolean;
}

export interface RegistryCounts {
  readonly verified: number;
  readonly proposed: number;
  readonly failing: number;
  readonly failed: number;
  readonly rejected: number;
}

export interface CoverageProjection {
  /** Companies verified now that were not verified before this projection (approved overrides excluded). */
  readonly newVerified: number;
  readonly unlocated: { readonly proposed: number; readonly failed: number; readonly counted: number };
  /** The whole registry after the projection. */
  readonly registry: RegistryCounts;
}

const LIVE: ReadonlySet<CompanyStatus> = new Set(['verified', 'failing']);

/** A detector verdict that says the careers page could not be read this week (not that the platform changed). */
const UNAVAILABLE = /^(?:unavailable|refused|unfetched|soft-404)\b|timeout|host-disabled/i;

/**
 * Review I-1: a company that is already live (verified or failing) is never demoted to Proposed by one week's verdict.
 * A Proposed verdict for it becomes a FAILED week (the stored platform and board are kept, fail_weeks + 1, 3 in a row
 * make it `failing`, still read by the daily run), with the reason first:
 * - `careers page unavailable this week: <why>` when the detector could not read the page (a 4xx/5xx, a refusal, a
 *   redirect it did not follow, a timeout, a disabled host);
 * - `platform signal changed, please confirm` when the page loaded but shows no platform, another platform whose board
 *   did not pass the verifier's gate, or the board itself no longer passes (0 jobs, another name).
 * A changed platform whose new board VERIFIES is an ordinary verified verdict: the company moves to the new board. An
 * approved company keeps its override's rule (a Proposed verdict leaves it verified). A company never live is untouched.
 */
function keepLive(v: CompanyVerdict, prev: Company | undefined): CompanyVerdict {
  if (v.status !== 'proposed' || prev === undefined || !LIVE.has(prev.status) || prev.userOverride === 'approved') return v;
  const why = v.guess.platform === null ? (v.guess.evidence[0] ?? '') : '';
  const first = v.guess.platform === null && UNAVAILABLE.test(why) ? `careers page unavailable this week: ${why}` : 'platform signal changed, please confirm';
  return { ...v, status: 'failed', reasons: [first, ...v.reasons] };
}

/**
 * D3: a board that came from freehire (catalogue or discovery) and failed to verify is Proposed, its reasons kept (a 404
 * included, `not verified: ` before the first), never `failed`: the user can reject it, and it is not counted as a
 * failing company. A live one still goes through `keepLive` afterwards.
 */
function freehireProposed(v: CompanyVerdict): CompanyVerdict {
  const src = v.guess.site.candidate.source;
  if (v.status !== 'failed' || (src !== 'freehire' && src !== 'freehire-discovery')) return v;
  const [first, ...rest] = v.reasons;
  return { ...v, status: 'proposed', reasons: [`not verified: ${first ?? 'no reason recorded'}`, ...rest] };
}

const unlocatedGuess = (s: CareersSite): PlatformGuess => ({ site: s, platform: null, slug: null, boardUrl: null, signature: null, routedFrom: null, evidence: ['not located'] });
const notLocated = (s: CareersSite): string => `careers site not located: ${(s.reasons ?? ['no probe found a careers page']).slice(0, 6).join('; ')}`;

/** The registry's counts by status. */
export function registryCounts(app: AppStore): RegistryCounts {
  const by = (status: CompanyStatus): number => app.listCompanies({ status }).length;
  return { verified: by('verified'), proposed: by('proposed'), failing: by('failing'), failed: by('failed'), rejected: by('rejected') };
}

/** Records the run's verdicts in one transaction; see the module comment for the rules. */
export function projectCoverage(app: AppStore, input: CoverageProjectInput): CoverageProjection {
  return app.tx(() => {
    const before = new Map(app.listCompanies().map((c) => [c.companyKey, c]));
    const opts = { countFailure: input.countFailures };
    for (const v of input.verdicts) app.upsertCompanyVerdict(keepLive(freehireProposed(v), before.get(v.guess.site.candidate.companyKey)), input.at, opts);
    const unlocated = { proposed: 0, failed: 0, counted: 0 };
    for (const s of input.unlocated) {
      const prev = before.get(s.candidate.companyKey);
      if (prev !== undefined && LIVE.has(prev.status)) {
        app.upsertCompanyVerdict({ guess: unlocatedGuess(s), status: 'failed', reasons: [notLocated(s)], boardName: null, jobsSeen: null }, input.at, opts);
        unlocated.failed++;
      } else if (s.candidate.source === 'pick') {
        app.upsertCompanyVerdict({ guess: unlocatedGuess(s), status: 'proposed', reasons: [notLocated(s)], boardName: null, jobsSeen: null }, input.at, opts);
        unlocated.proposed++;
      } else unlocated.counted++;
    }
    let newVerified = 0;
    for (const c of app.listCompanies({ status: 'verified' })) {
      const was = before.get(c.companyKey);
      if (c.userOverride !== 'approved' && (was === undefined || was.status !== 'verified')) newVerified++;
    }
    return { newVerified, unlocated, registry: registryCounts(app) };
  });
}

const MAX_HOSTS = 5;
const DEFERRAL = /host-disabled:([a-z0-9-]+) on ([a-z0-9.-]+)/gi;

/** The hosts that deferred steps, with why, from the deferred steps' details (`host-disabled:<why> on <host>`); once each, by host. */
export function deferralHosts(details: readonly string[]): [host: string, why: string][] {
  const out = new Map<string, string>();
  for (const d of details) for (const m of d.matchAll(DEFERRAL)) if (!out.has((m[2] as string).toLowerCase())) out.set((m[2] as string).toLowerCase(), m[1] as string);
  return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The deferral line (Task 3/5 carry): `not located this week: N, host-disabled <host> (<why>), …` when N > 0 steps
 * were deferred because a host was disabled in the run; every host that deferred a step is named once (at most 5, then
 * `and k more hosts`), so a host that refuses every week reads as one line, never as N "input rejected" problems.
 */
export function deferralLine(deferred: number, hosts: readonly (readonly [host: string, why: string])[], what: 'located' | 'verified' = 'located'): string | null {
  if (deferred <= 0) return null;
  const sorted = [...hosts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const named = sorted.slice(0, MAX_HOSTS).map(([h, why]) => `${h} (${why})`);
  const more = sorted.length > MAX_HOSTS ? ` and ${sorted.length - MAX_HOSTS} more hosts` : '';
  return `not ${what} this week: ${deferred}${named.length > 0 ? `, host-disabled ${named.join(', ')}${more}` : ''}`;
}

/**
 * The weekly line: `Coverage: N verified (+k new) · p proposed · f failing`, then ` · <deferral line>` for each one there
 * is: `not located this week: …` (locate and detect deferrals, carry 15) and `not verified this week: …` (verify).
 */
export function coverageNotification(
  r: { readonly verified: number; readonly newVerified: number; readonly proposed: number; readonly failing: number },
  deferral: string | null | readonly (string | null)[],
): string {
  const line = `Coverage: ${r.verified} verified (+${r.newVerified} new) · ${r.proposed} proposed · ${r.failing} failing`;
  const extra = (Array.isArray(deferral) ? deferral : [deferral]).filter((d): d is string => d !== null);
  return [line, ...extra].join(' · ');
}
