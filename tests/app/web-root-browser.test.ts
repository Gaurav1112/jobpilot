import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProfile } from '../../src/app/profiles/commands.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { serveRoot } from '../../src/app/web/root.js';
import { launchBrowser } from '../support/browser.js';
import { fillJobs } from '../support/jobs-fixture.js';

const repo = join(import.meta.dirname, '../..');
const clock = { now: () => '2026-10-09T06:30:00.000Z' };
const browser: Browser | undefined = await launchBrowser();
let root: string;
let close: () => Promise<void>;
let base: string;

describe.skipIf(browser === undefined)('the profiles root at 400 px', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'jobpilot-webroot-b-'));
    for (const id of ['asha', 'lena']) {
      createProfile({ root, id, clock, fromPack: join(repo, 'tests/fixtures/pack') });
      const app = AppStore.open(join(root, 'profiles', id, 'jobpilot.db'), { schema: 'migrate' });
      fillJobs(app, 3);
      app.close();
    }
    const server = serveRoot({ root, clock, port: 0 });
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterAll(async () => {
    await browser?.close();
    await close();
    rmSync(root, { recursive: true, force: true });
  });

  it('the switcher is visible and the page does not scroll sideways', async () => {
    const ctx = await (browser as Browser).newContext({ viewport: { width: 400, height: 800 } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${base}/p/asha/`, { waitUntil: 'load', timeout: 20_000 });
      expect(await page.locator('nav.profiles').isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
    } finally {
      await ctx.close();
    }
  });
});
