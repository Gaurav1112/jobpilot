import { z } from 'zod';
import type { RawPosting } from '../../../types.js';
import { feedBoard, feedProblem, httpsUrl, jsonBody, textOf, zodWhy, type FeedPage } from './feed-board.js';

/**
 * Gem (career-sites spec §4, Task 9): the Job Board API, Gem's documented public API for a company's job board
 * (`GET https://api.gem.com/job_board/v0/<slug>/job_posts/`, the reference at `api.gem.com/job_board/v0/reference`; the
 * API key it mentions is for submitting applications only). A board is its vanity path (the ref and the DiscoveryRequest
 * slug). One request returns every post (no paging). Documented API: robots.txt is not asked; `api.gem.com/robots.txt`
 * answers 403, so no robots file could be read anyway (seen live); a 401/403/429 on the API itself disables the host.
 *
 * Response: a JSON array (Greenhouse-compatible); anything else is a page-level problem. A post needs an `id`, a `title`
 * and an `absolute_url`, else it is skipped with a note. `raw` (normalizer mapper `gem`): `{ id, title, url, locations,
 * locationType, employmentType, department, firstPublishedAt, content }` (`locations` = `location.name` then each
 * office's location name; `content` the HTML). `sourceId` = the id.
 */

export const GEM_HOST = 'api.gem.com';
export const GEM_EGRESS = 'registry:gem-hosts';
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const parseGemRef = (ref: string): string | null => (SLUG.test(ref) ? ref : null);
export const gemUrl = (slug: string): string => `https://${GEM_HOST}/job_board/v0/${slug}/job_posts/`;

export function gemBoardOfUrl(boardUrl: string): string | null {
  try {
    const u = new URL(boardUrl);
    if (u.protocol !== 'https:' || u.hostname !== GEM_HOST || u.port !== '') return null;
    const m = /^\/job_board\/v0\/([^/]+)\/job_posts\/?$/u.exec(u.pathname);
    return m === null ? null : parseGemRef(m[1] as string);
  } catch {
    return null;
  }
}

const Str = z.string().nullish();
const Post = z
  .object({
    id: z.union([z.string().regex(/^\d{1,18}$/u), z.number().int().nonnegative().transform(String)]),
    title: z.string().refine((t) => t.trim() !== '', 'blank title'),
    absolute_url: z.string().refine((u) => httpsUrl(u) !== null, 'no url'),
    content: Str,
    location: z.object({ name: Str }).passthrough().nullish(),
    location_type: Str,
    employment_type: Str,
    first_published_at: Str,
    offices: z.array(z.object({ location: z.object({ name: Str }).passthrough().nullish() }).passthrough()).nullish(),
    departments: z.array(z.object({ name: Str }).passthrough()).nullish(),
  })
  .passthrough();

export function parseGem(body: string, slug: string, req: { company: string; slug: string }): FeedPage {
  const what = `gem ${slug}`;
  const json = jsonBody(body, what);
  if (!Array.isArray(json)) throw feedProblem(what, 'response shape is not valid (root: expected a list of job posts)');
  const postings: RawPosting[] = [];
  const malformed: string[] = [];
  json.forEach((e: unknown, i) => {
    const r = Post.safeParse(e);
    if (!r.success) return void malformed.push(`entry ${i}: ${zodWhy(r.error)}`);
    const d = r.data;
    const places = [textOf(d.location?.name), ...(d.offices ?? []).map((o) => textOf(o.location?.name))].filter((x): x is string => x !== null);
    const raw = {
      id: d.id,
      title: d.title.trim(),
      url: httpsUrl(d.absolute_url),
      locations: [...new Set(places)],
      locationType: textOf(d.location_type),
      employmentType: textOf(d.employment_type),
      department: textOf(d.departments?.[0]?.name),
      firstPublishedAt: textOf(d.first_published_at),
      content: textOf(d.content),
    };
    postings.push({ source: 'gem', sourceId: d.id, company: req.company, slug: req.slug, raw });
  });
  return { postings, malformed, listed: json.length, names: [], total: null };
}

export const gem = feedBoard<string>({
  platform: 'gem',
  label: 'Gem',
  team: 'sourcing-gem',
  egress: GEM_EGRESS,
  documented: true,
  fixedHost: GEM_HOST,
  parseRef: parseGemRef,
  refOf: (s) => s,
  hostOf: () => GEM_HOST,
  urlOf: gemUrl,
  boardOfUrl: gemBoardOfUrl,
  parse: (body, slug, req) => parseGem(body, slug, req),
});
export const srcGemContract = gem.contract;
export const makeSrcGem = gem.make;
