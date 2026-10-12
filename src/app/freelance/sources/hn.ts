import { defineAgent, type AgentContext } from '../../../kernel/agent.js';
import { KernelError } from '../../../kernel/errors.js';
import type { RawGig } from '../types.js';
import { checkGigs, finishGigs, getBoard, gigSourceContract, idOf, isRecord } from './common.js';

/**
 * Hacker News through the Algolia API, two modes by platform.
 * - `hn-freelancer`: the latest "Ask HN: Freelancer? Seeking freelancer?" thread, found with
 *   `search_by_date?query=%22Seeking%20freelancer%22&tags=story`. Keeps top-level comments that start with
 *   SEEKING FREELANCER (any case).
 * - `hn-hiring`: the latest "Ask HN: Who is hiring?" thread, found with `search_by_date?tags=story,author_whoishiring`.
 *   Keeps top-level comments whose first 300 characters say REMOTE (any case) and one of contract, part-time or
 *   freelance.
 * Only a thread created within HN_WINDOW_DAYS before 00:00 IST on `runDate` counts (measured from the request, never
 * the clock, so replay is deterministic). None → `[]` and the note "no thread in 45 days". The thread is read with
 * `items/<id>`; sourceId is the comment id. Deleted comments (no text) are not candidates. `raw` keeps the comment's
 * `id, author, created_at, created_at_i, text, story_id, parent_id` and the thread's id and title.
 */
export const HN_HOST = 'hn.algolia.com';
export const HN_WINDOW_DAYS = 45;
const API = `https://${HN_HOST}/api/v1`;
const IST_OFFSET = '+05:30';

export const hnSearchUrl = (platform: 'hn-freelancer' | 'hn-hiring'): string =>
  platform === 'hn-freelancer' ? `${API}/search_by_date?query=%22Seeking%20freelancer%22&tags=story` : `${API}/search_by_date?tags=story,author_whoishiring`;
export const hnItemUrl = (id: string): string => `${API}/items/${id}`;

export const srcHnContract = gigSourceContract('src-hn', HN_HOST, 'Fetches freelance or contract posts from the latest Hacker News threads');

const THREAD_TITLE = {
  'hn-freelancer': /^Ask HN: Freelancer\? Seeking freelancer\?/i,
  'hn-hiring': /^Ask HN: Who is hiring\?/,
} as const;

const FREELANCER_START = /^\s*SEEKING FREELANCER/i;
const REMOTE = /\bremote\b/i;
const CONTRACT = /\b(contract|contractor|part[- ]?time|freelance|freelancer)\b/i;

interface Thread {
  readonly id: string;
  readonly createdAt: number;
}

/** The newest matching thread created within the window, or undefined. Ties on time go to the lower id. */
function latestThread(json: unknown, platform: 'hn-freelancer' | 'hn-hiring', windowStart: number): Thread | undefined {
  if (!isRecord(json) || !Array.isArray(json.hits)) throw new KernelError('invalid_output', `hn: no hits array in the ${platform} thread search`);
  let best: Thread | undefined;
  for (const hit of json.hits as unknown[]) {
    if (!isRecord(hit) || typeof hit.title !== 'string' || !THREAD_TITLE[platform].test(hit.title)) continue;
    const id = idOf(hit.objectID);
    const at = hit.created_at_i;
    if (id === undefined || typeof at !== 'number' || !Number.isFinite(at) || at < windowStart) continue;
    if (best === undefined || at > best.createdAt || (at === best.createdAt && id < best.id)) best = { id, createdAt: at };
  }
  return best;
}

function wanted(platform: 'hn-freelancer' | 'hn-hiring', text: string): boolean {
  if (platform === 'hn-freelancer') return FREELANCER_START.test(text);
  const head = text.slice(0, 300);
  return REMOTE.test(head) && CONTRACT.test(head);
}

function comments(ctx: AgentContext, platform: 'hn-freelancer' | 'hn-hiring', thread: Thread, json: unknown): RawGig[] {
  if (!isRecord(json) || !Array.isArray(json.children)) throw new KernelError('invalid_output', `hn: thread ${thread.id} has no children array`);
  const title = typeof json.title === 'string' ? json.title : null;
  const gigs: RawGig[] = [];
  const skipped: string[] = [];
  json.children.forEach((c: unknown, i: number) => {
    if (!isRecord(c)) {
      skipped.push(`hn thread ${thread.id} comment ${i}: not an object`);
      return;
    }
    if (c.text === null || c.text === undefined) return; // deleted or dead: nothing to read
    const id = idOf(c.id);
    if (id === undefined || typeof c.text !== 'string') {
      skipped.push(`hn thread ${thread.id} comment ${i}: missing id or text`);
      return;
    }
    if (!wanted(platform, c.text)) return;
    gigs.push({
      platform,
      sourceId: id,
      raw: {
        id: c.id,
        author: c.author ?? null,
        created_at: c.created_at ?? null,
        created_at_i: c.created_at_i ?? null,
        text: c.text,
        story_id: c.story_id ?? null,
        parent_id: c.parent_id ?? null,
        thread: { id: thread.id, title },
      },
    });
  });
  checkGigs(ctx, 'hn', 'comments', json.children.length, skipped);
  return gigs;
}

export const srcHn = defineAgent(srcHnContract, async (req, ctx) => {
  if (req.platform !== 'hn-freelancer' && req.platform !== 'hn-hiring') return [];
  const platform = req.platform;
  const windowStart = Date.parse(`${req.runDate}T00:00:00${IST_OFFSET}`) / 1000 - HN_WINDOW_DAYS * 86_400;
  const thread = latestThread(await getBoard(ctx, hnSearchUrl(platform), platform), platform, windowStart);
  if (thread === undefined) {
    ctx.skipped([`no thread in ${HN_WINDOW_DAYS} days`]);
    return [];
  }
  return finishGigs(comments(ctx, platform, thread, await getBoard(ctx, hnItemUrl(thread.id), thread.id)));
});
