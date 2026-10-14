import type { FetchLike } from '../kernel/providers.js';

/**
 * A CHECK-ONLY hook for the live re-check of the coverage outage handling (final review C1): it simulates the machine
 * going offline for a while, without touching the system's network settings. Nothing sets it: the schedule never
 * does, and with the variable unset `checkOutage` returns null and the providers are used unchanged.
 *
 * `JOBPILOT_CHECK_OUTAGE=<from>/<seconds>`: from `<from>` (an ISO time, or `+S`: S seconds after this process's first
 * request) for `<seconds>`, every request fails the way an offline Mac fails one (a `TypeError('fetch failed')` whose
 * cause has the code `ENOTFOUND`), and the offline check (`dnsOnline`) answers false. A malformed value refuses to run.
 */
export const CHECK_OUTAGE_ENV = 'JOBPILOT_CHECK_OUTAGE';

export interface CheckOutage {
  readonly fetch: (f: FetchLike) => FetchLike;
  readonly online: (o: () => Promise<boolean>) => () => Promise<boolean>;
  /** One line for the operator: what the hook does in this process. */
  readonly describe: string;
}

export function checkOutage(env: Readonly<Record<string, string | undefined>> = process.env, now: () => number = Date.now): CheckOutage | null {
  const raw = env[CHECK_OUTAGE_ENV];
  if (raw === undefined || raw === '') return null;
  const m = /^(\+\d{1,6}|\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\/(\d{1,5})$/.exec(raw);
  const seconds = m === null ? NaN : Number(m[2]);
  const iso = m !== null && !(m[1] as string).startsWith('+') ? Date.parse(m[1] as string) : 0;
  if (m === null || !(seconds > 0) || Number.isNaN(iso)) throw new Error(`${CHECK_OUTAGE_ENV} must be <ISO time or +seconds>/<seconds>, e.g. +60/15 (got ${raw})`);
  const relative = (m[1] as string).startsWith('+') ? Number((m[1] as string).slice(1)) * 1000 : null;
  let from: number | null = relative === null ? iso : null;
  const down = (): boolean => {
    const t = now();
    if (from === null) from = t + (relative as number);
    return t >= from && t < from + seconds * 1000;
  };
  const offline = (): never => {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND (JOBPILOT_CHECK_OUTAGE)'), { code: 'ENOTFOUND' }) });
  };
  return {
    fetch: (f) => async (url, init) => (down() ? offline() : f(url, init)),
    online: (o) => async () => (down() ? false : o()),
    describe: `${CHECK_OUTAGE_ENV}=${raw}: a check-only hook; every request fails as offline for ${seconds} s from ${relative === null ? new Date(iso).toISOString() : `${relative / 1000} s after the first request`}`,
  };
}
