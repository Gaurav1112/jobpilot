import type { AgentContext } from '../../kernel/agent.js';
import { KernelError } from '../../kernel/errors.js';
import { isChallenge } from '../challenge.js';
import { networkKind } from '../net.js';
import { robotsDenial, robotsVerdictOf, type RobotsVerdict } from './robots.js';

/**
 * The coverage run's politeness gate, shared by every agent of a run that fetches a company's pages (the careers
 * locator and the platform detector). One `RunGate` per coverage run holds the run-scoped host state; each step opens
 * a `stepFetcher` on it, which applies the same rules to every request:
 *
 * - robots.txt is fetched once per host per run (whoever asks first) and honoured for every request. Its outcome is
 *   either an ANSWER, kept for the run: 404/410 allows all; 401/403 disallows the host (`robots-forbidden`); any other
 *   3xx/4xx, a moved file or a host whose TLS certificate is invalid or that refuses the connection disallows it
 *   (`robots-unavailable`, RFC 9309's conservative choice); DNS saying the name does not exist, while the machine is
 *   online, disallows it (`no-such-host`); 429 disables the host. Or it is TRANSIENT (C1): a network error, a timeout
 *   (a step abort included) or a 5xx is never cached; the host is disabled as `robots-transient` for
 *   TRANSIENT_DISABLE_MS only, and robots.txt is asked again after that.
 * - A host that answers with a challenge page (403/429/503 plus a marker from a closed list), 401, 403 or 429 is
 *   DISABLED for the rest of the run (a 429 for HTTP_429_EXPIRY_MS): no retry, no more requests by any step. A step
 *   that meets a host disabled by another step gets the reason `host-disabled:<why>`.
 * - A request that fails transiently is a miss marked `transient` (its transport code): a step whose outcome rests on
 *   one must FAIL with that code (never a finished "none"), so the kernel's breaker sees an outage and the step is
 *   asked again later in the run (the coverage pipeline re-queues it).
 * - OFFLINE_AFTER_NETWORK_ERRORS network errors in a row ask the offline check (`online`, the daily run's DNS probe);
 *   when it says offline, `offline()` turns true and the coverage run pauses its slice (`offline`).
 * - Redirects are followed by hand, at most MAX_HOPS, and only to hosts the step planned; a redirect to an unplanned
 *   host that `acceptMoved` admits ends the request as `moved` (unfetched), any other is a miss.
 * - Each step has a request budget; beyond it the step's fetcher throws `BudgetExhausted`.
 * - The honest user agent and the per-host spacing are the broker's (HTTP_HEADERS, the supervisor's host pacer).
 *
 * Memo safety: a disabled host is written to the store BEFORE the step that caused it returns (`RunGate.disable`), and
 * a result that depends on another step's disable must not be returned as a finished result (`refuseSiblingDependent`).
 */

export const MAX_HOPS = 5;
/**
 * The longest one request may take (body included) before it is given up as a transient miss with the reason
 * `timeout`. A timeout is NOT a refusal: a page that times out does not disable its host. A robots.txt that times out
 * is transient (C1): never cached, the host is off for TRANSIENT_DISABLE_MS only.
 */
export const REQUEST_TIMEOUT_MS = 15_000;
/**
 * One step's wall-clock deadline (the injected clock), under the agents' 120 s step timeout: no request starts after
 * it, and the step ends with what it has (the locator: `none` with `budget-exhausted:time`).
 */
export const CANDIDATE_DEADLINE_MS = 90_000;

/** A challenge page: 403/429/503 with a known marker in the body (`challenge.ts`, shared with the platform adapters). */
export { isChallenge } from '../challenge.js';

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
  /** When each disabled host was disabled (ISO): a disable in DISABLE_EXPIRY_MS expires after its time. */
  readonly since: Map<string, string>;
}

/**
 * A 429 ("slow down") disable is lifted after this long within the run, so a week-long run is not barred from a host
 * for the rest of the week by one rate limit.
 */
export const HTTP_429_EXPIRY_MS = 24 * 60 * 60_000;
/** A host whose robots.txt failed transiently (a network error, a timeout, a 5xx) is off this long, then asked again (C1). */
export const TRANSIENT_DISABLE_MS = 60 * 60_000;
/**
 * The disables that expire within the run, and after how long. Every other one (401, 403, a challenge, a robots.txt
 * answer that refuses, `no-such-host`) lasts the whole run.
 */
