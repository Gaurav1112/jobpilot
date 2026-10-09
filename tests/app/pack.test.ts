import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freezePack } from '../../src/kernel/broker.js';
import { dbPath, jobpilotHome, logsDir, outDir, packDir } from '../../src/app/pack/paths.js';
import { assertNoForbidden, citeable, ForbiddenTermError, loadPack } from '../../src/app/pack/load.js';
import type { Fact, Naming } from '../../src/app/pack/schema.js';
import { compileRoleDeny, compileSafePattern } from '../../src/app/pack/regex.js';
import { WatchEntrySchema } from '../../src/app/pack/schema.js';

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
    expect(pack.watchlist.map((w) => w.ats).sort()).toEqual(['ashby', 'careers', 'greenhouse', 'lever']);
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
  it('catches whitespace, newline and NBSP variants of a multi-word term', () => {
    const n: Naming = { employerDisplay: {}, forbiddenTerms: ['Initech India'] };
    for (const t of ['Initech  India', 'Initech\nIndia', 'Initech\u00a0India', 'INITECH\tindia']) {
      expect(() => assertNoForbidden(`at ${t} now`, n)).toThrow(ForbiddenTermError);
    }
  });
  it('folds Turkish dotted and dotless i, and Cyrillic and Greek homoglyphs (Task 8 fix round 2)', () => {
    for (const t of [
      '\u0130nitech', // İnitech
      'In\u0131tech', // dotless ı
      '\u0406nitech', // Cyrillic capital І
      'Init\u0435ch', // Cyrillic е
      'In\u0456t\u0435\u0441h', // Cyrillic і е с
      '\u0399NITECH', // Greek capital Ι
      'INIT\u0395CH', // Greek capital Ε
      '\u0399\u039d\u0399\u03a4\u0395CH', // Greek Ι Ν Ι Τ Ε
    ]) {
      expect(() => assertNoForbidden(`worked at ${t} once`, naming), t).toThrow(ForbiddenTermError);
    }
    const n: Naming = { employerDisplay: {}, forbiddenTerms: ['Acme Corp'] };
    for (const t of ['\u0410\u0441m\u0435 \u0421\u043erp', 'A\u0441me C\u043er\u0440', '\u0391cme \u039f'.replace('\u039f', 'Corp')]) {
      expect(() => assertNoForbidden(t, n), t).toThrow(ForbiddenTermError);
    }
    expect(() => assertNoForbidden('reinitechnology and \u0456nitiative', naming)).not.toThrow();
  });

  it('sees through zero-width characters and Unicode normalisation', () => {
    const n: Naming = { employerDisplay: {}, forbiddenTerms: ['Initech', 'café', 'Straße'] };
    expect(() => assertNoForbidden('Init\u200bech', n)).toThrow(ForbiddenTermError);
    expect(() => assertNoForbidden('Cafe\u0301 au lait', n)).toThrow(ForbiddenTermError);
    expect(() => assertNoForbidden('STRASSE', n)).toThrow(ForbiddenTermError);
    expect(() => assertNoForbidden('\uff29nitech', n)).toThrow(ForbiddenTermError);
  });
  it('uses Unicode letter boundaries', () => {
    const n: Naming = { employerDisplay: {}, forbiddenTerms: ['Initech'] };
    expect(() => assertNoForbidden('Initeché', n)).not.toThrow();
    expect(() => assertNoForbidden('(Initech)', n)).toThrow(ForbiddenTermError);
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

describe('roleDeny', () => {
  const deny = loadPack(FIXTURE).pack.filters.roleDeny.map(compileRoleDeny);
  const denied = (t: string): boolean => deny.some((r) => r.test(t));
  it('keeps legitimate titles', () => {
    for (const t of ['Internal Tools Engineer', 'International Payments Engineer', 'Salesforce Platform Engineer', 'Accounting Systems Engineer', 'Senior Backend Engineer']) {
      expect(denied(t), t).toBe(false);
    }
  });
  it('drops the excluded roles', () => {
    for (const t of ['Software Engineer Intern', 'Front End Engineer', 'Frontend Engineer', 'Sales Engineer', 'Account Executive', 'Engineering Manager']) {
      expect(denied(t), t).toBe(true);
    }
  });
  it('drops solution and solutions engineers, but not a backend engineer on a solutions platform (task 7 fix round 1)', () => {
    expect(denied('Solution Engineer')).toBe(true);
    expect(denied('Solutions Engineer')).toBe(true);
    expect(denied('Solutions Platform Backend Engineer')).toBe(false);
  });
});

describe('compileRoleDeny', () => {
  it('compiles with flags iu', () => {
    expect(compileRoleDeny('intern').flags).toBe('iu');
  });
  it.each(['(a+)+$', '(a*)*', '(a|a)+', '(\\w+\\s?)*', '(x{2,})+', 'a'.repeat(201)])('rejects unsafe %s', (p) => {
    expect(() => compileRoleDeny(p)).toThrow();
  });
  it.each(['\\bintern(ship)?\\b', '\\baccount (executive|manager)\\b', '[+*]+', 'a\\+b', '(?:foo)?bar'])('accepts safe %s', (p) => {
    expect(() => compileRoleDeny(p)).not.toThrow();
  });
  it('is enforced when loading a pack', () => {
    const d = copyFixture();
    writeFileSync(join(d, 'filters.yaml'), 'roleDeny: ["(a+)+$"]\ncompanyDeny: []\nemploymentDeny: []\n');
    expect(() => loadPack(d)).toThrow(/filters\.yaml/);
  });
});

describe('load hardening', () => {
  it('rejects blank forbidden terms', () => {
    const d = copyFixture();
    writeFileSync(join(d, 'naming.yaml'), 'employerDisplay: {}\nforbiddenTerms: ["  "]\n');
    expect(() => loadPack(d)).toThrow(/naming\.yaml/);
  });
  it('rejects an invalid override status', () => {
    expect(() => loadPack(FIXTURE, { 'f-nw-01': 'bogus' as never })).toThrow(/bogus|status/);
  });
  it('names policy.user.yaml for non-JSON values', () => {
    const d = copyFixture();
    writeFileSync(join(d, 'policy.user.yaml'), 'x: .nan\n');
    expect(() => loadPack(d)).toThrow(/policy\.user\.yaml/);
  });
});

describe('watchlist: careers entries', () => {
  const base = { company: 'Example Careers Co', ats: 'careers', slug: 'example-careers', hiresInIndia: true, allRemote: false };
  const ok = (v: unknown) => WatchEntrySchema.safeParse(v).success;

  it('the fixture carries one careers entry with an https listUrl', () => {
    const careers = loadPack(FIXTURE).pack.watchlist.filter((w) => w.ats === 'careers');
    expect(careers).toHaveLength(1);
    expect(careers[0]?.listUrl).toMatch(/^https:\/\//);
  });

  it('accepts an https listUrl with a safe linkPattern, and requires the linkPattern', () => {
    expect(ok({ ...base, listUrl: 'https://careers.example.com/jobs', linkPattern: '^/jobs/\\d+' })).toBe(true);
    expect(ok({ ...base, listUrl: 'https://careers.example.com/jobs' })).toBe(false);
  });

  it('requires listUrl for careers, and https with no port, credentials, IP literal or denied job board', () => {
    expect(ok({ ...base, linkPattern: 'x' })).toBe(false);
    for (const u of [
      'http://careers.example.com/jobs', 'https://careers.example.com:8443/jobs', 'https://u:p@careers.example.com/jobs', 'not a url', 'ftp://x.example/',
      'https://192.168.1.10/jobs', 'https://[::1]/jobs', 'https://www.glassdoor.co.in/Jobs', 'https://in.indeed.com/jobs', 'https://lnkd.in/x',
    ]) {
      expect(ok({ ...base, linkPattern: 'x', listUrl: u }), u).toBe(false);
    }
  });

  it('requires a kebab slug for careers', () => {
    expect(ok({ ...base, slug: 'Example Careers', listUrl: 'https://careers.example.com/jobs', linkPattern: 'x' })).toBe(false);
  });

  it('rejects an unsafe or invalid linkPattern', () => {
    for (const p of ['(a+)+$', '(', 'a'.repeat(201)]) expect(ok({ ...base, listUrl: 'https://careers.example.com/jobs', linkPattern: p }), p).toBe(false);
  });

  it('rejects listUrl or linkPattern on an API entry', () => {
    const gh = { company: 'X', ats: 'greenhouse', slug: 'x', hiresInIndia: true, allRemote: false };
    expect(ok(gh)).toBe(true);
    expect(ok({ ...gh, listUrl: 'https://x.example/jobs' })).toBe(false);
    expect(ok({ ...gh, linkPattern: 'jobs' })).toBe(false);
  });

  it('compileSafePattern is the neutral name of the roleDeny compiler', () => {
    expect(compileSafePattern).toBe(compileRoleDeny);
  });
});

describe('fx asOf is a real calendar date', () => {
  it('rejects an impossible date', async () => {
    const { FxSchema } = await import('../../src/app/pack/schema.js');
    const fx = (asOf: string) => FxSchema.safeParse({ asOf, toINR: { USD: 85, EUR: 92, GBP: 108, INR: 1 } }).success;
    expect(fx('2026-10-01')).toBe(true);
    expect(fx('2028-02-29')).toBe(true);
    expect(fx('2026-02-30')).toBe(false);
    expect(fx('2026-13-01')).toBe(false);
  });
});
