import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Browser } from 'playwright';
import { launchBrowser } from './browser.js';
import { GOLDEN_ROUTES } from './web-fixture.js';
import { startFixtureServer } from './web-server.js';

/** Every golden route at 1440 and 400 px, light and dark, full page (UX upgrade: before/after evidence per PR). */
const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (values.out === undefined) throw new Error('usage: screenshots.ts --out <dir>');
mkdirSync(values.out, { recursive: true });
const browser = (await launchBrowser()) as Browser;
const srv = await startFixtureServer();
let n = 0;
try {
  for (const [w, h] of [[1440, 900], [400, 860]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
      const page = await ctx.newPage();
      for (const [name, path] of GOLDEN_ROUTES) {
        await page.goto(srv.base + path, { waitUntil: 'networkidle', timeout: 30_000 });
        // previews are sandboxed (cross-origin) frames: bring each into view so a full-page shot paints it
        for (const f of await page.locator('iframe').all()) if (await f.isVisible()) await f.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(values.out, `${name}-${w}-${scheme}.png`), fullPage: true });
        n += 1;
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await srv.close();
}
console.log(`screenshots: ${n} in ${values.out}`);
