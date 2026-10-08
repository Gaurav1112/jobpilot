import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const SOURCE_EXT = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/;
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : SOURCE_EXT.test(p) ? [p] : [];
  });
const rel = (f: string) => relative(root, f).split(sep).join('/');

const submitPatterns = [
  /\.submit\b/,
  /requestSubmit\(/,
  /prototype\.submit/,
  /new\s+(Submit)?Event\(\s*['"`]submit/,
  /type\W{0,3}submit/i,
  /\bclick\([^)]*(apply|submit)/i,
  /getByRole[^;]*(apply|submit)/i,
  /keyboard\.press\(\s*['"`]Enter/,
];

describe('G-CONTAINMENT: submit-capable code lives only in src/agents/submit/', () => {
  it('finds no submit pattern outside the submit directory', () => {
    const offenders = walk(join(root, 'src'))
      .filter((f) => !rel(f).startsWith('src/agents/submit/'))
      .flatMap((f) => (submitPatterns.some((p) => p.test(readFileSync(f, 'utf8'))) ? [rel(f)] : []));
    expect(offenders).toEqual([]);
  });

  it('patterns match known submit forms and ignore look-alikes', () => {
    const positives = [
      'form.submit', 'form.submit()', 'f.requestSubmit()', 'HTMLFormElement.prototype.submit.call(f)',
      "el.dispatchEvent(new Event('submit'))", 'el.dispatchEvent(new SubmitEvent("submit"))', "{ type: 'submit' }",
      'type="submit"', "page.getByRole('button', { name: /apply/i }).click()", "btn.click('Apply now')",
      "page.keyboard.press('Enter')",
    ];
    for (const s of positives) expect(submitPatterns.some((p) => p.test(s)), s).toBe(true);
    for (const s of ['submitted', 'submit_failed', 'deniedSubmitHosts']) {
      expect(submitPatterns.some((p) => p.test(s)), s).toBe(false);
    }
    // each pattern must pull its own weight
    const own = [
      'form.submit', 'f.requestSubmit()', 'HTMLFormElement.prototype.submit', "new Event('submit'", "{ type: 'submit' }",
      "x.click('apply')", "page.getByRole('button', { name: /apply/i })", "keyboard.press('Enter')",
    ];
    submitPatterns.forEach((p, i) => expect(p.test(own[i] as string), String(p)).toBe(true));
  });
});

describe('G-NO-EVASION: anti-bot evasion tooling cannot be installed', () => {
  const deniedExact = [
    'puppeteer-extra', 'puppeteer-extra-plugin-stealth', 'playwright-extra', 'playwright-stealth', 'undetected-chromedriver',
    '2captcha', '@2captcha/captcha-solver', 'anti-captcha', 'capsolver', 'capmonster', 'fingerprint-injector', 'fingerprint-generator',
    'proxy-chain', 'rotating-proxy',
  ];
  const deniedPatterns = [
    /^puppeteer-extra/, /^playwright-extra/, /^@extra\//, /stealth/, /captcha/, /fingerprint/, /^patchright/, /^rebrowser-/,
    /^camoufox/, /proxy-chain/, /rotating-proxy/, /luminati/, /brightdata/, /^undetected/,
  ];
  const isDenied = (name: string) => deniedExact.includes(name) || deniedPatterns.some((p) => p.test(name));
  const pkgName = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] as string));

  it('name matcher flags evasion packages and spares ordinary ones', () => {
    for (const n of ['puppeteer-extra-plugin-recaptcha', '@extra/foo', 'my-stealth-kit', 'patchright', 'rebrowser-playwright', 'camoufox-js', 'brightdata-sdk', 'undetected-playwright']) {
      expect(isDenied(n), n).toBe(true);
    }
    for (const n of ['better-sqlite3', 'zod', 'commander', '@types/node']) expect(isDenied(n), n).toBe(false);
  });

  it('is not a dependency, transitive dependency or import', () => {
    // Out of reach: code that builds a specifier at run time from variables.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    const asObj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
    const asList = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
    const names = [
      ...['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides'].flatMap((k) => Object.keys(asObj(pkg[k]))),
      ...Object.keys(asObj(asObj(pkg.pnpm).overrides)),
      ...asList(pkg.bundleDependencies),
      ...asList(pkg.bundledDependencies),
    ];
    const manifest = names.filter(isDenied);

    const imports = walk(join(root, 'src')).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/['"`]((?:@[\w.-]+\/)?[\w.-][\w./-]*)['"`]/g)]
        .map((m) => pkgName(m[1] as string))
        .filter(isDenied)
        .map((d) => `${rel(f)}: ${d}`),
    );

    const lock = join(root, 'pnpm-lock.yaml');
    const locked = existsSync(lock)
      ? [...readFileSync(lock, 'utf8').matchAll(/^\s*'?\/?(@?[^\s@'/]+(?:\/[^\s@'/]+)?)@/gm)].map((m) => m[1] as string).filter(isDenied)
      : [];

    expect({ manifest, imports, locked }).toEqual({ manifest: [], imports: [], locked: [] });
  });
});
