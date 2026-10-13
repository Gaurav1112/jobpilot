import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { BrowserPage, BrowserProvider, BrowserRenderRequest, FetchLike } from '../kernel/providers.js';
import { htmlToText } from './agents/sources/careers.js';

/**
 * `jobpilot run --offline-fixtures <dir>`: recorded responses instead of the network. `<dir>/index.json` maps each
 * URL to a file in `<dir>` (`{"https://…": "board.json"}`). `fetch` serves every mapped URL with status 200; the
 * browser serves mapped `.html` files as rendered pages (a static page: its JSON-LD blocks, the text of `<main>` or
 * the body, settled, nothing to expand). An unmapped URL is a 404 for both. Both record the URLs asked for.
 */
export function offlineProviders(dir: string): {
  fetch: FetchLike & { calls: string[] };
  browser: BrowserProvider & { calls: string[] };
} {
  const root = resolve(dir);
  const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as unknown;
  if (typeof index !== 'object' || index === null || Array.isArray(index)) throw new Error(`${join(root, 'index.json')}: expected an object of URL -> file`);
  const files = new Map<string, string>();
  for (const [url, file] of Object.entries(index)) {
    if (typeof file !== 'string') throw new Error(`${join(root, 'index.json')}: ${url} must map to a file name`);
    const abs = resolve(root, file);
    if (!abs.startsWith(root + sep)) throw new Error(`${join(root, 'index.json')}: ${file} is outside ${root}`);
    files.set(url, abs);
  }
  const read = (url: string): string | undefined => {
    const f = files.get(url);
    return f === undefined ? undefined : readFileSync(f, 'utf8');
  };

  const fetchCalls: string[] = [];
  const fetch = Object.assign(
    async (url: string) => {
      fetchCalls.push(url);
      const file = files.get(url);
      if (file === undefined) return { status: 404, text: async (): Promise<string> => 'not found' };
      // Served as bytes through a stream, so a binary fixture (a tar.gz) survives; text fixtures decode to the same text.
      const bytes = readFileSync(file);
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(bytes));
          c.close();
        },
      });
      return { status: 200, body, text: async (): Promise<string> => bytes.toString('utf8') };
    },
    { calls: fetchCalls },
  );

  const browserCalls: string[] = [];
  const browser = {
    calls: browserCalls,
    async render(req: BrowserRenderRequest): Promise<BrowserPage> {
      browserCalls.push(req.url);
      const html = files.get(req.url)?.endsWith('.html') ? read(req.url) : undefined;
      const expansion = req.expand ? { expansion: { clicks: 0, scrolls: 0, capReached: false, unfollowedControls: [] } } : {};
      if (html === undefined) return { status: 404, finalUrl: req.url, html: '<h1>Not found</h1>', text: 'Not found', jsonLd: [], headers: {}, settled: true, ...expansion };
      return { ...staticPage(req.url, html), ...expansion };
    },
  };
  return { fetch, browser };
}

/** A static HTML document as a rendered page: what a browser would report if no script changed it. */
export function staticPage(url: string, html: string): BrowserPage {
  const jsonLd: unknown[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      jsonLd.push(JSON.parse(m[1] ?? '') as unknown);
    } catch {
      // a block that does not parse is skipped, as the real provider does
    }
  }
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html)?.[1] ?? /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)?.[1] ?? html;
  return { status: 200, finalUrl: url, html, text: htmlToText(main), jsonLd, headers: { 'content-type': 'text/html' }, settled: true };
}
