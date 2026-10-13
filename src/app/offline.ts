import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { BrowserPage, BrowserProvider, BrowserRenderRequest, FetchLike } from '../kernel/providers.js';
import { htmlToText } from './agents/sources/careers.js';

/**
 * `jobpilot run --offline-fixtures <dir>`: recorded responses instead of the network. `<dir>/index.json` maps each
 * URL to a file in `<dir>` (`{"https://…": "board.json"}`), or to a recorded response
 * `{"status": 403, "file": "challenge.html"}` / `{"status": 301, "location": "https://…"}` (a missing file is an empty
 * body). `fetch` serves a plain mapping with status 200 and a recorded response with its status and Location; the
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
  const responses = new Map<string, { status: number; location: string | null }>();
  const inRoot = (file: string): string => {
    const abs = resolve(root, file);
    if (!abs.startsWith(root + sep)) throw new Error(`${join(root, 'index.json')}: ${file} is outside ${root}`);
    return abs;
  };
  for (const [url, entry] of Object.entries(index)) {
    if (typeof entry === 'string') {
      files.set(url, inRoot(entry));
      continue;
    }
    const e = entry as { status?: unknown; file?: unknown; location?: unknown } | null;
    const ok = typeof e === 'object' && e !== null && Number.isInteger(e.status) && (e.file === undefined || typeof e.file === 'string') && (e.location === undefined || typeof e.location === 'string');
    if (!ok) throw new Error(`${join(root, 'index.json')}: ${url} must map to a file name or {status, file?, location?}`);
    if (typeof e.file === 'string') files.set(url, inRoot(e.file));
    responses.set(url, { status: e.status as number, location: typeof e.location === 'string' ? e.location : null });
  }
  const read = (url: string): string | undefined => {
    const f = files.get(url);
    return f === undefined ? undefined : readFileSync(f, 'utf8');
  };

  const fetchCalls: string[] = [];
  const fetch = Object.assign(
    async (url: string, init?: Parameters<FetchLike>[1]) => {
      fetchCalls.push(url);
      const postKey = init?.method === 'POST' ? `POST ${url} ${init.body ?? ''}` : undefined;
      const key = postKey !== undefined && (files.has(postKey) || responses.has(postKey)) ? postKey : url;
      const file = files.get(key);
      const recorded = responses.get(key);
      if (file === undefined && recorded === undefined) return { status: 404, text: async (): Promise<string> => 'not found' };
      // Served as bytes through a stream, so a binary fixture (a tar.gz) survives; text fixtures decode to the same text.
      const bytes = file === undefined ? Buffer.alloc(0) : readFileSync(file);
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(bytes));
          c.close();
        },
      });
      const headers = { get: (n: string): string | null => (n.toLowerCase() === 'location' ? (recorded?.location ?? null) : null) };
      return { status: recorded?.status ?? 200, body, headers, text: async (): Promise<string> => bytes.toString('utf8') };
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
