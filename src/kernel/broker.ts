import type { Clock } from './clock.js';
import { isSymbolicEgress, type AnyContract, type SymbolicEgress } from './contract.js';
import type { DataClass } from './data-class.js';
import type { Cost } from './envelope.js';
import { KernelError } from './errors.js';
import { egressAllowed, normalizeHost, type Policy } from './policy.js';
import { challengeReason } from './challenge.js';
import type { BrowserPage, FetchResponse, LlmResponse, Providers } from './providers.js';
import { createFiles, type FilesTool, type PendingFiles, type WritableFilesTool } from './files.js';

export type { FilesTool, WritableFilesTool } from './files.js';

export interface HttpTool {
  getText(url: string): Promise<{ status: number; body: string }>;
  /**
   * Like getText, then parses the body; a body that is not JSON is `invalid_output`.
   * A status of 400 or more is not parsed: the result is `{ status, json: null }` and the caller maps it.
   */
  getJson(url: string, opts?: RequestOptions): Promise<{ status: number; json: unknown }>;
  /** The raw body (for an archive or other binary file), under the same egress, pacing and size cap as getText. */
  getBytes(url: string): Promise<{ status: number; bytes: Uint8Array }>;
  /**
   * One GET whose answer is returned whatever the status: a 3xx comes back with its `Location` (never followed here, and
   * not a denial), a 429 or 5xx with its body, instead of the errors getText raises. For a caller that has its own rules
   * for redirects and bot walls (the careers locator). Same egress, https-only, pacing and size cap as getText.
   */
  getPage(url: string, opts?: RequestOptions): Promise<{ status: number; body: string; location: string | null }>;
  /**
   * One POST of a JSON body (`JSON.stringify(body)`, at most POST_BODY_MAX_BYTES), parsed like getJson: a status of 400
   * or more is `{ status, json: null }`, a body that is not JSON is `invalid_output`. For a platform whose public page
   * itself queries its job list with a POST (Workday's CXS search). The same egress, https-only, pacing, size cap,
   * timeout and honest headers as getJson (plus `content-type: application/json`); a redirect is refused, 429 is
   * `rate_limit`, a 5xx `overloaded`. Only for a contract declaring `capabilities.httpPost`; for any other it is a
   * policy denial.
   */
  postJson(url: string, body: unknown, opts?: RequestOptions): Promise<{ status: number; json: unknown }>;
  /**
   * One GET whose 2xx body is handed to `onText` chunk by chunk as it arrives (UTF-8 decoded in streaming mode, so a
   * character split across chunks is whole), never held whole: for a feed larger than the policy's response cap
   * (SuccessFactors' `sitemal.xml`). The caller names its byte cap (`maxBytes`): past it the stream is cancelled and the
   * result says `capped: true` (a `content-length` over the cap is refused before any byte is read), so a caller can
   * fail loudly instead of truncating. `onText` returning `false` stops the read (`stopped: true`). A cap above the
   * policy's `maxResponseBytes` needs `capabilities.httpStream`, and is never above STREAM_MAX_BYTES. A non-2xx answer
   * is not streamed: it comes back with `location` and at most STREAM_ERROR_BODY_BYTES of its body (for a bot-wall
   * check), like getPage. Same egress, https-only, pacing, timeout and honest headers as getPage.
   */
  getStream(url: string, onText: (text: string) => boolean | void, opts: StreamOptions): Promise<StreamResult>;
}

/** getStream's options: getPage's, plus the byte cap. */
export interface StreamOptions extends RequestOptions {
  readonly maxBytes: number;
}

export interface StreamResult {
  readonly status: number;
  readonly location: string | null;
  /** The bytes of a 2xx body read (0 for a refused content-length). */
  readonly bytes: number;
  /** The cap was reached: the stream was cancelled, the text handed over is incomplete. */
  readonly capped: boolean;
  /** `onText` asked to stop. */
  readonly stopped: boolean;
  /** A non-2xx answer's body, at most STREAM_ERROR_BODY_BYTES; absent for a 2xx. */
  readonly body?: string;
}

