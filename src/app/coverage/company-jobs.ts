import { boardRefOf, splitPostingSourceId } from '../text/norm.js';
import { normalCompanyName } from './names.js';
import { registrableDomain } from './seed.js';

/**
 * Which stored jobs belong to one registry company (career-sites Task 11 fix round 1), for the Companies tab's counts
 * and its links to the jobs list. Keyed by the company, never by the name shown (which may be hidden or a domain label):
 * a job is the company's when ANY of these holds
 * - its URL is on the company's registrable domain (`company_key`), e.g. a careers-site job;
 * - it came from the company's daily registry board (same platform, same board ref in its tenant-scoped source id);
 * - its company name equals the registry name after `normalCompanyName` (a job from another source, e.g. a feed).
 */
export interface CompanyJobs {
  readonly key: string;
  readonly name: string;
  /** The company's daily registry board (`registryBoardOf`), or null. */
  readonly board: { readonly platform: string; readonly ref: string } | null;
}

export interface JobKeys {
  readonly norm: string;
  readonly domain: string | null;
  /** `<platform> <board ref>` of a tenant-scoped job, or null. */
  readonly board: string | null;
}

/** What a job is matched on. */
export function jobKeys(j: { readonly company: string; readonly url: string; readonly source: string; readonly sourceId: string }): JobKeys {
  let domain: string | null = null;
  try {
    domain = registrableDomain(new URL(j.url).hostname);
  } catch {
    domain = null;
  }
  const split = splitPostingSourceId(j.source, j.sourceId);
  return { norm: normalCompanyName(j.company), domain, board: split === null ? null : `${j.source} ${split.board}` };
}

/** The same three keys on the company's side. */
export function companyKeys(c: CompanyJobs): JobKeys {
  return { norm: normalCompanyName(c.name), domain: c.key, board: c.board === null ? null : `${c.board.platform} ${boardRefOf(c.board.ref)}` };
}

export function jobOfCompany(j: JobKeys, c: JobKeys): boolean {
  return (c.domain !== null && j.domain === c.domain) || (c.board !== null && j.board === c.board) || (c.norm !== '' && j.norm === c.norm);
}
