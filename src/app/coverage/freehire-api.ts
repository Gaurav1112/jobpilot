import { z } from 'zod';
import { defineAgent } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { defineType } from '../../kernel/types.js';
import { namesIndia } from '../agents/sources/platforms/shared.js';
import { countriesIn } from '../text/norm.js';
import { refOfFreehireBoard } from './freehire-boards.js';
import type { Platform } from './types.js';

/**
 * The freehire API as jobpilot reads it. The API is documented at https://freehire.me/docs/api (and /openapi.yaml);
 * it is keyless, its robots.txt says `Allow: /` and asks bots to use the JSON API, the limit is 600 requests a
 * minute per IP, and its terms (2026-08-10) forbid "scraping beyond our documented API" and any attempt to bypass
 * rate limits or authentication. Nothing here goes beyond the documented API. freehire is MIT-licensed; no
 * attribution is required, and one is given anyway (assets/freehire/NOTICE).
 */
export const FREEHIRE_HOST = 'freehire.me';
export const FREEHIRE_API = `https://${FREEHIRE_HOST}/api/v1`;

/**
 * The fields jobpilot reads. Everything else, notably the LLM-filled `enrichment`, `countries`, `regions`,
 * `work_mode`, `skills`, `cities`, `collections` and `reality`, is NEVER read (zod drops unknown keys, so they are
 * absent from the parsed row).
 */
export const FreehireRow = z.object({
  source: z.string().min(1),
  external_id: z.string(),
  url: z.string().url(),
  title: z.string().min(1),
  company: z.string().nullable(),
  location: z.string().nullable(),
  posted_at: z.string().nullable(),
  created_at: z.string(),
  last_seen_at: z.string().nullish(),
  closed_at: z.string().nullish(),
});
export type FreehireRow = z.infer<typeof FreehireRow>;

const Page = z
  .object({
    data: z.array(z.unknown()),
    meta: z
      .object({ total: z.number().int().nonnegative(), limit: z.number().int(), offset: z.number().int(), ignored_params: z.array(z.string()).optional() })
      .passthrough(),
  })
  .passthrough();

export type PageCheck =
  | { readonly ok: true; readonly rows: FreehireRow[]; readonly malformed: string[]; readonly total: number }
  | { readonly ok: false; readonly why: string };

/**
 * A search page: JSON, the envelope above, and `meta.ignored_params` ABSENT OR EMPTY (freehire ignores an unknown
 * parameter instead of refusing it, so a renamed filter would silently widen the result: that is a shape change,
 * never data). One row failing `FreehireRow` is a named malformed entry; every row failing is a shape change.
 */
export function checkPage(body: string): PageCheck {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, why: 'freehire answered something that is not JSON' };
  }
  const page = Page.safeParse(json);
  if (!page.success) return { ok: false, why: 'freehire page lacks the data/meta envelope' };
  const ignored = page.data.meta.ignored_params ?? [];
  if (ignored.length > 0) return { ok: false, why: `freehire ignored parameters: ${ignored.join(', ')}` };
  const rows: FreehireRow[] = [];
  const malformed: string[] = [];
  page.data.data.forEach((raw, i) => {
    const r = FreehireRow.safeParse(raw);
    if (r.success) rows.push(r.data);
    else {
      const issue = r.error.issues[0];
      malformed.push(`row ${i}: ${issue === undefined || issue.path.length === 0 ? 'not an object' : issue.path.join('.')}`);
    }
  });
  if (rows.length === 0 && malformed.length > 0) return { ok: false, why: 'freehire rows do not match the expected shape' };
  return { ok: true, rows, malformed, total: page.data.meta.total };
}

/** The URL without `utm_*` query parameters (freehire appends `utm_source=freehire.me`), otherwise unchanged. */
export function stripTracking(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const h = url.indexOf('#', q);
  const query = url.slice(q + 1, h < 0 ? url.length : h);
  const parts = query.split('&');
  const kept = parts.filter((p) => !p.toLowerCase().startsWith('utm_'));
  if (kept.length === parts.length) return url;
  return url.slice(0, q) + (kept.length > 0 ? `?${kept.join('&')}` : '') + (h < 0 ? '' : url.slice(h));
}

/** jobpilot's platform for a freehire `source`, or null (a source jobpilot cannot read). UKG is null: it is skipped. */
export const FREEHIRE_PLATFORMS: Readonly<Record<string, Platform>> = {
  greenhouse: 'greenhouse', lever: 'lever', ashby: 'ashby', workday: 'workday', eightfold: 'eightfold', oracle: 'oracle',
  icims: 'icims', successfactors: 'successfactors', smartrecruiters: 'smartrecruiters', workable: 'workable',
  recruitee: 'recruitee', teamtailor: 'teamtailor', personio: 'personio', bamboohr: 'bamboohr', breezy: 'breezy',
  pinpoint: 'pinpoint', rippling: 'rippling', gem: 'gem', jazzhr: 'jazzhr', zohorecruit: 'zohorecruit', manatal: 'manatal',
  freshteam: 'freshteam',
};

