import { z } from 'zod';
import type { RawPosting } from '../../../types.js';
import { feedBoard, feedProblem, httpsUrl, jsonBody, plainHttps, textOf, zodWhy, type FeedPage } from './feed-board.js';

/**
 * Pinpoint (career-sites spec §4, Task 9): the documented JSON feed for custom career sites,
 * `GET https://<slug>.pinpointhq.com/postings.json`. A board is its slug (a label of `pinpointhq.com`, the ref and the
 * DiscoveryRequest slug). One request returns every posting, description included (no paging). Documented API:
 * robots.txt is not asked (it disallows `/mydata /admin /companies`, none of them the feed); a 401/403/429 disables
 * the host. The list has no posted date.
 *
 * Response: `{ data: [...] }`; without `data` it is a page-level problem. A posting needs an `id`, a `title` and a
 * `url`, else it is skipped with a note. `raw` (normalizer mapper `pinpoint`): `{ id, title, url, locationName, city,
 * province, workplaceType, employmentType, department, deadlineAt, compensation: { min, max, currency, frequency } |
 * null, description }`; `description` is the intro, the responsibilities and the skills sections (their headers as
 * `<h3>`), the benefits dropped; `compensation` only when the posting shows it (`compensation_visible`). `sourceId` =
 * the id.
 */

export const PINPOINT_EGRESS = 'registry:pinpoint-hosts';
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.pinpointhq\.com$/u;

export const parsePinpointRef = (ref: string): string | null => (LABEL.test(ref) && ref !== 'www' && ref !== 'api' ? ref : null);
export const pinpointHost = (slug: string): string => `${slug}.pinpointhq.com`;
export const pinpointUrl = (slug: string): string => `https://${slug}.pinpointhq.com/postings.json`;

export function pinpointBoardOfUrl(boardUrl: string): string | null {
  const u = plainHttps(boardUrl);
  if (u === null) return null;
  const m = HOST.exec(u.hostname);
  return m === null || u.pathname !== '/postings.json' ? null : parsePinpointRef(m[1] as string);
}

const Str = z.string().nullish();
const Posting = z
  .object({
    id: z.union([z.string().regex(/^\d{1,18}$/u), z.number().int().nonnegative().transform(String)]),
    title: z.string().refine((t) => t.trim() !== '', 'blank title'),
    url: z.string().refine((u) => httpsUrl(u) !== null, 'no url'),
    description: Str,
    key_responsibilities: Str,
    key_responsibilities_header: Str,
    skills_knowledge_expertise: Str,
    skills_knowledge_expertise_header: Str,
    workplace_type: Str,
    employment_type_text: Str,
    deadline_at: Str,
    compensation_visible: z.boolean().nullish(),
    compensation_minimum: z.unknown().optional(),
    compensation_maximum: z.unknown().optional(),
    compensation_currency: Str,
    compensation_frequency: Str,
    location: z.object({ name: Str, city: Str, province: Str }).passthrough().nullish(),
    job: z.object({ department: z.object({ name: Str }).passthrough().nullish() }).passthrough().nullish(),
  })
  .passthrough();
const Envelope = z.object({ data: z.array(z.unknown()) }).passthrough();

const section = (header: string | null, html: string | null): string | null => (html === null ? null : header === null ? html : `<h3>${header.replace(/[<>&]/gu, '')}</h3>${html}`);

export function parsePinpoint(body: string, slug: string, req: { company: string; slug: string }): FeedPage {
  const what = `pinpoint ${slug}`;
  const env = Envelope.safeParse(jsonBody(body, what));
  if (!env.success) throw feedProblem(what, `response shape is not valid (${zodWhy(env.error)})`);
  const postings: RawPosting[] = [];
  const malformed: string[] = [];
  env.data.data.forEach((e, i) => {
    const r = Posting.safeParse(e);
    if (!r.success) return void malformed.push(`entry ${i}: ${zodWhy(r.error)}`);
    const d = r.data;
    const description = [textOf(d.description), section(textOf(d.key_responsibilities_header), textOf(d.key_responsibilities)), section(textOf(d.skills_knowledge_expertise_header), textOf(d.skills_knowledge_expertise))].filter((x): x is string => x !== null);
    const raw = {
      id: d.id,
      title: d.title.trim(),
      url: httpsUrl(d.url),
      locationName: textOf(d.location?.name),
      city: textOf(d.location?.city),
      province: textOf(d.location?.province),
      workplaceType: textOf(d.workplace_type),
      employmentType: textOf(d.employment_type_text),
      department: textOf(d.job?.department?.name),
      deadlineAt: textOf(d.deadline_at),
      compensation: d.compensation_visible === true ? { min: d.compensation_minimum ?? null, max: d.compensation_maximum ?? null, currency: textOf(d.compensation_currency), frequency: textOf(d.compensation_frequency) } : null,
      description: description.length > 0 ? description.join('\n') : null,
    };
    postings.push({ source: 'pinpoint', sourceId: d.id, company: req.company, slug: req.slug, raw });
  });
  return { postings, malformed, listed: env.data.data.length, names: [], total: null };
}

export const pinpoint = feedBoard<string>({
  platform: 'pinpoint',
  label: 'Pinpoint',
  team: 'sourcing-pinpoint',
  egress: PINPOINT_EGRESS,
  documented: true,
  fixedHost: null,
  parseRef: parsePinpointRef,
  refOf: (s) => s,
  hostOf: pinpointHost,
  urlOf: pinpointUrl,
  boardOfUrl: pinpointBoardOfUrl,
  parse: (body, slug, req) => parsePinpoint(body, slug, req),
});
export const srcPinpointContract = pinpoint.contract;
export const makeSrcPinpoint = pinpoint.make;
