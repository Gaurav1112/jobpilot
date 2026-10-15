import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import type { PacerFactory } from '../../src/app/pacer.js';
import { runDaily } from '../../src/app/run.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';

const root = join(import.meta.dirname, '../..');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();

describe.skipIf(pdftotext === undefined)('runDaily pacer wiring', () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-run-pacer-'));
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: [himalayas]\n');
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('asks the injected factory for the http and the browser pacer, at the policy intervals', async () => {
    const calls: [number, string][] = [];
    const pacerFactory: PacerFactory = (ms, kind) => {
      calls.push([ms, kind]);
      return { wait: async () => {} };
    };
    const offline = offlineProviders(join(root, 'tests/fixtures/e2e'));
    const r = await runDaily({
      home,
      clock: { now: () => '2026-10-09T01:30:00.000Z' },
      fetch: offline.fetch,
      browser: offline.browser,
      sleep: async () => {},
      pdftotext: pdftotext as string,
      codeHash: 'identity0000fixed',
      pacerFactory,
    });
    expect(r.report.status).toBe('completed');
    expect(calls).toEqual([[PRODUCT_POLICY_V1.minHostIntervalMs, 'http'], [PRODUCT_POLICY_V1.minBrowserIntervalMs, 'browser']]);
  }, 120_000);
});
