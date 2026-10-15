import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * JPST1 (hosted spec §3.3): the sealed format of the hosted state and pack. A header line, then the compressed payload
 * in chunks, each AES-256-GCM with nonce = 8-byte random prefix ‖ uint32BE counter and AAD = sha256(header) ‖ counter ‖
 * final flag: the STREAM construction, so reordering, truncation and extension all fail authentication. On a failure
 * the reader tries cheap alternatives (another position, the other flag) only to NAME the failure; nothing that fails
 * authentication is ever emitted. Messages name chunk numbers and key ids, never key bytes or plaintext.
 */
export const JPST_MAGIC = 'JPST1\n';
export const DEFAULT_CHUNK = 4 * 1024 * 1024;
const TAG = 16;
const MAX_CHUNK = 64 * 1024 * 1024;

export type JpstCodec = 'zstd' | 'gzip';
export interface JpstHeader {
  readonly v: 1;
  readonly codec: JpstCodec;
  readonly level: number;
  readonly chunk: number;
  readonly keyId: string;
  readonly nonce: string;
}
export type JpstErrorCode = 'bad-magic' | 'bad-header' | 'wrong-key' | 'truncated' | 'extended' | 'reordered' | 'tampered';
export class JpstError extends Error {
  override readonly name = 'JpstError';
  constructor(readonly code: JpstErrorCode, message: string) {
    super(message);
  }
}

export const keyIdOf = (key: Buffer): string => createHash('sha256').update(key).digest('hex').slice(0, 8);

export function decodeKey(b64: string, name: string): Buffer {
  const t = b64.trim();
  const key = Buffer.from(t, 'base64');
  if (key.length !== 32 || key.toString('base64') !== t) throw new Error(`${name}: expected 32 bytes in standard base64`);
  return key;
}

function headerBytes(h: JpstHeader): Buffer {
  const json = `{"chunk":${h.chunk},"codec":${JSON.stringify(h.codec)},"keyId":${JSON.stringify(h.keyId)},"level":${h.level},"nonce":${JSON.stringify(h.nonce)},"v":1}`;
  return Buffer.from(`${JPST_MAGIC}${json}\n`, 'utf8');
}
function nonceOf(prefix: Buffer, counter: number): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0, 0, 8);
  n.writeUInt32BE(counter, 8);
  return n;
}
function aadOf(headerHash: Buffer, counter: number, final: boolean): Buffer {
  const a = Buffer.alloc(37);
  headerHash.copy(a, 0);
  a.writeUInt32BE(counter, 32);
  a[36] = final ? 1 : 0;
  return a;
}
function sealChunk(key: Buffer, prefix: Buffer, hh: Buffer, counter: number, final: boolean, plain: Buffer): Buffer {
  const c = createCipheriv('aes-256-gcm', key, nonceOf(prefix, counter));
  c.setAAD(aadOf(hh, counter, final));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
function tryOpen(key: Buffer, prefix: Buffer, hh: Buffer, counter: number, final: boolean, sealed: Buffer): Buffer | null {
  if (sealed.length < TAG) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, nonceOf(prefix, counter));
    d.setAAD(aadOf(hh, counter, final));
    d.setAuthTag(sealed.subarray(sealed.length - TAG));
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
  } catch {
    return null;
  }
}

export interface SealOptions {
  readonly codec?: JpstCodec;
  readonly level?: number;
  readonly chunk?: number;
  /** Tests only: the 8-byte nonce prefix (default: 8 random bytes per file). */
  readonly noncePrefix?: Buffer;
}

export function sealTransform(key: Buffer, o: SealOptions = {}): Transform {
  const chunk = o.chunk ?? DEFAULT_CHUNK;
  if (!Number.isInteger(chunk) || chunk < 16 || chunk > MAX_CHUNK) throw new Error(`jpst: chunk size ${chunk} out of range`);
  const prefix = o.noncePrefix ?? randomBytes(8);
  if (prefix.length !== 8) throw new Error('jpst: the nonce prefix is 8 bytes');
  const header = headerBytes({ v: 1, codec: o.codec ?? 'zstd', level: o.level ?? 3, chunk, keyId: keyIdOf(key), nonce: prefix.toString('hex') });
  const hh = createHash('sha256').update(header).digest();
  let pending = Buffer.alloc(0);
  let counter = 0;
  let headerOut = false;
  const emit = (t: Transform, final: boolean, plain: Buffer): void => {
    if (counter > 0xffffffff) throw new Error('jpst: too many chunks');
    t.push(sealChunk(key, prefix, hh, counter, final, plain));
    counter += 1;
  };
  return new Transform({
    transform(data: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      if (!headerOut) {
        this.push(header);
        headerOut = true;
      }
      pending = Buffer.concat([pending, data]);
      while (pending.length > chunk) {
        emit(this, false, pending.subarray(0, chunk));
        pending = pending.subarray(chunk);
      }
      cb();
    },
    flush(cb: TransformCallback) {
      if (!headerOut) this.push(header);
      emit(this, true, pending);
      cb();
    },
  });
}

