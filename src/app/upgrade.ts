import { withLock } from './lock.js';
import { homePaths } from './pack/paths.js';
import { AppStore, schemaState } from './store/app-store.js';

/**
 * Who migrates the database (dashboard-perf review I2). A migration holds SQLite's write lock for its whole length (the
 * envelope index of migration 18: 7-30 s on a 4 GB home), and a daily run that starts meanwhile fails on SQLITE_BUSY
 * after 5 s. So only runs and the CLI migrate, under the jobpilot lock (a run opens the DB inside `withLock`; the CLI
 * through `upgradeUnderLock`). The dashboard never does: with a schema behind its code it answers "being upgraded".
 */
export { schemaState, type SchemaState } from './store/app-store.js';

/**
 * Applies pending migrations holding the jobpilot lock (a run holding it: LockError; the run applies them itself).
 * True when it migrated; false when there was nothing to do (current, newer or no database yet), without the lock.
 */
export async function upgradeUnderLock(home: string, command: string): Promise<boolean> {
  const db = homePaths(home).db;
  if (schemaState(db) !== 'behind') return false;
  return withLock(home, `${command} (database upgrade)`, async () => {
    AppStore.open(db, { schema: 'migrate' }).close();
    return true;
  });
}
