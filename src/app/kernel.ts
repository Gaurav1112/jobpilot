import { execFileSync } from 'node:child_process';
import type { HostPacer } from '../kernel/broker.js';
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
import { codeHash } from './code-hash.js';
import { appGuardrails } from './guardrails.js';
import type { CompanyPick } from './pack/companies-schema.js';
import { loadPack, PackError, withoutFreelance, type LoadMode } from './pack/load.js';
import { packTextProblems } from './pack/scan.js';
import type { Fact, Pack, PublicPack } from './pack/schema.js';
import type { PageState } from './agents/sources/platforms/pages.js';
import type { PageLedger } from './agents/sources/platforms/shared.js';
import { careersEgressSets, compileDaily, dailyAgents, pacingProblems, rebuildAgents, rebuildPipeline, registryEgressSets, type RegistryBoard } from './pipeline.js';
import { FETCHING_PLATFORMS, freelanceAgents, freelancePacingProblems, freelancePipeline } from './freelance/pipeline.js';
import { freelanceDocsPacks } from './freelance/writing/gig-renderer.js';
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
  /** Hash of the public pack including the freelance files; the freelance supervisor's pack hash. */
  readonly freelancePackHash: string;
  /** Hash of the full pack (contact, answers, render.nonce) including the freelance files; the freelance renderer's key. */
  readonly freelanceFullPackHash: string;
  /** companies.yaml's picks (empty when absent or, in mode `daily`, ignored); in neither pack hash. */
  readonly companies: readonly CompanyPick[];
  /** Hash of `companies`; the coverage pipeline's own pack hash input. */
  readonly companiesHash: string;
  readonly asOf: string;
  readonly nonce: number | undefined;
  /** Mode `daily` only: the freelance files the load ignored, one redacted line each (the run records them). */
  readonly warnings: readonly string[];
}

/**
 * Loads the pack for a run: the user's fact overrides applied, `experience.asOf` set to `asOf` (the run passes the
 * current IST month of its injected clock, and nothing else), and both hashes. `render.nonce` goes into the full pack
 * only, so a rebuild changes the renderer's step key and no other.
 * Final I8: refuses (a `PackError`, so the run exits 2) on any `packTextProblems` problem, so a forbidden term or an
 * undrawable character edited into any pack file after the import never reaches a run. The problems name a file,
 * field or fact id and a term by its position only.
 * `mode` (final review C1): `daily` for `run`, `docs rebuild` and `serve`, where a broken or forbidden freelance file is
 * ignored with a warning instead (`loadPack`); `strict` for the freelance run, `networks pack`, `sources probe` and
 * `pack check`.
 */
export function loadRunPack(dir: string, overrides: Readonly<Record<string, Fact['status']>>, asOf: string, nonce: number | undefined, mode: LoadMode): RunPack {
  const { pack, hash, freelancePackHash, companies, companiesHash, warnings } = loadPack(dir, overrides, { asOf, mode });
  const text = packTextProblems({ ...pack, companies });
  // rereview R11: the first line (the failure notification's text) gives the count and where to look, never a term
  if (text.length > 0) {
    const n = text.length === 1 ? '1 text problem' : `${text.length} text problems`;
    throw new PackError(`the pack has ${n}; nothing runs until they are fixed (\`jobpilot pack check\` lists them)\n  - ${text.join('\n  - ')}`);
  }
  const { contact: _c, answers: _a, ...publicPack } = pack;
  const fullPack = nonce === undefined ? pack : { ...pack, render: { nonce } };
  return { pack, publicPack, packHash: hash, fullPack, fullPackHash: hashOf(withoutFreelance(fullPack)), freelancePackHash, freelanceFullPackHash: hashOf(fullPack), companies, companiesHash, asOf, nonce, warnings };
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
  /** A cooperative stop between steps (the supervisor's `pauseBefore`): the hosted wrapper's deadline. Default: never. */
  readonly pauseBefore?: () => string | null;
  /** `rebuild`: the renderer and qa-gate only (`docs rebuild`). Default `daily`. */
  readonly mode?: 'daily' | 'rebuild';
  /** The code fingerprint in every step key (review I4); default `codeHash()`, the hash of this checkout's sources and fonts. */
  readonly codeHash?: string;
  /** The verified registry companies the daily run reads through a platform adapter (`registryBoards`); default none. */
  readonly boards?: readonly RegistryBoard[];
  /** The day's Oracle list pages across runs (`appPageLedger`); default in memory (this run only). */
  readonly pageLedger?: PageLedger;
  /** The page adapters' state across runs (`appPageState`, Task 8); default in memory (this run only). */
  readonly pageState?: PageState;
  /** The page adapters' job pages per company per IST day (`appPageLedger(app, PAGE_LEDGER_PREFIX)`); default in memory. */
  readonly jobPageLedger?: PageLedger;
  /**
   * The HTTPS online check (`pacedHttpsOnline`), given the supervisor's per-host pacer, which its probes must wait on: a
   * network failure while it says offline is not final; the step is re-queued once it passes (the supervisor's wake
   * rule). Absent (tests, fixtures): only failures just after a detected wake are re-queued.
   */
  readonly online?: (pacer: HostPacer) => Promise<boolean>;
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
export function preparePipeline(
  pack: Pick<Pack, 'watchlist' | 'feeds' | 'policyUser'>,
  mode: 'daily' | 'rebuild' = 'daily',
  boards: readonly RegistryBoard[] = [],
  pageLedger?: PageLedger,
  pageState?: PageState,
  jobPageLedger?: PageLedger,
): Omit<AppKernel, 'supervisor'> & { readonly guardrails: GuardrailRegistry } {
  const guardrails = appGuardrails();
  const state = { ...(pageLedger === undefined ? {} : { pageLedger }), ...(pageState === undefined ? {} : { pageState }), ...(jobPageLedger === undefined ? {} : { jobPageLedger }) };
  const { registry, compiled } = mode === 'daily' ? compileDaily(dailyAgents(pack.watchlist, boards, state), guardrails) : compileDaily(rebuildAgents(), guardrails, rebuildPipeline());
  const policy = mergePolicy(PRODUCT_POLICY_V1, pack.policyUser);
  // A rebuild fetches nothing, so only the daily run's pacing matters.
  const pacing = mode === 'daily' ? pacingProblems(policy, pack, boards) : [];
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
  const boards = o.mode === 'rebuild' ? [] : (o.boards ?? []);
  const { registry, compiled, guardrails, policy, policyHash: pHash } = preparePipeline(pack, o.mode ?? 'daily', boards, o.pageLedger, o.pageState, o.jobPageLedger);
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
    egressSets: { ...careersEgressSets(pack.watchlist), ...registryEgressSets(boards) },
    codeHash: o.codeHash ?? codeHash(),
    ...(o.afterStep ? { afterStep: o.afterStep } : {}),
    ...(o.pauseBefore ? { pauseBefore: o.pauseBefore } : {}),
    ...(o.online !== undefined ? { online: o.online } : {}),
  });
  return { registry, compiled, supervisor, policy, policyHash: pHash };
}

