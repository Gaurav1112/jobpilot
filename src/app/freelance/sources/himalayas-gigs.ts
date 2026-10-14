import { defineAgent, type Agent } from '../../../kernel/agent.js';
import { defineContract, type Contract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import { SOURCE_TIMEOUT_MS } from '../../agents/sources/common.js';
import { indiaEligible } from '../../agents/sources/himalayas.js';
import { hasChallengeMarker, isChallenge } from '../../challenge.js';
import { parseRobots, robotsAllows, type Robots } from '../../coverage/robots.js';
import { GigRequest, RawGig } from '../types.js';
import { finishGigs, idOf, isRecord } from './common.js';

/**
 * `src-himalayas-gigs` (freelance-boost): Himalayas' free public JSON API (himalayas.app/api, read 2026-10-14: "no
 * authentication"; attribute Himalayas and link back to its job page), one search per skill of the pack's freelance
 * keywords (`platforms.himalayas.queries`), filtered to contractor and part-time work open to India:
 *
 *   https://himalayas.app/jobs/api/search?q=<skill>&employment_type=Contractor,Part%20Time&country=India&sort=recent
 *
 * - **Terms.** `url` (and `sourceId`) is the job's own himalayas.app page (`guid`), so every gig links back to the
 *   posting; the dashboard names the platform "Himalayas" on every row. The honest user agent is the broker's; nothing
 *   is resubmitted anywhere.
 * - **robots.txt** is read once per run per host (`himalayasGigsHosts`) and its rules are applied to every request.
 *   Himalayas serves its robots.txt with HTTP 404 but a full body (2026-10-14), so a body with rules is honoured
 *   whatever the status (stricter than RFC 9309, which would allow all on a 404). That body disallows
 *   `/jobs*&page=`, so this source **never pages**: it reads page 1 only (the API's 20 newest), and when the
 *   envelope's `totalCount` says more exist it records the loud note `himalayas <q>: N more not read (page 1 only:
 *   robots.txt disallows paging under /jobs)`. A disallowed URL is the named skip `robots-disallow …`, no request.
 * - **Pacing and refusals.** At least HIMALAYAS_GIGS_MIN_INTERVAL_MS between requests to the host (on top of the run's
 *   pacer). A 401/403 or a challenge page disables the host for the run (`challenged`), a 429 disables it
 *   (`rate_limit`, never retried: the contract retries only `overloaded`, `network`, `timeout`; Retry-After is never
 *   read); a later request on a disabled host is `input_rejected` `host-disabled:<why>`, sent nowhere. A redirect is
 *   refused by the broker. A 5xx is `overloaded`.
 * - **Shape.** A body that is not JSON with a `jobs` array is `invalid_output`. A job without `guid` or `title` is a
 *   named skip; every job failing is schema drift (`invalid_output`). A job whose `locationRestrictions` do not admit
 *   India (`indiaEligible`, the daily source's rule) is left out, as the daily source does.
 * - **raw** keeps `title, companyName, employmentType, minSalary, maxSalary, salaryPeriod, currency,
 *   locationRestrictions, timezoneRestrictions, description, pubDate, guid`; `expiryDate` (request-time), the logo
 *   and the category lists are dropped.
 */
export const HIMALAYAS_GIGS_HOST = 'himalayas.app';
export const HIMALAYAS_GIGS_MIN_INTERVAL_MS = 2000;
/** The employment types asked for: contract and part-time work only. */
export const HIMALAYAS_GIGS_TYPES = 'Contractor,Part Time';

export const himalayasGigsUrl = (query: string): string =>
  `https://${HIMALAYAS_GIGS_HOST}/jobs/api/search?q=${encodeURIComponent(query)}&employment_type=${encodeURIComponent(HIMALAYAS_GIGS_TYPES)}&country=India&sort=recent`;
export const HIMALAYAS_ROBOTS_URL = `https://${HIMALAYAS_GIGS_HOST}/robots.txt`;

const KEPT = ['title', 'companyName', 'employmentType', 'minSalary', 'maxSalary', 'salaryPeriod', 'currency', 'locationRestrictions', 'timezoneRestrictions', 'description', 'pubDate', 'guid'] as const;

/** The run's view of the Himalayas host: robots.txt once, and whether the host was disabled in this run. */
export interface HimalayasGigsHosts {
  robots(): Robots | 'allow-all' | undefined;
  setRobots(v: Robots | 'allow-all'): void;
  disabledWhy(): string | undefined;
  disable(why: string): void;
}

/** Fresh host state for one run (the freelance wiring builds one per run, so nothing outlives it). */
export function himalayasGigsHosts(): HimalayasGigsHosts {
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

export function srcHimalayasGigsContract(): Contract<GigRequest, RawGig> {
  return defineContract({
    id: 'src-himalayas-gigs',
    version: '1.0.0',
    description: 'Fetches contract or part-time jobs open to India from the Himalayas search API for one skill',
    skills: ['gig-sourcing'],
    // A team of its own: its breaker opens on its own failures only, never the other sources' (pipeline.ts).
    team: 'sourcing-himalayas',
    kind: 'io',
    consumes: GigRequest,
    produces: RawGig,
    capabilities: { http: true },
    egress: [HIMALAYAS_GIGS_HOST],
    dataClasses: { in: ['P0'], out: ['P0'] },
    budget: { usdPerCall: 0, usdPerRun: 0 },
    timeoutMs: SOURCE_TIMEOUT_MS,
    // Never `rate_limit`: a 429 disables the host for the run instead (no retry around a refusal).
    retry: { max: 2, on: ['overloaded', 'network', 'timeout'], backoffMs: [2000, 8000] },
  });
}

/** A refusal: the host is disabled for the run and the step fails with the named code. */
function refuse(hosts: HimalayasGigsHosts, why: string, code: 'challenged' | 'rate_limit', detail: string): never {
  hosts.disable(why);
  throw new KernelError(code, `${HIMALAYAS_GIGS_HOST} ${detail}: the host is disabled for this run, never retried around`);
}

/** Maps a response status (and body) to a refusal, a transport failure, or nothing (2xx). */
function checkStatus(hosts: HimalayasGigsHosts, status: number, body: string, what: string): void {
  if (isChallenge(status, body)) refuse(hosts, 'challenge', 'challenged', `answered ${what} with a challenge page (${status})`);
  if (status === 429) refuse(hosts, 'http-429', 'rate_limit', `answered ${what} with 429`);
  if (status === 401 || status === 403) refuse(hosts, `http-${status}`, 'challenged', `answered ${what} with ${status}`);
  if (status >= 500) throw new KernelError('overloaded', `${HIMALAYAS_GIGS_HOST} answered ${what} with ${status}`);
}

/** A robots.txt body with at least one rule group is honoured, whatever its status (see the module comment). */
function robotsOf(status: number, body: string): Robots | 'allow-all' | 'disallow-all' {
  const parsed = parseRobots(body);
  if (parsed.groups.length > 0) return parsed;
  if (status === 404 || status === 410) return 'allow-all';
  if (status >= 200 && status < 300) return parsed;
  return 'disallow-all';
}

export function makeSrcHimalayasGigs(hosts: HimalayasGigsHosts = himalayasGigsHosts()): Agent<GigRequest, RawGig> {
  return defineAgent(srcHimalayasGigsContract(), async (req, ctx) => {
    if (req.platform !== 'himalayas') return [];
    if (!ctx.http) throw new KernelError('policy_denied', 'no http capability issued');
    const http = ctx.http;
    const off = (): void => {
      const why = hosts.disabledWhy();
      if (why !== undefined) throw new KernelError('input_rejected', `host-disabled:${why} on ${HIMALAYAS_GIGS_HOST}; himalayas ${req.query} deferred to the next run, never retried around`);
    };
    off();
    const url = himalayasGigsUrl(req.query);
    let robots = hosts.robots();
    if (robots === undefined) {
      const r = await http.getPage(HIMALAYAS_ROBOTS_URL, { minIntervalMs: HIMALAYAS_GIGS_MIN_INTERVAL_MS });
      checkStatus(hosts, r.status, r.body, 'its robots.txt');
      if (r.status >= 300 && r.status < 400) refuse(hosts, 'robots-unavailable', 'challenged', `redirected its robots.txt (${r.status})`);
      const v = robotsOf(r.status, r.body);
      if (v === 'disallow-all') refuse(hosts, 'robots-unavailable', 'challenged', `answered its robots.txt with ${r.status}`);
      hosts.setRobots(v);
      robots = v;
    }
    const u = new URL(url);
    if (robots !== 'allow-all' && !robotsAllows(robots, u.pathname + u.search)) {
      ctx.skipped([`robots-disallow ${HIMALAYAS_GIGS_HOST}: himalayas ${req.query} not read today (robots-disallow ${u.pathname})`]);
      return [];
    }
    const r = await http.getPage(url, { minIntervalMs: HIMALAYAS_GIGS_MIN_INTERVAL_MS });
    checkStatus(hosts, r.status, r.body, `the search for ${req.query}`);
    if (r.status === 404) throw new KernelError('gone', `himalayas search not found: ${req.query}`);
    if (r.status < 200 || r.status >= 300) throw new KernelError('invalid_output', `${HIMALAYAS_GIGS_HOST} returned ${r.status} for ${req.query}`);
    let json: unknown;
    try {
      json = JSON.parse(r.body);
    } catch {
      if (hasChallengeMarker(r.body)) refuse(hosts, 'challenge', 'challenged', `answered the search for ${req.query} with a challenge page`);
      throw new KernelError('invalid_output', `himalayas ${req.query}: the response is not JSON`);
    }
    if (!isRecord(json) || !Array.isArray(json.jobs)) throw new KernelError('invalid_output', `himalayas ${req.query}: no jobs array`);
    const gigs: RawGig[] = [];
    const skipped: string[] = [];
    json.jobs.forEach((job: unknown, i: number) => {
      const id = isRecord(job) ? idOf(job.guid) : undefined;
      if (!isRecord(job) || id === undefined || typeof job.title !== 'string' || job.title.trim() === '') {
        skipped.push(`himalayas ${req.query} job ${i}: missing guid or title`);
        return;
      }
      if (Array.isArray(job.locationRestrictions) && !indiaEligible(job.locationRestrictions)) return;
      const raw: Record<string, unknown> = {};
      for (const k of KEPT) raw[k] = job[k] ?? null;
      gigs.push({ platform: 'himalayas', sourceId: id, raw });
    });
    if (json.jobs.length > 0 && skipped.length === json.jobs.length) throw new KernelError('invalid_output', `himalayas ${req.query}: all ${json.jobs.length} jobs failed to parse`);
    const total = typeof json.totalCount === 'number' && Number.isFinite(json.totalCount) ? json.totalCount : null;
    if (total !== null && total > json.jobs.length) skipped.push(`himalayas ${req.query}: ${total - json.jobs.length} more not read (page 1 only: robots.txt disallows paging under /jobs)`);
    if (skipped.length > 0) ctx.skipped(skipped);
    return finishGigs(gigs);
  });
}

/** The agent for exports and tests; the run builds its own with fresh host state (`freelanceAgents`). */
export const srcHimalayasGigs = makeSrcHimalayasGigs();
