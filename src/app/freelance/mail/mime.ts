/**
 * Just enough RFC 5322 / MIME to read an alert email as Gmail's `format=raw` returns it (Task 13). Pure: no I/O, no
 * clock. It reads the header fields jobpilot needs (`From`, `Subject`, `Date`, with RFC 2047 encoded words), walks
 * multipart bodies (at most MAX_DEPTH deep) and keeps the first inline `text/plain` and the first inline `text/html`
 * part, decoded from base64 or quoted-printable and from their charset. Attachments are never read.
 */

export interface MailMessage {
  /** Gmail's message id. */
  readonly id: string;
  /** The `From` address, exact and lower-cased ("" when there is none). */
  readonly from: string;
  /** The part after `@`, or "unknown sender". */
  readonly fromDomain: string;
  readonly subject: string;
  /** Gmail's `internalDate` (when Google received it) as ISO, else the `Date` header, else null. */
  readonly receivedAt: string | null;
  readonly text: string | null;
  readonly html: string | null;
}

const MAX_DEPTH = 6;

/** Bytes kept as a binary string (one char per byte, 0–255), so the RFC 822 structure can be split before decoding. */
type Binary = string;

const bytesOf = (b: Binary): Uint8Array => Uint8Array.from(b, (c) => c.charCodeAt(0) & 0xff);

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset.trim().toLowerCase() || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** base64 (standard or url-safe, whitespace ignored) to a binary string. */
export function base64Binary(s: string): Binary {
  const std = s.replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
  const padded = std.replace(/=+$/, '') + '='.repeat((4 - (std.replace(/=+$/, '').length % 4)) % 4);
  try {
    return atob(padded.length % 4 === 1 ? padded.slice(0, -1) : padded);
  } catch {
    return '';
  }
}

function quotedPrintable(s: Binary): Binary {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** The header block and the body, split at the first empty line. */
function split(raw: Binary): { head: Binary; body: Binary } {
  const m = /\r?\n\r?\n/.exec(raw);
  return m === null ? { head: raw, body: '' } : { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

/** Header fields by lower-cased name, unfolded, in order. */
function headers(head: Binary): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    out.set(name, [...(out.get(name) ?? []), line.slice(i + 1).trim()]);
  }
  return out;
}

/** RFC 2047 encoded words (`=?utf-8?B?...?=`, `=?iso-8859-1?Q?...?=`); whitespace between two of them is dropped. */
export function decodeWords(value: Binary): string {
  const WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
  const joined = value.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?)/g, '$1');
  let out = '';
  let at = 0;
  for (const m of joined.matchAll(WORD)) {
    out += decodeBytes(bytesOf(joined.slice(at, m.index)), 'utf-8');
    const charset = (m[1] as string).split('*')[0] as string;
    const data = m[3] as string;
    const bin = (m[2] as string).toUpperCase() === 'B' ? base64Binary(data) : quotedPrintable(data.replace(/_/g, ' '));
    out += decodeBytes(bytesOf(bin), charset);
    at = (m.index ?? 0) + m[0].length;
  }
  return out + decodeBytes(bytesOf(joined.slice(at)), 'utf-8');
}

/** `type/subtype` (lower-cased) and its parameters (names lower-cased, quotes removed). */
function contentType(v: string | undefined): { type: string; params: Map<string, string> } {
  const [type = 'text/plain', ...rest] = (v ?? 'text/plain').split(';');
  const params = new Map<string, string>();
  for (const p of rest) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    params.set(p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim().replace(/^"(.*)"$/, '$1'));
  }
  return { type: type.trim().toLowerCase(), params };
}

/** The `From` address: inside `<...>` when there is one, else the first address-like token. */
export function addressOf(from: string): string {
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  const bare = /([^\s<>"(),;:]+@[^\s<>"(),;:]+)/.exec(from);
  return (angle?.[1] ?? bare?.[1] ?? '').toLowerCase();
}

interface Parts {
  text: string | null;
  html: string | null;
}

function walk(raw: Binary, depth: number, found: Parts): void {
  const { head, body } = split(raw);
  const h = headers(head);
  const ct = contentType(h.get('content-type')?.[0]);
  const disposition = (h.get('content-disposition')?.[0] ?? '').toLowerCase();
  if (ct.type.startsWith('multipart/')) {
    const boundary = ct.params.get('boundary');
    if (boundary === undefined || boundary === '' || depth >= MAX_DEPTH) return;
    const lines = body.split(/\r?\n/);
    let current: string[] | null = null;
    const parts: string[] = [];
    for (const line of lines) {
      if (line === `--${boundary}--` || line.trimEnd() === `--${boundary}--`) {
        if (current !== null) parts.push(current.join('\r\n'));
        current = null;
        break;
      }
      if (line === `--${boundary}` || line.trimEnd() === `--${boundary}`) {
        if (current !== null) parts.push(current.join('\r\n'));
        current = [];
        continue;
      }
      current?.push(line);
    }
    if (current !== null) parts.push(current.join('\r\n'));
    for (const p of parts) walk(p, depth + 1, found);
    return;
  }
  if (disposition.startsWith('attachment')) return;
  if (ct.type !== 'text/plain' && ct.type !== 'text/html') return;
  if ((ct.type === 'text/plain' && found.text !== null) || (ct.type === 'text/html' && found.html !== null)) return;
  const cte = (h.get('content-transfer-encoding')?.[0] ?? '7bit').trim().toLowerCase();
  const bin = cte === 'base64' ? base64Binary(body) : cte === 'quoted-printable' ? quotedPrintable(body) : body;
  const text = decodeBytes(bytesOf(bin), ct.params.get('charset') ?? 'utf-8').replace(/\r\n?/g, '\n');
  if (ct.type === 'text/plain') found.text = text;
  else found.html = text;
}

function isoOf(internalDate: string | null, dateHeader: string | undefined): string | null {
  const ms = internalDate !== null && /^\d{1,15}$/.test(internalDate) ? Number(internalDate) : Number.NaN;
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  const t = dateHeader === undefined ? Number.NaN : Date.parse(dateHeader);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** One message from its raw RFC 822 text (`raw`, already base64url-decoded to a binary string). */
export function parseMail(id: string, raw: Binary, internalDate: string | null): MailMessage {
  const { head } = split(raw);
  const h = headers(head);
  const from = addressOf(decodeWords(h.get('from')?.[0] ?? ''));
  const at = from.lastIndexOf('@');
  const found: Parts = { text: null, html: null };
  walk(raw, 0, found);
  return {
    id,
    from,
    fromDomain: at > 0 ? from.slice(at + 1) : 'unknown sender',
    subject: decodeWords(h.get('subject')?.[0] ?? ''),
    receivedAt: isoOf(internalDate, h.get('date')?.[0]),
    text: found.text,
    html: found.html,
  };
}
