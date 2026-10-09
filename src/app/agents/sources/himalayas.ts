import { defineAgent } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { RawPosting } from '../../types.js';
import { capReached, checkParsed, finish, getBoard, idOf, isRecord, omit, pageSignature, repeatedPage, sourceContract, type Parsed } from './common.js';

/**
 * Himalayas search API, narrowed server-side to full-time backend roles open to India:
 * `q=backend&country=IN&employment_type=Full Time&sort=recent`. Full-time only matches the
 * spec (eligibility rejects contract, intern and temporary roles), and it cut the live result set
 * from 843 to 711 on 2026-10-09. Pages (20 jobs each) are fetched from 1 until the natural end:
 * the first EMPTY page (a short page is not the end: live pages hold 16 to 20 jobs mid-list).
 * Nothing is truncated quietly:
 * - HIMALAYAS_MAX_PAGES (1,000 jobs) is a safety cap; reaching it before the natural end is
 *   `invalid_output` ('himalayas himalayas: page cap reached at N postings');
 * - a page with the same length, first guid and last guid as the one before is `invalid_output`.
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
/** The live natural end on 2026-10-09 was page 37 (711 jobs); 50 pages allow 1,000. */
export const HIMALAYAS_MAX_PAGES = 50;
export const HIMALAYAS_TIMEOUT_MS = 450_000;
const DROPPED = ['expiryDate'] as const;

export const himalayasUrl = (page: number): string =>
  `https://${HIMALAYAS_HOST}/jobs/api/search?q=backend&country=IN&employment_type=Full%20Time&sort=recent&page=${page}`;

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

export const srcHimalayas = defineAgent(srcHimalayasContract, async (req, ctx) => {
  if (req.ats !== 'feed' || req.slug !== HIMALAYAS_FEED) return [];
  const what = `himalayas ${HIMALAYAS_FEED}`;
  const all: RawPosting[] = [];
  let previous: string | undefined;
  for (let page = 1; ; page++) {
    if (page > HIMALAYAS_MAX_PAGES) throw capReached(what, 'page', finish(all).length);
    const json = await getBoard(ctx, himalayasUrl(page), HIMALAYAS_FEED);
    const parsed = himalayasParse(json);
    const jobs = (json as { jobs: unknown[] }).jobs;
    if (jobs.length === 0) break;
    const signature = pageSignature(jobs, 'guid');
    if (signature === previous) throw repeatedPage(what, page);
    previous = signature;
    all.push(...parsed.postings);
  }
  return finish(all);
});
