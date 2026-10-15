import { z } from 'zod';
import { canonicalJson, hashOf } from './canonical.js';
import { DATA_CLASSES, type DataClass } from './data-class.js';
import { ERROR_CODES, RETRYABLE, type ErrorCode } from './errors.js';
import type { Predicate } from './predicates.js';
import type { MessageType } from './types.js';

/**
 * Symbolic egress entries. A contract may name one instead of fixed hosts when its hosts are the user's data (the
 * careers sites of the watchlist): the contract, and so its hash, stays the same whatever the hosts are, and the
 * broker resolves the entry at call time from the `egressSets` the supervisor is given (exact hosts, still checked
 * against the policy and its deny lists). A set that is not given resolves to no host at all.
 * `pack:careers-hosts` is the watchlist's careers hosts; `coverage:candidate-hosts` is the hosts of the weekly coverage
 * run's candidate companies (the careers locator's plan); `registry:workday-hosts` is the hosts of the verified
 * Workday companies in the company registry (the daily Workday adapter's); `registry:eightfold-hosts` and
 * `registry:oracle-hosts` likewise for the verified Eightfold and Oracle Recruiting Cloud companies (Task 7), and
 * `registry:icims-hosts`, `registry:successfactors-hosts`, `registry:smartrecruiters-hosts`, `registry:jsonld-hosts` for
 * the page adapters' companies (Task 8), and `registry:<platform>-hosts` for each of the nine small platforms (Task 9:
 * workable, recruitee, teamtailor, personio, bamboohr, breezy, pinpoint, rippling, gem).
 */
export const SYMBOLIC_EGRESS = [
  'pack:careers-hosts',
  'coverage:candidate-hosts',
  'registry:workday-hosts',
  'registry:eightfold-hosts',
  'registry:oracle-hosts',
  'registry:icims-hosts',
  'registry:successfactors-hosts',
  'registry:smartrecruiters-hosts',
  'registry:jsonld-hosts',
  'registry:workable-hosts',
  'registry:recruitee-hosts',
  'registry:teamtailor-hosts',
  'registry:personio-hosts',
  'registry:bamboohr-hosts',
  'registry:breezy-hosts',
  'registry:pinpoint-hosts',
  'registry:rippling-hosts',
  'registry:gem-hosts',
  'registry:jazzhr-hosts',
  'registry:freshteam-hosts',
  'registry:zohorecruit-hosts',
] as const;
export type SymbolicEgress = (typeof SYMBOLIC_EGRESS)[number];
export const isSymbolicEgress = (e: string): e is SymbolicEgress => (SYMBOLIC_EGRESS as readonly string[]).includes(e);

