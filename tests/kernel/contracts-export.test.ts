import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineAgent } from '../../src/kernel/agent.js';
import { checkDrift, exportContracts } from '../../src/kernel/contracts-export.js';
import { defineContract } from '../../src/kernel/contract.js';
import { Registry } from '../../src/kernel/registry.js';
import { demoAgents } from '../../src/demo/pipeline.js';
import { demoSource } from '../../src/demo/agents.js';
import { itemIdSet, scoreInRange } from '../../src/demo/types.js';

const registry = (...agents: Parameters<Registry['register']>[0][]) => {
  const r = new Registry();
  for (const a of agents) r.register(a);
  return r;
};

describe('contract export and drift', () => {
  it('the committed contracts-out/ matches the code', () => {
    expect(checkDrift(registry(...demoAgents), join(import.meta.dirname, '../../contracts-out'))).toEqual([]);
  });

  it('writes one file per agent major, with JSON Schemas for both message types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    const paths = exportContracts(registry(...demoAgents), dir);
    expect(paths.map((p) => p.split('/').at(-1))).toEqual(['demo-scorer@1.json', 'demo-source@1.json']);
    const doc = JSON.parse(readFileSync(paths[1]!, 'utf8'));
    expect(doc.shape.produces.schema.additionalProperties).toBe(false);
  });

  it('fails when a guarantee changes but the version does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    exportContracts(registry(...demoAgents), dir);
    const changed = defineAgent(defineContract({ ...demoSource.contract, guarantees: [itemIdSet, scoreInRange as never] }), demoSource.run);
    expect(checkDrift(registry(changed, demoAgents[1]), dir)).toEqual(['demo-source@1.0.0: contract changed without a version bump']);
  });

  it('asks for an export when the version was bumped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    exportContracts(registry(...demoAgents), dir);
    const bumped = defineAgent(defineContract({ ...demoSource.contract, version: '1.1.0' }), demoSource.run);
    expect(checkDrift(registry(bumped, demoAgents[1]), dir)[0]).toMatch(/1\.1\.0 is not exported yet/);
  });

  it('notices a hand-edited contract file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    const [scorer] = exportContracts(registry(...demoAgents), dir);
    const doc = JSON.parse(readFileSync(scorer!, 'utf8'));
    writeFileSync(scorer!, JSON.stringify({ ...doc, hash: 'tampered' }));
    expect(checkDrift(registry(...demoAgents), dir)).toEqual(['demo-scorer@1.0.0: contract changed without a version bump']);
  });
});
