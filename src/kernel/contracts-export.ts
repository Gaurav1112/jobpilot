import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
  const paths = registry.list().map((a) => {
    const c = a.contract;
    const path = fileOf(dir, c.id, contractMajor(c));
    writeFileSync(path, render({ hash: contractHash(c), shape: contractShape(c) }));
    return path;
  });
  // The directory is generated: anything this run did not write is stale.
  const written = new Set(paths.map((p) => basename(p)));
  for (const f of readdirSync(dir)) if (f.endsWith('.json') && !written.has(f) && statSync(join(dir, f)).isFile()) unlinkSync(join(dir, f));
  return paths;
}

const semverParts = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);

/** Numeric x.y.z comparison: negative when a < b. */
function compareVersions(a: string, b: string): number {
  const [pa, pb] = [semverParts(a), semverParts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function readDoc(path: string): ContractDoc | undefined {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Partial<ContractDoc> | null;
    if (doc && typeof doc.hash === 'string' && typeof doc.shape === 'object' && doc.shape !== null) return doc as ContractDoc;
  } catch {
    // fall through: unreadable
  }
  return undefined;
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
    const doc = readDoc(path);
    if (!doc) {
      problems.push(`${c.id}@${contractMajor(c)}: contract file is unreadable; run node --run contracts:export`);
      continue;
    }
    const committedVersion = (doc.shape as { version?: string }).version;
    if (committedVersion === c.version && doc.hash !== contractHash(c)) {
      problems.push(`${c.id}@${c.version}: contract changed without a version bump`);
    } else if (committedVersion === c.version && canonicalJson(doc.shape) !== canonicalJson(contractShape(c))) {
      problems.push(`${c.id}@${c.version}: contracts-out file was edited by hand; run node --run contracts:export`);
    } else if (committedVersion !== c.version && typeof committedVersion === 'string' && compareVersions(committedVersion, c.version) > 0) {
      problems.push(`${c.id}: code version ${c.version} is older than the exported ${committedVersion}`);
    } else if (committedVersion !== c.version) {
      problems.push(`${c.id}: version ${c.version} is not exported yet (committed ${committedVersion}); run node --run contracts:export`);
    }
  }
  const expected = new Set(registry.list().map((a) => `${a.contract.id}@${contractMajor(a.contract)}.json`));
  const stale = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith('.json') && !expected.has(f)).sort();
  for (const f of stale) problems.push(`${f}: no registered agent exports this contract; delete it or restore the agent`);
  return problems;
}
