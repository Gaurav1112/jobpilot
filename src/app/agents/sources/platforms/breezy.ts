import { z } from 'zod';
import type { RawPosting } from '../../../types.js';
import { feedBoard, feedProblem, httpsUrl, jsonBody, sortedNames, textOf, zodWhy, type FeedPage } from './feed-board.js';

/**
 * Breezy HR (career-sites spec §4, Task 9): the portal's JSON list, `GET https://<slug>.breezy.hr/json`. Not a documented
 * public API, so the strict page rule applies (robots.txt once per host per run; seen live it blocks only css/js paths
 * and one bot). A board is its slug (a label of `breezy.hr`, the ref and the DiscoveryRequest slug). One request
 * returns every position (no paging). The list has no description (the job page has JSON-LD; the adapter does not fetch
 * it: the controller's scope decision), so eligibility judges the title, department and location.
 *
 * Response: a JSON array; anything else is a page-level problem. An entry needs an `id`, a `name` and a `url`, else it
 * is skipped with a note. `raw` (normalizer mapper `breezy`): `{ id, title, url, publishedDate, type, department,
 * locations: [{ name, city, state, country, countryCode, isRemote }] }`: the entry's `locations` when it has any, else its
 * `location`; the salary string is dropped. `sourceId` = the id. The company's `company.name` is the verifier's name.
 */

export const BREEZY_EGRESS = 'registry:breezy-hosts';
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.breezy\.hr$/u;

export const parseBreezyRef = (ref: string): string | null => (LABEL.test(ref) && ref !== 'www' && ref !== 'api' ? ref : null);
export const breezyHost = (slug: string): string => `${slug}.breezy.hr`;
export const breezyUrl = (slug: string): string => `https://${slug}.breezy.hr/json`;

export function breezyBoardOfUrl(boardUrl: string): string | null {
  try {
    const u = new URL(boardUrl);
    if (u.protocol !== 'https:' || u.port !== '') return null;
    const m = HOST.exec(u.hostname);
    return m === null || u.pathname !== '/json' ? null : parseBreezyRef(m[1] as string);
  } catch {
    return null;
  }
}

const Str = z.string().nullish();
const Loc = z
  .object({
    name: Str,
    city: Str,
    is_remote: z.boolean().nullish(),
    country: z.object({ name: Str, id: Str }).passthrough().nullish(),
    state: z.object({ name: Str, id: Str }).passthrough().nullish(),
  })
  .passthrough();
const Entry = z
  .object({
    id: z.string().min(1, 'no id'),
    name: z.string().refine((t) => t.trim() !== '', 'blank title'),
    url: z.string().refine((u) => httpsUrl(u) !== null, 'no url'),
    published_date: Str,
    type: z.object({ name: Str }).passthrough().nullish(),
    department: Str,
    location: Loc.nullish(),
    locations: z.array(Loc).nullish(),
    company: z.object({ name: Str }).passthrough().nullish(),
  })
  .passthrough();

const locOf = (l: z.infer<typeof Loc>) => ({ name: textOf(l.name), city: textOf(l.city), state: textOf(l.state?.name), country: textOf(l.country?.name), countryCode: textOf(l.country?.id), isRemote: l.is_remote ?? null });

export function parseBreezy(body: string, slug: string, req: { company: string; slug: string }): FeedPage {
  const what = `breezy ${slug}`;
  const json = jsonBody(body, what);
  if (!Array.isArray(json)) throw feedProblem(what, 'response shape is not valid (root: expected a list of positions)');
  const postings: RawPosting[] = [];
  const malformed: string[] = [];
  const names: (string | null)[] = [];
  json.forEach((e: unknown, i) => {
    const r = Entry.safeParse(e);
    if (!r.success) return void malformed.push(`entry ${i}: ${zodWhy(r.error)}`);
    const d = r.data;
    names.push(textOf(d.company?.name));
    const locs = (d.locations ?? []).length > 0 ? (d.locations ?? []).map(locOf) : d.location == null ? [] : [locOf(d.location)];
    const raw = { id: d.id, title: d.name.trim(), url: httpsUrl(d.url), publishedDate: textOf(d.published_date), type: textOf(d.type?.name), department: textOf(d.department), locations: locs };
    postings.push({ source: 'breezy', sourceId: d.id, company: req.company, slug: req.slug, raw });
  });
  return { postings, malformed, listed: json.length, names: sortedNames(names), total: null };
}

export const breezy = feedBoard<string>({
  platform: 'breezy',
  label: 'Breezy',
  team: 'sourcing-breezy',
  egress: BREEZY_EGRESS,
  documented: false,
  fixedHost: null,
  parseRef: parseBreezyRef,
  refOf: (s) => s,
  hostOf: breezyHost,
  urlOf: breezyUrl,
  boardOfUrl: breezyBoardOfUrl,
  parse: (body, slug, req) => parseBreezy(body, slug, req),
});
export const srcBreezyContract = breezy.contract;
export const makeSrcBreezy = breezy.make;
