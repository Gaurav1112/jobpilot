import type { AgentContext } from '../../kernel/agent.js';
import { KernelError } from '../../kernel/errors.js';
import { parseRobots, robotsDenial, type RobotsVerdict } from './robots.js';

/**
 * The coverage run's politeness gate, shared by every agent of a run that fetches a company's pages (the careers
 * locator and the platform detector). One `RunGate` per coverage run holds the run-scoped host state; each step opens
 * a `stepFetcher` on it, which applies the same rules to every request:
 *
 * - robots.txt is fetched once per host per run (whoever asks first) and honoured for every request. 404/410 allows
 *   all; 401/403 disallows the host (`robots-forbidden`); any other 4xx, a 5xx or an unreachable host disallows it
 *   (`robots-unavailable`, RFC 9309's conservative choice); 429 disables the host.
 * - A host that answers with a challenge page (403/429/503 plus a marker from a closed list), 401, 403 or 429 is
 *   DISABLED for the rest of the run: no retry, no more requests by any step. A step that meets a host disabled by
 *   another step gets the reason `host-disabled:<why>`.
 * - Redirects are followed by hand, at most MAX_HOPS, and only to hosts the step planned; a redirect to an unplanned
 *   host that `acceptMoved` admits ends the request as `moved` (unfetched), any other is a miss.
 * - Each step has a request budget; beyond it the step's fetcher throws `BudgetExhausted`.
 * - The honest user agent and the per-host spacing are the broker's (HTTP_HEADERS, the supervisor's host pacer).
 *
 * Memo safety: a disabled host is written to the store BEFORE the step that caused it returns (`RunGate.disable`), and
 * a result that depends on another step's disable must not be returned as a finished result (`refuseSiblingDependent`).
 */

export const MAX_HOPS = 5;

/** Status codes that may carry a bot wall; with a marker in the body they are a challenge (a closed list, never extended at run time). */
const CHALLENGE_STATUS: ReadonlySet<number> = new Set([403, 429, 503]);
const CHALLENGE_MARKERS = /cf-chl|challenge-platform|captcha|Attention Required|px-captcha|Just a moment/i;

/** A challenge page: 403/429/503 with a known marker in the body. */
export function isChallenge(status: number, body: string): boolean {
  return CHALLENGE_STATUS.has(status) && CHALLENGE_MARKERS.test(body);
}

/** `https://host/...` for an http(s) URL string; null otherwise. A bare scheme-less value is not guessed. */
export function asHttps(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.protocol = 'https:';
  u.hash = '';
  return u;
}

/** What one run knows about hosts: robots.txt (once per host) and which hosts are disabled, and why. */
export interface HostState {
  readonly robots: Map<string, Promise<RobotsVerdict>>;
  readonly disabled: Map<string, string>;
}

/** Where a run's disabled hosts are kept durably (the app's `AppStore` implements it). */
export interface HostStateStore {
  coverageHostState(runKey: string): ReadonlyMap<string, string>;
  disableCoverageHost(runKey: string, host: string, reason: string, at: string): void;
}

/** One coverage run's host state, shared by every fetching agent of the run. */
export interface RunGate {
  readonly runKey: string;
  readonly state: HostState;
  /** Disables `host` for the run: durable first (when a store is given), then visible to the next step. Idempotent. */
  disable(host: string, why: string, at: string): void;
}

/**
 * The gate for ONE coverage run. Build it inside each run, with that run's key (the run id the supervisor resumes
 * under, e.g. `coverage-2026-10-13`), and hand the same gate to every agent of the run; never keep one in a long-lived
 * process. `runKey` and `store` are required: the hosts disabled before a crash are loaded again for the same key, and
 * every disable is written to the store before it is visible. Tests and evals pass `memoryHostStateStore()` explicitly.
 * robots.txt verdicts are not persisted: after a crash each host's robots.txt is fetched once more.
 */
