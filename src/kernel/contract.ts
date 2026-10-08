import { z } from 'zod';
import { hashOf } from './canonical.js';
import { DATA_CLASSES, type DataClass } from './data-class.js';
import { ERROR_CODES, RETRYABLE, type ErrorCode } from './errors.js';
import type { Predicate } from './predicates.js';
import type { MessageType } from './types.js';

export const AGENT_KINDS = ['deterministic', 'llm', 'io', 'io-session', 'human', 'effect'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export interface Capabilities {
  readonly http?: true;
  readonly llm?: { readonly model: string; readonly maxTokens: number };
}

export interface ObligationSpec {
  readonly id: string;
  /** Agent id that must discharge it before the item may finish. */
  readonly dischargedBy: string;
}

export interface Contract<I = unknown, O = unknown> {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly skills: readonly string[];
  readonly team: string;
  readonly kind: AgentKind;
  readonly consumes: MessageType<I>;
  readonly produces: MessageType<O>;
  readonly requires: readonly Predicate<I>[];
  readonly guarantees: readonly Predicate<O>[];
  readonly capabilities: Capabilities;
  readonly egress: readonly string[];
  readonly dataClasses: { readonly in: readonly DataClass[]; readonly out: readonly DataClass[] };
  readonly redactor: boolean;
  /** The least sensitive class this agent's outputs carry, whatever its input (e.g. P1 for an agent that attaches contact details). */
  readonly emits?: DataClass;
  readonly obligations: { readonly adds: readonly ObligationSpec[]; readonly discharges: readonly string[] };
  readonly budget: { readonly usdPerCall: number; readonly usdPerRun: number };
  readonly timeoutMs: number;
  readonly retry: { readonly max: number; readonly on: readonly ErrorCode[]; readonly backoffMs: readonly number[] };
  readonly breaker: { readonly consecutiveFailures: number };
  readonly guardrails: { readonly in: readonly string[]; readonly out: readonly string[] };
}

/** Predicates are contravariant in their payload, so heterogeneous collections use this. */
export type AnyContract = Contract<any, any>;

type Defaulted = 'capabilities' | 'egress' | 'redactor' | 'obligations' | 'retry' | 'breaker' | 'guardrails' | 'requires' | 'guarantees';
export type ContractSpec<I, O> = Omit<Contract<I, O>, Defaulted> & Partial<Pick<Contract<I, O>, Defaulted>>;

const kebab = /^[a-z][a-z0-9-]*$/;
const dotted = /^[a-z][a-z0-9.-]*$/;
const guardrailId = /^G-[A-Z0-9-]+$/;

const Meta = z.object({
  id: z.string().regex(kebab, 'id must be kebab-case'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver x.y.z'),
  description: z
    .string()
    .min(10, 'description must say what the agent does')
    .refine((d) => !/\band\b/i.test(d), 'description contains "and": one agent does one skill, so split it'),
  skills: z.array(z.string().min(1)).min(1),
  team: z.string().regex(kebab, 'team must be kebab-case'),
  kind: z.enum(AGENT_KINDS),
  capabilities: z
    .object({
      http: z.literal(true).optional(),
      llm: z.object({ model: z.string().min(1), maxTokens: z.number().int().positive() }).strict().optional(),
    })
    .strict(),
  egress: z.array(z.string().regex(/^[a-z0-9.-]+$/, 'egress entries are bare host names')),
  dataClasses: z.object({ in: z.array(z.enum(DATA_CLASSES)).min(1), out: z.array(z.enum(DATA_CLASSES)).min(1) }),
  redactor: z.boolean(),
  emits: z.enum(DATA_CLASSES).optional(),
  obligations: z.object({
    adds: z.array(z.object({ id: z.string().regex(dotted), dischargedBy: z.string().regex(kebab) }).strict()),
    discharges: z.array(z.string().regex(dotted)),
  }),
  guardrails: z.object({ in: z.array(z.string().regex(guardrailId)), out: z.array(z.string().regex(guardrailId)) }),
  budget: z
    .object({ usdPerCall: z.number().nonnegative(), usdPerRun: z.number().nonnegative() })
    .refine((b) => b.usdPerRun >= b.usdPerCall, 'budget.usdPerRun must be at least budget.usdPerCall'),
  timeoutMs: z.number().int().positive().max(600_000),
  retry: z
    .object({
      max: z.number().int().min(0).max(5),
      on: z.array(z.enum(ERROR_CODES)),
      backoffMs: z.array(z.number().int().nonnegative()),
    })
    .refine((r) => r.backoffMs.length === r.max, 'retry.backoffMs needs exactly one entry per retry')
    .refine((r) => r.max === 0 || r.on.length > 0, 'retry.max > 0 needs at least one code in retry.on')
    .refine((r) => r.on.every((c) => RETRYABLE.has(c)), 'retry.on may only list retryable codes'),
  breaker: z.object({ consecutiveFailures: z.number().int().min(1) }),
});

export function defineContract<I, O>(spec: ContractSpec<I, O>): Contract<I, O> {
  const c: Contract<I, O> = {
    capabilities: {},
    egress: [],
    redactor: false,
    obligations: { adds: [], discharges: [] },
    retry: { max: 0, on: [], backoffMs: [] },
    breaker: { consecutiveFailures: 5 },
    guardrails: { in: [], out: [] },
    requires: [],
    guarantees: [],
    ...spec,
  };
  const parsed = Meta.safeParse(c);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new TypeError(`contract ${spec.id}: ${msg}`);
  }
  checkKindCapabilities(c);
  return deepFreeze(snapshot(c));
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
  return v;
}

/** Copies every array and plain object the spec owns. consumes/produces/predicates are shared by reference. */
function snapshot<I, O>(c: Contract<I, O>): Contract<I, O> {
  const { capabilities } = c;
  return {
    ...c,
    skills: [...c.skills],
    requires: [...c.requires],
    guarantees: [...c.guarantees],
    capabilities: {
      ...(capabilities.http ? { http: capabilities.http } : {}),
      ...(capabilities.llm ? { llm: { ...capabilities.llm } } : {}),
    },
    egress: [...c.egress],
    dataClasses: { in: [...c.dataClasses.in], out: [...c.dataClasses.out] },
    obligations: { adds: c.obligations.adds.map((a) => ({ ...a })), discharges: [...c.obligations.discharges] },
    budget: { ...c.budget },
    retry: { max: c.retry.max, on: [...c.retry.on], backoffMs: [...c.retry.backoffMs] },
    breaker: { ...c.breaker },
    guardrails: { in: [...c.guardrails.in], out: [...c.guardrails.out] },
  };
}

function checkKindCapabilities(c: AnyContract): void {
  const problems: string[] = [];
  if (c.kind === 'llm' && !c.capabilities.llm) problems.push('kind llm requires capabilities.llm');
  if (c.kind !== 'llm' && c.capabilities.llm) problems.push(`kind ${c.kind} may not request capabilities.llm`);
  const httpKinds: readonly AgentKind[] = ['io', 'io-session', 'effect'];
  if (c.capabilities.http && !httpKinds.includes(c.kind)) problems.push(`kind ${c.kind} may not request capabilities.http`);
  if (c.capabilities.http && c.egress.length === 0) problems.push('capabilities.http requires at least one egress host');
  if (c.egress.length > 0 && !c.capabilities.http && !c.capabilities.llm) problems.push('egress requires capabilities.http or capabilities.llm');
  if ((c.kind === 'deterministic' || c.kind === 'human') && c.egress.length > 0) problems.push(`kind ${c.kind} may not declare egress`);
  if (c.kind === 'deterministic' && c.budget.usdPerCall > 0) problems.push('kind deterministic has no spend, so budget must be 0');
  if (c.emits !== undefined && !c.dataClasses.out.includes(c.emits)) problems.push(`emits ${c.emits} is not in dataClasses.out`);
  if (problems.length > 0) throw new TypeError(`contract ${c.id}: ${problems.join('; ')}`);
}

export function contractMajor(c: Pick<Contract, 'version'>): string {
  return c.version.split('.')[0] ?? '0';
}

/** The interface (types, predicates, capabilities, data classes) and the governance settings (budget, timeout, retry, breaker, guardrails, obligations). Changing any of it without a version bump is drift. */
export function contractShape(c: AnyContract): Record<string, unknown> {
  return {
    id: c.id,
    version: c.version,
    kind: c.kind,
    team: c.team,
    consumes: { type: c.consumes.id, schema: z.toJSONSchema(c.consumes.schema) },
    produces: { type: c.produces.id, schema: z.toJSONSchema(c.produces.schema) },
    requires: c.requires.map((p) => p.id).sort(),
    guarantees: c.guarantees.map((p) => p.id).sort(),
    capabilities: c.capabilities,
    egress: [...c.egress].sort(),
    dataClasses: { in: [...c.dataClasses.in].sort(), out: [...c.dataClasses.out].sort() },
    redactor: c.redactor,
    // Only present when declared, so contracts without it keep their hash.
    ...(c.emits !== undefined ? { emits: c.emits } : {}),
    obligations: {
      adds: [...c.obligations.adds].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((a) => ({ id: a.id, dischargedBy: a.dischargedBy })),
      discharges: [...c.obligations.discharges].sort(),
    },
    budget: c.budget,
    timeoutMs: c.timeoutMs,
    breaker: c.breaker,
    retry: { max: c.retry.max, on: [...c.retry.on].sort(), backoffMs: c.retry.backoffMs },
    guardrails: { in: c.guardrails.in, out: c.guardrails.out },
  };
}

export function contractHash(c: AnyContract): string {
  return hashOf(contractShape(c));
}
