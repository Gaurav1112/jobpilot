/**
 * A minimal ustar reader for the build script (no dependency). It reads 512-byte headers with the `ustar` magic, the
 * `prefix` + `name` path and the octal size, and returns the regular files. Directories and a pax GLOBAL header
 * (`g`, which GitHub's codeload puts first; it names the commit and carries no file) and hard/symbolic links (`1`, `2`:
 * the real repository holds some; they have no data and are never followed) are skipped; anything else is refused, so
 * a tarball with devices or long-name extensions (whose next path would be wrong) is never half-read.
 */
export interface UstarFile {
  readonly path: string;
  readonly data: Buffer;
}

const BLOCK = 512;

function field(h: Buffer, from: number, to: number): string {
  const end = h.indexOf(0, from);
  return h.toString('utf8', from, end < 0 || end > to ? to : end);
}

function octal(h: Buffer, from: number, to: number, what: string): number {
  const s = field(h, from, to).trim();
  if (!/^[0-7]*$/u.test(s)) throw new Error(`ustar: ${what} is not octal`);
  return s === '' ? 0 : Number.parseInt(s, 8);
}

export function readUstar(tar: Buffer): UstarFile[] {
  const files: UstarFile[] = [];
  let at = 0;
  while (at < tar.length) {
    if (at + BLOCK > tar.length) throw new Error('ustar: truncated header');
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) return files;
    if (h.toString('latin1', 257, 262) !== 'ustar') throw new Error(`ustar: header at byte ${at} lacks the ustar magic`);
    const stored = octal(h, 148, 156, 'checksum');
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] as number);
    if (sum !== stored) throw new Error(`ustar: checksum mismatch at byte ${at}`);
    const size = octal(h, 124, 136, 'size');
    const type = String.fromCharCode(h[156] as number);
    const start = at + BLOCK;
    if (start + size > tar.length) throw new Error(`ustar: entry at byte ${at} runs past the end of the archive`);
    if (type === '0' || type === '\0') {
      const prefix = field(h, 345, 500);
      const name = field(h, 0, 100);
      files.push({ path: prefix === '' ? name : `${prefix}/${name}`, data: Buffer.from(tar.subarray(start, start + size)) });
    } else if (type !== '5' && type !== 'g' && type !== '1' && type !== '2') {
      throw new Error(`ustar: unsupported entry type '${type}' at byte ${at}`);
    }
    at = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
