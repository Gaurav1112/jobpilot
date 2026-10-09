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
 * - only an empty page ends the walk, and an empty page right after a FULL page (a board size that
 *   is an exact multiple of 100, or a transient `[]`) is re-requested once: still empty means the
 *   end, anything else is `invalid_output`;
 * - LEVER_MAX_PAGES (7,000 postings) is a safety cap. After that many pages one more request
 *   confirms the end; if it is not empty the step fails ('lever <slug>: page cap reached at N
 *   postings'), so an exactly-full board is not a false alarm and a bigger one is never cut quietly;
 * - a page whose ids were all seen on earlier pages (the API ignored `skip`, or cycles A, B, A) is
 *   `invalid_output`, and so is a full page bringing fewer than LEVER_MIN_NEW_PER_PAGE new ids
 *   (say 99 duplicates plus 1 new), since Lever's list is stable.
 * Pages are processed in request order and deduped by id (the first copy wins), then sorted.
 * A failed page fails the whole step; the GETs are idempotent, so a retry starts again at page 1.
 * Live requests took 10.6 to 12 s each on 2026-10-09 (pages share the 1 s host pacer). The step
 * timeout (LEVER_TIMEOUT_MS, the kernel's 900 s maximum) allows 12.5 s per request at the cap,
 * counting the confirming request and its re-request, so a board too big for the cap fails with the cap error, not a timeout.
 * `raw` is the posting unchanged, except a `salaryRange` whose min and max are both 0 is
 * dropped (Lever's placeholder for "no salary"). Live postings carry no request-time fields.
 */
export const LEVER_HOST = 'api.lever.co';
export const LEVER_PAGE_SIZE = 100;
export const LEVER_MAX_PAGES = 70;
export const LEVER_TIMEOUT_MS = 900_000;
/** Every full (non-final) page must bring at least this many ids not seen on earlier pages. */
export const LEVER_MIN_NEW_PER_PAGE = 90;

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
    const url = leverUrl(req.slug, page * LEVER_PAGE_SIZE);
    const json = await getBoard(ctx, url, req.slug);
    const parsed = leverParse(json, req);
    const jobs = json as unknown[];
    if (jobs.length === 0) {
      // After a short page (or on page 0) an empty page is the end. After a full page it is the end
      // only if the board size is an exact multiple of LEVER_PAGE_SIZE, so the page is asked once more.
      if (page > 0 && !short) {
        const again = await getBoard(ctx, url, req.slug);
        if (!Array.isArray(again) || again.length > 0) {
          throw new KernelError('invalid_output', `${what}: empty page at skip ${page * LEVER_PAGE_SIZE} after a full page was not empty on re-request`);
        }
      }
      break;
    }
    if (short) throw new KernelError('invalid_output', `${what}: short page before end`);
    if (page === LEVER_MAX_PAGES) throw capReached(what, 'page', finish(all).length);
    const pageIds = parsed.postings.map((p) => p.sourceId);
    const fresh = new Set(pageIds.filter((id) => !seen.has(id))).size;
    if (onlySeenBefore(seen, pageIds)) throw repeatedPage(what, page + 1);
    // A full page is never the last one; Lever's list is stable, so it must be mostly new.
    if (jobs.length === LEVER_PAGE_SIZE && fresh < LEVER_MIN_NEW_PER_PAGE) {
      throw new KernelError('invalid_output', `${what}: page ${page + 1} brought ${fresh} new postings, minimum ${LEVER_MIN_NEW_PER_PAGE}`);
    }
    all.push(...parsed.postings);
    short = jobs.length < LEVER_PAGE_SIZE;
  }
  return finish(all);
});
