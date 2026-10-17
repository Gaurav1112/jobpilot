import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { systemClock, type Clock } from '../../kernel/clock.js';
import { profileScheduleRule } from '../freelance/run.js';
import { DAILY_LABEL, installSchedule, realRunner, scheduleStatus, uninstallSchedule, type Runner } from '../schedule.js';
import type { AdoptLaunchd, UnadoptLaunchd } from './adopt.js';
import { profileHome } from './root.js';

export interface LaunchdTarget {
  readonly root: string;
  readonly node: string;
  readonly repo: string;
  readonly uid: number;
  readonly agentsDir?: string;
  readonly run?: Runner;
  /** The month the profile's residence is read for (Task 21); the system clock unless given. */
  readonly clock?: Clock;
  /** Whether a process still exists (tests inject it); `process.kill(pid, 0)` unless given. */
  readonly alive?: (pid: number) => boolean;
  /** A synchronous pause between looks (tests inject a no-op). */
  readonly sleepMs?: (ms: number) => void;
  /** How long the unloaded jobs' processes get to exit; default 30 s. */
  readonly exitTimeoutMs?: number;
}

const systemAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const systemSleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * launchctl bootout returns before a running job's process has exited (the real adopt on 2026-10-17 met the live
 * dashboard still closing the database). The ids of the processes still running after the timeout.
 */
function stillRunning(o: LaunchdTarget, pids: readonly number[]): number[] {
  const alive = o.alive ?? systemAlive;
  const sleep = o.sleepMs ?? systemSleep;
  const deadline = Date.now() + (o.exitTimeoutMs ?? 30_000);
  let left = pids.filter((p) => alive(p));
  while (left.length > 0 && Date.now() < deadline) {
    sleep(200);
    left = left.filter((p) => alive(p));
  }
  return left.filter((p) => alive(p));
}

const legacyOf = (o: LaunchdTarget) => ({ node: o.node, repo: o.repo, home: o.root, uid: o.uid, ...(o.agentsDir !== undefined ? { agentsDir: o.agentsDir } : {}) });
const profileOf = (o: LaunchdTarget, id: string) => ({ ...legacyOf(o), home: profileHome(o.root, id), profile: { id, root: o.root } });
/** What "jobpilot schedule install --profile <id>" installs: a profile living outside India gets no freelance job (Task 21). */
const profileInstallOf = (o: LaunchdTarget, id: string) => {
  const p = profileOf(o, id);
  return profileScheduleRule(p.home, (o.clock ?? systemClock).now()).freelanceOff === null ? p : { ...p, freelance: false };
};

/** The JOBPILOT_HOME the installed legacy daily plist runs, or undefined when there is none. */
function installedHome(o: LaunchdTarget): string | undefined {
  const file = join(o.agentsDir ?? join(homedir(), 'Library', 'LaunchAgents'), `${DAILY_LABEL}.plist`);
  if (!existsSync(file)) return undefined;
  const m = /<key>JOBPILOT_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(readFileSync(file, 'utf8'));
  return m?.[1]?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export function adoptLaunchd(o: LaunchdTarget): AdoptLaunchd {
  const run = o.run ?? realRunner;
  return {
    before() {
      const runs = installedHome(o);
      if (runs !== undefined && real(runs) !== real(o.root)) throw new Error(`the installed schedule runs ${runs}, not ${o.root}; use --no-launchd for a copy`);
      const status = scheduleStatus(legacyOf(o), run).filter((s) => s.loaded);
      const loaded = status.map((s) => s.label);
      if (loaded.length > 0) uninstallSchedule({ ...legacyOf(o), dashboard: true }, run);
      const left = stillRunning(o, status.flatMap((s) => (s.pid === null ? [] : [s.pid])));
      if (left.length > 0) {
        installSchedule(legacyOf(o), run);
        throw new Error(`job processes still running after unloading (pid ${left.join(', ')}); the scheduled jobs were loaded back; try again once they have finished`);
      }
      return loaded;
    },
    after(id, loaded) {
      if (loaded.length > 0) installSchedule(profileInstallOf(o, id), run);
    },
    restore(loaded) {
      if (loaded.length > 0) installSchedule(legacyOf(o), run);
    },
  };
}

export function unadoptLaunchd(o: LaunchdTarget): UnadoptLaunchd {
  const run = o.run ?? realRunner;
  return {
    before(id) {
      const status = scheduleStatus(profileOf(o, id), run).filter((st) => st.loaded);
      const loaded = status.map((st) => st.label);
      try {
        uninstallSchedule({ ...profileOf(o, id), dashboard: true }, run);
      } catch (e) {
        // Some jobs may be unloaded already: the caller loads back what was loaded (review I1, 7).
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { loaded });
      }
      const left = stillRunning(o, status.flatMap((st) => (st.pid === null ? [] : [st.pid])));
      if (left.length > 0) {
        if (loaded.length > 0) installSchedule(profileInstallOf(o, id), run);
        // already loaded back here: the caller must not load them again
        throw Object.assign(new Error(`job processes still running after unloading (pid ${left.join(', ')}); the scheduled jobs were loaded back; try again once they have finished`), { loaded: [] });
      }
      return loaded;
    },
    after(loaded) {
      if (loaded.length > 0) installSchedule(legacyOf(o), run);
    },
    restore(id, loaded) {
      if (loaded.length > 0) installSchedule(profileInstallOf(o, id), run);
    },
  };
}
