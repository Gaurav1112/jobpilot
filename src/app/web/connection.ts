import { statSync } from 'node:fs';
import { AppStore } from '../store/app-store.js';
import { APP_MIGRATIONS } from '../store/schema.js';
import { MIGRATIONS } from '../../kernel/store/migrations.js';

/**
 * dashboard-perf fix 5: the dashboard's ONE long-lived connection (per process), so SQLite's page cache survives from
 * one request to the next instead of every request starting cold on a multi-GB file.
 *
 * Safe beside a run (WAL: readers never block the writer, and the writer never blocks readers):
 * - **No transaction is ever left open on it.** better-sqlite3 is synchronous: every statement autocommits, and every
 *   `transaction()` commits or rolls back before the route's `withStore` callback returns. After each use the
 *   connection is checked (`inTransaction`); one left in a transaction is rolled back and closed. So a run can always
 *   take the write lock, and a WAL checkpoint is never held back by the dashboard.
 * - **A schema change is seen as a fresh open would see it.** Before each use the kernel's `user_version` and the app's
 *   `app_schema.version` are read (O(1)); if either differs from this code's migrations, or the DB file is no longer
 *   the same file (a restore), the connection is closed and the next one is opened through `AppStore.open`, exactly
 *   today's per-request path: it applies this code's pending migrations, or refuses a newer schema ("newer than this
 *   jobpilot") with the error page. A newer schema is also reported (`onSchemaNewer`): `jobpilot serve` then exits,
 *   so launchd (KeepAlive) restarts the dashboard on the checkout's code, the newer jobpilot that migrated it.
 * - **A failing statement drops it.** Any error but SQLITE_BUSY closes the connection; the next request opens anew.
 * - Migrations run on it only when it is (re)opened, inside `AppStore.open`'s BEGIN IMMEDIATE (as every opener), never
 *   in the middle of its life.
 */
export class SharedStore {
  private store: AppStore | undefined;
  private fileId: string | undefined;

  constructor(
    private readonly path: string,
    private readonly timeoutMs: number,
    private readonly onOpen: () => void = () => {},
    /** Told when the database's schema is newer than this code (a newer jobpilot migrated it); `serve` exits so launchd restarts it on the new code. */
    private readonly onSchemaNewer: () => void = () => {},
  ) {}

  /** `cache_size` of the shared connection, in KiB (negative: KiB, SQLite's convention): 32 MB. */
  static readonly CACHE_KIB = 32 * 1024;

  use<T>(fn: (s: AppStore) => T): T {
    const store = this.current();
    let ok = false;
    try {
      const out = fn(store);
      ok = true;
      return out;
    } catch (e) {
      if (!isBusy(e)) this.drop();
      throw e;
    } finally {
      if (this.store === store && store.kernel.db.inTransaction) {
        if (ok) console.error('jobpilot dashboard: a request left a transaction open; it was rolled back and the connection closed');
        try {
          store.kernel.db.exec('ROLLBACK');
        } catch {
          // closing below ends it anyway
        }
        this.drop();
      }
    }
  }

  close(): void {
    this.drop();
  }

  private current(): AppStore {
    if (this.store !== undefined && !this.stillValid(this.store)) this.drop();
    if (this.store === undefined) {
      const id = fileIdOf(this.path);
      let s: AppStore;
      try {
        s = AppStore.open(this.path, { timeoutMs: this.timeoutMs });
      } catch (e) {
        if (e instanceof Error && /newer than this jobpilot/.test(e.message)) this.onSchemaNewer();
        throw e;
      }
      s.kernel.db.pragma(`cache_size = -${SharedStore.CACHE_KIB}`);
      this.store = s;
      // the file opened is the one stat'ed before, or (raced by a rename) the next check reopens
      this.fileId = id;
      this.onOpen();
    }
    return this.store;
  }

  private stillValid(s: AppStore): boolean {
    try {
      if (fileIdOf(this.path) !== this.fileId) return false;
      const db = s.kernel.db;
      if ((db.pragma('user_version', { simple: true }) as number) !== MIGRATIONS.length) return false;
      const row = db.prepare(`SELECT version FROM app_schema WHERE id = 1`).get() as { version: number } | undefined;
      return row?.version === APP_MIGRATIONS.length;
    } catch {
      return false;
    }
  }

  private drop(): void {
    const s = this.store;
    this.store = undefined;
    this.fileId = undefined;
    try {
      s?.close();
    } catch {
      // already unusable: nothing to keep
    }
  }
}

function fileIdOf(path: string): string | undefined {
  try {
    const st = statSync(path);
    return `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

const isBusy = (e: unknown): boolean => typeof (e as { code?: unknown })?.code === 'string' && (e as { code: string }).code.startsWith('SQLITE_BUSY');
