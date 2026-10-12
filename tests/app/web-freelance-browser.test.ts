import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppStore } from '../../src/app/store/app-store.js';
import { serveDashboard } from '../../src/app/web/server.js';

/**
 * The freelance Copy button in a real browser (Task 10): it copies exactly the bytes of the recorded `.txt` file, line
 * ends, quotes, non-ASCII and the final newline included, and the page does not scroll sideways at phone width.
 */
const root = join(import.meta.dirname, '../..');
const G = 'a2a2a2a2a2a2a2a2';
const TEXT = 'Hi — your “order service” needs care.\n\nI built a <payments> service & more.\n  1. Read the code.\nI send updates every two days.\n';
const sha = (b: string): string => createHash('sha256').update(b).digest('hex');

const browser: Browser | undefined = await chromium.launch().catch(() => undefined);
let home: string;
let base: string;
let server: ReturnType<typeof serveDashboard>;

describe.skipIf(browser === undefined)('freelance Copy in Chromium', () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-webflpw-'));
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    mkdirSync(join(home, 'out', 'gigs', G), { recursive: true });
    const s = AppStore.open(join(home, 'jobpilot.db'));
    try {
      s.upsertGig({
        gigKey: G, dedupeKey: G, platform: 'freelancer', sourceId: '1', url: 'https://www.freelancer.example/projects/1', title: 'A gig with a long title that must wrap on a narrow phone screen without scrolling', description: 'x',
        client: {}, kind: 'gig', budget: { type: 'fixed' }, rate: { minUsdH: 50, maxUsdH: 50, method: 'stated', fxDate: null, fxSource: null, budgetUsd: null }, hours: { min: null, max: null },
        verdict: 'eligible', reasons: [], notes: ['requirement softened nearby - verify'], flags: [{ id: 'off-platform', detail: 'd' }, { id: 'thin-brief', detail: 'd' }], fit: 60, breakdown: { base: 30 },
        list: 'gigs', docsState: 'ready', docsDetail: null, postedAt: null, at: '2026-10-12T14:00:00.000Z',
      });
      const files: [string, string][] = [['proposal.txt', TEXT], ['resume.pdf', 'pdf'], ['resume.docx', 'docx']];
      for (const [f, b] of files) writeFileSync(join(home, 'out', 'gigs', G, f), b);
      s.putGigDocs(G, files.map(([f, b]) => ({ kind: f.split('.')[0] as 'proposal' | 'resume', format: f.split('.')[1] as 'txt' | 'pdf' | 'docx', path: `gigs/${G}/${f}`, sha256: sha(b), pages: null })));
    } finally {
      s.close();
    }
    server = serveDashboard({ home, clock: { now: () => '2026-10-12T14:30:00.000Z' }, port: 0, busyTimeoutMs: 200 });
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });

  it('Copy puts exactly the .txt file bytes on the clipboard', async () => {
    const ctx = await (browser as Browser).newContext();
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const page = await ctx.newPage();
    await page.goto(`${base}/freelance/${G}`, { waitUntil: 'networkidle' });
    const button = page.getByRole('button', { name: 'Copy' });
    await expect.poll(() => button.isVisible()).toBe(true);
    await button.click();
    await expect.poll(() => page.locator('.copy-status').textContent()).toContain('Copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(readFileSync(join(home, 'out', 'gigs', G, 'proposal.txt'), 'utf8'));
    expect(Buffer.from(copied, 'utf8').equals(readFileSync(join(home, 'out', 'gigs', G, 'proposal.txt')))).toBe(true);
    await ctx.close();
  });

  it('JavaScript off: no Copy button is shown, the .txt link is', async () => {
    const ctx = await (browser as Browser).newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto(`${base}/freelance/${G}`);
    expect(await page.getByRole('button', { name: 'Copy' }).isVisible()).toBe(false);
    expect(await page.locator(`a[href="/freelance/${G}/files/proposal.txt"]`).isVisible()).toBe(true);
    await ctx.close();
  });

  it('no page of the tab scrolls sideways at 400 px', async () => {
    const ctx = await (browser as Browser).newContext({ viewport: { width: 400, height: 800 } });
    const page = await ctx.newPage();
    for (const p of ['/freelance?tab=gigs', `/freelance/${G}`, '/freelance/networks', '/freelance/sources']) {
      await page.goto(`${base}${p}`, { waitUntil: 'networkidle' });
      const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(w.scroll, p).toBeLessThanOrEqual(w.client);
    }
    await ctx.close();
  });
});