export const DISABLE_EXPIRY_MS: Readonly<Record<string, number>> = Object.freeze({ 'http-429': HTTP_429_EXPIRY_MS, 'robots-transient': TRANSIENT_DISABLE_MS });
/**
 * The disables that are the host's own refusal of jobpilot (C1-e): they stop every request to the host, a
 * documented public API read too. A robots.txt state (`robots-unavailable`, `robots-transient`, `no-such-host`) set
 * by page crawling does not stop a read that is exempt from robots.txt.
 */
export const REFUSALS: ReadonlySet<string> = new Set(['http-401', 'http-403', 'http-429', 'challenge']);
/** Network errors in a row (no answer between them) after which the gate asks whether the machine is offline. */
export const OFFLINE_AFTER_NETWORK_ERRORS = 5;
/** How long (the injected clock) one answer of the offline check is reused. */
export const ONLINE_CHECK_TTL_MS = 30_000;
/**
 * Re-check m5: a positive online check under this age is reused instead of probing again, provided a real HTTP answer
 * has come since it (so the network is known to have worked after it; behind a portal no answer comes, and it is
 * asked again).
 */
export const ONLINE_REUSE_MS = 60_000;
/** The transport code of a transient miss: the code a step resting on it fails with. */
export type TransientCode = 'network' | 'timeout' | 'overloaded';

/** Where a run's disabled hosts are kept durably (the app's `AppStore` implements it). */
export interface HostStateStore {
  coverageHostState(runKey: string): ReadonlyMap<string, string>;
  /** When each host was disabled (ISO). */
  coverageHostTimes(runKey: string): ReadonlyMap<string, string>;
  disableCoverageHost(runKey: string, host: string, reason: string, at: string): void;
  /** Lifts a disable (an expired 429). */
  enableCoverageHost(runKey: string, host: string): void;
}

/** One coverage run's host state, shared by every fetching agent of the run. */
export interface RunGate {
  readonly runKey: string;
  readonly state: HostState;
  /** Disables `host` for the run: durable first (when a store is given), then visible to the next step. Idempotent. */
  disable(host: string, why: string, at: string): void;
  /** Why `host` is disabled at `now`, or undefined; an expired disable (DISABLE_EXPIRY_MS) is lifted (durably) here. */
  disabledWhy(host: string, now: string): string | undefined;
  /** Whether this gate found the machine offline (OFFLINE_AFTER_NETWORK_ERRORS network errors in a row, then the check). */
  offline(): boolean;
  /**
   * One request's transport outcome: a real HTTP answer resets the count of transport errors in a row and confirms
   * every disable made since; an error of any kind (a refused connection and a bad certificate included, R1) adds one.
   */
  noteTransport(outcome: 'answer' | 'network-error', now: string): Promise<void>;
  /** The offline check (`online`): a positive answer is reused for ONLINE_CHECK_TTL_MS while fewer than OFFLINE_AFTER_NETWORK_ERRORS errors follow it. */
  isOnline(now: string): Promise<boolean>;
  /** The number of transport events so far (requests that answered or failed): a position to compare against. */
  seq(): number;
  /** A run-long disable caused by a transport error (no answer, R1): undone if the machine turns out to be offline. */
  markProvisional(host: string): void;
  /**
   * Was the network proven to work at or after transport event `since` (a real answer, or a positive online check)?
   * If not, asks the online check now; offline undoes the provisional disables.
   */
  settled(since: number, now: string): Promise<boolean>;
}

/**
 * The gate for ONE coverage run. Build it inside each run, with that run's key (the run id the supervisor resumes
 * under, e.g. `coverage-2026-10-13`), and hand the same gate to every agent of the run; never keep one in a long-lived
 * process. `runKey` and `store` are required: the hosts disabled before a crash are loaded again for the same key, and
 * every disable is written to the store before it is visible. Tests and evals pass `memoryHostStateStore()` explicitly.
 * robots.txt verdicts are not persisted: after a crash each host's robots.txt is fetched once more.
 */
