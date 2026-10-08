import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const bin = readFileSync(join(import.meta.dirname, '..', 'src', 'bin.ts'), 'utf8');

describe('src/bin.ts: the Node version guard runs before anything is loaded', () => {
  it('has no static import of a non-node: specifier', () => {
    const specs = [...bin.matchAll(/^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specs.filter((s) => !s?.startsWith('node:'))).toEqual([]);
  });

  it('checks the version before importing the CLI', () => {
    const check = bin.indexOf('process.versions.node');
    const load = bin.indexOf("import('./cli.js')");
    expect(check).toBeGreaterThanOrEqual(0);
    expect(load).toBeGreaterThan(check);
  });
});
