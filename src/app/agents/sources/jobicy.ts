import { defineAgent } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { RawPosting } from '../../types.js';
import { capReached, checkParsed, reportSkips, finish, getBoard, idOf, isRecord, onlySeenBefore, sourceContract, type Parsed } from './common.js';

/**
 * Jobicy remote-jobs API, `tag=backend&count=50`, for `geo=apac` then `geo=anywhere` (there is
 * no India geo slug). Each geo is followed to its natural end: while a response says
 * `hasMore: true`, the next request passes its `nextCursor` back as `cursor` (checked live on
 * 2026-10-09: `after` is ignored, `cursor` pages). No end signal is taken on trust:
 * - `hasMore` must be a boolean; a missing or renamed field is `invalid_output`, not "no more";
 * - `hasMore: true` without a `nextCursor` is `invalid_output`;
 * - the envelope has no total for the whole result set (`jobCount` is the count on this page), so
 *   when `jobCount` is a number it must equal the jobs on the page;
 * - JOBICY_MAX_REQUESTS is a safety cap on requests for the whole step (both geos). One more
 *   request is allowed only to confirm an end; if it brings jobs, or another request would be
 *   needed, the step fails ('jobicy jobicy: request cap reached at N postings');
 * - within a geo, a page whose ids were all seen on earlier pages (repeat, or an A, B, A cycle)
 *   is `invalid_output`. Across geos repeats are normal (apac and anywhere overlap).
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
    const fail = (page: number, message: string): KernelError => new KernelError('invalid_output', `${what}: ${geo} page ${page} ${message}`);
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 1; ; page++) {
      if (requests > JOBICY_MAX_REQUESTS) throw capReached(what, 'request', finish(all).length);
      requests++;
      const json = await getBoard(ctx, jobicyUrl(geo, cursor), JOBICY_FEED);
      const parsed = reportSkips(ctx, jobicyParse(json), `${geo} page ${page}: `);
      const body = json as { jobs: unknown[]; hasMore?: unknown; nextCursor?: unknown; jobCount?: unknown };
      if (typeof body.hasMore !== 'boolean') throw fail(page, 'has no boolean hasMore');
      if (typeof body.jobCount === 'number' && body.jobCount !== body.jobs.length) {
        throw fail(page, `jobCount ${body.jobCount} but ${body.jobs.length} jobs`);
      }
      if (requests > JOBICY_MAX_REQUESTS && body.jobs.length > 0) throw capReached(what, 'request', finish(all).length);
      if (onlySeenBefore(seen, parsed.postings.map((p) => p.sourceId))) throw fail(page, 'repeats earlier postings');
      all.push(...parsed.postings);
      if (!body.hasMore) break;
      if (typeof body.nextCursor !== 'string' || body.nextCursor === '') throw fail(page, 'says hasMore but gives no nextCursor');
      cursor = body.nextCursor;
    }
  }
  return finish(all);
});
