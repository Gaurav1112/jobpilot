import { describe, expect, it } from 'vitest';
import { canonicalJson, hashOf, sha256 } from '../../src/kernel/canonical.js';

describe('canonicalJson', () => {
  it('sorts keys at every depth so insertion order never changes the output', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson({ a: { c: 3, d: 2 }, b: 1 })).toBe(canonicalJson({ b: 1, a: { d: 2, c: 3 } }));
  });

  it('sorts integer-like keys as strings, unlike JSON.stringify', () => {
    expect(canonicalJson({ '2': 'x', '10': 'y', a: 'z' })).toBe('{"10":"y","2":"x","a":"z"}');
  });

  it('drops undefined properties and nulls undefined array items', () => {
    expect(canonicalJson({ a: undefined, b: [1, undefined] })).toBe('{"b":[1,null]}');
  });

  it('normalises -0 to 0', () => {
    expect(canonicalJson(-0)).toBe('0');
  });

  it('throws on values without a stable JSON form', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(/non-finite number at \$\.x/);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/unsupported object at \$\.d/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/unsupported function/);
  });

  it('hashes the canonical form', () => {
    expect(hashOf({ b: 1, a: 2 })).toBe(sha256('{"a":2,"b":1}'));
    expect(hashOf({ a: 2, b: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
