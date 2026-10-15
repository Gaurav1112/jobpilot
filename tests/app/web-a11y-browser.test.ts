import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../support/browser.js';
import { JOB } from '../support/web-fixture.js';
import { startFixtureServer, type FixtureServer } from '../support/web-server.js';

/** A12 (D7 2.4.3, 4.1.3): after an htmx swap focus stays on the control used, and the change is announced. */
const browser: Browser | undefined = await launchBrowser();
let srv: FixtureServer;

describe.skipIf(browser === undefined)('focus and announcements after htmx swaps', () => {
  beforeAll(async () => {
    srv = await startFixtureServer();
  });
  afterAll(async () => {
    await browser?.close();
    await srv.close();
  });
  it('Shortlist from the keyboard: focus comes back to Shortlist, and "Status set to Shortlisted." is announced', async () => {
    const ctx = await (browser as Browser).newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(`${srv.base}/jobs/${JOB.ready}`, { waitUntil: 'networkidle' });
      await page.locator('#status-to-approved').focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => page.locator('#live').textContent(), { timeout: 10_000 }).toBe('Status set to Shortlisted.');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('status-to-approved');
    } finally {
      await ctx.close();
    }
  });
  it('Verify a fact: its button is gone after the swap, so focus lands on the row itself', async () => {
    const ctx = await (browser as Browser).newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(`${srv.base}/facts`, { waitUntil: 'networkidle' });
      await page.locator('#fact-f-nw-05-verify').focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => document.activeElement?.id), { timeout: 10_000 }).toBe('fact-f-nw-05');
      expect(await page.locator('#live').textContent()).toBe('Saved: Verified.');
    } finally {
      await ctx.close();
    }
  });
});
