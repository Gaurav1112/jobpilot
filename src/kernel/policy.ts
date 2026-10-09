import { z } from 'zod';
import { hashOf } from './canonical.js';
import { DATA_CLASSES, type DataClass } from './data-class.js';
import { PolicyViolation } from './errors.js';

export interface Policy {
  readonly version: string;
  /** Hosts (and their subdomains) no agent may contact. */
  readonly deniedEgressHosts: readonly string[];
  /** Brand labels no agent may contact under any public suffix or subdomain (`hostMatchesBrand`). */
  readonly deniedEgressBrands: readonly string[];
  /** Hosts no effect agent may submit to. */
  readonly deniedSubmitHosts: readonly string[];
  /** Data classes allowed to leave the machine, per host; hosts not listed use the default. */
  readonly egressClasses: Readonly<Record<string, readonly DataClass[]>>;
  readonly defaultEgressClasses: readonly DataClass[];
  readonly maxUsdPerRun: number;
  readonly maxPayloadBytes: number;
  /** Largest HTTP response body the broker will read, in bytes. A user may only lower it. */
  readonly maxResponseBytes: number;
  /** Minimum gap between two requests to the same host within one supervisor, in ms. A user may only raise it. */
  readonly minHostIntervalMs: number;
  /** Minimum gap between two browser renders on the same host within one supervisor, in ms, on top of minHostIntervalMs. A user may only raise it. */
  readonly minBrowserIntervalMs: number;
  readonly maxSubmitsPerDay: number;
  readonly requireApprovalForEffects: boolean;
  /** Agent ids allowed to lower a data class (declared `redactor: true`). */
  readonly redactors: readonly string[];
}

/** Lower-case and strip trailing dots, so `Tracker.Example.` and `tracker.example` are one host. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '');
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** The product safety floor. A user policy may tighten it, never loosen it. */
export const PRODUCT_POLICY_V1: Policy = deepFreeze<Policy>({
  version: 'product.v1',
  // Job boards whose terms forbid automated access: no agent may reach them, by http or browser, whatever a contract
  // lists. The brands cover every country domain and subdomain (www.glassdoor.co.in, in.indeed.com); lnkd.in is
  // LinkedIn's link shortener.
  deniedEgressHosts: ['glassdoor.com', 'indeed.com', 'linkedin.com', 'lnkd.in', 'naukri.com'],
  deniedEgressBrands: ['glassdoor', 'indeed', 'linkedin', 'naukri'],
  deniedSubmitHosts: ['linkedin.com', 'naukri.com', 'indeed.com'],
  egressClasses: { 'api.anthropic.com': ['P0'] },
  defaultEgressClasses: ['P0'],
  maxUsdPerRun: 5,
  maxPayloadBytes: 262_144,
  maxResponseBytes: 16_777_216,
  minHostIntervalMs: 1000,
  minBrowserIntervalMs: 10_000,
  maxSubmitsPerDay: 10,
  requireApprovalForEffects: true,
  redactors: [],
});

const HostName = z.string().regex(/^[A-Za-z0-9.-]+$/);

const UserPolicy = z
  .object({
    deniedEgressHosts: z.array(HostName).optional(),
    deniedSubmitHosts: z.array(HostName).optional(),
    deniedEgressBrands: z.array(z.string().regex(/^[a-z0-9-]+$/)).optional(),
    egressClasses: z.record(HostName, z.array(z.enum(DATA_CLASSES))).optional(),
    maxUsdPerRun: z.number().nonnegative().optional(),
    maxSubmitsPerDay: z.number().int().nonnegative().optional(),
    maxResponseBytes: z.number().int().positive().optional(),
    minHostIntervalMs: z.number().int().nonnegative().optional(),
    minBrowserIntervalMs: z.number().int().nonnegative().optional(),
    requireApprovalForEffects: z.boolean().optional(),
    redactors: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).optional(),
  })
  .strict();
export type UserPolicy = z.infer<typeof UserPolicy>;

const union = (a: readonly string[], b: readonly string[] = []): string[] =>
  [...new Set([...a, ...b].map(normalizeHost))].sort();

function classesFor(p: Policy, host: string): readonly DataClass[] {
  return Object.hasOwn(p.egressClasses, host) ? (p.egressClasses[host] ?? p.defaultEgressClasses) : p.defaultEgressClasses;
}

