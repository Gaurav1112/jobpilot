import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });

describe('G-CONTAINMENT: submit-capable code lives only in src/agents/submit/', () => {
  const patterns = [/\.submit\(\s*\)/, /requestSubmit\(/, /type\s*=\s*["']submit["']/, /\bclick\([^)]*(apply|submit)/i];
  it('finds no submit pattern outside the submit directory', () => {
    const offenders = walk(join(root, 'src'))
      .filter((f) => !relative(root, f).startsWith('src/agents/submit/'))
      .flatMap((f) => (patterns.some((p) => p.test(readFileSync(f, 'utf8'))) ? [relative(root, f)] : []));
    expect(offenders).toEqual([]);
  });
});

describe('G-NO-EVASION: anti-bot evasion tooling cannot be installed', () => {
  const denied = [
    'puppeteer-extra', 'puppeteer-extra-plugin-stealth', 'playwright-extra', 'playwright-stealth', 'undetected-chromedriver',
    '2captcha', '@2captcha/captcha-solver', 'anti-captcha', 'capsolver', 'capmonster', 'fingerprint-injector', 'fingerprint-generator',
    'proxy-chain', 'rotating-proxy',
  ];
  it('lists none of them in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies });
    expect(deps.filter((d) => denied.includes(d))).toEqual([]);
  });

  it('imports none of them from source', () => {
    const offenders = walk(join(root, 'src')).flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return denied.filter((d) => text.includes(`'${d}'`) || text.includes(`"${d}"`)).map((d) => `${relative(root, f)}: ${d}`);
    });
    expect(offenders).toEqual([]);
  });
});
