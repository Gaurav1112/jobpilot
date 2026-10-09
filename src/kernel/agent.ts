import type { AgentContext } from './broker.js';
import type { Contract } from './contract.js';

/** Re-exported so agent code can name its context type without importing the broker. */
export type { AgentContext };

export interface Agent<I = unknown, O = unknown> {
  readonly contract: Contract<I, O>;
  /** Return outputs in a deterministic order; the index is part of each envelope id. */
  run(input: I, ctx: AgentContext): Promise<readonly O[]>;
}

/** Registries hold agents of many payload types. */
export type AnyAgent = Agent<any, any>;

export function defineAgent<I, O>(contract: Contract<I, O>, run: (input: I, ctx: AgentContext) => Promise<readonly O[]>): Agent<I, O> {
  return Object.freeze({ contract, run });
}
