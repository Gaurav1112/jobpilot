import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fullChainCheck } from '../../src/app/chain-status.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { rebuildDocs, runDaily } from '../../src/app/run.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { storeCompactCommand, storeRestoreCommand } from '../../src/app/store/compact-command.js';
import type { SegmentManifest } from '../../src/app/store/retention.js';
import { createDashboard } from '../../src/app/web/server.js';
import { Sessions } from '../../src/app/web/security.js';

/**
 * Retention end to end on real daily runs (offline fixtures): after `store compact --apply`
 * - the full audit verify passes;
 * - the dashboard (jobs, every job page with documents, runs, freelance) answers 200 and the job pages still show the
 *   plan behind their documents;
 * - memo safety: re-running the archived day executes the archived steps again (never an empty replay) and produces
 *   exactly the envelopes a fresh home produces for that day;
 * - docs rebuild still works;
 * - restore --all brings every archived envelope back byte for byte.
 * The daily golden is untouched by construction: compaction is a separate command, never called by a pipeline.
 */
const root = join(import.meta.dirname, '../..');
const FIXTURES = join(root, 'tests/fixtures/e2e');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();
const D1 = '2026-10-09T01:30:00.000Z';
const D2 = '2026-10-10T01:30:00.000Z';
const LATER = '2026-10-10T09:00:00.000Z';
const homes: string[] = [];
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-retention-e2e-'));
  homes.push(home);
  chmodSync(home, 0o700);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: [himalayas]\n');
  writeFileSync(join(home, 'pack/retention.yaml'), 'version: 1\nkeep: { daily: 1, freelance: 1, coverage: 1, rebuild: 1 }\n');
  return home;
}
const offline = offlineProviders(FIXTURES);
const setPenalty = (home: string, n: number): void => {
  const t = join(home, 'pack/targets.yaml');
  writeFileSync(t, readFileSync(t, 'utf8').replace(/yearsPenalty: \d+/, `yearsPenalty: ${n}`));
};
const run = (home: string, at: string) =>
  runDaily({ home, clock: { now: () => at }, fetch: offline.fetch, browser: offline.browser, sleep: async () => {}, pdftotext: pdftotext as string, codeHash: 'retention-e2e' });
const envelopes = (home: string): Map<string, string> => {
  const a = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return new Map((a.kernel.db.prepare(`SELECT envelope_id, body FROM envelopes`).all() as { envelope_id: string; body: string }[]).map((r) => [r.envelope_id, r.body]));
  } finally {
    a.close();
  }
};

/** Day 1, a pack change, day 2, then `store compact --apply` (daily: 1): day 1's own steps are archived. */
async function compacted(): Promise<{ home: string; before: Map<string, string>; manifest: SegmentManifest }> {
  const home = newHome();
  expect((await run(home, D1)).report.status).toBe('completed');
  // a pack change between the days, so day 1's pack-reading steps are day 1's alone (otherwise day 2 replays them)
  setPenalty(home, 21);
  expect((await run(home, D2)).report.status).toBe('completed');
  const before = envelopes(home);
  const out: string[] = [];
  expect(await storeCompactCommand({ home, clock: { now: () => LATER }, out: (l) => out.push(l), err: (l) => out.push(l), apply: true, includeIncomplete: false, vacuum: true })).toBe(0);
  const seg = /archive\/(envelopes-[^ ]+\.jsonl\.gz)/.exec(out.join('\n'))?.[1] as string;
  return { home, before, manifest: JSON.parse(readFileSync(join(home, 'archive', `${seg}.manifest.json`), 'utf8')) as SegmentManifest };
}

