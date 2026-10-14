import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { runFreelance } from '../../src/app/freelance/run.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { liveHolder } from '../../src/app/lock.js';
import { offlineProviders } from '../../src/app/offline.js';
import { runDaily } from '../../src/app/run.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { APP_MIGRATIONS } from '../../src/app/store/schema.js';
import { jobRow } from '../support/app-fixtures.js';

/**
 * Final re-review P3: the daily and the freelance run each migrate a database whose schema is behind the code, inside
 * the run lock, and complete. They are the openers allowed to migrate (`schema: 'migrate'`); the dashboard and every
 * other command refuse a behind schema, so without this the upgrade would never happen.
 */
const root = join(import.meta.dirname, '../..');
/** The index the last app migration creates: dropped (with the version set one back) to make a schema that is behind. */
const LAST_INDEX = /CREATE INDEX IF NOT EXISTS (\w+)/.exec(String(APP_MIGRATIONS.at(-1)))?.[1] as string;
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

function behindHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-run-migrates-'));
  homes.push(home);
  chmodSync(home, 0o700);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  // no sources: the run has nothing to fetch, so it completes fast; the point is the open
  writeFileSync(join(home, 'pack/watchlist.yaml'), 'watchlist: []\n');
  writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: []\n');
  const s = AppStore.open(join(home, 'jobpilot.db'), { schema: 'migrate' });
  s.upsertJob(jobRow());
  s.close();
  const d = new Database(join(home, 'jobpilot.db'));
  d.exec(`DROP INDEX ${LAST_INDEX}; UPDATE app_schema SET version = ${APP_MIGRATIONS.length - 1}`);
  d.close();
  return home;
}
const version = (home: string): number => {
  const d = new Database(join(home, 'jobpilot.db'), { readonly: true });
  try {
    return (d.prepare(`SELECT version FROM app_schema`).get() as { version: number }).version;
  } finally {
    d.close();
  }
};

describe.skipIf(pdftotext === undefined)('runs migrate a behind schema under the run lock', () => {
  it('the daily run', async () => {
    const home = behindHome();
    let locked = false;
    const r = await runDaily({
      home, clock: { now: () => '2026-10-14T01:30:00.000Z' }, fetch: offlineProviders(join(root, 'tests/fixtures/e2e')).fetch, sleep: async () => {},
      pdftotext: pdftotext as string, codeHash: 'run-migrates',
      onLocked: () => {
        expect(liveHolder(home)).toMatchObject({ pid: process.pid, command: 'run' });
        expect(version(home)).toBe(APP_MIGRATIONS.length - 1);
        locked = true;
      },
    });
    expect(locked).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(version(home)).toBe(APP_MIGRATIONS.length);
  }, 120_000);

  it('the freelance run', async () => {
    const home = behindHome();
    let locked = false;
    const r = await runFreelance({
      home, clock: { now: () => '2026-10-14T02:00:00.000Z' }, fetch: offlineProviders(join(root, 'tests/fixtures/freelance-e2e')).fetch, sleep: async () => {},
      pdftotext: pdftotext as string, codeHash: 'run-migrates',
      onLocked: () => {
        expect(liveHolder(home)).toMatchObject({ pid: process.pid });
        expect(version(home)).toBe(APP_MIGRATIONS.length - 1);
        locked = true;
      },
    });
    expect(locked).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(version(home)).toBe(APP_MIGRATIONS.length);
  }, 120_000);
});
