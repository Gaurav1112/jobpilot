import type { AnyAgent } from './agent.js';
import { contractHash } from './contract.js';

export class Registry {
  private readonly agents = new Map<string, AnyAgent>();
  private readonly hashes = new Map<string, string>();

  register(agent: AnyAgent): void {
    const c = agent.contract;
    if (this.agents.has(c.id)) throw new Error(`agent ${c.id} registered twice`);
    this.agents.set(c.id, agent);
    this.hashes.set(`${c.id}@${c.version}`, contractHash(c));
  }

  get(id: string): AnyAgent {
    const a = this.agents.get(id);
    if (!a) throw new Error(`unknown agent ${id}`);
    return a;
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  /** Sorted by id so iteration order never depends on registration order. */
  list(): AnyAgent[] {
    return [...this.agents.values()].sort((a, b) => (a.contract.id < b.contract.id ? -1 : 1));
  }

  contractHashOf(agentId: string, version: string): string | undefined {
    return this.hashes.get(`${agentId}@${version}`);
  }
}
