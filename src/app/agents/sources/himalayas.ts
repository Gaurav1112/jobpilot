import { defineAgent } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { RawPosting } from '../../types.js';
import { DEFAULT_RESIDENCE, type ResidenceScope } from '../../geo/residence.js';
import { checkParsed, reportSkips, finish, getBoard, idOf, isRecord, omit, sourceContract, type Parsed } from './common.js';
import { exactCountryRe, residenceOfCode } from './platforms/shared.js';

/**
 * Himalayas search API, `q=backend&country=IN&sort=recent`, **page 1 only** (the API's 20 newest). There is
 * deliberately no `employment_type` filter: eligibility (spec §5.2) decides employment type, and a server-side
 * "Full Time" filter dropped "Other" and "Part Time" jobs it would keep.
 *
 * Why page 1 only (controller decision 2026-10-15, user rule "no scraping against robots.txt"): Himalayas serves its
 * robots.txt with HTTP 404 but a full body, and that body says `Disallow: /jobs*&page=` (read 2026-10-14). RFC 9309
 * would treat a 404 as "allow all"; jobpilot honours the body's intent instead. So the request carries no `page`
 * parameter at all (even `&page=1` matches the rule) and nothing pages. When the envelope's `totalCount` says more
 * jobs exist, the step records the loud note `himalayas: N more not read (page 1 only: robots.txt disallows paging
 * under /jobs)`, never a silent truncation. The run is twice a day and newest-first, so new jobs still arrive.
 * (Before 2026-10-15 the source walked every page against the offset chain; that walk is gone.)
 *
 * The response must carry a `jobs` array (else `invalid_output`); a missing or non-numeric `totalCount` is tolerated
 * (no note). `country=IN` also returns jobs restricted elsewhere, so a job is kept only when `locationRestrictions` is
 * empty (worldwide) or names India, Asia, APAC, Worldwide or Anywhere.
 *
 * Profiles Task 15: the residence comes from the seed (`DiscoveryRequest.residence`, absent: India). For another
 * residence the request asks `country=<its ISO code>` (the API takes ISO alpha-2, per its OpenAPI document) and a job is
 * kept by `residenceEligible`: an empty list, the country's code or any of its whole-country names, its regions,
 * worldwide or anywhere, or a region's spellings (`asia pacific` for apac). India's request and rule are unchanged.
 *
 * There is no job id; `guid` (the job's himalayas.app URL) is the sourceId.
 * `raw` drops `expiryDate`: it moved between two fetches of the same job on 2026-10-09, so it is
 * request-time, not content. `pubDate` stays (it is epoch seconds, not ms; the normaliser converts).
 * The envelope (`comments`, `updatedAt`, `offset`, `limit`, `totalCount`) is dropped.
 */
export const HIMALAYAS_HOST = 'himalayas.app';
export const HIMALAYAS_FEED = 'himalayas';
/** One request per run: page 1 only (see above). Kept as a constant for the pacing arithmetic (`pipeline.ts`). */
export const HIMALAYAS_MAX_PAGES = 1;
export const HIMALAYAS_TIMEOUT_MS = 720_000;
const DROPPED = ['expiryDate'] as const;

/** No `page` parameter: Himalayas' robots.txt body disallows `/jobs*&page=`. */
export const himalayasUrl = (scope: ResidenceScope = DEFAULT_RESIDENCE): string => `https://${HIMALAYAS_HOST}/jobs/api/search?q=backend&country=${scope.code}&sort=recent`;

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

/** A restriction's name names the residence: a whole-country name, a region with it (worldwide too), or a region's spelling. */
function namesScope(name: string, scope: ResidenceScope): boolean {
  const n = name.trim().toLowerCase();
  if (n === 'anywhere' || n === scope.display.toLowerCase() || n === scope.country || scope.regions.has(n) || exactCountryRe(scope).test(n)) return true;
  return [...scope.regions].some((r) => (scope.table.places[r] ?? []).includes(n));
}

/**
 * Whether a job's `locationRestrictions` admit the residence: empty (worldwide), or one restriction names it (see
 * `namesScope`; an object restriction by its `alpha2` code too). For India it is exactly `indiaEligible`'s rule.
 */
export function residenceEligible(restrictions: readonly unknown[], scope: ResidenceScope): boolean {
  if (scope.isDefault) return indiaEligible(restrictions);
  if (restrictions.length === 0) return true;
  return restrictions.some((r) => {
    if (typeof r === 'string') return namesScope(r, scope);
    if (isRecord(r)) return (typeof r.alpha2 === 'string' && r.alpha2.toUpperCase() === scope.code) || (typeof r.name === 'string' && namesScope(r.name, scope));
    return false;
  });
}

export function himalayasParse(json: unknown, scope: ResidenceScope = DEFAULT_RESIDENCE): Parsed {
  if (!isRecord(json) || !Array.isArray(json.jobs)) throw new KernelError('invalid_output', 'himalayas: no jobs array');
  const postings: RawPosting[] = [];
  const skipped: string[] = [];
  json.jobs.forEach((job: unknown, i: number) => {
    const id = isRecord(job) ? idOf(job.guid) : undefined;
    if (!isRecord(job) || id === undefined || typeof job.title !== 'string' || typeof job.companyName !== 'string' || !Array.isArray(job.locationRestrictions)) {
      skipped.push(`himalayas job ${i}: missing guid, title, companyName or locationRestrictions`);
      return;
    }
    if (!residenceEligible(job.locationRestrictions, scope)) return;
    postings.push({ source: 'himalayas', sourceId: id, company: job.companyName, slug: HIMALAYAS_FEED, raw: omit(job, DROPPED) });
  });
  return checkParsed('himalayas', json.jobs.length, { postings, skipped });
}

export const srcHimalayasContract = sourceContract('src-himalayas', HIMALAYAS_HOST, 'Fetches backend jobs open to the residence (default India) from the Himalayas feed', HIMALAYAS_TIMEOUT_MS);

export const srcHimalayas = defineAgent(srcHimalayasContract, async (req, ctx) => {
  if (req.ats !== 'feed' || req.slug !== HIMALAYAS_FEED) return [];
  const scope = residenceOfCode(req.residence, 'src-himalayas');
  const json = await getBoard(ctx, himalayasUrl(scope), HIMALAYAS_FEED);
  const parsed = reportSkips(ctx, himalayasParse(json, scope));
  const body = json as { jobs: unknown[]; totalCount?: unknown };
  const total = typeof body.totalCount === 'number' && Number.isFinite(body.totalCount) ? body.totalCount : null;
  if (total !== null && total > body.jobs.length) ctx.skipped([`himalayas: ${total - body.jobs.length} more not read (page 1 only: robots.txt disallows paging under /jobs)`]);
  return finish(parsed.postings);
});
