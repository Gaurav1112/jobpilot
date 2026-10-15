import { defineAgent, type Agent } from '../../../kernel/agent.js';
import { defineContract, type Contract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import { GigRequest, RawGig } from '../types.js';
import { finishGigs, isRecord } from './common.js';
import { GITHUB_API_HOST, githubJson, makeGithubHosts, type GithubHosts } from './github.js';

/**
 * `src-draftdev`: Draft.dev's public hiring repo `github.com/draftdev/jobs`, read through the GitHub contents API
 * (the shared rules of `github.ts`: one host, one request budget, a refusal disables the host for the run):
 * 1. `GET /repos/draftdev/jobs/contents/` (the root listing);
 * 2. `GET /repos/draftdev/jobs/contents/<name>` for `README.md` and each other root `*.md` (never `archive/`), at most
 *    DRAFTDEV_MAX_FILES role files (more: `input_rejected` `draftdev: N role files over the cap of 8`, before any
 *    file is read), base64 `content` decoded.
 * Gigs:
 * - README's `## Open Roles` bullets, `- **[<Title>](<url>) (<pay>)** - <text>`: one gig each, sourceId
 *   `readme:<title slug>`, url the bullet's link;
 * - each role file whose H1 is `# <Title> at [Draft.dev](…)` and does NOT end with `| CLOSED`: one gig, sourceId
 *   `file:<name>`, url the file's `html_url`; its first `> …` line is the summary (pay, hours, location); a closed file
 *   is counted in one note `draftdev: N closed roles skipped`.
 * raw: `{ title, url, summary, text (≤ 4000 chars of the markdown, links kept as text), file, sha, readmeRemoteGlobal }`;
 * for a README bullet `summary` is its pay in the parentheses.
 *
 * Parsing is linear: forward `indexOf` scans, line by line, no backtracking regex over a document body.
 */
export const DRAFTDEV_MAX_FILES = 8;
const REPO = '/repos/draftdev/jobs/contents/';
const TEXT_MAX = 4000;
/** A role file's text is cut here before it is touched, so no scan can be longer than this. */
const SCAN_MAX = 64_000;

export function srcDraftdevContract(): Contract<GigRequest, RawGig> {
  return defineContract({
    id: 'src-draftdev',
    version: '1.0.0',
    description: "Reads Draft.dev's open writer roles from its public GitHub repo",
    skills: ['gig-sourcing'],
    // A team of its own: its breaker opens on its own failures only (pipeline.ts).
    team: 'sourcing-draftdev',
    kind: 'io',
    consumes: GigRequest,
    produces: RawGig,
    capabilities: { http: true },
    egress: [GITHUB_API_HOST],
    dataClasses: { in: ['P0'], out: ['P0'] },
    budget: { usdPerCall: 0, usdPerRun: 0 },
    // Up to 10 requests, 2 s apart.
    timeoutMs: 60_000,
    // Never `rate_limit` or a refusal: those disable the host for the run instead.
    retry: { max: 1, on: ['overloaded', 'network', 'timeout'], backoffMs: [8000] },
  });
}

const lines = function* (s: string): Generator<string> {
  let at = 0;
  while (at <= s.length) {
    const nl = s.indexOf('\n', at);
    const end = nl === -1 ? s.length : nl;
    yield s.slice(at, end).replace(/\r$/, '');
    if (nl === -1) return;
    at = nl + 1;
  }
};

/** `[text](url)` becomes `text`; any other bracket stays. Forward scans only, and only over the first SCAN_MAX characters. */
function linksAsText(md: string): string {
  const s = md.slice(0, SCAN_MAX);
  let out = '';
  let at = 0;
  let open = s.indexOf('[');
  let mid = -1;
  while (open !== -1) {
    if (mid <= open) mid = s.indexOf('](', open + 1);
    if (mid === -1) break;
    const next = s.indexOf('[', open + 1);
    // A nearer '[' before the '](' is the real link start: hop to it (the '](' search is cached).
    if (next !== -1 && next < mid) {
      open = next;
      continue;
    }
    const close = s.indexOf(')', mid + 2);
    if (close === -1) break;
    out += s.slice(at, open) + s.slice(open + 1, mid);
    at = close + 1;
    open = s.indexOf('[', at);
  }
  return out + s.slice(at);
}

/** The README's `## Open Roles` bullets `- **[<Title>](<url>) (<pay>)** - <text>`. */
export function parseOpenRoles(readme: string): { title: string; url: string; pay: string | null; text: string }[] {
  const roles: { title: string; url: string; pay: string | null; text: string }[] = [];
  let inSection = false;
  for (const line of lines(readme)) {
    if (line.startsWith('#')) {
      inSection = line.replace(/^#+/, '').trim().toLowerCase() === 'open roles' && line.startsWith('## ');
      continue;
    }
    if (!inSection || !line.startsWith('- **[')) continue;
    const mid = line.indexOf('](', 5);
    if (mid === -1) continue;
    const urlEnd = line.indexOf(')', mid + 2);
    if (urlEnd === -1) continue;
    const title = line.slice(5, mid).trim();
    const url = line.slice(mid + 2, urlEnd).trim();
    if (title === '' || !url.startsWith('https://')) continue;
    let rest = line.slice(urlEnd + 1);
    let pay: string | null = null;
    if (rest.startsWith(' (')) {
      const close = rest.indexOf(')**');
      if (close === -1) continue;
      pay = rest.slice(2, close).trim() || null;
      rest = rest.slice(close + 3);
    } else if (rest.startsWith('**')) rest = rest.slice(2);
    else continue;
    const text = linksAsText(rest.replace(/^\s*-\s*/, '')).replace(/\s+/g, ' ').trim();
    roles.push({ title, url, pay, text });
  }
  return roles;
}

const AT_DRAFT = ' at [Draft.dev]';

/** A role file: `# <Title> at [Draft.dev](…)` (optionally `| CLOSED`) and its first `> …` line; null when it is no role file. */
export function parseRoleFile(md: string): { title: string; closed: boolean; summary: string | null } | null {
  let head: string | undefined;
  let summary: string | null = null;
  for (const line of lines(md.slice(0, SCAN_MAX))) {
    if (head === undefined) {
      if (line.trim() === '') continue;
      head = line;
      continue;
    }
    if (line.startsWith('>')) {
      summary = line.replace(/^>\s*/, '').trim() || null;
      break;
    }
  }
  if (head === undefined || !head.startsWith('# ')) return null;
  const at = head.indexOf(AT_DRAFT);
  if (at === -1) return null;
  const title = head.slice(2, at).trim();
  if (title === '') return null;
  return { title, closed: head.trimEnd().toUpperCase().endsWith('| CLOSED'), summary };
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** A contents-API file object's text: base64 `content` (GitHub wraps it at 60 columns), UTF-8. */
function contentOf(v: unknown, what: string): { text: string; sha: string; htmlUrl: string | null } {
  if (!isRecord(v) || v.encoding !== 'base64' || typeof v.content !== 'string') throw new KernelError('invalid_output', `draftdev: ${what} is not a base64 file answer`);
  return {
    text: Buffer.from(v.content.replace(/\s+/g, ''), 'base64').toString('utf8'),
    sha: typeof v.sha === 'string' ? v.sha : '',
    htmlUrl: typeof v.html_url === 'string' && v.html_url.startsWith('https://github.com/') ? v.html_url : null,
  };
}

export function makeSrcDraftdev(hosts: GithubHosts = makeGithubHosts()): Agent<GigRequest, RawGig> {
  return defineAgent(srcDraftdevContract(), async (req, ctx) => {
    if (req.platform !== 'draftdev') return [];
    const listing = await githubJson(ctx, hosts, REPO);
    if (!Array.isArray(listing)) throw new KernelError('invalid_output', 'draftdev: the repo listing is not an array');
    const names = listing.flatMap((e: unknown) => (isRecord(e) && e.type === 'file' && typeof e.name === 'string' && e.name.endsWith('.md') ? [e.name] : []));
    const roleFiles = names.filter((n) => n !== 'README.md').sort();
    if (roleFiles.length > DRAFTDEV_MAX_FILES) throw new KernelError('input_rejected', `draftdev: ${roleFiles.length} role files over the cap of ${DRAFTDEV_MAX_FILES}`);
    const gigs: RawGig[] = [];
    const notes: string[] = [];
    let remoteGlobal = false;
    const read = async (name: string) => contentOf(await githubJson(ctx, hosts, REPO + encodeURIComponent(name)), name);
    if (names.includes('README.md')) {
      const readme = await read('README.md');
      remoteGlobal = /remote,\s*global team/i.test(readme.text.slice(0, SCAN_MAX));
      for (const role of parseOpenRoles(readme.text)) {
        gigs.push({
          platform: 'draftdev',
          sourceId: `readme:${slug(role.title)}`,
          raw: { title: role.title, url: role.url, summary: role.pay, text: role.text.slice(0, TEXT_MAX), file: 'README.md', sha: readme.sha, readmeRemoteGlobal: remoteGlobal },
        });
      }
    }
    let closed = 0;
    for (const name of roleFiles) {
      const file = await read(name);
      const role = parseRoleFile(file.text);
      if (role === null) {
        notes.push(`draftdev: ${name} is not a role file`);
        continue;
      }
      if (role.closed) {
        closed += 1;
        continue;
      }
      gigs.push({
        platform: 'draftdev',
        sourceId: `file:${name}`,
        raw: {
          title: role.title,
          url: file.htmlUrl ?? `https://github.com/draftdev/jobs/blob/main/${encodeURIComponent(name)}`,
          summary: role.summary,
          text: linksAsText(file.text).slice(0, TEXT_MAX),
          file: name,
          sha: file.sha,
          readmeRemoteGlobal: remoteGlobal,
        },
      });
    }
    if (closed > 0) notes.push(`draftdev: ${closed} closed roles skipped`);
    if (notes.length > 0) ctx.skipped(notes);
    return finishGigs(gigs);
  });
}

/** The agent for exports and tests; the run builds its own on the run's shared GitHub host state (`freelanceAgents`). */
export const srcDraftdev = makeSrcDraftdev();
