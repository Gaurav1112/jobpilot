import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { runDaily } from '../../src/app/run.js';
import type { FetchLike } from '../../src/kernel/providers.js';

/**
 * The daily run is wired to the supervisor's wake rule: with the network down at the start (every fetch fails
 * ENOTFOUND, as during a DarkWake) and the online check saying offline, the failed sources are re-queued once the
 * check passes, and the run ends exactly as the strict daily-identity golden: same step keys, statuses and outputs.
 * No sleep- or outage-related value enters a step key or an envelope.
 */
const root = join(import.meta.dirname, '../..');
const GOLDEN = join(root, 'tests/fixtures/daily-identity.json');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();

describe.skipIf(pdftotext === undefined)('daily run: transport failures while offline are re-queued and the run ends as the golden', () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-wake-'));
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: [himalayas]\n');
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('re-queues after the online check passes; steps and envelopes equal the golden', async () => {
    const offline = offlineProviders(join(root, 'tests/fixtures/e2e'));
    let down = true;
    let failed = 0;
    const fetch: FetchLike = async (url, init) => {
      if (down) {
        failed++;
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      }
      return offline.fetch(url, init);
    };
    let checks = 0;
    const r = await runDaily({
      home,
      clock: { now: () => '2026-10-09T01:30:00.000Z' },
      fetch,
      browser: offline.browser,
      sleep: async () => {},
      pdftotext: pdftotext as string,
      codeHash: 'identity0000fixed',
      online: async () => {
        if (checks++ === 0) return false; // offline when the first source fails
        down = false;
        return true;
      },
    });
    expect(r.report.status).toBe('completed');
    expect(failed).toBeGreaterThan(0);
    const d = new Database(join(home, 'jobpilot.db'), { readonly: true });
    try {
      const steps = (d.prepare('SELECT agent_id, step_key, status, error_code FROM steps ORDER BY agent_id, step_key').all() as { agent_id: string; step_key: string; status: string; error_code: string | null }[]).map(
        (s) => `${s.agent_id} ${s.step_key} ${s.status} ${s.error_code ?? '-'}`,
      );
      const envelopes = (d.prepare('SELECT envelope_id FROM envelopes ORDER BY envelope_id').all() as { envelope_id: string }[]).map((e) => e.envelope_id);
      const kinds = (d.prepare(`SELECT kind FROM events WHERE run_id = ?`).all(r.runId) as { kind: string }[]).map((e) => e.kind);
      const want = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { steps: string[]; envelopes: string[] };
      expect(steps).toEqual(want.steps);
      expect(envelopes).toEqual(want.envelopes.map((e) => e.split(' ')[0]));
      expect(kinds).toContain('wake_retry_due');
      expect(kinds).toContain('wake_requeued');
    } finally {
      d.close();
    }
  }, 120_000);
});
