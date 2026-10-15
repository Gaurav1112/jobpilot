import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintWorkflow } from '../../src/app/hosted/workflow-lint.js';

const example = readFileSync(join(import.meta.dirname, '../../examples/hosted/daily.yml'), 'utf8');
const SHA = 'a'.repeat(40);

/** Replace exactly one occurrence, failing the test when the example no longer has it. */
function mutate(from: string, to: string): string {
  expect(example.split(from).length - 1, `the example must hold ${from}`).toBe(1);
  return example.replace(from, () => to);
}

describe('lintWorkflow', () => {
  it('passes the example workflow', () => {
    expect(lintWorkflow(example)).toEqual([]);
  });

  const cases: Array<[string, string, RegExp]> = [
    ['a push trigger', mutate('  workflow_dispatch: {}\n', '  workflow_dispatch: {}\n  push: {}\n'), /trigger.*push/],
    ['a pull_request trigger', mutate('  workflow_dispatch: {}\n', '  workflow_dispatch: {}\n  pull_request: {}\n'), /trigger.*pull_request/],
    ['cancel-in-progress true', mutate('cancel-in-progress: false', 'cancel-in-progress: true'), /concurrency/],
    ['a second concurrency group', mutate('group: jobpilot-state', 'group: other-group'), /concurrency/],
    ['a floating action tag', mutate('actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0', 'actions/setup-node@v7'), /actions\/setup-node@v7/],
    ['an action that is not allowed', mutate('actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0', `some/action@${SHA}`), /some\/action/],
    ['a cron on the hour', mutate("'37 7 * * *'", "'0 7 * * *'"), /minute/],
    ['a missing timezone', mutate("'37 10 * * *'   # catch-up for a dropped or delayed 07:37 trigger (the cheap check exits in about a minute)\n      timezone: Asia/Kolkata\n", "'37 10 * * *'\n"), /timezone/],
    ['a missing timeout-minutes', mutate('    timeout-minutes: 150\n', ''), /timeout-minutes/],
    ['permissions write-all', mutate('permissions:\n  contents: write\n  issues: write\n  actions: read\n', 'permissions: write-all\n'), /permissions/],
    ['an extra permission', mutate('  actions: read\n', '  actions: read\n  pull-requests: write\n'), /permissions/],
    ['set -x in a run', mutate('run: pnpm install --frozen-lockfile', 'run: set -x && pnpm install --frozen-lockfile'), /set -x/],
    ['an upload-artifact step', mutate('      - name: chromium cache\n', `      - name: keep\n        uses: actions/upload-artifact@${SHA}\n      - name: chromium cache\n`), /upload-artifact/],
    ['a secret inside a run', mutate('run: pnpm install --frozen-lockfile', 'run: echo ${{ secrets.STATE_KEY }}'), /run.*secrets/],
    [
      'a secret in the install step env',
      mutate('        run: pnpm install --frozen-lockfile\n', '        run: pnpm install --frozen-lockfile\n        env:\n          JOBPILOT_SECRET_HOSTED_STATE_KEY: ${{ secrets.STATE_KEY }}\n'),
      /install.*env/,
    ],
    ['a different job timeout in the wrapper env', mutate("JOBPILOT_JOB_TIMEOUT_MINUTES: '150'", "JOBPILOT_JOB_TIMEOUT_MINUTES: '120'"), /JOBPILOT_JOB_TIMEOUT_MINUTES/],
  ];
  for (const [name, text, re] of cases) {
    it(`flags exactly one problem for ${name}`, () => {
      const problems = lintWorkflow(text);
      expect(problems, problems.join(' | ')).toHaveLength(1);
      expect(problems[0]).toMatch(re);
    });
  }

  it('reports unreadable YAML as a problem', () => {
    expect(lintWorkflow('a: [')).toHaveLength(1);
  });
});
