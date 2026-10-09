import { defineAgent } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { RawPosting } from '../../types.js';
import { capReached, checkParsed, finish, getBoard, idOf, isRecord, omit, onlySeenBefore, repeatedPage, sourceContract, type Parsed } from './common.js';

/**
 * Himalayas search API, `q=backend&country=IN&sort=recent`. There is deliberately no
 * `employment_type` filter: eligibility (spec §5.2) decides employment type, and a server-side
 * "Full Time" filter dropped "Other" and "Part Time" jobs it would keep.
 *
 * Pages (20 slots each) are walked from 1 against the envelope (`offset`, `limit`, `totalCount`),
 * which is the source of truth for the end; nothing is truncated quietly:
 * - every page must carry numeric `offset`, `limit` and `totalCount`, and its `offset` must be the
 *   previous page's `offset + limit` (page 1: 0), so every window of the result set is visited;
 * - the walk ends only at an empty page with `offset >= totalCount`. An empty page before that (a
 *   transient glitch, or an empty page 1 while `totalCount > 0`) is `invalid_output`;
 * - a short page is not the end. Live, the server drops a few slots from some pages: on 2026-10-09
 *   it served 827 jobs for `totalCount` 842 (15 slots missing over 11 short pages), so "jobs seen ==
 *   totalCount" cannot be asserted; window coverage plus the delivery tolerances below are the
 *   invariant instead;
 * - HIMALAYAS_MAX_PAGES (1,600 jobs) is a safety cap. After it, one more request confirms the end;
 *   if that is not empty the step fails ('himalayas himalayas: page cap reached at N postings');
 * - a page whose guids were all seen on earlier pages (repeat, or an A, B, A cycle) is
 *   `invalid_output`. Jobs filtered out for location count as seen.
 * A failed page fails the whole step; a retry starts again at page 1. Pages are processed in
 * request order and deduped by guid (first copy wins). The step timeout allows 9 s per page.
 *
 * `country=IN` also returns jobs restricted elsewhere, so a job is kept only when
 * `locationRestrictions` is empty (worldwide) or names India, Asia, APAC, Worldwide or Anywhere.
 *
 * There is no job id; `guid` (the job's himalayas.app URL) is the sourceId.
 * `raw` drops `expiryDate`: it moved between two fetches of the same job on 2026-10-09, so it is
 * request-time, not content. `pubDate` stays (it is epoch seconds, not ms; the normaliser converts).
 * The envelope (`comments`, `updatedAt`, `offset`, `limit`, `totalCount`) is dropped.
 */
export const HIMALAYAS_HOST = 'himalayas.app';
export const HIMALAYAS_FEED = 'himalayas';
/** Live on 2026-10-09: `totalCount` 842 needs 43 pages (the end is page 44); 80 pages (1,600 jobs) give 1.86x headroom. */
export const HIMALAYAS_MAX_PAGES = 80;
export const HIMALAYAS_TIMEOUT_MS = 720_000;
const DROPPED = ['expiryDate'] as const;

export const himalayasUrl = (page: number): string =>
  `https://${HIMALAYAS_HOST}/jobs/api/search?q=backend&country=IN&sort=recent&page=${page}`;

const ELIGIBLE = /^(india|asia|apac|asia[- ]pacific|worldwide|anywhere)$/i;

/** Live restrictions are country-name strings; the docs say `{alpha2, name, slug}` objects. Both are accepted. */
export function indiaEligible(restrictions: readonly unknown[]): boolean {
  if (restrictions.length === 0) return true;
  return restrictions.some((r) => {
    if (typeof r === 'string') return ELIGIBLE.test(r.trim());
    if (isRecord(r)) return (typeof r.alpha2 === 'string' && r.alpha2.toUpperCase() === 'IN') || (typeof r.name === 'string' && ELIGIBLE.test(r.name.trim()));
    return false;
  });
}

export function himalayasParse(json: unknown): Parsed {
  if (!isRecord(json) || !Array.isArray(json.jobs)) throw new KernelError('invalid_output', 'himalayas: no jobs array');
  const postings: RawPosting[] = [];
  const skipped: string[] = [];
  json.jobs.forEach((job: unknown, i: number) => {
    const id = isRecord(job) ? idOf(job.guid) : undefined;
    if (!isRecord(job) || id === undefined || typeof job.title !== 'string' || typeof job.companyName !== 'string' || !Array.isArray(job.locationRestrictions)) {
      skipped.push(`himalayas job ${i}: missing guid, title, companyName or locationRestrictions`);
      return;
    }
    if (!indiaEligible(job.locationRestrictions)) return;
    postings.push({ source: 'himalayas', sourceId: id, company: job.companyName, slug: HIMALAYAS_FEED, raw: omit(job, DROPPED) });
  });
  return checkParsed('himalayas', json.jobs.length, { postings, skipped });
}

