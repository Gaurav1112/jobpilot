import { defineAgent } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { RawPosting } from '../../types.js';
import { checkParsed, finish, getBoard, idOf, isRecord, sourceContract, type Parsed } from './common.js';

/**
 * Jobicy remote-jobs API: two requests per step, `geo=apac` then `geo=anywhere`, each with
 * `tag=backend` and `count=50` (no paging). There is no India geo slug. A job in both answers is
 * kept once (the first seen, i.e. the apac copy). `raw` is the job object unchanged (no
 * request-time fields seen live); the envelope (`apiVersion`, `friendlyNotice`, `lastUpdate`,
 * `nextCursor`, `hasMore`, `appliedFilters`, `statusCode`, `success`) is dropped.
 */
export const JOBICY_HOST = 'jobicy.com';
export const JOBICY_FEED = 'jobicy';
export const JOBICY_GEOS = ['apac', 'anywhere'] as const;

export const jobicyUrl = (geo: string): string => `https://${JOBICY_HOST}/api/v2/remote-jobs?count=50&geo=${geo}&tag=backend`;

export function jobicyParse(json: unknown): Parsed {
  if (!isRecord(json) || !Array.isArray(json.jobs)) throw new KernelError('invalid_output', 'jobicy: no jobs array');
  const postings: RawPosting[] = [];
  const skipped: string[] = [];
  json.jobs.forEach((job: unknown, i: number) => {
    const id = isRecord(job) ? idOf(job.id) : undefined;
    if (!isRecord(job) || id === undefined || typeof job.jobTitle !== 'string' || typeof job.companyName !== 'string') {
      skipped.push(`jobicy job ${i}: missing id, jobTitle or companyName`);
      return;
    }
    postings.push({ source: 'jobicy', sourceId: id, company: job.companyName, slug: JOBICY_FEED, raw: job });
  });
  return checkParsed('jobicy', json.jobs.length, { postings, skipped });
}

export const srcJobicyContract = sourceContract('src-jobicy', JOBICY_HOST, 'Fetches APAC or worldwide backend jobs from the Jobicy feed');

export const srcJobicy = defineAgent(srcJobicyContract, async (req, ctx) => {
  if (req.ats !== 'feed' || req.slug !== JOBICY_FEED) return [];
  const all: RawPosting[] = [];
  for (const geo of JOBICY_GEOS) all.push(...jobicyParse(await getBoard(ctx, jobicyUrl(geo), JOBICY_FEED)).postings);
  return finish(all);
});
