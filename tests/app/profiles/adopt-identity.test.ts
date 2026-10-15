import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { resolvePdftotext } from '../../../src/app/kernel.js';
import { offlineProviders } from '../../../src/app/offline.js';
import { adoptProfile, unadoptProfile } from '../../../src/app/profiles/adopt.js';
import { runDaily } from '../../../src/app/run.js';
import { outTreeHashes, snapshot } from '../../support/identity-snapshot.js';

const repo = join(import.meta.dirname, '../../..');
const pdftotext = (() => { try { return resolvePdftotext(); } catch { return undefined; } })();
const homes: string[] = [];
const newHome = (): string => {
  const h = mkdtempSync(join(tmpdir(), 'jobpilot-adoptid-'));
  homes.push(h);
  cpSync(join(repo, 'tests/fixtures/pack'), join(h, 'pack'), { recursive: true });
  writeFileSync(join(h, 'pack/feeds.yaml'), 'enabled: [himalayas]\n');
  return h;
};
const day = async (home: string, iso: string) => {
  const offline = offlineProviders(join(repo, 'tests/fixtures/e2e'));
  const r = await runDaily({ home, clock: { now: () => iso }, fetch: offline.fetch, browser: offline.browser, sleep: async () => {}, pdftotext: pdftotext as string, codeHash: 'identity0000fixed' });
  expect(r.report.status).toBe('completed');
};
/** No TEXT anywhere in the DB names the home's absolute path (so moving the home cannot change a row). */
const mentions = (db: string, path: string): string[] => {
  const d = new Database(db, { readonly: true });
  try {
    const tables = (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
    return tables.filter((t) => (d.prepare(`SELECT * FROM "${t}"`).all() as unknown[]).some((row) => JSON.stringify(row).includes(path)));
  } finally {
    d.close();
  }
};
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

describe.skipIf(pdftotext === undefined)('adopt is byte-identical (spec §3 golden)', () => {
  it('day 2 after adopt equals day 2 without it; unadopt keeps day 3 equal too', async () => {
    const control = newHome();
    const adopted = newHome();
    await day(control, '2026-10-09T01:30:00.000Z');
    await day(adopted, '2026-10-09T01:30:00.000Z');
    expect(mentions(join(adopted, 'jobpilot.db'), adopted)).toEqual([]);
    const { home } = await adoptProfile({ root: adopted, id: 'owner', clock: { now: () => '2026-10-09T12:00:00.000Z' } });
    await day(control, '2026-10-10T01:30:00.000Z');
    await day(home, '2026-10-10T01:30:00.000Z');
    expect(snapshot(join(home, 'jobpilot.db'))).toEqual(snapshot(join(control, 'jobpilot.db')));
    expect(outTreeHashes(join(home, 'out'))).toEqual(outTreeHashes(join(control, 'out')));
    await unadoptProfile({ root: adopted, clock: { now: () => '2026-10-10T12:00:00.000Z' } });
    await day(control, '2026-10-11T01:30:00.000Z');
    await day(adopted, '2026-10-11T01:30:00.000Z');
    expect(snapshot(join(adopted, 'jobpilot.db'))).toEqual(snapshot(join(control, 'jobpilot.db')));
    expect(outTreeHashes(join(adopted, 'out'))).toEqual(outTreeHashes(join(control, 'out')));
    expect(readFileSync(join(adopted, 'pack', 'facts.yaml'), 'utf8')).toBe(readFileSync(join(control, 'pack', 'facts.yaml'), 'utf8'));
  }, 300_000);
});
