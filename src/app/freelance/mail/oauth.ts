import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KernelError } from '../../../kernel/errors.js';
import type { FetchLike, FetchResponse } from '../../../kernel/providers.js';
import type { Secrets } from '../../secrets.js';
import { AUTH_URL, GMAIL_HOST, GMAIL_LABEL_ID, GMAIL_NOT_CONNECTED, GMAIL_READ_PATH, GMAIL_SCOPE, SECRET, TOKEN_URL } from './google.js';

/**
 * Google OAuth 2.0 for an installed ("Desktop") app, read-only Gmail (Task 13):
 * - consent in the user's browser with PKCE (S256) and a random `state`, scope `gmail.readonly` only;
 * - the reply comes to a loopback server on `127.0.0.1:<free port>/cb`, which refuses any other state;
 * - the code is exchanged at the token endpoint (`exchangeCode`); only a refresh token granting exactly
 *   `gmail.readonly` is accepted;
 * - each run turns the refresh token into an access token in memory (`gmailRunAccess`), never on disk or in the store.
 *
 * Nothing here prints or returns a client secret, refresh token or access token, except to its caller in memory.
 */

const b64url = (b: Buffer): string => b.toString('base64url');

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
  readonly state: string;
}

/** A fresh PKCE pair (43-character verifier, its SHA-256 challenge) and a 128-bit state. */
export function newPkce(random: (n: number) => Buffer = randomBytes): Pkce {
  const verifier = b64url(random(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()), state: b64url(random(16)) };
}

/** The consent page URL. `access_type=offline` with `prompt=consent` makes Google return a refresh token. */
export function authUrl(o: { readonly clientId: string; readonly redirectUri: string; readonly pkce: Pkce }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    code_challenge: o.pkce.challenge,
    code_challenge_method: 'S256',
    state: o.pkce.state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH_URL}?${q.toString()}`;
}

/** A form POST to Google's token endpoint. Injected, so tests never reach Google. */
export type FormPost = (url: string, form: Readonly<Record<string, string>>, signal?: AbortSignal) => Promise<{ readonly status: number; text(): Promise<string> }>;

/** The real form post: the token endpoint only, the honest user agent, no redirect followed. */
export const realFormPost: FormPost = async (url, form, signal) => {
  if (url !== TOKEN_URL) throw new Error(`refused: jobpilot posts only to ${TOKEN_URL}`);
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'jobpilot/0.1 (+local)' },
    body: new URLSearchParams({ ...form }).toString(),
    redirect: 'manual',
    signal: signal ?? AbortSignal.timeout(30_000),
  });
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The token endpoint's JSON, or the OAuth error code (never its description, which could echo a value). */
async function tokenJson(res: { readonly status: number; text(): Promise<string> }, what: string): Promise<Rec> {
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch {
    json = undefined;
  }
  if (res.status !== 200 || !isRec(json)) {
    const code = isRec(json) && typeof json.error === 'string' && /^[a-z_]{1,40}$/.test(json.error) ? json.error : `HTTP ${res.status}`;
    throw new Error(`Google refused the ${what} (${code})`);
  }
  return json;
}

/** Throws unless Google granted exactly `gmail.readonly`. */
function onlyReadonly(json: Rec): void {
  const scopes = typeof json.scope === 'string' ? json.scope.split(/\s+/).filter((s) => s !== '') : [];
  if (scopes.length !== 1 || scopes[0] !== GMAIL_SCOPE) {
    throw new Error(`Google granted ${scopes.length === 0 ? 'no stated scope' : scopes.join(' ')}; jobpilot accepts only gmail.readonly, so nothing was stored`);
  }
}

/** Code → refresh token (authorization_code grant with the PKCE verifier). */
export async function exchangeCode(
  post: FormPost,
  o: { readonly clientId: string; readonly clientSecret: string; readonly code: string; readonly redirectUri: string; readonly verifier: string },
): Promise<{ refreshToken: string }> {
  const json = await tokenJson(
    await post(TOKEN_URL, { grant_type: 'authorization_code', code: o.code, redirect_uri: o.redirectUri, client_id: o.clientId, client_secret: o.clientSecret, code_verifier: o.verifier }),
    'sign-in code',
  );
  onlyReadonly(json);
  if (typeof json.refresh_token !== 'string' || json.refresh_token === '') {
    throw new Error('Google returned no refresh token; remove jobpilot under myaccount.google.com/permissions, then run jobpilot gmail connect again');
  }
  return { refreshToken: json.refresh_token };
}

export interface GmailClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Refresh token → access token (refresh_token grant), in memory. */
export async function refreshAccess(post: FormPost, o: GmailClient & { readonly refreshToken: string }, signal?: AbortSignal): Promise<{ accessToken: string; expiresIn: number | null }> {
  const json = await tokenJson(await post(TOKEN_URL, { grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: o.clientId, client_secret: o.clientSecret }, signal), 'stored sign-in');
  // Google may leave `scope` out of a refresh reply; the token then carries the scope of the grant, which
  // `exchangeCode` already checked was exactly gmail.readonly. A stated scope must still be exactly that.
  if (json.scope !== undefined) onlyReadonly(json);
  if (typeof json.access_token !== 'string' || json.access_token === '') throw new Error('Google returned no access token');
  return { accessToken: json.access_token, expiresIn: typeof json.expires_in === 'number' ? json.expires_in : null };
}

const PAGE = (title: string, line: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;margin:3rem"><h1>${title}</h1><p>${line}</p></body></html>`;