/**
 * The user policy the freelance run applies: `policy.user.yaml` with `minHostIntervalMs` raised (never lowered) to the
 * largest `platform-rules.yaml` `minIntervalMs` of the enabled platforms that fetch (Freelancer's 2000 ms by default).
 * The kernel has one host pacer per supervisor, so the largest interval paces every host; mergePolicy still checks
 * the result only tightens the product policy. The daily run keeps `policy.user.yaml` as it is.
 */
export function freelancePolicyUser(pack: Pick<Pack, 'policyUser' | 'freelance' | 'platformRules'>): Record<string, unknown> {
  const base = mergePolicy(PRODUCT_POLICY_V1, pack.policyUser).minHostIntervalMs;
  const platforms = FETCHING_PLATFORMS.filter((p) => pack.freelance.platforms[p].enabled);
  const interval = Math.max(base, ...platforms.map((p) => pack.platformRules[p].minIntervalMs));
  return { ...pack.policyUser, minHostIntervalMs: interval };
}

/**
 * The freelance counterpart of `preparePipeline`: the freelance agents through the same capability allow-list and
 * wiring proof (`jobpilot-freelance@1.0.0`), the effective policy with the platforms' pacing (`freelancePolicyUser`;
 * its hash differs from the daily one when that raises the interval) and the freelance pacing check. Throws on any problem.
 */
export function prepareFreelance(pack: Pick<Pack, 'policyUser' | 'freelance' | 'platformRules'>): Omit<AppKernel, 'supervisor'> & { readonly guardrails: GuardrailRegistry } {
  const guardrails = appGuardrails();
  const agents = freelanceAgents();
  const { registry, compiled } = compileDaily(agents, guardrails, freelancePipeline(agents));
  const policy = mergePolicy(PRODUCT_POLICY_V1, freelancePolicyUser(pack));
  const pacing = freelancePacingProblems(policy, { gmail: pack.freelance.platforms.gmail.enabled });
  if (pacing.length > 0) throw new Error(`refusing to start:\n- ${pacing.join('\n- ')}`);
  return { registry, compiled, guardrails, policy, policyHash: policyHash(policy) };
}

/**
 * Wires the freelance pipeline for one run: `prepareFreelance`, then a supervisor with the freelance packs and hashes
 * (`freelanceDocsPacks`: the public pack keyed by `freelancePackHash`, the full pack by `freelanceFullPackHash`, so a
 * freelance file edit re-runs the steps that read it), the out root, the absolute pdftotext and the injected sleep. No
 * tracker (the job tracker follows daily postings) and no browser (no freelance source renders a page).
 */
export function freelanceKernel(o: Omit<AppKernelOptions, 'browser' | 'mode'>): AppKernel {
  if (!isAbsolute(o.pdftotext)) throw new Error(`pdftotext must be an absolute path, not ${o.pdftotext}`);
  const { registry, compiled, guardrails, policy, policyHash: pHash } = prepareFreelance(o.loaded.pack);
  const packs = freelanceDocsPacks(o.loaded);
  const supervisor = new Supervisor({
    store: o.store,
    registry,
    compiled,
    guardrails,
    policy,
    policyHash: pHash,
    providers: { fetch: o.fetch, fileRoots: { out: o.outDir }, pdfText: pdftotextProvider(o.pdftotext) },
    clock: o.clock,
    sleep: o.sleep,
    pack: packs.pack,
    packHash: packs.packHash,
    fullPack: packs.fullPack,
    fullPackHash: packs.fullPackHash,
    codeHash: o.codeHash ?? codeHash(),
    ...(o.afterStep ? { afterStep: o.afterStep } : {}),
    ...(o.pauseBefore ? { pauseBefore: o.pauseBefore } : {}),
    ...(o.online !== undefined ? { online: o.online } : {}),
  });
  return { registry, compiled, supervisor, policy, policyHash: pHash };
}
