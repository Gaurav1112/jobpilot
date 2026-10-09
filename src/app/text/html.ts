/**
 * HTML to plain text for job descriptions. Pure and import-free, because agent code (the normalizer) imports it and
 * the containment scan reads it like agent code.
 *
 * Completeness rule: no visible content is dropped. Every list item and every table cell survives, list items keep
 * their nesting, and a `<br>` inside a list item stays with that item. Only script, style, template and noscript
 * bodies, comments, tags and their attributes are removed.
 */

/** Named entities: the HTML 4 set (Latin-1, symbols, Greek, punctuation) plus the HTML5 names job boards use. */
const NAMED: Readonly<Record<string, string>> = {
  amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'",
  nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e', rlm: '\u200f', shy: '\u00ad',
  iexcl: '¡', cent: '¢', pound: '£', curren: '¤', yen: '¥', brvbar: '¦', sect: '§', uml: '¨', copy: '©', COPY: '©', ordf: 'ª', laquo: '«',
  not: '¬', reg: '®', REG: '®', macr: '¯', deg: '°', plusmn: '±', sup2: '²', sup3: '³', acute: '´', micro: 'µ', para: '¶', middot: '·',
  cedil: '¸', sup1: '¹', ordm: 'º', raquo: '»', frac14: '¼', frac12: '½', frac34: '¾', iquest: '¿', times: '×', divide: '÷',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê',
  Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', ETH: 'Ð', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ',
  Ouml: 'Ö', Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', THORN: 'Þ', szlig: 'ß', agrave: 'à', aacute: 'á',
  acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì',
  iacute: 'í', icirc: 'î', iuml: 'ï', eth: 'ð', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', thorn: 'þ', yuml: 'ÿ', OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š',
  Yuml: 'Ÿ', fnof: 'ƒ', circ: 'ˆ', tilde: '˜',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ', Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ',
  Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ', Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
  nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigmaf: 'ς', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', dagger: '†', Dagger: '‡', bull: '•',
  hellip: '…', permil: '‰', prime: '′', Prime: '″', lsaquo: '‹', rsaquo: '›', oline: '‾', frasl: '⁄', euro: '€', trade: '™', TRADE: '™',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔', rArr: '⇒', lArr: '⇐', hArr: '⇔', minus: '−', lowast: '∗', le: '≤', ge: '≥',
  ne: '≠', asymp: '≈', equiv: '≡', infin: '∞', sum: '∑', radic: '√', check: '✓', cross: '✗', star: '☆', starf: '★', hearts: '♥',
  loz: '◊', spades: '♠', clubs: '♣', diams: '♦', inr: '₹', half: '½', dash: '‐', hyphen: '‐', colon: ':', comma: ',', period: '.',
  excl: '!', quest: '?', num: '#', dollar: '$', percnt: '%', lpar: '(', rpar: ')', ast: '*', plus: '+', sol: '/', bsol: '\\', semi: ';',
  equals: '=', commat: '@', lsqb: '[', rsqb: ']', lowbar: '_', grave: '`', lcub: '{', rcub: '}', verbar: '|', vert: '|', Tab: '\t',
  NewLine: '\n',
};

/** Numeric references 128-159 name windows-1252 characters in practice; browsers decode them that way. */
const CP1252: Readonly<Record<number, string>> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
  0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
  0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function fromCodePoint(cp: number): string {
  if (CP1252[cp] !== undefined) return CP1252[cp];
  if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  return String.fromCodePoint(cp);
}

/**
 * Decodes named (case-sensitive, semicolon required), decimal and hex character references, exactly once. An unknown
 * name, or an ampersand that starts no reference, is left as it is.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (m, dec?: string, hex?: string, name?: string) => {
    if (dec !== undefined) return fromCodePoint(Number.parseInt(dec, 10));
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16));
    return (name !== undefined ? NAMED[name] : undefined) ?? m;
  });
}

/** Tags whose boundaries end a paragraph (a blank line). */
const PARAGRAPH = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote', 'pre', 'figure', 'hr']);
/** Tags whose boundaries end a line. */
const LINE = new Set([
  'div', 'tr', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'address', 'dl', 'dt', 'dd', 'figcaption', 'form',
  'fieldset', 'legend', 'details', 'summary', 'center', 'caption', 'thead', 'tbody', 'tfoot', 'ul', 'ol', 'menu',
]);
const LIST = new Set(['ul', 'ol', 'menu']);
const CELL = new Set(['td', 'th']);

/**
 * One token per match: a comment, a raw-text element with its body, a tag (attribute values may hold `>`), or a
 * doctype / processing instruction. Everything between matches is text.
 */
