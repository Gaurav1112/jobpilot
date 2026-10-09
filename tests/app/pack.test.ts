import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freezePack } from '../../src/kernel/broker.js';
import { dbPath, jobpilotHome, logsDir, outDir, packDir } from '../../src/app/pack/paths.js';
import { assertNoForbidden, citeable, ForbiddenTermError, loadPack } from '../../src/app/pack/load.js';
import type { Fact, Naming } from '../../src/app/pack/schema.js';

const FIXTURE = resolve(import.meta.dirname, '../fixtures/pack');
const tmp: string[] = [];

function copyFixture(): string {
  const d = mkdtempSync(join(tmpdir(), 'jp-pack-'));
  tmp.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  return d;
}
function append(dir: string, file: string, text: string): void {
  const p = join(dir, file);
  writeFileSync(p, readFileSync(p, 'utf8') + text);
}

afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('paths', () => {
  it('honours JOBPILOT_HOME', () => {
    const prev = process.env['JOBPILOT_HOME'];
    process.env['JOBPILOT_HOME'] = '/x/jp';
    try {
      expect(jobpilotHome()).toBe('/x/jp');
      expect(packDir()).toBe('/x/jp/pack');
      expect(outDir()).toBe('/x/jp/out');
      expect(dbPath()).toBe('/x/jp/jobpilot.db');
      expect(logsDir()).toBe('/x/jp/logs');
    } finally {
      if (prev === undefined) delete process.env['JOBPILOT_HOME'];
      else process.env['JOBPILOT_HOME'] = prev;
    }
  });
});

describe('loadPack', () => {
  it('loads the fictional fixture', () => {
    const { pack, hash } = loadPack(FIXTURE);
    expect(pack.contact.name).toBe('Asha Rao');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.facts.length).toBeGreaterThanOrEqual(14);
    const statuses = new Set(pack.facts.map((f) => f.status));
    expect(statuses.has('derived-unverified')).toBe(true);
    expect(statuses.has('rejected')).toBe(true);
    expect(pack.facts.some((f) => f.kind === 'cert')).toBe(true);
    expect(pack.roles.map((r) => r.employer)).toEqual(['Northwind Labs', 'Contoso Retail', 'Fabrikam']);
    expect(pack.watchlist.map((w) => w.ats).sort()).toEqual(['ashby', 'greenhouse', 'lever']);
    expect(pack.naming.forbiddenTerms).toEqual(['Initech']);
    const raw = pack.facts.find((f) => f.employer.startsWith('Initech'));
    expect(raw).toBeDefined();
    expect(pack.naming.employerDisplay[raw?.employer ?? '']).toBe('Northwind Labs');
    expect(pack.targets.minFit).toBe(60);
    expect(pack.targets.maxYearsRequired).toBe(14);
    expect(pack.offers.floor?.amount).toBe(1200000);
  });

  it('includes the key itself in each lexicon group synonyms', () => {
    const { pack } = loadPack(FIXTURE);
    const spring = pack.lexicon.strong.find((g) => g.key === 'spring');
    expect(spring?.synonyms).toContain('spring');
    expect(spring?.synonyms).toContain('spring boot');
    for (const g of [...pack.lexicon.strong, ...pack.lexicon.medium, ...pack.lexicon.gap]) {
      expect(g.synonyms).toContain(g.key);
    }
  });

  it('is deep-freezable for ctx.pack', () => {
    const { pack } = loadPack(FIXTURE);
    expect(Object.isFrozen(freezePack(pack).facts)).toBe(true);
  });

  it('applies defaults for missing optional files', () => {
    const d = copyFixture();
    for (const f of ['offers.yaml', 'fx.yaml', 'feeds.yaml', 'policy.user.yaml']) rmSync(join(d, f));
    const { pack } = loadPack(d);
    expect(pack.offers.floor).toBeNull();
    expect(pack.feeds.enabled).toEqual([]);
    expect(pack.policyUser).toEqual({});
    expect(pack.fx.toINR.INR).toBe(1);
  });

  it('errors when a required file is missing, naming it', () => {
    const d = copyFixture();
    rmSync(join(d, 'facts.yaml'));
    expect(() => loadPack(d)).toThrow(/facts\.yaml/);
  });

  it.each([
    'contact.yaml', 'facts.yaml', 'roles.yaml', 'eligibility.yaml', 'lexicon.yaml', 'targets.yaml',
    'filters.yaml', 'naming.yaml', 'offers.yaml', 'fx.yaml', 'watchlist.yaml', 'feeds.yaml',
  ])('rejects an unknown top-level key in %s, naming the file', (file) => {
    const d = copyFixture();
    append(d, file, '\nbogusKey: 1\n');
    expect(() => loadPack(d)).toThrow(new RegExp(file.replace('.', '\\.')));
  });

  it('rejects an unknown key nested in a fact, naming file and path', () => {
    const d = copyFixture();
    const p = join(d, 'facts.yaml');
    writeFileSync(p, readFileSync(p, 'utf8').replace('    kind: cert\n', '    kind: cert\n    extra: 1\n'));
    expect(() => loadPack(d)).toThrow(/facts\.yaml.*facts\.\d+/s);
  });

  it('rejects a malformed period and bad YAML', () => {
    const d = copyFixture();
    const p = join(d, 'facts.yaml');
    writeFileSync(p, readFileSync(p, 'utf8').replace('2022-03..present', '2022..now'));
    expect(() => loadPack(d)).toThrow(/facts\.yaml/);
    writeFileSync(p, 'facts: [\n');
    expect(() => loadPack(d)).toThrow(/facts\.yaml/);
  });

  it('rejects duplicate fact ids', () => {
    const d = copyFixture();
    const p = join(d, 'facts.yaml');
    writeFileSync(p, readFileSync(p, 'utf8').replaceAll('f-nw-02', 'f-nw-01'));
    expect(() => loadPack(d)).toThrow(/duplicate fact id/);
  });
});

