import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted by code unit, `undefined` object
 * properties dropped, `undefined` array items become null. Throws on values
 * that have no stable JSON form (NaN, Infinity, Date, Map, class instances).
 */
export function canonicalJson(value: unknown): string {
  return serialise(value, '$');
}

function serialise(v: unknown, path: string): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(Object.is(v, -0) ? 0 : v);
    case 'object': {
      if (Array.isArray(v)) {
        return `[${v.map((x, i) => serialise(x === undefined ? null : x, `${path}[${i}]`)).join(',')}]`;
      }
      const proto: unknown = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalJson: unsupported object at ${path}`);
      }
      const rec = v as Record<string, unknown>;
      const parts: string[] = [];
      for (const k of Object.keys(rec).sort()) {
        const x = rec[k];
        if (x === undefined) continue;
        parts.push(`${JSON.stringify(k)}:${serialise(x, `${path}.${k}`)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashOf(value: unknown): string {
  return sha256(canonicalJson(value));
}
