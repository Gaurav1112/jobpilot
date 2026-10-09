import { defineAgent } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { RawPosting } from '../../types.js';
import { capReached, checkParsed, finish, getBoard, idOf, isRecord, pageSignature, sourceContract, type Parsed } from './common.js';

/**
 * Jobicy remote-jobs API, `tag=backend&count=50`, for `geo=apac` then `geo=anywhere` (there is
 * no India geo slug). Each geo is followed to its natural end: while a response says
 * `hasMore: true`, the next request passes its `nextCursor` back as `cursor` (checked live on
 * 2026-10-09: `after` is ignored, `cursor` pages). Nothing is truncated quietly:
 * - JOBICY_MAX_REQUESTS is a safety cap on requests for the whole step (both geos); reaching it
 *   before the natural end is `invalid_output` ('jobicy jobicy: request cap reached at N postings');
 * - `hasMore` without a `nextCursor`, or a page repeating the one before, is `invalid_output`.
 * A job in both geos is kept once: the first seen, i.e. the apac copy. A failed request fails the
 * whole step; a retry starts again at the first request. The step timeout allows 9 s per request.
 * `raw` is the job object unchanged (no request-time fields seen live); the envelope
 * (`apiVersion`, `documentationUrl`, `friendlyNotice`, `jobCount`, `lastUpdate`, `nextCursor`,
 * `hasMore`, `appliedFilters`, `statusCode`, `success`) is dropped.
 */
export const JOBICY_HOST = 'jobicy.com';
export const JOBICY_FEED = 'jobicy';
export const JOBICY_GEOS = ['apac', 'anywhere'] as const;
export const JOBICY_MAX_REQUESTS = 20;
export const JOBICY_TIMEOUT_MS = 180_000;

export const jobicyUrl = (geo: string, cursor?: string): string =>
  `https://${JOBICY_HOST}/api/v2/remote-jobs?count=50&geo=${geo}&tag=backend${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;

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

export const srcJobicyContract = sourceContract('src-jobicy', JOBICY_HOST, 'Fetches APAC or worldwide backend jobs from the Jobicy feed', JOBICY_TIMEOUT_MS);

export const srcJobicy = defineAgent(srcJobicyContract, async (req, ctx) => {
  if (req.ats !== 'feed' || req.slug !== JOBICY_FEED) return [];
  const what = `jobicy ${JOBICY_FEED}`;
  const all: RawPosting[] = [];
  let requests = 0;
  for (const geo of JOBICY_GEOS) {
    let cursor: string | undefined;
    let previous: string | undefined;
    for (let page = 1; ; page++) {
      if (requests === JOBICY_MAX_REQUESTS) throw capReached(what, 'request', finish(all).length);
      requests++;
      const json = await getBoard(ctx, jobicyUrl(geo, cursor), JOBICY_FEED);
      const parsed = jobicyParse(json);
      const body = json as { jobs: unknown[]; hasMore?: unknown; nextCursor?: unknown };
      const signature = pageSignature(body.jobs, 'id');
      if (signature !== undefined && signature === previous) {
        throw new KernelError('invalid_output', `${what}: ${geo} page ${page} repeats page ${page - 1}`);
      }
      previous = signature;
      all.push(...parsed.postings);
      if (body.hasMore !== true) break;
      if (typeof body.nextCursor !== 'string' || body.nextCursor === '') {
        throw new KernelError('invalid_output', `${what}: ${geo} page ${page} says hasMore but gives no nextCursor`);
      }
      cursor = body.nextCursor;
    }
  }
  return finish(all);
});
