import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { treeManifest } from '../../../src/app/profiles/adopt.js';

// Task 22 rehearsal: the owner's real DB is 4.8 GB, and hashing it with readFileSync threw ERR_FS_FILE_TOO_LARGE
// (> 2 GiB), so `profile adopt` could not run on a real home. A sparse file takes no disk space.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobpilot-adopt-large-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const streamSha = (p: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(p).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });

describe('treeManifest on a home with a database larger than 2 GiB', () => {
  it('hashes it in chunks, to the same digest a stream gives', async () => {
    mkdirSync(join(dir, 'home'));
    const big = join(dir, 'home', 'jobpilot.db');
    writeFileSync(big, 'SQLite format 3\u0000');
    truncateSync(big, 2 ** 31 + 4096);
    const lines = treeManifest(dir, ['home']);
    expect(lines).toEqual([`home/jobpilot.db ${2 ** 31 + 4096} ${await streamSha(big)}`]);
  }, 120_000);
  it('small files keep exactly the digest they had', () => {
    mkdirSync(join(dir, 'pack'));
    writeFileSync(join(dir, 'pack', 'a.yaml'), 'x: 1\n');
    expect(treeManifest(dir, ['pack'])).toEqual([`pack/a.yaml 5 ${createHash('sha256').update('x: 1\n').digest('hex')}`]);
  });
});
