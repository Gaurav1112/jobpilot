import { statSync } from 'node:fs';
import { AppStore } from '../store/app-store.js';
import { APP_MIGRATIONS } from '../store/schema.js';
import { MIGRATIONS } from '../../kernel/store/migrations.js';
import { schemaState } from '../upgrade.js';

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
 *   the same file (a restore), the connection is closed and the next request looks at the schema again:
 *   current, it reopens; behind, it answers "being upgraded"; newer, it refuses ("newer than this jobpilot") with the
 *   error page. A newer schema is also reported (`onSchemaNewer`): `jobpilot serve` then exits,
 *   so launchd (KeepAlive) restarts the dashboard on the checkout's code, the newer jobpilot that migrated it.
 * - **A failing statement drops it.** Any error but SQLITE_BUSY closes the connection; the next request opens anew.
 * - **It never migrates** (review I2; `upgrade.ts`): before opening, the schema is read read-only; behind this code (or
 *   no database yet) the request answers 503 "being upgraded" (`UpgradePending`) and the next request looks again.
 *   Runs and the CLI migrate, under the jobpilot lock.
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
    /** Whether a run holds the jobpilot lock (`liveHolder`); idle maintenance waits until it does not. */
    private readonly runActive: () => boolean = () => false,
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

  /** The WAL size the shared connection lets SQLite keep after a checkpoint (`journal_size_limit`): 64 MB. */
  static readonly JOURNAL_LIMIT_BYTES = 64 * 1024 * 1024;

  /**
   * Idle maintenance (review): this connection staying open means a run is no longer the last to close the DB, so its
   * -wal file (as large as its biggest transaction) is no longer removed. When the dashboard is idle and no run holds
   * the jobpilot lock: a PASSIVE checkpoint (it copies frames without taking the write lock), then, only when it copied
   * every frame, a TRUNCATE (now just emptying the file, so the write lock is held for no time). It never waits
   * (busy_timeout 0): anything in the way makes it a no-op, retried at the next idle.
   */
  maintain(): void {
    const s = this.store;
    if (s === undefined || s.kernel.db.inTransaction) return;
    try {
      if (this.runActive()) return;
    } catch {
      return;
    }
    const db = s.kernel.db;
    const before = db.pragma('busy_timeout', { simple: true }) as number;
    try {
      db.pragma('busy_timeout = 0');
      const [p] = db.pragma('wal_checkpoint(PASSIVE)') as { busy: number; log: number; checkpointed: number }[];
      if (p !== undefined && p.busy === 0 && p.log >= 0 && p.checkpointed === p.log) db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // busy or anything else: nothing to do now
    } finally {
      try {
        db.pragma(`busy_timeout = ${before}`);
      } catch {
        this.drop();
      }
    }
  }

  private current(): AppStore {
    if (this.store !== undefined && !this.stillValid(this.store)) this.drop();
    if (this.store === undefined) {
      // the dashboard never migrates (review I2): a schema behind this code waits for a run or the CLI (under the lock)
      const state = schemaState(this.path);
      if (state === 'missing' || state === 'empty') throw new UpgradePending('missing');
      if (state === 'behind') throw new UpgradePending('behind');
      const id = fileIdOf(this.path);
      let s: AppStore;
      try {
        s = AppStore.open(this.path, { timeoutMs: this.timeoutMs });
      } catch (e) {
        if (e instanceof Error && /newer than this jobpilot/.test(e.message)) this.onSchemaNewer();
        throw e;
      }
      s.kernel.db.pragma(`cache_size = -${SharedStore.CACHE_KIB}`);
      s.kernel.db.pragma(`journal_size_limit = ${SharedStore.JOURNAL_LIMIT_BYTES}`);
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

/** The database is behind this code (or not there yet): a run or the CLI upgrades it; the dashboard answers 503. */
export class UpgradePending extends Error {
  override readonly name = 'UpgradePending';
  /** `missing`: no database (or an empty one) yet; `behind`: a schema behind this code. */
  constructor(readonly why: 'missing' | 'behind') {
    super(why === 'missing' ? 'no database yet; the first run creates it' : 'jobpilot is being upgraded; the next run (or jobpilot facts list) applies it');
  }
}
