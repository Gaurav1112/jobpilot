import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The dashboard's request rules (Task 13). It listens on 127.0.0.1 only; these rules stop other sites the user's
 * browser visits from reaching it.
 *
 * - **Host.** Every request must name a loopback host (`127.0.0.1`, `localhost`, `[::1]`), so a DNS-rebinding page
 *   cannot read the dashboard through its own domain.
 * - **POST, both checks.** A POST must come from the dashboard itself (its `Origin`, or when a browser sends none its
 *   `Referer`, equals the request's own origin), AND carry the session's CSRF token (form field `_csrf`, or header
 *   `X-CSRF-Token`). htmx requests (`HX-Request: true`) get a fragment back; plain form posts (JavaScript off) get a
 *   303 redirect. Either way both checks apply.
 * - **Session.** A random session id in an HttpOnly, SameSite=Strict cookie; the token is HMAC-SHA256 of it under a
 *   per-process secret, so it is never stored and a restart invalidates every token.
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

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Whether a URL host (`name` or `name:port`) is loopback. */
export function isLoopbackHost(host: string): boolean {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(host.toLowerCase());
  return m !== null && LOOPBACK.has(m[1] as string);
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
