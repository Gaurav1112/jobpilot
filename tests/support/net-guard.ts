/**
 * Vitest setup file (vitest.config.ts, vitest.perf.config.ts): the suite fails closed on real network access.
 * - Real `fetch`, `net.Socket.connect` and `dns.lookup` (callback and promise) throw for any non-loopback host.
 * - JOBPILOT_NO_NETWORK=1 is set, so the app's own entries (`nodeFetch`, the online probes, the browser provider) refuse
 *   too, in this process and in every CLI process a test spawns.
 * A test that truly needs the network opts in, by name, with `allowRealNetwork()` (and restores the guard after).
 * Not covered: Chromium's own traffic (it runs in its own process); the browser tests render local fixtures only.
 */
import dns from 'node:dns';
import net from 'node:net';
import { isLoopbackHost, NO_NETWORK_ENV } from '../../src/kernel/no-network.js';

interface GuardState {
  installed?: boolean;
  allowed: number;
}
const G = globalThis as { __jobpilotNetGuard?: GuardState };
const state: GuardState = (G.__jobpilotNetGuard ??= { allowed: 0 });
process.env[NO_NETWORK_ENV] = '1';

/** Whether the guard lets a connection to `host` through now. */
export function guardAllows(host: unknown): boolean {
  if (state.allowed > 0) return true;
  if (typeof host !== 'string' || host === '' || host.startsWith('/')) return true; // a local socket path, or the default host
  return isLoopbackHost(host);
}

/** The one way a test opts in to the real network; call the returned function (in a `finally`) to turn the guard back on. */
export function allowRealNetwork(): () => void {
  state.allowed++;
  delete process.env[NO_NETWORK_ENV];
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--state.allowed === 0) process.env[NO_NETWORK_ENV] = '1';
  };
}

const refused = (what: string, host: unknown): Error => new Error(`network guard: real ${what} to ${String(host)} refused in tests (opt in with allowRealNetwork())`);

if (state.installed !== true) {
  state.installed = true;
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    // net.connect passes its normalized arguments as one array
    const o = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    const host = typeof o === 'object' && o !== null ? ((o as { host?: unknown; path?: unknown }).host ?? (o as { path?: unknown }).path) : typeof args[1] === 'string' ? args[1] : 'localhost';
    if (!guardAllows(host)) throw refused('connection', host);
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof connect;
  const lookup = dns.lookup;
  (dns as { lookup: unknown }).lookup = function (host: unknown, ...rest: unknown[]) {
    if (!guardAllows(host)) throw refused('DNS lookup', host);
    return (lookup as (...a: unknown[]) => unknown).call(dns, host, ...rest);
  };
  const plookup = dns.promises.lookup;
  (dns.promises as { lookup: unknown }).lookup = async (host: unknown, ...rest: unknown[]) => {
    if (!guardAllows(host)) throw refused('DNS lookup', host);
    return (plookup as (...a: unknown[]) => Promise<unknown>)(host, ...rest);
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).hostname;
    if (!guardAllows(host)) {
      const cause = refused('fetch', host);
      throw new TypeError(`fetch failed (${cause.message})`, { cause });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}
