import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
  /** Unique per acquisition, so a lock is told apart from a later one of the same pid. */
  readonly token: string;
  /** The holder's process start time (`ps -o lstart=`), so a reused pid is not mistaken for the holder. */
  readonly started?: string;
}

/** How the lock looks at other processes; tests inject a fake. */
export interface ProcessProbe {
  /** Whether a process with this pid exists. */
  alive(pid: number): boolean;
  /** That process's start time, or undefined when it cannot be read. */
  startTime(pid: number): string | undefined;
}

/** The real probe: `kill(pid, 0)` (EPERM means it exists) and `ps -o lstart= -p <pid>` (macOS and Linux). */
export const systemProbe: ProcessProbe = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  startTime(pid) {
    try {
      const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim().replace(/\s+/g, ' ');
      return out === '' ? undefined : out;
    } catch {
      return undefined;
    }
  },
};

/**
 * Whether the lock's holder is still running: its pid exists and, when the lock recorded a start time, that process
 * started then. A pid reused by another process (launchd restarts, a reboot) makes the lock stale. A start time that
 * cannot be read counts as a match (the lock is kept, never wrongly broken).
 */
function holderAlive(b: Pick<LockBody, 'pid' | 'started'>, probe: ProcessProbe): boolean {
  if (!probe.alive(b.pid)) return false;
  if (b.started === undefined) return true;
  const now = probe.startTime(b.pid);
  return now === undefined || now === b.started;
}

function readBody(path: string): LockBody | undefined {
  try {
    const b = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockBody>;
    return typeof b.pid === 'number' && Number.isInteger(b.pid) && b.pid > 0
      ? { pid: b.pid, command: String(b.command ?? '?'), at: String(b.at ?? '?'), token: String(b.token ?? ''), ...(typeof b.started === 'string' ? { started: b.started } : {}) }
      : undefined;
  } catch {
    return undefined;
  }
}

const unlinkQuiet = (p: string): void => {
  try {
    unlinkSync(p);
  } catch {
    // already gone
  }
};

/**
 * Creates `path` holding `body`, atomically and whole: the body is written to a unique temp file and hard-linked into
 * place, so the file appears complete or not at all (a crash can leave only a temp file, which blocks nothing).
 * False when `path` already exists.
 */
function createWhole(path: string, body: LockBody): boolean {
  const tmp = `${path}.${process.pid}.${body.token}.tmp`;
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o600, flag: 'wx' });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    unlinkQuiet(tmp);
  }
}

/**
 * Takes the single-process lock synchronously: `run`, `docs rebuild` and `migrate desk` share one out root and one
 * DB, and a supervisor's start deletes staged writes it does not own, so two of them must never overlap.
 *
 * - The lock is `<home>/jobpilot.lock`, holding `{pid, command, at, token}`, created whole (`createWhole`).
 * - A lock held by a live process (same pid and same process start time, ruling 6) refuses with a LockError naming it.
 * - A lock whose process is gone is stale. Taking it over is serialised by an exclusive `<lock>.takeover` file: only
 *   its holder re-reads the lock, removes it if it is still that same stale lock (same pid and token), and creates
 *   its own. So two processes can never both take over, and a fresh lock created meanwhile is never deleted (m2). A
 *   takeover file whose own process died is cleared.
 * - A lock file that cannot be read refuses (it is never deleted).
 */
function acquire(home: string, command: string, probe: ProcessProbe): () => void {
  mkdirSync(home, { recursive: true });
  const path = join(home, LOCK_FILE);
  const guard = `${path}.takeover`;
  const started = probe.startTime(process.pid);
  const body: LockBody = { pid: process.pid, command, at: new Date().toISOString(), token: randomUUID(), ...(started !== undefined ? { started } : {}) };
  const heldError = (h: LockBody) => new LockError(`another jobpilot process (pid ${h.pid}, ${h.command}) holds ${path} since ${h.at}; wait for it to finish`);

  if (!createWhole(path, body)) {
    const held = readBody(path);
    if (held === undefined) throw new LockError(`${path} exists but cannot be read; if no jobpilot is running, delete it`);
    if (holderAlive(held, probe)) throw heldError(held);
    // Stale: take it over under the takeover file.
    if (!createWhole(guard, body)) {
      const g = readBody(guard);
      if (g !== undefined && holderAlive(g, probe)) throw new LockError(`another jobpilot process (pid ${g.pid}) is taking over a stale lock at ${path}; try again`);
      // The takeover holder died; clear its file only if it is still that one, then claim it.
      if (readBody(guard)?.token === g?.token) unlinkQuiet(guard);
      if (!createWhole(guard, body)) throw new LockError(`another jobpilot process is taking over a stale lock at ${path}; try again`);
    }
    try {
      const again = readBody(path);
      if (again !== undefined && again.token === held.token && again.pid === held.pid && !holderAlive(again, probe)) unlinkQuiet(path);
      if (!createWhole(path, body)) {
        const now = readBody(path);
        throw now === undefined ? new LockError(`${path} exists but cannot be read; if no jobpilot is running, delete it`) : heldError(now);
      }
    } finally {
      if (readBody(guard)?.token === body.token) unlinkQuiet(guard);
    }
  }
  return () => {
    // Remove only our own lock.
    if (readBody(path)?.token === body.token) unlinkQuiet(path);
  };
}

/** Runs `fn` holding the lock; the lock is taken before `fn` starts (synchronously) and released however it ends. */
export async function withLock<T>(home: string, command: string, fn: () => Promise<T>, probe: ProcessProbe = systemProbe): Promise<T> {
  const release = acquire(home, command, probe);
  try {
    return await fn();
  } finally {
    release();
  }
}