/** freehire sources whose rows are re-syndicated listings with no employer link: never a lead (fixed list). */
export const LEAD_SOURCE_DENY = /^(?:whatjobs(?:-[a-z]{2})?|adzuna|powertofly)$/u;

/** A tech title (fixed word list, word-bounded). */
export const TECH_TITLE = /\b(?:engineer(?:ing)?|developer|programmer|architect|sre|devops|back[\s-]?end|full[\s-]?stack|platform|software|sde|swe|data|ml|machine learning|ai|security|infrastructure|cloud)\b/iu;
/** A location open to anyone (fixed words, word-bounded): "Worldwide", "Anywhere in the World", "Remote - Global". */
export const WORLDWIDE_REMOTE = /\b(?:anywhere|worldwide|world\s*wide|global(?:ly)?|international)\b/iu;

/**
 * jobpilot's own evidence that a row is India or worldwide-remote tech work, from the RAW `title` and `location`
 * only: `india` when `namesIndia(location)`, `worldwide` when WORLDWIDE_REMOTE matches and the location names no
 * country other than India (`countriesIn`, whose own `worldwide` marker is not a country), else null; null too when the title fails TECH_TITLE.
 */
export function evidenceOf(row: Pick<FreehireRow, 'title' | 'location'>): 'india' | 'worldwide' | null {
  if (row.location === null || !TECH_TITLE.test(row.title)) return null;
  if (namesIndia(row.location)) return 'india';
  if (WORLDWIDE_REMOTE.test(row.location) && countriesIn(row.location).every((c) => c === 'india' || c === 'worldwide')) return 'worldwide';
  return null;
}

/**
 * `(platform, board)` of a row on a supported source: the `external_id` before its FIRST `:` (freehire's board id),
 * case kept (Oracle site numbers are case-sensitive); matching against catalogue boards compares lower-cased.
 */
export function boardOfRow(row: Pick<FreehireRow, 'source' | 'external_id'>): { readonly platform: Platform; readonly board: string } | null {
  if (!Object.hasOwn(FREEHIRE_PLATFORMS, row.source)) return null;
  const platform = FREEHIRE_PLATFORMS[row.source] as Platform;
  const colon = row.external_id.indexOf(':');
  const board = colon < 0 ? row.external_id : row.external_id.slice(0, colon);
  return board === '' ? null : { platform, board };
}

export type RowClass = 'board' | 'lead' | 'drop';

/**
 * What a search row is worth (deterministic, from the fields above only):
 * - `drop`: closed, no India/worldwide tech evidence of its own (`evidenceOf`), or a re-syndicated source;
 * - `board`: a supported platform whose board id jobpilot can translate to a readable ref (`refOfFreehireBoard`);
 * - `lead`: everything else with evidence (an unsupported platform, or a board shape jobpilot cannot read).
 */
export function classifyRow(row: Pick<FreehireRow, 'source' | 'external_id' | 'title' | 'location'> & { readonly closed_at?: string | null | undefined }): RowClass {
  if (row.closed_at !== null && row.closed_at !== undefined && row.closed_at !== '') return 'drop';
  if (evidenceOf(row) === null || LEAD_SOURCE_DENY.test(row.source)) return 'drop';
  const b = boardOfRow(row);
  if (b !== null && refOfFreehireBoard(b.platform, b.board) !== null) return 'board';
  return 'lead';
}

export const RowIn = defineType(
  'FreehireRowIn',
  1,
  z.object({ source: z.string(), external_id: z.string(), title: z.string(), location: z.string().nullable(), closed_at: z.string().nullable() }).strict(),
);
export const RowOut = defineType('FreehireRowClass', 1, z.object({ class: z.enum(['board', 'lead', 'drop']) }).strict());

export const freehireRowClassifierContract = defineContract({
  id: 'freehire-row-classifier',
  version: '1.0.0',
  description: 'Classes a freehire search row as board, lead or drop',
  skills: ['freehire-row-class'],
  team: 'coverage',
  kind: 'deterministic',
  consumes: RowIn,
  produces: RowOut,
  capabilities: {},
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
});

/** Evaluated only (the `freehire-rows` golden set); the discovery agent (Task 8) calls `classifyRow` itself. */
export const freehireRowClassifier = defineAgent(freehireRowClassifierContract, async (r) => [{ class: classifyRow(r) }]);
