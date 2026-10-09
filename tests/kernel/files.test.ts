import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAgent } from '../../src/kernel/agent.js';
import { issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { contractHash, defineContract, type ContractSpec } from '../../src/kernel/contract.js';
import { type Envelope, ZERO_COST } from '../../src/kernel/envelope.js';
import { KernelError } from '../../src/kernel/errors.js';
import { executeStep } from '../../src/kernel/executor.js';
import { builtinGuardrails } from '../../src/kernel/guardrails/builtin.js';
import { PRODUCT_POLICY_V1, policyHash } from '../../src/kernel/policy.js';
import type { Providers } from '../../src/kernel/providers.js';
import { Store } from '../../src/kernel/store/store.js';
import { defineType } from '../../src/kernel/types.js';

const In = defineType('FileIn', 1, z.object({ n: z.number() }).strict());
const Out = defineType('FileOut', 1, z.object({ n: z.number() }).strict());
const base: ContractSpec<{ n: number }, { n: number }> = {
  id: 'file-writer',
  version: '1.0.0',
  description: 'Writes one document under the out root',
  skills: ['writing-files'],
  team: 'demo',
  kind: 'io',
  consumes: In,
  produces: Out,
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 5000,
};
const writer = defineContract({ ...base, capabilities: { files: { root: 'out', access: 'read-write' } } });
const reader = defineContract({ ...base, id: 'file-reader', kind: 'deterministic', capabilities: { files: { root: 'out', access: 'read' }, pdfText: true } });

const root = (): string => mkdtempSync(join(tmpdir(), 'jobpilot-files-'));
const providers = (out: string, extra: Partial<Providers> = {}): Providers => ({
  fetch: async () => ({ status: 404, text: async () => '' }),
  fileRoots: { out },
  ...extra,
});
const ctxOf = (contract: typeof writer, p: Providers) =>
  issueContext({ contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: p, clock: fixedClock('2026-10-09T00:00:00Z'), signal: AbortSignal.timeout(5000) });
const bytes = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

describe('kernel capability files (contract)', () => {
  it('accepts files {root out, access read|read-write} and pdfText, and keeps them in the frozen contract', () => {
    expect(writer.capabilities).toEqual({ files: { root: 'out', access: 'read-write' } });
    expect(reader.capabilities).toEqual({ files: { root: 'out', access: 'read' }, pdfText: true });
    expect(Object.isFrozen(writer.capabilities.files)).toBe(true);
  });

  it('rejects unknown keys, other roots, other access modes and pdfText without files', () => {
    const bad = (capabilities: unknown) => () => defineContract({ ...base, capabilities } as ContractSpec<{ n: number }, { n: number }>);
    expect(bad({ files: { root: 'out', access: 'read-write', follow: true } })).toThrow(/capabilities\.files/);
    expect(bad({ files: { root: '/etc', access: 'read' } })).toThrow(/capabilities\.files\.root/);
    expect(bad({ files: { root: 'out', access: 'write' } })).toThrow(/capabilities\.files\.access/);
    expect(bad({ files: { root: 'out' } })).toThrow(/capabilities\.files\.access/);
    expect(bad({ pdfText: 'yes' })).toThrow(/capabilities\.pdfText/);
    expect(bad({ pdfText: true })).toThrow(/capabilities\.pdfText requires capabilities\.files/);
  });

  it('allows writing only to io, io-session and effect agents; reading to any kind', () => {
    expect(() => defineContract({ ...base, kind: 'deterministic', capabilities: { files: { root: 'out', access: 'read-write' } } })).toThrow(
      /kind deterministic may not write files/,
    );
    expect(defineContract({ ...base, kind: 'deterministic', capabilities: { files: { root: 'out', access: 'read' } } }).kind).toBe('deterministic');
  });

  it("requires emits of at least P1 for a 'full' pack contract, and refuses a 'full' pack redactor", () => {
    expect(() => defineContract({ ...base, capabilities: { pack: 'full' } })).toThrow(/pack 'full' requires emits P1 or higher/);
    expect(() => defineContract({ ...base, capabilities: { pack: 'full' }, emits: 'P0' })).toThrow(/pack 'full' requires emits P1 or higher/);
    expect(() =>
      defineContract({ ...base, capabilities: { pack: 'full' }, emits: 'P1', redactor: true, dataClasses: { in: ['P0'], out: ['P1'] } }),
    ).toThrow(/pack 'full' may not be a redactor/);
    expect(defineContract({ ...base, capabilities: { pack: 'full' }, emits: 'P1', dataClasses: { in: ['P0'], out: ['P1'] } }).emits).toBe('P1');
  });
});

describe('kernel capability files (broker)', () => {
  it('is absent unless declared; read-only contracts get no write', () => {
    const out = root();
    expect(ctxOf(defineContract(base), providers(out)).files).toBeUndefined();
    const r = ctxOf(reader, providers(out));
    expect(r.files?.read).toBeTypeOf('function');
    expect((r.files as { write?: unknown }).write).toBeUndefined();
    expect(r.pdfText).toBeTypeOf('function');
    expect(ctxOf(writer, providers(out)).pdfText).toBeUndefined();
  });

  it('writes under the root, creating directories, and returns the relative path and sha256', async () => {
    const out = root();
    const ctx = ctxOf(writer, providers(out));
    const res = await ctx.files!.write!('0123456789abcdef/resume.pdf', bytes('%PDF-1.3 hello'));
    expect(res).toEqual({ path: '0123456789abcdef/resume.pdf', sha256: sha('%PDF-1.3 hello') });
    expect(readFileSync(join(out, '0123456789abcdef/resume.pdf'), 'utf8')).toBe('%PDF-1.3 hello');
    // overwriting is allowed and atomic (no temp file left behind)
    await ctx.files!.write!('0123456789abcdef/resume.pdf', bytes('v2'));
    expect(readFileSync(join(out, '0123456789abcdef/resume.pdf'), 'utf8')).toBe('v2');
    const back = await ctx.files!.read('0123456789abcdef/resume.pdf');
    expect(new TextDecoder().decode(back.bytes)).toBe('v2');
    expect(back.sha256).toBe(sha('v2'));
    expect(ctx.denials()).toEqual([]);
  });

  it('creates a missing root', async () => {
    const out = join(root(), 'nested', 'out');
    const res = await ctxOf(writer, providers(out)).files!.write!('a/b.txt', bytes('x'));
    expect(res.path).toBe('a/b.txt');
    expect(readFileSync(join(out, 'a/b.txt'), 'utf8')).toBe('x');
  });

  const escapes: [string, RegExp][] = [
    ['/etc/passwd', /absolute/],
    ['C:/x.txt', /absolute/],
    ['../x.txt', /\.\./],
    ['a/../../x.txt', /\.\./],
    ['a\\b.txt', /backslash/],
    ['a/\0b.txt', /NUL/],
    ['', /empty/],
    ['a//b.txt', /empty segment/],
    ['./a.txt', /"\." segment/],
    ['a/', /empty segment/],
  ];
  for (const [p, why] of escapes) {
    it(`rejects ${JSON.stringify(p)} as a policy denial, on write and read`, async () => {
      const out = root();
      const ctx = ctxOf(writer, providers(out));
      await expect(ctx.files!.write!(p, bytes('x'))).rejects.toThrow(why);
      await expect(ctx.files!.read(p)).rejects.toThrow(why);
      expect(ctx.denials()).toHaveLength(2);
      expect(ctx.denials()[0]).toMatch(/^G-FILES: /);
    });
  }

  it('rejects a non-string path and non-byte data', async () => {
    const ctx = ctxOf(writer, providers(root()));
    await expect(ctx.files!.write!(1 as unknown as string, bytes('x'))).rejects.toThrow(/path must be a string/);
    await expect(ctx.files!.write!('a.txt', 'x' as unknown as Uint8Array)).rejects.toThrow(/bytes must be a Uint8Array/);
  });

  it('never writes into an applied-* directory, at any depth (reading is allowed)', async () => {
    const out = root();
    mkdirSync(join(out, 'k', 'applied-2026-10-09'), { recursive: true });
    writeFileSync(join(out, 'k', 'applied-2026-10-09', 'resume.pdf'), 'snapshot');
    const ctx = ctxOf(writer, providers(out));
    await expect(ctx.files!.write!('k/applied-2026-10-09/resume.pdf', bytes('x'))).rejects.toThrow(/applied-/);
    await expect(ctx.files!.write!('applied-x/a.txt', bytes('x'))).rejects.toThrow(/applied-/);
    await expect(ctx.files!.write!('k/applied-2026-10-09', bytes('x'))).rejects.toThrow(/applied-/);
    expect(readFileSync(join(out, 'k', 'applied-2026-10-09', 'resume.pdf'), 'utf8')).toBe('snapshot');
    const back = await ctxOf(reader, providers(out)).files!.read('k/applied-2026-10-09/resume.pdf');
    expect(new TextDecoder().decode(back.bytes)).toBe('snapshot');
    // a name that merely contains the word is fine
    await expect(ctx.files!.write!('k/not-applied-yet.txt', bytes('x'))).resolves.toMatchObject({ path: 'k/not-applied-yet.txt' });
  });

  it('refuses a symlinked directory or file that leads out of the root', async () => {
    const out = root();
    const outside = root();
    symlinkSync(outside, join(out, 'link'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(out, 'file-link.txt'));
    const ctx = ctxOf(writer, providers(out));
    await expect(ctx.files!.write!('link/x.txt', bytes('x'))).rejects.toThrow(/symlink/);
    await expect(ctx.files!.read('link/secret.txt')).rejects.toThrow(/symlink/);
    await expect(ctx.files!.write!('file-link.txt', bytes('x'))).rejects.toThrow(/symlink/);
    await expect(ctx.files!.read('file-link.txt')).rejects.toThrow(/symlink/);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    expect(ctx.denials().every((d) => d.startsWith('G-FILES: '))).toBe(true);
  });

  it('follows a symlinked root itself (the root is configuration, not agent input)', async () => {
    const real = root();
    const parent = root();
    symlinkSync(real, join(parent, 'out'));
    const res = await ctxOf(writer, providers(join(parent, 'out'))).files!.write!('a.txt', bytes('x'));
    expect(res.path).toBe('a.txt');
    expect(readFileSync(join(real, 'a.txt'), 'utf8')).toBe('x');
  });

  it('denies when no root is configured, and reports a missing file as invalid_output', async () => {
    const ctx = ctxOf(writer, { fetch: async () => ({ status: 404, text: async () => '' }) });
    await expect(ctx.files!.write!('a.txt', bytes('x'))).rejects.toThrow(/no out root/);
    const r = ctxOf(reader, providers(root()));
    const err = await r.files!.read('missing.pdf').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KernelError);
    expect((err as KernelError).code).toBe('invalid_output');
    expect(r.denials()).toEqual([]);
  });

  it('refuses a file larger than policy.maxResponseBytes', async () => {
    const policy = { ...PRODUCT_POLICY_V1, maxResponseBytes: 4 };
    const ctx = issueContext({ contract: writer, policy, inputClass: 'P0', providers: providers(root()), clock: fixedClock('2026-10-09T00:00:00Z'), signal: AbortSignal.timeout(5000) });
    await expect(ctx.files!.write!('a.txt', bytes('12345'))).rejects.toThrow(/exceeds 4 bytes/);
  });
});

describe('kernel capability pdfText', () => {
  it('runs the injected provider on the confined absolute path', async () => {
    const out = root();
    writeFileSync(join(out, 'a.pdf'), '%PDF');
    const calls: string[] = [];
    const ctx = ctxOf(reader, providers(out, { pdfText: async (abs) => (calls.push(abs), 'Asha Rao\n\f') }));
    expect(await ctx.pdfText!('a.pdf')).toBe('Asha Rao\n\f');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.endsWith('/a.pdf')).toBe(true);
    await expect(ctx.pdfText!('../a.pdf')).rejects.toThrow(/\.\./);
  });

  it('denies when no pdfText provider is configured', async () => {
    const out = root();
    writeFileSync(join(out, 'a.pdf'), '%PDF');
    const ctx = ctxOf(reader, providers(out));
    await expect(ctx.pdfText!('a.pdf')).rejects.toThrow(/no pdfText provider/);
  });
});

