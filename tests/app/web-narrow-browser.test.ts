import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../support/browser.js';
import { GOLDEN_ROUTES, NARROW_ONLY } from '../support/web-fixture.js';
import { startFixtureServer, type FixtureServer } from '../support/web-server.js';

/** UX upgrade A0 (amendment 1, D7 1.4.10): no page of the dashboard scrolls sideways at 400 px, JavaScript on or off. */
const browser: Browser | undefined = await launchBrowser();
const PAGES = [...GOLDEN_ROUTES.map(([n, p]) => [n, p] as const), ...NARROW_ONLY];
let srv: FixtureServer;

describe.skipIf(browser === undefined)('400 px: no page scrolls sideways', () => {
  beforeAll(async () => {
    srv = await startFixtureServer();
  });
  afterAll(async () => {
    await browser?.close();
    await srv.close();
  });

  for (const js of [true, false]) {
    it(`every page, JavaScript ${js ? 'on' : 'off'}`, async () => {
      const ctx = await (browser as Browser).newContext({ viewport: { width: 400, height: 860 }, javaScriptEnabled: js });
      const page = await ctx.newPage();
      const wide: string[] = [];
      try {
        for (const [name, path] of PAGES) {
          await page.goto(srv.base + path, { waitUntil: 'load', timeout: 20_000 });
          const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
          if (w.scroll > w.client) wide.push(`${name} ${path}: scrollWidth ${w.scroll} > ${w.client}`);
        }
      } finally {
        await ctx.close();
      }
      expect(wide).toEqual([]);
    });
  }
});
