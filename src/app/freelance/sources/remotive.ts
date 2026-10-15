import { defineAgent } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { RawGig } from '../types.js';
import { checkGigs, finishGigs, getBoard, gigSourceContract, idOf, isRecord } from './common.js';

/**
 * OFF since 2026-10-15: see REMOTIVE_OFF. What follows describes the source as it was.
 *
 * Remotive public API, one request: `https://remotive.com/api/remote-jobs?category=software-dev`. Its notice asks for
 * few calls (at most 2 a day), so the agent answers only the `am` half of an IST day and returns `[]` for `pm`
 * without a request; the pm run reuses the am outputs through the projector.
 *
 * Keeps jobs whose `job_type` is `contract`, `freelance` or `part_time`. `raw` is the whole job: its `url` is the
 * Remotive page, which is the attribution link the notice requires. The envelope (`00-warning`, `0-legal-notice`,
 * counts) is dropped.
 */
export const REMOTIVE_HOST = 'remotive.com';
export const REMOTIVE_URL = `https://${REMOTIVE_HOST}/api/remote-jobs?category=software-dev`;
export const REMOTIVE_JOB_TYPES: readonly string[] = ['contract', 'freelance', 'part_time'];

export const srcRemotiveContract = gigSourceContract('src-remotive', REMOTIVE_HOST, 'Fetches contract or part-time software jobs from the Remotive feed');

/**
 * OFF since 2026-10-15 (controller decision, the user's rule "no scraping against robots.txt"): remotive.com's
 * robots.txt says `Disallow: /api/*` for every agent. The run never seeds Remotive (`freelanceSeeds`), and this agent
 * answers any Remotive request it still gets with the named skip REMOTIVE_OFF and no request. The code is kept for the
 * day the rule changes.
 */
export const REMOTIVE_OFF: string | null = 'robots.txt disallows /api (2026-10-15)';

/** The kept parse of one Remotive response (the agent's, before it was switched off): gigs and skipped-job notes. */
export function remotiveParse(json: unknown): { gigs: RawGig[]; skipped: string[]; total: number } {
  if (!isRecord(json) || !Array.isArray(json.jobs)) throw new KernelError('invalid_output', 'remotive: no jobs array');
  const gigs: RawGig[] = [];
  const skipped: string[] = [];
  json.jobs.forEach((job: unknown, i: number) => {
    const id = isRecord(job) ? idOf(job.id) : undefined;
    if (!isRecord(job) || id === undefined || typeof job.title !== 'string' || typeof job.url !== 'string') {
      skipped.push(`remotive job ${i}: missing id, title or url`);
      return;
    }
    if (typeof job.job_type === 'string' && REMOTIVE_JOB_TYPES.includes(job.job_type)) gigs.push({ platform: 'remotive', sourceId: id, raw: job });
  });
  return { gigs, skipped, total: json.jobs.length };
}

export const srcRemotive = defineAgent(srcRemotiveContract, async (req, ctx) => {
  if (req.platform !== 'remotive') return [];
  if (REMOTIVE_OFF !== null) {
    ctx.skipped([`remotive: ${REMOTIVE_OFF}; not read`]);
    return [];
  }
  if (req.half !== 'am') return [];
  const { gigs, skipped, total } = remotiveParse(await getBoard(ctx, REMOTIVE_URL, 'remotive'));
  checkGigs(ctx, 'remotive', 'jobs', total, skipped);
  return finishGigs(gigs);
});
