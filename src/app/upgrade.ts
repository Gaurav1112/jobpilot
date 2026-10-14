import { existsSync } from 'node:fs';
import { MIGRATIONS } from '../kernel/store/migrations.js';
import { Store } from '../kernel/store/store.js';
import { withLock } from './lock.js';
import { homePaths } from './pack/paths.js';
import { AppStore } from './store/app-store.js';
import { APP_MIGRATIONS } from './store/schema.js';

/**
 * Who migrates the database (dashboard-perf review I2). A migration holds SQLite's write lock for its whole length (the
 * envelope index of migration 18: 7-30 s on a 4 GB home), and a daily run that starts meanwhile fails on SQLITE_BUSY
 * after 5 s. So only runs and the CLI migrate, under the jobpilot lock (a run opens the DB inside `withLock`; the CLI
 * through `upgradeUnderLock`). The dashboard never does: with a schema behind its code it answers "being upgraded".
 */
export type SchemaState = 'missing' | 'current' | 'behind' | 'newer';

/** The DB's kernel and app schema against this code's migrations, read-only (nothing is created, set or migrated). */
export function schemaState(dbPath: string): SchemaState {
  if (!existsSync(dbPath)) return 'missing';
  let k: Store;
  try {
    k = Store.openReadOnly(dbPath);
  } catch (e) {
    if (e instanceof Error && /newer than this jobpilot/.test(e.message)) return 'newer';
    throw e;
  }
  try {
    const kernel = k.db.pragma('user_version', { simple: true }) as number;
    const hasApp = k.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_schema'`).get() !== undefined;
    const app = hasApp ? (k.db.prepare(`SELECT version FROM app_schema WHERE id = 1`).get() as { version: number } | undefined)?.version : undefined;
    if (app !== undefined && app > APP_MIGRATIONS.length) return 'newer';
    return kernel === MIGRATIONS.length && app === APP_MIGRATIONS.length ? 'current' : 'behind';
  } finally {
    k.close();
  }
}

/**
 * Applies pending migrations holding the jobpilot lock (a run holding it: LockError; the run applies them itself).
 * True when it migrated; false when there was nothing to do (current, newer or no database yet), without the lock.
 */
export async function upgradeUnderLock(home: string, command: string): Promise<boolean> {
  const db = homePaths(home).db;
  if (schemaState(db) !== 'behind') return false;
  return withLock(home, `${command} (database upgrade)`, async () => {
    AppStore.open(db).close();
    return true;
  });
}
