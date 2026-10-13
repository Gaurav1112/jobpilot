import { z } from 'zod';
import type { AgentContext } from '../../../../kernel/agent.js';
import { KernelError } from '../../../../kernel/errors.js';
import type { DiscoveryRequest, RawPosting } from '../../../types.js';
import { ASHBY_HOST, ashbyParse, ashbyUrl } from '../ashby.js';
import type { Parsed } from '../common.js';
import { GREENHOUSE_HOST, greenhouseParse, greenhouseUrl } from '../greenhouse.js';
import { LEVER_HOST, LEVER_PAGE_SIZE, leverParse, leverUrl } from '../lever.js';

/**
 * The read side of each career platform, shared by the coverage run's board-verifier (Task 5) and the daily adapters
 * (Tasks 6-8 add one per platform). A client reads a board the way the platform's daily adapter does: the same host,
 * the same URL builder and the same parser (`greenhouseUrl` + `greenhouseParse`, ...), so a board the verifier accepts
 * is one the daily run can read. The daily adapters themselves are not changed: their step keys stay as on main.
 *
 * `readBoard` makes ONE request (Lever: the first page of LEVER_PAGE_SIZE, the daily adapter's page 1) and checks the
 * response shape with zod before the daily parser sees it. It throws:
 * - `BoardRefused` on 401 or 403 (the caller disables the host for the run, never retries around it);
 * - `KernelError('gone')` on 404, as the daily adapters' `getBoard` does;
 * - `KernelError('invalid_output')` on any other 4xx or a response of the wrong shape;
 * - whatever the broker raises (`rate_limit` on 429, `overloaded` on 5xx, `network`, a timeout).
 *
 * The board-API rule (decided 2026-10-14): a client reads only the platform's DOCUMENTED PUBLIC job-board API
 * (Greenhouse Job Board API `boards-api.greenhouse.io`, Lever Postings API `api.lever.co`, Ashby posting API
 * `api.ashbyhq.com`), which each platform publishes for programmatic use. It does not fetch robots.txt for these
 * API hosts, exactly as the daily adapters do not (seen live 2026-10-13: Greenhouse disallows only `/embed/`, Lever
 * says `Allow: /`, Ashby answers 401 for robots.txt). robots.txt keeps governing every PAGE fetch: the careers
 * locator and the platform detector honour it for every request, through the coverage gate. If a board API answers
 * 401, 403 or 429, the verifier disables that API host for the rest of the run, with a named problem (a deferral),
 * and never retries around it.
 *
 * Agent code (containment): it imports only kernel definitions, so the platform is a plain string here; the coverage
 * types' `Platform` enum is a superset of these keys.
 */

/** The broker's HTTP tool, as an agent's context carries it. */
export type HttpTool = NonNullable<AgentContext['http']>;

export interface BoardRead {
  /** The board's own company name, when the platform gives one and every job agrees on it; else null. */
  readonly boardName: string | null;
  /** Every distinct company name the board's jobs carry, sorted (more than one: the board is not one company's). */
  readonly boardNames: readonly string[];
  readonly jobs: readonly RawPosting[];
  /** False when the board has more jobs than this one request returned (a full Lever page). */
  readonly complete: boolean;
  /** The URL read. */
  readonly url: string;
}

export interface PlatformClient {
  readonly platform: string;
  /** The one host the client reads from (the verifier's egress for this platform). */
  readonly host: string;
  readonly boardUrl: (slug: string) => string;
  /** `timeoutMs`: a per-request timeout (the coverage verifier's); absent, only the step timeout applies. */
  readBoard(slug: string, http: HttpTool, opts?: { readonly timeoutMs?: number }): Promise<BoardRead>;
}

/** A 401 or 403 from the platform's host: a refusal of the requester, not a fact about the board. */
export class BoardRefused extends Error {
  constructor(
    readonly status: number,
    readonly host: string,
  ) {
    super(`${host} answered ${status}`);
    this.name = 'BoardRefused';
  }
}

const JobId = z.union([z.number(), z.string()]);
const SHAPES = {
  greenhouse: z.object({ jobs: z.array(z.object({ id: JobId, title: z.string(), company_name: z.string().nullish() }).passthrough()) }).passthrough(),
  lever: z.array(z.object({ id: z.string(), text: z.string() }).passthrough()),
  ashby: z.object({ jobs: z.array(z.object({ id: z.string(), title: z.string() }).passthrough()) }).passthrough(),
} as const;

/** The daily parsers read only `slug` and `company` of the request; the rest is a placeholder. */
const requestFor = (ats: 'greenhouse' | 'lever' | 'ashby', slug: string): DiscoveryRequest => ({ ats, slug, company: slug, runDate: '1970-01-01' });

