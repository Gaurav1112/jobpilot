import { describe, expect, it } from 'vitest';
import { sitemapLocs } from '../../../src/app/coverage/locator.js';

describe('sitemapLocs is linear (fix round 1)', () => {
  const MB = 1 << 20;
  const rep = (x: string): string => x.repeat(Math.ceil(MB / x.length)).slice(0, MB);
  const time = (f: () => unknown): number => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };
  it('1 MB of adversarial input in < 100 ms', () => {
    expect(time(() => sitemapLocs(`<loc>${rep(' ')}`))).toBeLessThan(100);
    expect(time(() => sitemapLocs(rep('<loc> ')))).toBeLessThan(100);
    expect(time(() => sitemapLocs(`<loc><![CDATA[${rep(' ')}`))).toBeLessThan(100);
    expect(time(() => sitemapLocs(rep('<loc>x</loc>')))).toBeLessThan(500);
  });
  it('keeps the same results: trimmed, CDATA, entities, empty and unclosed locs', () => {
    expect(sitemapLocs('<loc> https://a.test/x </loc><loc><![CDATA[ https://a.test/y ]]></loc><LOC>https://a.test/z?a=1&amp;b=2</LOC>')).toEqual(['https://a.test/x', 'https://a.test/y', 'https://a.test/z?a=1&b=2']);
    expect(sitemapLocs('<loc></loc><loc>  </loc><loc>https://a.test/open')).toEqual([]);
  });
});