export function makeRunGate(opts: {
  readonly runKey: string;
  readonly store: HostStateStore;
  /**
   * Is the machine online (the coverage run passes `dnsOnline`)? Asked before a name DNS does not know becomes
   * `no-such-host`, and after OFFLINE_AFTER_NETWORK_ERRORS network errors in a row. Default: online (tests, evals).
   */
  readonly online?: () => Promise<boolean>;
}): RunGate {
  const state: HostState = { robots: new Map(), disabled: new Map(), since: new Map() };
  const { runKey, store } = opts;
  const online = opts.online ?? (async () => true);
  for (const [h, why] of store.coverageHostState(runKey)) state.disabled.set(h, why);
  for (const [h, at] of store.coverageHostTimes(runKey)) state.since.set(h, at);
  let errorsInARow = 0;
  let offline = false;
  let events = 0;
  let lastAnswer = 0;
  let checked: { readonly at: number; readonly seq: number; readonly online: boolean } | undefined;
  /** The transport position of the last reuse of a positive check (re-check m5). */
  let reusedAt = 0;
  /** Run-long disables caused by transport errors since the last real answer (R1). */
  const provisional = new Set<string>();
  const goOffline = (): void => {
    offline = true;
    // every miss since the last real answer was the outage's, not the hosts': nothing of it is kept for the run
    for (const h of provisional) {
      store.enableCoverageHost(runKey, h);
      state.disabled.delete(h);
      state.since.delete(h);
      state.robots.delete(h);
    }
    provisional.clear();
  };
  const check = async (now: string): Promise<boolean> => {
    const t = Date.parse(now);
    if (checked?.online === true && t >= checked.at && t - checked.at < ONLINE_REUSE_MS && lastAnswer > Math.max(checked.seq, reusedAt)) {
      // reused once per real answer (the next reuse needs another answer after this point); never proof for `settled`
      reusedAt = events;
      errorsInARow = 0;
      return true;
    }
    const on = await online();
    checked = { at: Date.parse(now), seq: events, online: on };
    if (on) errorsInARow = 0;
    else goOffline();
    return on;
  };
  const isOnline = async (now: string): Promise<boolean> => {
    if (offline) return false;
    const t = Date.parse(now);
    const fresh = checked !== undefined && t >= checked.at && t - checked.at < ONLINE_CHECK_TTL_MS;
    if (fresh && checked?.online === false) return false;
    if (fresh && checked?.online === true && errorsInARow < OFFLINE_AFTER_NETWORK_ERRORS) return true;
    return check(now);
  };
  return {
    runKey,
    state,
    disable(host, why, at) {
      if (state.disabled.has(host)) return;
      store.disableCoverageHost(runKey, host, why, at); // durable first, then visible to the next step
      state.disabled.set(host, why);
      state.since.set(host, at);
    },
    disabledWhy(host, now) {
      const why = state.disabled.get(host);
      if (why === undefined || !Object.hasOwn(DISABLE_EXPIRY_MS, why)) return why;
      const since = Date.parse(state.since.get(host) ?? '');
      if (Number.isNaN(since) || Date.parse(now) - since < (DISABLE_EXPIRY_MS[why] as number)) return why;
      store.enableCoverageHost(runKey, host);
      state.disabled.delete(host);
      state.since.delete(host);
      return undefined;
    },
    offline: () => offline,
    async noteTransport(outcome, now) {
      events++;
      if (outcome === 'answer') {
        errorsInARow = 0;
        lastAnswer = events;
        provisional.clear();
        return;
      }
      errorsInARow++;
      if (errorsInARow >= OFFLINE_AFTER_NETWORK_ERRORS && !offline) await check(now);
    },
    isOnline,
    seq: () => events,
    markProvisional(host) {
      if (offline) {
        // re-check m4: marked after the machine was found offline: undone at once, never kept for the run
        provisional.add(host);
        goOffline();
      } else if (lastAnswer < events) provisional.add(host);
    },
    async settled(since, now) {
      if (offline) return false;
      if (lastAnswer > since) return true;
      if (checked?.online === true && checked.seq >= since) return true;
      return check(now);
    },
  };
}