/** The largest cap getStream accepts, whatever the contract declares. */
export const STREAM_MAX_BYTES = 64 * 1024 * 1024;
/** How much of a non-2xx streamed answer is kept, for a bot-wall check. */
export const STREAM_ERROR_BODY_BYTES = 64 * 1024;

/**
 * Per-request options (getPage and getJson). `timeoutMs`: the request, body included, is aborted after that long and
 * fails as `KernelError('timeout')` naming the host; the step's own signal is untouched, so the step goes on (the
 * coverage gate reads it as a miss). The host pacer's wait comes before the clock starts. Absent: only the step's
 * timeout applies, as before.
 */
export interface RequestOptions {
  readonly timeoutMs?: number;
  /**
   * A wider spacing for this request's host than the policy's `minHostIntervalMs` (a platform's own politeness rule,
   * e.g. Workday's 2 s): the request waits until at least this long after the previous request to the host. It can
   * only widen the spacing, never narrow it.
   */
  readonly minIntervalMs?: number;
  /**
   * `getPage` only (Task 9): the one alternative Accept value a request may name, for an RSS feed (Teamtailor answers 400
   * to the JSON Accept). Nothing else about the request changes (the honest user agent, egress, https, pacing, no
   * redirects); any other value is a policy denial and nothing is sent.
   */
  readonly accept?: 'application/rss+xml';
}

/** The largest JSON body `postJson` sends. */
export const POST_BODY_MAX_BYTES = 64 * 1024;

/** Fixed request headers. The user-agent is honest and never configurable (G-NO-EVASION). */
export const HTTP_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  accept: 'application/json, text/plain;q=0.8, */*;q=0.1',
  'user-agent': 'jobpilot/0.1 (+local)',
});

/** `postJson`'s headers: the fixed GET headers plus the JSON content type, nothing configurable. */
export const POST_HEADERS: Readonly<Record<string, string>> = Object.freeze({ ...HTTP_HEADERS, 'content-type': 'application/json' });

/** Spaces requests to one host by at least `minIntervalMs`; one instance is shared by every context of a supervisor. */
export interface HostPacer {
  /** `minIntervalMs` widens the spacing for this one request (never below the pacer's own interval). */
  wait(host: string, minIntervalMs?: number): Promise<void>;
}

/**
 * Each request to a host is scheduled at max(now, previous slot + interval) and waits until its slot.
 * The slot is claimed before sleeping, so concurrent waits on one host are spaced, never collapsed.
 * Time comes from the injected clock and sleep, so tests are deterministic.
 */
export function createHostPacer(minIntervalMs: number, clock: Clock, sleep: (ms: number) => Promise<void>): HostPacer {
  const lastRequestAt = new Map<string, number>();
  return {
    async wait(host, wider) {
      const h = normalizeHost(host);
      const now = Date.parse(clock.now());
      const last = lastRequestAt.get(h);
      const gap = wider !== undefined && Number.isFinite(wider) && wider > minIntervalMs ? wider : minIntervalMs;
      const slot = last === undefined ? now : Math.max(now, last + gap);
      lastRequestAt.set(h, slot);
      if (slot > now) await sleep(slot - now);
    },
  };
}

/** Reads a response body, refusing it once it passes `maxBytes`. A stream is cancelled at the cap, not read to the end. */
async function readCappedBytes(res: FetchResponse, maxBytes: number): Promise<Uint8Array> {
  const tooBig = (): KernelError => new KernelError('invalid_output', `response exceeds ${maxBytes} bytes`);
  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooBig();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw tooBig();
  return Buffer.from(text, 'utf8');
}

async function readCapped(res: FetchResponse, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readCappedBytes(res, maxBytes));
}

