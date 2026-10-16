import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { HOSTED_RETENTION_YAML, HostedConfig, loadHostedConfig, parseCodeLock } from '../../src/app/hosted/config.js';
import { EMPTY_POINTER, parsePointer, Pointer, pointerJson } from '../../src/app/hosted/pointer.js';
import { readFileSync } from 'node:fs';

const EXAMPLE = join(__dirname, '../../examples/hosted/hosted.yaml');
const dir = mkdtempSync(join(tmpdir(), 'jp-cfg-'));
const write = (name: string, text: string): string => {
  const f = join(dir, name);
  writeFileSync(f, text);
  return f;
};
const base = (): Record<string, any> => parse(readFileSync(EXAMPLE, 'utf8')) as Record<string, any>;
const bad = (mutate: (c: Record<string, any>) => void, needle: string): void => {
  const c = base();
  mutate(c);
  const f = write('bad.yaml', JSON.stringify(c));
  expect(() => loadHostedConfig(f)).toThrow(needle);
};

describe('hosted.yaml', () => {
  it('the shipped example parses and equals the spec values', () => {
    const c = loadHostedConfig(EXAMPLE);
    expect(c).toEqual({
      version: 1,
      owner: 'example-user',
      view: { repo: 'jobpilot-view', url: 'https://example-user.github.io/jobpilot-view/' },
      budget: { monthlyMinutes: 2000, safetyMinutes: 100, cycleStartDay: 1, dailyEstimateMinutes: 46 },
      freelance: { windows: ['am'] },
      coverage: { everyWeeks: 2, anchor: '2026-11-01', maxSliceMinutes: 330, endBy: '07:00' },
      state: { keepGenerations: 7, keepWeekly: 4, archiveDays: 30, warnCompressedMB: 600, hardCompressedMB: 1500 },
      snapshot: { budgetMB: 40, staleHours: 26 },
      skipSources: [],
    });
    expect(HostedConfig.safeParse(c).success).toBe(true);
  });

  it('refuses unknown keys, warn >= hard and bad skipSources, naming the file and path', () => {
    bad((c) => { c.extra = 1; }, 'bad.yaml');
    bad((c) => { c.budget.extra = 1; }, 'budget');
    bad((c) => { c.state.warnCompressedMB = 1500; }, 'state.warnCompressedMB must be below hardCompressedMB');
    bad((c) => { c.skipSources = ['Acme Corp']; }, 'skipSources.0');
    bad((c) => { c.owner = '-bad'; }, 'owner');
  });

  it('never echoes the offending value', () => {
    const c = base();
    c.skipSources = ['Secret Value Inc'];
    try {
      loadHostedConfig(write('v.yaml', JSON.stringify(c)));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('Secret Value');
    }
  });

  it('accepts source:id and freelance:name skip forms', () => {
    const c = base();
    c.skipSources = ['greenhouse', 'greenhouse:acme-1', 'freelance:upwork'];
    expect(loadHostedConfig(write('ok.yaml', JSON.stringify(c))).skipSources).toHaveLength(3);
  });

  it('reports an unreadable or unparsable file by name', () => {
    expect(() => loadHostedConfig(join(dir, 'missing.yaml'))).toThrow('missing.yaml');
    expect(() => loadHostedConfig(write('broken.yaml', 'a: [1'))).toThrow('broken.yaml');
  });

  it('pins the retention yaml', () => {
    expect(HOSTED_RETENTION_YAML).toBe('version: 1\nkeep: {daily: 1, freelance: 1, coverage: 1, rebuild: 1}\n');
  });
});

describe('code.lock', () => {
  const sha = 'a'.repeat(40);
  it('accepts exactly one 40-hex line', () => {
    expect(parseCodeLock(sha)).toBe(sha);
    expect(parseCodeLock(`${sha}\n`)).toBe(sha);
  });
  it('refuses 41 hex, two lines, uppercase and empty', () => {
    for (const t of ['a'.repeat(41), `${sha}\n${sha}\n`, 'A'.repeat(40), '', `${sha}\n\n`, ` ${sha}`]) {
      expect(() => parseCodeLock(t), JSON.stringify(t)).toThrow('code.lock');
    }
  });
});

describe('pointer.json', () => {
  const rec = (gen: number) => ({
    gen, tag: `state-g${String(gen).padStart(6, '0')}`, asset: `state-g${String(gen).padStart(6, '0')}.jpst`,
    sha256: 'b'.repeat(64), bytes: 10, schema: { kernel: 1, app: 2 }, codeSha: 'c'.repeat(40), packHash: 'p',
    lastDone: { daily: '2026-10-15', freelance: null, coverage: null }, at: '2026-10-15T07:40:00Z',
  });
  const ptr = (over: Record<string, unknown> = {}) => ({ ...EMPTY_POINTER, gen: 2, current: rec(2), history: [rec(2), rec(1)], ...over });

  it('serialises the empty pointer canonically', () => {
    expect(pointerJson(EMPTY_POINTER)).toBe('{"budget":null,"current":null,"gen":0,"history":[],"lease":null,"sizeHard":false,"v":1}\n');
    expect(parsePointer(pointerJson(EMPTY_POINTER))).toEqual(EMPTY_POINTER);
  });

  it('round-trips a full pointer', () => {
    const p = Pointer.parse(ptr({ lease: { holder: 'actions:123', until: '2026-10-15T08:00:00Z' }, budget: { month: '2026-10', level: 'L0' } }));
    expect(parsePointer(pointerJson(p))).toEqual(p);
  });

  it('refuses current.gen != gen, a bad lease holder and unordered history', () => {
    expect(() => parsePointer(JSON.stringify(ptr({ gen: 3 })))).toThrow('current.gen');
    expect(() => parsePointer(JSON.stringify(ptr({ lease: { holder: 'laptop:XYZ', until: '2026-10-15T08:00:00Z' } })))).toThrow('lease.holder');
    expect(() => parsePointer(JSON.stringify(ptr({ history: [rec(1), rec(2)] })))).toThrow('history');
    expect(() => parsePointer(JSON.stringify(ptr({ history: [rec(2), rec(2)] })))).toThrow('history');
    expect(() => parsePointer(JSON.stringify({ ...EMPTY_POINTER, current: rec(1) }))).toThrow('current');
    expect(() => parsePointer('not json')).toThrow('pointer.json');
  });
});
