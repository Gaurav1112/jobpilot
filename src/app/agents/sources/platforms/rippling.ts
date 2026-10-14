import { z } from 'zod';
import type { RawPosting } from '../../../types.js';
import { feedBoard, feedProblem, httpsUrl, jsonBody, textOf, zodWhy, type FeedPage } from './feed-board.js';

/**
 * Rippling ATS (career-sites spec §4, Task 9): the board JSON the public page itself calls,
 * `GET https://api.rippling.com/platform/api/ats/v1/board/<slug>/jobs`. Not a documented public API, so the strict page
 * rule applies: robots.txt of `api.rippling.com` once per run (seen live it answers 404, which allows all; the page host
 * `ats.rippling.com` only disallows `/internal/`). A board is its slug (the ref and the DiscoveryRequest slug, case as
 * the detector names it). One request returns every job (no paging; 608 for Rippling itself). The list carries no
 * description or date (the detail does; the adapter does not fetch it: the controller's scope decision), so
 * eligibility judges the title, department and location label.
 *
 * Response: a JSON array; anything else is a page-level problem. An entry needs a `uuid`, a `name` and a `url`, else it
 * is skipped with a note. `raw` (normalizer mapper `rippling`): `{ uuid, title, url, department, location }` (the
 * `workLocation.label`, which can be a state code or a city: "AR", "Louisville, KY", "Remote (Dallas, Texas, US)"; a
 * country is never invented from it). `sourceId` = the uuid.
 */

export const RIPPLING_HOST = 'api.rippling.com';
export const RIPPLING_EGRESS = 'registry:rippling-hosts';
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const parseRipplingRef = (ref: string): string | null => (SLUG.test(ref) ? ref : null);
export const ripplingUrl = (slug: string): string => `https://${RIPPLING_HOST}/platform/api/ats/v1/board/${slug}/jobs`;

export function ripplingBoardOfUrl(boardUrl: string): string | null {
  try {
    const u = new URL(boardUrl);
    if (u.protocol !== 'https:' || u.hostname !== RIPPLING_HOST || u.port !== '') return null;
    const m = /^\/platform\/api\/ats\/v1\/board\/([^/]+)\/jobs\/?$/u.exec(u.pathname);
    return m === null ? null : parseRipplingRef(m[1] as string);
  } catch {
    return null;
  }
}

const Str = z.string().nullish();
const Entry = z
  .object({
    uuid: z.string().regex(/^[A-Za-z0-9-]{8,64}$/u, 'no uuid'),
    name: z.string().refine((t) => t.trim() !== '', 'blank title'),
    url: z.string().refine((u) => httpsUrl(u) !== null, 'no url'),
    department: z.object({ label: Str }).passthrough().nullish(),
    workLocation: z.object({ label: Str }).passthrough().nullish(),
  })
  .passthrough();

export function parseRippling(body: string, slug: string, req: { company: string; slug: string }): FeedPage {
  const what = `rippling ${slug}`;
  const json = jsonBody(body, what);
  if (!Array.isArray(json)) throw feedProblem(what, 'response shape is not valid (root: expected a list of jobs)');
  const postings: RawPosting[] = [];
  const malformed: string[] = [];
  json.forEach((e: unknown, i) => {
    const r = Entry.safeParse(e);
    if (!r.success) return void malformed.push(`entry ${i}: ${zodWhy(r.error)}`);
    const d = r.data;
    const raw = { uuid: d.uuid, title: d.name.trim(), url: httpsUrl(d.url), department: textOf(d.department?.label), location: textOf(d.workLocation?.label) };
    postings.push({ source: 'rippling', sourceId: d.uuid, company: req.company, slug: req.slug, raw });
  });
  return { postings, malformed, listed: json.length, names: [], total: null };
}

export const rippling = feedBoard<string>({
  platform: 'rippling',
  label: 'Rippling',
  team: 'sourcing-rippling',
  egress: RIPPLING_EGRESS,
  documented: false,
  fixedHost: RIPPLING_HOST,
  parseRef: parseRipplingRef,
  refOf: (s) => s,
  hostOf: () => RIPPLING_HOST,
  urlOf: ripplingUrl,
  boardOfUrl: ripplingBoardOfUrl,
  parse: (body, slug, req) => parseRippling(body, slug, req),
});
export const srcRipplingContract = rippling.contract;
export const makeSrcRippling = rippling.make;