/** A HostStateStore held in memory only: for tests and evals, which pass it explicitly. A crash loses it. */
export function memoryHostStateStore(): HostStateStore {
  const rows = new Map<string, Map<string, { reason: string; at: string }>>();
  const sorted = (runKey: string) => [...(rows.get(runKey) ?? new Map<string, { reason: string; at: string }>())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    coverageHostState: (runKey) => new Map(sorted(runKey).map(([h, v]) => [h, v.reason])),
    coverageHostTimes: (runKey) => new Map(sorted(runKey).map(([h, v]) => [h, v.at])),
    disableCoverageHost(runKey, host, reason, at) {
      const m = rows.get(runKey) ?? new Map<string, { reason: string; at: string }>();
      if (!m.has(host)) m.set(host, { reason, at });
      rows.set(runKey, m);
    },
    enableCoverageHost(runKey, host) {
      rows.get(runKey)?.delete(host);
    },
  };
}

/** How a coverage agent gets its run's host state: the run's shared gate, or a key and store to build its own from. */
export type GateSource = { readonly gate: RunGate } | { readonly runKey: string; readonly store: HostStateStore };

export const gateOf = (o: GateSource): RunGate => ('gate' in o ? o.gate : makeRunGate({ runKey: o.runKey, store: o.store }));

/** A step's limits: its request budget, the per-request timeout and its wall-clock deadline. */
export interface StepLimits {
  readonly maxRequests: number;
  readonly requestTimeoutMs?: number;
  readonly deadlineMs?: number;
}

/** The limits from an agent factory's options; `maxRequests` falls back to the agent's own default. */
export function limitsOf(o: Partial<StepLimits>, maxRequests: number): StepLimits {
  return {
    maxRequests: o.maxRequests ?? maxRequests,
    ...(o.requestTimeoutMs !== undefined ? { requestTimeoutMs: o.requestTimeoutMs } : {}),
    ...(o.deadlineMs !== undefined ? { deadlineMs: o.deadlineMs } : {}),
  };
}

/** A step ran out of its request budget (`requests`) or its wall-clock deadline (`time`). */
export class BudgetExhausted extends Error {
  constructor(readonly kind: 'requests' | 'time' = 'requests') {
    super(`budget exhausted: ${kind}`);
  }
}

/** The reason a step records for an exhausted budget: `budget-exhausted`, or `budget-exhausted:time` past its deadline. */
export const budgetReason = (e: BudgetExhausted): string => (e.kind === 'time' ? 'budget-exhausted:time' : 'budget-exhausted');

/** The reason of a host DNS does not know while the machine is online: kept for the run (it is not a real host). */
export const NO_SUCH_HOST = 'no-such-host';

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
  /** `transient`: the miss is an outage, a timeout or an overloaded host (its code), not a fact about the page. */
  | {
      readonly kind: 'miss';
      readonly reason: string;
      readonly transient?: TransientCode;
      /** A definitive transport error (no such host, a refused connection, a bad certificate): no HTTP answer (R1). */
      readonly transport?: true;
    }
  | { readonly kind: 'challenge'; readonly reason: string };

/** The transport code when `r` is transient (a transient miss, or a 5xx answer); else null. */
export function transientOf(r: Fetched): TransientCode | null {
  if (r.kind === 'miss') return r.transient ?? null;
  if (r.kind === 'ok' && r.status >= 500 && r.status < 600) return 'overloaded';
  return null;
}

/**
 * Throws the transport failure a step's outcome rests on (C1): the first of `codes`, naming the reasons. A step
 * resting on a transient miss must fail (the breaker counts it; the run re-queues it), never finish as "not found".
 */
export function failTransient(codes: readonly TransientCode[], reasons: readonly string[]): void {
  const code = codes[0];
  if (code === undefined) return;
  throw new KernelError(code, `transient: the outcome rests on a failure that may pass (${reasons.slice(0, 6).join('; ')}); asked again later in the run`);
}

