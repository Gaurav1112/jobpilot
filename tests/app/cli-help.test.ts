import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * The operator guide (README "Running jobpilot on your own" and docs/operations.md) names real commands: every one it
 * writes as `node --run jobpilot -- <command>` must exist in the CLI's --help, and the guide must not point at the
 * build tooling or name anything the pack forbids.
 */

const root = join(import.meta.dirname, '../..');
const read = (f: string): string => readFileSync(join(root, f), 'utf8');
const readme = read('README.md');
const section = ((): string => {
  const start = readme.indexOf('## Running jobpilot on your own');
  if (start < 0) return '';
  const next = readme.indexOf('\n## ', start + 5);
  return readme.slice(start, next < 0 ? undefined : next);
})();
const guide = `${section}\n${read('docs/operations.md')}`;

const help = (path: readonly string[]): { status: number | null; out: string } => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/bin.ts'), ...path, '--help'], { cwd: root, encoding: 'utf8' });
  return { status: r.status, out: r.stdout };
};
/** The subcommand names a --help lists under "Commands:" (without `help`). */
const subcommands = (out: string): string[] => {
  const at = out.indexOf('Commands:');
  if (at < 0) return [];
  return out
    .slice(at)
    .split('\n')
    .slice(1)
    .map((l) => /^ {2}([a-z][a-z0-9-]*)\b/u.exec(l)?.[1])
    .filter((n): n is string => n !== undefined && n !== 'help');
};

