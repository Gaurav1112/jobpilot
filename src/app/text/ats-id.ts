/**
 * The ATS job id of a posting (career-sites Task 10, spec §4): the id one job has on its applicant-tracking system,
 * platform-qualified so it can never collide across platforms or boards. Two postings of one company with the same
 * key are one job seen through two sources (a company page and its ATS board, or a platform adapter and the board).
 *
 * - `platform`: the ATS (`greenhouse`, `lever`, `ashby`, `workday`).
 * - `board`: the board on that platform (Greenhouse board token, Lever site, Ashby board, Workday tenant); null only for
 *   a company page carrying a bare `gh_jid` with no board anywhere (the store resolves it, or the posting stays
 *   unmerged).
 * - `id`: the platform's job id (Greenhouse digits, Lever and Ashby UUIDs, the Workday req id).
 *
 * Normalisation is exact after trimming; case is folded only where the platform is case-insensitive: Greenhouse board
 * tokens, hostnames (the Workday tenant label), Lever sites (lower-case in their URLs) and UUIDs. A Workday req id
 * and an Ashby board keep their case. Anything that does not have the exact expected shape gives no key: an
 * uncertain id never merges two jobs.
 */
export const ATS_ID_PLATFORMS = ['greenhouse', 'lever', 'ashby', 'workday'] as const;
export type AtsIdPlatform = (typeof ATS_ID_PLATFORMS)[number];

/**
 * Fix round 3: the platforms whose job ids are GLOBAL, unique across every board of every company. Two different ids
 * on one of them are two jobs whatever board each is on; on any other platform (Workday req ids are per tenant) only
 * on the same board. Confirmed for each:
 * - greenhouse: a job post id is one integer sequence across all boards (the Job Board API's `id`; `gh_jid=<id>` on
 *   any company's own domain names the posting with no board);
 * - lever, ashby: the posting / job id is a random UUID (`text/ats-id.ts` accepts only the UUID shape).
 * jobpilot already relies on this: a posting's identity is `jobKey(source, sourceId)` with no board for all three.
 */
export const GLOBAL_ID_PLATFORMS: ReadonlySet<AtsIdPlatform> = new Set<AtsIdPlatform>(['greenhouse', 'lever', 'ashby']);

/** The scope within which two different ids of a company prove two jobs: the platform when its ids are global, else the board. */
export const idScope = (platform: AtsIdPlatform, board: string): string => (GLOBAL_ID_PLATFORMS.has(platform) ? platform : `${platform}:${board}`);

export interface AtsRef {
  readonly platform: AtsIdPlatform;
  readonly board: string | null;
  readonly id: string;
}

const DIGITS = /^\d{1,20}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** A board token, Lever site, Ashby board or Workday tenant: one URL path segment or host label, no separators. */
const BOARD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
/** A Workday req id as `reqIdOf` accepts it (`JR2026776`, `R-292398-1`). */
const REQ_ID = /^[A-Za-z0-9-]{1,64}$/u;

/** The canonical form of a ref (case folded where the platform ignores case), or null when a part has the wrong shape. */
export function normalAtsRef(platform: AtsIdPlatform, board: string | null, id: string): AtsRef | null {
  const b = board === null ? null : board.trim();
  const i = id.trim();
  if (b !== null && !BOARD.test(b)) return null;
  switch (platform) {
    case 'greenhouse':
      return DIGITS.test(i) ? { platform, board: b === null ? null : b.toLowerCase(), id: i } : null;
    case 'lever':
      return b !== null && UUID.test(i.toLowerCase()) ? { platform, board: b.toLowerCase(), id: i.toLowerCase() } : null;
    case 'ashby':
      return b !== null && UUID.test(i.toLowerCase()) ? { platform, board: b, id: i.toLowerCase() } : null;
    case 'workday':
      return b !== null && REQ_ID.test(i) ? { platform, board: b.toLowerCase(), id: i } : null;
  }
}

/** `<platform>:<board>:<id>`, the key two postings must share to be one job; null while the board is unknown. */
export function atsJobKey(ref: AtsRef): string | null {
  return ref.board === null ? null : `${ref.platform}:${ref.board}:${ref.id}`;
}

/**
 * The ref of an ATS adapter's own posting, from its identity: the watchlist adapters' `sourceId` is the platform job id
 * and their `slug` the board. Their Posting therefore needs no extra field and stays byte-identical to main's. Any other
 * source (a feed, a careers page, a registry adapter) has none here.
 */
