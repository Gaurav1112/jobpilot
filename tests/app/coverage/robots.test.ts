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
    expect(robotsDenial({ kind: 'disallow-all', why: '503' }, u)).toBe('robots-unavailable');
    expect(robotsDenial({ kind: 'challenge', why: 'x' }, u)).toBe('challenge');
    expect(robotsDenial({ kind: 'rules', robots: parseRobots('User-agent: *\nDisallow: /careers?') }, u)).toBe('robots-disallow /careers');
    expect(robotsDenial({ kind: 'rules', robots: parseRobots('User-agent: *\nDisallow: /jobs') }, u)).toBeNull();
  });
});
