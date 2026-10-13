import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { runDaily } from '../../src/app/run.js';

/**
 * Daily byte-identity (career-sites spec §7, Task 6): with an EMPTY company registry the daily pipeline is identical
 * to the one before the registry existed: the same step keys (agent, key, status), the same output envelopes (ids,
 * types, payloads), the same job rows and the same document hashes. The golden file was recorded from the code
 * before the Workday adapter (617d692, whose daily pipeline is main's) with the same fixtures, pack, clock and pinned
 * code hash. A missing golden FAILS; only `UPDATE_GOLDEN=1` (re)writes it, deliberately, from the code under test.
 *
 * Contract versions and hashes are deliberately not compared: `DiscoveryRequest.ats` and `Posting.ats` gained
 * `workday`, so every contract carrying them took a minor version bump (the step key holds only the major).
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

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

interface Snapshot {
  readonly steps: string[];
  readonly envelopes: string[];
  readonly jobs: string;
  readonly docs: string[];
  readonly companies: number;
}

function snapshot(db: string): Snapshot {
  const d = new Database(db, { readonly: true });
  try {
    const steps = (d.prepare('SELECT agent_id, step_key, status, error_code FROM steps ORDER BY agent_id, step_key').all() as { agent_id: string; step_key: string; status: string; error_code: string | null }[]).map(
      (r) => `${r.agent_id} ${r.step_key} ${r.status} ${r.error_code ?? '-'}`,
    );
    const envelopes = (d.prepare('SELECT envelope_id, step_key, idx, type, body FROM envelopes ORDER BY envelope_id').all() as { envelope_id: string; step_key: string; idx: number; type: string; body: string }[]).map((r) => {
      const body = JSON.parse(r.body) as { payload?: unknown };
      return `${r.envelope_id} ${r.step_key} ${r.idx} ${r.type} ${sha(JSON.stringify(body.payload ?? null))}`;
    });
    const jobs = sha(JSON.stringify(d.prepare('SELECT * FROM jobs ORDER BY job_key').all()));
    const docs = (d.prepare('SELECT * FROM job_docs ORDER BY 1, 2, 3').all() as Record<string, unknown>[]).map((r) => JSON.stringify(r));
    const companies = (d.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number }).n;
    return { steps, envelopes, jobs, docs, companies };
  } finally {
    d.close();
  }
}

describe.skipIf(pdftotext === undefined)('daily byte-identity with an empty company registry', () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-identity-'));
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: [himalayas]\n');
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('step keys, envelopes, job rows and document hashes equal the recorded pre-registry run', async () => {
    const offline = offlineProviders(join(root, 'tests/fixtures/e2e'));
    const r = await runDaily({
      home,
      clock: { now: () => '2026-10-09T01:30:00.000Z' },
      fetch: offline.fetch,
      browser: offline.browser,
      sleep: async () => {},
      pdftotext: pdftotext as string,
      codeHash: 'identity0000fixed',
    });
    expect(r.report.status).toBe('completed');
    const got = snapshot(join(home, 'jobpilot.db'));
    expect(got.companies).toBe(0);
    if (process.env['UPDATE_GOLDEN'] === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify({ ...got, fetched: offline.fetch.calls }, null, 2)}\n`);
    }
    if (!existsSync(GOLDEN)) throw new Error(`${GOLDEN} is missing: the byte-identity golden is never recreated silently; restore it from git, or run with UPDATE_GOLDEN=1 only when the change is meant to alter the daily run`);
    const want = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Snapshot & { fetched: string[] };
    expect(got.steps).toEqual(want.steps);
    expect(got.envelopes).toEqual(want.envelopes);
    expect(got.jobs).toBe(want.jobs);
    expect(got.docs).toEqual(want.docs);
    expect(offline.fetch.calls).toEqual(want.fetched);
    // no Workday step and no Workday agent: the step-key list names exactly the pre-registry agents
    expect([...new Set(got.steps.map((s) => s.split(' ')[0]))]).not.toContain('src-workday');
  }, 120_000);
});