describe('pack hash', () => {
  it('is stable for the same files', () => {
    expect(loadPack(FIXTURE).hash).toBe(loadPack(FIXTURE).hash);
    expect(loadPack(copyFixture()).hash).toBe(loadPack(FIXTURE).hash);
  });

  it('ignores contact and answers (P1)', () => {
    const d = copyFixture();
    const before = loadPack(d).hash;
    writeFileSync(join(d, 'contact.yaml'), 'name: Someone Else\nemail: a@example.com\nphone: "1"\ncity: Delhi\nlinks: []\n');
    writeFileSync(join(d, 'answers.yaml'), 'notice_period_days: 90\n');
    expect(loadPack(d).hash).toBe(before);
  });

  it('changes when a public file changes', () => {
    const d = copyFixture();
    const before = loadPack(d).hash;
    append(d, 'feeds.yaml', '');
    writeFileSync(join(d, 'feeds.yaml'), 'enabled: [remoteok, other]\n');
    expect(loadPack(d).hash).not.toBe(before);
  });

  it('changes with fact overrides, and overrides replace statuses', () => {
    const base = loadPack(FIXTURE);
    const o = loadPack(FIXTURE, { 'f-nw-05': 'verified' });
    expect(o.hash).not.toBe(base.hash);
    expect(o.pack.facts.find((f) => f.id === 'f-nw-05')?.status).toBe('verified');
    expect(base.pack.facts.find((f) => f.id === 'f-nw-05')?.status).toBe('derived-unverified');
    expect(loadPack(FIXTURE, { 'f-nw-05': 'verified' }).hash).toBe(o.hash);
  });

  it('rejects an override for an unknown fact id', () => {
    expect(() => loadPack(FIXTURE, { nope: 'verified' })).toThrow(/nope/);
  });
});

describe('citeable', () => {
  const base: Fact = {
    id: 'x', claim: 'c', tech: [], employer: 'e', period: '2020-01..present', kind: 'experience', status: 'verified',
  };
  it('allows only verified and user-stated', () => {
    expect(citeable({ ...base, status: 'verified' })).toBe(true);
    expect(citeable({ ...base, status: 'user-stated' })).toBe(true);
    expect(citeable({ ...base, status: 'derived-unverified' })).toBe(false);
    expect(citeable({ ...base, status: 'user-cannot-confirm' })).toBe(false);
    expect(citeable({ ...base, status: 'rejected' })).toBe(false);
  });
});

describe('assertNoForbidden', () => {
  const naming: Naming = { employerDisplay: {}, forbiddenTerms: ['Initech'] };
  it('matches case-insensitively at word boundaries', () => {
    expect(() => assertNoForbidden('worked at INITECH once', naming)).toThrow(ForbiddenTermError);
    expect(() => assertNoForbidden('Initech-India', naming)).toThrow(/Initech/);
    expect(() => assertNoForbidden('reinitechnology', naming)).not.toThrow();
    expect(() => assertNoForbidden('Northwind Labs', naming)).not.toThrow();
  });
  it('escapes regex metacharacters in terms', () => {
    const n: Naming = { employerDisplay: {}, forbiddenTerms: ['A+B'] };
    expect(() => assertNoForbidden('about AAB', n)).not.toThrow();
    expect(() => assertNoForbidden('about A+B co', n)).toThrow(ForbiddenTermError);
  });
  it('exposes the offending term', () => {
    try {
      assertNoForbidden('x initech y', naming);
      expect.unreachable();
    } catch (e) {
      expect((e as ForbiddenTermError).term).toBe('Initech');
    }
  });
});

describe('fixture hygiene', () => {
  it('exists', () => {
    expect(existsSync(join(FIXTURE, 'naming.yaml'))).toBe(true);
  });
});
