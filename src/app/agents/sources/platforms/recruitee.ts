import { z } from 'zod';
import type { RawPosting } from '../../../types.js';
import { feedBoard, feedProblem, httpsUrl, jsonBody, plainHttps, sortedNames, textOf, zodWhy, type FeedPage } from './feed-board.js';

/**
 * Recruitee (career-sites spec §4, Task 9): the Careers Site API, Recruitee's documented public API
 * (`GET https://<slug>.recruitee.com/api/offers/`). A board is its slug (a label of `recruitee.com`, the ref and the
 * DiscoveryRequest slug). One request returns every offer, description included (bunq: 21 offers, 622 KB). Documented
 * API: robots.txt is not asked (bunq's 302s to its custom domain, so a robots.txt read could never have governed the
 * API host); a 401/403/429 disables the host.
 *
 * Response: `{ offers: [...] }`; a response without `offers` is a page-level problem. An offer needs an `id` and a
 * `title`, else it is skipped with a note. `raw` (normalizer mapper `recruitee`): `{ id, title, url, location, city,
 * country, countryCode, locations: [{ name, state, country, countryCode }], remote, hybrid, onSite, publishedAt,
 * employmentType, salary: { min, max, period, currency }, department, description, requirements }`; `url` is the
 * offer's `careers_url` (the company's own careers domain). `publishedAt` is ISO (`2026-10-13 10:58:56 UTC` →
 * `2026-10-13T10:58:56Z`). The questions, translations, mailbox and photo options are dropped. `sourceId` = the id.
 */

export const RECRUITEE_EGRESS = 'registry:recruitee-hosts';
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.recruitee\.com$/u;

export const parseRecruiteeRef = (ref: string): string | null => (LABEL.test(ref) && ref !== 'www' && ref !== 'api' ? ref : null);
export const recruiteeHost = (slug: string): string => `${slug}.recruitee.com`;
export const recruiteeUrl = (slug: string): string => `https://${slug}.recruitee.com/api/offers/`;

export function recruiteeBoardOfUrl(boardUrl: string): string | null {
  const u = plainHttps(boardUrl);
  if (u === null) return null;
  const m = HOST.exec(u.hostname);
  return m === null || u.pathname.replace(/\/+$/u, '') !== '/api/offers' ? null : parseRecruiteeRef(m[1] as string);
}

const Str = z.string().nullish();
const Id = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,18}$/u)]).transform(String);
const Offer = z
  .object({
    id: Id,
    title: z.string().refine((t) => t.trim() !== '', 'blank title'),
    slug: Str,
    careers_url: Str,
    location: Str,
    city: Str,
    country: Str,
    country_code: Str,
    remote: z.boolean().nullish(),
    hybrid: z.boolean().nullish(),
    on_site: z.boolean().nullish(),
    published_at: Str,
    employment_type_code: Str,
    department: Str,
    description: Str,
    requirements: Str,
    company_name: Str,
    salary: z.object({ min: z.unknown().optional(), max: z.unknown().optional(), period: Str, currency: Str }).passthrough().nullish(),
    locations: z.array(z.object({ name: Str, state: Str, country: Str, country_code: Str }).passthrough()).nullish(),
  })
  .passthrough();
const Envelope = z.object({ offers: z.array(z.unknown()) }).passthrough();

/** `2026-10-13 10:58:56 UTC` → `2026-10-13T10:58:56Z`; anything else is kept as is when ISO-like, else null. */
function isoOf(v: string | null | undefined): string | null {
  const t = textOf(v);
  if (t === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(?:UTC|Z)?$/u.exec(t);
  return m === null ? null : `${m[1]}T${m[2]}Z`;
}

export function parseRecruitee(body: string, slug: string, req: { company: string; slug: string }): FeedPage {
  const what = `recruitee ${slug}`;
  const env = Envelope.safeParse(jsonBody(body, what));
  if (!env.success) throw feedProblem(what, `response shape is not valid (${zodWhy(env.error)})`);
  const postings: RawPosting[] = [];
  const malformed: string[] = [];
  const names: (string | null)[] = [];
  env.data.offers.forEach((e, i) => {
    const o = Offer.safeParse(e);
    if (!o.success) return void malformed.push(`entry ${i}: ${zodWhy(o.error)}`);
    const d = o.data;
    names.push(textOf(d.company_name));
    const raw = {
      id: d.id,
      title: d.title.trim(),
      url: httpsUrl(d.careers_url) ?? `https://${recruiteeHost(slug)}/o/${encodeURIComponent(textOf(d.slug) ?? d.id)}`,
      location: textOf(d.location),
      city: textOf(d.city),
      country: textOf(d.country),
      countryCode: textOf(d.country_code),
      locations: (d.locations ?? []).map((l) => ({ name: textOf(l.name), state: textOf(l.state), country: textOf(l.country), countryCode: textOf(l.country_code) })),
      remote: d.remote ?? null,
      hybrid: d.hybrid ?? null,
      onSite: d.on_site ?? null,
      publishedAt: isoOf(d.published_at),
      employmentType: textOf(d.employment_type_code),
      salary: d.salary == null ? null : { min: d.salary.min ?? null, max: d.salary.max ?? null, period: textOf(d.salary.period), currency: textOf(d.salary.currency) },
      department: textOf(d.department),
      description: textOf(d.description),
      requirements: textOf(d.requirements),
    };
    postings.push({ source: 'recruitee', sourceId: d.id, company: req.company, slug: req.slug, raw });
  });
  return { postings, malformed, listed: env.data.offers.length, names: sortedNames(names), total: null };
}

export const recruitee = feedBoard<string>({
  platform: 'recruitee',
  label: 'Recruitee',
  team: 'sourcing-recruitee',
  egress: RECRUITEE_EGRESS,
  documented: true,
  fixedHost: null,
  parseRef: parseRecruiteeRef,
  refOf: (s) => s,
  hostOf: recruiteeHost,
  urlOf: recruiteeUrl,
  boardOfUrl: recruiteeBoardOfUrl,
  parse: (body, slug, req) => parseRecruitee(body, slug, req),
});
export const srcRecruiteeContract = recruitee.contract;
export const makeSrcRecruitee = recruitee.make;
