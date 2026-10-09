import type { AnyContract } from '../contract.js';
import type { DataClass } from '../data-class.js';
import type { Envelope, GuardrailVerdict } from '../envelope.js';
import type { Policy } from '../policy.js';

export type Side = 'in' | 'out';

export interface GuardrailContext {
  readonly side: Side;
  readonly contract: AnyContract;
  readonly policy: Policy;
  readonly policyHash: string;
  /** Resolves the registered contract hash for a producer; undefined if unknown. */
  readonly contractHashOf: (agentId: string, version: string) => string | undefined;
  readonly input: Envelope;
  /** Present on the out side: one output payload and its computed data class. */
  readonly output?: { readonly payload: unknown; readonly dataClass: DataClass };
  /** The user's public pack, deep-frozen; passed whenever the supervisor has one, whatever the contract declares. */
  readonly pack?: Readonly<unknown>;
  /**
   * The full pack (with P1 contact details and answers), deep-frozen; present only when the contract declares
   * `capabilities.pack: 'full'`, so a guardrail can re-derive what that agent rendered from what it read.
   */
  readonly fullPack?: Readonly<unknown>;
}

/** A pure function of the envelope, the contract and the policy. */
export interface Guardrail {
  readonly id: string;
  readonly sides: readonly Side[];
  check(ctx: GuardrailContext): GuardrailVerdict;
}

/** These run on every step whether or not a contract lists them: the kernel fails closed. */
export const MANDATORY: Readonly<Record<Side, readonly string[]>> = {
  in: ['G-SCHEMA', 'G-LINEAGE', 'G-DATACLASS', 'G-SIZE', 'G-PRE'],
  out: ['G-SCHEMA', 'G-DATACLASS', 'G-POST'],
};

export class GuardrailRegistry {
  private readonly byId = new Map<string, Guardrail>();

  constructor(guardrails: readonly Guardrail[] = []) {
    for (const g of guardrails) this.add(g);
  }

  add(g: Guardrail): void {
    if (this.byId.has(g.id)) throw new Error(`guardrail ${g.id} registered twice`);
    this.byId.set(g.id, g);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Mandatory ids first, then the contract's own, deduplicated; stops at the first trip. */
  run(side: Side, ctx: GuardrailContext): { verdicts: GuardrailVerdict[]; tripped: boolean } {
    const declared = side === 'in' ? ctx.contract.guardrails.in : ctx.contract.guardrails.out;
    const ids = [...new Set([...MANDATORY[side], ...declared])];
    const verdicts: GuardrailVerdict[] = [];
    for (const id of ids) {
      const g = this.byId.get(id);
      if (!g) {
        verdicts.push({ id, verdict: 'trip', detail: 'unknown guardrail' });
        return { verdicts, tripped: true };
      }
      if (!g.sides.includes(side)) {
        if (MANDATORY[side].includes(id)) {
          verdicts.push({ id, verdict: 'trip', detail: `mandatory guardrail does not run on the ${side} side` });
          return { verdicts, tripped: true };
        }
        continue;
      }
      let v: GuardrailVerdict;
      try {
        v = g.check({ ...ctx, side });
      } catch (e) {
        v = { id, verdict: 'trip', detail: `guardrail threw: ${e instanceof Error ? e.message : String(e)}` };
      }
      const kind: unknown = (v as { verdict?: unknown } | null | undefined)?.verdict;
      const validId = (v as { id?: unknown } | null | undefined)?.id === id;
      if (!validId || (kind !== 'pass' && kind !== 'warn' && kind !== 'trip')) {
        verdicts.push({ id, verdict: 'trip', detail: 'guardrail returned an invalid verdict' });
        return { verdicts, tripped: true };
      }
      verdicts.push(v);
      if (v.verdict === 'trip') return { verdicts, tripped: true };
    }
    return { verdicts, tripped: false };
  }
}
