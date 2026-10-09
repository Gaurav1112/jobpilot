import { defineAgent } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { DiscoveryRequest, RawPosting } from '../../types.js';
import { capReached, checkParsed, finish, getBoard, idOf, isRecord, omit, pageSignature, repeatedPage, sourceContract, type Parsed } from './common.js';

/**
 * Lever Postings API: a top-level array. A big board unpaged (veeva: 937 postings, 13 MB) comes
 * close to the broker's 16 MiB cap, so the list is paged with `skip`/`limit` (LEVER_PAGE_SIZE per
 * page) until the API's natural end: the first page shorter than LEVER_PAGE_SIZE (an empty page
 * included). Nothing is truncated quietly:
 * - LEVER_MAX_PAGES (10,000 postings) is a safety cap; reaching it before the natural end is
 *   `invalid_output` ('lever <slug>: page cap reached at N postings');
 * - a page with the same length, first id and last id as the one before means the API ignored
 *   `skip`, which would loop or return a partial board, so it is `invalid_output` too.
 * Pages are processed in request order and deduped by id (the first copy wins), then sorted.
 * A failed page fails the whole step; the GETs are idempotent, so a retry starts again at page 1.
 * A live page took up to 7.7 s and pages share the 1 s host pacer, so the step timeout
 * (LEVER_TIMEOUT_MS) allows 9 s per page at the cap.
 * `raw` is the posting unchanged, except a `salaryRange` whose min and max are both 0 is
 * dropped (Lever's placeholder for "no salary"). Live postings carry no request-time fields.
 */
export const LEVER_HOST = 'api.lever.co';
export const LEVER_PAGE_SIZE = 100;
export const LEVER_MAX_PAGES = 100;
export const LEVER_TIMEOUT_MS = 900_000;

export const leverUrl = (slug: string, skip: number): string =>
  `https://${LEVER_HOST}/v0/postings/${encodeURIComponent(slug)}?mode=json&skip=${skip}&limit=${LEVER_PAGE_SIZE}`;

const zeroSalary = (v: unknown): boolean => isRecord(v) && v.min === 0 && v.max === 0;

export function leverParse(json: unknown, req: DiscoveryRequest): Parsed {
  if (!Array.isArray(json)) throw new KernelError('invalid_output', `lever board ${req.slug}: response is not an array`);
  const postings: RawPosting[] = [];
  const skipped: string[] = [];
  json.forEach((job: unknown, i: number) => {
    const id = isRecord(job) ? idOf(job.id) : undefined;
    if (!isRecord(job) || id === undefined || typeof job.text !== 'string') {
      skipped.push(`lever ${req.slug} posting ${i}: missing id or text`);
      return;
    }
    const raw = zeroSalary(job.salaryRange) ? omit(job, ['salaryRange']) : job;
    postings.push({ source: 'lever', sourceId: id, company: req.company, slug: req.slug, raw });
  });
  return checkParsed('lever', json.length, { postings, skipped });
}

export const srcLeverContract = sourceContract('src-lever', LEVER_HOST, 'Fetches one Lever postings board', LEVER_TIMEOUT_MS);

export const srcLever = defineAgent(srcLeverContract, async (req, ctx) => {
  if (req.ats !== 'lever') return [];
  const what = `lever ${req.slug}`;
  const all: RawPosting[] = [];
  let previous: string | undefined;
  for (let page = 0; ; page++) {
    if (page === LEVER_MAX_PAGES) throw capReached(what, 'page', finish(all).length);
    const json = await getBoard(ctx, leverUrl(req.slug, page * LEVER_PAGE_SIZE), req.slug);
    const parsed = leverParse(json, req);
    const jobs = json as unknown[];
    const signature = pageSignature(jobs, 'id');
    if (signature !== undefined && signature === previous) throw repeatedPage(what, page + 1);
    previous = signature;
    all.push(...parsed.postings);
    if (jobs.length < LEVER_PAGE_SIZE) break;
  }
  return finish(all);
});