export const srcHimalayasContract = sourceContract('src-himalayas', HIMALAYAS_HOST, 'Fetches India-eligible backend jobs from the Himalayas feed', HIMALAYAS_TIMEOUT_MS);

/**
 * Delivery tolerances. The offset chain proves every window was requested, not that it was
 * delivered, so the walk also bounds the shortfall. Measured live on 2026-10-09 (q=backend,
 * country=IN): 11 of 43 pages short by 1 to 4 jobs (the worst page held 16 of 20), 827 unique
 * jobs for a totalCount of 842 (98.2%), and totalCount moving by 1 between pages.
 * - A page that is not the last one (offset + limit < totalCount) must bring at least
 *   limit - HIMALAYAS_PAGE_SLACK new guids (15 of 20).
 * - At the end, unique guids must reach HIMALAYAS_MIN_COVERAGE of the largest totalCount seen.
 * - The final totalCount may sit at most one page (limit) below the largest one seen; a bigger
 *   fall (say a glitch answering totalCount 0) would end the walk early.
 */
export const HIMALAYAS_PAGE_SLACK = 5;
export const HIMALAYAS_MIN_COVERAGE = 0.95;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export const srcHimalayas = defineAgent(srcHimalayasContract, async (req, ctx) => {
  if (req.ats !== 'feed' || req.slug !== HIMALAYAS_FEED) return [];
  const what = `himalayas ${HIMALAYAS_FEED}`;
  const fail = (message: string): KernelError => new KernelError('invalid_output', `${what}: ${message}`);
  const all: RawPosting[] = [];
  const seen = new Set<string>();
  // Newest-first drift mid-walk: an insert pushes jobs down a page (duplicates, deduped); a removal (expiry) pulls one up, so it can be missed until the next run. Accepted.
  let expectedOffset = 0;
  let maxTotal = 0;
  for (let page = 1; ; page++) {
    const json = await getBoard(ctx, himalayasUrl(page), HIMALAYAS_FEED);
    const parsed = himalayasParse(json);
    const body = json as { jobs: unknown[]; offset?: unknown; limit?: unknown; totalCount?: unknown };
    const offset = num(body.offset);
    const limit = num(body.limit);
    const total = num(body.totalCount);
    if (offset === undefined || limit === undefined || total === undefined || limit <= 0) {
      throw fail(`page ${page} has no numeric offset, limit or totalCount`);
    }
    if (offset !== expectedOffset) throw fail(`page ${page} starts at offset ${offset}, expected ${expectedOffset}`);
    expectedOffset = offset + limit;
    maxTotal = Math.max(maxTotal, total);
    if (body.jobs.length === 0) {
      if (maxTotal - total > limit) throw fail(`totalCount fell from ${maxTotal} to ${total} during the walk`);
      if (offset < total) throw fail(`empty page ${page} at offset ${offset} before totalCount ${total}`);
      if (seen.size < maxTotal * HIMALAYAS_MIN_COVERAGE) {
        throw fail(`${seen.size} unique jobs for totalCount ${maxTotal} (minimum ${HIMALAYAS_MIN_COVERAGE * 100}%)`);
      }
      break;
    }
    if (page > HIMALAYAS_MAX_PAGES) throw capReached(what, 'page', finish(all).length);
    const guids = body.jobs.flatMap((j) => (isRecord(j) && idOf(j.guid) !== undefined ? [idOf(j.guid) as string] : []));
    const fresh = new Set(guids.filter((g) => !seen.has(g))).size;
    if (onlySeenBefore(seen, guids)) throw repeatedPage(what, page);
    if (offset + limit < total && fresh < limit - HIMALAYAS_PAGE_SLACK) {
      throw fail(`page ${page} brought ${fresh} new jobs, minimum ${limit - HIMALAYAS_PAGE_SLACK}`);
    }
    all.push(...parsed.postings);
  }
  return finish(all);
});