export function makeRunGate(opts: { readonly runKey: string; readonly store: HostStateStore }): RunGate {
  const state: HostState = { robots: new Map(), disabled: new Map() };
  const { runKey, store } = opts;
  for (const [h, why] of store.coverageHostState(runKey)) state.disabled.set(h, why);
  return {
    runKey,
    state,
    disable(host, why, at) {
      if (state.disabled.has(host)) return;
      store.disableCoverageHost(runKey, host, why, at); // durable first, then visible to the next step
      state.disabled.set(host, why);
    },
  };
}

/** A HostStateStore held in memory only: for tests and evals, which pass it explicitly. A crash loses it. */
export function memoryHostStateStore(): HostStateStore {
  const rows = new Map<string, Map<string, string>>();
  return {
    coverageHostState: (runKey) => new Map([...(rows.get(runKey) ?? new Map<string, string>())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    disableCoverageHost(runKey, host, reason) {
      const m = rows.get(runKey) ?? new Map<string, string>();
      if (!m.has(host)) m.set(host, reason);
      rows.set(runKey, m);
    },
  };
}

/** How a coverage agent gets its run's host state: the run's shared gate, or a key and store to build its own from. */
export type GateSource = { readonly gate: RunGate } | { readonly runKey: string; readonly store: HostStateStore };

export const gateOf = (o: GateSource): RunGate => ('gate' in o ? o.gate : makeRunGate({ runKey: o.runKey, store: o.store }));

export class BudgetExhausted extends Error {}

/** The prefix of a reason that comes from state another step set: such a result is never stored as a finished step. */
export const HOST_DISABLED = 'host-disabled:';

/**
 * Throws `input_rejected` when any reason carries `host-disabled:*`: the outcome depends on a sibling's request, not
 * on the step's own input (a failed step is not replayed, it trips no breaker, and its detail names the reason).
 */
export function refuseSiblingDependent(reasons: readonly string[], found: string | null): void {
  const skipped = reasons.filter((r) => r.includes(HOST_DISABLED));
  if (skipped.length > 0) {
    throw new KernelError('input_rejected', `skipped by run state set by another candidate (${skipped.join('; ')})${found === null ? '' : `; found ${found}`}`);
  }
}

export type Fetched =
  | { readonly kind: 'ok'; readonly status: number; readonly body: string; readonly url: string }
  | { readonly kind: 'moved'; readonly url: string }
  | { readonly kind: 'miss'; readonly reason: string }
  | { readonly kind: 'challenge'; readonly reason: string };

export interface StepFetcher {
  /** One request with up to MAX_HOPS manual redirects. `checkRobots` is off only for robots.txt itself. */
  fetchUrl(start: string, checkRobots: boolean): Promise<Fetched>;
  /** The host's robots.txt for the run: fetched once, whoever asks first. Only settled verdicts are cached. */
  robotsFor(host: string): Promise<RobotsVerdict>;
}

/**
 * The fetcher of one step on the run's gate. `planned` are the hosts the step may contact (the egress set it was
 * planned for); `acceptMoved` admits an unplanned redirect target as `moved`.
 */
export function stepFetcher(o: {
  readonly ctx: AgentContext;
  readonly gate: RunGate;
  readonly planned: ReadonlySet<string>;
  readonly acceptMoved: (u: URL) => boolean;
  readonly maxRequests: number;
}): StepFetcher {
  const { ctx, gate, planned, acceptMoved, maxRequests } = o;
  const state = gate.state;
  /** Hosts THIS step's own requests disabled: its refusals are its own outcome, unlike a sibling's. */
  const own = new Set<string>();
  const disable = (host: string, why: string, at: string): void => {
    if (!state.disabled.has(host)) own.add(host);
    gate.disable(host, why, at);
  };
  const skipReason = (host: string, why: string): string => (own.has(host) ? `${why} (${host})` : `${HOST_DISABLED}${why} on ${host}`);
  if (!ctx.http) throw new KernelError('policy_denied', 'no http capability issued');
  const http = ctx.http;
  let requests = 0;

  async function fetchUrl(start: string, checkRobots: boolean): Promise<Fetched> {
    let url = start;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const u = asHttps(url);
      if (u === null) return { kind: 'miss', reason: `not an http(s) URL: ${url.slice(0, 80)}` };
      if (u.port !== '' || u.username !== '' || u.password !== '') return { kind: 'miss', reason: `port or credentials in URL: ${u.hostname}` };
      const host = u.hostname.toLowerCase();
      if (!planned.has(host)) {
        if (hop > 0 && acceptMoved(u)) return { kind: 'moved', url: u.href };
        return { kind: 'miss', reason: hop > 0 ? `redirect to ${host} (off-domain)` : `${host} is not a planned host` };
      }
      const off = state.disabled.get(host);
      if (off !== undefined) return { kind: 'miss', reason: skipReason(host, off) };
      if (checkRobots) {
        const denial = robotsDenial(await robotsFor(host), u);
        if (denial !== null) return { kind: 'miss', reason: `${denial} (${host})` };
        const off2 = state.disabled.get(host);
        if (off2 !== undefined) return { kind: 'miss', reason: skipReason(host, off2) };
      }
      // robots.txt is shared by the whole run, so it is counted but never refused by one step's budget
      if (checkRobots && requests >= maxRequests) throw new BudgetExhausted();
      requests++;
      let page;
      try {
        page = await http.getPage(u.href);
      } catch (e) {
        if (e instanceof KernelError) return { kind: 'miss', reason: `${e.code}: ${u.hostname}${u.pathname}` };
        throw e;
      }
      const challenge = isChallenge(page.status, page.body);
      // For robots.txt itself a plain 401/403 is the robots-forbidden verdict (robotsFor), not a disabled host.
      const plainDenied = page.status === 401 || page.status === 403;
      if (challenge || page.status === 429 || (plainDenied && checkRobots)) {
        const why = challenge ? 'challenge' : `http-${page.status}`;
        disable(host, why, ctx.clock.now());
        return { kind: 'challenge', reason: page.status === 429 && !challenge ? `rate-limited (429) on ${host}` : `${why} (${page.status}) on ${host}` };
      }
      if (page.status >= 300 && page.status < 400) {
        if (page.location === null) return { kind: 'miss', reason: `${page.status} without Location (${host}${u.pathname})` };
        try {
          url = new URL(page.location, u).href;
        } catch {
          return { kind: 'miss', reason: `bad redirect Location (${host}${u.pathname})` };
        }
        continue;
      }
      return { kind: 'ok', status: page.status, body: page.body, url: u.href };
    }
    return { kind: 'miss', reason: `more than ${MAX_HOPS} redirects from ${start.slice(0, 80)}` };
  }

  function robotsFor(host: string): Promise<RobotsVerdict> {
    const cached = state.robots.get(host);
    if (cached !== undefined) return cached;
    const p = (async (): Promise<RobotsVerdict> => {
      let verdict: RobotsVerdict;
      try {
        verdict = await robotsVerdict(host);
      } catch (e) {
        // e.g. a TimeoutError rethrown by the broker: the host is robots-unavailable for the run, never a cached rejection
        verdict = { kind: 'disallow-all', reason: 'robots-unavailable', why: e instanceof Error ? e.name : 'error' };
      }
      if (verdict.kind === 'disallow-all') disable(host, verdict.reason, ctx.clock.now());
      return verdict;
    })();
    state.robots.set(host, p);
    return p;
  }

  async function robotsVerdict(host: string): Promise<RobotsVerdict> {
    const r = await fetchUrl(`https://${host}/robots.txt`, false);
    if (r.kind === 'challenge') return { kind: 'allow-all', why: r.reason }; // the host is disabled; the caller sees that
    if (r.kind === 'miss' || r.kind === 'moved') return { kind: 'disallow-all', reason: 'robots-unavailable', why: r.kind === 'miss' ? r.reason : 'robots.txt moved off the planned hosts' };
    if (r.status === 404 || r.status === 410) return { kind: 'allow-all', why: `robots.txt ${r.status}` };
    if (r.status === 401 || r.status === 403) return { kind: 'disallow-all', reason: 'robots-forbidden', why: `robots.txt ${r.status}` };
    if (r.status >= 400) return { kind: 'disallow-all', reason: 'robots-unavailable', why: `robots.txt ${r.status}` };
    return { kind: 'rules', robots: parseRobots(r.body) };
  }

  return { fetchUrl, robotsFor };
}
