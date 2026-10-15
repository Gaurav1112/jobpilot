import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { checkName, header, tarStream, TarError, untarInto } from '../../src/app/hosted/ustar.js';

const d = mkdtempSync(join(tmpdir(), 'jp-ustar-'));
afterAll(() => rmSync(d, { recursive: true, force: true }));
const all = async (files: Parameters<typeof tarStream>[0]) => { const b: Buffer[] = []; for await (const c of tarStream(files)) b.push(c); return Buffer.concat(b); };

describe('ustar', () => {
  writeFileSync(join(d, 'a.txt'), 'hello');
  mkdirSync(join(d, 'out/k'), { recursive: true });
  writeFileSync(join(d, 'out/k/r.pdf'), Buffer.alloc(1300, 1));
  const files = [{ name: 'out/k/r.pdf', path: join(d, 'out/k/r.pdf') }, { name: 'a.txt', path: join(d, 'a.txt') }];

  it('is deterministic: names sorted, mtime 0, mode 0600 (known answer)', async () => {
    const tar = await all(files);
    expect(tar.length).toBe(4096);
    expect(createHash('sha256').update(tar).digest('hex')).toBe('1933bfcfcc56366133be8ae710c7a8acf3b34a268078482ffe951485e92a7efa');
    writeFileSync(join(d, 'x.tar'), tar);
    // the system tar reads it (bsdtar on macOS, GNU tar on Linux)
    expect(execFileSync('tar', ['-tf', join(d, 'x.tar')], { encoding: 'utf8' })).toBe('a.txt\nout/k/r.pdf\n');
  });
  it('round-trips through untarInto, split at any byte', async () => {
    const tar = await all(files);
    const t = mkdtempSync(join(d, 'x-'));
    const seen: string[] = [];
    await pipeline(Readable.from([tar.subarray(0, 700), tar.subarray(700, 701), tar.subarray(701)]), untarInto(t, (n) => seen.push(n)));
    expect(seen).toEqual(['a.txt', 'out/k/r.pdf']);
    expect(readFileSync(join(t, 'a.txt'), 'utf8')).toBe('hello');
    expect(readFileSync(join(t, 'out/k/r.pdf')).length).toBe(1300);
  });
  it('long names use the prefix field', () => {
    const name = `${'d'.repeat(120)}/${'f'.repeat(90)}`;
    const h = header(name, 0);
    expect(h.subarray(345, 465).toString().replace(/\0+$/, '')).toBe('d'.repeat(120));
  });
  it('refuses unsafe names, duplicates, a truncated archive and a bad checksum', async () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../b', 'a/./b', 'a\\b', 'a\nb', '', 'x'.repeat(256)]) expect(() => checkName(bad), bad).toThrow(TarError);
    await expect(all([files[1]!, files[1]!])).rejects.toThrow(/duplicate entry a\.txt/);
    const tar = await all(files);
    await expect(pipeline(Readable.from([tar.subarray(0, 1024)]), untarInto(mkdtempSync(join(d, 'y-'))))).rejects.toThrow(/ends early/);
    const bad = Buffer.from(tar); bad[0] = 0x62;
    await expect(pipeline(Readable.from([bad]), untarInto(mkdtempSync(join(d, 'z-'))))).rejects.toThrow(/checksum/);
  });
});
