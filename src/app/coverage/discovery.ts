import { defineAgent, type Agent } from '../../kernel/agent.js';
import { defineContract, type Contract } from '../../kernel/contract.js';
import { KernelError } from '../../kernel/errors.js';
import { hostDenied, PRODUCT_POLICY_V1 } from '../../kernel/policy.js';
import { platformClient } from '../agents/sources/platforms/client.js';
import { isChallenge } from '../challenge.js';
import { officeCity } from '../text/norm.js';
import { boardOfRow, checkPage, evidenceOf, FREEHIRE_API, FREEHIRE_HOST, LEAD_SOURCE_DENY, stripTracking } from './freehire-api.js';
import { isRealCompanyName, refOfFreehireBoard } from './freehire-boards.js';
import { FreehireFinding, FreehireQuery } from './types.js';

/**
 * `src-freehire-discovery` (sources-x D6): once a week, at most DISCOVERY_MAX_QUERIES fixed searches of freehire's
 * keyless public API (https://freehire.me/docs/api), one page of 100 rows each, never a second page.
 *
 * Terms (read 2026-10-15): robots.txt `User-agent: * Allow: /` and its comment invites bots to use the JSON API instead
 * of the pages; llms.txt "no key, no sign-up"; Terms of Service (2026-08-10): "no scraping beyond our documented API,
 * no attempting to bypass rate limits or authentication". Rate limit 600 requests/min per IP; this agent makes ≤ 10 a
 * week, ≥ 2 s apart, with the honest UA. No attribution is required; every lead links the original posting and the
 * dashboard names freehire as where it was found.
 *
 * Reads ONLY `source, external_id, url, title, company, location, posted_at, created_at, last_seen_at, closed_at`. The
 * LLM-filled fields (`enrichment`, `countries`, `regions`, `work_mode`, `skills`, `category`, `reality`) are never read,
 * and no query filters on them: queries are full-text over `title,location` plus `open_within_days` (freehire's own
 * first-seen date) and `source_exclude` (the provider, a fact).
 *
 * Fails closed: a non-2xx, a body that is not the documented envelope, a non-empty `meta.ignored_params`, every row
 * malformed, a timeout, a 5xx: the step returns NO findings and one named note `freehire-outage <queryId>: <why>`.
 * A 401, 403, 429 or a challenge also disables freehire.me for the rest of the run (`host-disabled`), never retried,
 * Retry-After never read. Nothing else in jobpilot depends on this agent.
 */
export const DISCOVERY_MIN_INTERVAL_MS = 2000;
export const DISCOVERY_MAX_QUERIES = 10;
/** The rows one search reads (freehire's page size for these requests); more matches are a loud note, never a second page. */
export const DISCOVERY_PAGE = 100;

const COMMON = `q_fields=title,location&open_within_days=7&sort=created_at&order=desc&limit=${DISCOVERY_PAGE}&source_exclude=powertofly,adzuna`;

/** `city` comes from the pack's office cities (at most two, pack order); never from code. */
export const DISCOVERY_TEMPLATES: readonly { readonly id: string; readonly q: (city?: string) => string; readonly perCity?: true }[] = [
  { id: 'q1', q: (c) => `"senior backend ${c ?? ''}"`, perCity: true }, // q1 for office city 1
  { id: 'q2', q: (c) => `"senior backend ${c ?? ''}"`, perCity: true }, // q2 for office city 2 (absent when the pack names one)
  { id: 'q3', q: () => '"senior backend india"' },
  { id: 'q4', q: () => '"senior engineer india"' },
  { id: 'q5', q: () => '"staff engineer india"' },
  { id: 'q6', q: () => '"remote india engineer"' },
  { id: 'q7', q: () => '"contract engineer remote"' },
  { id: 'q8', q: () => '"freelance developer"' },
  { id: 'q9', q: () => '"part-time engineer remote"' },
];

/** The week's searches: the fixed templates, the two city ones only for the pack's office cities (each city once, pack order, at most two). */
export function discoveryQueries(week: string, officeCities: readonly string[]): FreehireQuery[] {
  const cities: string[] = [];
  for (const raw of officeCities) {
    const name = officeCity(raw).display.toLowerCase();
    if (name !== '' && !cities.includes(name)) cities.push(name);
  }
  const out: FreehireQuery[] = [];
  let cityNo = 0;
  for (const t of DISCOVERY_TEMPLATES) {
    let q: string;
    if (t.perCity === true) {
      const city = cities[cityNo++];
      if (city === undefined || cityNo > 2) continue;
      q = t.q(city);
    } else q = t.q();
    out.push({ week, queryId: t.id, url: `${FREEHIRE_API}/jobs/search?q=${encodeURIComponent(q)}&${COMMON}` });
  }
  return out.slice(0, DISCOVERY_MAX_QUERIES);
}

export function srcFreehireDiscoveryContract(): Contract<FreehireQuery, FreehireFinding> {
  return defineContract({
    id: 'src-freehire-discovery',
    version: '1.0.0',
    description: 'Finds new job boards or unreadable-platform postings through at most ten weekly freehire searches',
    skills: ['board-discovery'],
    // A team of its own: its breaker opens on its own failures only.
    team: 'coverage-freehire',
    kind: 'io',
    consumes: FreehireQuery,
    produces: FreehireFinding,
    capabilities: { http: true },
    egress: [FREEHIRE_HOST],
    dataClasses: { in: ['P0'], out: ['P0'] },
    budget: { usdPerCall: 0, usdPerRun: 0 },
    timeoutMs: 60_000,
    retry: { max: 0, on: [], backoffMs: [] },
  });
}

