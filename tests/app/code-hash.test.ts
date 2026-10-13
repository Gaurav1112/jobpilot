import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeHash, codeHashOf, CODE_ROOT } from '../../src/app/code-hash.js';
import { computeStepKey } from '../../src/kernel/memo.js';
import { normalizer } from '../../src/app/agents/normalizer.js';
import { makeEnvelopeId } from '../../src/kernel/envelope.js';
import type { Envelope } from '../../src/kernel/envelope.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { runDaily, type RunOutcome } from '../../src/app/run.js';

/** A tiny code tree: src/**\/*.ts and assets/fonts/*, plus files the hash must ignore. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'jp-code-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const base = {
  'src/a.ts': 'export const a = 1;\n',
  'src/app/b.ts': 'export const b = 2;\n',
  'assets/fonts/Font.ttf': 'font-bytes',
};

describe('the JOBPILOT_CODE_HASH test seam', () => {
  it('is honoured only under test (NODE_ENV=test or VITEST), and ignored by a real run', () => {
    const real = codeHashOf(CODE_ROOT);
    expect(codeHash({ JOBPILOT_CODE_HASH: 'pinned', VITEST: 'true' })).toBe('pinned');
    expect(codeHash({ JOBPILOT_CODE_HASH: 'pinned', NODE_ENV: 'test' })).toBe('pinned');
    expect(codeHash({ JOBPILOT_CODE_HASH: 'pinned' })).toBe(real);
    expect(codeHash({ JOBPILOT_CODE_HASH: 'pinned', NODE_ENV: 'production' })).toBe(real);
    expect(codeHash({ JOBPILOT_CODE_HASH: '', VITEST: 'true' })).toBe(real);
  });
});

describe('I4: the code hash in every app step key', () => {
  it('is 16 hex characters, and the same code gives the same hash', () => {
    const h = codeHashOf(tree(base));
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(codeHashOf(tree(base))).toBe(h);
  });

  it('changes with any src/**/*.ts file or any font, and ignores everything else', () => {
    const h = codeHashOf(tree(base));
    expect(codeHashOf(tree({ ...base, 'src/app/b.ts': 'export const b = 3;\n' }))).not.toBe(h);
    expect(codeHashOf(tree({ ...base, 'src/app/c.ts': 'export {};\n' }))).not.toBe(h);
    expect(codeHashOf(tree({ ...base, 'assets/fonts/Font.ttf': 'other-bytes' }))).not.toBe(h);
    expect(codeHashOf(tree({ ...base, 'src/notes.md': 'x', 'README.md': 'y', 'tests/t.ts': 'z' }))).toBe(h);
  });

  it('is computed once from the repository, and a code change gives a new step key', () => {
    expect(codeHash()).toBe(codeHashOf(CODE_ROOT));
    expect(codeHash()).toBe(codeHash());
    const input: Envelope = {
      envelopeId: makeEnvelopeId('seed', 0), stepKey: 'seed', index: 0, type: 'RawPosting@1', producer: { agentId: 'x', version: '1.0.0', contractHash: 'h' },
      parents: [], payload: { any: 1 }, handoff: { guarantees: [], dataClass: 'P0', obligations: [], pins: { policyHash: 'p' } }, guardrails: [], cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
    };
    const before = codeHashOf(tree(base));
    const after = codeHashOf(tree({ ...base, 'src/a.ts': 'export const a = 2;\n' }));
    expect(computeStepKey(normalizer.contract, input, 'p', 'none', before)).not.toBe(computeStepKey(normalizer.contract, input, 'p', 'none', after));
    expect(computeStepKey(normalizer.contract, input, 'p', 'none', before)).toBe(computeStepKey(normalizer.contract, input, 'p', 'none', codeHashOf(tree(base))));
  });
});

const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();

describe.skipIf(pdftotext === undefined)('I4 end to end: a code change re-runs every step once', () => {
  it('the same code replays everything; another code hash executes every agent again, then replays', async () => {
    const repo = join(import.meta.dirname, '../..');
    const home = mkdtempSync(join(tmpdir(), 'jp-code-e2e-'));
    try {
      cpSync(join(repo, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
      writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: [himalayas]\n');
      const offline = offlineProviders(join(repo, 'tests/fixtures/e2e'));
      const clock = { now: () => '2026-10-09T01:30:00.000Z' };
      const run = (code: string) =>
        runDaily({ home, clock, fetch: offline.fetch, browser: offline.browser, sleep: async () => {}, pdftotext: pdftotext as string, codeHash: code });
      const executed = (s: RunOutcome): string[] =>
        Object.entries(s.counts.byAgent)
          .filter(([, c]) => c.done + c.quarantined + c.failed - c.replayed > 0)
          .map(([a]) => a)
          .sort();
      const first = await run('code-a');
      const all = executed(first);
      expect(all).toEqual(expect.arrayContaining(['normalizer', 'eligibility', 'scorer-lexicon', 'renderer', 'qa-gate']));
      expect(executed(await run('code-a'))).toEqual([]);
      const changed = await run('code-b');
      expect(executed(changed)).toEqual(all);
      expect(executed(await run('code-b'))).toEqual([]);
      // Same code, same bytes: the documents of the re-run are identical.
      expect(changed.projection.docs).toEqual(first.projection.docs);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 240_000);
});
