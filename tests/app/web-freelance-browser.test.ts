import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { launchBrowser } from '../support/browser.js';
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
const B = 'b1b1b1b1b1b1b1b1';
const COVER = 'Dear Hiring Team,\nI’m applying for the role — with “quotes” & <angle> text.\n\nSincerely,\nAsha Rao\n';

const browser: Browser | undefined = await launchBrowser();
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
      // freelance-v2: a review contract from an employer job board with its cover letter, long words included
      s.upsertGig({
        gigKey: B, dedupeKey: B, platform: 'boards', sourceId: '2', url: 'https://jobs.example.com/roles/2', title: 'Senior Backend Engineer - Java/Spring Boot/Kafka/PostgreSQL/Kubernetes (6-month contract, remote India)', description: 'x',
        client: { name: 'Example Robotics International Holdings Private Limited' }, kind: 'contract', budget: { type: 'unknown' }, rate: { minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, fxSource: null, budgetUsd: null }, hours: { min: null, max: null },
        verdict: 'review', reasons: ['rate-unclear', 'hours-unclear'], notes: [], flags: [], fit: 72, breakdown: { base: 30 },
        list: 'review', docsState: 'ready', docsDetail: null, postedAt: '2026-10-11T09:00:00.000Z', at: '2026-10-12T14:00:00.000Z',
      });
      mkdirSync(join(home, 'out', 'gigs', B), { recursive: true });
      const coverFiles: [string, string][] = [['pitch.txt', 'Pitch.\n'], ['resume.pdf', 'pdf'], ['resume.docx', 'docx'], ['cover.txt', COVER], ['cover.pdf', 'cpdf'], ['cover.docx', 'cdocx'], ['cover.html', '<p>c</p>']];
      for (const [f, b] of coverFiles) writeFileSync(join(home, 'out', 'gigs', B, f), b);
      s.putGigDocs(B, coverFiles.map(([f, b]) => ({ kind: f.split('.')[0] as 'pitch' | 'resume' | 'cover', format: f.split('.')[1] as 'txt' | 'pdf' | 'docx' | 'html', path: `gigs/${B}/${f}`, sha256: sha(b), pages: null })));
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

  it('the cover letter Copy puts exactly cover.txt on the clipboard (freelance-v2)', async () => {
    const ctx = await (browser as Browser).newContext();
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const page = await ctx.newPage();
    await page.goto(`${base}/freelance/${B}`, { waitUntil: 'networkidle' });
    const button = page.locator('button.copy-btn[data-copy-target="cover-text"]');
    await expect.poll(() => button.isVisible()).toBe(true);
    await button.click();
    await expect.poll(() => page.locator('#cover-h ~ .paste-bar .copy-status').textContent()).toContain('Copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(Buffer.from(copied, 'utf8').equals(readFileSync(join(home, 'out', 'gigs', B, 'cover.txt')))).toBe(true);
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
    for (const p of ['/freelance', '/freelance?tab=gigs', '/freelance?tab=review', `/freelance/${G}`, `/freelance/${B}`, '/freelance/networks', '/freelance/sources']) {
      await page.goto(`${base}${p}`, { waitUntil: 'networkidle' });
      const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(w.scroll, p).toBeLessThanOrEqual(w.client);
    }
    await ctx.close();
  });
});
