import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { checkRelPath } from '../kernel/files.js';

/**
 * Whether a document the qa-gate passed is still on disk as it passed (Task 10 fix round 1, replay safety). A replayed
 * QaReport vouches for exact bytes (`qa.files` pins each sha256), so the projector marks a job `ready` only when
 * every listed file is present under the out root with its recorded sha256; otherwise the job's documents are
 * `missing` (and `jobpilot docs rebuild` re-renders them).
 */
export type DocOnDisk = 'ok' | 'absent' | 'changed';
export type DocCheck = (relPath: string, sha256: string) => DocOnDisk;

/** The real check against `outDir`: a confined relative path, a regular file that is not a symlink, the same sha256. */
export function diskDocCheck(outDir: string): DocCheck {
  return (relPath, sha256) => {
    let segs: string[];
    try {
      segs = checkRelPath(relPath, (m) => new Error(m) as never);
    } catch {
      return 'absent';
    }
    let root: string;
    try {
      root = realpathSync(outDir);
    } catch {
      return 'absent';
    }
    const abs = join(root, ...segs);
    try {
      if (!lstatSync(abs).isFile()) return 'absent';
      const real = realpathSync(abs);
      if (!real.startsWith(root + sep)) return 'absent';
      return createHash('sha256').update(readFileSync(real)).digest('hex') === sha256 ? 'ok' : 'changed';
    } catch {
      return 'absent';
    }
  };
}