describe("executor: a 'full' pack agent's outputs are at least P1 (M7)", () => {
  const seed = (dataClass: 'P0' | 'P1'): Envelope => ({
    envelopeId: 'seed', stepKey: 'seed-step', index: 0, type: 'FileIn@1',
    producer: { agentId: 'supervisor', version: '1.0.0', contractHash: 'seed-hash' },
    parents: [], payload: { n: 1 },
    handoff: { guarantees: [], dataClass, obligations: [], pins: { policyHash: policyHash(PRODUCT_POLICY_V1) } },
    guardrails: [], cost: ZERO_COST,
  });
  const run = async (contract: ReturnType<typeof defineContract<{ n: number }, { n: number }>>, input: Envelope, fullPack: unknown = { contact: { name: 'Asha Rao' } }) => {
    const agent = defineAgent(contract, async () => [{ n: 2 }]);
    const guardrails = builtinGuardrails();
    const seen: unknown[] = [];
    guardrails.add({ id: 'G-SEE-FULL', sides: ['out'], check: (g) => (seen.push([g.pack, g.fullPack]), { id: 'G-SEE-FULL', verdict: 'pass' }) });
    const store = Store.open(':memory:');
    const out = await executeStep(
      {
        store, policy: PRODUCT_POLICY_V1, policyHash: policyHash(PRODUCT_POLICY_V1), providers: { fetch: async () => ({ status: 404, text: async () => '' }) },
        clock: fixedClock('2026-10-09T00:00:00Z'), guardrails, contractHashOf: (id) => (id === 'supervisor' ? 'seed-hash' : contractHash(contract)),
        sleep: async () => {}, pack: { naming: {} }, packHash: 'p', fullPack, fullPackHash: 'f',
      },
      'r', agent, input,
    );
    return { out, seen };
  };
  const full = defineContract({ ...base, id: 'full-writer', capabilities: { pack: 'full' }, emits: 'P1', dataClasses: { in: ['P0', 'P1'], out: ['P1'] }, guardrails: { in: [], out: ['G-SEE-FULL'] } });

  it('labels outputs P1 from a P0 input, whatever the payload says', async () => {
    const { out } = await run(full, seed('P0'));
    expect(out.kind).toBe('done');
    if (out.kind === 'done') expect(out.outputs.map((o) => o.handoff.dataClass)).toEqual(['P1']);
  });

  it('keeps a higher input class (taint only rises)', async () => {
    const c = defineContract({ ...full, id: 'full-writer-2', dataClasses: { in: ['P0', 'P2'], out: ['P1', 'P2'] } });
    const { out } = await run(c, { ...seed('P0'), handoff: { ...seed('P0').handoff, dataClass: 'P2' } });
    if (out.kind === 'done') expect(out.outputs[0]!.handoff.dataClass).toBe('P2');
    else throw new Error(`expected done, got ${out.kind}`);
  });

  it("gives the full pack to a 'full' agent's guardrails as fullPack, and the public pack as pack", async () => {
    const { seen } = await run(full, seed('P0'));
    expect(seen).toEqual([[{ naming: {} }, { contact: { name: 'Asha Rao' } }]]);
  });

  it('gives no fullPack to the guardrails of a public pack agent', async () => {
    const pub = defineContract({ ...base, id: 'pub-reader', kind: 'deterministic', capabilities: { pack: true }, guardrails: { in: [], out: ['G-SEE-FULL'] } });
    const { seen } = await run(pub, seed('P0'));
    expect(seen).toEqual([[{ naming: {} }, undefined]]);
  });
});
