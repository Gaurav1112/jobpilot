import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { RUN_ENV_VAR } from '../run-env.js';

export interface PipelineRun {
  /** The exit code; null when a signal ended the child (the SIGKILL case). */
  readonly exit: number | null;
  /** SIGTERM was sent at the deadline. */
  readonly stopped: boolean;
  /** The child was still alive `graceMs` after the SIGTERM and was SIGKILLed. */
  readonly killed: boolean;
  readonly ms: number;
  /** The signal that ended the child, when one did (SIGTERM: the deadline stop reached it before its handler). */
  readonly signal?: NodeJS.Signals | null;
}

export const DEFAULT_GRACE_MS = 60_000;

/**
 * Starts one pipeline child with stdout and stderr appended to `logFile` (inside the home, so it ships encrypted). At
 * `deadlineAt` it sends SIGTERM (the child stops between steps); a child still alive `graceMs` later (default 60 s) is
 * SIGKILLed and `killed` is true: the wrapper then uploads nothing (spec §3.3 "Deadline").
 */
export function spawnPipeline(o: {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly logFile: string;
  readonly deadlineAt: number;
  readonly graceMs?: number;
}): Promise<PipelineRun> {
  const [cmd, ...args] = o.argv;
  if (cmd === undefined) return Promise.reject(new Error('spawnPipeline: empty argv'));
  mkdirSync(dirname(o.logFile), { recursive: true, mode: 0o700 });
  const fd = openSync(o.logFile, 'a', 0o600);
  const started = Date.now();
  return new Promise<PipelineRun>((resolve, reject) => {
    // its own process group: the deadline signals reach what the pipeline started too (pdftotext, a browser)
    const child = spawn(cmd, args, { cwd: o.cwd, env: { ...o.env }, stdio: ['ignore', fd, fd], detached: true });
    let stopped = false;
    let killed = false;
    let grace: NodeJS.Timeout | undefined;
    const signal = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };
    const timer = setTimeout(() => {
      stopped = true;
      signal('SIGTERM');
      grace = setTimeout(() => {
        killed = true;
        signal('SIGKILL');
      }, o.graceMs ?? DEFAULT_GRACE_MS);
    }, Math.max(0, o.deadlineAt - Date.now()));
    const finish = (): void => {
      clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      closeSync(fd);
    };
    child.on('error', (e) => {
      finish();
      reject(e);
    });
    child.on('close', (code, sig) => {
      finish();
      resolve({ exit: code, stopped, killed, ms: Date.now() - started, signal: sig });
    });
  });
}

/** The child's variable set from the parent's. */
const BASE_NAMES = ['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR'] as const;
export const GMAIL_ENV_NAMES = ['JOBPILOT_SECRET_GMAIL_CLIENT_ID', 'JOBPILOT_SECRET_GMAIL_CLIENT_SECRET', 'JOBPILOT_SECRET_GMAIL_REFRESH'] as const;

/** The child's whole environment: PATH, HOME, LANG, TZ, TMPDIR from `base`; JOBPILOT_HOME, the run env set to hosted, NODE_NO_WARNINGS=1; plus `extra`. Nothing else (no key, no token). */
export function childEnv(base: NodeJS.ProcessEnv, home: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of BASE_NAMES) {
    const v = base[n];
    if (v !== undefined && v !== '') out[n] = v;
  }
  return { ...out, JOBPILOT_HOME: home, [RUN_ENV_VAR]: 'hosted', NODE_NO_WARNINGS: '1', ...extra };
}
