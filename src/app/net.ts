import { lookup } from 'node:dns/promises';
import type { KernelError } from '../kernel/errors.js';

/**
 * The machine's network, as the runs see it: is it online at all, and is a failed request an outage (transient: ask
 * again later) or a fact about the host (definitive: it has no such name, or no valid TLS certificate)?
 */

/** Hosts every pack's sources depend on; one resolving means the network is up (Wi-Fi is often still down at wake). */
export const PROBE_HOSTS: readonly string[] = ['boards-api.greenhouse.io', 'api.lever.co', 'api.ashbyhq.com'];

/** One of `hosts` resolves (each lookup given 5 s): the machine is online. */
export async function dnsOnline(hosts: readonly string[] = PROBE_HOSTS): Promise<boolean> {
  const one = (h: string) => Promise.race([lookup(h).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5_000).unref())]).catch(() => false);
  return (await Promise.all(hosts.map(one))).some(Boolean);
}

/** The KernelError codes of a transport failure: an outage, a slow or overloaded host. Asked again later, never a verdict. */
export const TRANSIENT_CODES: ReadonlySet<string> = new Set(['network', 'timeout', 'overloaded']);

/** DNS answered that the name does not exist. Only a verdict while the machine is online: offline, every name fails so. */
const NO_SUCH_HOST = new Set(['ENOTFOUND', 'EAI_NONAME']);
/** The host answered, and refused the connection or showed no valid certificate: a fact about the host, not an outage. */
const DEFINITIVE = /^(?:ECONNREFUSED|CERT_|ERR_TLS_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|ERR_SSL_)/;

/**
 * What a transport failure says about its host:
 * - `no-such-host`: DNS says the name does not exist (`ENOTFOUND`). The caller must confirm the machine is online first;
 * - `definitive`: the host refused the connection or its TLS certificate is invalid;
 * - `transient`: anything else (a reset, a timeout, an unreachable network, an unknown cause): an outage, ask again.
 */
export function networkKind(e: Pick<KernelError, 'code' | 'sysCode'>): 'no-such-host' | 'definitive' | 'transient' {
  if (e.code !== 'network' || e.sysCode === undefined) return 'transient';
  if (NO_SUCH_HOST.has(e.sysCode)) return 'no-such-host';
  return DEFINITIVE.test(e.sysCode) ? 'definitive' : 'transient';
}
