/**
 * JOBPILOT_NO_NETWORK=1: every real-network entry of the app refuses (the test suite sets it, so the CLI processes its
 * tests spawn inherit it). Loopback hosts stay allowed: tests serve fixtures from local servers.
 */
export const NO_NETWORK_ENV = 'JOBPILOT_NO_NETWORK';

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;

/** True for a loopback host name or address (a local test server). */
export const isLoopbackHost = (host: string): boolean => LOOPBACK.test(host);

/** Throws when JOBPILOT_NO_NETWORK=1 and `target` (a URL or a host) is not loopback. */
export function refuseRealNetwork(target: string): void {
  if (process.env[NO_NETWORK_ENV] !== '1') return;
  let host = target;
  try {
    host = new URL(target).hostname;
  } catch {
    // a bare host
  }
  if (!isLoopbackHost(host)) throw new Error(`${NO_NETWORK_ENV}=1: real network access to ${host} is refused`);
}
