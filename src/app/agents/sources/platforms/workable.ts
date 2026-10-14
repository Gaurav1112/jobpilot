import { z } from 'zod';
import type { RawPosting } from '../../../types.js';
import { feedBoard, feedProblem, httpsUrl, jsonBody, sortedNames, textOf, zodWhy, type FeedPage } from './feed-board.js';

/**
 * Workable (career-sites spec §4, Task 9): the widget API, Workable's documented public API for a company's board
 * (`GET https://apply.workable.com/api/v1/widget/accounts/<slug>?details=true`; `details=true` adds each job's
 * description, seen live for Hugging Face). A board is its account slug (the ref and the DiscoveryRequest slug, case as
 * the platform detector names it). One request returns every job (no paging). Documented API: robots.txt is not asked
 * (its `Disallow:` is empty anyway, seen live), a 401/403/429 disables the host.
 *
 * Response: `{ name, description, jobs: [...] }`; a response without `jobs` is a page-level problem. A job needs a
 * `shortcode` and a `title`, else it is skipped with a note. `raw` (normalizer mapper `workable`): `{ shortcode, title,
 * url, city, state, country, locations: [{ city, region, country, countryCode }], telecommuting, employmentType,
 * department, publishedOn, description }`; the hidden locations are dropped; `url` is the public job page
 * (`https://apply.workable.com/j/<shortcode>`). `sourceId` = the shortcode.
 */

export const WORKABLE_HOST = 'apply.workable.com';
export const WORKABLE_EGRESS = 'registry:workable-hosts';
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const parseWorkableRef = (ref: string): string | null => (SLUG.test(ref) ? ref : null);
export const workableUrl = (slug: string): string => `https://${WORKABLE_HOST}/api/v1/widget/accounts/${slug}?details=true`;

/** The board of a stored board URL (`…/api/v1/widget/accounts/<slug>`, with or without a query). */
export function workableBoardOfUrl(boardUrl: string): string | null {
  try {
    const u = new URL(boardUrl);
    if (u.protocol !== 'https:' || u.hostname !== WORKABLE_HOST || u.port !== '') return null;
    const m = /^\/api\/v1\/widget\/accounts\/([^/]+)\/?$/u.exec(u.pathname);
    return m === null ? null : parseWorkableRef(m[1] as string);
  } catch {
    return null;
  }
}

const Str = z.string().nullish();
const Job = z
  .object({
    shortcode: z.string().refine((s) => /^[A-Za-z0-9]{1,32}$/u.test(s), 'no shortcode'),
    title: z.string().refine((t) => t.trim() !== '', 'blank title'),
    url: Str,
    city: Str,
    state: Str,
    country: Str,
    telecommuting: z.boolean().nullish(),
    employment_type: Str,
    department: Str,
    published_on: Str,
    description: Str,
    locations: z.array(z.object({ city: Str, region: Str, country: Str, countryCode: Str, hidden: z.boolean().nullish() }).passthrough()).nullish(),
  })
  .passthrough();
const Envelope = z.object({ name: Str, jobs: z.array(z.unknown()) }).passthrough();

export function parseWorkable(body: string, slug: string, req: { company: string; slug: string }): FeedPage {
  const what = `workable ${slug}`;
  const env = Envelope.safeParse(jsonBody(body, what));
  if (!env.success) throw feedProblem(what, `response shape is not valid (${zodWhy(env.error)})`);
  const postings: RawPosting[] = [];
  const malformed: string[] = [];
  env.data.jobs.forEach((e, i) => {
    const j = Job.safeParse(e);
    if (!j.success) return void malformed.push(`entry ${i}: ${zodWhy(j.error)}`);
    const d = j.data;
    const raw = {
      shortcode: d.shortcode,
      title: d.title.trim(),
      url: httpsUrl(d.url) ?? `https://${WORKABLE_HOST}/j/${d.shortcode}`,
      city: textOf(d.city),
      state: textOf(d.state),
      country: textOf(d.country),
      locations: (d.locations ?? []).filter((l) => l.hidden !== true).map((l) => ({ city: textOf(l.city), region: textOf(l.region), country: textOf(l.country), countryCode: textOf(l.countryCode) })),
      telecommuting: d.telecommuting ?? null,
      employmentType: textOf(d.employment_type),
      department: textOf(d.department),
      publishedOn: textOf(d.published_on),
      description: textOf(d.description),
    };
    postings.push({ source: 'workable', sourceId: d.shortcode, company: req.company, slug: req.slug, raw });
  });
  const name = textOf(env.data.name);
  return { postings, malformed, listed: env.data.jobs.length, names: sortedNames([name]), total: null };
}

export const workable = feedBoard<string>({
  platform: 'workable',
  label: 'Workable',
  team: 'sourcing-workable',
  egress: WORKABLE_EGRESS,
  documented: true,
  fixedHost: WORKABLE_HOST,
  parseRef: parseWorkableRef,
  refOf: (s) => s,
  hostOf: () => WORKABLE_HOST,
  urlOf: workableUrl,
  boardOfUrl: workableBoardOfUrl,
  parse: (body, slug, req) => parseWorkable(body, slug, req),
});
export const srcWorkableContract = workable.contract;
export const makeSrcWorkable = workable.make;
