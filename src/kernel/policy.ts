import { z } from 'zod';
import { hashOf } from './canonical.js';
import { DATA_CLASSES, type DataClass } from './data-class.js';
import { PolicyViolation } from './errors.js';

export interface Policy {
  readonly version: string;
  /** Hosts no agent may contact. */
  readonly deniedEgressHosts: readonly string[];
  /** Hosts no effect agent may submit to. */
  readonly deniedSubmitHosts: readonly string[];
  /** Data classes allowed to leave the machine, per host; hosts not listed use the default. */
  readonly egressClasses: Readonly<Record<string, readonly DataClass[]>>;
  readonly defaultEgressClasses: readonly DataClass[];
  readonly maxUsdPerRun: number;
  readonly maxPayloadBytes: number;
  readonly maxSubmitsPerDay: number;
  readonly requireApprovalForEffects: boolean;
}

/** The product safety floor. A user policy may tighten it, never loosen it. */
export const PRODUCT_POLICY_V1: Policy = Object.freeze<Policy>({
  version: 'product.v1',
  deniedEgressHosts: [],
  deniedSubmitHosts: ['linkedin.com', 'naukri.com', 'indeed.com'],
  egressClasses: { 'api.anthropic.com': ['P0'] },
  defaultEgressClasses: ['P0'],
  maxUsdPerRun: 5,
  maxPayloadBytes: 262_144,
  maxSubmitsPerDay: 10,
  requireApprovalForEffects: true,
});

const UserPolicy = z
  .object({
    deniedEgressHosts: z.array(z.string()).optional(),
    deniedSubmitHosts: z.array(z.string()).optional(),
    egressClasses: z.record(z.string(), z.array(z.enum(DATA_CLASSES))).optional(),
    maxUsdPerRun: z.number().nonnegative().optional(),
    maxSubmitsPerDay: z.number().int().nonnegative().optional(),
    requireApprovalForEffects: z.boolean().optional(),
  })
  .strict();
export type UserPolicy = z.infer<typeof UserPolicy>;

const union = (a: readonly string[], b: readonly string[] = []): string[] => [...new Set([...a, ...b])].sort();

/** effective = product ∧ user. Throws PolicyViolation listing every rule the user file tries to relax. */
export function mergePolicy(product: Policy, userRaw: unknown): Policy {
  const user = UserPolicy.parse(userRaw ?? {});
  const violations: string[] = [];
  if (user.maxUsdPerRun !== undefined && user.maxUsdPerRun > product.maxUsdPerRun) {
    violations.push(`maxUsdPerRun may only be lowered (product ${product.maxUsdPerRun}, user ${user.maxUsdPerRun})`);
  }
  if (user.maxSubmitsPerDay !== undefined && user.maxSubmitsPerDay > product.maxSubmitsPerDay) {
    violations.push(`maxSubmitsPerDay may only be lowered (product ${product.maxSubmitsPerDay}, user ${user.maxSubmitsPerDay})`);
  }
  if (user.requireApprovalForEffects === false && product.requireApprovalForEffects) {
    violations.push('requireApprovalForEffects cannot be turned off');
  }
  const egressClasses: Record<string, readonly DataClass[]> = { ...product.egressClasses };
  for (const [host, classes] of Object.entries(user.egressClasses ?? {})) {
    const allowed = product.egressClasses[host] ?? product.defaultEgressClasses;
    const extra = classes.filter((c) => !allowed.includes(c));
    if (extra.length > 0) violations.push(`egressClasses.${host} may not add ${extra.join(', ')}`);
    egressClasses[host] = [...new Set(classes)].sort();
  }
  if (violations.length > 0) throw new PolicyViolation(violations);
  return Object.freeze<Policy>({
    ...product,
    version: `${product.version}+user`,
    deniedEgressHosts: union(product.deniedEgressHosts, user.deniedEgressHosts),
    deniedSubmitHosts: union(product.deniedSubmitHosts, user.deniedSubmitHosts),
    egressClasses,
    maxUsdPerRun: user.maxUsdPerRun ?? product.maxUsdPerRun,
    maxSubmitsPerDay: user.maxSubmitsPerDay ?? product.maxSubmitsPerDay,
  });
}

export function policyHash(p: Policy): string {
  return hashOf(p);
}

export function hostMatches(host: string, pattern: string): boolean {
  return host === pattern || host.endsWith(`.${pattern}`);
}

export function egressAllowed(p: Policy, host: string, cls: DataClass): boolean {
  if (p.deniedEgressHosts.some((d) => hostMatches(host, d))) return false;
  return (p.egressClasses[host] ?? p.defaultEgressClasses).includes(cls);
}
