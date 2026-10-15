import Database from 'better-sqlite3';
import { AppStore } from '../../src/app/store/app-store.js';
import { APP_MIGRATIONS } from '../../src/app/store/schema.js';
import { jobRow } from './app-fixtures.js';

/** The index the last index migration creates: dropped (with the version set back before it) to make a schema that is behind. */
export const LAST_INDEX_AT = APP_MIGRATIONS.findLastIndex((m) => typeof m === 'string' && /CREATE INDEX IF NOT EXISTS/.test(m));
export const LAST_INDEX = /CREATE INDEX IF NOT EXISTS (\w+)/.exec(String(APP_MIGRATIONS[LAST_INDEX_AT]))?.[1] as string;
/** The version that leaves the last index migration and every later one (migration 23 re-runs as a no-op) pending. */
export const BEHIND_VERSION = LAST_INDEX_AT;

/** Makes the database at `dbPath` a schema one migration behind this code, with a row in it. */
export function makeBehindDb(dbPath: string): void {
  const s = AppStore.open(dbPath, { schema: 'migrate' });
  s.upsertJob(jobRow());
  s.close();
  const d = new Database(dbPath);
  d.exec(`DROP INDEX ${LAST_INDEX}; UPDATE app_schema SET version = ${BEHIND_VERSION}`);
  d.close();
}
