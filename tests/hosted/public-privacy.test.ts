import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { HostedConfig } from '../../src/app/hosted/config.js';

const root = join(import.meta.dirname, '../..');
const SPEC = 'docs/superpowers/specs/2026-10-15-jobpilot-hosted-design.md';

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}
const rel = (p: string): string => p.slice(root.length + 1);
const examples = [...walk(join(root, 'examples'))];
const publicFiles = [...examples, ...['docs/hosted.md', SPEC].map((f) => join(root, f)).filter((f) => existsSync(f))];

describe('the public-repo hosted material is fictional', () => {
  it('has the example files and the guide', () => {
    expect(examples.map(rel)).toEqual(expect.arrayContaining(['examples/hosted/daily.yml', 'examples/hosted/hosted.yaml']));
    expect(existsSync(join(root, 'docs/hosted.md'))).toBe(true);
  });

  it('every email ends in @example.com or @example.org', () => {
    const bad: string[] = [];
    for (const f of publicFiles) {
      for (const m of readFileSync(f, 'utf8').matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g)) {
        if (m[1] !== 'example.com' && m[1] !== 'example.org') bad.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('every GitHub owner is example-user', () => {
    const bad: string[] = [];
    const check = (f: string, owner: string): void => {
      if (owner !== 'example-user') bad.push(`${rel(f)}: ${owner}`);
    };
    for (const f of publicFiles) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/repository:\s*["']?([A-Za-z0-9_.-]+)\//g)) check(f, m[1] as string);
      for (const m of text.matchAll(/github\.com\/([A-Za-z0-9_.-]+)\//g)) check(f, m[1] as string);
      for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9-]+)\.github\.io\//g)) check(f, m[1] as string);
      for (const m of text.matchAll(/^\s*owner:\s*["']?([A-Za-z0-9_.-]+)/gm)) check(f, m[1] as string);
    }
    expect(bad).toEqual([]);
  });

  it('the only 40-hex strings in examples/ are the three pinned action SHAs', () => {
    const found = new Set<string>();
    for (const f of examples) for (const m of readFileSync(f, 'utf8').matchAll(/\b[0-9a-f]{40}\b/g)) found.add(m[0]);
    expect([...found].sort()).toEqual([
      '3d3c42e5aac5ba805825da76410c181273ba90b1',
      '55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
      '949feb2413d6458794dcd2491c4babbbce0c15c1',
    ]);
  });

  it('no number in examples/ equals a compensation value of the fixture pack offers', () => {
    const offers = readFileSync(join(root, 'tests/fixtures/pack/offers.yaml'), 'utf8');
    const values = new Set<string>();
    const collect = (v: unknown): void => {
      if (typeof v === 'number' && v >= 1000) values.add(String(v));
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v !== null && typeof v === 'object') Object.values(v).forEach(collect);
    };
    collect(parse(offers));
    expect(values.size).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const f of examples) {
      const text = readFileSync(f, 'utf8');
      for (const v of values) {
        const forms = [v, Number(v).toLocaleString('en-US')];
        for (const form of forms) if (new RegExp(`(?<![\\d,.])${form.replace(/[.,]/g, '\\$&')}(?![\\d,]|\\.\\d)`).test(text)) hits.push(`${rel(f)}: ${v}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the example hosted.yaml parses', () => {
    const cfg = HostedConfig.parse(parse(readFileSync(join(root, 'examples/hosted/hosted.yaml'), 'utf8')));
    expect(cfg.owner).toBe('example-user');
  });
});
