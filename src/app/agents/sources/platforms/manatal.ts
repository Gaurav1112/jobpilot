import { z } from 'zod';
import type { RawPosting } from '../../../types.js';
import { feedBoard, feedProblem, jsonBody, plainHttps, textOf, zodWhy, type FeedPage } from './feed-board.js';

/**
 * Manatal (sources expansion, Task 4). Reference: freehire `manatal.go` @ 3957f7b (MIT), read for the shapes only.
 * A board is a career-page slug (the ref and the DiscoveryRequest slug). `GET https://open.api.manatal.com/open/v3/
 * career-page/<slug>/jobs/` answers a DRF page `{count, next, previous, results}` of 10 jobs; `next` is the following
 * page's URL (null on the last). The endpoint is the career page's own JSON, not a published developer API, so the
 * strict page rule applies: robots.txt once per host per run (seen live 2026-10-15 it answers 404: allow all).
 *
 * Many Manatal tenants are recruitment agencies with thousands of jobs (one seen: 2,010). A board is refused loudly
 * (`job-cap`, `input_rejected`) from page 1's `count` when it is over FEED_MAX_JOBS_PAGED, before page 2 is asked
 * (`feed-board.ts`); it is never truncated. `next` must stay on the board's host over https.
 *
 * `raw` (normalizer mapper `manatal`): `{ hash, title, url, description, location, remote, contract }`, with the public
 * URL `https://www.careers-page.com/<slug>/job/<hash>`. The location is `location_display`, else city, state, country.
 * The salary fields are dropped: agency boards state them inconsistently, and the scorer reads the description.
 * `organization_name` is a department (freehire's note), so no company name is taken: the slug is compared under the
 * generic-label rules. `sourceId` = the hash.
 */

export const MANATAL_HOST = 'open.api.manatal.com';
export const MANATAL_EGRESS = 'registry:manatal-hosts';
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export const parseManatalRef = (ref: string): string | null => (SLUG.test(ref) ? ref : null);
export const manatalUrl = (slug: string): string => `https://${MANATAL_HOST}/open/v3/career-page/${slug}/jobs/`;

const BOARD_PATH = /^\/open\/v3\/career-page\/([^/]+)\/jobs\/?$/u;

/** The board of a stored list URL (any `?page=` ignored); null when it is not a Manatal list URL. */
export function manatalBoardOfUrl(boardUrl: string): string | null {
  const u = plainHttps(boardUrl);
  if (u === null || u.hostname !== MANATAL_HOST) return null;
  const m = BOARD_PATH.exec(u.pathname);
  return m === null ? null : parseManatalRef((m[1] as string).toLowerCase());
}

const Job = z
  .object({
    hash: z.string({ error: 'no hash' }).regex(/^[A-Za-z0-9]{4,32}$/u, 'no hash'),
    position_name: z.string({ error: 'no title' }).refine((t) => t.trim() !== '', 'blank title'),
    description: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    country: z.string().nullish(),
    location_display: z.string().nullish(),
    is_remote: z.boolean().nullish(),
    contract_details: z.string().nullish(),
  })
  .passthrough();
const Page = z.object({ count: z.number().int().nonnegative(), next: z.string().nullable(), results: z.array(z.unknown()) }).passthrough();

export function parseManatal(body: string, slug: string, req: { company: string; slug: string }): FeedPage {
  const what = `manatal ${slug}`;
  const p = Page.safeParse(jsonBody(body, what));
  if (!p.success) throw feedProblem(what, `response shape is not valid (${zodWhy(p.error)})`);
  const postings: RawPosting[] = [];
  const malformed: string[] = [];
  const seen = new Set<string>();
  p.data.results.forEach((e: unknown, i) => {
    const r = Job.safeParse(e);
    if (!r.success) return void malformed.push(`entry ${i}: ${zodWhy(r.error)}`);
    const d = r.data;
    if (seen.has(d.hash)) return;
    seen.add(d.hash);
    const place = [textOf(d.city), textOf(d.state), textOf(d.country)].filter((x): x is string => x !== null).join(', ');
    const raw = {
      hash: d.hash,
      title: d.position_name.trim(),
      url: `https://www.careers-page.com/${slug}/job/${d.hash}`,
      description: d.description ?? null,
      location: textOf(d.location_display) ?? (place === '' ? null : place),
      remote: d.is_remote ?? null,
      contract: textOf(d.contract_details),
    };
    postings.push({ source: 'manatal', sourceId: d.hash, company: req.company, slug: req.slug, raw });
  });
  return { postings, malformed, listed: p.data.results.length, names: [], total: null };
}

const pageOf = (body: string) => Page.safeParse(jsonBody(body, 'manatal'));

export const manatal = feedBoard<string>({
  platform: 'manatal',
  label: 'Manatal',
  team: 'sourcing-manatal',
  egress: MANATAL_EGRESS,
  documented: false,
  fixedHost: MANATAL_HOST,
  parseRef: parseManatalRef,
  refOf: (s) => s,
  hostOf: () => MANATAL_HOST,
  urlOf: manatalUrl,
  boardOfUrl: manatalBoardOfUrl,
  parse: (body, slug, req) => parseManatal(body, slug, req),
  next: (body) => {
    const p = pageOf(body);
    return p.success ? p.data.next : null;
  },
  totalOf: (body) => {
    const p = pageOf(body);
    return p.success ? p.data.count : null;
  },
});
export const srcManatalContract = manatal.contract;
export const makeSrcManatal = manatal.make;
