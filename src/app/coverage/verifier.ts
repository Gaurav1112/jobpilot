import { defineAgent, type AgentContext } from '../../kernel/agent.js';
import type { EgressSets } from '../../kernel/broker.js';
import { defineContract } from '../../kernel/contract.js';
import { KernelError } from '../../kernel/errors.js';
import { BoardRefused, platformClient, type BoardRead } from '../agents/sources/platforms/client.js';
import { gateOf, HOST_DISABLED, REQUEST_TIMEOUT_MS, type GateSource, type RunGate } from './gate.js';
import { sameCompany } from './names.js';
import { CompanyVerdict, PlatformGuess } from './types.js';

/**
 * The board verifier (spec §3, D2): for one detected platform and board slug, read the board ONCE through the
 * platform's read client (`platformClient`, the request the daily adapter makes) and decide:
 *
 * - `verified` iff ALL of: the board answered 2xx; the response has the platform's shape (zod); it lists at least one
 *   job; and the board is the candidate's company: `sameCompany(candidate name, board name, domain label)` on the
 *   board's own company name (Greenhouse's `company_name`), or, where the platform gives none (Lever, Ashby), on the
 *   board slug. The domain-label route is refused for generic labels (`GENERIC_LABELS`).
 * - `proposed` when the shape is valid but the name differs (`board name '…' ≈ '…', please confirm`), is not available
 *   (`board name not available, please confirm`) or names several companies, or the board has 0 jobs; when the
 *   platform has no adapter in this build (`adapter not built yet: <platform>`, nothing fetched); and when no platform
 *   was detected (the detector's reasons carried, nothing fetched; the coverage pipeline does not even route those here).
 * - `failed` on an error: 404 (`board not found`), another 4xx, a response of the wrong shape, a 5xx or a network
 *   failure. A URL-only detection of a dead board ends here, never verified.
 *
 * Politeness and memo safety (the run's shared gate, `gate.ts`): the read host of a platform is a public job-board API
 * the daily adapters already read (robots.txt is not fetched for it, exactly as the daily adapters do not). A 401, 403
 * or 429 from it DISABLES the host for the rest of the run (written to `coverage_host_state` before the step returns,
 * this agent's one side channel outside its output) and the step is deferred: it fails `input_rejected` with
 * `host-disabled:<why> on <host>`, so it is never stored as a finished result and is asked again in a later run. A step that
 * meets a host already disabled (by itself or a sibling) is deferred the same way, without a request.
 */

export const boardVerifierContract = defineContract({
  id: 'board-verifier',
  version: '1.0.0',
  description: 'Reads a detected job board once to confirm its company name, its shape, its open jobs; a refused host is recorded in the run\'s coverage_host_state',
  skills: ['board-verifier'],
  team: 'coverage-verifier',
  kind: 'io',
  consumes: PlatformGuess,
  produces: CompanyVerdict,
  capabilities: { http: true },
  egress: ['coverage:candidate-hosts'],
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 60_000,
  retry: { max: 0, on: [], backoffMs: [] },
});

/** The registrable domain's first label (`purestorage.com` → `purestorage`, `foo.co.uk` → `foo`): the companyKey's. */
export const domainLabel = (companyKey: string): string => companyKey.split('.')[0] ?? '';

/** The host the verifier reads a guess's board from: the built platform client's host; none for anything else. */
export function verifierHosts(g: PlatformGuess): string[] {
  if (g.platform === null || g.slug === null) return [];
  const client = platformClient(g.platform);
  return client === null ? [] : [client.host];
}

/** The egress set for the verify stage: the union of `verifierHosts` (exact hosts, never a suffix). */
export function verifierEgressSets(guesses: readonly PlatformGuess[]): EgressSets {
  return { 'coverage:candidate-hosts': [...new Set(guesses.flatMap(verifierHosts))].sort() };
}

/**
 * The verdict for a guess with no platform: Proposed, with the detector's verdict and the locator's evidence carried
 * through. Used by the coverage pipeline for such guesses (no verifier step) and by the verifier itself if it gets one.
 */
