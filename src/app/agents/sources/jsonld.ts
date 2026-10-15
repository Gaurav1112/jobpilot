import { z } from 'zod';
import { isRecord } from './common.js';

/**
 * JSON-LD reading shared by the careers source (`careers.ts`, whose node walk and JobPosting finder moved here
 * unchanged in Task 8) and the platform page adapters (iCIMS, SuccessFactors, SmartRecruiters, the generic
 * `jsonld-sitemap`), which read job pages as plain HTML:
 * - `jsonLdBlocks(html)`: every `<script type="application/ld+json">` block of a page, parsed, in document order; a
 *   block that is not JSON is counted (`malformed`), never thrown. Linear: each `<script`, its `>` and its `</script`
 *   are found by forward searches from where the last one ended, and a missing one ends the scan.
 * - `jsonLdJobPostings(html)`: every JobPosting node of those blocks (plain, `@graph`, nested, an array `@type`), in
 *   document order.
 * - `checkJobPosting(node)`: the node checked with zod (a non-blank `title` and `description`, the schema.org fields
 *   the normalizer reads in their schema.org shapes). A node that fails is reported with the first issue, never
 *   partially read. `keptJobPosting` keeps only the fields the normalizer reads, so nothing else a page carries (a
 *   recruiter's name, a street address) is stored: `hiringOrganization` keeps its `name`; each `jobLocation` place its
 *   `addressLocality`, `addressRegion`, `addressCountry` (a placeholder such as `UNAVAILABLE` or `N/A`, seen live on
 *   iCIMS, is dropped: it names no place) and its `name`.
 */

export const hasType = (o: Record<string, unknown>, t: string): boolean =>
  o['@type'] === t || (Array.isArray(o['@type']) && o['@type'].includes(t));

/** Every JSON-LD node, depth first in document order: arrays, `@graph` and nested objects are walked. */
export function* jsonLdNodes(v: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 20) return;
  if (Array.isArray(v)) {
    for (const x of v) yield* jsonLdNodes(x, depth + 1);
  } else if (isRecord(v)) {
    yield v;
    for (const x of Object.values(v)) if (typeof x === 'object' && x !== null) yield* jsonLdNodes(x, depth + 1);
  }
}

export function findJobPosting(jsonLd: readonly unknown[]): Record<string, unknown> | null {
  for (const n of jsonLdNodes(jsonLd)) if (hasType(n, 'JobPosting')) return n;
  return null;
}

const LD_TYPE = /\btype\s*=\s*["']?\s*application\/ld\+json/i;

/** The parsed JSON-LD blocks of a page, in document order, and how many were not JSON. Linear in the page. */
export function jsonLdBlocks(html: string): { blocks: unknown[]; malformed: number } {
  const blocks: unknown[] = [];
  let malformed = 0;
  const open = /<script\b/gi;
  const close = /<\/script/gi;
  let o = open.exec(html);
  while (o !== null) {
    const gt = html.indexOf('>', open.lastIndex);
    if (gt < 0) break;
    close.lastIndex = gt + 1;
    const c = close.exec(html);
    if (c === null) break;
    if (LD_TYPE.test(html.slice(open.lastIndex, gt))) {
      let text = html.slice(gt + 1, c.index).trim();
      if (text.startsWith('<![CDATA[') && text.endsWith(']]>')) text = text.slice('<![CDATA['.length, -']]>'.length).trim();
      try {
        blocks.push(JSON.parse(text) as unknown);
      } catch {
        malformed++;
      }
    }
    open.lastIndex = close.lastIndex;
    o = open.exec(html);
  }
  return { blocks, malformed };
}

/** Every JobPosting node of the page's JSON-LD, in document order. */
export function jsonLdJobPostings(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const n of jsonLdNodes(jsonLdBlocks(html).blocks)) if (hasType(n, 'JobPosting')) out.push(n);
  return out;
}

const nonBlank = (what: string) => z.string().refine((s) => s.trim() !== '', `blank ${what}`);
const TextOrList = z.union([z.string(), z.array(z.string())]);

