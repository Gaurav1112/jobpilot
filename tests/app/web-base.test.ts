import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { u } from '../../src/app/web/paths.js';
import { pagesHome, renderPages } from '../support/web-pages.js';

const repo = join(import.meta.dirname, '../..');
const home = pagesHome();
afterAll(() => rmSync(home, { recursive: true, force: true }));
const ATTR = /\b(?:href|action|src|hx-get|hx-post|data-copy-src)="(\/[^"]*)"/g;

describe('dashboard base path', () => {
  it('u()', () => {
    expect(u('', '/jobs/1')).toBe('/jobs/1');
    expect(u('/p/asha', '/jobs/1')).toBe('/p/asha/jobs/1');
    expect(u('/p/asha', '/')).toBe('/p/asha/');
    expect(() => u('', 'jobs')).toThrow(/must start with \//);
  });
  it('without a base every page is byte-identical to before', async () => {
    const want = JSON.parse(readFileSync(join(repo, 'tests/fixtures/web-legacy-pages.json'), 'utf8')) as Record<string, string>;
    expect(await renderPages(home)).toEqual(want);
  });
  it('with /p/asha every absolute link, form and script is under it', async () => {
    const pages = await renderPages(home, '/p/asha');
    const outside = Object.entries(pages).flatMap(([route, body]) => [...body.matchAll(ATTR)].map((m) => m[1] as string).filter((p) => !p.startsWith('/p/asha/')).map((p) => `${route}: ${p}`));
    expect(outside).toEqual([]);
    expect(Object.values(pages).join('').match(ATTR)?.length).toBeGreaterThan(30);
  });
  it('no view writes a raw absolute path, and every redirect goes through u()', () => {
    const grep = (args: string[]): string => {
      try {
        return execFileSync('/usr/bin/grep', args, { encoding: 'utf8' }).trim();
      } catch (e) {
        if ((e as { status?: number }).status === 1) return ''; // grep: no match
        throw e;
      }
    };
    const web = join(repo, 'src/app/web');
    expect(grep(['-rnE', '--exclude=root.ts', '(href|action|src|hx-get|hx-post)="/', web])).toBe('');
    expect(grep(['-rnE', '--exclude=root.ts', 'redirect\\((`|\'|")/', web])).toBe('');
  });
});
