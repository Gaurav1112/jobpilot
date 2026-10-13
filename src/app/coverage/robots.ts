/**
 * robots.txt (RFC 9309): a parser, the matcher, and the fetch rules the careers locator follows.
 *
 * Group choice: the groups naming the product token (`jobpilot`, case-insensitive, a `/version` suffix ignored) are
 * merged and used alone; without one, the `*` groups; without either, everything is allowed.
 * Rule choice: the longest matching pattern wins, and `Allow` wins a tie. `*` matches any run of characters and a
 * trailing `$` anchors the end. An empty `Disallow` (allow all) and an empty `Allow` are ignored. Patterns are
 * compared with the request's path and query as they are written (no percent-decoding).
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
  | { readonly kind: 'disallow-all'; readonly why: string }
  | { readonly kind: 'challenge'; readonly why: string };

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
    } else {
      collectingAgents = false;
    }
  }
  return { groups, sitemaps };
}

const toRegExp = (pattern: string): RegExp => {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`, 'u');
};

/** The rules that apply to `agent`: its own groups merged, else the `*` groups, else none. */
export function rulesFor(robots: Robots, agent: string = PRODUCT_TOKEN): RobotsRule[] {
  const a = agent.toLowerCase();
  const own = robots.groups.filter((g) => g.agents.includes(a));
  const chosen = own.length > 0 ? own : robots.groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => [...g.rules]);
}

/** May `agent` fetch `pathAndQuery` (e.g. `/careers?x=1`)? Longest match wins; allow wins a tie; no match means allowed. */
export function robotsAllows(robots: Robots, pathAndQuery: string, agent: string = PRODUCT_TOKEN): boolean {
  let best: RobotsRule | null = null;
  for (const r of rulesFor(robots, agent)) {
    if (!toRegExp(r.pattern).test(pathAndQuery)) continue;
    if (best === null || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
  }
  return best === null || best.allow;
}

/** May the verdict's host be asked for this URL? Returns null when yes, else the reason. */
export function robotsDenial(v: RobotsVerdict, url: URL): string | null {
  switch (v.kind) {
    case 'allow-all':
      return null;
    case 'rules':
      return robotsAllows(v.robots, url.pathname + url.search) ? null : `robots-disallow ${url.pathname}`;
    case 'disallow-all':
      return 'robots-unavailable';
    case 'challenge':
      return 'challenge';
  }
}
