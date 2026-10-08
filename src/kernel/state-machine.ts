import { InvalidTransition } from './errors.js';

export interface MachineDef<S extends string, E extends string> {
  readonly id: string;
  /** State an entity is in before its first event. */
  readonly initial: S;
  readonly terminal: readonly S[];
  /** `from: '*'` matches any non-terminal state; exact matches win. */
  readonly transitions: readonly { readonly from: S | '*'; readonly on: E; readonly to: S }[];
}

export class StateMachine<S extends string = string, E extends string = string> {
  constructor(readonly def: MachineDef<S, E>) {
    const seen = new Set<string>();
    for (const t of def.transitions) {
      const k = `${t.from}|${t.on}`;
      if (seen.has(k)) throw new Error(`${def.id}: duplicate transition ${t.from} --${t.on}-->`);
      seen.add(k);
      if (t.from !== '*' && def.terminal.includes(t.from)) throw new Error(`${def.id}: terminal state ${t.from} has an outgoing transition`);
    }
  }

  next(from: S, on: E): S {
    const exact = this.def.transitions.find((t) => t.from === from && t.on === on);
    if (exact) return exact.to;
    if (!this.def.terminal.includes(from)) {
      const any = this.def.transitions.find((t) => t.from === '*' && t.on === on);
      if (any) return any.to;
    }
    throw new InvalidTransition(this.def.id, from, on);
  }

  isTerminal(s: S): boolean {
    return this.def.terminal.includes(s);
  }
}
