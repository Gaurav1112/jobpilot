import { canonicalJson } from '../canonical.js';
import type { GuardrailVerdict } from '../envelope.js';
import { type Guardrail, GuardrailRegistry } from './index.js';

const pass = (id: string): GuardrailVerdict => ({ id, verdict: 'pass' });
const trip = (id: string, detail: string): GuardrailVerdict => ({ id, verdict: 'trip', detail });

/** Strict parse, and the parse must not change the payload: no coercion, no defaults, no repair. */
export const G_SCHEMA: Guardrail = {
  id: 'G-SCHEMA',
  sides: ['in', 'out'],
  check(ctx) {
    if (ctx.side === 'out' && !ctx.output) return trip('G-SCHEMA', 'no output to check');
    const type = ctx.side === 'in' ? ctx.contract.consumes : ctx.contract.produces;
    const payload = ctx.side === 'in' ? ctx.input.payload : ctx.output?.payload;
    if (ctx.side === 'in' && ctx.input.type !== type.id) return trip('G-SCHEMA', `envelope type ${ctx.input.type}, contract consumes ${type.id}`);
    const r = type.schema.safeParse(payload);
    if (!r.success) {
      const i = r.error.issues[0];
      return trip('G-SCHEMA', `${type.id}: ${i ? `${i.path.join('.') || '(root)'} ${i.message}` : 'invalid'}`);
    }
    if (canonicalJson(r.data) !== canonicalJson(payload)) return trip('G-SCHEMA', `${type.id}: schema would coerce the payload`);
    return pass('G-SCHEMA');
  },
};

export const G_LINEAGE: Guardrail = {
  id: 'G-LINEAGE',
  sides: ['in'],
  check(ctx) {
    const p = ctx.input.producer;
    const known = ctx.contractHashOf(p.agentId, p.version);
    if (known === undefined) return trip('G-LINEAGE', `unknown producer ${p.agentId}@${p.version}`);
    if (known !== p.contractHash) return trip('G-LINEAGE', `${p.agentId}@${p.version} contract hash does not match the registry`);
    if (ctx.input.handoff.pins.policyHash !== ctx.policyHash) return trip('G-LINEAGE', 'envelope was produced under a different policy');
    return pass('G-LINEAGE');
  },
};

export const G_DATACLASS: Guardrail = {
  id: 'G-DATACLASS',
  sides: ['in', 'out'],
  check(ctx) {
    if (ctx.side === 'in') {
      const c = ctx.input.handoff.dataClass;
      return ctx.contract.dataClasses.in.includes(c) ? pass('G-DATACLASS') : trip('G-DATACLASS', `${ctx.contract.id} may not receive ${c} data`);
    }
    if (!ctx.output) return trip('G-DATACLASS', 'no output to check');
    if (ctx.contract.redactor && !ctx.policy.redactors.includes(ctx.contract.id)) {
      return trip('G-DATACLASS', `redactor ${ctx.contract.id} is not allowed by policy`);
    }
    const c = ctx.output.dataClass;
    return ctx.contract.dataClasses.out.includes(c) ? pass('G-DATACLASS') : trip('G-DATACLASS', `output would carry ${c}, contract emits ${ctx.contract.dataClasses.out.join('/')}`);
  },
};

export const G_SIZE: Guardrail = {
  id: 'G-SIZE',
  sides: ['in'],
  check(ctx) {
    const bytes = Buffer.byteLength(canonicalJson(ctx.input.payload), 'utf8');
    return bytes <= ctx.policy.maxPayloadBytes ? pass('G-SIZE') : trip('G-SIZE', `${bytes} bytes > ${ctx.policy.maxPayloadBytes}`);
  },
};

/** The producer must have promised it, and it must hold on the actual payload. */
export const G_PRE: Guardrail = {
  id: 'G-PRE',
  sides: ['in'],
  check(ctx) {
    for (const p of ctx.contract.requires) {
      if (!ctx.input.handoff.guarantees.includes(p.id)) return trip('G-PRE', `${p.id} was not guaranteed by ${ctx.input.producer.agentId}`);
      if (!p.test(ctx.input.payload)) return trip('G-PRE', `${p.id} does not hold on the input`);
    }
    return pass('G-PRE');
  },
};

export const G_POST: Guardrail = {
  id: 'G-POST',
  sides: ['out'],
  check(ctx) {
    if (!ctx.output) return trip('G-POST', 'no output to check');
    for (const p of ctx.contract.guarantees) {
      if (!p.test(ctx.output.payload)) return trip('G-POST', `${p.id} does not hold on the output`);
    }
    return pass('G-POST');
  },
};

export const BUILTIN_GUARDRAILS: readonly Guardrail[] = [G_SCHEMA, G_LINEAGE, G_DATACLASS, G_SIZE, G_PRE, G_POST];

export function builtinGuardrails(): GuardrailRegistry {
  return new GuardrailRegistry(BUILTIN_GUARDRAILS);
}