/** A JobPosting node in the shapes the normalizer reads (schema.org); other fields pass through unchecked. */
export const JobPostingLd = z
  .object({
    title: nonBlank('title'),
    description: nonBlank('description'),
    datePosted: z.string().optional(),
    validThrough: z.string().optional(),
    employmentType: TextOrList.optional(),
    jobLocationType: TextOrList.optional(),
    jobLocation: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string()]).optional(),
    applicantLocationRequirements: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string()]).optional(),
    hiringOrganization: z.union([z.string(), z.object({ name: z.string().optional() }).passthrough()]).optional(),
    baseSalary: z.unknown().optional(),
    url: z.string().optional(),
  })
  .passthrough();
export type JobPostingLd = z.infer<typeof JobPostingLd>;

/** The node checked: the posting, or why not (`title: Required`, `description: blank description`, …). */
export function checkJobPosting(node: unknown): { readonly ok: true; readonly posting: JobPostingLd } | { readonly ok: false; readonly why: string } {
  const r = JobPostingLd.safeParse(node);
  if (r.success) return { ok: true, posting: r.data };
  const first = r.error.issues[0];
  return { ok: false, why: first === undefined ? 'not a JobPosting' : `${first.path.map(String).join('.') || 'root'}: ${first.message}` };
}

/** Address values that name no place (seen live: iCIMS writes `UNAVAILABLE` into every unknown field). */
const PLACEHOLDER = /^\s*(?:unavailable|n\/?a|none|null|undefined|-+|\.+)?\s*$/i;
const placeValue = (v: unknown): string | Record<string, unknown> | undefined => {
  if (typeof v === 'string') return PLACEHOLDER.test(v) ? undefined : v.trim();
  if (isRecord(v) && typeof v.name === 'string' && !PLACEHOLDER.test(v.name)) return { name: v.name.trim() };
  return undefined;
};

function keptPlace(p: unknown): unknown {
  if (typeof p === 'string') return PLACEHOLDER.test(p) ? undefined : p.trim();
  if (!isRecord(p)) return undefined;
  const a = isRecord(p.address) ? p.address : null;
  const address: Record<string, unknown> = {};
  if (a !== null) {
    for (const k of ['addressLocality', 'addressRegion', 'addressCountry'] as const) {
      const v = placeValue(a[k]);
      if (v !== undefined) address[k] = v;
    }
  } else if (typeof p.address === 'string' && !PLACEHOLDER.test(p.address)) {
    address.addressLocality = p.address.trim();
  }
  const name = placeValue(p.name);
  const out: Record<string, unknown> = {};
  if (typeof p['@type'] === 'string') out['@type'] = p['@type'];
  if (Object.keys(address).length > 0) out.address = address;
  if (typeof name === 'string') out.name = name;
  return Object.keys(out).filter((k) => k !== '@type').length > 0 ? out : undefined;
}

const keptPlaces = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(keptPlace).filter((x) => x !== undefined);

/** Only what the normalizer reads (see the header), so a stored posting carries nothing else of the page. */
export function keptJobPosting(p: JobPostingLd): Record<string, unknown> {
  const org = p.hiringOrganization;
  const orgName = typeof org === 'string' ? org : org?.name;
  const located = keptPlaces(p.jobLocation);
  const applicants = keptPlaces(p.applicantLocationRequirements);
  return {
    '@type': 'JobPosting',
    title: p.title,
    description: p.description,
    ...(p.datePosted === undefined ? {} : { datePosted: p.datePosted }),
    ...(p.validThrough === undefined ? {} : { validThrough: p.validThrough }),
    ...(p.employmentType === undefined ? {} : { employmentType: p.employmentType }),
    ...(p.jobLocationType === undefined ? {} : { jobLocationType: p.jobLocationType }),
    // Freshteam's own remote flag (`"remote": "true"`), kept only when set, for its mapper alone
    ...(p.remote === true || (typeof p.remote === 'string' && p.remote.trim().toLowerCase() === 'true') ? { remote: p.remote } : {}),
    ...(located.length === 0 ? {} : { jobLocation: located }),
    ...(applicants.length === 0 ? {} : { applicantLocationRequirements: applicants }),
    ...(orgName === undefined || orgName.trim() === '' ? {} : { hiringOrganization: { name: orgName.trim() } }),
    ...(p.baseSalary === undefined ? {} : { baseSalary: p.baseSalary }),
  };
}