export function atsRefFromIdentity(source: string, slug: string, sourceId: string): AtsRef | null {
  if (source === 'greenhouse' || source === 'lever' || source === 'ashby') return normalAtsRef(source, slug, sourceId);
  return null;
}

const hostIs = (host: string, re: RegExp): boolean => re.test(host);

/** The ref one URL states unambiguously, or null (also for a URL that is not one). */
function refOfUrl(raw: string): AtsRef | null | 'ambiguous' {
  // Every parse is total: `new URL` is the one call that throws (caught); URLSearchParams decodes a bad escape to U+FFFD
  // (then not digits, so no id) and path segments are read raw. An uncertain id is null, never an exception.
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter((s) => s !== '');
  // Greenhouse: a board job URL, the embed form, or a company page's gh_jid marker.
  if (hostIs(host, /^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/u)) {
    if (seg[0] === 'embed') {
      const fors = u.searchParams.getAll('for');
      const tokens = u.searchParams.getAll('token');
      if (fors.length !== 1 || tokens.length !== 1) return fors.length + tokens.length > 2 ? 'ambiguous' : null;
      return normalAtsRef('greenhouse', fors[0] as string, tokens[0] as string);
    }
    if (seg.length >= 3 && seg[1] === 'jobs') return normalAtsRef('greenhouse', seg[0] as string, seg[2] as string);
  }
  const ghJids = u.searchParams.getAll('gh_jid');
  if (ghJids.length > 1) return new Set(ghJids).size > 1 ? 'ambiguous' : normalAtsRef('greenhouse', null, ghJids[0] as string);
  if (ghJids.length === 1) return normalAtsRef('greenhouse', null, ghJids[0] as string);
  // Lever: jobs.lever.co/<site>/<uuid>[/apply]
  if (hostIs(host, /^jobs(?:\.eu)?\.lever\.co$/u) && seg.length >= 2) return normalAtsRef('lever', seg[0] as string, seg[1] as string);
  // Ashby: jobs.ashbyhq.com/<board>/<uuid>[/application]
  // Fix round 1 (I1): no percent-decoding anywhere here: a raw segment with an escape fails BOARD's shape and gives no
  // id, so a malformed escape (`%E0%A4%A`) can never throw out of the normalizer and drop the job
  if (host === 'jobs.ashbyhq.com' && seg.length >= 2) return normalAtsRef('ashby', seg[0] as string, seg[1] as string);
  // Workday: <tenant>.wdN.myworkdayjobs.com/[<locale>/]<site>/job/<location>/<title>_<reqId>
  const wd = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/u.exec(host);
  if (wd !== null) {
    const job = seg.indexOf('job');
    const last = seg.at(-1) ?? '';
    const cut = last.lastIndexOf('_');
    // a `job` segment after the site, and a last segment `<title>_<reqId>` (when `job` is itself last, it has no `_`)
    if (job < 1 || cut < 0) return null;
    return normalAtsRef('workday', wd[1] as string, last.slice(cut + 1));
  }
  return null;
}

/**
 * The one ATS ref a company page states through its URLs (the page URL, the JobPosting `url` and `sameAs`), or null:
 * none, or two that disagree (two ids, two platforms, or two boards for one id). A board-less `gh_jid` and a boarded
 * Greenhouse URL of the same id agree, and the board is kept.
 */
export function atsRefFromUrls(urls: readonly string[]): AtsRef | null {
  let found: AtsRef | null = null;
  for (const url of urls) {
    if (typeof url !== 'string' || url.trim() === '') continue;
    const r = refOfUrl(url);
    if (r === 'ambiguous') return null;
    if (r === null) continue;
    if (found === null) {
      found = r;
      continue;
    }
    if (found.platform !== r.platform || found.id !== r.id) return null;
    if (found.board !== null && r.board !== null && found.board !== r.board) return null;
    if (found.board === null) found = r;
  }
  return found;
}

/** A posting's ref: the one the normalizer recorded (a company page, a registry adapter), else its adapter identity. */
export function atsRefOf(p: { readonly source: string; readonly slug: string; readonly sourceId: string; readonly atsRef?: AtsRef | undefined }): AtsRef | null {
  return p.atsRef ?? atsRefFromIdentity(p.source, p.slug, p.sourceId);
}
