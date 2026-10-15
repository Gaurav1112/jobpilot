import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFreelance } from '../../../src/app/freelance/run.js';
import { resolvePdftotext } from '../../../src/app/kernel.js';
import { offlineProviders } from '../../../src/app/offline.js';
import { runDaily } from '../../../src/app/run.js';

/**
 * Freelance regression (sources-expansion Task 10): with the new sources (Draft.dev, Prime Intellect, Fractional Jobs)
 * switched off in the fixture pack's freelance.yaml, the freelance run is the run `main` made before they existed: the
 * same step keys (agent, key, status). The golden was recorded from main's code with the same fixtures, pack, clock and
 * pinned code hash. A missing golden FAILS; only `UPDATE_GOLDEN=1` (re)writes it, deliberately.
 */
const root = join(import.meta.dirname, '../../..');
const FIXTURES = join(root, 'tests/fixtures/freelance-e2e');
const GOLDEN = join(root, 'tests/fixtures/freelance-identity.json');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();

/** The sources-expansion agents: they answer no request while their platform is off, but they still take a (empty) step per request. */
const NEW_SOURCES = new Set(['src-draftdev', 'src-prime-intellect', 'src-fractional-jobs']);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * What the run did, without the step-key hashes: those fold in the contract hashes, which change whenever `Platform`
 * gains a value (every contract carrying it), so they are not comparable across the change. The agents' steps with
 * their status and error code, and the envelopes' types with a hash of each payload, are.
 */
function snapshot(db: string): { steps: string[]; envelopes: string[] } {
  const d = new Database(db, { readonly: true });
  try {
    const steps = (d.prepare('SELECT agent_id, status, error_code FROM steps').all() as { agent_id: string; status: string; error_code: string | null }[])
      .filter((r) => !NEW_SOURCES.has(r.agent_id))
      .map((r) => `${r.agent_id} ${r.status} ${r.error_code ?? '-'}`)
      .sort();
    const envelopes = (d.prepare('SELECT type, body FROM envelopes').all() as { type: string; body: string }[])
      .map((r) => `${r.type} ${sha(JSON.stringify((JSON.parse(r.body) as { payload?: unknown }).payload ?? null))}`)
      .sort();
    return { steps, envelopes };
  } finally {
    d.close();
  }
}

describe.skipIf(pdftotext === undefined)('freelance run identity with the Task 10-12 sources off', () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-fl-identity-'));
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('steps, envelopes and fetched URLs equal the run recorded from main', async () => {
    const off = offlineProviders(FIXTURES);
    await runDaily({ home, clock: { now: () => '2026-10-12T01:30:00.000Z' }, fetch: off.fetch, browser: off.browser, sleep: async () => {}, pdftotext: pdftotext as string, codeHash: 'identity0000fixed' });
    const fl = offlineProviders(FIXTURES);
    const r = await runFreelance({ home, clock: { now: () => '2026-10-12T03:00:00.000Z' }, fetch: fl.fetch, sleep: async () => {}, pdftotext: pdftotext as string, codeHash: 'identity0000fixed' });
    expect(r.report.status).toBe('completed');
    const got = { ...snapshot(join(home, 'jobpilot.db')), fetched: fl.fetch.calls };
    if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(GOLDEN, `${JSON.stringify(got, null, 2)}\n`);
    if (!existsSync(GOLDEN)) throw new Error(`${GOLDEN} is missing: the freelance golden is never recreated silently; restore it from git, or run with UPDATE_GOLDEN=1 only on main's code`);
    const want = JSON.parse(readFileSync(GOLDEN, 'utf8')) as typeof got;
    expect(got.steps).toEqual(want.steps);
    expect(got.envelopes).toEqual(want.envelopes);
    expect(got.fetched).toEqual(want.fetched);
  }, 600_000);
});
