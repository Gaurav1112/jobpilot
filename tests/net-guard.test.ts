import { spawnSync } from 'node:child_process';
import dns from 'node:dns';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { nodeFetch } from '../src/kernel/providers.js';
import { NO_NETWORK_ENV } from '../src/kernel/no-network.js';
import { allowRealNetwork, guardAllows } from './support/net-guard.js';

/**
 * The test suite fails closed on real network access (tests/support/net-guard.ts, a vitest setup file): real `fetch`,
 * `net.Socket.connect` and `dns.lookup` throw for any non-loopback host unless a test opts in with
 * `allowRealNetwork()`, and JOBPILOT_NO_NETWORK=1 (set by the setup, inherited by spawned CLI processes) makes the
 * app's own network entries (`nodeFetch`, the probes, the browser) refuse too. 203.0.113.1 is TEST-NET-3: never routed.
 */
const REFUSED = /network guard|JOBPILOT_NO_NETWORK/;

describe('the test network guard', () => {
  it('a real fetch to a public host throws', async () => {
    await expect(fetch('https://203.0.113.1/', { signal: AbortSignal.timeout(2_000) })).rejects.toThrow(REFUSED);
    await expect(fetch('https://example.com/', { signal: AbortSignal.timeout(2_000) })).rejects.toThrow(REFUSED);
  });

  it('net.Socket.connect and dns.lookup to a public host throw; loopback is allowed', async () => {
    expect(() => net.connect({ host: '203.0.113.1', port: 443 })).toThrow(REFUSED);
    expect(() => dns.lookup('203.0.113.1', () => {})).toThrow(REFUSED);
    await expect(dns.promises.lookup('203.0.113.1')).rejects.toThrow(REFUSED);
    expect(guardAllows('127.0.0.1')).toBe(true);
    expect(guardAllows('localhost')).toBe(true);
    expect(guardAllows('::1')).toBe(true);
  });

  it('JOBPILOT_NO_NETWORK=1 is set for the suite and inherited by child processes; nodeFetch refuses', async () => {
    expect(process.env[NO_NETWORK_ENV]).toBe('1');
    const child = spawnSync(process.execPath, ['-e', `process.exit(process.env.${NO_NETWORK_ENV} === '1' ? 0 : 1)`]);
    expect(child.status).toBe(0);
    await expect(nodeFetch('https://203.0.113.1/', { signal: AbortSignal.timeout(2_000), redirect: 'manual', headers: {} })).rejects.toThrow(REFUSED);
  });

  it('a test opts in only through allowRealNetwork(); the guard is back on after', () => {
    expect(guardAllows('example.com')).toBe(false);
    const restore = allowRealNetwork();
    try {
      expect(guardAllows('example.com')).toBe(true);
      expect(process.env[NO_NETWORK_ENV]).toBeUndefined();
    } finally {
      restore();
    }
    expect(guardAllows('example.com')).toBe(false);
    expect(process.env[NO_NETWORK_ENV]).toBe('1');
  });
});