/** The first `maxBytes` of a body (an error page), the rest cancelled unread. */
async function readPrefix(res: FetchResponse, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value.subarray(0, Math.max(0, maxBytes - total)));
    total += value.byteLength;
    if (total >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Streams a 2xx body to `onText` under the byte cap (see HttpTool.getStream). */
async function streamBody(res: FetchResponse, maxBytes: number, onText: (text: string) => boolean | void): Promise<Pick<StreamResult, 'bytes' | 'capped' | 'stopped'>> {
  const declared = Number(res.headers?.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { bytes: 0, capped: true, stopped: false };
  }
  const decoder = new TextDecoder();
  if (!res.body) {
    const text = await res.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > maxBytes) {
      onText(decoder.decode(bytes.subarray(0, maxBytes)));
      return { bytes: maxBytes, capped: true, stopped: false };
    }
    const go = onText(text);
    return { bytes: bytes.byteLength, capped: false, stopped: go === false };
  }
  const reader = res.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.byteLength > room) {
      if (room > 0) onText(decoder.decode(value.subarray(0, room), { stream: true }));
      total += Math.max(0, room);
      await reader.cancel().catch(() => undefined);
      return { bytes: total, capped: true, stopped: false };
    }
    total += value.byteLength;
    if (onText(decoder.decode(value, { stream: true })) === false) {
      await reader.cancel().catch(() => undefined);
      return { bytes: total, capped: false, stopped: true };
    }
  }
  const tail = decoder.decode();
  if (tail !== '' && onText(tail) === false) return { bytes: total, capped: false, stopped: true };
  return { bytes: total, capped: false, stopped: false };
}

/** Read-only page rendering. The agent names the URL and whether it is a listing; the broker fixes everything else. */
export interface BrowserTool {
  render(url: string, opts?: { readonly expand?: boolean; readonly linkPattern?: string }): Promise<BrowserPage>;
}

export interface LlmTool {
  complete(req: { system: string; prompt: string }): Promise<LlmResponse>;
}

/**
 * Everything an agent may touch. Tools exist only when the contract grants
 * them. There is deliberately no proxy, user-agent, fingerprint or CAPTCHA
 * capability: those are absent, not disabled (G-NO-EVASION).
 */
export interface AgentContext {
  readonly clock: Clock;
  readonly signal: AbortSignal;
  readonly http?: HttpTool;
  readonly llm?: LlmTool;
  /** Present only when the contract declares `capabilities.browser`. */
  readonly browser?: BrowserTool;
  /** The user's pack, deep-frozen; present only when the contract declares `capabilities.pack`. */
  readonly pack?: Readonly<unknown>;
  /**
   * Files under the contract's root; present only when the contract declares `capabilities.files`. `write` exists
   * only with `access: 'read-write'` (see `files.ts` for the confinement rules).
   */
  readonly files?: FilesTool & Partial<Pick<WritableFilesTool, 'write'>>;
  /** The text layer of a PDF under the files root; present only when the contract declares `capabilities.pdfText`. */
  readonly pdfText?: (relPath: string) => Promise<string>;
  spent(): Cost;
  /** The largest single model call paid in this context. */
  maxCall(): number;
  /** Every policy denial the broker raised in this context, in order, whether or not the agent caught it. */
  denials(): readonly string[];
  /**
   * Records input items the agent skipped (one short note each, say a malformed job in a response), so a partial skip
   * is never silent: the executor puts the count and the first notes in the step_done event (and repeats them on
   * replay). Notes name ids and positions only, never free text.
   */
  skipped(notes: readonly string[]): void;
  /** The notes recorded by `skipped`, in order. */
  skips(): readonly string[];
}

export interface IssueArgs {
  readonly contract: AnyContract;
  readonly policy: Policy;
  readonly inputClass: DataClass;
  readonly providers: Providers;
  readonly clock: Clock;
  readonly signal: AbortSignal;
  /** What the run had already paid before this context was issued: by this agent, and in total. */
  readonly priorSpend?: { readonly agentUsd: number; readonly runUsd: number; readonly maxCallUsd?: number };
  /** The pack this contract may read (public or full), already frozen by `freezePack`; ignored unless the contract declares capabilities.pack. */
  readonly pack?: unknown;
  /** Shared per-host pacing; without one, requests are not paced (unit tests, evals). */
  readonly hostPacer?: HostPacer;
  /** This attempt's staged-write transaction (the executor opens one per step); without it, `files.write` is denied. */
  readonly pendingFiles?: PendingFiles;
  /** Shared per-host pacing of browser renders (`policy.minBrowserIntervalMs`), applied before `hostPacer`. */
  readonly browserPacer?: HostPacer;
  /** The hosts behind each symbolic egress entry (`pack:careers-hosts`); a missing set resolves to no host. */
  readonly egressSets?: EgressSets;
}

