/** A minimal ustar writer for tests: the reverse of the reader in `src/app/coverage/seed.ts`. */
export interface TarEntry {
  /** The full path. With `longName` it is carried in a GNU `L` or pax `x` header and the real header gets a short stand-in. */
  readonly name: string;
  readonly data?: string;
  /** Typeflag; default `0` (a regular file). */
  readonly type?: string;
  readonly longName?: 'gnu' | 'pax';
  /** Writes `prefix` and `short` into the ustar fields instead of `name`. */
  readonly prefix?: string;
  readonly short?: string;
}

function header(name: string, size: number, type: string, prefix = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

export function buildTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '', 'utf8');
    if (e.longName === 'gnu') {
      const n = Buffer.from(`${e.name}\0`, 'utf8');
      parts.push(header('././@LongLink', n.length, 'L'), pad(n));
      parts.push(header(e.name.slice(0, 99), data.length, e.type ?? '0'), pad(data));
    } else if (e.longName === 'pax') {
      const rec = Buffer.from(paxRecord('path', e.name), 'utf8');
      parts.push(header('PaxHeader/x', rec.length, 'x'), pad(rec));
      parts.push(header(e.name.slice(0, 99), data.length, e.type ?? '0'), pad(data));
    } else if (e.prefix !== undefined) {
      parts.push(header(e.short ?? e.name, data.length, e.type ?? '0', e.prefix), pad(data));
    } else {
      parts.push(header(e.name, data.length, e.type ?? '0'), pad(data));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