/**
 * One GET of the board, read with the broker's `getPage` (the same URL, method, headers, pacing and size cap as the
 * daily adapter's `getJson`; redirects are never followed by either). `getPage` reports a 3xx instead of recording a
 * policy denial, so a board API that redirects (off-platform, a retired board) is a finding about the board, not a
 * failure of the step: `invalid_output` "board API redirected off-platform". 429 and 5xx keep the broker's codes.
 */
async function getJson(http: HttpTool, url: string, host: string, slug: string, timeoutMs?: number): Promise<unknown> {
  const { status, body, location } = await http.getPage(url, timeoutMs === undefined ? undefined : { timeoutMs });
  if (status >= 300 && status < 400) {
    let to = 'nowhere';
    try {
      to = location === null ? to : new URL(location, url).hostname;
    } catch {
      to = 'an invalid Location';
    }
    throw new KernelError('invalid_output', `board API redirected off-platform (${status} to ${to})`);
  }
  if (status === 429) throw new KernelError('rate_limit', `429 from ${host}`);
  if (status >= 500) throw new KernelError('overloaded', `${status} from ${host}`);
  if (status === 401 || status === 403) throw new BoardRefused(status, host);
  if (status === 404) throw new KernelError('gone', `board not found: ${slug}`);
  if (status < 200 || status >= 300) throw new KernelError('invalid_output', `${host} returned ${status} for ${slug}`);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new KernelError('invalid_output', `response from ${host} is not valid JSON`);
  }
}

function checkShape(platform: keyof typeof SHAPES, slug: string, json: unknown): void {
  const r = SHAPES[platform].safeParse(json);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first === undefined ? '' : ` (${first.path.map(String).join('.') || 'root'}: ${first.message})`;
    throw new KernelError('invalid_output', `${platform} board ${slug}: response shape is not valid${where}`);
  }
}

const distinctNames = (jobs: readonly unknown[]): string[] =>
  [...new Set(jobs.map((j) => (typeof j === 'object' && j !== null ? (j as { company_name?: unknown }).company_name : undefined)).filter((n): n is string => typeof n === 'string' && n.trim() !== '').map((n) => n.trim()))].sort();

const read = (parsed: Parsed, names: readonly string[], complete: boolean, url: string): BoardRead => ({
  boardName: names.length === 1 ? (names[0] as string) : null,
  boardNames: names,
  jobs: parsed.postings,
  complete,
  url,
});

const CLIENTS: Readonly<Record<string, PlatformClient>> = {
  greenhouse: {
    platform: 'greenhouse',
    host: GREENHOUSE_HOST,
    boardUrl: greenhouseUrl,
    async readBoard(slug, http, opts) {
      const url = greenhouseUrl(slug);
      const json = await getJson(http, url, GREENHOUSE_HOST, slug, opts?.timeoutMs);
      checkShape('greenhouse', slug, json);
      const jobs = (json as { jobs: unknown[] }).jobs;
      return read(greenhouseParse(json, requestFor('greenhouse', slug)), distinctNames(jobs), true, url);
    },
  },
  lever: {
    platform: 'lever',
    host: LEVER_HOST,
    boardUrl: (slug) => leverUrl(slug, 0),
    async readBoard(slug, http, opts) {
      const url = leverUrl(slug, 0);
      const json = await getJson(http, url, LEVER_HOST, slug, opts?.timeoutMs);
      checkShape('lever', slug, json);
      // Lever's postings carry no company name.
      return read(leverParse(json, requestFor('lever', slug)), [], (json as unknown[]).length < LEVER_PAGE_SIZE, url);
    },
  },
  ashby: {
    platform: 'ashby',
    host: ASHBY_HOST,
    boardUrl: ashbyUrl,
    async readBoard(slug, http, opts) {
      const url = ashbyUrl(slug);
      const json = await getJson(http, url, ASHBY_HOST, slug, opts?.timeoutMs);
      checkShape('ashby', slug, json);
      // Ashby's job-board response carries no company name.
      return read(ashbyParse(json, requestFor('ashby', slug)), [], true, url);
    },
  },
};

/** The platform's read client, or null when this build has no adapter for it yet (Tasks 6-8 add them). */
export function platformClient(platform: string): PlatformClient | null {
  return Object.hasOwn(CLIENTS, platform) ? (CLIENTS[platform] as PlatformClient) : null;
}

/** The platforms this build can read (and so verify), sorted. */
export const BUILT_PLATFORMS: readonly string[] = Object.keys(CLIENTS).sort();
