import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The real forbidden terms live only in the user's own pack, never in this repo.
const home = process.env['JOBPILOT_HOME'] ?? join(homedir(), '.jobpilot');
const namingPath = join(home, 'pack', 'naming.yaml');
const root = resolve(import.meta.dirname, '..');

function termsFromPack(): string[] {
  const doc = parse(readFileSync(namingPath, 'utf8')) as { forbiddenTerms?: unknown } | null;
  const t = doc?.forbiddenTerms;
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

describe('forbidden terms never appear in the repo', () => {
  if (!existsSync(namingPath)) {
    it.skip(`skipped: no ${namingPath} (the real pack is not installed on this machine)`, () => {});
    return;
  }
  it('src, tests, docs, evals and examples are clean', () => {
    const terms = termsFromPack().map((t) => t.toLowerCase());
    expect(terms.length, 'naming.yaml has no forbiddenTerms').toBeGreaterThan(0);
    const hits: string[] = [];
    for (const top of ['src', 'tests', 'docs', 'evals', 'examples']) {
      const dir = join(root, top);
      if (!existsSync(dir)) continue;
      for (const file of walk(dir)) {
        const text = readFileSync(file, 'utf8').toLowerCase();
        for (const t of terms) if (text.includes(t)) hits.push(`${file.slice(root.length + 1)} (term #${terms.indexOf(t) + 1})`);
      }
    }
    // Report file and term index only; never echo the term itself.
    expect(hits).toEqual([]);
  });
});
