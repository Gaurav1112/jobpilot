/**
 * A small XML reader for the platform feeds (Task 9: Teamtailor's RSS and Personio's XML): pure, no imports, so agent
 * code may use it. It is not a general XML parser. It reads one document into a tree of elements with their decoded
 * text, and refuses what a feed never holds.
 *
 * Linear in the input, with no pattern built from the document: every scan moves forward over literal markers
 * (`indexOf` from the current position, an attribute value found by its closing quote), an entity is looked for only
 * in the ten characters after its `&`, and the work is capped by the document's depth and node count. Malformed input
 * (an unclosed tag or comment, a mismatched or missing closing tag, a second root, text outside the root) is an
 * `XmlError`, never a partial tree.
 *
 * Entities: the five XML ones and numeric references, decoded ONCE, so an RSS `<description>` of escaped HTML comes out
 * as the HTML string. A DOCTYPE is skipped unread (no entity is ever defined or expanded). CDATA is taken as is.
 */

export interface XmlNode {
  readonly name: string;
  /** The element's own text (entities decoded, CDATA as is), the pieces between its child elements joined. */
  readonly text: string;
  readonly children: readonly XmlNode[];
}

export class XmlError extends Error {
  constructor(why: string) {
    super(`xml: ${why}`);
    this.name = 'XmlError';
  }
}

export interface XmlLimits {
  readonly maxNodes?: number;
  readonly maxDepth?: number;
}

export const XML_MAX_NODES = 200_000;
export const XML_MAX_DEPTH = 32;

const NAMED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** One-level entity decoding; an unknown or malformed reference stays as written. Linear: a reference is looked for in the next 10 characters only. */
function decode(s: string): string {
  let amp = s.indexOf('&');
  if (amp < 0) return s;
  let out = '';
  let from = 0;
  while (amp >= 0) {
    let semi = -1;
    for (let k = amp + 1; k < s.length && k <= amp + 10; k++) {
      if (s.charCodeAt(k) === 59) {
        semi = k;
        break;
      }
    }
    let rep: string | undefined;
    if (semi > amp + 1) {
      const ref = s.slice(amp + 1, semi);
      if (ref.charCodeAt(0) === 35) {
        const hex = ref.charCodeAt(1) === 120 || ref.charCodeAt(1) === 88;
        const digits = ref.slice(hex ? 2 : 1);
        const code = digits !== '' && (hex ? /^[0-9a-fA-F]+$/u : /^[0-9]+$/u).test(digits) ? Number.parseInt(digits, hex ? 16 : 10) : Number.NaN;
        if (Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) rep = String.fromCodePoint(code);
      } else rep = Object.hasOwn(NAMED, ref) ? NAMED[ref] : undefined;
    }
    if (rep === undefined) {
      amp = s.indexOf('&', amp + 1);
      continue;
    }
    out += s.slice(from, amp) + rep;
    from = semi + 1;
    amp = s.indexOf('&', from);
  }
  return out + s.slice(from);
}

const isNameChar = (c: number): boolean => (c >= 48 && c <= 58) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45 || c === 46;

interface Open {
  name: string;
  parts: string[];
  children: XmlNode[];
}

export function parseXml(xml: string, limits: XmlLimits = {}): XmlNode {
  const maxNodes = limits.maxNodes ?? XML_MAX_NODES;
  const maxDepth = limits.maxDepth ?? XML_MAX_DEPTH;
  const stack: Open[] = [];
  let root: XmlNode | null = null;
  let nodes = 0;
  let i = 0;
  const close = (o: Open): XmlNode => ({ name: o.name, text: o.parts.join(''), children: o.children });
  const attach = (n: XmlNode): void => {
    const top = stack[stack.length - 1];
    if (top !== undefined) top.children.push(n);
    else root = n;
  };
  for (;;) {
    const lt = xml.indexOf('<', i);
    const chunk = xml.slice(i, lt < 0 ? xml.length : lt);
    const top = stack[stack.length - 1];
    if (top !== undefined) top.parts.push(decode(chunk));
    else if (chunk.trim() !== '' && chunk.trim() !== '﻿') throw new XmlError('text outside the root element');
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlError('unclosed comment');
      i = end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlError('unclosed CDATA section');
      if (top === undefined) throw new XmlError('CDATA outside the root element');
      top.parts.push(xml.slice(lt + 9, end));
      i = end + 3;
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlError('unclosed processing instruction');
      i = end + 2;
    } else if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      if (end < 0) throw new XmlError('unclosed declaration');
      i = end + 1;
    } else if (xml.startsWith('</', lt)) {
      const gt = xml.indexOf('>', lt + 2);
      if (gt < 0) throw new XmlError('unclosed end tag');
      const name = xml.slice(lt + 2, gt).trim();
      const open = stack.pop();
      if (open === undefined || open.name !== name) throw new XmlError(`end tag </${name.slice(0, 40)}> does not match ${open === undefined ? 'an open element' : `<${open.name}>`}`);
      attach(close(open));
      i = gt + 1;
    } else {
      let j = lt + 1;
      while (j < xml.length && isNameChar(xml.charCodeAt(j))) j++;
      const name = xml.slice(lt + 1, j);
      if (name === '') throw new XmlError('a tag with no name');
      // attributes (read for their quotes only): up to the closing '>', a quoted value found by its closing quote
      for (;;) {
        if (j >= xml.length) throw new XmlError(`unclosed tag <${name.slice(0, 40)}`);
        const c = xml.charCodeAt(j);
        if (c === 62) break;
        if (c === 34 || c === 39) {
          const q = xml.indexOf(xml[j] as string, j + 1);
          if (q < 0) throw new XmlError(`unclosed attribute value in <${name.slice(0, 40)}>`);
          j = q + 1;
        } else j++;
      }
      const selfClosing = xml.charCodeAt(j - 1) === 47;
      if (root !== null && stack.length === 0) throw new XmlError('more than one root element');
      if (++nodes > maxNodes) throw new XmlError(`more than ${maxNodes} nodes`);
      if (selfClosing) {
        attach({ name, text: '', children: [] });
      } else {
        if (stack.length >= maxDepth) throw new XmlError(`deeper than ${maxDepth} levels`);
        stack.push({ name, parts: [], children: [] });
      }
      i = j + 1;
    }
  }
  if (stack.length > 0) throw new XmlError(`<${(stack[stack.length - 1] as Open).name}> is never closed`);
  if (root === null) throw new XmlError('no root element');
  return root;
}

/** The element children named `name`, in document order. */
export const children = (n: XmlNode, name: string): XmlNode[] => n.children.filter((c) => c.name === name);

/** The trimmed text of the first child named `name`; null when there is no such child. */
export function childText(n: XmlNode, name: string): string | null {
  const c = n.children.find((x) => x.name === name);
  return c === undefined ? null : c.text.trim();
}
