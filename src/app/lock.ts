import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** The lock file under JOBPILOT_HOME. */
export const LOCK_FILE = 'jobpilot.lock';

export class LockError extends Error {
  override readonly name = 'LockError';
}

interface LockBody {
  readonly pid: number;
  readonly command: string;
  readonly at: string;
}

/** Whether a process with this pid exists (EPERM: it exists but belongs to someone else). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readBody(path: string): LockBody | undefined {
  try {
    const b = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockBody>;
    return typeof b.pid === 'number' && Number.isInteger(b.pid) && b.pid > 0 ? { pid: b.pid, command: String(b.command ?? '?'), at: String(b.at ?? '?') } : undefined;
  } catch {
    return undefined;
  }
}

/** Creates the lock file exclusively, or throws EEXIST. */
function create(path: string, body: LockBody): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify(body));
  } finally {
    closeSync(fd);
  }
}

/**
 * Takes the single-process lock synchronously: `run`, `docs rebuild` and `migrate desk` share one out root and one
 * DB, and a supervisor's start deletes staged writes it does not own, so two of them must never overlap. The lock is
 * an exclusive file holding `{pid, command, at}`. A lock whose process is gone (a crash, a kill -9) is stale and is
 * taken over; one held by a live process refuses with a LockError naming it. A lock file that cannot be read is
 * treated as held (it may be mid-write), never deleted.
 */
function acquire(home: string, command: string): () => void {
  mkdirSync(home, { recursive: true });
  const path = join(home, LOCK_FILE);
  const body: LockBody = { pid: process.pid, command, at: new Date().toISOString() };
  for (let attempt = 0; ; attempt++) {
    try {
      create(path, body);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = readBody(path);
      if (held === undefined) throw new LockError(`${path} exists but cannot be read; if no jobpilot is running, delete it`);
      if (alive(held.pid) || attempt > 0) {
        throw new LockError(`another jobpilot process (pid ${held.pid}, ${held.command}) holds ${path} since ${held.at}; wait for it to finish`);
      }
      // Stale: its process is gone. Remove it only if it is still that same stale lock, then try once more.
      if (readBody(path)?.pid === held.pid) unlinkSync(path);
    }
  }
  return () => {
    // Remove only our own lock.
    if (readBody(path)?.pid === process.pid) unlinkSync(path);
  };
}

/** Runs `fn` holding the lock; the lock is taken before `fn` starts (synchronously) and released however it ends. */
export async function withLock<T>(home: string, command: string, fn: () => Promise<T>): Promise<T> {
  const release = acquire(home, command);
  try {
    return await fn();
  } finally {
    release();
  }
}
