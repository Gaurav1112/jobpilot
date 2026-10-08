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

const FORBIDDEN_MODULES = ['http', 'https', 'net', 'tls', 'dgram', 'fs', 'fs/promises', 'child_process', 'worker_threads'];
const moduleRef = new RegExp(
  `(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+|\\brequire\\s*\\(\\s*)['"\\x60](?:node:)?(?:${FORBIDDEN_MODULES.join('|')})['"\\x60]`,
);
const bypassPatterns = [/\bfetch\s*\(/, /globalThis\.fetch/, /XMLHttpRequest/, /WebSocket\s*\(/, moduleRef, /process\.binding/];
const bypasses = (text: string) => bypassPatterns.some((p) => p.test(text));

describe('G-CONTAINMENT: agent code reaches the outside world only through the broker', () => {
  // src/kernel/, src/evals/, src/cli.ts and src/bin.ts are the trusted side and are not scanned.
  const agentDirs = ['src/agents', 'src/demo'].map((d) => join(root, d)).filter((d) => existsSync(d));

  it('finds no network, filesystem or process access in agent code', () => {
    expect(agentDirs.length).toBeGreaterThan(0);
    const offenders = agentDirs.flatMap(walk).flatMap((f) => (bypasses(readFileSync(f, 'utf8')) ? [rel(f)] : []));
    expect(offenders).toEqual([]);
  });

  it('patterns match known bypasses and ignore look-alikes', () => {
    const positives = [
      "fetch('https://x')", 'await fetch (url)', 'globalThis.fetch', 'new XMLHttpRequest()', "new WebSocket('wss://x')",
      "import http from 'node:http'", "import * as https from 'https'", "import { connect } from 'node:net'", "import tls from 'tls'",
      "import dgram from 'node:dgram'", "import { readFileSync } from 'node:fs'", "import { readFile } from 'fs/promises'",
      "import { readFile } from \"node:fs/promises\"", "import { spawn } from 'child_process'", "import { Worker } from 'node:worker_threads'",
      "const fs = require('fs')", "await import('node:child_process')", "import 'node:fs'", "export * from 'fs'", "process.binding('fs')",
    ];
    for (const s of positives) expect(bypasses(s), s).toBe(true);
    const negatives = [
      'fetch: async () => ({ status: 404 })', 'prefetch(x)', "import { join } from 'node:path'", "import { z } from 'zod'",
      "import x from 'fs-extra'", "import { createHash } from 'node:crypto'", 'ctx.http.getText(url)', 'const httpsOnly = true',
    ];
    for (const s of negatives) expect(bypasses(s), s).toBe(false);
    // each pattern must pull its own weight
    const own = ['fetch(u)', 'globalThis.fetch', 'XMLHttpRequest', 'WebSocket(u)', "from 'node:fs'", "process.binding('x')"];
    bypassPatterns.forEach((p, i) => expect(p.test(own[i] as string), String(p)).toBe(true));
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
