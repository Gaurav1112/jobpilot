import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppStore, type Doc } from '../../src/app/store/app-store.js';
import { serveDashboard } from '../../src/app/web/server.js';
import { jobRow } from '../support/app-fixtures.js';

/**
 * The dashboard in a real browser (Task 13 fix round 1): what unit tests cannot see because they write the request
 * headers themselves. With JavaScript off, each form is a plain POST: Chromium sets Origin and Referer by the page's
 * referrer policy, and every form must end in a 303 that persists. With JavaScript on, htmx errors must be shown.
 */
const root = join(import.meta.dirname, '../..');
const K1 = '1111111111111111';
const sha = (b: string): string => createHash('sha256').update(b).digest('hex');

const browser: Browser | undefined = await chromium.launch().catch(() => undefined);

let home: string;
let base: string;
let server: ReturnType<typeof serveDashboard>;

const withStore = <T>(fn: (s: AppStore) => T): T => {
  const s = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return fn(s);
  } finally {
    s.close();
  }
};

describe.skipIf(browser === undefined)('dashboard in Chromium', () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-webpw-'));
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    mkdirSync(join(home, 'out', K1), { recursive: true });
    withStore((s) => {
      s.upsertJob(jobRow({ jobKey: K1, docsState: 'ready', recommendedFormat: 'pdf' }));
      const docs: Doc[] = [];
      for (const kind of ['resume', 'cover'] as const) {
        for (const format of ['pdf', 'docx', 'html'] as const) {
          const body = `${kind}.${format}`;
          writeFileSync(join(home, 'out', K1, body), body);
          docs.push({ kind, format, path: `${K1}/${body}`, sha256: sha(body), pages: null, qaOk: true });
        }
      }
      s.putDocs(K1, docs);
    });
    server = serveDashboard({ home, clock: { now: () => '2026-10-09T06:30:00.000Z' }, port: 0, busyTimeoutMs: 200 });
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) (chmodSync(join(d, e.name), 0o755), walk(join(d, e.name)));
    };
    if (existsSync(home)) walk(home);
    rmSync(home, { recursive: true, force: true });
  });

  it('JavaScript off: status, note and fact verify are plain POSTs that end in a 303 and persist', async () => {
    const ctx = await (browser as Browser).newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    const posts: { url: string; status: number }[] = [];
    page.on('response', (r) => {
      if (r.request().method() === 'POST') posts.push({ url: new URL(r.url()).pathname, status: r.status() });
    });

    await page.goto(`${base}/jobs/${K1}`);
    await page.locator('button[name=to][value=approved]').click();
    await page.waitForURL(`${base}/jobs/${K1}#status`, { timeout: 10_000 });
    expect(withStore((s) => s.getJob(K1)?.status)).toBe('approved');

    await page.fill('#note', 'asked about the team');
    await page.getByRole('button', { name: 'Save note' }).click();
    await page.waitForURL(`${base}/jobs/${K1}#note-h`, { timeout: 10_000 });
    expect(withStore((s) => s.getJob(K1)?.note)).toBe('asked about the team');

    await page.goto(`${base}/facts`);
    await page.locator('form[action="/facts/f-nw-05/verify"] button').click();
    await page.waitForURL(`${base}/facts#fact-f-nw-05`, { timeout: 10_000 });
    expect(withStore((s) => s.factOverrides())).toMatchObject({ 'f-nw-05': 'verified' });

    expect(posts).toEqual([
      { url: `/jobs/${K1}/status`, status: 303 },
      { url: `/jobs/${K1}/note`, status: 303 },
      { url: '/facts/f-nw-05/verify', status: 303 },
    ]);
    await ctx.close();
  });

  it('JavaScript on: a refused htmx request is shown ("Your session expired, reload the page")', async () => {
    const ctx = await (browser as Browser).newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/jobs/${K1}`, { waitUntil: 'networkidle' });
    await expect.poll(() => page.locator('#htmx-error').isHidden()).toBe(true);
    await ctx.clearCookies(); // as after the session cookie is lost: the POST has no session
    await page.locator('button[name=to][value=interview]').click();
    await expect.poll(() => page.locator('#htmx-error').textContent()).toContain('Your session expired, reload the page');
    expect(await page.locator('#htmx-error').isVisible()).toBe(true);
    await ctx.close();
  });

  it('JavaScript on: a busy store is shown with the 503 message, and the click changes nothing', async () => {
    const ctx = await (browser as Browser).newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/jobs/${K1}`, { waitUntil: 'networkidle' });
    const before = withStore((s) => s.getJob(K1)?.status);
    const lock = new Database(join(home, 'jobpilot.db'));
    lock.exec('BEGIN IMMEDIATE');
    try {
      await page.locator('button[name=to][value=offer]').click();
      await expect.poll(() => page.locator('#htmx-error').textContent()).toContain("jobpilot is busy finishing today's run — try again in a moment");
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
    expect(withStore((s) => s.getJob(K1)?.status)).toBe(before);
    await ctx.close();
  });
});
