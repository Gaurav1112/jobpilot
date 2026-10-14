import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Final review I2 (privacy): the user's real salary floor must not appear in a tracked file. The value is read at test
 * time from the user's own pack (`~/.jobpilot/pack/offers.yaml`) and never written into this repo; without that pack
 * the test is skipped. A hit is reported as `file:line` only, never with the value.
 *
 * Not scanned: `tests/` and `evals/`, whose synthetic fixtures use round amounts as test data (the strict daily
 * golden hashes `tests/fixtures/pack`, so they cannot change in a fix wave); see the fix-wave report.
 */
const root = join(import.meta.dirname, '../..');
const offers = join(homedir(), '.jobpilot', 'pack', 'offers.yaml');
const NOT_SCANNED = /^(?:tests|evals)\//;

/** Every spelling of `n` a document might use: plain, 3-digit groups, Indian groups, and lakh (`30 LPA`, `30L`). */
function spellings(n: number): RegExp[] {
  const esc = (s: string): string => s.replace(/[.,]/g, (c) => `\\${c}`);
  const plain = [String(n), n.toLocaleString('en-US'), n.toLocaleString('en-IN')].map((v) => new RegExp(`(?<![0-9,.])${esc(v)}(?![0-9])`));
  const lakh = new RegExp(`(?<![0-9.])${esc(String(n / 1e5))}\\s*(?:L\\b|LPA|lakh|lac)`, 'i');
  return [...plain, lakh];
}

describe('I2: the user\'s salary floor is in no tracked file', () => {
  it.runIf(existsSync(offers))('no tracked file outside tests/ and evals/ holds the floor in any spelling', () => {
    const amount = Number((parse(readFileSync(offers, 'utf8')) as { floor?: { amount?: unknown } }).floor?.amount);
    expect(Number.isFinite(amount) && amount > 0).toBe(true);
    const forms = spellings(amount);
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter((f) => f !== '' && !NOT_SCANNED.test(f));
    const hits: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(join(root, f), 'utf8');
      } catch {
        continue; // a tracked file deleted in the working tree
      }
      if (text.includes('\0')) continue;
      text.split('\n').forEach((line, i) => {
        if (forms.some((re) => re.test(line))) hits.push(`${f}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it.skipIf(existsSync(offers))('skipped: no pack at ~/.jobpilot/pack/offers.yaml on this machine, so there is no floor to look for', () => {});
});
