import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../support/browser.js';
import { JOB } from '../support/web-fixture.js';
import { startFixtureServer, type FixtureServer } from '../support/web-server.js';

/** A2 (amendment 5): an opened preview shows the document on white paper, at 400 and 1440 px, light and dark. */
const browser: Browser | undefined = await launchBrowser();
let srv: FixtureServer;

describe.skipIf(browser === undefined)('previews in a real browser', () => {
  beforeAll(async () => {
    srv = await startFixtureServer();
  });
  afterAll(async () => {
    await browser?.close();
    await srv.close();
  });
  for (const [w, h] of [[400, 860], [1440, 900]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      it(`${w} px, ${scheme}: each preview, once opened, shows its text in dark ink on white, inside the page`, async () => {
        const ctx = await (browser as Browser).newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
        try {
          const page = await ctx.newPage();
          await page.goto(`${srv.base}/jobs/${JOB.ready}`, { waitUntil: 'load' });
          for (const kind of ['resume', 'cover'] as const) {
            const box = page.locator('details.preview-box').filter({ has: page.locator(`iframe.preview-${kind}`) });
            await box.locator('summary').click();
            const el = box.locator('iframe');
            await el.scrollIntoViewIfNeeded();
            const fr = page.frameLocator(`iframe.preview-${kind}`);
            await expect.poll(() => fr.locator('main').innerText(), { timeout: 15_000 }).toContain('Led the order pipeline');
            const bb = await el.boundingBox();
            expect(bb?.height ?? 0, kind).toBeGreaterThan(200);
            expect((bb?.x ?? 0) + (bb?.width ?? 0), kind).toBeLessThanOrEqual(w);
            expect(await fr.locator('body').evaluate((b) => getComputedStyle(b).backgroundColor), kind).toBe('rgb(255, 255, 255)');
            expect(await fr.locator('li').first().evaluate((e) => getComputedStyle(e).color), kind).toBe('rgb(17, 17, 17)');
            expect(await fr.locator('li').first().isVisible(), kind).toBe(true);
          }
        } finally {
          await ctx.close();
        }
      });
    }
  }
});
