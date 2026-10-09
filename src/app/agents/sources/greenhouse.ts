import { defineAgent } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { DiscoveryRequest, RawPosting } from '../../types.js';
import { finish, getBoard, idOf, isRecord, sourceContract, type Parsed } from './common.js';

/**
 * Greenhouse Job Board API: the whole board in one response (no paging).
 * `raw` is the job object unchanged: live responses carry no request-time fields
 * (`updated_at` is content versioning and stays). The response envelope `meta` is dropped.
 */
export const GREENHOUSE_HOST = 'boards-api.greenhouse.io';

export const greenhouseUrl = (slug: string): string =>
  `https://${GREENHOUSE_HOST}/v1/boards/${encodeURIComponent(slug)}/jobs?content=true&pay_transparency=true`;

export function greenhouseParse(json: unknown, req: DiscoveryRequest): Parsed {
  if (!isRecord(json) || !Array.isArray(json.jobs)) throw new KernelError('invalid_output', `greenhouse board ${req.slug}: no jobs array`);
  const postings: RawPosting[] = [];
  const skipped: string[] = [];
  json.jobs.forEach((job: unknown, i: number) => {
    const id = isRecord(job) ? idOf(job.id) : undefined;
    if (!isRecord(job) || id === undefined || typeof job.title !== 'string') {
      skipped.push(`greenhouse ${req.slug} job ${i}: missing id or title`);
      return;
    }
    postings.push({ source: 'greenhouse', sourceId: id, company: req.company, slug: req.slug, raw: job });
  });
  return { postings, skipped };
}

export const srcGreenhouseContract = sourceContract('src-greenhouse', GREENHOUSE_HOST, 'Fetches one Greenhouse job board');

export const srcGreenhouse = defineAgent(srcGreenhouseContract, async (req, ctx) => {
  if (req.ats !== 'greenhouse') return [];
  return finish(greenhouseParse(await getBoard(ctx, greenhouseUrl(req.slug), req.slug), req).postings);
});
