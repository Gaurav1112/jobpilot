import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompanyVerdict } from '../../src/app/coverage/types.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { serveDashboard } from '../../src/app/web/server.js';

/**
 * The Companies tab in a real browser (career-sites Task 11): no page of it scrolls sideways at 400 px, long untrusted
 * names, reasons and URLs included; Approve works as a plain form post with JavaScript off.
 */
const root = join(import.meta.dirname, '../..');
const AT = '2026-10-11T01:30:00.000Z';
const LONG = 'Averyveryveryverylongcompanynamewithoutanyspacesatallthatmustwraponaphonescreen Holdings';

const browser: Browser | undefined = await chromium.launch().catch(() => undefined);
let home: string;
let base: string;
let server: ReturnType<typeof serveDashboard>;

function verdict(key: string, name: string, status: CompanyVerdict['status'], reasons: string[], boardUrl: string | null, platform: CompanyVerdict['guess']['platform']): CompanyVerdict {
  return {
    guess: {
      site: { candidate: { companyKey: key, name, website: `https://${key}`, careersUrl: null, source: 'remoteintech', runDate: '2026-10-11' }, careersUrl: `https://${key}/careers/${'x'.repeat(120)}`, method: 'listed', evidence: null },
      platform, slug: platform === null ? null : `${'tenant'.repeat(20)}/External`, boardUrl, signature: null, routedFrom: null, evidence: [],
    },
    status, reasons, boardName: null, jobsSeen: 3,
  };
}

describe.skipIf(browser === undefined)('companies tab in Chromium', () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-webcopw-'));
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    const s = AppStore.open(join(home, 'jobpilot.db'));
    try {
      s.upsertCompanyVerdict(verdict('acme.example', LONG, 'verified', [], 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs', 'workday'), AT);
      s.upsertCompanyVerdict(verdict('bank.example', `<b>${LONG}</b>`, 'proposed', [`board name '${'Q'.repeat(150)}' ≈ 'bank', please confirm`], null, 'oracle'), AT);
      s.upsertCompanyVerdict(verdict('hooli.example', 'Hooli', 'verified', [], 'https://hooli.wd1.myworkdayjobs.com/wday/cxs/hooli/Jobs/jobs', 'workday'), '2026-09-20T01:30:00.000Z');
      for (const w of ['2026-09-27', '2026-10-04', '2026-10-11']) s.upsertCompanyVerdict(verdict('hooli.example', 'Hooli', 'failed', [`error ${'E'.repeat(140)}`], null, null), `${w}T01:30:00.000Z`);
      s.kernel.startRun('coverage-2026-10-11', 'jobpilot-coverage', 'p', AT);
      s.disableCoverageHost('coverage-2026-10-11', `${'sub'.repeat(30)}.acme.example`, 'http-429', AT);
    } finally {
      s.close();
    }
    server = serveDashboard({ home, clock: { now: () => '2026-10-14T04:30:00.000Z' }, port: 0, busyTimeoutMs: 200 });
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });

  it('no page of the tab scrolls sideways at 400 px', async () => {
    const ctx = await (browser as Browser).newContext({ viewport: { width: 400, height: 800 } });
    const page = await ctx.newPage();
    for (const p of ['/companies', '/companies?done=approved&key=acme.example', '/?companyKey=acme.example&band=rejected&band=disclosed']) {
      await page.goto(`${base}${p}`, { waitUntil: 'networkidle' });
      const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(w.scroll, p).toBeLessThanOrEqual(w.client);
    }
    await ctx.close();
  });

  it('JavaScript off: Approve is a plain form post that lands back on the tab', async () => {
    const ctx = await (browser as Browser).newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto(`${base}/companies`);
    await page.locator('form[action="/companies/bank.example/approve"] button').click();
    await page.waitForURL(/done=approved/);
    expect(await page.locator('#verified-h').textContent()).toContain('2');
    await ctx.close();
  });
});