export type EgressSets = Readonly<Partial<Record<SymbolicEgress, readonly string[]>>>;

/**
 * A contract's egress with its symbolic entries replaced by their sets: exact, lower-cased host names, sorted and
 * deduplicated. Anything in a set that is not a bare host name is dropped (fail closed).
 */
export function resolveEgress(egress: readonly string[], sets: EgressSets = {}): string[] {
  const out = new Set<string>();
  for (const e of egress) {
    if (!isSymbolicEgress(e)) {
      out.add(e);
      continue;
    }
    for (const h of sets[e] ?? []) {
      const n = normalizeHost(h);
      if (/^[a-z0-9.-]+$/.test(n)) out.add(n);
    }
  }
  return [...out].sort();
}

/** Freezes every object reachable from `v`, in place. Cycles are safe. Typed arrays and DataViews cannot be frozen, so they are skipped. */
function deepFreeze<T>(v: T, seen = new WeakSet<object>()): T {
  if (v !== null && typeof v === 'object' && !seen.has(v) && !ArrayBuffer.isView(v)) {
    seen.add(v);
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child, seen);
  }
  return v;
}

/**
 * A deep-frozen deep copy of a pack: the caller's object is never frozen. The Supervisor calls it once
 * per pack; every context then shares the same read-only view. Typed arrays inside stay mutable.
 */
export function freezePack<T>(pack: T): Readonly<T> {
  return deepFreeze(structuredClone(pack));
}

function mapProviderError(e: unknown): unknown {
  if (e instanceof KernelError) return e;
  const o = typeof e === 'object' && e !== null ? (e as { name?: unknown; status?: unknown; message?: unknown }) : {};
  if (o.name === 'TimeoutError') return e;
  if (typeof o.status === 'number') {
    if (o.status === 429) return new KernelError('rate_limit', `provider returned ${o.status}`);
    if (o.status >= 500) return new KernelError('overloaded', `provider returned ${o.status}`);
  }
  if (o.name === 'AbortError') return new KernelError('unknown', 'request aborted');
  return new KernelError('network', typeof o.message === 'string' ? o.message : 'provider call failed');
}

/** Sums of decimal dollar amounts drift (0.1 + 0.2 > 0.3); a cap is only exceeded beyond that noise. */
const exceeds = (total: number, cap: number): boolean => total > cap + 1e-9;

