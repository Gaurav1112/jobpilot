import { KernelError } from '../kernel/errors.js';
import { WORKDAY_MIN_INTERVAL_MS, type HttpTool, type WorkdayHosts } from './agents/sources/platforms/workday.js';
import { isChallenge } from './coverage/gate.js';
import { robotsDenial, robotsVerdictOf, type RobotsVerdict } from './coverage/robots.js';

/**
 * The daily run's host state for the registry platform adapters (Task 6: Workday), built once per daily run by the
 * wiring and handed to the adapter, so it never outlives the run:
 * - robots.txt is fetched once per host per run, through the adapter's own broker context (its egress, the honest
 *   user agent, the 2 s Workday spacing), and matched with the coverage run's robots.txt rules (`coverage/robots.ts`:
 *   the parser, the matcher and the status rules; nothing of the coverage run's tables or run state). A robots.txt
 *   that fails to arrive (network, timeout) is not cached: the step fails and its retry asks again.
 * - A host that answers a robots.txt with a challenge page or 429, or any request with 401, 403 or 429, is disabled
 *   for the rest of the run (in memory: a daily run is one process); the adapter never asks it again in this run.
 */
export function dailyWorkdayHosts(): WorkdayHosts {
  const robots = new Map<string, Promise<RobotsVerdict>>();
  const disabled = new Map<string, string>();

  async function verdictOf(host: string, http: HttpTool): Promise<RobotsVerdict> {
    const r = await http.getPage(`https://${host}/robots.txt`, { minIntervalMs: WORKDAY_MIN_INTERVAL_MS });
    if (isChallenge(r.status, r.body)) {
      disabled.set(host, 'challenge');
      throw new KernelError('challenged', `${host} answered its robots.txt with a challenge page (${r.status}): the host is disabled for this run, never retried around`);
    }
    if (r.status === 429) {
      disabled.set(host, 'http-429');
      throw new KernelError('rate_limit', `429 from ${host} for robots.txt: the host is disabled for this run`);
    }
    return robotsVerdictOf(r.status, r.body);
  }

  return {
    async robots(host, path, http) {
      let p = robots.get(host);
      if (p === undefined) {
        p = verdictOf(host, http);
        robots.set(host, p);
        // only a settled verdict is kept: a robots.txt that never arrived is asked again by the next step
        p.catch(() => robots.delete(host));
      }
      return robotsDenial(await p, new URL(`https://${host}${path}`));
    },
    disabledWhy: (host) => disabled.get(host),
    disable(host, why) {
      if (!disabled.has(host)) disabled.set(host, why);
    },
  };
}
