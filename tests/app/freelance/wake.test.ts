import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runFreelance } from '../../../src/app/freelance/run.js';
import { resolvePdftotext } from '../../../src/app/kernel.js';
import { offlineProviders } from '../../../src/app/offline.js';
import type { FetchLike } from '../../../src/kernel/providers.js';

/**
 * The freelance run is wired to the supervisor's wake rule: every fetch fails ENOTFOUND at the start (a DarkWake, no
 * network yet) while the online check says offline; the sources are re-queued once it passes and none fails.
 */
const root = join(import.meta.dirname, '../../..');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();
const homes: string[] = [];
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe.skipIf(pdftotext === undefined)('freelance run: transport failures while offline are re-queued', () => {
  it('no source fails once the online check passes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jobpilot-freelance-wake-'));
    homes.push(home);
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    const off = offlineProviders(join(root, 'tests/fixtures/freelance-e2e'));
    let down = true;
    let failed = 0;
    const fetch: FetchLike = async (url, init) => {
      if (down) {
        failed++;
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      }
      return off.fetch(url, init);
    };
    let checks = 0;
    const r = await runFreelance({
      home, clock: { now: () => '2026-10-12T03:00:00.000Z' }, fetch, sleep: async () => {}, pdftotext: pdftotext as string,
      online: async () => {
        if (checks++ === 0) return false;
        down = false;
        return true;
      },
    });
    expect(failed).toBeGreaterThan(0);
    expect(r.report.status).toBe('completed');
    for (const agent of ['src-hn', 'src-remotive', 'src-freelancer']) expect(r.counts.byAgent[agent], agent).toMatchObject({ failed: 0, skipped: 0 });
  }, 600_000);
});
