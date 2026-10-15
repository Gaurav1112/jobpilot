import { describe, expect, it } from 'vitest';
import { readUstar } from '../../scripts/ustar.js';
import { buildTar } from '../support/tar.js';

describe('scripts/ustar: the minimal reader', () => {
  it('reads regular files with their prefix and name, skipping directories and a pax global header', () => {
    const tar = buildTar([
      { name: 'pax_global_header', type: 'g', data: '52 comment=96b53a2c7b1e545bbad0868e16ec85a2eba4f36a\n' },
      { name: 'repo-1/', type: '5' },
      { name: 'repo-1/link', type: '2' },
      { name: 'repo-1/a.yml', data: '- company: A\n' },
      { name: 'ignored', prefix: 'repo-1/sources', short: 'b.yml', data: 'bee' },
    ]);
    const files = readUstar(tar);
    expect(files.map((f) => f.path)).toEqual(['repo-1/a.yml', 'repo-1/sources/b.yml']);
    expect(files.map((f) => f.data.toString('utf8'))).toEqual(['- company: A\n', 'bee']);
  });

  it('refuses a header without the ustar magic', () => {
    const tar = buildTar([{ name: 'a.txt', data: 'x' }]);
    tar.fill(0, 257, 262);
    expect(() => readUstar(tar)).toThrow(/ustar/u);
  });

  it('refuses a size field that runs past the end of the archive', () => {
    const tar = buildTar([{ name: 'a.txt', data: 'x' }]).subarray(0, 512);
    tar.write('00000001000\0', 124);
    let sum = 0;
    tar.fill(0x20, 148, 156);
    for (const b of tar) sum += b;
    tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    expect(() => readUstar(tar)).toThrow(/past the end/u);
  });

  it('refuses a bad checksum and an entry type it does not read', () => {
    const bad = buildTar([{ name: 'a.txt', data: 'x' }]);
    bad.write('0', 0);
    expect(() => readUstar(bad)).toThrow(/checksum/u);
    expect(() => readUstar(buildTar([{ name: 'dev', type: '3' }]))).toThrow(/entry type/u);
  });
});