export function issueContext(a: IssueArgs): AgentContext {
  let usd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let maxCallUsd = 0;
  const prior = a.priorSpend ?? { agentUsd: 0, runUsd: 0 };
  const denied: string[] = [];
  const skipNotes: string[] = [];
  const egress = resolveEgress(a.contract.egress, a.egressSets);
  /** A policy denial is recorded before it is thrown, so an agent cannot hide it by catching. */
  const deny = (message: string): KernelError => {
    denied.push(message);
    return new KernelError('policy_denied', message);
  };

  const checkHost = (host: string): void => {
    if (!egress.includes(normalizeHost(host))) {
      throw deny(`G-EGRESS: ${a.contract.id} may not contact ${host}`);
    }
    if (!egressAllowed(a.policy, host, a.inputClass)) {
      throw deny(`G-PII-EGRESS: ${a.inputClass} data may not be sent to ${host}`);
    }
  };

  const ctx: { -readonly [K in keyof AgentContext]: AgentContext[K] } = {
    clock: a.clock,
    signal: a.signal,
    spent: () => ({ usd, inputTokens, outputTokens }),
    maxCall: () => maxCallUsd,
    denials: () => [...denied],
    skipped: (notes) => {
      for (const n of notes) skipNotes.push(String(n));
    },
    skips: () => [...skipNotes],
  };

  if (a.contract.capabilities.pack && a.pack !== undefined && a.pack !== null) ctx.pack = a.pack;

  const filesCap = a.contract.capabilities.files;
  if (filesCap) {
    const files = createFiles({ root: a.providers.fileRoots?.[filesCap.root], rootName: filesCap.root, maxBytes: a.policy.maxResponseBytes, deny, ...(a.pendingFiles ? { pending: a.pendingFiles } : {}) }, filesCap.access);
    ctx.files = files.tool;
    if (a.contract.capabilities.pdfText) {
      ctx.pdfText = async (relPath) => {
        // Confined exactly like a read: the provider only ever sees a regular file under the root.
        const abs = await files.locate(relPath);
        const provider = a.providers.pdfText;
        if (!provider) throw deny('no pdfText provider is configured');
        if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new pdfText calls');
        let text: string;
        try {
          text = await provider(abs, a.signal);
        } catch (e) {
          throw new KernelError('invalid_output', `pdfText of ${relPath} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (typeof text !== 'string') throw new KernelError('invalid_output', `pdfText of ${relPath} returned no text`);
        if (Buffer.byteLength(text, 'utf8') > a.policy.maxResponseBytes) throw new KernelError('invalid_output', `pdfText of ${relPath} exceeds ${a.policy.maxResponseBytes} bytes`);
        return text;
      };
    }
  }

  /** https only, no explicit port, no credentials, and an egress host the policy allows. */
  const checkUrl = (url: string): URL => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw deny('G-EGRESS: invalid URL');
    }
    if (u.protocol !== 'https:') throw deny(`G-EGRESS: only https is allowed (${u.protocol}//${u.hostname})`);
    if (u.port !== '') throw deny(`G-EGRESS: explicit ports are not allowed (${u.hostname})`);
    if (u.username !== '' || u.password !== '') throw deny('G-EGRESS: credentials in URLs are not allowed');
    checkHost(u.hostname);
    return u;
  };

  if (a.contract.capabilities.http) {
    /** The signal one request runs under: the step's, plus its own timer when `timeoutMs` is given. */
    const requestSignal = (timeoutMs: number | undefined): { signal: AbortSignal; timedOut: () => boolean; done: () => void } => {
      if (timeoutMs === undefined) return { signal: a.signal, timedOut: () => false, done: () => {} };
      const c = new AbortController();
      let fired = false;
      const timer = setTimeout(() => {
        fired = true;
        c.abort(new DOMException('request timeout', 'TimeoutError'));
      }, timeoutMs);
      const onStep = (): void => c.abort(a.signal.reason);
      a.signal.addEventListener('abort', onStep, { once: true });
      return {
        signal: c.signal,
        timedOut: () => fired && !a.signal.aborted,
        done: () => {
          clearTimeout(timer);
          a.signal.removeEventListener('abort', onStep);
        },
      };
    };
    const timedOutError = (host: string, ms: number | undefined): KernelError => new KernelError('timeout', `request to ${host} timed out after ${ms ?? 0} ms`);
    const fetchBody = async <T>(
      url: string,
      read: (res: FetchResponse, max: number) => Promise<T>,
      opts?: RequestOptions,
      post?: string,
    ): Promise<{ status: number; body: T }> => {
      const u = checkUrl(url);
      if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new requests');
      await (opts?.minIntervalMs === undefined ? a.hostPacer?.wait(u.hostname) : a.hostPacer?.wait(u.hostname, opts.minIntervalMs));
      if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new requests');
      let res;
      let body;
      const timeoutMs = opts?.timeoutMs;
      const rq = requestSignal(timeoutMs);
      try {
        res = await a.providers.fetch(
          u.href,
          post === undefined ? { signal: rq.signal, redirect: 'manual', headers: HTTP_HEADERS } : { signal: rq.signal, redirect: 'manual', headers: POST_HEADERS, method: 'POST', body: post },
        );
        if (res.status >= 300 && res.status < 400) {
          throw deny(`G-EGRESS: redirect from ${u.hostname} refused`);
        }
        if (res.status === 429) throw new KernelError('rate_limit', `429 from ${u.hostname}`);
        if (res.status >= 500) throw new KernelError('overloaded', `${res.status} from ${u.hostname}`);
        body = await read(res, a.policy.maxResponseBytes);
      } catch (e) {
        if (rq.timedOut()) throw timedOutError(u.hostname, timeoutMs);
        throw mapProviderError(e);
      } finally {
        rq.done();
      }
      return { status: res.status, body };
    };
    const getPage = async (url: string, opts?: RequestOptions): Promise<{ status: number; body: string; location: string | null }> => {
      const u = checkUrl(url);
      if (opts?.accept !== undefined && opts.accept !== 'application/rss+xml') throw deny('G-NO-EVASION: getPage accepts only accept: application/rss+xml');
      const headers = opts?.accept === undefined ? HTTP_HEADERS : { ...HTTP_HEADERS, accept: opts.accept };
      if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new requests');
      await (opts?.minIntervalMs === undefined ? a.hostPacer?.wait(u.hostname) : a.hostPacer?.wait(u.hostname, opts.minIntervalMs));
      if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new requests');
      const rq = requestSignal(opts?.timeoutMs);
      try {
        const res = await a.providers.fetch(u.href, { signal: rq.signal, redirect: 'manual', headers });
        const body = await readCapped(res, a.policy.maxResponseBytes);
        return { status: res.status, body, location: res.headers?.get('location') ?? null };
      } catch (e) {
        if (rq.timedOut()) throw timedOutError(u.hostname, opts?.timeoutMs);
        throw mapProviderError(e);
      } finally {
        rq.done();
      }
    };
    const getStream = async (url: string, onText: (text: string) => boolean | void, opts: StreamOptions): Promise<StreamResult> => {
      const max = opts.maxBytes;
      if (!Number.isSafeInteger(max) || max <= 0) throw deny('G-EGRESS: getStream needs a positive integer maxBytes');
      if (max > STREAM_MAX_BYTES) throw deny(`G-EGRESS: getStream maxBytes ${max} exceeds ${STREAM_MAX_BYTES}`);
      if (max > a.policy.maxResponseBytes && a.contract.capabilities.httpStream !== true) {
        throw deny(`G-EGRESS: ${a.contract.id} may not stream more than ${a.policy.maxResponseBytes} bytes (no capabilities.httpStream)`);
      }
      const u = checkUrl(url);
      if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new requests');
      await (opts.minIntervalMs === undefined ? a.hostPacer?.wait(u.hostname) : a.hostPacer?.wait(u.hostname, opts.minIntervalMs));
      if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new requests');
      const rq = requestSignal(opts.timeoutMs);
      try {
        const res = await a.providers.fetch(u.href, { signal: rq.signal, redirect: 'manual', headers: HTTP_HEADERS });
        const location = res.headers?.get('location') ?? null;
        if (res.status < 200 || res.status >= 300) return { status: res.status, location, bytes: 0, capped: false, stopped: false, body: await readPrefix(res, STREAM_ERROR_BODY_BYTES) };
        return { status: res.status, location, ...(await streamBody(res, max, onText)) };
      } catch (e) {
        if (rq.timedOut()) throw timedOutError(u.hostname, opts.timeoutMs);
        throw mapProviderError(e);
      } finally {
        rq.done();
      }
    };
    const getText = (url: string, opts?: RequestOptions): Promise<{ status: number; body: string }> => fetchBody(url, readCapped, opts);
    const parseJson = (url: string, status: number, body: string): { status: number; json: unknown } => {
      if (status >= 400) return { status, json: null };
      try {
        return { status, json: JSON.parse(body) as unknown };
      } catch {
        throw new KernelError('invalid_output', `response from ${new URL(url).hostname} is not valid JSON`);
      }
    };
    ctx.http = {
      getText: (url) => getText(url),
      getPage,
      getStream,
      async getBytes(url) {
        const { status, body } = await fetchBody(url, readCappedBytes);
        return { status, bytes: body };
      },
      async getJson(url, opts) {
        const { status, body } = await getText(url, opts);
        return parseJson(url, status, body);
      },
      async postJson(url, payload, opts) {
        if (a.contract.capabilities.httpPost !== true) throw deny(`G-EGRESS: ${a.contract.id} may not POST (no capabilities.httpPost)`);
        let text: string | undefined;
        try {
          text = JSON.stringify(payload);
        } catch {
          text = undefined;
        }
        if (text === undefined) throw new KernelError('invalid_output', 'postJson: the body is not JSON-serialisable');
        if (Buffer.byteLength(text, 'utf8') > POST_BODY_MAX_BYTES) throw new KernelError('invalid_output', `postJson: the body exceeds ${POST_BODY_MAX_BYTES} bytes`);
        const { status, body } = await fetchBody(url, readCapped, opts, text);
        return parseJson(url, status, body);
      },
    };
  }

  const browserCap = a.contract.capabilities.browser;
  if (browserCap) {
    let pages = 0;
    ctx.browser = {
      async render(url, opts) {
        // The only options are `expand` and `linkPattern`; anything else (a header, a user agent, a proxy) is refused, not ignored.
        if (
          opts !== undefined &&
          (typeof opts !== 'object' ||
            opts === null ||
            Object.keys(opts).some((k) => k !== 'expand' && k !== 'linkPattern') ||
            (opts.expand !== undefined && typeof opts.expand !== 'boolean') ||
            (opts.linkPattern !== undefined && (typeof opts.linkPattern !== 'string' || opts.linkPattern.length > 200)))
        ) {
          throw deny('G-NO-EVASION: render accepts only { expand: boolean, linkPattern: string }');
        }
        const u = checkUrl(url);
        if (pages >= browserCap.maxPages) {
          throw new KernelError('budget_exceeded', `G-BUDGET: page budget of ${browserCap.maxPages} pages reached in this step`);
        }
        const provider = a.providers.browser;
        if (!provider) throw deny('no browser provider is configured');
        if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new renders');
        pages += 1;
        await a.browserPacer?.wait(u.hostname);
        await a.hostPacer?.wait(u.hostname);
        if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new renders');
        let page: BrowserPage;
        try {
          // A redirect may only land on an egress host the policy also allows for this data class.
          const navigationHosts = egress.filter((h) => egressAllowed(a.policy, h, a.inputClass));
          page = await provider.render({
            url: u.href,
            navigationHosts,
            deniedHosts: [...a.policy.deniedEgressHosts],
            deniedBrands: [...a.policy.deniedEgressBrands],
            maxBytes: a.policy.maxResponseBytes,
            expand: opts?.expand === true,
            ...(opts?.linkPattern !== undefined ? { linkPattern: opts.linkPattern } : {}),
            signal: a.signal,
          });
        } catch (e) {
          // The provider refuses what the page itself tried (a form POST): that is a denial of this step too.
          if (e instanceof KernelError && e.code === 'policy_denied') denied.push(e.message);
          throw mapProviderError(e);
        }
        // The landing page is checked like the request: a redirect may not leave egress or drop to http.
        let final: URL;
        try {
          final = new URL(page.finalUrl);
        } catch {
          throw deny(`G-EGRESS: render of ${u.hostname} ended on an invalid URL`);
        }
        if (final.protocol !== 'https:') throw deny(`G-EGRESS: only https is allowed (redirect to ${final.protocol}//${final.hostname})`);
        if (normalizeHost(final.hostname) !== normalizeHost(u.hostname) && !egress.includes(normalizeHost(final.hostname))) {
          throw deny(`G-EGRESS: redirect from ${u.hostname} to ${final.hostname} refused`);
        }
        checkUrl(final.href);
        if (Buffer.byteLength(page.html, 'utf8') > a.policy.maxResponseBytes) {
          throw new KernelError('invalid_output', `response exceeds ${a.policy.maxResponseBytes} bytes`);
        }
        const challenge = challengeReason(page);
        if (challenge !== null) {
          throw new KernelError('challenged', `G-CHALLENGE: ${final.hostname} answered with a bot wall or CAPTCHA (${challenge}); stopping without retry`);
        }
        if (page.status >= 500) throw new KernelError('overloaded', `${page.status} from ${final.hostname}`);
        return {
          status: page.status,
          finalUrl: page.finalUrl,
          html: page.html,
          text: page.text,
          jsonLd: [...page.jsonLd],
          headers: { ...page.headers },
          settled: page.settled,
          ...(page.settleCapMs !== undefined ? { settleCapMs: page.settleCapMs } : {}),
          ...(page.expansion ? { expansion: { ...page.expansion, unfollowedControls: [...page.expansion.unfollowedControls] } } : {}),
        };
      },
    };
  }

  const llmCap = a.contract.capabilities.llm;
  const provider = a.providers.llm;
  if (llmCap) {
    let overCall = false;
    let inFlight = false;
    ctx.llm = {
      async complete(req) {
        if (!provider) throw deny('no LLM provider is configured');
        checkHost(provider.host);
        if (inFlight) throw deny('G-BUDGET: one model call at a time per step');
        if (a.signal.aborted) throw new KernelError('timeout', 'step timed out; no new model calls');
        inFlight = true;
        try {
          if (overCall) throw new KernelError('budget_exceeded', 'G-BUDGET: a previous call exceeded usdPerCall');
          // Every call reserves a full usdPerCall (or the largest call this agent has already
          // been charged in the run, if that was more) before it is made, so the caps are hard:
          // a call that costs more than usdPerCall is latched above, everything else fits.
          // Bounds, stated exactly: (a) a call that returns in time and costs more than usdPerCall is charged
          // in full and stops this agent for the rest of the run, so a run can exceed policy.maxUsdPerRun by at
          // most (actual - usdPerCall) once per LLM agent; (b) a call still in flight when the step times out
          // is recorded at its reservation (max of usdPerCall and the largest call seen); what the provider
          // actually bills for it is not visible to the kernel and is bounded only per call by the provider's
          // pricing for maxTokens; (c) spend of a call in flight when the process itself dies is not recorded
          // and the step re-runs on resume.
          const reserve = Math.max(a.contract.budget.usdPerCall, prior.maxCallUsd ?? 0);
          if (exceeds(usd + reserve, a.contract.budget.usdPerRun)) {
            throw new KernelError('budget_exceeded', 'G-BUDGET: usdPerRun reached in this step');
          }
          if (exceeds(prior.agentUsd + usd + reserve, a.contract.budget.usdPerRun) || exceeds(prior.runUsd + usd + reserve, a.policy.maxUsdPerRun)) {
            throw new KernelError('budget_exceeded', 'G-BUDGET: run budget reached');
          }
          // A call still in flight when the step times out is charged its reservation at once, so the
          // executor (which reads spent() right after the abort) records it. Whatever the provider answers
          // later is discarded, never added a second time. Bound (b) above: accounting for a timed-out call is the
          // reservation, never zero, even though the provider may bill more for it.
          let chargedOnAbort = false;
          const chargeOnAbort = (): void => {
            chargedOnAbort = true;
            usd += reserve;
            maxCallUsd = Math.max(maxCallUsd, reserve);
          };
          a.signal.addEventListener('abort', chargeOnAbort, { once: true });
          let res;
          try {
            res = await provider.complete({ ...req, model: llmCap.model, maxTokens: llmCap.maxTokens }, a.signal);
          } catch (e) {
            // A failed provider call reports no usage, so spend is left unchanged (unless it was charged on abort).
            throw mapProviderError(e);
          } finally {
            a.signal.removeEventListener('abort', chargeOnAbort);
          }
          if (chargedOnAbort) throw new KernelError('timeout', 'step timed out; the late model answer is discarded');
          usd += res.usd;
          inputTokens += res.inputTokens;
          outputTokens += res.outputTokens;
          maxCallUsd = Math.max(maxCallUsd, res.usd);
          if (res.usd > a.contract.budget.usdPerCall) {
            overCall = true;
            throw new KernelError('budget_exceeded', `G-BUDGET: call cost ${res.usd} > usdPerCall ${a.contract.budget.usdPerCall}`);
          }
          return res;
        } finally {
          inFlight = false;
        }
      },
    };
  }
  return ctx;
}
