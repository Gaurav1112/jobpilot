import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { commitPending, discardPending as discardPendingFn, openPending, recoverPending, type CommitHooks, type PendingFiles } from '../../src/kernel/files.js';
import { builtinGuardrails } from '../../src/kernel/guardrails/builtin.js';
import { PRODUCT_POLICY_V1, policyHash } from '../../src/kernel/policy.js';
import type { Providers } from '../../src/kernel/providers.js';
import { Store } from '../../src/kernel/store/store.js';
import { computeStepKey } from '../../src/kernel/memo.js';
import { Registry } from '../../src/kernel/registry.js';
import { Supervisor } from '../../src/kernel/supervisor.js';
import { compileWiring } from '../../src/kernel/wiring.js';
import { demoAgents, demoLlm, demoPipeline, demoTracker } from '../../src/demo/pipeline.js';
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
/** The step key every directly issued writer context stages under; `commit(out)` plays the executor's commit. */
const KEY = 'a'.repeat(64);
/** The latest stage opened per step key; `commit` names it final, as the executor does after the out guardrails. */
const stages = new Map<string, PendingFiles>();
const ctxOf = (contract: typeof writer, p: Providers, key: string | null = KEY) => {
  const root = p.fileRoots?.out;
  const pending = contract.capabilities.files?.access === 'read-write' && root !== undefined && key !== null ? openPending(root, key) : undefined;
  if (pending && key !== null) stages.set(`${root}|${key}`, pending);
  return issueContext({ contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: p, clock: fixedClock('2026-10-09T00:00:00Z'), signal: AbortSignal.timeout(5000), ...(pending ? { pendingFiles: pending } : {}) });
};
const markFinal = async (out: string, key = KEY) => stages.get(`${out}|${key}`)?.markFinal();
const commit = async (out: string, key = KEY, hooks: CommitHooks = {}) => {
  await markFinal(out, key);
  return commitPending(out, key, PRODUCT_POLICY_V1.maxResponseBytes, hooks);
};
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
    // staged, not yet in place: the final path appears only on commit
    expect(existsSync(join(out, '0123456789abcdef/resume.pdf'))).toBe(false);
    expect(readFileSync(join(out, '.pending', KEY, '0', 'files', '0123456789abcdef/resume.pdf'), 'utf8')).toBe('%PDF-1.3 hello');
    expect(await commit(out)).toEqual(['0123456789abcdef/resume.pdf']);
    expect(readFileSync(join(out, '0123456789abcdef/resume.pdf'), 'utf8')).toBe('%PDF-1.3 hello');
    expect(existsSync(join(out, '.pending', KEY))).toBe(false);
    // overwriting is allowed and atomic (no temp file left behind)
    await ctxOf(writer, providers(out)).files!.write!('0123456789abcdef/resume.pdf', bytes('v2'));
    await commit(out);
    expect(readFileSync(join(out, '0123456789abcdef/resume.pdf'), 'utf8')).toBe('v2');
    expect(readdirSync(join(out, '0123456789abcdef'))).toEqual(['resume.pdf']);
    const back = await ctx.files!.read('0123456789abcdef/resume.pdf');
    expect(new TextDecoder().decode(back.bytes)).toBe('v2');
    expect(back.sha256).toBe(sha('v2'));
    expect(ctx.denials()).toEqual([]);
  });

  it('creates a missing root', async () => {
    const out = join(root(), 'nested', 'out');
    const res = await ctxOf(writer, providers(out)).files!.write!('a/b.txt', bytes('x'));
    expect(res.path).toBe('a/b.txt');
    await commit(out);
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
    ['.pending/k/a.txt', /\.pending is reserved/],
    ['k/.PENDING/a.txt', /\.pending is reserved/],
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

  it('folds case and compatibility forms: Applied-, APPLIED- and fullwidth applied- are all snapshots (APFS is case-insensitive)', async () => {
    const out = root();
    mkdirSync(join(out, 'k', 'applied-2026-10-09'), { recursive: true });
    writeFileSync(join(out, 'k', 'applied-2026-10-09', 'resume.pdf'), 'SNAPSHOT');
    const ctx = ctxOf(writer, providers(out));
    for (const p of ['k/Applied-2026-10-09/resume.pdf', 'k/APPLIED-2026-10-09/resume.pdf', 'k/ａｐｐｌｉｅｄ-2026-10-09/resume.pdf', 'Applied-x/a.txt', 'k/aPpLiEd-new/a.txt']) {
      await expect(ctx.files!.write!(p, bytes('X')), p).rejects.toThrow(/applied-\* snapshot/);
    }
    await commit(out);
    expect(readFileSync(join(out, 'k', 'applied-2026-10-09', 'resume.pdf'), 'utf8')).toBe('SNAPSHOT');
    expect(ctx.denials()).toHaveLength(5);
  });

  it('refuses a symlink into an applied directory, and re-checks the rules at commit', async () => {
    const out = root();
    mkdirSync(join(out, 'k', 'applied-2026-10-09'), { recursive: true });
    writeFileSync(join(out, 'k', 'applied-2026-10-09', 'resume.pdf'), 'SNAPSHOT');
    symlinkSync(join(out, 'k', 'applied-2026-10-09'), join(out, 'k', 'latest'));
    const ctx = ctxOf(writer, providers(out));
    await expect(ctx.files!.write!('k/latest/resume.pdf', bytes('X'))).rejects.toThrow(/symlink/);
    // a stage that was legal when written but whose target became a snapshot (or a link) is refused at commit
    await ctx.files!.write!('j/resume.pdf', bytes('X'));
    symlinkSync(join(out, 'k', 'applied-2026-10-09'), join(out, 'j'));
    await expect(commit(out)).rejects.toThrow(/symlink/);
    expect(readFileSync(join(out, 'k', 'applied-2026-10-09', 'resume.pdf'), 'utf8')).toBe('SNAPSHOT');
  });

  it('denies a write without a step transaction', async () => {
    const out = root();
    const ctx = ctxOf(writer, providers(out), null);
    await expect(ctx.files!.write!('a.txt', bytes('x'))).rejects.toThrow(/need a step transaction/);
  });

  it('commits idempotently: a commit interrupted after some renames is finished by the next one', async () => {
    const out = root();
    const ctx = ctxOf(writer, providers(out));
    await ctx.files!.write!('k/a.txt', bytes('A'));
    await ctx.files!.write!('k/b.txt', bytes('B'));
    // simulate a crash after the first rename
    mkdirSync(join(out, 'k'));
    const { renameSync } = await import('node:fs');
    renameSync(join(out, '.pending', KEY, '0', 'files', 'k', 'a.txt'), join(out, 'k', 'a.txt'));
    expect(await commit(out)).toEqual(['k/a.txt', 'k/b.txt']);
    expect(readFileSync(join(out, 'k', 'b.txt'), 'utf8')).toBe('B');
    expect(await commit(out)).toEqual([]);
  });

  it('refuses to commit a staged file whose bytes changed after staging', async () => {
    const out = root();
    await ctxOf(writer, providers(out)).files!.write!('k/a.txt', bytes('A'));
    writeFileSync(join(out, '.pending', KEY, '0', 'files', 'k', 'a.txt'), 'tampered');
    await expect(commit(out)).rejects.toThrow(/does not match its recorded sha256/);
    expect(existsSync(join(out, 'k', 'a.txt'))).toBe(false);
  });

  it('recovery commits done stages in ascending stepKey order (the greater key wins a shared path) and deletes the rest', async () => {
    const out = root();
    const [k1, k2, k3] = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)];
    // staged in the opposite order to their keys
    await ctxOf(writer, providers(out), k2).files!.write!('k/r.pdf', bytes('from-2'));
    await ctxOf(writer, providers(out), k1).files!.write!('k/r.pdf', bytes('from-1'));
    await ctxOf(writer, providers(out), k3).files!.write!('k/other.pdf', bytes('from-3'));
    for (const k of [k1, k2, k3]) await markFinal(out, k);
    const r = await recoverPending(out, (k) => k !== k3, PRODUCT_POLICY_V1.maxResponseBytes);
    expect(r).toEqual({ committed: [k1, k2], discarded: [k3], failed: [] });
    expect(readFileSync(join(out, 'k', 'r.pdf'), 'utf8')).toBe('from-2');
    expect(existsSync(join(out, 'k', 'other.pdf'))).toBe(false);
    expect(readdirSync(join(out, '.pending'))).toEqual([]);
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
    await commit(join(parent, 'out'));
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

describe('executor: transactional writes (staged, committed only after the out guardrails pass)', () => {
  const pHash = policyHash(PRODUCT_POLICY_V1);
  const input: Envelope = {
    envelopeId: 'seed', stepKey: 'seed-step', index: 0, type: 'FileIn@1',
    producer: { agentId: 'supervisor', version: '1.0.0', contractHash: 'seed-hash' },
    parents: [], payload: { n: 1 },
    handoff: { guarantees: [], dataClass: 'P0', obligations: [], pins: { policyHash: pHash } },
    guardrails: [], cost: ZERO_COST,
  };
  const make = (over: Partial<ContractSpec<{ n: number }, { n: number }>>, run: (ctx: Parameters<Parameters<typeof defineAgent<{ n: number }, { n: number }>>[1]>[1]) => Promise<{ n: number }[]>) =>
    defineAgent(defineContract({ ...base, capabilities: { files: { root: 'out', access: 'read-write' } }, ...over }), async (_i, ctx) => run(ctx));
  const exec = (store: Store, out: string, agent: ReturnType<typeof make>, extra: Partial<Parameters<typeof executeStep>[0]> = {}) => {
    const guardrails = builtinGuardrails();
    guardrails.add({ id: 'G-NEVER', sides: ['out'], check: () => ({ id: 'G-NEVER', verdict: 'trip', detail: 'refused' }) });
    return executeStep(
      {
        store, policy: PRODUCT_POLICY_V1, policyHash: pHash, providers: providers(out), clock: fixedClock('2026-10-09T00:00:00Z'), guardrails,
        contractHashOf: (id) => (id === 'supervisor' ? 'seed-hash' : contractHash(agent.contract)), sleep: async () => {}, ...extra,
      },
      'r', agent, input,
    );
  };
  const writesA = async (ctx: { files?: { write?: (p: string, b: Uint8Array) => Promise<unknown> } }) => {
    await ctx.files!.write!('k/a.txt', bytes('A'));
    return [{ n: 2 }];
  };

  it('commits on success: the file is in place with the recorded sha256, and nothing stays staged', async () => {
    const out = root();
    const store = Store.open(':memory:');
    const res = await exec(store, out, make({}, writesA));
    expect(res.kind).toBe('done');
    expect(readFileSync(join(out, 'k', 'a.txt'), 'utf8')).toBe('A');
    expect(readdirSync(join(out, '.pending'))).toEqual([]);
    const ev = store.events('r').find((e) => e.kind === 'files_committed');
    expect(JSON.parse(ev!.data)).toMatchObject({ files: ['k/a.txt'] });
  });

  it('commits nothing when an out guardrail trips', async () => {
    const out = root();
    const res = await exec(Store.open(':memory:'), out, make({ id: 'tripper', guardrails: { in: [], out: ['G-NEVER'] } }, writesA));
    expect(res.kind).toBe('quarantined');
    expect(existsSync(join(out, 'k'))).toBe(false);
    expect(readdirSync(join(out, '.pending'))).toEqual([]);
  });

  it('commits nothing when the agent fails after writing, or times out (and a late write is refused)', async () => {
    const out = root();
    const failing = make({ id: 'failer' }, async (ctx) => {
      await ctx.files!.write!('k/a.txt', bytes('A'));
      throw new Error('boom');
    });
    expect((await exec(Store.open(':memory:'), out, failing)).kind).toBe('failed');
    let late: Promise<unknown> | undefined;
    const slow = make({ id: 'sleeper', timeoutMs: 50 }, async (ctx) => {
      await ctx.files!.write!('k/b.txt', bytes('B'));
      await new Promise((r) => setTimeout(r, 120));
      late = ctx.files!.write!('k/c.txt', bytes('C')).catch((e: unknown) => e);
      return [{ n: 2 }];
    });
    expect(await exec(Store.open(':memory:'), out, slow)).toMatchObject({ kind: 'failed', error: 'timeout' });
    await new Promise((r) => setTimeout(r, 150));
    expect(await late).toBeInstanceOf(KernelError);
    expect(existsSync(join(out, 'k'))).toBe(false);
    expect(readdirSync(join(out, '.pending'))).toEqual([]);
  });

  it('finishes a commit a crash interrupted: the replayed done step commits its stage', async () => {
    const out = root();
    const store = Store.open(':memory:');
    const agent = make({ id: 'crasher' }, writesA);
    await expect(exec(store, out, agent, { beforeCommit: () => { throw new Error('simulated crash'); } })).rejects.toThrow(/simulated crash/);
    const step = store.getStep(computeStepKey(agent.contract, input, pHash));
    expect(step?.status).toBe('done');
    expect(existsSync(join(out, 'k', 'a.txt'))).toBe(false);
    expect(readdirSync(join(out, '.pending'))).toHaveLength(1);
    const again = await exec(store, out, agent);
    expect(again).toMatchObject({ kind: 'done', replayed: true });
    expect(readFileSync(join(out, 'k', 'a.txt'), 'utf8')).toBe('A');
    expect(readdirSync(join(out, '.pending'))).toEqual([]);
  });

  it('the supervisor deletes stale stages of steps that never finished, on start', async () => {
    const out = root();
    const stale = 'c'.repeat(64);
    await ctxOf(writer, providers(out), stale).files!.write!('k/a.txt', bytes('A'));
    const store = Store.open(':memory:');
    const registry = new Registry();
    for (const a of demoAgents) registry.register(a);
    const guardrails = builtinGuardrails();
    const sup = new Supervisor({
      store, registry, compiled: compileWiring(registry, demoPipeline, guardrails), guardrails, policy: PRODUCT_POLICY_V1, policyHash: pHash,
      providers: { ...providers(out), llm: demoLlm() }, clock: fixedClock('2026-10-09T00:00:00Z'), sleep: async () => {}, trackers: [demoTracker],
    });
    await sup.start('run-1', [{ count: 1, prefix: 'demo' }]);
    expect(readdirSync(join(out, '.pending'))).toEqual([]);
    expect(existsSync(join(out, 'k'))).toBe(false);
    const ev = store.events('run-1').find((e) => e.kind === 'files_recovered');
    expect(JSON.parse(ev!.data)).toMatchObject({ root: 'out', committed: [], discarded: [stale] });
  });
});

describe('staging never follows a link (N1), hard links (m8), temp squatters (m10)', () => {
  const max = PRODUCT_POLICY_V1.maxResponseBytes;

  it('a symlinked .pending: writes are denied, recovery reports it and touches nothing outside', async () => {
    const out = root();
    const outside = root();
    mkdirSync(join(outside, 'victim-dir'));
    writeFileSync(join(outside, 'victim-dir', 'keep.txt'), 'keep');
    writeFileSync(join(outside, 'victim.txt'), 'keep');
    symlinkSync(outside, join(out, '.pending'));
    const ctx = ctxOf(writer, providers(out));
    await expect(ctx.files!.write!('job2/a.txt', bytes('x'))).rejects.toThrow(/G-FILES: \.pending is not a real directory/);
    const r = await recoverPending(out, () => false, max);
    expect(r).toEqual({ committed: [], discarded: [], failed: [{ stepKey: '.pending', message: 'G-FILES: .pending is not a real directory' }] });
    await expect(commitPending(out, KEY, max)).rejects.toThrow(/\.pending is not a real directory/);
    await expect(discardPendingFn(out, KEY)).rejects.toThrow(/\.pending is not a real directory/);
    expect(readdirSync(outside).sort()).toEqual(['victim-dir', 'victim.txt']);
    expect(readFileSync(join(outside, 'victim-dir', 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('a symlinked step directory: writes are denied, recovery skips and reports it, nothing outside is emptied', async () => {
    const out = root();
    const outside = root();
    writeFileSync(join(outside, 'victim.txt'), 'keep');
    mkdirSync(join(out, '.pending'));
    symlinkSync(outside, join(out, '.pending', KEY));
    await expect(ctxOf(writer, providers(out)).files!.write!('job2/a.txt', bytes('x'))).rejects.toThrow(/G-FILES: \.pending\/a+ is not a real directory/);
    const r = await recoverPending(out, () => false, max);
    expect(r.discarded).toEqual([]);
    expect(r.failed).toEqual([{ stepKey: KEY, message: `G-FILES: .pending/${KEY} is not a real directory` }]);
    await expect(commitPending(out, KEY, max)).rejects.toThrow(/is not a real directory/);
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('keep');
  });

  it('a symlinked directory inside a stage: the commit is denied and the outside file is not moved', async () => {
    const out = root();
    const outside = root();
    mkdirSync(join(outside, 'sub'));
    writeFileSync(join(outside, 'sub', 'a.txt'), 'outside');
    const sha = createHash('sha256').update('outside').digest('hex');
    const base = join(out, '.pending', KEY);
    mkdirSync(join(base, '0', 'files'), { recursive: true });
    symlinkSync(join(outside, 'sub'), join(base, '0', 'files', 'job4'));
    writeFileSync(join(base, '0', 'manifest.json'), JSON.stringify({ stepKey: KEY, files: [{ path: 'job4/a.txt', sha256: sha }] }));
    writeFileSync(join(base, 'final.json'), JSON.stringify({ attempt: 0 }));
    await expect(commitPending(out, KEY, max)).rejects.toThrow(/G-FILES: job4\/a\.txt passes through a symlink/);
    expect(readFileSync(join(outside, 'sub', 'a.txt'), 'utf8')).toBe('outside');
    expect(existsSync(join(out, 'job4', 'a.txt'))).toBe(false);
    // recovery of a done step reports the failed commit and leaves the outside file alone
    const r = await recoverPending(out, () => true, max);
    expect(r.failed.map((f) => f.stepKey)).toEqual([KEY]);
    expect(readFileSync(join(outside, 'sub', 'a.txt'), 'utf8')).toBe('outside');
  });

  it('a symlinked staged file or final.json is a G-FILES denial, not a raw ELOOP', async () => {
    const out = root();
    const outside = root();
    writeFileSync(join(outside, 'a.txt'), 'outside');
    const sha = createHash('sha256').update('outside').digest('hex');
    const base = join(out, '.pending', KEY);
    mkdirSync(join(base, '0', 'files', 'job5'), { recursive: true });
    symlinkSync(join(outside, 'a.txt'), join(base, '0', 'files', 'job5', 'a.txt'));
    writeFileSync(join(base, '0', 'manifest.json'), JSON.stringify({ stepKey: KEY, files: [{ path: 'job5/a.txt', sha256: sha }] }));
    writeFileSync(join(base, 'final.json'), JSON.stringify({ attempt: 0 }));
    const err = await commitPending(out, KEY, max).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KernelError);
    expect((err as KernelError).code).toBe('policy_denied');
    expect((err as Error).message).toMatch(/^G-FILES: job5\/a\.txt is a symlink/);
    const key2 = 'f'.repeat(64);
    mkdirSync(join(out, '.pending', key2));
    symlinkSync(join(outside, 'a.txt'), join(out, '.pending', key2, 'final.json'));
    await expect(commitPending(out, key2, max)).rejects.toThrow(/^G-FILES: final\.json is a symlink/);
    expect(readFileSync(join(outside, 'a.txt'), 'utf8')).toBe('outside');
  });

  it('m10: a directory squatting the temp path is a G-FILES denial', async () => {
    const out = root();
    mkdirSync(join(out, '.pending', KEY, '0', 'files', 'k', 'a.txt.jobpilot-tmp'), { recursive: true });
    const ctx = ctxOf(writer, providers(out));
    const err = await ctx.files!.write!('k/a.txt', bytes('x')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KernelError);
    expect((err as Error).message).toMatch(/^G-FILES: k\/a\.txt has a directory in the way of its temp file/);
  });

  it('m8: a read (or pdfText) of a file with more than one hard link is a denial', async () => {
    const out = root();
    const outside = root();
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    const { linkSync } = await import('node:fs');
    linkSync(join(outside, 'secret.txt'), join(out, 'alias.txt'));
    const ctx = ctxOf(reader, providers(out, { pdfText: async () => 'text' }));
    await expect(ctx.files!.read('alias.txt')).rejects.toThrow(/G-FILES: alias\.txt is a hard link/);
    await expect(ctx.pdfText!('alias.txt')).rejects.toThrow(/G-FILES: alias\.txt is a hard link/);
    writeFileSync(join(out, 'plain.txt'), 'ok');
    await expect(ctx.files!.read('plain.txt')).resolves.toMatchObject({ sha256: sha('ok') });
  });
});

describe('commits are all or nothing per step (N2)', () => {
  const max = PRODUCT_POLICY_V1.maxResponseBytes;
  const seed = (out: string) => {
    mkdirSync(join(out, 'k'), { recursive: true });
    for (const n of ['a', 'b', 'c']) writeFileSync(join(out, 'k', `${n}.txt`), `OLD-${n}`);
  };
  const stageAll = async (out: string) => {
    const ctx = ctxOf(writer, providers(out));
    for (const n of ['a', 'b', 'c']) await ctx.files!.write!(`k/${n}.txt`, bytes(`NEW-${n}`));
  };
  const contents = (out: string) => ['a', 'b', 'c'].map((n) => readFileSync(join(out, 'k', `${n}.txt`), 'utf8'));

  it('a failure while moving the third file restores the first two from their backups', async () => {
    const out = root();
    seed(out);
    await stageAll(out);
    await expect(commit(out, KEY, { beforeMove: (i) => { if (i === 2) throw new Error('disk full'); } })).rejects.toThrow(/disk full/);
    expect(contents(out)).toEqual(['OLD-a', 'OLD-b', 'OLD-c']);
    expect(readdirSync(join(out, 'k')).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('a target that is no longer a regular file fails validation before anything moves', async () => {
    const out = root();
    seed(out);
    await stageAll(out);
    const { rmSync } = await import('node:fs');
    rmSync(join(out, 'k', 'c.txt'));
    mkdirSync(join(out, 'k', 'c.txt'));
    await expect(commit(out, KEY)).rejects.toThrow(/G-FILES: k\/c\.txt is not a regular file/);
    expect(['a', 'b'].map((n) => readFileSync(join(out, 'k', `${n}.txt`), 'utf8'))).toEqual(['OLD-a', 'OLD-b']);
  });

  it('a successful commit replaces the whole set and leaves no backup behind', async () => {
    const out = root();
    seed(out);
    await stageAll(out);
    await commit(out, KEY);
    expect(contents(out)).toEqual(['NEW-a', 'NEW-b', 'NEW-c']);
    expect(readdirSync(join(out, '.pending'))).toEqual([]);
  });
});

describe('executor: per-attempt stages (N4) and pack hashes (m9)', () => {
  const pHash = policyHash(PRODUCT_POLICY_V1);
  const input: Envelope = {
    envelopeId: 'seed', stepKey: 'seed-step', index: 0, type: 'FileIn@1',
    producer: { agentId: 'supervisor', version: '1.0.0', contractHash: 'seed-hash' },
    parents: [], payload: { n: 1 },
    handoff: { guarantees: [], dataClass: 'P0', obligations: [], pins: { policyHash: pHash } },
    guardrails: [], cost: ZERO_COST,
  };
  const depsFor = (store: Store, out: string, contract: ReturnType<typeof defineContract<{ n: number }, { n: number }>>, extra: Record<string, unknown> = {}) => ({
    store, policy: PRODUCT_POLICY_V1, policyHash: pHash, providers: providers(out), clock: fixedClock('2026-10-09T00:00:00Z'), guardrails: builtinGuardrails(),
    contractHashOf: (id: string) => (id === 'supervisor' ? 'seed-hash' : contractHash(contract)), sleep: async () => {}, ...extra,
  });

  it('commits only the successful attempt\'s stage; a failed attempt\'s writes are never committed', async () => {
    const out = root();
    const c = defineContract({ ...base, id: 'retrier', capabilities: { files: { root: 'out', access: 'read-write' } }, retry: { max: 1, on: ['network'], backoffMs: [0] } });
    let attempt = 0;
    const agent = defineAgent(c, async (_i, ctx) => {
      attempt += 1;
      if (attempt === 1) {
        await ctx.files!.write!('k/first.txt', bytes('attempt 1'));
        throw new KernelError('network', 'flaky');
      }
      await ctx.files!.write!('k/second.txt', bytes('attempt 2'));
      return [{ n: 2 }];
    });
    let layout: { entries: string[]; final: unknown } | undefined;
    const beforeCommit = (_a: string, key: string) => {
      const dir = join(out, '.pending', key);
      layout = { entries: readdirSync(dir).sort(), final: JSON.parse(readFileSync(join(dir, 'final.json'), 'utf8')) };
    };
    const res = await executeStep(depsFor(Store.open(':memory:'), out, c, { beforeCommit }), 'r', agent, input);
    expect(res.kind).toBe('done');
    // each attempt staged into its own directory, and only attempt 1 (the second, successful one) is named final
    expect(layout).toEqual({ entries: ['0', '1', 'final.json'], final: { attempt: 1 } });
    expect(readdirSync(join(out, 'k'))).toEqual(['second.txt']);
    expect(readdirSync(join(out, '.pending'))).toEqual([]);
  });

  it("throws when a 'full' pack agent runs without fullPackHash, or a pack agent with a pack but no packHash", async () => {
    const full = defineContract({ ...base, id: 'full-reader', kind: 'deterministic', capabilities: { pack: 'full' }, emits: 'P1', dataClasses: { in: ['P0'], out: ['P1'] } });
    const pub = defineContract({ ...base, id: 'pub-reader', kind: 'deterministic', capabilities: { pack: true } });
    const run = (c: typeof full, extra: Record<string, unknown>) =>
      executeStep(depsFor(Store.open(':memory:'), root(), c, extra), 'r', defineAgent(c, async () => [{ n: 2 }]), input);
    await expect(run(full, { fullPack: { contact: {} } })).rejects.toThrow(/full-reader reads the full pack but no fullPackHash was supplied/);
    await expect(run(full, {})).rejects.toThrow(/no fullPackHash/);
    await expect(run(pub, { pack: { naming: {} } })).rejects.toThrow(/pub-reader reads the pack but no packHash was supplied/);
    await expect(run(full, { fullPack: { contact: {} }, fullPackHash: 'f' })).resolves.toMatchObject({ kind: 'done' });
    await expect(run(pub, { pack: { naming: {} }, packHash: 'p' })).resolves.toMatchObject({ kind: 'done' });
    await expect(run(pub, {})).resolves.toMatchObject({ kind: 'done' });
  });
});
