import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('reports a stale export no agent maps to, and export removes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    exportContracts(registry(...demoAgents), dir);
    writeFileSync(join(dir, 'ghost@1.json'), '{}');
    expect(checkDrift(registry(...demoAgents), dir)).toEqual(['ghost@1.json: no registered agent exports this contract; delete it or restore the agent']);
    exportContracts(registry(...demoAgents), dir);
    expect(existsSync(join(dir, 'ghost@1.json'))).toBe(false);
    expect(checkDrift(registry(...demoAgents), dir)).toEqual([]);
  });

  it('notices a shape edited by hand while the hash is intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    const [, source] = exportContracts(registry(...demoAgents), dir);
    const doc = JSON.parse(readFileSync(source!, 'utf8'));
    writeFileSync(source!, JSON.stringify({ ...doc, shape: { ...doc.shape, kind: 'tampered' } }));
    expect(checkDrift(registry(...demoAgents), dir)).toEqual(['demo-source@1.0.0: contracts-out file was edited by hand; run node --run contracts:export']);
  });

  it('reports a committed version newer than the code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    const [, source] = exportContracts(registry(...demoAgents), dir);
    const doc = JSON.parse(readFileSync(source!, 'utf8'));
    writeFileSync(source!, JSON.stringify({ ...doc, shape: { ...doc.shape, version: '9.0.0' } }));
    expect(checkDrift(registry(...demoAgents), dir)).toEqual(['demo-source: code version 1.0.0 is older than the exported 9.0.0']);
  });

  it('reports an unreadable contract file instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    const [, source] = exportContracts(registry(...demoAgents), dir);
    writeFileSync(source!, 'not json {');
    expect(checkDrift(registry(...demoAgents), dir)).toEqual(['demo-source@1: contract file is unreadable; run node --run contracts:export']);
  });

  it('reports a missing export directory instead of throwing', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'contracts-')), 'nope');
    expect(checkDrift(registry(...demoAgents), dir)).toEqual([
      'demo-scorer@1: no exported contract; run node --run contracts:export',
      'demo-source@1: no exported contract; run node --run contracts:export',
    ]);
  });

  it('leaves a directory named like a json file alone on export', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    mkdirSync(join(dir, 'x.json'));
    expect(() => exportContracts(registry(...demoAgents), dir)).not.toThrow();
    expect(existsSync(join(dir, 'x.json'))).toBe(true);
  });
});
