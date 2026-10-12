import { defineAgent } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { RawGig } from '../types.js';
import { checkGigs, finishGigs, getBoard, gigSourceContract, idOf, isRecord } from './common.js';

/**
 * Freelancer.com public projects API, one request per query:
 * `?query=<q>&limit=50&full_description=true&job_details=true&sort_field=time_updated`. One GigRequest carries one query,
 * and the run seeds one request per pack query. The agent dedupes within its response; `mergeGigs` merges the queries.
 *
 * `raw` keeps `title, description, preview_description, type, budget, currency{code, exchange_rate}, time_submitted,
 * seo_url, jobs[].name, local, bid_stats, owner_id` and `hourly_project_info` without its `commitment`. Freelancer.com
 * fills `commitment` ({hours: 40, interval: 'week'}) with a default on every hourly project, so it is not the client's
 * statement and nothing downstream may read hours from it (spec §4.6). Everything else is dropped.
 *
 * An empty `result.projects` is a valid empty result (`[]`); a missing one is `invalid_output`.
 */
export const FREELANCER_HOST = 'www.freelancer.com';

export const freelancerUrl = (query: string): string =>
  `https://${FREELANCER_HOST}/api/projects/0.1/projects/active/?query=${encodeURIComponent(query)}&limit=50&full_description=true&job_details=true&sort_field=time_updated`;

export const srcFreelancerContract = gigSourceContract('src-freelancer', FREELANCER_HOST, 'Fetches active Freelancer.com projects for one search query');

/** `hourly_project_info` without `commitment` (a default, ignored), or null when the project has none. */
function hourlyInfo(v: unknown): Record<string, unknown> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) if (k !== 'commitment') out[k] = val;
  return out;
}

function pick(project: Record<string, unknown>): Record<string, unknown> {
  const currency = isRecord(project.currency) ? { code: project.currency.code ?? null, exchange_rate: project.currency.exchange_rate ?? null } : null;
  const jobs = Array.isArray(project.jobs) ? project.jobs.flatMap((j) => (isRecord(j) && typeof j.name === 'string' ? [{ name: j.name }] : [])) : [];
  return {
    title: project.title,
    description: project.description ?? null,
    preview_description: project.preview_description ?? null,
    type: project.type ?? null,
    budget: project.budget ?? null,
    currency,
    time_submitted: project.time_submitted ?? null,
    seo_url: project.seo_url ?? null,
    jobs,
    local: project.local ?? null,
    bid_stats: project.bid_stats ?? null,
    owner_id: project.owner_id ?? null,
    hourly_project_info: hourlyInfo(project.hourly_project_info),
  };
}

export const srcFreelancer = defineAgent(srcFreelancerContract, async (req, ctx) => {
  if (req.platform !== 'freelancer') return [];
  const json = await getBoard(ctx, freelancerUrl(req.query), req.query);
  const projects = isRecord(json) && isRecord(json.result) ? json.result.projects : undefined;
  if (!Array.isArray(projects)) throw new KernelError('invalid_output', `freelancer ${req.query}: no result.projects array`);
  const gigs: RawGig[] = [];
  const skipped: string[] = [];
  projects.forEach((p: unknown, i: number) => {
    const id = isRecord(p) ? idOf(p.id) : undefined;
    if (!isRecord(p) || id === undefined || typeof p.title !== 'string') {
      skipped.push(`freelancer ${req.query} project ${i}: missing id or title`);
      return;
    }
    gigs.push({ platform: 'freelancer', sourceId: id, raw: pick(p) });
  });
  checkGigs(ctx, 'freelancer', 'projects', projects.length, skipped);
  return finishGigs(gigs);
});
