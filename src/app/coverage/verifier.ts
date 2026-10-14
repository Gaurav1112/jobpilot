import { defineAgent, type AgentContext } from '../../kernel/agent.js';
import type { EgressSets } from '../../kernel/broker.js';
import { defineContract } from '../../kernel/contract.js';
import { KernelError } from '../../kernel/errors.js';
import { BoardRefused, platformClient, type BoardRead, type PlatformClient } from '../agents/sources/platforms/client.js';
import { HostDisabled, RobotsDenied, type PlatformHosts } from '../agents/sources/platforms/shared.js';
import { gateOf, HOST_DISABLED, REQUEST_TIMEOUT_MS, stepFetcher, type GateSource, type RunGate } from './gate.js';
import { robotsDenial, robotsVerdictOf, type RobotsVerdict } from './robots.js';
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
 * the daily adapters already read (robots.txt is not fetched for it, exactly as the daily adapters do not), except
 * Workday, whose CXS endpoint is the careers page's own JSON: its tenant's robots.txt is checked through the gate (once
 * per host per run) before page 1 is read; a disallow is `proposed` (`robots-disallow … : the board was not read`).
 * Workday names no company: its tenant is compared, under the generic-label rules, as a slug is. Eightfold and Oracle
 * Recruiting Cloud (Task 7) read the same way, through the gate; Oracle's robots.txt answers 403 (its WAF), which for
 * its REST API is "unknown", read at the minimal rate (`client.robotsUnreadable`, a controller decision): the gate
 * fetches it without disabling the host, and a readable robots.txt still governs. A 401, 403
 * or 429 from it DISABLES the host for the rest of the run (written to `coverage_host_state` before the step returns,
 * this agent's one side channel outside its output) and the step is deferred: it fails `input_rejected` with
 * `host-disabled:<why> on <host>`, so it is never stored as a finished result and is asked again in a later run. A step that
 * meets a host already disabled (by itself or a sibling) is deferred the same way, without a request.
 */

export const boardVerifierContract = defineContract({
  id: 'board-verifier',
  // 2.0.0: capabilities.httpPost (Workday's CXS list is read with a POST), a security field, so a major version
  version: '2.0.0',
  description: 'Reads a detected job board once to confirm its company name, its shape, its open jobs; a refused host is recorded in the run\'s coverage_host_state',
  skills: ['board-verifier'],
  team: 'coverage-verifier',
  kind: 'io',
  consumes: PlatformGuess,
  produces: CompanyVerdict,
  capabilities: { http: true, httpPost: true },
  egress: ['coverage:candidate-hosts'],
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 60_000,
  retry: { max: 0, on: [], backoffMs: [] },
});

/** The registrable domain's first label (`purestorage.com` → `purestorage`, `foo.co.uk` → `foo`): the companyKey's. */
export const domainLabel = (companyKey: string): string => companyKey.split('.')[0] ?? '';

/** The host the verifier reads a guess's board from: the built platform client's host (Workday: the tenant's own); none for anything else. */
export function verifierHosts(g: PlatformGuess): string[] {
  if (g.platform === null || g.slug === null) return [];
  const client = platformClient(g.platform);
  const ref = client?.refOf(g.slug, g.boardUrl) ?? null;
  const host = client === null || ref === null ? null : client.hostOf(ref);
  return host === null ? [] : [host];
}

/**
 * The run gate as a robots-governed client's host state (Workday, Eightfold, Oracle): robots.txt once per host per run
 * (the gate's own cache and rules), and the gate's disabled hosts. Only for a platform whose read robots.txt governs
 * (`client.robots`). `unreadable: 'allow'` (Oracle): robots.txt is fetched through the gate without its robots rules,
 * so a plain 401/403 neither disables the host nor refuses the read (it is "unknown"); a challenge or 429 still
 * disables the host (the gate's fetch does that), and any other answer is judged by the usual status rules.
 */
function gateHosts(ctx: AgentContext, gate: RunGate, host: string, timeoutMs: number, unreadable: 'refuse' | 'allow' = 'refuse'): PlatformHosts {
  const fetcher = stepFetcher({ ctx, gate, planned: new Set([host]), acceptMoved: () => false, maxRequests: 1, requestTimeoutMs: timeoutMs });
  const unknownOk = async (h: string): Promise<RobotsVerdict> => {
    const r = await fetcher.fetchUrl(`https://${h}/robots.txt`, false);
    // a challenge has disabled the host: the read sees that and defers
    if (r.kind === 'challenge') return { kind: 'allow-all', why: r.reason };
    if (r.kind !== 'ok') return { kind: 'disallow-all', reason: 'robots-unavailable', why: r.kind === 'miss' ? r.reason : 'robots.txt moved' };
    if (r.status === 401 || r.status === 403) return { kind: 'allow-all', why: `robots.txt ${r.status}: unreadable, read at the minimal rate` };
    return robotsVerdictOf(r.status, r.body);
  };
  return {
    robots: async (h, path) => robotsDenial(await (unreadable === 'allow' ? unknownOk(h) : fetcher.robotsFor(h)), new URL(`https://${h}${path}`)),
    disabledWhy: (h) => gate.disabledWhy(h, ctx.clock.now()),
    disable: (h, why) => gate.disable(h, why, ctx.clock.now()),
  };
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

/** The read options: the verifier's timeout, plus the gate as host state where robots.txt governs the read (Workday). */
const readOptions = (client: PlatformClient, ctx: AgentContext, gate: RunGate, host: string, timeoutMs: number) =>
  client.robots ? { timeoutMs, hosts: gateHosts(ctx, gate, host, timeoutMs, client.robotsUnreadable ?? 'refuse') } : { timeoutMs };

const deferred = (why: string, host: string, detail: string): KernelError => new KernelError('input_rejected', `${HOST_DISABLED}${why} on ${host} (${detail}); deferred to a later run, never retried around`);

async function verify(g: PlatformGuess, ctx: AgentContext, gate: RunGate, timeoutMs: number): Promise<CompanyVerdict> {
  const verdict = (status: CompanyVerdict['status'], reasons: string[], read?: BoardRead): CompanyVerdict => ({
    // a read may name what to store instead of the detection's slug and board URL (Eightfold: its API variant)
    guess: read?.stored === undefined ? g : { ...g, slug: read.stored.slug, boardUrl: read.stored.boardUrl },
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
  const ref = client.refOf(g.slug, g.boardUrl);
  const host = ref === null ? null : client.hostOf(ref);
  if (ref === null || host === null) return verdict('proposed', [`no readable ${g.platform} board in ${g.boardUrl ?? g.slug}, please confirm`]);
  const off = gate.disabledWhy(host, ctx.clock.now());
  if (off !== undefined) throw deferred(off, host, 'disabled earlier in this run');

  let read: BoardRead;
  try {
    read = await client.readBoard(ref, ctx.http, readOptions(client, ctx, gate, host, timeoutMs));
  } catch (e) {
    if (e instanceof HostDisabled) throw deferred(e.why, e.host, 'disabled earlier in this run');
    if (e instanceof RobotsDenied) {
      const why = gate.disabledWhy(e.host, ctx.clock.now());
      if (why !== undefined) throw deferred(why, e.host, 'its robots.txt refused this run');
      return verdict('proposed', [`${e.reason} on ${e.host}: the board was not read, please confirm`, `detected: ${g.platform} ${ref}`]);
    }
    if (e instanceof BoardRefused) {
      gate.disable(host, `http-${e.status}`, ctx.clock.now());
      throw deferred(`http-${e.status}`, host, 'it refused this request');
    }
    if (e instanceof KernelError && e.code === 'rate_limit') {
      gate.disable(host, 'http-429', ctx.clock.now());
      throw deferred('http-429', host, 'it rate-limited this request');
    }
    // a challenge page (Eightfold's careers page, Task 7 fix round 2): a refusal, deferred like a 429, never a failed verdict
    if (e instanceof KernelError && e.code === 'challenged') {
      gate.disable(host, 'challenge', ctx.clock.now());
      throw deferred('challenge', host, 'it answered with a challenge page');
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
    const key = read.nameKey ?? g.slug;
    const what = read.nameKey === null ? 'board slug' : `${g.platform} tenant`;
    sameName = sameCompany(c.name, key, label);
    if (!sameName) reasons.push('board name not available, please confirm', `${what} '${key}' is neither '${c.name}' nor the domain label '${label}'`);
  }
  const jobs = read.jobs.length;
  if (jobs === 0) reasons.push('board has 0 open jobs');
  if (sameName && jobs >= 1) {
    const by = read.boardName !== null ? `board name '${read.boardName}'` : read.nameKey !== null ? `${g.platform} tenant '${read.nameKey}'` : `board slug '${g.slug}'`;
    return verdict('verified', [`${g.platform} board ${g.slug}: ${jobs}${read.complete ? '' : '+'} open jobs; ${by} matches '${c.name}'`], read);
  }
  return verdict('proposed', reasons, read);
}
