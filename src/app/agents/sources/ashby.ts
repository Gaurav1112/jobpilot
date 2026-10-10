import { defineAgent } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { DiscoveryRequest, RawPosting } from '../../types.js';
import { checkParsed, reportSkips, finish, getBoard, idOf, isRecord, sourceContract, type Parsed } from './common.js';

/**
 * Ashby posting API: the whole board in one response, compensation included.
 * `raw` is the job object unchanged (no request-time fields seen live); the envelope
 * `apiVersion` is dropped.
 */
export const ASHBY_HOST = 'api.ashbyhq.com';

export const ashbyUrl = (slug: string): string =>
  `https://${ASHBY_HOST}/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;

export function ashbyParse(json: unknown, req: DiscoveryRequest): Parsed {
  if (!isRecord(json) || !Array.isArray(json.jobs)) throw new KernelError('invalid_output', `ashby board ${req.slug}: no jobs array`);
  const postings: RawPosting[] = [];
  const skipped: string[] = [];
  json.jobs.forEach((job: unknown, i: number) => {
    const id = isRecord(job) ? idOf(job.id) : undefined;
    if (!isRecord(job) || id === undefined || typeof job.title !== 'string') {
      skipped.push(`ashby ${req.slug} job ${i}: missing id or title`);
      return;
    }
    postings.push({ source: 'ashby', sourceId: id, company: req.company, slug: req.slug, raw: job });
  });
  return checkParsed('ashby', json.jobs.length, { postings, skipped });
}

export const srcAshbyContract = sourceContract('src-ashby', ASHBY_HOST, 'Fetches one Ashby job board');

export const srcAshby = defineAgent(srcAshbyContract, async (req, ctx) => {
  if (req.ats !== 'ashby') return [];
  return finish(reportSkips(ctx, ashbyParse(await getBoard(ctx, ashbyUrl(req.slug), req.slug), req)).postings);
});