export const AGENT_KINDS = ['deterministic', 'llm', 'io', 'io-session', 'human', 'effect'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export interface Capabilities {
  readonly http?: true;
  /**
   * `ctx.http.postJson`: one JSON POST to an egress host (a search query a platform's own public page sends, e.g.
   * Workday's CXS job list). Needs `http`. Without it `postJson` is a policy denial, so an agent that only reads by GET
   * (the Gmail source, every board API) can never send a POST.
   */
  readonly httpPost?: true;
  /**
   * `ctx.http.getStream` with a byte cap above the policy's `maxResponseBytes` (at most STREAM_MAX_BYTES): one feed too
   * large to hold whole (SuccessFactors' `sitemal.xml`), handed to the agent chunk by chunk. Needs `http`. Without it a
   * stream is capped at `maxResponseBytes`, like every other response.
   */
  readonly httpStream?: true;
  readonly llm?: { readonly model: string; readonly maxTokens: number };
  /**
   * Read-only access to the user's pack as `ctx.pack` (deep-frozen). `true` is the public pack;
   * `'full'` also carries P1 contact details. The step key includes the matching pack hash, so a
   * pack edit re-runs only the agents that read it.
   */
  readonly pack?: true | 'full';
  /**
   * Read-only page rendering as `ctx.browser.render(url)`, at most `maxPages` renders per step, to the exact
   * `egress` hosts only. There is deliberately nothing else here: no stealth, proxy, user-agent, header or
   * fingerprint option exists (G-NO-EVASION), and the strict meta-schema rejects any extra key.
   */
  readonly browser?: { readonly maxPages: number };
  /**
   * Files under one named root (`out`: the documents folder the app configures as `providers.fileRoots.out`), as
   * `ctx.files.read(relPath)` and, with `access: 'read-write'`, `ctx.files.write(relPath, bytes)`. Paths are relative,
   * with no `..`, NUL, backslash or symlink; nothing is ever written into an `applied-*` directory.
   */
  readonly files?: { readonly root: 'out'; readonly access: 'read' | 'read-write' };
  /** `ctx.pdfText(relPath)`: the text layer of a PDF under the files root (`pdftotext -layout`). Needs `files`. */
  readonly pdfText?: true;
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

/** Strict: an unknown key in a contract spec is a typo or a smuggled field, so it is rejected. */
const Meta = z
  .object({
    consumes: z.custom<MessageType<unknown>>((v) => typeof v === 'object' && v !== null, 'consumes must be a message type'),
    produces: z.custom<MessageType<unknown>>((v) => typeof v === 'object' && v !== null, 'produces must be a message type'),
    requires: z.array(z.custom<Predicate<unknown>>((v) => typeof v === 'object' && v !== null)),
    guarantees: z.array(z.custom<Predicate<unknown>>((v) => typeof v === 'object' && v !== null)),
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
        httpPost: z.literal(true).optional(),
        httpStream: z.literal(true).optional(),
        llm: z.object({ model: z.string().min(1), maxTokens: z.number().int().positive() }).strict().optional(),
        pack: z.union([z.literal(true), z.literal('full')]).optional(),
        browser: z.object({ maxPages: z.number().int().positive().max(500) }).strict().optional(),
        files: z.object({ root: z.literal('out'), access: z.enum(['read', 'read-write']) }).strict().optional(),
        pdfText: z.literal(true).optional(),
      })
      .strict(),
    egress: z.array(
      z.string().refine((e) => /^[a-z0-9.-]+$/.test(e) || isSymbolicEgress(e), `egress entries are bare host names or a known symbolic set (${SYMBOLIC_EGRESS.join(', ')})`),
    ),
    dataClasses: z.object({ in: z.array(z.enum(DATA_CLASSES)).min(1), out: z.array(z.enum(DATA_CLASSES)).min(1) }).strict(),
    redactor: z.boolean(),
    emits: z.enum(DATA_CLASSES).optional(),
    obligations: z.object({
      adds: z.array(z.object({ id: z.string().regex(dotted), dischargedBy: z.string().regex(kebab) }).strict()),
      discharges: z.array(z.string().regex(dotted)),
    })
    .strict(),
    guardrails: z.object({ in: z.array(z.string().regex(guardrailId)), out: z.array(z.string().regex(guardrailId)) }).strict(),
    budget: z
      .object({ usdPerCall: z.number().nonnegative(), usdPerRun: z.number().nonnegative() })
      .strict()
      .refine((b) => b.usdPerRun >= b.usdPerCall, 'budget.usdPerRun must be at least budget.usdPerCall'),
    timeoutMs: z.number().int().positive().max(1_800_000),
    retry: z
      .object({
        max: z.number().int().min(0).max(5),
        on: z.array(z.enum(ERROR_CODES)),
        backoffMs: z.array(z.number().int().nonnegative()),
      })
      .strict()
      .refine((r) => r.backoffMs.length === r.max, 'retry.backoffMs needs exactly one entry per retry')
      .refine((r) => r.max === 0 || r.on.length > 0, 'retry.max > 0 needs at least one code in retry.on')
      .refine((r) => r.on.every((c) => RETRYABLE.has(c)), 'retry.on may only list retryable codes'),
    breaker: z.object({ consecutiveFailures: z.number().int().min(1) }).strict(),
  })
  .strict();

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
      ...(capabilities.httpPost ? { httpPost: capabilities.httpPost } : {}),
      ...(capabilities.httpStream ? { httpStream: capabilities.httpStream } : {}),
      ...(capabilities.llm ? { llm: { ...capabilities.llm } } : {}),
      ...(capabilities.pack ? { pack: capabilities.pack } : {}),
      ...(capabilities.browser ? { browser: { maxPages: capabilities.browser.maxPages } } : {}),
      ...(capabilities.files ? { files: { root: capabilities.files.root, access: capabilities.files.access } } : {}),
      ...(capabilities.pdfText ? { pdfText: capabilities.pdfText } : {}),
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
  if (c.capabilities.httpPost && !c.capabilities.http) problems.push('capabilities.httpPost requires capabilities.http');
  if (c.capabilities.httpStream && !c.capabilities.http) problems.push('capabilities.httpStream requires capabilities.http');
  const browserKinds: readonly AgentKind[] = ['io', 'io-session'];
  if (c.capabilities.browser && !browserKinds.includes(c.kind)) problems.push(`kind ${c.kind} may not request capabilities.browser`);
  if (c.capabilities.browser && c.egress.length === 0) problems.push('capabilities.browser requires at least one egress host');
  if (c.egress.length > 0 && !c.capabilities.http && !c.capabilities.llm && !c.capabilities.browser) {
    problems.push('egress requires capabilities.http, capabilities.llm or capabilities.browser');
  }
  if ((c.kind === 'deterministic' || c.kind === 'human') && c.egress.length > 0) problems.push(`kind ${c.kind} may not declare egress`);
  if (c.kind === 'deterministic' && c.budget.usdPerCall > 0) problems.push('kind deterministic has no spend, so budget must be 0');
  if (c.emits !== undefined && !c.dataClasses.out.includes(c.emits)) problems.push(`emits ${c.emits} is not in dataClasses.out`);
  const writeKinds: readonly AgentKind[] = ['io', 'io-session', 'effect'];
  if (c.capabilities.files?.access === 'read-write' && !writeKinds.includes(c.kind)) problems.push(`kind ${c.kind} may not write files`);
  if (c.capabilities.pdfText && !c.capabilities.files) problems.push('capabilities.pdfText requires capabilities.files');
  // M7: contact details make an output P1 whatever the agent returns, so a 'full' pack agent must say so and may not redact.
  if (c.capabilities.pack === 'full' && (c.emits === undefined || DATA_CLASSES.indexOf(c.emits) < DATA_CLASSES.indexOf('P1'))) {
    problems.push("capabilities.pack 'full' requires emits P1 or higher");
  }
  if (c.capabilities.pack === 'full' && c.redactor) problems.push("capabilities.pack 'full' may not be a redactor");
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

/** The fields that decide what an agent may touch and how tainted its outputs are. Changing any of them needs a major version. */
export const SECURITY_FIELDS = ['kind', 'capabilities', 'egress', 'dataClasses', 'redactor', 'emits'] as const;

/** Security-relevant fields that differ between two contract shapes, in SECURITY_FIELDS order. */
export function securityDiff(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return SECURITY_FIELDS.filter((f) => canonicalJson({ v: a[f] }) !== canonicalJson({ v: b[f] }));
}

export function contractHash(c: AnyContract): string {
  return hashOf(contractShape(c));
}