export interface Loopback {
  /** `http://127.0.0.1:<port>/cb`, the redirect URI to send Google. */
  readonly redirectUri: string;
  /** Google's code, once a reply with the right state arrives; rejects on a Google error or after `timeoutMs`. */
  readonly code: Promise<string>;
  close(): void;
}

/**
 * Listens on 127.0.0.1 on a free port. `GET /cb` with the expected `state` settles `code` (with `code`, or Google's
 * `error`); a reply with any other state is refused (400) and the wait goes on; every other path is a 404. The
 * server closes when `code` settles.
 */
export async function startLoopback(state: string, timeoutMs: number): Promise<Loopback> {
  let resolve!: (c: string) => void;
  let reject!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  code.catch(() => undefined);
  const server = createServer((req, res) => {
    const send = (status: number, title: string, line: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end(PAGE(title, line));
    };
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || u.pathname !== '/cb') return send(404, 'Not found', 'jobpilot is waiting for Google at /cb only.');
    // One state and at most one code and one error: a repeated parameter is a smuggling attempt, not Google.
    const once = (k: string): boolean => u.searchParams.getAll(k).length <= 1;
    if (u.searchParams.getAll('state').length !== 1 || u.searchParams.get('state') !== state || !once('code') || !once('error')) {
      return send(400, 'Refused', "This reply did not come from jobpilot's sign-in request, so it was refused.");
    }
    const error = u.searchParams.get('error');
    const got = u.searchParams.get('code');
    // The wait ends once the page has been sent, so the browser always gets it.
    if (error !== null || got === null || got === '') {
      res.once('finish', () => finish(new Error(`Google did not grant access (${error !== null && /^[a-z_]{1,40}$/.test(error) ? error : 'no code'})`)));
      return send(200, 'Not connected', 'Google did not grant access. You can close this tab.');
    }
    res.once('finish', () => finish(got));
    send(200, 'jobpilot received Google’s reply', 'You can close this tab and return to the terminal.');
  });
  const timer = setTimeout(() => finish(new Error(`no reply from Google within ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minutes` : `${timeoutMs} ms`}; run jobpilot gmail connect again`)), timeoutMs);
  let done = false;
  function finish(r: string | Error): void {
    if (done) return;
    done = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    if (r instanceof Error) reject(r);
    else resolve(r);
  }
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => res());
  });
  const port = (server.address() as AddressInfo).port;
  return { redirectUri: `http://127.0.0.1:${port}/cb`, code, close: () => finish(new Error('cancelled')) };
}

/** What a freelance run needs of Gmail: whether it is connected, why not (`reason`), and the authorised fetch layer. */
export interface GmailRunAccess {
  readonly connected: boolean;
  readonly reason: string | null;
  wrap(base: FetchLike): FetchLike;
}

export const GMAIL_OFF: GmailRunAccess = { connected: false, reason: GMAIL_NOT_CONNECTED, wrap: (f) => f };

const response = (status: number, body: unknown): FetchResponse => ({ status, text: async () => JSON.stringify(body) });

/** `security exit N` from a Keychain error, for the warning. */
const keychainError = (e: unknown): string => {
  const m = e instanceof Error ? /security exit (\d+)/.exec(e.message) : null;
  return `Keychain could not be read (security exit ${m?.[1] ?? '?'}); Gmail skipped`;
};

/**
 * The run's Gmail access, read from the Keychain once, now (call it only when gmail is enabled). Any Keychain error
 * makes it `connected: false` with the reason `Keychain could not be read (security exit N); Gmail skipped`, a run
 * warning, never a run failure. A refresh token without its client is "not connected" too.
 *
 * `wrap` puts an authorised layer over the run's fetch:
 * - `GET TOKEN_URL` (the agent's first request, checked by the broker like any other) refreshes the access token: one
 *   POST to the token endpoint with the client and refresh token. The access token stays in this closure; the agent
 *   sees only `{"token":"ready"}` or Google's error code.
 * - a request to the Gmail host must be a read (`GMAIL_READ_PATH`, a GET: the broker makes GETs only), with `labelIds`
 *   only a label id, and gets `authorization: Bearer <access token>`; without a refreshed token it is answered 401
 *   without being sent.
 * - every other URL goes to the base fetch unchanged.
 */
export function gmailRunAccess(secrets: Pick<Secrets, 'get' | 'has'>, post: FormPost = realFormPost): GmailRunAccess {
  let creds: (GmailClient & { readonly refreshToken: string }) | undefined;
  try {
    if (!secrets.has(SECRET.refresh)) return GMAIL_OFF;
    const clientId = secrets.get(SECRET.clientId);
    const clientSecret = secrets.get(SECRET.clientSecret);
    const refreshToken = secrets.get(SECRET.refresh);
    if (clientId === undefined || clientSecret === undefined || refreshToken === undefined) return GMAIL_OFF;
    creds = { clientId, clientSecret, refreshToken };
  } catch (e) {
    return { connected: false, reason: keychainError(e), wrap: (f) => f };
  }
  const c = creds;
  return {
    connected: true,
    reason: null,
    wrap(base) {
      let access: string | undefined;
      return async (url, init) => {
        const u = new URL(url);
        if (u.href === TOKEN_URL) {
          try {
            const t = await refreshAccess(post, c, init.signal);
            access = t.accessToken;
            return response(200, { token: 'ready', expiresIn: t.expiresIn });
          } catch (e) {
            access = undefined;
            const m = e instanceof Error ? /\(([a-z_]{1,40}|HTTP \d{3})\)/.exec(e.message) : null;
            return response(401, { error: m?.[1] ?? 'refresh_failed' });
          }
        }
        if (u.hostname === GMAIL_HOST) {
          if (!GMAIL_READ_PATH.test(u.pathname) || !u.searchParams.getAll('labelIds').every((l) => GMAIL_LABEL_ID.test(l))) {
            throw new KernelError('policy_denied', `G-READONLY: ${u.pathname} is not a Gmail read`);
          }
          if (access === undefined) return response(401, { error: 'no_access_token' });
          return base(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${access}` } });
        }
        return base(url, init);
      };
    },
  };
}
