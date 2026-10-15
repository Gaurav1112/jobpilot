/**
 * robots.txt (RFC 9309): a parser, the matcher, and the fetch rules the careers locator follows.
 *
 * Group choice: the groups naming the product token (`jobpilot`, case-insensitive, a `/version` suffix ignored) are
 * merged and used alone; without one, the `*` groups; without either, everything is allowed.
 * Rule choice: the longest matching pattern wins, and `Allow` wins a tie. `*` matches any run of characters and a
 * trailing `$` anchors the end. An empty `Disallow` (allow all) and an empty `Allow` are ignored.
 * Matching is linear (no RegExp is built from robots input): the pattern is split at `*` and its pieces are found in
 * order, each at its leftmost position. Pattern and path are first normalised (RFC 9309 §2.2.2): raw non-ASCII is
 * percent-encoded as UTF-8, `%xx` hex is upper-cased, `%xx` of an unreserved character (A-Z a-z 0-9 - . _ ~) is decoded,
 * and everything else (notably `%2F`) stays encoded.
 */

export const PRODUCT_TOKEN = 'jobpilot';

export interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
}

export interface RobotsGroup {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
}

export interface Robots {
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly string[];
}

/** What a host's robots.txt allows, as the locator holds it for one run. */
export type RobotsVerdict =
  | { readonly kind: 'rules'; readonly robots: Robots }
  | { readonly kind: 'allow-all'; readonly why: string }
  | {
      readonly kind: 'disallow-all';
      /**
       * `robots-forbidden` (401/403) and `robots-unavailable` (another 3xx/4xx, a moved or unreadable file) are answers;
       * `no-such-host` (DNS has no such name, the machine online) is a fact about the host; `robots-transient` (a network
       * error, a timeout, a 5xx) is neither: it is asked again later, never kept as the run's verdict.
       */
      readonly reason: 'robots-unavailable' | 'robots-forbidden' | 'robots-transient' | 'no-such-host';
      readonly why: string;
      /** For `robots-transient`: the transport code a step resting on it fails with. */
      readonly transient?: 'network' | 'timeout' | 'overloaded';
    };

export function parseRobots(text: string): Robots {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  const sitemaps: string[] = [];
  let cur: { agents: string[]; rules: RobotsRule[] } | null = null;
  let collectingAgents = false;
  for (const raw of text.replace(/^﻿/u, '').split(/\r\n|\r|\n/u)) {
    const line = raw.replace(/#.*$/u, '').trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (cur === null || !collectingAgents) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      collectingAgents = true;
      cur.agents.push(value.toLowerCase().split('/')[0] ?? '');
    } else if (key === 'allow' || key === 'disallow') {
      collectingAgents = false;
      if (cur !== null && value !== '') cur.rules.push({ allow: key === 'allow', pattern: value });
    } else if (key === 'sitemap') {
      if (value !== '') sitemaps.push(value);
    }
    // any other line (Crawl-delay, Host, ...) neither opens nor closes a group, as in Google's parser
  }
  return { groups, sitemaps };
}

const UNRESERVED = /^[A-Za-z0-9\-._~]$/u;

/** Percent-encoding normal form (see the header); `*` and `$` pass through unchanged. */
export function normalizeEncoding(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; ) {
    const ch = s.codePointAt(i) as number;
    const c = String.fromCodePoint(ch);
    if (c === '%' && /^[0-9A-Fa-f]{2}$/u.test(s.slice(i + 1, i + 3))) {
      const hex = s.slice(i + 1, i + 3).toUpperCase();
      const dec = String.fromCharCode(Number.parseInt(hex, 16));
      out += UNRESERVED.test(dec) ? dec : `%${hex}`;
      i += 3;
      continue;
    }
    if (ch > 0x7f) for (const b of Buffer.from(c, 'utf8')) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    else out += c;
    i += c.length;
  }
  return out;
}

