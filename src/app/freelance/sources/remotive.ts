import { defineAgent } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { RawGig } from '../types.js';
import { checkGigs, finishGigs, getBoard, gigSourceContract, idOf, isRecord } from './common.js';

/**
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

export const srcRemotive = defineAgent(srcRemotiveContract, async (req, ctx) => {
  if (req.platform !== 'remotive' || req.half !== 'am') return [];
  const json = await getBoard(ctx, REMOTIVE_URL, 'remotive');
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
  checkGigs(ctx, 'remotive', 'jobs', json.jobs.length, skipped);
  return finishGigs(gigs);
});
