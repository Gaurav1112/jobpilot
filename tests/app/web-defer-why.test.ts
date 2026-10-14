import { describe, expect, it } from 'vitest';
import { deferWhy } from '../../src/app/web/views/companies.js';

describe('deferWhy: a host disable reason in words', () => {
  it('names the C1 reasons: a transient robots.txt failure and a host that does not exist', () => {
    expect(deferWhy('robots-transient')).toBe('robots.txt failed for now (asked again within the hour)');
    expect(deferWhy('no-such-host')).toBe('no such host');
    expect(deferWhy('robots-unavailable')).toBe('robots.txt could not be read');
    expect(deferWhy('http-429')).toBe('rate-limited (HTTP 429)');
  });
});
