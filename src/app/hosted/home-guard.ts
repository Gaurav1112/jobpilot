import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';

export class DefaultHomeError extends Error {}

/** Resolves symlinks for the longest existing prefix of the path, then appends the rest (the path may not exist yet). */
function realish(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    rest.unshift(basename(cur));
    cur = up;
  }
  return join(realpathSync(existsSync(cur) ? cur : dirname(cur)), ...rest);
}

/**
 * Every `hosted` command that writes a home refuses the default `~/.jobpilot` (spec §3.3: branch code never migrates
 * it), whatever path leads there (symlinks resolved), and anything inside it.
 */
export function refuseDefaultHome(home: string, command: string, defaultHome: string = join(homedir(), '.jobpilot')): void {
  const target = realish(home);
  const def = realish(defaultHome);
  const rel = relative(def, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new DefaultHomeError(`hosted ${command}: refusing to write the default home ${defaultHome}; pass another --home (the Mac's home stays as it is)`);
  }
}
