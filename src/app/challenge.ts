/**
 * Bot-wall detection (a closed list, never extended at run time), shared by the coverage gate and the platform
 * adapters. Pure: no imports, so agent code may use it.
 */

/** Status codes that may carry a bot wall; with a marker in the body they are a challenge. */
const CHALLENGE_STATUS: ReadonlySet<number> = new Set([403, 429, 503]);
const CHALLENGE_MARKERS = /cf-chl|challenge-platform|captcha|Attention Required|px-captcha|Just a moment/i;

/** A challenge page: 403/429/503 with a known marker in the body. */
export function isChallenge(status: number, body: string): boolean {
  return CHALLENGE_STATUS.has(status) && CHALLENGE_MARKERS.test(body);
}

/** Whether a body carries a challenge marker (for a 2xx page that should have held something else). */
export const hasChallengeMarker = (body: string): boolean => CHALLENGE_MARKERS.test(body);
