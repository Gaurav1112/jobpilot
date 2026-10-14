import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { due, DAILY_DUE } from '../../src/app/due.js';
import { AppStore, SchemaBehindError } from '../../src/app/store/app-store.js';
import { APP_MIGRATIONS } from '../../src/app/store/schema.js';
import { jobRow } from '../support/app-fixtures.js';

/**
 * dashboard-perf re-review: only runs (inside their lock) and `jobpilot facts list` (through `upgradeUnderLock`) migrate
 * the database. Every other command that opens it, on a schema behind its code, says so and exits 2, leaving the
 * database untouched; the due checks of `--if-due` read it as it is, so the scheduled run can start and migrate it.
 */
const root = join(import.meta.dirname, '../..');
let home: string;
const db = (): string => join(home, 'jobpilot.db');
const MESSAGE = 'the database needs an upgrade; run `jobpilot facts list` (it takes the run lock)';

/** The schema one migration behind this code, with a row in it. */
function makeBehind(): void {
  const s = AppStore.open(db(), { schema: 'migrate' });
  s.upsertJob(jobRow());
  s.close();
  const d = new Database(db());
  d.exec(`DROP INDEX envelopes_rendered_by_job; UPDATE app_schema SET version = ${APP_MIGRATIONS.length - 1}`);
  d.close();
}
const state = (): { version: number; index: boolean } => {
  const d = new Database(db(), { readonly: true });
  try {
    return {
      version: (d.prepare(`SELECT version FROM app_schema`).get() as { version: number }).version,
      index: d.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'envelopes_rendered_by_job'`).get() !== undefined,
    };
  } finally {
    d.close();
  }
};
const BEHIND = { version: APP_MIGRATIONS.length - 1, index: false };
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/bin.ts'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, JOBPILOT_HOME: home, VITEST: 'true' } });

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'jobpilot-behind-'));
  chmodSync(home, 0o700);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  makeBehind();
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('a schema behind the code: only locked commands migrate', () => {
  it('AppStore.open refuses by default, reads as it is with schema "as-is", migrates only with schema "migrate"', () => {
    expect(() => AppStore.open(db())).toThrow(SchemaBehindError);
    expect(() => AppStore.open(db())).toThrow(MESSAGE);
    const r = AppStore.open(db(), { schema: 'as-is' });
    expect(r.listRuns(1)).toEqual([]);
    r.close();
    expect(state()).toEqual(BEHIND);
  });

  it('a new, empty database is created by any opener (no data to migrate)', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'jobpilot-behind-fresh-'));
    try {
      const s = AppStore.open(join(fresh, 'jobpilot.db'));
      expect(s.schemaVersion()).toBe(APP_MIGRATIONS.length);
      s.close();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('a KERNEL schema behind the code is refused in every mode but migrate (as-is too); the due check then says owed', () => {
    const k = mkdtempSync(join(tmpdir(), 'jobpilot-behind-kernel-'));
    try {
      chmodSync(k, 0o700);
      const path = join(k, 'jobpilot.db');
      AppStore.open(path).close();
      const d = new Database(path);
      d.pragma('user_version = 0');
      d.close();
      const uv = (): number => {
        const v = new Database(path, { readonly: true });
        try {
          return v.pragma('user_version', { simple: true }) as number;
        } finally {
          v.close();
        }
      };
      expect(() => AppStore.open(path, { schema: 'as-is' })).toThrow(SchemaBehindError);
      expect(() => AppStore.open(path)).toThrow(SchemaBehindError);
      expect(uv()).toBe(0);
      const r = due(DAILY_DUE, k, '2026-10-14T02:00:00.000Z');
      expect(r.due).toBe(true);
      expect(uv()).toBe(0);
    } finally {
      rmSync(k, { recursive: true, force: true });
    }
  });

  it('the due check of a scheduled run reads it without migrating', () => {
    expect(() => due(DAILY_DUE, home, '2026-10-14T02:00:00.000Z')).not.toThrow();
    expect(state()).toEqual(BEHIND);
  });

  for (const args of [
    ['pack', 'check'],
    ['facts', 'verify', 'f-nw-05'],
    ['facts', 'reject', 'f-nw-05'],
    ['coverage', 'probe'],
    ['networks', 'list'],
    ['migrate', 'desk', join(root, 'tests/fixtures/desk')],
    ['store', 'compact'],
    ['store', 'compact', '--apply'],
  ]) {
    it(`jobpilot ${args.join(' ')}: says so, exits 2, leaves the database untouched`, () => {
      const r = cli(...args);
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(2);
      expect(r.stderr).toContain(MESSAGE);
      expect(state()).toEqual(BEHIND);
    }, 60_000);
  }

  it('jobpilot facts list applies it, under the run lock', () => {
    const r = cli('facts', 'list');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('the database was upgraded to this jobpilot');
    expect(state()).toEqual({ version: APP_MIGRATIONS.length, index: true });
  }, 60_000);
});