const TOKEN =
  /<!--[\s\S]*?-->|<(script|style|template|noscript)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>|<(\/?)([A-Za-z][A-Za-z0-9:-]*)(?:[^>"']|"[^"]*"|'[^']*')*>|<[!?][^>]*>/g;

/** Characters that are never visible content: soft hyphen, zero-width space, word joiner, BOM. */
const INVISIBLE = /[\u00ad\u200b\u2060\ufeff]/g;

/** Accumulates text lines; block structure arrives as requests that only take effect when the next text does. */
class TextBuilder {
  private readonly lines: string[] = [];
  private cur = '';
  /** Line breaks owed before the next text (0-2). */
  private breaks = 0;
  /** A list marker owed before the next text: the item's depth. While it is owed, block boundaries are absorbed. */
  private marker: number | null = null;
  /** A list item closed and no text came since: the next item is its sibling, one line below. */
  private afterItem = false;
  /** A cell separator owed before the next text on this line. */
  private sep = false;
  /** Depths of the open list items, innermost last. */
  readonly items: number[] = [];

  lineBreak(n: 1 | 2): void {
    if (this.marker === null) this.breaks = Math.max(this.breaks, n);
  }

  /** `<br>`: each one counts, up to a blank line. */
  br(): void {
    if (this.marker === null) this.breaks = Math.min(2, this.breaks + 1);
  }

  startItem(depth: number): void {
    this.breaks = this.afterItem ? 1 : Math.max(this.breaks, 1);
    this.marker = depth; // an earlier item that got no text is replaced: empty items vanish
    this.sep = false;
  }

  endItem(): void {
    this.items.pop();
    if (this.marker === null) this.breaks = Math.max(this.breaks, 1);
    this.afterItem = true;
  }

  cell(first: boolean): void {
    if (!first) this.sep = true;
  }

  text(raw: string): void {
    const t = raw.replace(INVISIBLE, '').replace(/\s+/g, ' ');
    if (t.trim() === '') {
      if (t !== '' && this.cur !== '' && !this.cur.endsWith(' ') && this.breaks === 0 && this.marker === null) this.cur += ' ';
      return;
    }
    if ((this.lines.length > 0 || this.cur !== '') && (this.breaks > 0 || this.marker !== null)) {
      if (this.cur !== '') this.lines.push(this.cur.replace(/ +$/, ''));
      this.cur = '';
      if (this.breaks === 2) this.lines.push('');
    }
    this.breaks = 0;
    this.afterItem = false;
    if (this.cur === '') {
      const open = this.items[this.items.length - 1];
      if (this.marker !== null) this.cur = `${'  '.repeat(this.marker - 1)}- `;
      else if (open !== undefined) this.cur = '  '.repeat(open);
      this.marker = null;
      this.cur += t.replace(/^ /, '');
    } else if (this.sep) {
      this.cur = `${this.cur.replace(/ +$/, '')} | ${t.replace(/^ /, '')}`;
    } else {
      this.cur += this.cur.endsWith(' ') && t.startsWith(' ') ? t.slice(1) : t;
    }
    this.sep = false;
  }

  done(): string {
    if (this.cur !== '') this.lines.push(this.cur.replace(/ +$/, ''));
    return this.lines.join('\n').replace(/\s+$/, '');
  }
}

/**
 * Visible text of an HTML fragment:
 * - entities are decoded after the tags are removed, so escaped markup (`&lt;b&gt;`) stays text;
 * - `p`, `h1`-`h6`, `table`, `blockquote`, `pre` end a paragraph (a blank line); `div`, `tr`, `br`, lists and other
 *   block tags end a line; at most 2 newlines appear in a row;
 * - every `li` is prefixed with `- `, indented two spaces per nesting level; text after a `<br>`, a paragraph or a
 *   nested list inside an item is indented under that item;
 * - table cells on a row are joined with ` | `;
 * - all other tags are removed, whitespace runs collapse to one space, and empty list items vanish.
 * Greenhouse `content` is HTML-escaped HTML: call `htmlToText(decodeEntities(content))`.
 */
export function htmlToText(html: string): string {
  const out = new TextBuilder();
  let listDepth = 0;
  let cellIndex = 0;
  let last = 0;
  for (const m of html.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.text(decodeEntities(html.slice(last, at)));
    last = at + m[0].length;
    const name = m[3]?.toLowerCase();
    if (name === undefined) continue; // comment, raw-text element, doctype
    const closing = m[2] === '/';
    if (name === 'br') {
      out.br();
    } else if (name === 'li') {
      if (closing) {
        out.endItem();
      } else {
        const depth = Math.max(listDepth, 1);
        while ((out.items[out.items.length - 1] ?? 0) >= depth) out.items.pop(); // an unclosed sibling item
        out.items.push(depth);
        out.startItem(depth);
      }
    } else if (LIST.has(name)) {
      if (closing) {
        while (listDepth > 0 && (out.items[out.items.length - 1] ?? 0) >= listDepth) out.items.pop(); // items left unclosed
        listDepth = Math.max(0, listDepth - 1);
        out.lineBreak(listDepth === 0 ? 2 : 1);
      } else {
        listDepth++;
        out.lineBreak(listDepth === 1 && out.items.length === 0 ? 2 : 1);
      }
    } else if (name === 'tr') {
      cellIndex = 0;
      out.lineBreak(1);
    } else if (CELL.has(name)) {
      if (!closing) out.cell(cellIndex++ === 0);
    } else if (PARAGRAPH.has(name)) {
      out.lineBreak(2);
    } else if (LINE.has(name)) {
      out.lineBreak(1);
    }
  }
  if (last < html.length) out.text(decodeEntities(html.slice(last)));
  return out.done();
}
