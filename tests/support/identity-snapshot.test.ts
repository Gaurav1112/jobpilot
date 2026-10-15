import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { outTreeHashes } from './identity-snapshot.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('outTreeHashes', () => {
  it('lists every file under out/ once, sorted by path, with its sha256', () => {
    dir = mkdtempSync(join(tmpdir(), 'jobpilot-out-'));
    mkdirSync(join(dir, 'b'), { recursive: true });
    writeFileSync(join(dir, 'b', 'x.pdf'), 'two');
    writeFileSync(join(dir, 'a.html'), 'one');
    expect(outTreeHashes(dir)).toEqual([
      'a.html 7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed',
      'b/x.pdf 3fc4ccfe745870e2c0d99f71f30ff0656c8dedd41cc1d7d3d376b0dbe685e2f3',
    ]);
  });
});
