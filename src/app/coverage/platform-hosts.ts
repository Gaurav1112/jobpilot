import { SIGNATURES } from './signatures.js';
import type { Platform } from './types.js';

/**
 * Hosts of the known career-site platforms, one entry per host suffix, derived from the signature table
 * (`signatures.ts`, the single source of platform host data). The careers locator uses it to accept a link or redirect
 * that leaves the company's own domain for its ATS; the platform detector reads the table itself.
 * A suffix matches the host itself and any subdomain of it, on a dot boundary: `acme.wd5.myworkdayjobs.com` matches
 * `myworkdayjobs.com`, `notmyworkdayjobs.com` does not.
 */
export const PLATFORM_HOSTS: ReadonlyArray<{ readonly platform: Platform; readonly hostSuffix: string }> = SIGNATURES.flatMap((row) =>
  row.hosts.map((h) => ({ platform: row.platform, hostSuffix: h.suffix })),
);

/**
 * Vendor suffixes that are the vendor's own marketing domain: `icims.com` and `www.icims.com` are the vendor's site, a
 * company's board is `<tenant>.icims.com`. These need a tenant subdomain (not the apex, not `www.`).
 */
const TENANT_ONLY: ReadonlySet<string> = new Set(SIGNATURES.flatMap((row) => row.hosts.filter((h) => h.tenantOnly === true).map((h) => h.suffix)));

/** The platform a host belongs to (lower-cased, suffix match on a dot boundary), or null. */
export function platformForHost(host: string): Platform | null {
  const h = host.trim().toLowerCase().replace(/\.+$/u, '');
  for (const p of PLATFORM_HOSTS) {
    if (TENANT_ONLY.has(p.hostSuffix) && (h === p.hostSuffix || h === `www.${p.hostSuffix}`)) continue;
    if (h === p.hostSuffix || h.endsWith(`.${p.hostSuffix}`)) return p.platform;
  }
  return null;
}