/** Linear wildcard match of a normalised pattern at the start of a normalised path. */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  if (parts.length === 1) return anchored ? path === parts[0] : path.startsWith(parts[0] as string);
  const first = parts[0] as string;
  if (!path.startsWith(first)) return false;
  let pos = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const idx = path.indexOf(parts[i] as string, pos);
    if (idx < 0) return false;
    pos = idx + (parts[i] as string).length;
  }
  const last = parts[parts.length - 1] as string;
  if (anchored) return path.length - last.length >= pos && path.endsWith(last);
  return path.indexOf(last, pos) >= 0;
}

/** The rules that apply to `agent`: its own groups merged, else the `*` groups, else none. */
export function rulesFor(robots: Robots, agent: string = PRODUCT_TOKEN): RobotsRule[] {
  const a = agent.toLowerCase();
  const own = robots.groups.filter((g) => g.agents.includes(a));
  const chosen = own.length > 0 ? own : robots.groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => [...g.rules]);
}

/** May `agent` fetch `pathAndQuery` (e.g. `/careers?x=1`)? Longest match wins; allow wins a tie; no match means allowed. */
export function robotsAllows(robots: Robots, pathAndQuery: string, agent: string = PRODUCT_TOKEN): boolean {
  const path = normalizeEncoding(pathAndQuery);
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rulesFor(robots, agent)) {
    const pattern = normalizeEncoding(r.pattern);
    if (!matches(pattern, path)) continue;
    if (best === null || pattern.length > best.len || (pattern.length === best.len && r.allow && !best.allow)) best = { allow: r.allow, len: pattern.length };
  }
  return best === null || best.allow;
}

/**
 * The rules a robots.txt BODY carries, whatever its status, or null. Strict, so an error page never counts: no HTML
 * (`<html`, `<!doctype`, `<body`, `<head`), and at least one group whose `User-agent:` line is followed by an `Allow:`
 * or `Disallow:` line (a rule with a non-empty path). A body with only a Sitemap, a Crawl-delay or prose is null.
 */
export function robotsInBody(body: string): Robots | null {
  if (/<\s*(?:!doctype|html|body|head)\b/iu.test(body)) return null;
  const parsed = parseRobots(body);
  return parsed.groups.some((g) => g.agents.length > 0 && g.rules.length > 0) ? parsed : null;
}

/**
 * The verdict of a robots.txt that answered `status` with `body` (no redirect, no challenge, no 429: the caller
 * handles those): 404/410 allows all, unless the body carries rules (`robotsInBody`): then those rules apply
 * (controller decision 2026-10-15, the user's rule "no scraping against robots.txt"; Himalayas serves its rules with a
 * 404). Rules never loosen a stricter verdict, so a 401/403 or another 4xx stays a refusal whatever its body; 401/403 disallows the host (`robots-forbidden`); a 5xx disallows it for now
 * (`robots-transient`: the server is in trouble, ask again later, C1); any other 3xx or 4xx disallows it
 * (`robots-unavailable`, RFC 9309's conservative choice); a 2xx is parsed.
 */
export function robotsVerdictOf(status: number, body: string): RobotsVerdict {
  if (status === 404 || status === 410) {
    const rules = robotsInBody(body);
    return rules === null ? { kind: 'allow-all', why: `robots.txt ${status}` } : { kind: 'rules', robots: rules };
  }
  if (status === 401 || status === 403) return { kind: 'disallow-all', reason: 'robots-forbidden', why: `robots.txt ${status}` };
  if (status >= 500 && status < 600) return { kind: 'disallow-all', reason: 'robots-transient', why: `robots.txt ${status}`, transient: 'overloaded' };
  if (status >= 300 || status < 200) return { kind: 'disallow-all', reason: 'robots-unavailable', why: `robots.txt ${status}` };
  return { kind: 'rules', robots: parseRobots(body) };
}

/** May the verdict's host be asked for this URL? Returns null when yes, else the reason. */
export function robotsDenial(v: RobotsVerdict, url: URL): string | null {
  switch (v.kind) {
    case 'allow-all':
      return null;
    case 'rules':
      return robotsAllows(v.robots, url.pathname + url.search) ? null : `robots-disallow ${url.pathname}`;
    case 'disallow-all':
      return v.reason;
  }
}