/** Every `node --run jobpilot -- <words>` in the guide, cut at the first flag, placeholder, path or quote. */
function guideCommands(text: string): string[][] {
  const found: string[][] = [];
  for (const m of text.matchAll(/node --run jobpilot -- ([^`\n]+)/gu)) {
    const words: string[] = [];
    for (const w of (m[1] as string).trim().split(/\s+/u)) {
      if (!/^[a-z][a-z0-9-]*$/u.test(w)) break;
      words.push(w);
    }
    if (words.length > 0) found.push(words);
  }
  return found;
}

describe('the operator guide', () => {
  it('has the README section and docs/operations.md', () => {
    expect(section).toContain('docs/operations.md');
    expect(guide.length).toBeGreaterThan(5000);
  });

  it('names the commands it documents', () => {
    const names = new Set(guideCommands(guide).map((w) => w.join(' ')));
    for (const c of ['pack check', 'pack import', 'run', 'run-freelance', 'run-coverage', 'coverage probe', 'sources probe', 'schedule install', 'schedule status', 'schedule run-now', 'schedule uninstall', 'serve', 'gmail connect', 'gmail status', 'gmail disconnect', 'networks pack', 'audit verify', 'docs rebuild', 'facts list']) {
      expect([...names].some((n) => n.startsWith(c)), c).toBe(true);
    }
  });

  it('every command in the guide exists in --help', () => {
    const cache = new Map<string, { status: number | null; out: string }>();
    const helpOf = (p: readonly string[]) => {
      const k = p.join(' ');
      if (!cache.has(k)) cache.set(k, help(p));
      return cache.get(k) as { status: number | null; out: string };
    };
    const top = subcommands(helpOf([]).out);
    expect(top).toContain('run-coverage');
    for (const words of guideCommands(guide)) {
      const path: string[] = [];
      let known = top;
      for (const w of words) {
        if (!known.includes(w)) {
          // an argument (`networks pack arc`), only after a command with no subcommands
          expect(known, `${words.join(' ')}: "${w}" is not a command`).toEqual([]);
          break;
        }
        path.push(w);
        const h = helpOf(path);
        expect(h.status, `${path.join(' ')} --help`).toBe(0);
        known = subcommands(h.out);
      }
      expect(path.length, words.join(' ')).toBeGreaterThan(0);
    }
  }, 300_000);

  it('every option the guide uses is in that command\'s --help', () => {
    const uses = [
      ['run', '--if-due'], ['run', '--refresh'], ['run', '--no-notify'], ['run', '--offline-fixtures'], ['run-coverage', '--if-due'], ['run-coverage', '--slice-minutes'], ['run-coverage', '--no-freehire'], ['run-coverage', '--catalogue-limit'],
      ['coverage', 'probe', '--days'], ['coverage', 'probe', '--json'], ['serve', '--port'], ['pack', 'import', '--dry-run'], ['pack', 'import', '--forbid'], ['schedule', 'run-now', '--freelance'], ['schedule', 'run-now', '--coverage'], ['schedule', 'install', '--coverage-now'],
      ['audit', 'verify', '--db'], ['quarantined', '--db'], ['resume', '--db'],
    ] as const;
    for (const u of uses) {
      const opt = u[u.length - 1] as string;
      const path = u.slice(0, -1);
      expect(guide, `${path.join(' ')} ${opt} is in the guide`).toContain(opt);
      expect(help(path).out, `${path.join(' ')} ${opt}`).toContain(opt);
    }
  }, 120_000);

  it('sources expansion: the guide covers the freehire seed, the new platforms and the gig sources', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['catalogue:freehire']).toBeDefined();
    for (const w of [
      'node --run catalogue:freehire -- --date', '--cache', '--offline', 'assets/freehire/NOTICE', 'freehire', 'MIT', 'Found through freehire', '300',
      'JazzHR', 'Zoho Recruit', 'Manatal', 'Freshteam', 'UKG Pro', 'JobBoardView',
      'Draft.dev', 'Prime Intellect', 'Fractional Jobs', 'platforms.<id>.enabled: false', 'draftdev', 'prime-intellect', 'fractional-jobs',
      'catalogue: ', 'discovery: boards', 'leads', '(last week)',
    ]) expect(guide, w).toContain(w);
    // the gig sources' request budget
    expect(guide).toMatch(/≤ 12 requests a run/u);
    expect(guide).toMatch(/two runs a day/u);
    // the help texts name what the guide documents
    expect(help(['coverage', 'probe']).out).toMatch(/catalogue/u);
    expect(help(['sources', 'probe']).out).toMatch(/Draft\.dev/u);
    expect(help(['run-coverage']).out).toMatch(/discovery/u);
  }, 60_000);

  it('final review M-B7: a bad --limit or --slice-minutes is a usage error (commander\'s), not a crash', () => {
    for (const [opt, v] of [['--limit', 'abc'], ['--slice-minutes', '0']] as const) {
      const r = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/bin.ts'), 'run-coverage', opt, v], { cwd: root, encoding: 'utf8', env: { ...process.env, JOBPILOT_HOME: '/nonexistent-jobpilot-home' } });
      expect(r.stderr, opt).toMatch(new RegExp(`^error: option '${opt} <n>' argument '${v}' is invalid\\. ${opt} must be`, 'u'));
      expect(r.status, opt).toBe(1);
    }
  }, 60_000);

  it('does not point at the build tooling or mention the user\'s employer or client', () => {
    expect(guide).not.toMatch(/\.superpowers|\bskills?\b|CLAUDE\.md|AGENTS\.md|subagent/iu);
    // the only mentions allowed: the plain statement, once in the README section and once in the guide, that Claude Code was only the build tool
    const claude = guide.match(/claude[^\n]*/giu) ?? [];
    expect(claude.length).toBeLessThanOrEqual(2);
    for (const c of claude) expect(c).toMatch(/^Claude Code was only the tool/u);
    for (const w of guideCommands(guide).flat()) expect(w).not.toMatch(/claude/iu);
    const naming = parseYaml(read('tests/fixtures/pack/naming.yaml')) as { forbiddenTerms: string[] };
    for (const t of naming.forbiddenTerms) expect(guide.toLowerCase()).not.toContain(t.toLowerCase());
  });

  it('states plainly that no AI or key is needed and that the LlmProvider is unused', () => {
    expect(guide).toMatch(/No AI and no API key is needed/u);
    expect(guide).toMatch(/Claude Code was only the tool the project was built with/u);
    expect(guide).toMatch(/`LlmProvider`/u);
    expect(guide).toMatch(/unused/u);
  });

  it('has no email address or phone number but the placeholders', () => {
    const emails = guide.match(/[\w.+-]+@[a-z][\w-]*\.[\w.-]+/gu) ?? [];
    for (const e of emails) expect(e).toBe('you@example.com');
    const phones = guide.match(/\+\d[\d ]{6,}/gu) ?? [];
    for (const p of phones) expect(p).toBe('+91 00000 00000');
  });
});
