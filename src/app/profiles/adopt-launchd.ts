import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
}

const legacyOf = (o: LaunchdTarget) => ({ node: o.node, repo: o.repo, home: o.root, uid: o.uid, ...(o.agentsDir !== undefined ? { agentsDir: o.agentsDir } : {}) });
const profileOf = (o: LaunchdTarget, id: string) => ({ ...legacyOf(o), home: profileHome(o.root, id), profile: { id, root: o.root } });

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
      const loaded = scheduleStatus(legacyOf(o), run).filter((s) => s.loaded).map((s) => s.label);
      if (loaded.length > 0) uninstallSchedule({ ...legacyOf(o), dashboard: true }, run);
      return loaded;
    },
    after(id, loaded) {
      if (loaded.length > 0) installSchedule(profileOf(o, id), run);
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
      const loaded = scheduleStatus(profileOf(o, id), run).filter((st) => st.loaded).map((st) => st.label);
      uninstallSchedule({ ...profileOf(o, id), dashboard: true }, run);
      return loaded;
    },
    after(loaded) {
      if (loaded.length > 0) installSchedule(legacyOf(o), run);
    },
    restore(id, loaded) {
      if (loaded.length > 0) installSchedule(profileOf(o, id), run);
    },
  };
}