export function noPlatformVerdict(g: PlatformGuess): CompanyVerdict {
  const reasons = [`no platform detected: ${g.evidence[0] ?? 'no evidence'}`, ...g.evidence.slice(1, 6)];
  if (g.site.evidence !== null) reasons.push(`careers URL ${g.site.method}: ${g.site.evidence}`);
  return { guess: g, status: 'proposed', reasons, boardName: null, jobsSeen: null };
}

/** The board-verifier agent for ONE coverage run, on the run's shared gate (or a key and store to build one from). */
export function makeBoardVerifier(opts: GateSource & { readonly requestTimeoutMs?: number }) {
  const gate = gateOf(opts);
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  return defineAgent(boardVerifierContract, async (g, ctx) => [await verify(g, ctx, gate, timeoutMs)]);
}

const deferred = (why: string, host: string, detail: string): KernelError => new KernelError('input_rejected', `${HOST_DISABLED}${why} on ${host} (${detail}); deferred to a later run, never retried around`);

async function verify(g: PlatformGuess, ctx: AgentContext, gate: RunGate, timeoutMs: number): Promise<CompanyVerdict> {
  const verdict = (status: CompanyVerdict['status'], reasons: string[], read?: BoardRead): CompanyVerdict => ({
    guess: g,
    status,
    reasons,
    boardName: read?.boardName ?? null,
    jobsSeen: read === undefined ? null : read.jobs.length,
  });
  if (g.platform === null) return noPlatformVerdict(g);
  const client = platformClient(g.platform);
  if (client === null) return verdict('proposed', [`adapter not built yet: ${g.platform}`, `detected: ${g.platform} ${g.slug ?? '(no slug)'}`]);
  if (g.slug === null || g.slug.trim() === '') return verdict('proposed', [`no board slug for ${g.platform}`]);
  if (!ctx.http) throw new KernelError('policy_denied', 'no http capability issued');
  const host = client.host;
  const off = gate.state.disabled.get(host);
  if (off !== undefined) throw deferred(off, host, 'disabled earlier in this run');

  let read: BoardRead;
  try {
    read = await client.readBoard(g.slug, ctx.http, { timeoutMs });
  } catch (e) {
    if (e instanceof BoardRefused) {
      gate.disable(host, `http-${e.status}`, ctx.clock.now());
      throw deferred(`http-${e.status}`, host, 'it refused this request');
    }
    if (e instanceof KernelError && e.code === 'rate_limit') {
      gate.disable(host, 'http-429', ctx.clock.now());
      throw deferred('http-429', host, 'it rate-limited this request');
    }
    if (e instanceof KernelError && e.code === 'gone') return verdict('failed', [`board not found (404): ${g.platform} ${g.slug}`]);
    if (e instanceof KernelError && (e.code === 'invalid_output' || e.code === 'overloaded' || e.code === 'network' || (e.code === 'timeout' && !ctx.signal.aborted))) {
      return verdict('failed', [`${g.platform} board ${g.slug}: ${e.message}`]);
    }
    throw e;
  }

  const c = g.site.candidate;
  const label = domainLabel(c.companyKey);
  const reasons: string[] = [];
  let sameName: boolean;
  if (read.boardNames.length > 1) {
    sameName = false;
    reasons.push(`board lists several company names (${read.boardNames.join(', ')}), please confirm`);
  } else if (read.boardName !== null) {
    sameName = sameCompany(c.name, read.boardName, label);
    if (!sameName) reasons.push(`board name '${read.boardName}' ≈ '${c.name}', please confirm`);
  } else {
    sameName = sameCompany(c.name, g.slug, label);
    if (!sameName) reasons.push('board name not available, please confirm', `board slug '${g.slug}' is neither '${c.name}' nor the domain label '${label}'`);
  }
  const jobs = read.jobs.length;
  if (jobs === 0) reasons.push('board has 0 open jobs');
  if (sameName && jobs >= 1) {
    const by = read.boardName !== null ? `board name '${read.boardName}'` : `board slug '${g.slug}'`;
    return verdict('verified', [`${g.platform} board ${g.slug}: ${jobs}${read.complete ? '' : '+'} open jobs; ${by} matches '${c.name}'`], read);
  }
  return verdict('proposed', reasons, read);
}
