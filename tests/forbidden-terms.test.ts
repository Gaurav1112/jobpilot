import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { privacyHomes } from '../src/app/privacy.js';

// The real forbidden terms live only in each profile's own pack, never in this repo. `jobpilot privacy scan` covers
// contact details and the pay floor; this test keeps to forbidden terms, for every profile (removed ones too).
const homes = privacyHomes().filter((h) => existsSync(join(h.home, 'pack', 'naming.yaml')));
const root = resolve(import.meta.dirname, '..');

function termsOf(home: string): string[] {
  const doc = parse(readFileSync(join(home, 'pack', 'naming.yaml'), 'utf8')) as { forbiddenTerms?: unknown } | null;
  const t = doc?.forbiddenTerms;
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.toLowerCase()) : [];
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
  if (homes.length === 0) {
    it.skip('skipped: no profile has a pack/naming.yaml (the real pack is not installed on this machine)', () => {});
    return;
  }
  it('src, tests, docs and evals are clean', () => {
    const sets = homes.map((h) => ({ label: h.label, terms: termsOf(h.home) }));
    expect(sets.some((s) => s.terms.length > 0), 'no profile naming.yaml has forbiddenTerms').toBe(true);
    const hits: string[] = [];
    for (const top of ['src', 'tests', 'docs', 'evals']) {
      const dir = join(root, top);
      if (!existsSync(dir)) continue;
      for (const file of walk(dir)) {
        const text = readFileSync(file, 'utf8').toLowerCase();
        for (const s of sets) s.terms.forEach((t, i) => {
          if (text.includes(t)) hits.push(`${file.slice(root.length + 1)} (${s.label}, term #${i + 1})`);
        });
      }
    }
    // Report file, profile and term index only; never echo the term itself.
    expect(hits).toEqual([]);
  });
});
