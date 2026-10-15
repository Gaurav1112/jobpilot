/**
 * Structural queries over the dashboard's rendered HTML (UX upgrade A0), for tests that must survive markup changes.
 * No parser dependency: the dashboard's own HTML is regular (every non-void element closed, attributes double-quoted,
 * values escaped by `html`), and these helpers rely on exactly that. Security and escaping tests keep exact strings.
 */
const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) =>
    e.startsWith('#x') ? String.fromCodePoint(Number.parseInt(e.slice(2), 16)) : e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : (NAMED[e] ?? m),
  );
}

/** The text a reader gets: scripts and styles dropped, every tag a space, entities decoded, whitespace collapsed. */
export function textOf(html: string): string {
  return decode(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').replace(/ ([,.;:)])/g, '$1').trim();
}

/** The element that starts at `start` (a `<tag` there), through its matching close tag. */
export function blockOf(html: string, start: number): string {
  const open = /^<([a-z][a-z0-9]*)\b[^>]*>/i.exec(html.slice(start));
  if (open === null) throw new Error(`blockOf: no element at ${start}`);
  const tag = (open[1] as string).toLowerCase();
  if (VOID.has(tag)) return open[0];
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error(`blockOf: <${tag}> at ${start} is never closed`);
}

/** Every element with attribute `attr` (equal to `value` when given), in document order. */
export function elementsWith(html: string, attr: string, value?: string): string[] {
  const re = new RegExp(`<[a-z][a-z0-9]*\\b[^>]*\\s${escapeRe(attr)}="${value === undefined ? '[^"]*' : escapeRe(value)}"[^>]*>`, 'gi');
  return [...html.matchAll(re)].map((m) => blockOf(html, m.index));
}

export function rowOf(html: string, attr: string, key: string): string {
  const found = elementsWith(html, attr, key);
  if (found.length !== 1) throw new Error(`rowOf: expected one element with ${attr}="${key}", found ${found.length}`);
  return found[0] as string;
}

/** The attributes of the first tag of `el`, values decoded. */
export function attrsOf(el: string): Record<string, string> {
  const tag = /^<[a-z][a-z0-9]*\b([^>]*)>/i.exec(el)?.[1] ?? '';
  return Object.fromEntries([...tag.matchAll(/\s([a-z][a-z0-9:-]*)(?:="([^"]*)")?/gi)].map((m) => [m[1] as string, decode(m[2] ?? '')]));
}

export function linksOf(html: string): { href: string; text: string; attrs: Record<string, string> }[] {
  return elementsWith(html, 'href').filter((e) => /^<a\b/i.test(e)).map((a) => {
    const attrs = attrsOf(a);
    return { href: attrs['href'] ?? '', text: textOf(a), attrs };
  });
}
