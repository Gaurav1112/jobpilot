import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { readSegment } from '../../src/app/store/retention.js';

let dir = '';
afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

describe('readSegment line splitting', () => {
  it('splits only on \\n: U+2028, U+2029 and a lone \\r inside a JSON string stay in their line', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jobpilot-seg-'));
    // JSON.stringify leaves U+2028/U+2029 unescaped, as canonicalJson writes them (a scraped job description).
    const rows = [
      { t: 'envelope', row: { body: 'line one still one' } },
      { t: 'envelope', row: { body: 'para graph' } },
      { t: 'step', row: { detail: 'plain' } },
    ];
    const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    expect(text).toContain(' ');
    const path = join(dir, 'seg.jsonl.gz');
    writeFileSync(path, gzipSync(Buffer.from(text, 'utf8')));
    const back = await readSegment(path);
    expect(back.lines).toEqual(rows);
  });

  it('keeps a multi-byte character split across gunzip chunks intact', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jobpilot-seg-'));
    const big = { t: 'envelope', row: { body: '₹'.repeat(200_000) + ' ' + 'é'.repeat(100_000) } };
    const path = join(dir, 'seg.jsonl.gz');
    writeFileSync(path, gzipSync(Buffer.from(`${JSON.stringify(big)}\n`, 'utf8')));
    const back = await readSegment(path);
    expect(back.lines).toEqual([big]);
  });
});