export interface StepFetcher {
  /** One request with up to MAX_HOPS manual redirects. `checkRobots` is off only for robots.txt itself. */
  fetchUrl(start: string, checkRobots: boolean): Promise<Fetched>;
  /**
   * R1: before a step finishes on its misses, `network` when one of them was a transport error (a refused connection,
   * a bad certificate, no such host) that nothing has proven to be the host's own since (no real answer, no positive
   * online check after it) and the online check now says offline; else null.
   */
  settle(): Promise<TransientCode | null>;
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
  /** Per-request timeout; default REQUEST_TIMEOUT_MS. */
  readonly requestTimeoutMs?: number;
  /** The step's wall-clock deadline from its start (the context's clock); default CANDIDATE_DEADLINE_MS. */
  readonly deadlineMs?: number;
}): StepFetcher {
  const { ctx, gate, planned, acceptMoved, maxRequests } = o;
  const timeoutMs = o.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const deadline = Date.parse(ctx.clock.now()) + (o.deadlineMs ?? CANDIDATE_DEADLINE_MS);
  const state = gate.state;
  /** Hosts THIS step's own requests disabled: its refusals are its own outcome, unlike a sibling's. */
  const own = new Set<string>();
  const disable = (host: string, why: string, at: string): void => {
    if (!state.disabled.has(host)) own.add(host);
    gate.disable(host, why, at);
  };
  const skipReason = (host: string, why: string): string => (own.has(host) ? `${why} (${host})` : `${HOST_DISABLED}${why} on ${host}`);
  /** This step's own transient robots.txt failures, by host: a later request of the step to the host is transient too. */
  const ownTransient = new Map<string, TransientCode>();
  const skipMiss = (host: string, why: string): Fetched => {
    const code = own.has(host) ? ownTransient.get(host) : undefined;
    return { kind: 'miss', reason: skipReason(host, why), ...(code !== undefined ? { transient: code } : {}) };
  };
  if (!ctx.http) throw new KernelError('policy_denied', 'no http capability issued');
  const http = ctx.http;
  let requests = 0;
  /** The gate's transport position at this step's last definitive transport miss (R1), or null. */
  let lastTransportMiss: number | null = null;
  /** Hosts whose robots.txt verdict came from a transport error, not an answer (R1: provisional until proven). */
  const transportVerdicts = new Set<string>();

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
      const off = gate.disabledWhy(host, ctx.clock.now());
      if (off !== undefined) return skipMiss(host, off);
      if (checkRobots) {
        const verdict = await robotsFor(host);
        const denial = robotsDenial(verdict, u);
        if (denial !== null) return { kind: 'miss', reason: `${denial} (${host})`, ...(verdict.kind === 'disallow-all' && verdict.transient !== undefined ? { transient: verdict.transient } : {}) };
        const off2 = gate.disabledWhy(host, ctx.clock.now());
        if (off2 !== undefined) return skipMiss(host, off2);
      }
      // robots.txt is shared by the whole run, so it is counted but never refused by one step's budget
      if (checkRobots && requests >= maxRequests) throw new BudgetExhausted('requests');
      if (Date.parse(ctx.clock.now()) >= deadline) throw new BudgetExhausted('time');
      requests++;
      let page;
      try {
        page = await http.getPage(u.href, { timeoutMs });
      } catch (e) {
        if (e instanceof KernelError) return transportMiss(e, u);
        throw e;
      }
      await gate.noteTransport('answer', ctx.clock.now());
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

  /**
   * A request that failed in transport, as a miss: transient (a network error, a timeout, a step abort, an overloaded
   * host; counted towards the offline check), or definitive (no such host while online, a refused connection, an
   * invalid certificate, any other kernel refusal).
   */
  async function transportMiss(e: KernelError, u: URL): Promise<Fetched> {
    const now = ctx.clock.now();
    const where = `${u.hostname}${u.pathname}`;
    if (e.code === 'timeout' || e.code === 'unknown') {
      // a step abort is this step's end, not the network's state: it is not counted towards the offline check
      if (!ctx.signal.aborted) await gate.noteTransport('network-error', now);
      return { kind: 'miss', reason: `timeout: ${e.message}`, transient: 'timeout' };
    }
    if (e.code === 'overloaded') return { kind: 'miss', reason: `overloaded: ${where}`, transient: 'overloaded' };
    if (e.code !== 'network') return { kind: 'miss', reason: `${e.code}: ${where}` };
    // R1: every transport error counts towards the offline check, a refused connection and a bad certificate too
    // (behind a captive portal or a TLS-intercepting proxy every host looks like that); only a real answer resets it
    await gate.noteTransport('network-error', now);
    const kind = networkKind(e);
    const sys = e.sysCode !== undefined ? ` (${e.sysCode})` : '';
    // re-check m4: the error that made the offline check fail is the outage's too, never a fact about the host
    if (gate.offline() || kind === 'transient') return { kind: 'miss', reason: `network: ${where}${sys}`, transient: 'network' };
    if (kind === 'no-such-host' && !(await gate.isOnline(now))) return { kind: 'miss', reason: `network: ${where}${sys}`, transient: 'network' };
    // a fact about this host, provided the network is proven to work around it (`settle`, `markProvisional`)
    lastTransportMiss = gate.seq();
    return kind === 'no-such-host' ? { kind: 'miss', reason: `${NO_SUCH_HOST}: ${u.hostname}`, transport: true } : { kind: 'miss', reason: `network: ${where}${sys}`, transport: true };
  }

  async function settle(): Promise<TransientCode | null> {
    if (lastTransportMiss === null) return null;
    return (await gate.settled(lastTransportMiss, ctx.clock.now())) ? null : 'network';
  }

  function robotsFor(host: string): Promise<RobotsVerdict> {
    const cached = state.robots.get(host);
    if (cached !== undefined) return cached;
    const p = (async (): Promise<RobotsVerdict> => {
      let verdict: RobotsVerdict;
      try {
        verdict = await robotsVerdict(host);
      } catch (e) {
        // BudgetExhausted belongs to the step that asked: forget the fetch, the next asker tries again
        if (e instanceof BudgetExhausted) {
          state.robots.delete(host);
          throw e;
        }
        // an unexpected error rethrown by the broker: not an answer about the host, so transient
        const name = e instanceof Error ? e.name : 'error';
        verdict = { kind: 'disallow-all', reason: 'robots-transient', why: name, transient: name === 'TimeoutError' ? 'timeout' : 'network' };
      }
      if (verdict.kind === 'disallow-all' && verdict.reason === 'robots-transient') {
        // C1: never cached; the host is off for TRANSIENT_DISABLE_MS only, then robots.txt is asked again
        state.robots.delete(host);
        disable(host, 'robots-transient', ctx.clock.now());
        if (own.has(host)) ownTransient.set(host, verdict.transient ?? 'network');
        return verdict;
      }
      if (verdict.kind === 'disallow-all') {
        disable(host, verdict.reason, ctx.clock.now());
        if (transportVerdicts.has(host)) gate.markProvisional(host);
      }
      return verdict;
    })();
    state.robots.set(host, p);
    return p;
  }

  async function robotsVerdict(host: string): Promise<RobotsVerdict> {
    const r = await fetchUrl(`https://${host}/robots.txt`, false);
    if (r.kind === 'challenge') return { kind: 'allow-all', why: r.reason }; // the host is disabled; the caller sees that
    if (r.kind === 'miss' && r.transient !== undefined) return { kind: 'disallow-all', reason: 'robots-transient', why: r.reason, transient: r.transient };
    if (r.kind === 'miss' && r.transport === true) transportVerdicts.add(host);
    if (r.kind === 'miss' && r.reason.startsWith(`${NO_SUCH_HOST}:`)) return { kind: 'disallow-all', reason: NO_SUCH_HOST, why: r.reason };
    if (r.kind === 'miss' || r.kind === 'moved') return { kind: 'disallow-all', reason: 'robots-unavailable', why: r.kind === 'miss' ? r.reason : 'robots.txt moved off the planned hosts' };
    const verdict = robotsVerdictOf(r.status, r.body);
    // final review N3: a robots.txt reached by redirect (www -> apex) is the target host's own robots.txt too; an
    // allowing answer is kept for it, so it is not asked again two seconds later (a refusal is left to its own fetch)
    const target = new URL(r.url);
    const other = target.hostname.toLowerCase();
    if (other !== host && target.pathname === '/robots.txt' && target.search === '' && verdict.kind !== 'disallow-all' && !state.robots.has(other)) state.robots.set(other, Promise.resolve(verdict));
    return verdict;
  }

  return { fetchUrl, robotsFor, settle };
}
