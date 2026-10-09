import { defineAgent } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { DiscoveryRequest, RawPosting } from '../../types.js';
import { checkParsed, finish, getBoard, idOf, isRecord, omit, sourceContract, type Parsed } from './common.js';

/**
 * Lever Postings API: a top-level array. A big board unpaged (veeva: 937 postings, 13 MB) comes
 * close to the broker's 16 MiB cap, so the list is paged with `skip`/`limit` (LEVER_PAGE_SIZE per page, at most
 * LEVER_MAX_PAGES pages, so at most 2000 postings), stopping at the first short page. A live page
 * took up to 7.7 s, and pages share the 1 s host pacer, so the step timeout (LEVER_TIMEOUT_MS)
 * allows 9 s per page at the cap. A failed page fails the whole step;
 * the GETs are idempotent, so a retry re-fetches every page.
 * `raw` is the posting unchanged, except a `salaryRange` whose min and max are both 0 is
 * dropped (Lever's placeholder for "no salary"). Live postings carry no request-time fields.
 */
export const LEVER_HOST = 'api.lever.co';
export const LEVER_PAGE_SIZE = 100;
export const LEVER_MAX_PAGES = 20;
export const LEVER_TIMEOUT_MS = 180_000;

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
  const all: RawPosting[] = [];
  for (let page = 0; page < LEVER_MAX_PAGES; page++) {
    const json = await getBoard(ctx, leverUrl(req.slug, page * LEVER_PAGE_SIZE), req.slug);
    all.push(...leverParse(json, req).postings);
    if (!Array.isArray(json) || json.length < LEVER_PAGE_SIZE) break;
  }
  return finish(all);
});
