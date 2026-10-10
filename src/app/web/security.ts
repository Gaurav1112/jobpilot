import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The dashboard's request rules (Task 13). It listens on 127.0.0.1 only; these rules stop other sites the user's
 * browser visits from reaching it.
 *
 * - **Host.** The raw Host header must be exactly `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`, and an
 *   absolute-form request target may not name another host, so a DNS-rebinding page cannot read the dashboard.
 * - **POST, both checks.** A POST must come from the dashboard itself (its `Origin`, or when a browser sends none its
 *   `Referer`, equals the request's own origin), AND carry the session's CSRF token (form field `_csrf`, or header
 *   `X-CSRF-Token`). htmx requests (`HX-Request: true`) get a fragment back; plain form posts (JavaScript off) get a
 *   303 redirect. Either way both checks apply.
 * - **Session.** A random session id in an HttpOnly, SameSite=Strict cookie; the token is HMAC-SHA256 of it under a
 *   random secret kept in the app DB (`app_settings`), so tokens are never stored and survive a restart.
 */

export const SESSION_COOKIE = 'jp_sid';
export const CSRF_FIELD = '_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** Pages: same-origin resources only, no inline script, frames only from the dashboard (the document previews). */
export const PAGE_CSP = "default-src 'self'; script-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
/** Document previews: nothing may load or run; their own inline style only; framed only by the dashboard. */
export const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";
/** Downloads and static files. */
export const FILE_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'] as const;

/**
 * The exact Host values the dashboard answers: each loopback name with the bound port, or the bare names when no port
 * is configured (an in-process `app.request`). An unknown port (-1, not yet listening) allows nothing.
 */
export function allowedHosts(port: number | undefined): ReadonlySet<string> {
  if (port === undefined) return new Set(LOOPBACK);
  if (port < 1) return new Set();
  return new Set(LOOPBACK.map((h) => `${h}:${port}`));
}

/** Whether the request came from a dashboard page: its Origin (or, without one, Referer) is `selfOrigin`. */
export function sameOrigin(selfOrigin: string, origin: string | undefined, referer: string | undefined): boolean {
  if (origin !== undefined && origin !== '') return origin === selfOrigin;
  if (referer === undefined || referer === '') return false;
  try {
    return new URL(referer).origin === selfOrigin;
  } catch {
    return false;
  }
}

export class Sessions {
  private readonly secret: Buffer;
  constructor(secret: Buffer = randomBytes(32)) {
    this.secret = secret;
  }
  newId(): string {
    return randomBytes(16).toString('hex');
  }
  static validId(sid: string | undefined): sid is string {
    return sid !== undefined && /^[0-9a-f]{32}$/.test(sid);
  }
  token(sid: string): string {
    return createHmac('sha256', this.secret).update(`csrf:${sid}`).digest('hex');
  }
  check(sid: string | undefined, token: string | undefined): boolean {
    if (!Sessions.validId(sid) || token === undefined || !/^[0-9a-f]{64}$/.test(token)) return false;
    return timingSafeEqual(Buffer.from(this.token(sid), 'hex'), Buffer.from(token, 'hex'));
  }
}