/** A posting date: the date part of an absolute ISO timestamp, else null (a relative or absent date is never guessed). */
const postedDate = (v: string | null): string | null => (v !== null && /^\d{4}-\d{2}-\d{2}(?:[T ]|$)/u.test(v) ? v.slice(0, 10) : null);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The agent, with fresh host state (one flag: disabled for the rest of the run); the coverage run builds one per run
 * (`coverageAgents`), so a refusal never outlives it.
 */
export function makeSrcFreehireDiscovery(): Agent<FreehireQuery, FreehireFinding> {
  let disabled: string | undefined;
  return defineAgent(srcFreehireDiscoveryContract(), async (q, ctx) => {
    if (!ctx.http) throw new KernelError('policy_denied', 'no http capability issued');
    if (!q.url.startsWith(`${FREEHIRE_API}/`)) throw new KernelError('input_rejected', `${q.queryId}: not a ${FREEHIRE_HOST} API request`);
    const outage = (why: string): FreehireFinding[] => {
      ctx.skipped([`freehire-outage ${q.queryId}: ${why}`]);
      return [];
    };
    if (disabled !== undefined) return outage(`host-disabled:${disabled} on ${FREEHIRE_HOST}`);
    const refuse = (why: string, what: string): FreehireFinding[] => {
      disabled ??= why;
      return outage(`freehire ${what}; host-disabled:${why} on ${FREEHIRE_HOST} for the rest of the run, never retried`);
    };

    let r;
    try {
      r = await ctx.http.getPage(q.url, { minIntervalMs: DISCOVERY_MIN_INTERVAL_MS });
    } catch (e) {
      if (e instanceof KernelError && e.code !== 'policy_denied') return outage(`${e.code}: ${e.message}`);
      throw e;
    }
    if (isChallenge(r.status, r.body)) return refuse('challenge', `answered with a challenge page (${r.status})`);
    if (r.status === 429) return refuse('http-429', 'answered 429');
    if (r.status === 401 || r.status === 403) return refuse(`http-${r.status}`, `answered ${r.status}`);
    if (r.status < 200 || r.status >= 300) return outage(`freehire answered ${r.status}`);
    const page = checkPage(r.body);
    if (!page.ok) return outage(page.why);

    const boards = new Map<string, Extract<FreehireFinding, { kind: 'board' }>>();
    const leads = new Map<string, Extract<FreehireFinding, { kind: 'lead' }>>();
    let notIndia = 0;
    let unnamed = 0;
    let denied = 0;
    for (const row of page.rows) {
      if (row.closed_at !== null && row.closed_at !== undefined && row.closed_at !== '') continue;
      const evidence = evidenceOf(row);
      if (evidence === null) {
        notIndia++;
        continue;
      }
      const b = boardOfRow(row);
      if (b !== null) {
        const ref = refOfFreehireBoard(b.platform, b.board);
        const client = platformClient(b.platform);
        if (ref === null || client === null || !isRealCompanyName(row.company, b.board)) {
          unnamed++;
          continue;
        }
        const key = `${b.platform} ${ref.toLowerCase()}`;
        if (!boards.has(key)) {
          boards.set(key, { kind: 'board', platform: b.platform, ref, boardUrl: client.boardUrl(ref), company: row.company.trim(), evidence, example: { title: row.title, location: row.location, url: stripTracking(row.url) }, queryId: q.queryId });
        }
        continue;
      }
      let host = '';
      try {
        host = new URL(row.url).hostname;
      } catch {
        host = '';
      }
      if (LEAD_SOURCE_DENY.test(row.source) || host === '' || hostDenied(PRODUCT_POLICY_V1, host)) {
        denied++;
        continue;
      }
      const leadKey = `${row.source}:${row.external_id}`;
      if (!leads.has(leadKey)) {
        leads.set(leadKey, { kind: 'lead', leadKey, source: row.source, url: stripTracking(row.url), title: row.title, company: row.company, location: row.location, postedAt: postedDate(row.posted_at), evidence, queryId: q.queryId });
      }
    }
    const dropped = notIndia + unnamed + denied;
    const notes = [`freehire ${q.queryId}: ${page.rows.length} rows, ${boards.size} boards, ${leads.size} leads, ${dropped} dropped (${notIndia} not India/worldwide tech, ${unnamed} unnamed, ${denied} denied)`];
    if (page.malformed.length > 0) notes.push(`freehire ${q.queryId}: ${page.malformed.length} malformed rows skipped (${page.malformed.slice(0, 3).join('; ')})`);
    if (page.total > DISCOVERY_PAGE) notes.push(`freehire ${q.queryId}: ${page.total - DISCOVERY_PAGE} more matches not read (one page per query)`);
    ctx.skipped(notes);
    return [...[...boards.values()].sort((a, b) => cmp(a.platform, b.platform) || cmp(a.ref, b.ref)), ...[...leads.values()].sort((a, b) => cmp(a.leadKey, b.leadKey))];
  });
}

/** The agent for exports and tests; a run builds its own (`coverageAgents`). */
export const srcFreehireDiscovery = makeSrcFreehireDiscovery();
