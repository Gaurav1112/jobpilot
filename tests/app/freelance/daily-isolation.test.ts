import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRunPack, resolvePdftotext } from '../../../src/app/kernel.js';
import { offlineProviders } from '../../../src/app/offline.js';
import { loadPack } from '../../../src/app/pack/load.js';
import { runCommand, runFreelanceCommand } from '../../../src/app/run-command.js';
import { rebuildDocs, runDaily } from '../../../src/app/run.js';

/**
 * Final review C1: a bad freelance file (freelance.yaml, platform-rules.yaml, networks/) never breaks the daily run.
 * The daily load (`run`, `docs rebuild`, `serve`) ignores the file with a warning; the freelance run and `pack check`
 * (both strict) refuse. A freelance file holding a forbidden term is ignored too, and its content never reaches any
 * daily output.
 */
const root = join(import.meta.dirname, '../../..');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-isolation-'));
  homes.push(home);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  return home;
}
const edit = (p: string, from: string, to: string): void => {
  const t = readFileSync(p, 'utf8');
  if (!t.includes(from)) throw new Error(`test setup: ${p} lacks ${from}`);
  writeFileSync(p, t.replace(from, to));
};

/** A marker only the forbidden keyword carries, so its absence from every output is checkable. */
const MARKER = 'zebrakw';
const CASES: readonly (readonly [string, (pack: string) => void, RegExp])[] = [
  ['a freelance.yaml typo', (p) => writeFileSync(join(p, 'freelance.yaml'), 'rateFloorUsdHour: forty\n'), /^freelance\.yaml: rateFloorUsdHour: .*the daily run ignores this file/],
  ['networks/arc.yaml.bak', (p) => writeFileSync(join(p, 'networks', 'arc.yaml.bak'), 'x: 1\n'), /^networks\/arc\.yaml\.bak: only \.yaml files belong in networks\/ \(the daily run ignores this file/],
  ['networks/README.md', (p) => writeFileSync(join(p, 'networks', 'README.md'), 'notes\n'), /^networks\/README\.md: only \.yaml files belong in networks\//],
  ['an unknown key in platform-rules.yaml', (p) => writeFileSync(join(p, 'platform-rules.yaml'), 'fiverr: {}\n'), /^platform-rules\.yaml: .*the daily run ignores this file/],
  ['a → in a network file', (p) => edit(join(p, 'networks', 'toptal.yaml'), 'English communication practice', 'English → practice'), /^U\+2192 in networks\/toptal\.yaml: screening\[0\]\.prep\[0\]/],
  ['a ✓ in a network file', (p) => edit(join(p, 'networks', 'toptal.yaml'), 'English communication practice', 'Prep ✓ done'), /^U\+2713 in networks\/toptal\.yaml/],
  ['an emoji in a network file', (p) => edit(join(p, 'networks', 'toptal.yaml'), 'English communication practice', 'Go \u{1F680}'), /^U\+1F680 in networks\/toptal\.yaml/],
  ['a forbidden term in a network keyword', (p) => edit(join(p, 'networks', 'arc.yaml'), 'keywords: [backend,', `keywords: [Initech ${MARKER}, backend,`), /^networks\/arc\.yaml: keywords\[0\] holds forbidden term #1 \(the daily run ignores this file/],
];

describe('the daily load ignores a bad freelance file; the strict load refuses it', () => {
  for (const [name, mutate, warning] of CASES) {
    it(name, () => {
      const pack = join(newHome(), 'pack');
      const before = loadPack(pack, {}, { asOf: '2026-10', mode: 'daily' });
      mutate(pack);
      const daily = loadRunPack(pack, {}, '2026-10', undefined, 'daily');
      expect(daily.warnings).toHaveLength(1);
      expect(daily.warnings[0]).toMatch(warning);
      expect(daily.warnings[0]).not.toMatch(/initech/i);
      // The daily hashes do not move: the freelance files are not in them.
      expect(daily.packHash).toBe(before.hash);
      expect(() => loadRunPack(pack, {}, '2026-10', undefined, 'strict')).toThrow();
    });
  }
  it('an ignored file takes its defaults (freelance.yaml, platform-rules.yaml) or is left out (a network)', () => {
    const pack = join(newHome(), 'pack');
    writeFileSync(join(pack, 'freelance.yaml'), 'fitFloor: 65\nrateFloorUsdHour: forty\n');
    edit(join(pack, 'networks', 'arc.yaml'), 'keywords: [backend,', 'keywords: [Initech, backend,');
    const { pack: p, warnings } = loadPack(pack, {}, { asOf: '2026-10', mode: 'daily' });
    expect(p.freelance.fitFloor).toBe(45); // the default, not the 65 of the broken file
    expect(p.networks.map((n) => n.id)).not.toContain('arc');
    expect(p.networks).toHaveLength(7);
    expect(warnings).toHaveLength(2);
  });
  it('a network file whose name holds a forbidden term is named by position only', () => {
    const pack = join(newHome(), 'pack');
    writeFileSync(join(pack, 'networks', 'initech.md'), 'x');
    const { warnings } = loadPack(pack, {}, { asOf: '2026-10', mode: 'daily' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^networks #\d+: /);
    expect(warnings[0]).not.toMatch(/initech/i);
  });
  it('a clean pack loads with no warning, and the hashes match the strict load', () => {
    const pack = join(root, 'tests/fixtures/pack');
    const d = loadRunPack(pack, {}, '2026-10', undefined, 'daily');
    const s = loadRunPack(pack, {}, '2026-10', undefined, 'strict');
    expect(d.warnings).toEqual([]);
    expect([d.packHash, d.fullPackHash, d.freelancePackHash]).toEqual([s.packHash, s.fullPackHash, s.freelancePackHash]);
  });
});

/** Every file under `dir`, as text (latin1 keeps binary files searchable). */
function allText(dir: string): string {
  let out = '';
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    out += statSync(p).isDirectory() ? allText(p) : readFileSync(p).toString('latin1');
  }
  return out;
}

describe.skipIf(pdftotext === undefined)('the daily run with a bad freelance file (C1)', () => {
  for (const [name, mutate, warning] of CASES) {
    it(`${name}: the daily run exits 0 with a warning; run-freelance refuses (exit 2)`, async () => {
      const home = newHome();
      mutate(join(home, 'pack'));
      const lines: string[] = [];
      const posted: string[] = [];
      const deps = { home, notifier: async (t: string) => void posted.push(t), out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), sleep: async () => {}, pdftotext: pdftotext as string };
      const code = await runCommand({ notify: true, offlineFixtures: join(root, 'tests/fixtures/e2e') }, { ...deps, clock: { now: () => '2026-10-13T02:00:00.000Z' } });
      expect(code, lines.join('\n')).toBe(0);
      expect(posted[0]).toMatch(/^3 new matches · top: /);
      const warned = lines.join('\n').split('\n').filter((l) => l.startsWith('warning: ')).map((l) => l.slice('warning: '.length));
      expect(warned.some((w) => warning.test(w)), warned.join('\n')).toBe(true);
      // The forbidden keyword's content never reaches a daily output: stdout, the notification, the documents, the DB.
      for (const text of [lines.join('\n'), posted.join('\n'), allText(join(home, 'out')), readFileSync(join(home, 'jobpilot.db')).toString('latin1')]) {
        expect(text).not.toContain(MARKER);
      }
      const free: string[] = [];
      const freeCode = await runFreelanceCommand(
        { notify: true, offlineFixtures: join(root, 'tests/fixtures/freelance-e2e') },
        { ...deps, notifier: async (t: string) => void free.push(t), out: (l: string) => free.push(l), err: (l: string) => free.push(l), clock: { now: () => '2026-10-13T03:00:00.000Z' } },
      );
      expect(freeCode).toBe(2);
      expect(free.find((l) => l.startsWith('jobpilot run-freelance failed: '))).toBeDefined();
      expect(free.join('\n')).not.toMatch(/initech/i);
    });
  }
  it('docs rebuild ignores the file too, and `pack check` (strict) refuses it', async () => {
    const home = newHome();
    const at = (t: string) => ({ now: () => t });
    const off = offlineProviders(join(root, 'tests/fixtures/e2e'));
    await runDaily({ home, clock: at('2026-10-13T02:00:00.000Z'), fetch: off.fetch, browser: off.browser, sleep: async () => {}, pdftotext: pdftotext as string });
    edit(join(home, 'pack', 'networks', 'arc.yaml'), 'keywords: [backend,', `keywords: [Initech ${MARKER}, backend,`);
    const rebuilt = await rebuildDocs({ home, clock: at('2026-10-13T02:30:00.000Z'), sleep: async () => {}, pdftotext: pdftotext as string });
    expect(rebuilt.warnings.some((w) => /^networks\/arc\.yaml: keywords\[0\] holds forbidden term #1/.test(w))).toBe(true);
    expect(allText(join(home, 'out'))).not.toContain(MARKER);
    const check = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/bin.ts'), 'pack', 'check'], { cwd: root, encoding: 'utf8', env: { ...process.env, JOBPILOT_HOME: home } });
    expect(check.status).toBe(1);
    expect(check.stderr).toMatch(/networks\/arc\.yaml: keywords\[0\] holds forbidden term #1/);
    expect(check.stderr).not.toMatch(/initech/i);
  });
});
