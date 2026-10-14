import { z } from 'zod';
import type { RawPosting } from '../../../types.js';
import { feedBoard, feedProblem, jsonBody, plainHttps, textOf, zodWhy, type FeedPage } from './feed-board.js';

/**
 * BambooHR (career-sites spec §4, Task 9): the careers page's own list, `GET https://<slug>.bamboohr.com/careers/list`
 * (JSON). BambooHR's official API needs a key, so this endpoint is not a documented public API and the strict page
 * rule applies (robots.txt once per host per run; seen live it disallows only `/jobs/embed*.php`). A board is its slug
 * (a label of `bamboohr.com`, the ref and the DiscoveryRequest slug); an unknown slug answers 302 to bamboohr.com, which
 * is `input_rejected` (a redirect is never followed). One request returns every job (no paging; `meta.totalCount`).
 *
 * The list carries no description, date or URL. The adapter does not fetch the detail (the controller's scope
 * decision): eligibility judges the title, department and location. `url` = `https://<slug>.bamboohr.com/careers/<id>`,
 * the job's public page. Response: `{ meta: { totalCount }, result: [...] }`; without `result` it is a page-level
 * problem. An entry needs an `id` and a `jobOpeningName`, else it is skipped with a note. A `totalCount` above the
 * entries listed is the note `short-list`. `raw` (normalizer mapper `bamboohr`): `{ id, title, url, department,
 * employmentStatus, city, state, country, isRemote }` (`atsLocation` first, the legacy `location` for the city and
 * state it lacks; `locationType`, whose codes the list does not explain, is dropped). `sourceId` = `<slug>:<id>`: BambooHR
 * ids are small numbers counted per company.
 */

export const BAMBOOHR_EGRESS = 'registry:bamboohr-hosts';
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.bamboohr\.com$/u;

export const parseBambooRef = (ref: string): string | null => (LABEL.test(ref) && ref !== 'www' && ref !== 'api' ? ref : null);
export const bambooHost = (slug: string): string => `${slug}.bamboohr.com`;
export const bambooUrl = (slug: string): string => `https://${slug}.bamboohr.com/careers/list`;

export function bambooBoardOfUrl(boardUrl: string): string | null {
  const u = plainHttps(boardUrl);
  if (u === null) return null;
  const m = HOST.exec(u.hostname);
  return m === null || u.pathname !== '/careers/list' ? null : parseBambooRef(m[1] as string);
}

const Str = z.string().nullish();
const Entry = z
  .object({
    id: z.union([z.string().regex(/^\d{1,12}$/u), z.number().int().nonnegative().transform(String)]),
    jobOpeningName: z.string().refine((t) => t.trim() !== '', 'blank title'),
    departmentLabel: Str,
    employmentStatusLabel: Str,
    isRemote: z.boolean().nullish(),
    atsLocation: z.object({ country: Str, state: Str, province: Str, city: Str }).passthrough().nullish(),
    location: z.object({ city: Str, state: Str }).passthrough().nullish(),
  })
  .passthrough();
const Envelope = z.object({ meta: z.object({ totalCount: z.number().int().nonnegative().nullish() }).passthrough().nullish(), result: z.array(z.unknown()) }).passthrough();

export function parseBamboo(body: string, slug: string, req: { company: string; slug: string }): FeedPage {
  const what = `bamboohr ${slug}`;
  const env = Envelope.safeParse(jsonBody(body, what));
  if (!env.success) throw feedProblem(what, `response shape is not valid (${zodWhy(env.error)})`);
  const postings: RawPosting[] = [];
  const malformed: string[] = [];
  env.data.result.forEach((e, i) => {
    const r = Entry.safeParse(e);
    if (!r.success) return void malformed.push(`entry ${i}: ${zodWhy(r.error)}`);
    const d = r.data;
    const raw = {
      id: d.id,
      title: d.jobOpeningName.trim(),
      url: `https://${bambooHost(slug)}/careers/${d.id}`,
      department: textOf(d.departmentLabel),
      employmentStatus: textOf(d.employmentStatusLabel),
      city: textOf(d.atsLocation?.city) ?? textOf(d.location?.city),
      state: textOf(d.atsLocation?.state) ?? textOf(d.atsLocation?.province) ?? textOf(d.location?.state),
      country: textOf(d.atsLocation?.country),
      isRemote: d.isRemote ?? null,
    };
    postings.push({ source: 'bamboohr', sourceId: `${slug}:${d.id}`, company: req.company, slug: req.slug, raw });
  });
  return { postings, malformed, listed: env.data.result.length, names: [], total: env.data.meta?.totalCount ?? null };
}

export const bamboohr = feedBoard<string>({
  platform: 'bamboohr',
  label: 'BambooHR',
  team: 'sourcing-bamboohr',
  egress: BAMBOOHR_EGRESS,
  documented: false,
  fixedHost: null,
  parseRef: parseBambooRef,
  refOf: (s) => s,
  hostOf: bambooHost,
  urlOf: bambooUrl,
  boardOfUrl: bambooBoardOfUrl,
  parse: (body, slug, req) => parseBamboo(body, slug, req),
});
export const srcBamboohrContract = bamboohr.contract;
export const makeSrcBamboohr = bamboohr.make;