/** effective = product ∧ user. Throws PolicyViolation listing every rule the user file tries to relax. */
export function mergePolicy(product: Policy, userRaw: unknown): Policy {
  const parsed = UserPolicy.safeParse(userRaw ?? {});
  const issues = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`);
  // Zod's record silently drops a `__proto__` key, so check the raw keys ourselves.
  const rawClasses = (userRaw as { egressClasses?: unknown } | null | undefined)?.egressClasses;
  if (typeof rawClasses === 'object' && rawClasses !== null) {
    for (const k of Object.keys(rawClasses)) {
      if (!HostName.safeParse(k).success) issues.push(`egressClasses.${k}: invalid host name`);
    }
  }
  if (!parsed.success || issues.length > 0) throw new PolicyViolation(issues);
  const user = parsed.data;
  const violations: string[] = [];
  if (user.maxUsdPerRun !== undefined && user.maxUsdPerRun > product.maxUsdPerRun) {
    violations.push(`maxUsdPerRun may only be lowered (product ${product.maxUsdPerRun}, user ${user.maxUsdPerRun})`);
  }
  if (user.maxSubmitsPerDay !== undefined && user.maxSubmitsPerDay > product.maxSubmitsPerDay) {
    violations.push(`maxSubmitsPerDay may only be lowered (product ${product.maxSubmitsPerDay}, user ${user.maxSubmitsPerDay})`);
  }
  if (user.maxResponseBytes !== undefined && user.maxResponseBytes > product.maxResponseBytes) {
    violations.push(`maxResponseBytes may only be lowered (product ${product.maxResponseBytes}, user ${user.maxResponseBytes})`);
  }
  if (user.minHostIntervalMs !== undefined && user.minHostIntervalMs < product.minHostIntervalMs) {
    violations.push(`minHostIntervalMs may only be raised (product ${product.minHostIntervalMs}, user ${user.minHostIntervalMs})`);
  }
  if (user.minBrowserIntervalMs !== undefined && user.minBrowserIntervalMs < product.minBrowserIntervalMs) {
    violations.push(`minBrowserIntervalMs may only be raised (product ${product.minBrowserIntervalMs}, user ${user.minBrowserIntervalMs})`);
  }
  if (user.requireApprovalForEffects === false && product.requireApprovalForEffects) {
    violations.push('requireApprovalForEffects cannot be turned off');
  }
  for (const id of user.redactors ?? []) {
    if (!product.redactors.includes(id)) violations.push(`redactors may not add ${id}`);
  }
  const entries = new Map<string, readonly DataClass[]>(
    Object.entries(product.egressClasses).map(([h, c]) => [normalizeHost(h), [...c]]),
  );
  for (const [rawHost, classes] of Object.entries(user.egressClasses ?? {})) {
    const host = normalizeHost(rawHost);
    const allowed = classesFor(product, host);
    const extra = classes.filter((c) => !allowed.includes(c));
    if (extra.length > 0) violations.push(`egressClasses.${host} may not add ${extra.join(', ')}`);
    entries.set(host, [...new Set(classes)].sort());
  }
  if (violations.length > 0) throw new PolicyViolation(violations);
  return deepFreeze<Policy>({
    ...product,
    version: `${product.version}+user`,
    deniedEgressHosts: union(product.deniedEgressHosts, user.deniedEgressHosts),
    deniedSubmitHosts: union(product.deniedSubmitHosts, user.deniedSubmitHosts),
    deniedEgressBrands: union(product.deniedEgressBrands, user.deniedEgressBrands),
    egressClasses: Object.fromEntries(entries),
    defaultEgressClasses: [...product.defaultEgressClasses],
    maxUsdPerRun: user.maxUsdPerRun ?? product.maxUsdPerRun,
    maxSubmitsPerDay: user.maxSubmitsPerDay ?? product.maxSubmitsPerDay,
    maxResponseBytes: user.maxResponseBytes ?? product.maxResponseBytes,
    minHostIntervalMs: user.minHostIntervalMs ?? product.minHostIntervalMs,
    minBrowserIntervalMs: user.minBrowserIntervalMs ?? product.minBrowserIntervalMs,
    redactors: [...new Set(user.redactors ?? product.redactors)].sort(),
  });
}

export function policyHash(p: Policy): string {
  return hashOf(p);
}

export function hostMatches(host: string, pattern: string): boolean {
  const h = normalizeHost(host);
  const pat = normalizeHost(pattern);
  return h === pat || h.endsWith(`.${pat}`);
}

/**
 * Whether `host` belongs to `brand` under any public suffix: the brand is a whole label, followed only by a TLD
 * (`glassdoor.com`, `indeed.jobs`) or a two-part country suffix (`glassdoor.co.in`, `indeed.com.au`), with any
 * subdomains in front. Without a public-suffix list this is an approximation that errs towards denying.
 */
export function hostMatchesBrand(host: string, brand: string): boolean {
  const labels = normalizeHost(host).split('.');
  const b = brand.toLowerCase();
  for (let i = 0; i < labels.length - 1; i++) {
    if (labels[i] !== b) continue;
    const rest = labels.slice(i + 1);
    if (rest.length === 1 && /^[a-z]{2,}$/.test(rest[0] as string)) return true;
    if (rest.length === 2 && /^(co|com|net|org|ac|gov|edu|ne|or)$/.test(rest[0] as string) && /^[a-z]{2}$/.test(rest[1] as string)) return true;
  }
  return false;
}

/** Whether the policy denies `host` outright, by host or by brand, whatever the data class. */
export function hostDenied(p: Pick<Policy, 'deniedEgressHosts' | 'deniedEgressBrands'>, host: string): boolean {
  return p.deniedEgressHosts.some((d) => hostMatches(host, d)) || p.deniedEgressBrands.some((b) => hostMatchesBrand(host, b));
}

export function egressAllowed(p: Policy, host: string, cls: DataClass): boolean {
  const h = normalizeHost(host);
  if (hostDenied(p, h)) return false;
  return classesFor(p, h).includes(cls);
}
