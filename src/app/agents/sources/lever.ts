import { defineAgent } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { DiscoveryRequest, RawPosting } from '../../types.js';
import { capReached, checkParsed, finish, getBoard, idOf, isRecord, omit, onlySeenBefore, repeatedPage, sourceContract, type Parsed } from './common.js';

/**
 * Lever Postings API: a top-level array. A big board unpaged (veeva: 937 postings, 13 MB) comes
 * close to the broker's 16 MiB cap, so the list is paged with `skip`/`limit` (LEVER_PAGE_SIZE per
 * page). No single signal is trusted as the end of the list:
 * - a short page may be the last one, but a server that clamps `limit` or a glitching page also
 *   looks short, so the next page is always fetched: empty means the natural end, anything else is
 *   `invalid_output` ('lever <slug>: short page before end');
 * - only an empty page ends the walk;
 * - LEVER_MAX_PAGES (10,000 postings) is a safety cap. After that many pages one more request
 *   confirms the end; if it is not empty the step fails ('lever <slug>: page cap reached at N
 *   postings'), so an exactly-full board is not a false alarm and a bigger one is never cut quietly;
 * - a page whose ids were all seen on earlier pages (the API ignored `skip`, or cycles A, B, A) is
 *   `invalid_output`.
 * Pages are processed in request order and deduped by id (the first copy wins), then sorted.
 * A failed page fails the whole step; the GETs are idempotent, so a retry starts again at page 1.
 * A live page took up to 7.7 s and pages share the 1 s host pacer, so the step timeout
 * (LEVER_TIMEOUT_MS) allows 9 s per page at the cap (8.9 s per request counting the confirming one;
 * the kernel caps a step at 900 s).
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
  const seen = new Set<string>();
  let short = false;
  for (let page = 0; ; page++) {
    const json = await getBoard(ctx, leverUrl(req.slug, page * LEVER_PAGE_SIZE), req.slug);
    const parsed = leverParse(json, req);
    const jobs = json as unknown[];
    if (jobs.length === 0) break;
    if (short) throw new KernelError('invalid_output', `${what}: short page before end`);
    if (page === LEVER_MAX_PAGES) throw capReached(what, 'page', finish(all).length);
    if (onlySeenBefore(seen, parsed.postings.map((p) => p.sourceId))) throw repeatedPage(what, page + 1);
    all.push(...parsed.postings);
    short = jobs.length < LEVER_PAGE_SIZE;
  }
  return finish(all);
});
