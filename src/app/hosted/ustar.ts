import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { Writable } from 'node:stream';

/**
 * The deterministic ustar of the hosted bundles (spec §3.3): names sorted, mode 0600, uid/gid 0, mtime 0, regular files
 * only, so the same names and bytes always give the same archive. The extractor reads only this subset.
 */
export interface TarFile {
  readonly name: string;
  readonly path: string;
}
const BLOCK = 512;
const SAFE_NAME = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+=,~ -]+(?:\/[A-Za-z0-9._@+=,~ -]+)*$/;

export class TarError extends Error {
  override readonly name = 'TarError';
}

export function checkName(name: string): void {
  if (Buffer.byteLength(name) > 255 || !SAFE_NAME.test(name)) throw new TarError(`tar: unsafe or too long entry name ${JSON.stringify(name.slice(0, 80))}`);
}

function splitName(name: string): { prefix: string; base: string } {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', base: name };
  for (let i = name.lastIndexOf('/'); i > 0; i = name.lastIndexOf('/', i - 1)) {
    const prefix = name.slice(0, i);
    const base = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(base) <= 100) return { prefix, base };
  }
  throw new TarError(`tar: ${JSON.stringify(name.slice(0, 80))} does not fit a ustar header`);
}

const octal = (n: number, width: number): string => `${n.toString(8).padStart(width - 1, '0')}\0`;

export function header(name: string, size: number): Buffer {
  checkName(name);
  if (!Number.isSafeInteger(size) || size < 0 || size > 0o77777777777) throw new TarError(`tar: ${name} is too large for ustar`);
  const { prefix, base } = splitName(name);
  const h = Buffer.alloc(BLOCK);
  h.write(base, 0, 100, 'utf8');
  h.write(octal(0o600, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

export async function* tarStream(files: readonly TarFile[]): AsyncGenerator<Buffer> {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.name === sorted[i - 1]!.name) throw new TarError(`tar: duplicate entry ${sorted[i]!.name}`);
  for (const f of sorted) {
    const size = statSync(f.path).size;
    yield header(f.name, size);
    let read = 0;
    for await (const chunk of createReadStream(f.path)) {
      read += (chunk as Buffer).length;
      yield chunk as Buffer;
    }
    if (read !== size) throw new TarError(`tar: ${f.name} changed while it was read`);
    if (size % BLOCK !== 0) yield Buffer.alloc(BLOCK - (size % BLOCK));
  }
  yield Buffer.alloc(2 * BLOCK);
}

const field = (h: Buffer, at: number, len: number): string => {
  const raw = h.subarray(at, at + len);
  const z = raw.indexOf(0);
  return raw.subarray(0, z < 0 ? len : z).toString('utf8');
};

export function untarInto(dir: string, onFile?: (name: string) => void): Writable {
  const root = resolve(dir);
  let buf = Buffer.alloc(0);
  let current: { remaining: number; pad: number; out: ReturnType<typeof createWriteStream> } | null = null;
  let ended = false;
  const step = async (): Promise<void> => {
    for (;;) {
      if (current !== null) {
        if (current.remaining > 0) {
          if (buf.length === 0) return;
          const take = Math.min(current.remaining, buf.length);
          const part = buf.subarray(0, take);
          buf = buf.subarray(take);
          current.remaining -= take;
          const out = current.out;
          if (!out.write(part)) await new Promise<void>((r) => out.once('drain', () => r()));
          continue;
        }
        if (buf.length < current.pad) return;
        buf = buf.subarray(current.pad);
        const out = current.out;
        await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
        current = null;
        continue;
      }
      if (ended || buf.length < BLOCK) return;
      const h = buf.subarray(0, BLOCK);
      if (h.every((b) => b === 0)) {
        ended = true;
        return;
      }
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
      if (parseInt(field(h, 148, 8).trim() || '-1', 8) !== sum) throw new TarError('tar: header checksum mismatch');
      if (field(h, 257, 6) !== 'ustar' || field(h, 156, 1) !== '0') throw new TarError('tar: only ustar regular files are accepted');
      const prefix = field(h, 345, 155);
      const name = prefix === '' ? field(h, 0, 100) : `${prefix}/${field(h, 0, 100)}`;
      checkName(name);
      const size = parseInt(field(h, 124, 12), 8);
      if (!Number.isSafeInteger(size) || size < 0) throw new TarError(`tar: bad size for ${name}`);
      const target = join(root, ...name.split('/'));
      if (!target.startsWith(root + sep)) throw new TarError(`tar: ${name} escapes the target`);
      onFile?.(name);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      buf = buf.subarray(BLOCK);
      current = { remaining: size, pad: (BLOCK - (size % BLOCK)) % BLOCK, out: createWriteStream(target, { flags: 'wx', mode: 0o600 }) };
    }
  };
  return new Writable({
    write(chunk: Buffer, _e, cb) {
      buf = Buffer.concat([buf, chunk]);
      step().then(() => cb(), cb);
    },
    final(cb) {
      step().then(() => cb(ended && current === null ? null : new TarError('tar: the archive ends early')), cb);
    },
  });
}
