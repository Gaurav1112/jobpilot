import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './canonical.js';
import { contractHash, contractMajor, contractShape } from './contract.js';
import type { Registry } from './registry.js';

export interface ContractDoc {
  readonly hash: string;
  readonly shape: Record<string, unknown>;
}

const fileOf = (dir: string, id: string, major: string) => join(dir, `${id}@${major}.json`);

/** Pretty, key-sorted JSON so diffs are reviewable. */
function render(doc: ContractDoc): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(doc)), null, 2)}\n`;
}

export function exportContracts(registry: Registry, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  return registry.list().map((a) => {
    const c = a.contract;
    const path = fileOf(dir, c.id, contractMajor(c));
    writeFileSync(path, render({ hash: contractHash(c), shape: contractShape(c) }));
    return path;
  });
}

/** A contract that changed shape without a version bump is drift: other agents rely on the old shape. */
export function checkDrift(registry: Registry, dir: string): string[] {
  const problems: string[] = [];
  for (const a of registry.list()) {
    const c = a.contract;
    const path = fileOf(dir, c.id, contractMajor(c));
    if (!existsSync(path)) {
      problems.push(`${c.id}@${contractMajor(c)}: no exported contract; run node --run contracts:export`);
      continue;
    }
    const doc = JSON.parse(readFileSync(path, 'utf8')) as ContractDoc;
    const committedVersion = (doc.shape as { version?: string }).version;
    if (committedVersion === c.version && doc.hash !== contractHash(c)) {
      problems.push(`${c.id}@${c.version}: contract changed without a version bump`);
    } else if (committedVersion !== c.version) {
      problems.push(`${c.id}: version ${c.version} is not exported yet (committed ${committedVersion}); run node --run contracts:export`);
    }
  }
  return problems;
}