describe.skipIf(pdftotext === undefined)('store compact on real daily runs', () => {
  let home: string;
  let before: Map<string, string>;
  let manifest: SegmentManifest;

  beforeAll(async () => {
    ({ home, before, manifest } = await compacted());
  }, 300_000);

  it('archived something of day 1, kept day 2 whole', () => {
    expect(manifest.counts.envelopes).toBeGreaterThan(3);
    expect(manifest.counts.steps).toBeGreaterThan(3);
    const now = envelopes(home);
    expect(now.size).toBe(before.size - manifest.counts.envelopes);
  });

  it('the full audit passes after compaction', () => {
    const a = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(fullChainCheck(a.kernel, LATER, { record: false })).toMatchObject({ ok: true });
    } finally {
      a.close();
    }
  });

  it('the dashboard answers: jobs, every job page with documents (with its plan), runs, freelance', async () => {
    const app = createDashboard({ home, clock: { now: () => LATER }, sessions: new Sessions(Buffer.alloc(32, 7)) });
    const get = async (p: string) => {
      const r = await app.request(p, { headers: { host: 'localhost', cookie: 'jp_sid=' + 'ab'.repeat(16) } });
      return { status: r.status, body: await r.text() };
    };
    for (const p of ['/', '/runs', '/freelance', '/companies', '/facts']) expect((await get(p)).status, p).toBe(200);
    const a = AppStore.open(join(home, 'jobpilot.db'));
    const withDocs = (a.kernel.db.prepare(`SELECT DISTINCT job_key FROM job_docs`).all() as { job_key: string }[]).map((r) => r.job_key);
    const plans = withDocs.map((k) => a.renderedPlanOf(k));
    a.close();
    expect(withDocs.length).toBeGreaterThan(0);
    expect(plans.every((p) => p !== undefined)).toBe(true);
    for (const k of withDocs) expect((await get(`/jobs/${k}`)).status, k).toBe(200);
  });

  it('docs rebuild still works', async () => {
    const r = await rebuildDocs({ home, clock: { now: () => LATER }, sleep: async () => {}, pdftotext: pdftotext as string });
    expect(r.exitCode).toBe(0);
  }, 300_000);

  it('restore --all brings every archived envelope back byte for byte', async () => {
    expect(await storeRestoreCommand({ home, clock: { now: () => LATER }, out: () => {}, err: () => {}, all: true })).toBe(0);
    const got = envelopes(home);
    expect(manifest.envelopeIds.filter((id) => got.get(id) !== before.get(id))).toEqual([]);
    const a = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(fullChainCheck(a.kernel, LATER, { record: false })).toMatchObject({ ok: true });
    } finally {
      a.close();
    }
  });
});

describe.skipIf(pdftotext === undefined)('memo safety on real daily runs', () => {
  it('memo safety: re-running day 1 executes the archived steps again and equals a fresh home\'s day 1', async () => {
    const { home, before, manifest } = await compacted();
    setPenalty(home, 20); // day 1's pack again: day 1's step keys
    const again = await run(home, D1);
    expect(again.report.status).toBe('completed');
    const fresh = newHome();
    expect((await run(fresh, D1)).report.status).toBe('completed');
    const want = envelopes(fresh);
    const got = envelopes(home);
    const diff = [...want].filter(([id, body]) => got.get(id) !== body).map(([id]) => id);
    expect(diff).toEqual([]);
    // the archived envelopes it made again are byte-identical to the originals
    const remade = manifest.envelopeIds.filter((id) => got.has(id));
    expect(remade.length).toBeGreaterThan(0);
    expect(remade.filter((id) => got.get(id) !== before.get(id))).toEqual([]);
    // and they were executed, not replayed as empty outputs
    const a = AppStore.open(join(home, 'jobpilot.db'));
    try {
      const kinds = (a.kernel.db.prepare(`SELECT kind, COUNT(*) AS n FROM events WHERE run_id = ? GROUP BY kind`).all(again.runId) as { kind: string; n: number }[]);
      expect(kinds.find((k) => k.kind === 'step_done')?.n ?? 0).toBeGreaterThan(0);
    } finally {
      a.close();
    }
  }, 300_000);

});
