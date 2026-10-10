import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ALLOWED, isAgentCode, RENDER_LIBS, scanAgentSource, scanRenderLib } from './support/agent-scan.js';

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

describe('G-CONTAINMENT: the browser test flag is never wired', () => {
  it('names allowInsecureLocalhostForTests only where the provider defines it', () => {
    const where = walk(join(root, 'src')).flatMap((f) => (readFileSync(f, 'utf8').includes('allowInsecureLocalhostForTests') ? [rel(f)] : []));
    expect(where).toEqual(['src/app/browser/playwright-provider.ts']);
    const text = readFileSync(join(root, 'src/app/browser/playwright-provider.ts'), 'utf8');
    // The option declaration and the one read inside navigationAllowed, nothing else.
    expect(text.match(/allowInsecureLocalhostForTests/g)).toHaveLength(2);
  });
});

describe('G-CONTAINMENT: agent code reaches the outside world only through the broker', () => {
  const agentFiles = ['src/agents', 'src/demo', 'src/app/agents']
    .map((d) => join(root, d))
    .filter((d) => existsSync(d))
    .flatMap(walk)
    .filter((f) => isAgentCode(rel(f)))
    // Not agent code, but agent code may import them, so they must pass the same scan.
    .concat(APP_ALLOWED.map((f) => join(root, f)));
  const AT = 'src/agents/jobs/score.ts';

  it('finds no imports, globals or reflection outside the allow-list in agent code', () => {
    expect(agentFiles.map(rel)).toEqual(
      expect.arrayContaining(['src/demo/agents.ts', 'src/demo/types.ts', 'src/app/agents/sources/common.ts', 'src/app/agents/sources/lever.ts', 'src/app/types.ts', 'src/app/pack/regex.ts', 'src/app/agents/sources/careers.ts', 'src/app/agents/normalizer.ts', 'src/app/text/html.ts', 'src/app/text/norm.ts', 'src/app/comp/parse.ts', 'src/app/comp/floor.ts', 'src/app/lexicon.ts', 'src/app/agents/eligibility.ts', 'src/app/agents/scorer-lexicon.ts', 'src/app/pack/rules.ts', 'src/app/agents/writing/evidence-matcher.ts', 'src/app/agents/writing/resume-planner.ts', 'src/app/agents/writing/cover-writer.ts', 'src/app/agents/writing/grounded.ts', 'src/app/agents/writing/templates.ts', 'src/app/agents/writing/renderer.ts', 'src/app/agents/writing/qa-gate.ts', 'src/app/render/model.ts', 'src/app/render/fill.ts', 'src/app/render/html.ts', 'src/app/ats-profiles.ts']),
    );
    expect(agentFiles.flatMap((f) => scanAgentSource(rel(f), readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('lets agent code import the render libraries, which are held to their own narrower rule', () => {
    const f = 'src/app/agents/writing/x.ts';
    for (const ok of ["import { renderPdf } from '../../render/pdf.js'", "import { renderDocx } from '../../render/docx.js'", "import { modelText } from '../../render/model.js'"]) {
      expect(scanAgentSource(f, ok), ok).toEqual([]);
    }
    expect(scanAgentSource(f, "import PDFDocument from 'pdfkit'")).toEqual([`${f}:1: import of pdfkit`]);
    expect(scanAgentSource(f, "import { readFileSync } from '../../render/fs.js'")).toHaveLength(1);
    for (const lib of RENDER_LIBS) expect(scanRenderLib(lib, readFileSync(join(root, lib), 'utf8')), lib).toEqual([]);
    const lib = 'src/app/render/pdf.ts';
    for (const bad of ["import { writeFileSync } from 'node:fs'", "import x from 'node:child_process'", 'const t = Date.now()', 'const d = new Date()', 'Math.random()', 'await fetch(u)', "process.env['X']", "await import('node:fs')"]) {
      expect(scanRenderLib(lib, bad), bad).not.toEqual([]);
    }
    expect(scanRenderLib(lib, "const d = new Date(`${m.date}T00:00:00.000Z`)")).toEqual([]);
  });

  it('flags every bypass found in review', () => {
    const bypasses = [
      'fetch?.(u)', '(fetch)(u)', 'fetch/**/(u)', 'fetch.call(null, u)', 'fetch`u`', 'const f = fetch', 'fetch(u)',
      "process.getBuiltinModule('node:https')", 'const W = WebSocket; new W(u)', 'new (WebSocket)(u)',
      "(async () => {}).constructor('...')()", "import('./' + '../../kernel/providers.js')", "import('./x.js'.replace('x', 'y'))",
      'globalThis.fetch', "Reflect.get(globalThis, 'fetch')", "(0, eval)('1')", "new Function('')", "require('fs')",
      "import x from '../../kernel/providers.js'", "import('node:fs')",
      // earlier rounds, and the forms the regexes missed
      "f\\u0065tch('u')", "\\u0070rocess.getBuiltinModule('node:fs')", 'export { fetch as f }', "new EventSource('u')",
      "const { fetch: f } = globalThis", "const f = global.fetch", "process['binding']('fs')", 'await import(`./${x}`)', 'await import(m)',
      "x['constructor']", 'new.target', 'import.meta.url', "import x = require('fs')", "export * from '../../kernel/executor.js'",
      "import { fakeLlm } from '../../kernel/fakes.js'", "import type { Providers } from '../../kernel/providers.js'",
      "import { join } from 'node:path'", "import nodeFetch from 'node-fetch'", 'Buffer.from(x)', 'Deno.exit()', 'Bun.file(x)',
      'module.exports = 1', "new XMLHttpRequest()", 'function f(process: unknown) {}',
      'const { constructor: AF } = async () => {}', 'const { constructor } = x', "Object.getOwnPropertyDescriptor(p, 'constructor')",
      'Reflect.get(p, `constructor`)',
    ];
    for (const s of bypasses) expect(scanAgentSource(AT, s), s).not.toEqual([]);
  });

  it('strips a ?/# suffix from a relative specifier before resolving it', () => {
    const f = 'src/agents/x.ts';
    expect(scanAgentSource(f, "import x from '../kernel/providers.js?/../../agents/x.js'")).toEqual([`${f}:1: import of ../kernel/providers.js?/../../agents/x.js`]);
    expect(scanAgentSource(f, "import x from '../kernel/providers.js#/../../agents/x.js'")).not.toEqual([]);
    expect(scanAgentSource(f, "import x from './y.js?v=1'")).toEqual([]);
  });

  it('treats src/app/agents/** as agent code, with app types and sibling agent modules allowed', () => {
    const f = 'src/app/agents/sources/x.ts';
    expect(isAgentCode(f)).toBe(true);
    expect(isAgentCode('src/app/types.ts')).toBe(false);
    for (const ok of [
      "import { RawPosting } from '../../types.js'",
      "import type { DiscoveryRequest } from '../../types.js'",
      "import { finish } from './common.js'",
      "import { x } from '../other/y.js'",
      "import { defineAgent, type AgentContext } from '../../../kernel/agent.js'",
      "import { KernelError } from '../../../kernel/errors.js'",
      "import { parseComp } from '../../comp/parse.js'",
      "import { htmlToText } from '../../text/html.js'",
      "import { jobKey } from '../../text/norm.js'",
      "import { toInrPerYear } from '../../comp/floor.js'",
      "import { termsIn } from '../../lexicon.js'",
      "import { citeable, employerDisplay } from '../../pack/rules.js'",
    ]) {
      expect(scanAgentSource(f, ok), ok).toEqual([]);
    }
    for (const bad of [
      "import type { AgentContext } from '../../../kernel/broker.js'",
      "import x from '../../../kernel/providers.js'",
      "import { FiltersSchema } from '../../pack/schema.js'",
      "import { loadPack } from '../../pack/load.js'",
      "import { x } from '../../../cli.js'",
    ]) {
      expect(scanAgentSource(f, bad), bad).toEqual([`${f}:1: import of ${bad.match(/'([^']+)'/)![1]}`]);
    }
    expect(scanAgentSource(f, 'fetch(u)')).toEqual([`${f}:1: reference to fetch`]);
  });

  it('reports offenders as file:line: reason', () => {
    expect(scanAgentSource(AT, "const a = 1;\nawait fetch?.('u');")).toEqual([`${AT}:2: reference to fetch`]);
    expect(scanAgentSource(AT, "import x from '../../kernel/providers.js'")).toEqual([`${AT}:1: import of ../../kernel/providers.js`]);
    expect(scanAgentSource(AT, 'const = (')).toEqual([expect.stringMatching(new RegExp(`^${AT}:1: does not parse`))]);
  });

  it('does not flag ordinary agent code', () => {
    const ordinary = [
      'function f(obj: { fetch(n: number): void }) { obj.fetch(1) }', 'const o = { fetch: 1 }', "import { z } from 'zod'",
      "await import('../../kernel/errors.js')", "import { defineAgent } from '../../kernel/agent.js'", "import type { DataClass } from '../../kernel/data-class.js'",
      "import { x } from './helpers.js'", 'class A { fetch() {} process = 1 }', 'const processed = 1; prefetch(processed)', "ctx.http?.getText('u')",
      'type T = { fetch: number; process(): void }', 'const n = items[0]', 'x?.fetch?.(1)',
    ];
    for (const s of ordinary) expect(scanAgentSource(AT, s), s).toEqual([]);
    const demo = 'src/demo/agents.ts';
    expect(scanAgentSource(demo, readFileSync(join(root, demo), 'utf8'))).toEqual([]);
    for (const ok of ["import { DemoItem } from './types.js'", "import { x } from '../agents/jobs/score.js'", "import { defineAgent } from '../kernel/agent.js'"]) {
      expect(scanAgentSource(demo, ok), ok).toEqual([]);
    }
    expect(scanAgentSource(demo, "import { demoKernel } from './kernel.js'")).toHaveLength(1);
    expect(scanAgentSource(demo, "import x from '../kernel/providers.js'")).toEqual([`${demo}:1: import of ../kernel/providers.js`]);
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
    expect(existsSync(lock), 'pnpm-lock.yaml is missing: the lockfile scan cannot vouch for transitive dependencies').toBe(true);
    const locked = [...readFileSync(lock, 'utf8').matchAll(/^\s*'?\/?(@?[^\s@'/]+(?:\/[^\s@'/]+)?)@/gm)].map((m) => m[1] as string).filter(isDenied);

    expect({ manifest, imports, locked }).toEqual({ manifest: [], imports: [], locked: [] });
  });
});
