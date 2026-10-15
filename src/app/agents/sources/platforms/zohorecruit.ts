import { z } from 'zod';
import { decodeEntities } from '../../../text/html.js';
import type { RawPosting } from '../../../types.js';
import { feedBoard, feedProblem, jsonBody, plainHttps, textOf, zodWhy, type FeedPage } from './feed-board.js';

/**
 * Zoho Recruit (sources expansion, Task 3). Reference: freehire `zoho.go` @ 3957f7b (MIT), read for the page shape only.
 * A board is its careers host, `<label>.zohorecruit.<region TLD>` (the ref and the DiscoveryRequest slug). One request,
 * `GET https://<host>/jobs/Careers`, returns the careers page, which embeds EVERY opening as HTML-escaped JSON in
 * `<input id="jobs" value="…">` (seen live 2026-10-15: 21 openings, a 1.8 MB page). Not a documented API, so the strict
 * page rule applies: robots.txt once per host per run (seen live it allows `/jobs`, `/jobs/` and `/jobs/*` and ends
 * `Disallow: /`, so the longest matching rule decides).
 *
 * The embedded records carry no description, and the adapter does NOT fetch detail pages (freehire's description comes
 * from a JS-escaped blob; the Breezy and Rippling precedent): eligibility judges the title, the location, the remote
 * flag and the job type. The records carry no company name either, so the verifier compares the host's first label.
 * An opening needs an `id` (6-24 digits) and a `Posting_Title`, else it is skipped with a note; `Publish: false` is not
 * on the career site, so not an open job (skipped silently, not malformed). `raw` (normalizer mapper `zohorecruit`):
 * `{ id, title, url, city, state, country, remote, jobType }`. `sourceId` = the id.
 */

export const ZOHO_EGRESS = 'registry:zohorecruit-hosts';
const HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.zohorecruit\.(?:com|in|eu|com\.au)$/u;

export const parseZohoRef = (ref: string): string | null => (HOST.test(ref) && !ref.startsWith('www.') ? ref : null);
export const zohoUrl = (host: string): string => `https://${host}/jobs/Careers`;

export function zohoBoardOfUrl(boardUrl: string): string | null {
  const u = plainHttps(boardUrl);
  return u === null || u.pathname.replace(/\/$/u, '') !== '/jobs/Careers' ? null : parseZohoRef(u.hostname.toLowerCase());
}

const Opening = z
  .object({
    id: z.string({ error: 'no id' }).regex(/^\d{6,24}$/u, 'no id'),
    Posting_Title: z.string({ error: 'no title' }).refine((t) => t.trim() !== '', 'blank title'),
    City: z.string().nullish(),
    State: z.string().nullish(),
    Country: z.string().nullish(),
    Remote_Job: z.boolean().nullish(),
    Publish: z.boolean().nullish(),
    Job_Type: z.string().nullish(),
  })
  .passthrough();

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * The value of the first `<input …>` whose `id` is `jobs` (attribute order free, single or double quotes), entities
 * decoded; null when there is none. Linear: forward `indexOf('<input')`, then each tag's attributes are read once and
 * the scan resumes after what was read (a `<` inside a tag ends it, a quote with no closing quote ends the search).
 */
export function embeddedJobs(html: string): string | null {
  let from = 0;
  for (;;) {
    const at = html.indexOf('<input', from);
    if (at < 0) return null;
    let i = at + '<input'.length;
    const next = html[i];
    if (!(isSpace(next) || next === '/' || next === '>')) {
      from = i;
      continue;
    }
    let id: string | null = null;
    let value: string | null = null;
    for (;;) {
      while (i < html.length && (isSpace(html[i]) || html[i] === '/')) i++;
      if (i >= html.length) return null;
      const c = html[i];
      if (c === '>') {
        i++;
        break;
      }
      if (c === '<') break; // a new tag starts: this one is malformed, rescan from here
      const s = i;
      while (i < html.length && !isSpace(html[i]) && html[i] !== '=' && html[i] !== '>' && html[i] !== '/' && html[i] !== '<') i++;
      const name = html.slice(s, i).toLowerCase();
      if (i === s) {
        i++;
        continue;
      }
      while (i < html.length && isSpace(html[i])) i++;
      if (html[i] !== '=') continue;
      i++;
      while (i < html.length && isSpace(html[i])) i++;
      let v: string;
      const q = html[i];
      if (q === '"' || q === "'") {
        const end = html.indexOf(q, i + 1);
        if (end < 0) return null;
        v = html.slice(i + 1, end);
        i = end + 1;
      } else {
        const vs = i;
        while (i < html.length && !isSpace(html[i]) && html[i] !== '>') i++;
        v = html.slice(vs, i);
      }
      if (name === 'id') id = v;
      else if (name === 'value') value = v;
    }
    if (id === 'jobs' && value !== null) return decodeEntities(value);
    from = i;
  }
}

export function parseZoho(body: string, host: string, req: { company: string; slug: string }): FeedPage {
  const what = `zohorecruit ${host}`;
  const raw = embeddedJobs(body);
  if (raw === null) throw feedProblem(what, 'no <input id="jobs"> list on the careers page');
  const json = jsonBody(raw, what);
  if (!Array.isArray(json)) throw feedProblem(what, 'response shape is not valid (root: expected a list of openings)');
  const postings: RawPosting[] = [];
  const malformed: string[] = [];
  const seen = new Set<string>();
  json.forEach((e: unknown, i) => {
    const r = Opening.safeParse(e);
    if (!r.success) return void malformed.push(`entry ${i}: ${zodWhy(r.error)}`);
    const d = r.data;
    if (d.Publish === false) return; // not on the career site: not an open job (not malformed)
    if (seen.has(d.id)) return;
    seen.add(d.id);
    const raw = {
      id: d.id,
      title: d.Posting_Title.trim(),
      url: `https://${host}/jobs/Careers/${d.id}`,
      city: textOf(d.City),
      state: textOf(d.State),
      country: textOf(d.Country),
      remote: d.Remote_Job ?? null,
      jobType: textOf(d.Job_Type),
    };
    postings.push({ source: 'zohorecruit', sourceId: d.id, company: req.company, slug: req.slug, raw });
  });
  return { postings, malformed, listed: json.length, names: [], total: null };
}

export const zohorecruit = feedBoard<string>({
  platform: 'zohorecruit',
  label: 'Zoho Recruit',
  team: 'sourcing-zohorecruit',
  egress: ZOHO_EGRESS,
  documented: false,
  fixedHost: null,
  parseRef: parseZohoRef,
  refOf: (h) => h,
  hostOf: (h) => h,
  urlOf: zohoUrl,
  boardOfUrl: zohoBoardOfUrl,
  // no company name in the list: the host's first label is compared (generic-label rules), as Personio's
  nameKey: (h) => h.split('.')[0] ?? null,
  parse: (body, host, req) => parseZoho(body, host, req),
});
export const srcZohorecruitContract = zohorecruit.contract;
export const makeSrcZohorecruit = zohorecruit.make;
