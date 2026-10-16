import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { privacyHomes, scanFolder, scanGit } from '../../src/app/privacy.js';
import { createProfile } from '../../src/app/profiles/commands.js';

// Fictional fixture values only (Asha Rao, Initech). Asha's terms: #1 initech, #2 name, #3 email, #4 phone, #5 link.
const repo = join(import.meta.dirname, '../..');
let root: string;
let git: string;
const run = (...args: string[]): string => execFileSync('git', args, { cwd: git, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Asha Rao', GIT_AUTHOR_EMAIL: 'asha.rao@example.com', GIT_COMMITTER_NAME: 'Asha Rao', GIT_COMMITTER_EMAIL: 'asha.rao@example.com' } }).trim();
const commit = (msg: string, files: Record<string, string | null>): string => {
  for (const [f, t] of Object.entries(files)) {
    if (t === null) run('rm', '-q', f);
    else {
      mkdirSync(join(git, f, '..'), { recursive: true });
      writeFileSync(join(git, f), t);
      run('add', f);
    }
  }
  run('commit', '-q', '-m', msg);
  return run('rev-parse', '--short=7', 'HEAD');
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jobpilot-privgit-'));
  createProfile({ root, id: 'asha', clock: { now: () => '2026-10-15T08:00:00.000Z' }, fromPack: join(repo, 'tests/fixtures/pack') });
  git = join(root, 'repo');
  mkdirSync(git);
  run('init', '-q', '-b', 'main');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const homes = () => privacyHomes({ JOBPILOT_ROOT: root, HOME: '/Users/x' });

describe('privacy scan --git', () => {
  it('a term added in one commit and deleted in the next is still found, in the commit that added it', () => {
    const base = commit('init', { 'a.md': 'clean\n' });
    const added = commit('notes', { 'notes.md': 'met Initech today\n' });
    commit('tidy', { 'notes.md': null });
    const r = scanGit(git, `${base}..HEAD`, homes());
    expect(r.hits).toEqual([`${added} notes.md (asha, term #1)`]);
    expect(r.commits).toBe(2);
  });
  it('commit messages are scanned; author and committer (a public identity) are not', () => {
    const base = commit('init', { 'a.md': 'clean\n' });
    const c = commit('fix for Initech review', { 'a.md': 'still clean\n' });
    expect(scanGit(git, `${base}..HEAD`, homes()).hits).toEqual([`${c} message (asha, term #1)`]);
  });
  it('the root commit counts, file names count and are hidden, and the term is never printed', () => {
    const c = commit('init', { 'docs/asha-rao/cv.md': 'clean\n', 'b.bin': 'x\u0000 call +91 90000 00000' });
    const hits = scanGit(git, 'HEAD', homes()).hits;
    expect(hits).toEqual([`${c} b.bin (asha, term #4)`, `${c} docs/[hidden] (asha, term #2, in the path)`]);
    expect(hits.join('\n')).not.toMatch(/initech|asha rao|asha-rao|90000/i);
  });
  it('a clean range is clean, and an unknown range is an error, not "clean"', () => {
    const base = commit('init', { 'a.md': 'clean\n' });
    commit('more', { 'b.md': 'fine\n' });
    expect(scanGit(git, `${base}..HEAD`, homes())).toEqual({ hits: [], commits: 1 });
    expect(() => scanGit(git, 'nope..HEAD', homes())).toThrow(/git/);
  });
});

describe('the folder scan of a git work tree', () => {
  it('skips git-ignored files (they are never pushed) and counts them', () => {
    commit('init', { '.gitignore': 'notes/\n*.local\n', 'a.md': 'clean\n' });
    mkdirSync(join(git, 'notes'));
    writeFileSync(join(git, 'notes', 'n.md'), 'Initech\n');
    writeFileSync(join(git, 'x.local'), 'Initech\n');
    writeFileSync(join(git, 'new.md'), 'Initech\n'); // untracked but not ignored: it could be committed next
    const r = scanFolder(git, homes(), { skipIgnored: true });
    expect(r.hits).toEqual(['new.md (asha, term #1)']);
    expect(r.ignoredSkipped).toBe(2);
    expect(scanFolder(git, homes()).hits).toEqual(['new.md (asha, term #1)', 'notes/n.md (asha, term #1)', 'x.local (asha, term #1)']);
  });
});
