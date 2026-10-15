import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK, decodeKey, JpstError, keyIdOf, openBuffer, parseHeader, sealBuffer } from '../../src/app/hosted/jpst.js';

const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const PREFIX = Buffer.from([0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7]);
const PLAIN = Buffer.from('jobpilot JPST1 known-answer vector\n'.repeat(5)); // 175 bytes
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const seal = (p: Buffer, k = KEY) => sealBuffer(k, p, { chunk: 64, noncePrefix: PREFIX });
const codeOf = async (b: Buffer, k = KEY) => openBuffer(k, b).then(() => 'ok', (e: JpstError) => e.code);
const headerLen = (b: Buffer) => b.indexOf(0x0a, 6) + 1;
const UNIT = 64 + 16;

describe('JPST1 known answers (Node 24 AES-256-GCM)', () => {
  it('seals the vector to fixed bytes', async () => {
    const s = await seal(PLAIN);
    expect(s.subarray(0, headerLen(s)).toString()).toBe('JPST1\n{"chunk":64,"codec":"zstd","keyId":"630dcd29","level":3,"nonce":"a0a1a2a3a4a5a6a7","v":1}\n');
    expect(s.length).toBe(319);
    expect(sha(s)).toBe('5cbe0fe2f59393a608e126819f80864dde3afd4d7176f9e3992d5542614f9873');
    expect(s.subarray(headerLen(s) + 64, headerLen(s) + 80).toString('hex')).toBe('2c45846b86d163083bdab155a730b41f');
    expect((await openBuffer(KEY, s)).equals(PLAIN)).toBe(true);
  });
  it('an empty payload is one empty final chunk', async () => {
    const s = await seal(Buffer.alloc(0));
    expect(s.length).toBe(112);
    expect(sha(s)).toBe('d704dd172d21a8521b8c2544ff8085c463feb181521e4c3acdeec763d77b7643');
    expect((await openBuffer(KEY, s)).length).toBe(0);
  });
  it('a payload of exactly two chunks has no extra chunk', async () => {
    const s = await seal(Buffer.alloc(128, 7));
    expect(s.length - headerLen(s)).toBe(2 * UNIT);
    expect((await openBuffer(KEY, s)).equals(Buffer.alloc(128, 7))).toBe(true);
  });
  it('key ids and key decoding', () => {
    expect(keyIdOf(KEY)).toBe('630dcd29');
    expect(decodeKey(KEY.toString('base64'), 'STATE_KEY').equals(KEY)).toBe(true);
    expect(() => decodeKey('abc', 'STATE_KEY')).toThrow(/^STATE_KEY: expected 32 bytes in standard base64$/);
    expect(DEFAULT_CHUNK).toBe(4 * 1024 * 1024);
  });
});

describe('JPST1 failures each have their own code', () => {
  it('tampered, reordered, truncated, extended, wrong key, bad header, bad magic', async () => {
    const s = await seal(PLAIN);
    const hl = headerLen(s);
    const body = s.subarray(hl);
    const flip = Buffer.from(s); flip[hl + 5] = (flip[hl + 5] as number) ^ 1;
    expect(await codeOf(flip)).toBe('tampered');
    expect(await codeOf(Buffer.concat([s.subarray(0, hl), body.subarray(UNIT, 2 * UNIT), body.subarray(0, UNIT), body.subarray(2 * UNIT)]))).toBe('reordered');
    expect(await codeOf(s.subarray(0, hl + 2 * UNIT))).toBe('truncated');
    expect(await codeOf(Buffer.concat([s, body.subarray(0, UNIT)]))).toBe('extended');
    const exact = await seal(Buffer.alloc(128, 7));
    expect(await codeOf(Buffer.concat([exact, exact.subarray(headerLen(exact), headerLen(exact) + UNIT)]))).toBe('extended');
    const wrong = Buffer.from(KEY); wrong[0] = 1;
    expect(await codeOf(s, wrong)).toBe('wrong-key');
    const nonce = Buffer.from(s); nonce[s.indexOf(Buffer.from('a0a1')) + 1] = 0x31;
    expect(await codeOf(nonce)).toBe('tampered');
    const v = Buffer.from(s); v[hl - 3] = 0x32;
    expect(await codeOf(v)).toBe('bad-header');
    expect(await codeOf(Buffer.from('JPST2\n{}\n'))).toBe('bad-magic');
    expect(await codeOf(s.subarray(0, 10))).toBe('truncated');
    expect(await codeOf(Buffer.concat([s, Buffer.alloc(5)]))).toBe('tampered');
  });
  it('messages never carry key bytes', async () => {
    const e = await openBuffer(Buffer.alloc(32, 9), await seal(PLAIN)).catch((x: Error) => x);
    expect(String(e)).not.toContain(Buffer.alloc(32, 9).toString('base64'));
    expect(String(e)).toMatch(/wrong key \(the file was sealed with key 630dcd29\)/);
  });
  it('parseHeader refuses a non-canonical header', () => {
    expect(() => parseHeader(Buffer.from('JPST1\n{"v":1,"codec":"zstd","level":3,"chunk":64,"keyId":"630dcd29","nonce":"a0a1a2a3a4a5a6a7"}\n'))).toThrow(/not canonical/);
  });
});