export function parseHeader(buf: Buffer): { header: JpstHeader; length: number } | null {
  if (buf.length < JPST_MAGIC.length) return null;
  if (buf.subarray(0, JPST_MAGIC.length).toString('latin1') !== JPST_MAGIC) throw new JpstError('bad-magic', 'jpst: not a JPST1 file');
  const nl = buf.indexOf(0x0a, JPST_MAGIC.length);
  if (nl < 0) {
    if (buf.length > 1024) throw new JpstError('bad-header', 'jpst: header line longer than 1024 bytes');
    return null;
  }
  let x: Partial<JpstHeader>;
  try {
    x = JSON.parse(buf.subarray(JPST_MAGIC.length, nl).toString('utf8')) as Partial<JpstHeader>;
  } catch {
    throw new JpstError('bad-header', 'jpst: the header is not JSON');
  }
  const ok =
    x.v === 1 && (x.codec === 'zstd' || x.codec === 'gzip') && Number.isInteger(x.level) && Number.isInteger(x.chunk) &&
    (x.chunk as number) >= 16 && (x.chunk as number) <= MAX_CHUNK && /^[0-9a-f]{8}$/.test(x.keyId ?? '') && /^[0-9a-f]{16}$/.test(x.nonce ?? '');
  if (!ok) throw new JpstError('bad-header', 'jpst: the header fields are invalid');
  const header = x as JpstHeader;
  if (!headerBytes(header).equals(buf.subarray(0, nl + 1))) throw new JpstError('bad-header', 'jpst: the header is not canonical');
  return { header, length: nl + 1 };
}

export function readHeaderOf(file: string): JpstHeader {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(1024);
    const n = readSync(fd, b, 0, 1024, 0);
    const p = parseHeader(b.subarray(0, n));
    if (p === null) throw new JpstError('truncated', 'jpst: the file ends inside its header');
    return p.header;
  } finally {
    closeSync(fd);
  }
}

export function openTransform(key: Buffer, onHeader?: (h: JpstHeader) => void): Transform {
  let head = Buffer.alloc(0);
  let header: JpstHeader | undefined;
  let hh = Buffer.alloc(0);
  let prefix = Buffer.alloc(0);
  let unit = 0;
  let pending = Buffer.alloc(0);
  let counter = 0;
  /** A non-final chunk failed for no reason found yet: the rest is kept (at most 16 units) to tell an extension. */
  let suspect = false;
  const misplaced = (sealed: Buffer, at: number): number | null => {
    for (let c = 0; c <= at + 64; c++) {
      if (c === at) continue;
      if (tryOpen(key, prefix, hh, c, false, sealed) !== null || tryOpen(key, prefix, hh, c, true, sealed) !== null) return c;
    }
    return null;
  };
  const tampered = (): JpstError => new JpstError('tampered', `jpst: chunk ${counter} failed authentication (tampered or corrupt)`);
  const extended = (): JpstError => new JpstError('extended', `jpst: data follows the final chunk (${counter})`);
  const failNonFinal = (sealed: Buffer): void => {
    const c = misplaced(sealed, counter);
    if (c !== null) throw new JpstError('reordered', `jpst: chunk ${counter} belongs at position ${c}`);
    if (tryOpen(key, prefix, hh, counter, true, sealed) !== null) throw extended();
    suspect = true;
  };
  const finish = (t: Transform): void => {
    if (suspect) {
      // whole sealed chunks appended after a short final one: the final chunk is what is left modulo a unit
      const len = pending.length % unit === 0 ? unit : pending.length % unit;
      if (tryOpen(key, prefix, hh, counter, true, pending.subarray(0, len)) !== null) throw extended();
      throw tampered();
    }
    if (pending.length === 0 && counter > 0) throw new JpstError('truncated', `jpst: the file ends after chunk ${counter - 1}, which is not the final one`);
    const plain = tryOpen(key, prefix, hh, counter, true, pending);
    if (plain === null) {
      if (tryOpen(key, prefix, hh, counter, false, pending) !== null) throw new JpstError('truncated', `jpst: the file ends after chunk ${counter}, which is not the final one`);
      const c = misplaced(pending, counter);
      if (c !== null) throw new JpstError('reordered', `jpst: chunk ${counter} belongs at position ${c}`);
      throw tampered();
    }
    if (plain.length > 0) t.push(plain);
  };
  return new Transform({
    transform(data: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      try {
        if (header === undefined) {
          head = Buffer.concat([head, data]);
          const p = parseHeader(head);
          if (p === null) return cb();
          if (p.header.keyId !== keyIdOf(key)) throw new JpstError('wrong-key', `jpst: wrong key (the file was sealed with key ${p.header.keyId})`);
          header = p.header;
          onHeader?.(header);
          hh = createHash('sha256').update(head.subarray(0, p.length)).digest();
          prefix = Buffer.from(header.nonce, 'hex');
          unit = header.chunk + TAG;
          data = head.subarray(p.length);
        }
        pending = Buffer.concat([pending, data]);
        if (suspect) {
          if (pending.length > 16 * unit) throw tampered();
          return cb();
        }
        while (pending.length > unit) {
          const sealed = pending.subarray(0, unit);
          const plain = tryOpen(key, prefix, hh, counter, false, sealed);
          if (plain === null) {
            failNonFinal(sealed);
            return cb();
          }
          if (plain.length > 0) this.push(plain);
          counter += 1;
          pending = pending.subarray(unit);
        }
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (header === undefined) throw new JpstError('truncated', 'jpst: the file ends inside its header');
        finish(this);
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
  });
}

async function collect(t: Transform, input: Buffer): Promise<Buffer> {
  const out: Buffer[] = [];
  t.on('data', (b: Buffer) => out.push(b));
  const done = new Promise<void>((res, rej) => {
    t.on('end', res);
    t.on('error', rej);
  });
  t.end(input);
  await done;
  return Buffer.concat(out);
}
export const sealBuffer = (key: Buffer, plain: Buffer, o: SealOptions = {}): Promise<Buffer> => collect(sealTransform(key, o), plain);
export const openBuffer = (key: Buffer, sealed: Buffer): Promise<Buffer> => collect(openTransform(key), sealed);
