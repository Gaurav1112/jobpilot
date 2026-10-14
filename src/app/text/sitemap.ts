/**
 * Sitemap reading shared by the coverage careers locator and the daily page adapters (Task 8): pure, no imports, so
 * agent code may use it. Every scan is linear in the input (forward literal searches, never a pattern built from input).
 */

/** The XML entities a sitemap `<loc>` uses (`&amp;` above all); nothing else is decoded. */
const decodeEntities = (s: string): string => s.replace(/&amp;/gi, '&').replace(/&#38;/g, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");

/**
 * The `<loc>` values of a sitemap, in document order: trimmed, an optional CDATA wrapper removed, entities decoded;
 * empty values and values holding `<` or `]` are skipped. Linear: each `<loc>` and `</loc>` is found by a forward
 * literal search, a found `</loc>` is reused until passed, and a missing one ends the scan.
 */
export function sitemapLocs(xml: string): string[] {
  const out: string[] = [];
  const open = /<loc>/gi;
  const close = /<\/loc>/gi;
  let end = -1; // where the next </loc> starts (reused until an opening passes it)
  let o = open.exec(xml);
  while (o !== null) {
    const from = open.lastIndex;
    if (end < from) {
      close.lastIndex = from;
      const c = close.exec(xml);
      if (c === null) break; // no </loc> after here: no later <loc> can close either
      end = c.index;
    }
    const n = open.exec(xml);
    if (n === null || n.index > end) {
      let v = xml.slice(from, end).trim();
      if (v.startsWith('<![CDATA[')) v = v.slice('<![CDATA['.length);
      if (v.endsWith(']]>')) v = v.slice(0, -']]>'.length);
      v = v.trim();
      if (v !== '' && !v.includes('<') && !v.includes(']')) out.push(decodeEntities(v));
    }
    o = n; // a <loc> opening before this one closed leaves this one without a value
  }
  return out;
}

/** Whether a sitemap document is a sitemap index (`<sitemapindex>`: its `<loc>`s are sitemaps, not pages). */
export const isSitemapIndex = (xml: string): boolean => /<sitemapindex[\s>]/i.test(xml.slice(0, 4096));
