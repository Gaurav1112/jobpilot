import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { hashOf } from '../kernel/canonical.js';
import type { Clock } from '../kernel/clock.js';
import { mergePolicy, policyHash, PRODUCT_POLICY_V1, type Policy } from '../kernel/policy.js';
import { pdftotextProvider, type BrowserProvider, type FetchLike } from '../kernel/providers.js';
import type { Registry } from '../kernel/registry.js';
import type { Store } from '../kernel/store/store.js';
import { Supervisor } from '../kernel/supervisor.js';
import type { CompiledPipeline } from '../kernel/wiring.js';
import type { GuardrailRegistry } from '../kernel/guardrails/index.js';
import { appGuardrails } from './guardrails.js';
import { loadPack } from './pack/load.js';
import type { Fact, Pack, PublicPack } from './pack/schema.js';
import { compileDaily, dailyAgents, pacingProblems } from './pipeline.js';
import { makeJobTracker } from './tracker.js';

/** Where poppler's pdftotext usually lives when PATH does not say (a launchd job has a bare PATH). */
const PDFTOTEXT_CANDIDATES = ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', '/usr/bin/pdftotext'];

const executable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The absolute path of `pdftotext`, resolved once per run: `which pdftotext` on the current PATH, else the known
 * install paths (`candidates`). The qa-gate gets that absolute path, so a scheduled run with a bare PATH still finds it.
 */
export function resolvePdftotext(candidates: readonly string[] = PDFTOTEXT_CANDIDATES): string {
  let fromPath: string | undefined;
  if (candidates === PDFTOTEXT_CANDIDATES) {
    try {
      fromPath = execFileSync('/usr/bin/which', ['pdftotext'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      fromPath = undefined;
    }
  }
  for (const p of [fromPath, ...candidates]) if (p !== undefined && p !== '' && isAbsolute(p) && executable(p)) return p;
  throw new Error(`pdftotext not found on PATH or at ${candidates.join(', ')}: the qa-gate needs it; install poppler (brew install poppler)`);
}

/** The pack as one run reads it. */
export interface RunPack {
  readonly pack: Pack;
  /** What `capabilities.pack: true` agents and guardrails see: no contact details, no answers. */
  readonly publicPack: PublicPack;
  /** Hash of `publicPack`, in the step key of every pack-reading agent. */
  readonly packHash: string;
  /** What the renderer (the only 'full' agent) sees: the whole pack, plus `render.nonce` once `docs rebuild` ran. */
  readonly fullPack: Pack & { readonly render?: { readonly nonce: number } };
  /** Hash of `fullPack`, in the renderer's step key only. */
  readonly fullPackHash: string;
  readonly asOf: string;
  readonly nonce: number | undefined;
}

/**
 * Loads the pack for a run: the user's fact overrides applied, `experience.asOf` set to `asOf` (the run passes the
 * current IST month of its injected clock, and nothing else), and both hashes. `render.nonce` goes into the full pack
 * only, so a rebuild changes the renderer's step key and no other.
 */
export function loadRunPack(dir: string, overrides: Readonly<Record<string, Fact['status']>>, asOf: string, nonce?: number): RunPack {
  const { pack, hash } = loadPack(dir, overrides, { asOf });
  const { contact: _c, answers: _a, ...publicPack } = pack;
  const fullPack = nonce === undefined ? pack : { ...pack, render: { nonce } };
  return { pack, publicPack, packHash: hash, fullPack, fullPackHash: hashOf(fullPack), asOf, nonce };
}

export interface AppKernelOptions {
  readonly store: Store;
  readonly loaded: RunPack;
  /** The documents root (`<home>/out`). */
  readonly outDir: string;
  readonly clock: Clock;
  /** Real time in production (`setTimeout`); the pacers and retry backoff wait through it. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly fetch: FetchLike;
  /** Needed only when the watchlist has careers entries. */
  readonly browser?: BrowserProvider;
  /** Absolute path of pdftotext (`resolvePdftotext`). */
  readonly pdftotext: string;
  /** Test hook (the supervisor's): runs after each step; throwing simulates a crash. */
  readonly afterStep?: (count: number) => void;
}

export interface AppKernel {
  readonly registry: Registry;
  readonly compiled: CompiledPipeline;
  readonly supervisor: Supervisor;
  readonly policy: Policy;
  readonly policyHash: string;
}

/**
 * Everything about the daily pipeline that is decided by the pack alone, before any store or provider exists: the
 * agents for its watchlist, the capability allow-list and wiring proof, the effective policy (product policy
 * tightened by `policy.user.yaml`) and the pacing check against the timeout arithmetic. Throws on any problem.
 * `jobpilot pack check` runs it too.
 */
export function preparePipeline(pack: Pick<Pack, 'watchlist' | 'feeds' | 'policyUser'>): Omit<AppKernel, 'supervisor'> & { readonly guardrails: GuardrailRegistry } {
  const guardrails = appGuardrails();
  const { registry, compiled } = compileDaily(dailyAgents(pack.watchlist), guardrails);
  const policy = mergePolicy(PRODUCT_POLICY_V1, pack.policyUser);
  const pacing = pacingProblems(policy, pack);
  if (pacing.length > 0) throw new Error(`refusing to start:\n- ${pacing.join('\n- ')}`);
  return { registry, compiled, guardrails, policy, policyHash: policyHash(policy) };
}

/**
 * Wires the daily pipeline for one run, in the style of `demoKernel`: `preparePipeline`, then a supervisor with the
 * job tracker (`makeJobTracker({minFit})`), both packs and both hashes, the out root, the absolute pdftotext and the
 * injected sleep. Throws, before anything runs, on any problem.
 */
export function appKernel(o: AppKernelOptions): AppKernel {
  const { pack } = o.loaded;
  if (!isAbsolute(o.pdftotext)) throw new Error(`pdftotext must be an absolute path, not ${o.pdftotext}`);
  const { registry, compiled, guardrails, policy, policyHash: pHash } = preparePipeline(pack);
  if (registry.has('src-careers-list') && o.browser === undefined) throw new Error('the watchlist has careers entries but no browser provider was given');
  const supervisor = new Supervisor({
    store: o.store,
    registry,
    compiled,
    guardrails,
    policy,
    policyHash: pHash,
    providers: {
      fetch: o.fetch,
      ...(o.browser !== undefined ? { browser: o.browser } : {}),
      fileRoots: { out: o.outDir },
      pdfText: pdftotextProvider(o.pdftotext),
    },
    clock: o.clock,
    sleep: o.sleep,
    trackers: [makeJobTracker({ minFit: pack.targets.minFit })],
    pack: o.loaded.publicPack,
    packHash: o.loaded.packHash,
    fullPack: o.loaded.fullPack,
    fullPackHash: o.loaded.fullPackHash,
    ...(o.afterStep ? { afterStep: o.afterStep } : {}),
  });
  return { registry, compiled, supervisor, policy, policyHash: pHash };
}
