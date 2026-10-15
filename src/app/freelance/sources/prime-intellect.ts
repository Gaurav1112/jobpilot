import { defineAgent, type Agent } from '../../../kernel/agent.js';
import { defineContract, type Contract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import { GigRequest, RawGig } from '../types.js';
import { finishGigs, isRecord } from './common.js';
import { GITHUB_API_HOST, githubJson, makeGithubHosts, type GithubHosts } from './github.js';

/**
 * `src-prime-intellect`: open GitHub issues in the PrimeIntellect-ai org that are environment bounties, through the
 * GitHub search API (one request per run, the shared GithubHosts budget).
 * An item is a bounty when a label name contains `bounty` (any case, e.g. "💎 Bounty") OR its title or body states an
 * amount next to the word bounty (BOUNTY_AMOUNT); anything else the text search matched is dropped, counted in one
 * note. `incomplete_results: true` → the note `prime-intellect: GitHub says the results are incomplete`; more than 50
 * matches → `prime-intellect: N more not read (one page)`. Pull requests (`pull_request` present) are never gigs.
 * raw: `{ number, repo, title, url: html_url, body (≤ 4000 chars), labels, created_at, amount }`; sourceId `<repo>#<number>`.
 *
 * Why the whole org and not one repo (decision D9): `prime-environments` was renamed `community-environments`
 * (GitHub 301, 2026-10-15), its own issue list answers empty, and the bounties are posted through Algora comments on
 * issues across the org. An empty open list is the normal answer: the note `prime-intellect: 0 open bounty issues`.
 *
 * Parsing is linear: the regex is anchored on `$` or the word `bounty` and reaches at most 40 characters on, and every
 * text is cut to SCAN_MAX characters before it is scanned.
 */
export const PI_SEARCH_URL = 'https://api.github.com/search/issues?q=org%3APrimeIntellect-ai+is%3Aissue+is%3Aopen+bounty&sort=created&order=desc&per_page=50';
/** `$1,200 bounty`, `bounty: $800`, `$5k bounty` (an amount within 40 characters of the word, same sentence). Linear. */
export const BOUNTY_AMOUNT = /\$\s?(\d{1,3}(?:,\d{3})*|\d+)(k)?\b[^.\n$]{0,40}\bbount(?:y|ies)\b|\bbount(?:y|ies)\b[^.\n$]{0,40}\$\s?(\d{1,3}(?:,\d{3})*|\d+)(k)?\b/iu;

const BODY_MAX = 4000;
/** Every text is cut here before a scan, so no scan is longer than this. */
const SCAN_MAX = 64_000;
const GLOBAL_AMOUNT = new RegExp(BOUNTY_AMOUNT.source, 'giu');

/** The one distinct bounty amount (US dollars) the text states, or null when it states none or several. */
export function bountyAmount(text: string): number | null {
  const seen = new Set<number>();
  for (const m of text.slice(0, SCAN_MAX).matchAll(GLOBAL_AMOUNT)) {
    const n = Number((m[1] ?? m[3] ?? '').replace(/,/g, ''));
    const amount = (m[2] ?? m[4]) === undefined ? n : n * 1000;
    if (Number.isFinite(amount)) seen.add(amount);
  }
  return seen.size === 1 ? ([...seen][0] ?? null) : null;
}

export function srcPrimeIntellectContract(): Contract<GigRequest, RawGig> {
  return defineContract({
    id: 'src-prime-intellect',
    version: '1.0.0',
    description: 'Reads open Prime Intellect environment bounties through the GitHub search API',
    skills: ['gig-sourcing'],
    // A team of its own: its breaker opens on its own failures only (pipeline.ts).
    team: 'sourcing-prime-intellect',
    kind: 'io',
    consumes: GigRequest,
    produces: RawGig,
    capabilities: { http: true },
    egress: [GITHUB_API_HOST],
    dataClasses: { in: ['P0'], out: ['P0'] },
    budget: { usdPerCall: 0, usdPerRun: 0 },
    // One request.
    timeoutMs: 30_000,
    // Never `rate_limit` or a refusal: those disable the host for the run instead.
    retry: { max: 1, on: ['overloaded', 'network', 'timeout'], backoffMs: [8000] },
  });
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** The repo name from `repository_url` (`…/repos/<org>/<repo>`), else from the issue's `html_url`. */
function repoOf(o: Record<string, unknown>): string | null {
  for (const key of ['repository_url', 'html_url']) {
    const v = str(o[key]);
    if (v === null) continue;
    const parts = v.split('/');
    const at = parts.indexOf(key === 'repository_url' ? 'repos' : 'github.com');
    const repo = at === -1 ? undefined : parts[at + 2];
    if (repo !== undefined && repo !== '') return repo;
  }
  return null;
}

export function makeSrcPrimeIntellect(hosts: GithubHosts = makeGithubHosts()): Agent<GigRequest, RawGig> {
  return defineAgent(srcPrimeIntellectContract(), async (req, ctx) => {
    if (req.platform !== 'prime-intellect') return [];
    const answer = await githubJson(ctx, hosts, PI_SEARCH_URL.slice(`https://${GITHUB_API_HOST}`.length));
    if (!isRecord(answer) || !Array.isArray(answer.items)) throw new KernelError('invalid_output', 'prime-intellect: the search answer has no items list');
    const items: unknown[] = answer.items;
    const notes: string[] = [];
    if (items.length === 0) {
      notes.push('prime-intellect: 0 open bounty issues');
      if (answer.incomplete_results === true) notes.push('prime-intellect: GitHub says the results are incomplete');
      ctx.skipped(notes);
      return [];
    }
    const gigs: RawGig[] = [];
    let dropped = 0;
    let unreadable = 0;
    for (const item of items) {
      if (!isRecord(item)) {
        unreadable += 1;
        continue;
      }
      if ('pull_request' in item && item.pull_request !== undefined && item.pull_request !== null) continue;
      const number = item.number;
      const title = str(item.title);
      const url = str(item.html_url);
      const repo = repoOf(item);
      const created = str(item.created_at);
      if (typeof number !== 'number' || !Number.isInteger(number) || title === null || url === null || !url.startsWith('https://github.com/') || repo === null) {
        unreadable += 1;
        continue;
      }
      const labels = (Array.isArray(item.labels) ? item.labels : []).flatMap((l: unknown) => (isRecord(l) && typeof l.name === 'string' ? [l.name] : []));
      const body = (typeof item.body === 'string' ? item.body : '').slice(0, BODY_MAX);
      const amount = bountyAmount(`${title}\n${body}`);
      const labelled = labels.some((l) => l.toLowerCase().includes('bounty'));
      const stated = BOUNTY_AMOUNT.test(title.slice(0, SCAN_MAX)) || BOUNTY_AMOUNT.test(body);
      if (!labelled && !stated) {
        dropped += 1;
        continue;
      }
      gigs.push({ platform: 'prime-intellect', sourceId: `${repo}#${number}`, raw: { number, repo, title, url, body, labels, created_at: created, amount } });
    }
    if (unreadable === items.length) throw new KernelError('invalid_output', `prime-intellect: all ${items.length} search items failed to parse`);
    if (unreadable > 0) notes.push(`prime-intellect: ${unreadable} search items unreadable`);
    if (dropped > 0) notes.push(`prime-intellect: ${dropped} matches without a bounty label or amount dropped`);
    if (answer.incomplete_results === true) notes.push('prime-intellect: GitHub says the results are incomplete');
    const total = typeof answer.total_count === 'number' ? answer.total_count : items.length;
    if (total > items.length) notes.push(`prime-intellect: ${total - items.length} more not read (one page)`);
    if (notes.length > 0) ctx.skipped(notes);
    return finishGigs(gigs);
  });
}

/** The agent for exports and tests; the run builds its own on the run's shared GitHub host state (`freelanceAgents`). */
export const srcPrimeIntellect = makeSrcPrimeIntellect();
