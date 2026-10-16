import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codesOf, createGateway, isTemplateLine, line, SLOTS, TEMPLATES, TemplateError, templateRegexes, type TemplateId } from '../../src/app/hosted/log-gateway.js';

const VALID: Record<string, string | number> = {
  pipeline: 'daily', trigger: 'primary', gen: 12, code: 'abcdef012345', holder: 'actions:123', until: '07:30 IST', reason: 'cas',
  mb: 12.5, outcome: 'done', minutes: 41, postings: 1204, toDecide: 37, problems: 3, gigs: 9, codes: ' (2 challenged, 1 timeout)',
  n: 4, seconds: 30, used: 120, total: 2000, month: '2026-10', level: 'L1', runId: '98765', hits: 0, lines: 0, step: 'triage',
  phase: 'H4', limit: 900,
};
const slotsOf = (id: TemplateId): { name: string; kind: string }[] =>
  [...TEMPLATES[id].matchAll(/\{([a-zA-Z]+):([a-z0-9]+)\}/g)].map((m) => ({ name: m[1] as string, kind: m[2] as string }));
// 'reason' is a refusal in `refused` and a failure elsewhere; 'until' is dm in freelanceCut.
const validFor = (id: TemplateId, kind: string, name: string): string | number => {
  if (id === 'refused' && name === 'reason') return 'repo-public';
  if (name === 'until' && kind === 'dm') return '16 Oct';
  if (kind === 'sizelevel') return 'warning';
  return VALID[name] as string | number;
};
const base = (id: TemplateId): Record<string, string | number> => Object.fromEntries(slotsOf(id).map((s) => [s.name, validFor(id, s.kind, s.name)]));

const BAD_STRINGS = ['Acme Corp', 'https://jobs.example.com/a', 'a\nb', '\u001b[31m', '::add-mask::x', '%0A', '-1', 'NaN', '1e9', '٣', ' 12', '12 ', 'L5', 'actions:1 x', 'ab@example.com', '../x', ''];
const BAD_NUMBERS = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53];
const ids = Object.keys(TEMPLATES) as TemplateId[];

describe('line', () => {
  it('renders the spec example exactly', () => {
    expect(line('daily', { outcome: 'done', minutes: 41, postings: 1204, toDecide: 37, problems: 3, codes: codesOf({ challenged: 2, timeout: 1 }) })).toBe(
      'daily: done in 41 min · 1,204 postings · 37 to decide · 3 problems (2 challenged, 1 timeout)',
    );
  });

  it('renders every template from valid values to a printable line the audit recognises', () => {
    for (const id of ids) {
      const out = line(id, base(id));
      expect(out, id).toMatch(/^[ -~·]+$/);
      expect(isTemplateLine(out), id).toBe(true);
    }
    expect(line('daily', { ...base('daily'), codes: '' })).toMatch(/3 problems$/);
  });

  it('rejects every bad value in every slot with a message that does not depend on the value', () => {
    for (const id of ids) {
      for (const { name, kind } of slotsOf(id)) {
        const messages = new Set<string>();
        for (const bad of [...BAD_STRINGS, ...BAD_NUMBERS]) {
          if (bad === '' && kind === 'codes') continue; // an empty codes slot is the "no problems" form
          if (bad === 1.5 && kind === 'mb') continue; // 1.5 MB is a size
          let err: unknown;
          try {
            line(id, { ...base(id), [name]: bad });
          } catch (e) {
            err = e;
          }
          expect(err, `${id}.${name} accepted ${String(bad)}`).toBeInstanceOf(TemplateError);
          const m = (err as Error).message;
          expect(m).toContain(id);
          expect(m).toContain(name);
          messages.add(m);
        }
        // one message per slot whatever the value was: nothing of the value can be in it
        expect(messages.size, `${id}.${name}`).toBe(1);
      }
    }
  });

  it('rejects unknown and missing slots', () => {
    expect(() => line('compactNone', { extra: 1 })).toThrow(TemplateError);
    expect(() => line('pulled', { gen: 1 })).toThrow(TemplateError);
    expect(() => line('pulled', {} as never)).toThrow(/slot gen missing/);
  });

  it('keeps the slot alphabets anchored', () => {
    for (const [k, r] of Object.entries(SLOTS)) expect(r.source.startsWith('^') && r.source.endsWith('$'), k).toBe(true);
  });
});

describe('codesOf', () => {
  it('sorts by count then code and is empty without problems', () => {
    expect(codesOf({})).toBe('');
    expect(codesOf({ timeout: 1, challenged: 2, network: 1 })).toBe(' (2 challenged, 1 network, 1 timeout)');
    expect(codesOf({ timeout: 0 })).toBe('');
    expect(codesOf({ timeout: 1200 })).toBe(' (1,200 timeout)');
  });
});

describe('templateRegexes and createGateway', () => {
  it('recognises template lines and nothing else', () => {
    expect(templateRegexes().length).toBe(ids.length);
    expect(isTemplateLine('compaction: nothing to archive')).toBe(true);
    expect(isTemplateLine('compaction: nothing to archive ')).toBe(false);
    expect(isTemplateLine('Acme Corp is hiring')).toBe(false);
  });

  it('writes to out and appends to the summary file', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'jp-gw-')), 'summary.md');
    const out: string[] = [];
    const g = createGateway({ out: (l) => out.push(l), summaryFile: f });
    expect(g.emit('compactNone', {})).toBe('compaction: nothing to archive');
    g.emit('pulled', { gen: 3, mb: 1.25 });
    expect(out).toEqual(['compaction: nothing to archive', 'state: generation 3 pulled and verified (1.3 MB)']);
    expect(readFileSync(f, 'utf8')).toBe(`${out.join('\n')}\n`);
    expect(() => g.emit('pulled', { gen: -1, mb: 1 })).toThrow(TemplateError);
    expect(out.length).toBe(2);
  });
});
