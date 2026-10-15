import type { AgentContext } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import { hasChallengeMarker, isChallenge } from '../../challenge.js';

/**
 * The shared rules for reading GitHub's REST API (sources-expansion Tasks 10 and 11: Draft.dev, Prime Intellect).
 * The API is documented and public; unauthenticated it allows 60 core requests per hour and 10 search requests per
 * minute per IP, so both GitHub sources share ONE `GithubHosts` per run (one host, one request budget). robots.txt is
 * not asked for the API host, as the Greenhouse API is read. The honest user agent is the broker's, nothing is sent
 * but the GET, no token, no login.
 */
export const GITHUB_API_HOST = 'api.github.com';
/** Requests to api.github.com per freelance run, both GitHub sources together (2 runs/day, so at most 24 of 60 an hour). */
export const GITHUB_MAX_REQUESTS_PER_RUN = 12;
/** The spacing between two requests to the host (on top of the run's pacer). */
export const GITHUB_MIN_INTERVAL_MS = 2000;

/** The run's view of api.github.com: how many requests were made and whether the host was disabled (and why). */
export interface GithubHosts {
  used: number;
  disabled?: string;
}
export const makeGithubHosts = (): GithubHosts => ({ used: 0 });

/** A refusal: the host is disabled for the run and the step fails with the named code; nothing is retried around it. */
function refuse(hosts: GithubHosts, why: string, code: 'challenged' | 'rate_limit', detail: string): never {
  hosts.disabled ??= why;
  throw new KernelError(code, `${GITHUB_API_HOST} ${detail}: the host is disabled for this run, never retried around`);
}

/**
 * One GET to api.github.com under the run's rules: a disabled host is never asked (`input_rejected`
 * `host-disabled:<why> on api.github.com`); over GITHUB_MAX_REQUESTS_PER_RUN is `input_rejected` `github-budget: …`
 * (loud, never a silent stop); `minIntervalMs: 2000`. A 403 (GitHub's rate-limit answer is a 403) and a 401 disable the
 * host (`challenged`), a 429 disables it (`rate_limit`); Retry-After and the X-RateLimit headers are never read (the
 * broker does not expose them, and a refusal ends the run's reads anyway). 404 is `gone`, 5xx `overloaded`, a body that
 * is not JSON `invalid_output`.
 */
export async function githubJson(ctx: AgentContext, hosts: GithubHosts, path: string): Promise<unknown> {
  if (hosts.disabled !== undefined) throw new KernelError('input_rejected', `host-disabled:${hosts.disabled} on ${GITHUB_API_HOST}; ${path} deferred to the next run, never retried around`);
  if (!ctx.http) throw new KernelError('policy_denied', 'no http capability issued');
  if (hosts.used >= GITHUB_MAX_REQUESTS_PER_RUN) {
    throw new KernelError('input_rejected', `github-budget: ${hosts.used} requests to ${GITHUB_API_HOST} this run reached the cap of ${GITHUB_MAX_REQUESTS_PER_RUN}; ${path} not read`);
  }
  hosts.used += 1;
  const r = await ctx.http.getPage(`https://${GITHUB_API_HOST}${path}`, { minIntervalMs: GITHUB_MIN_INTERVAL_MS });
  const what = `the request for ${path}`;
  if (isChallenge(r.status, r.body)) refuse(hosts, 'challenge', 'challenged', `answered ${what} with a challenge page (${r.status})`);
  if (r.status === 429) refuse(hosts, 'http-429', 'rate_limit', `answered ${what} with 429`);
  if (r.status === 401 || r.status === 403) refuse(hosts, `http-${r.status}`, 'challenged', `answered ${what} with ${r.status}`);
  if (r.status === 404) throw new KernelError('gone', `${GITHUB_API_HOST} has no ${path}`);
  if (r.status >= 500) throw new KernelError('overloaded', `${GITHUB_API_HOST} answered ${what} with ${r.status}`);
  if (r.status < 200 || r.status >= 300) throw new KernelError('invalid_output', `${GITHUB_API_HOST} answered ${what} with ${r.status}`);
  try {
    return JSON.parse(r.body) as unknown;
  } catch {
    if (hasChallengeMarker(r.body)) refuse(hosts, 'challenge', 'challenged', `answered ${what} with a challenge page`);
    throw new KernelError('invalid_output', `${GITHUB_API_HOST}: the response to ${path} is not JSON`);
  }
}
