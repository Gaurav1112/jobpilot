import { defineAgent } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { RawPosting } from '../../types.js';
import { finish, getBoard, idOf, isRecord, omit, sourceContract, type Parsed } from './common.js';

/**
 * Himalayas search API, narrowed server-side to backend roles open to India
 * (`q=backend&country=IN&sort=recent`), pages 1 to HIMALAYAS_MAX_PAGES (20 jobs a page),
 * stopping at the first empty page. `country=IN` also returns jobs restricted elsewhere, so a
 * job is kept only when `locationRestrictions` is empty (worldwide) or names India, Asia or APAC.
 *
 * There is no job id; `guid` (the job's himalayas.app URL) is the sourceId.
 * `raw` drops `expiryDate`: it moved between two fetches of the same job on 2026-10-09, so it is
 * request-time, not content. `pubDate` stays (it is epoch seconds, not ms; the normaliser converts).
 * The envelope (`comments`, `updatedAt`, `offset`, `limit`, `totalCount`) is dropped.
 */
export const HIMALAYAS_HOST = 'himalayas.app';
export const HIMALAYAS_FEED = 'himalayas';
export const HIMALAYAS_MAX_PAGES = 3;
const DROPPED = ['expiryDate'] as const;

export const himalayasUrl = (page: number): string =>
  `https://${HIMALAYAS_HOST}/jobs/api/search?q=backend&country=IN&sort=recent&page=${page}`;

const ELIGIBLE = /^(india|asia|apac|asia[- ]pacific)$/i;

/** Live restrictions are country-name strings; the docs say `{alpha2, name, slug}` objects. Both are accepted. */
export function indiaEligible(restrictions: readonly unknown[]): boolean {
  if (restrictions.length === 0) return true;
  return restrictions.some((r) => {
    if (typeof r === 'string') return ELIGIBLE.test(r.trim());
    if (isRecord(r)) return r.alpha2 === 'IN' || (typeof r.name === 'string' && ELIGIBLE.test(r.name.trim()));
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
  return { postings, skipped };
}

export const srcHimalayasContract = sourceContract('src-himalayas', HIMALAYAS_HOST, 'Fetches India-eligible backend jobs from the Himalayas feed');

export const srcHimalayas = defineAgent(srcHimalayasContract, async (req, ctx) => {
  if (req.ats !== 'feed' || req.slug !== HIMALAYAS_FEED) return [];
  const all: RawPosting[] = [];
  for (let page = 1; page <= HIMALAYAS_MAX_PAGES; page++) {
    const json = await getBoard(ctx, himalayasUrl(page), HIMALAYAS_FEED);
    if (isRecord(json) && Array.isArray(json.jobs) && json.jobs.length === 0) break;
    all.push(...himalayasParse(json).postings);
  }
  return finish(all);
});
