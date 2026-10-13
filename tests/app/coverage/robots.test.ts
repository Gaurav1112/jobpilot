import { describe, expect, it } from 'vitest';
import { parseRobots, robotsAllows, robotsDenial } from '../../../src/app/coverage/robots.js';

const ok = (txt: string, path: string, agent?: string): boolean => robotsAllows(parseRobots(txt), path, agent);

describe('robots matcher (RFC 9309)', () => {
  it('allows everything when there are no rules, or an empty Disallow', () => {
    expect(ok('', '/careers')).toBe(true);
    expect(ok('User-agent: *\nDisallow:', '/careers')).toBe(true);
  });

  it('the longest matching pattern wins', () => {
    const t = 'User-agent: *\nDisallow: /company\nAllow: /company/careers';
    expect(ok(t, '/company/careers')).toBe(true);
    expect(ok(t, '/company/careers/eng')).toBe(true);
    expect(ok(t, '/company/about')).toBe(false);
  });

  it('allow wins a tie in length', () => {
    expect(ok('User-agent: *\nDisallow: /jobs\nAllow: /jobs', '/jobs')).toBe(true);
    expect(ok('User-agent: *\nAllow: /jobs\nDisallow: /jobs', '/jobs')).toBe(true);
  });

  it('a more specific disallow beats a shorter allow', () => {
    const t = 'User-agent: *\nAllow: /\nDisallow: /careers';
    expect(ok(t, '/careers')).toBe(false);
    expect(ok(t, '/about')).toBe(true);
  });

  it('* matches any run of characters', () => {
    const t = 'User-agent: *\nDisallow: /*/careers\nDisallow: /tmp*draft';
    expect(ok(t, '/en/careers')).toBe(false);
    expect(ok(t, '/careers')).toBe(true);
    expect(ok(t, '/tmp-x-draft')).toBe(false);
  });

  it('$ anchors the end of the path', () => {
    const t = 'User-agent: *\nDisallow: /*.pdf$';
    expect(ok(t, '/files/a.pdf')).toBe(false);
    expect(ok(t, '/files/a.pdf?x=1')).toBe(true);
    expect(ok(t, '/files/a.pdfx')).toBe(true);
  });

  it('matches from the start of the path, and regex characters are literal', () => {
    const t = 'User-agent: *\nDisallow: /a.b';
    expect(ok(t, '/a.b')).toBe(false);
    expect(ok(t, '/axb')).toBe(true);
    expect(ok(t, '/x/a.b')).toBe(true);
  });

  it('uses the jobpilot group in preference to *, whatever the order', () => {
    const t = 'User-agent: *\nDisallow: /\n\nUser-agent: JobPilot/0.1\nAllow: /\nDisallow: /private';
    expect(ok(t, '/careers')).toBe(true);
    expect(ok(t, '/private/x')).toBe(false);
    expect(ok(t, '/careers', '*')).toBe(false);
  });

  it('falls back to * and merges consecutive User-agent lines into one group', () => {
    const t = 'User-agent: googlebot\nUser-agent: *\nDisallow: /x';
    expect(ok(t, '/x')).toBe(false);
    expect(ok('User-agent: googlebot\nDisallow: /', '/x')).toBe(true);
  });

  it('merges separate groups of the same agent', () => {
    const t = 'User-agent: jobpilot\nDisallow: /a\n\nUser-agent: jobpilot\nDisallow: /b';
    expect(ok(t, '/a')).toBe(false);
    expect(ok(t, '/b')).toBe(false);
    expect(ok(t, '/c')).toBe(true);
  });

  it('ignores comments, case of directives, BOM and CRLF; collects Sitemap lines', () => {
    const t = '﻿USER-AGENT: *  # all\r\nDISALLOW: /p # private\r\nSitemap: https://x.test/s.xml\r\n';
    const r = parseRobots(t);
    expect(robotsAllows(r, '/p')).toBe(false);
    expect(r.sitemaps).toEqual(['https://x.test/s.xml']);
  });

  it('robotsDenial maps each verdict kind to a reason or null', () => {
    const u = new URL('https://x.test/careers?x=1');
    expect(robotsDenial({ kind: 'allow-all', why: '404' }, u)).toBeNull();
    expect(robotsDenial({ kind: 'disallow-all', reason: 'robots-unavailable', why: '503' }, u)).toBe('robots-unavailable');
    expect(robotsDenial({ kind: 'disallow-all', reason: 'robots-forbidden', why: '403' }, u)).toBe('robots-forbidden');
    expect(robotsDenial({ kind: 'rules', robots: parseRobots('User-agent: *\nDisallow: /careers?') }, u)).toBe('robots-disallow /careers');
    expect(robotsDenial({ kind: 'rules', robots: parseRobots('User-agent: *\nDisallow: /jobs') }, u)).toBeNull();
  });

  it('is linear: a pathological wildcard pattern on a 200-char path finishes fast', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*a*a*a*a*a*a*a*a*a*a*a*ab');
    const path = '/' + 'a'.repeat(199);
    const t0 = performance.now();
    expect(robotsAllows(r, path)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(robotsAllows(r, path + 'b')).toBe(false);
  });

  it('wildcards: ordered segments, trailing * and * then $', () => {
    expect(ok('User-agent: *\nDisallow: /a*b*c$', '/aXbYc')).toBe(false);
    expect(ok('User-agent: *\nDisallow: /a*b*c$', '/aXcYb')).toBe(true);
    expect(ok('User-agent: *\nDisallow: /a*', '/a')).toBe(false);
    expect(ok('User-agent: *\nDisallow: /*$', '/anything')).toBe(false);
  });

  it('percent-encoding: raw non-ASCII vs encoded, either side', () => {
    expect(ok('User-agent: *\nDisallow: /café', '/caf%C3%A9')).toBe(false);
    expect(ok('User-agent: *\nDisallow: /caf%C3%A9', '/café')).toBe(false);
    expect(ok('User-agent: *\nDisallow: /採用', '/%E6%8E%A1%E7%94%A8')).toBe(false);
  });
  it('percent-encoding: unreserved are decoded, hex case is folded, %2F is kept', () => {
    expect(ok('User-agent: *\nDisallow: /%7Ejoe', '/~joe')).toBe(false);
    expect(ok('User-agent: *\nDisallow: /~joe', '/%7ejoe')).toBe(false);
    expect(ok('User-agent: *\nDisallow: /caf%c3%a9', '/caf%C3%A9')).toBe(false);
    expect(ok('User-agent: *\nDisallow: /a%2Fb', '/a/b')).toBe(true);
    expect(ok('User-agent: *\nDisallow: /a%2fb', '/a%2Fb')).toBe(false);
  });

  it('non-rule lines (Crawl-delay, Sitemap) between User-agent lines do not split the group', () => {
    const t = 'User-agent: jobpilot\nCrawl-delay: 5\nSitemap: https://x.test/s.xml\nUser-agent: other\nDisallow: /x';
    expect(ok(t, '/x')).toBe(false);
    expect(ok(t, '/x', 'other')).toBe(false);
  });

  it('BOM, CRLF and comments', () => {
    expect(ok('\uFEFF# top\r\nUser-agent: * # everyone\r\nDisallow: /p # secret\r\n', '/p')).toBe(false);
    expect(ok('User-agent: *\r\n# Disallow: /p\r\nDisallow: /q\r\n', '/p')).toBe(true);
  });
});
