import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CompanyVerdict, Platform } from '../../../src/app/coverage/types.js';
import { loadRunPack } from '../../../src/app/kernel.js';
import { loadPack, PackError } from '../../../src/app/pack/load.js';
import { packTextProblems } from '../../../src/app/pack/scan.js';
import { AppStore } from '../../../src/app/store/app-store.js';
import { APP_MIGRATIONS } from '../../../src/app/store/schema.js';
import { Store } from '../../../src/kernel/store/store.js';

const root = join(import.meta.dirname, '../../..');
const FIXTURE = join(root, 'tests/fixtures/pack');
const AT = '2026-10-13T01:30:00.000Z';
const LATER = '2026-10-20T01:30:00.000Z';
const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});
function copyPack(): string {
  const d = mkdtempSync(join(tmpdir(), 'jp-cov-'));
  tmp.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  return d;
}

type Status = 'verified' | 'proposed' | 'failed';
function verdict(over: { key?: string; status?: Status; platform?: Platform | null; jobsSeen?: number | null } = {}): CompanyVerdict {
  const key = over.key ?? 'example-one.test';
  return {
    guess: {
      site: {
        candidate: { companyKey: key, name: 'Example One', website: `https://${key}`, careersUrl: null, source: 'pick', runDate: '2026-10-13' },
        careersUrl: `https://careers.${key}/`,
        method: 'listed',
        evidence: null,
      },
      platform: over.platform === undefined ? 'greenhouse' : over.platform,
      slug: 'exampleone',
      boardUrl: 'https://boards.example.test/exampleone',
      signature: null,
      routedFrom: null,
      evidence: [],
    },
    status: over.status ?? 'verified',
    reasons: ['name matches'],
    boardName: 'Example One',
    jobsSeen: over.jobsSeen === undefined ? 12 : over.jobsSeen,
  };
}

/** Every table other than `companies`: its name, SQL and rows, hashed, so a later migration must leave them byte-identical. `skip`: tables (with their indexes) or single objects, by name. */
function dumpHash(db: import('better-sqlite3').Database, skip: readonly string[] = []): string {
  const h = createHash('sha256');
  const objs = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  for (const o of objs) {
    if (skip.includes(o.tbl_name) || skip.includes(o.name)) continue;
    h.update(JSON.stringify(o));
    // app_schema's one row is the version counter itself; every other row of every other table must not change.
    if (o.type === 'table' && o.name !== 'app_schema') for (const r of db.prepare(`SELECT * FROM "${o.name}" ORDER BY rowid`).all()) h.update(JSON.stringify(r));
  }
  return h.digest('hex');
}

describe('migration 9: the companies registry', () => {
  it('adds companies to a version-8 DB and leaves every prior table byte-identical', () => {
    const kernel = Store.open(':memory:');
    const db = kernel.db;
    db.exec(`CREATE TABLE IF NOT EXISTS app_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
    db.prepare(`INSERT INTO app_schema (id, version) VALUES (1, 0)`).run();
    for (const [i, m] of APP_MIGRATIONS.slice(0, 8).entries()) {
      if (typeof m === 'string') db.exec(m);
      else {
        db.pragma('foreign_keys = OFF');
        m.run(db);
        db.pragma('foreign_keys = ON');
      }
      db.prepare(`UPDATE app_schema SET version = ?`).run(i + 1);
    }
    db.prepare(`INSERT INTO gigs (gig_key, dedupe_key, platform, source_id, url, title, client, kind, budget, hours, first_seen, last_seen) VALUES ('g1', 'd', 'freelancer', '1', 'https://x.test', 'T', '{}', 'gig', '{}', '{}', 'a', 'a')`).run();
    db.prepare(`INSERT INTO network_status (network_id, status, updated_at) VALUES ('n1', 'todo', 'a')`).run();
    const before = dumpHash(db);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'companies'`).get()).toBeUndefined();
    const s = AppStore.on(kernel);
    expect(APP_MIGRATIONS.length).toBe(19);
    expect(s.schemaVersion()).toBe(19);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'companies'`).get()).toEqual({ name: 'companies' });
    // dashboard-perf migrations 16-19 add indexes only (tests/app/indexes.test.ts): skipped by name, their tables' rows still compared
    expect(dumpHash(db, ['companies', 'coverage_host_state', 'platform_pages', 'job_ats', 'job_board_ids', 'jobs_list', 'events_by_run', 'envelopes_rendered_by_job', 'events_step_done'])).toBe(before);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('has the columns of the brief, in order', () => {
    const s = AppStore.on(Store.open(':memory:'));
    const cols = (s.kernel.db.prepare(`PRAGMA table_info(companies)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      'company_key', 'name', 'website', 'careers_url', 'platform', 'platform_slug', 'board_url', 'status', 'reasons', 'source', 'jobs_seen',
      'last_verified', 'failing_since', 'fail_weeks', 'user_override', 'updated_at', 'coverage_status',
    ]);
  });

  it('freezes its SQL as a literal (no interpolation)', () => {
    expect(typeof APP_MIGRATIONS[8]).toBe('string');
    expect(APP_MIGRATIONS[8]).toContain("CHECK (status IN ('verified', 'proposed', 'rejected', 'failing', 'failed'))");
  });
});

describe('migration 10: coverage host state', () => {
  it('adds coverage_host_state, keeps the earlier SQL, and round-trips a disabled host per run', () => {
    const s = AppStore.on(Store.open(':memory:'));
    expect(s.schemaVersion()).toBe(19);
    const cols = (s.kernel.db.prepare(`PRAGMA table_info(coverage_host_state)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['run_key', 'host', 'reason', 'at']);
    s.disableCoverageHost('coverage-2026-10-13', 'a.test', 'http-429', '2026-10-13T01:00:00.000Z');
    s.disableCoverageHost('coverage-2026-10-13', 'a.test', 'http-403', '2026-10-13T02:00:00.000Z'); // the first reason stays
    s.disableCoverageHost('coverage-2026-10-20', 'b.test', 'challenge', '2026-10-20T01:00:00.000Z');
    expect([...s.coverageHostState('coverage-2026-10-13')]).toEqual([['a.test', 'http-429']]);
    expect([...s.coverageHostState('coverage-2026-10-20')]).toEqual([['b.test', 'challenge']]);
    expect([...s.coverageHostState('coverage-none')]).toEqual([]);
  });
});

describe('the registry methods', () => {
  it('records a verdict and lists it', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertCompanyVerdict(verdict(), AT);
    expect(s.listCompanies()).toEqual([
      {
        companyKey: 'example-one.test', name: 'Example One', website: 'https://example-one.test', careersUrl: 'https://careers.example-one.test/',
        platform: 'greenhouse', platformSlug: 'exampleone', boardUrl: 'https://boards.example.test/exampleone', status: 'verified', reasons: ['name matches'],
        source: 'pick', jobsSeen: 12, lastVerified: AT, failingSince: null, failWeeks: 0, userOverride: null, updatedAt: AT, coverageStatus: 'verified',
      },
    ]);
    expect(s.verifiedCompanies().map((c) => c.companyKey)).toEqual(['example-one.test']);
  });

  it('keeps a proposed or failed verdict out of verifiedCompanies', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertCompanyVerdict(verdict({ key: 'a.test', status: 'proposed' }), AT);
    s.upsertCompanyVerdict(verdict({ key: 'b.test', status: 'failed', platform: null, jobsSeen: null }), AT);
    expect(s.verifiedCompanies()).toEqual([]);
    expect(s.listCompanies({ status: 'proposed' }).map((c) => c.companyKey)).toEqual(['a.test']);
    expect(s.listCompanies({ status: 'failed' }).map((c) => c.companyKey)).toEqual(['b.test']);
  });

  it('user_override rejected survives a later verified verdict, and verifiedCompanies excludes it', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertCompanyVerdict(verdict(), AT);
    s.setCompanyOverride('example-one.test', 'rejected', AT);
    expect(s.listCompanies()[0]).toMatchObject({ status: 'rejected', userOverride: 'rejected' });
    s.upsertCompanyVerdict(verdict({ status: 'verified' }), LATER);
    expect(s.listCompanies()[0]).toMatchObject({ status: 'rejected', userOverride: 'rejected', lastVerified: AT, updatedAt: LATER });
    expect(s.verifiedCompanies()).toEqual([]);
  });

  it('a rejection set before the first verdict also holds', () => {
    const s = AppStore.on(Store.open(':memory:'));
    expect(s.setCompanyOverride('nobody.test', 'rejected', AT)).toBe(false);
    s.upsertCompanyVerdict(verdict({ status: 'proposed' }), AT);
    s.setCompanyOverride('example-one.test', 'rejected', AT);
    s.upsertCompanyVerdict(verdict({ status: 'verified' }), LATER);
    expect(s.verifiedCompanies()).toEqual([]);
  });

  it('an approved override makes a proposed company verified, and clearing a rejection returns it to proposed', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertCompanyVerdict(verdict({ status: 'proposed' }), AT);
    s.setCompanyOverride('example-one.test', 'approved', AT);
    expect(s.verifiedCompanies().map((c) => c.companyKey)).toEqual(['example-one.test']);
    s.upsertCompanyVerdict(verdict({ status: 'proposed' }), LATER);
    expect(s.listCompanies()[0]).toMatchObject({ status: 'verified', userOverride: 'approved' });
    s.setCompanyOverride('example-one.test', 'rejected', LATER);
    s.setCompanyOverride('example-one.test', null, LATER);
    expect(s.listCompanies()[0]).toMatchObject({ status: 'proposed', userOverride: null });
  });

  it('a verified company becomes failing after 3 failed weeks, never silently removed, and recovers', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertCompanyVerdict(verdict(), '2026-10-13T00:00:00.000Z');
    const fail = verdict({ status: 'failed', jobsSeen: null });
    s.upsertCompanyVerdict(fail, '2026-10-20T00:00:00.000Z');
    s.upsertCompanyVerdict(fail, '2026-10-27T00:00:00.000Z');
    expect(s.listCompanies()[0]).toMatchObject({ status: 'verified', failWeeks: 2, failingSince: '2026-10-20T00:00:00.000Z' });
    s.upsertCompanyVerdict(fail, '2026-11-03T00:00:00.000Z');
    expect(s.listCompanies()[0]).toMatchObject({ status: 'failing', failWeeks: 3, failingSince: '2026-10-20T00:00:00.000Z', lastVerified: '2026-10-13T00:00:00.000Z' });
    expect(s.verifiedCompanies().map((c) => c.status)).toEqual(['failing']);
    s.upsertCompanyVerdict(verdict(), '2026-11-10T00:00:00.000Z');
    expect(s.listCompanies()[0]).toMatchObject({ status: 'verified', failWeeks: 0, failingSince: null });
  });
});

describe('companies.yaml', () => {
  it('the fixture lists 3 picks', () => {
    const { companies } = loadPack(FIXTURE);
    expect(companies.map((c) => c.name)).toEqual(['Example Workday Co', 'Example Eightfold Co', 'Example Greenhouse Co']);
  });

  it('absent gives no companies and leaves both pack hashes as they were', () => {
    const d = copyPack();
    const withFile = loadPack(d);
    rmSync(join(d, 'companies.yaml'));
    const without = loadPack(d);
    expect(without.companies).toEqual([]);
    expect(without.hash).toBe(withFile.hash);
    expect(without.freelancePackHash).toBe(withFile.freelancePackHash);
    expect(without.companiesHash).not.toBe(withFile.companiesHash);
  });

  it('editing it changes only companiesHash', () => {
    const d = copyPack();
    const before = loadPack(d);
    writeFileSync(join(d, 'companies.yaml'), `${readFileSync(join(d, 'companies.yaml'), 'utf8')}  - {name: Another Co}\n`);
    const after = loadPack(d);
    expect(after.companies.length).toBe(4);
    expect(after.hash).toBe(before.hash);
    expect(after.freelancePackHash).toBe(before.freelancePackHash);
    expect(after.companiesHash).not.toBe(before.companiesHash);
  });

  it('a bad file is refused when strict and ignored with a redacted warning when daily', () => {
    const d = copyPack();
    writeFileSync(join(d, 'companies.yaml'), 'companies:\n  - {website: https://x.test}\n');
    expect(() => loadPack(d, {}, { asOf: '2026-10' })).toThrow(PackError);
    expect(() => loadPack(d, {}, { asOf: '2026-10' })).toThrow(/companies\.yaml/);
    const daily = loadPack(d, {}, { asOf: '2026-10', mode: 'daily' });
    expect(daily.companies).toEqual([]);
    expect(daily.hash).toBe(loadPack(FIXTURE, {}, { asOf: '2026-10' }).hash);
    expect(daily.warnings.join('\n')).toMatch(/companies\.yaml.*the daily run ignores this file/);
  });

  it('is scanned for forbidden terms and unprintable glyphs, naming the file and path but never the text', () => {
    const d = copyPack();
    const naming = readFileSync(join(d, 'naming.yaml'), 'utf8');
    expect(naming).toMatch(/forbiddenTerms/);
    const term = (loadPack(d).pack.naming.forbiddenTerms[0] ?? '') as string;
    expect(term).not.toBe('');
    writeFileSync(join(d, 'companies.yaml'), `companies:\n  - {name: "Acme ${term} → Co"}\n`);
    const loaded = loadPack(d);
    const problems = packTextProblems({ ...loaded.pack, companies: loaded.companies });
    expect(problems.some((p) => p.startsWith('companies.yaml: companies[0].name holds forbidden term #'))).toBe(true);
    expect(problems.some((p) => p.includes('U+2192') && p.includes('companies.yaml: companies[0].name'))).toBe(true);
    expect(problems.join('\n')).not.toContain(term);
    expect(() => loadRunPack(d, {}, '2026-10', undefined, 'strict')).toThrow(/text problem/);
    expect(loadRunPack(d, {}, '2026-10', undefined, 'daily').companies).toEqual([]);
  });
});

describe('migration 15: coverage_status (Task 11 fix round 1)', () => {
  it('backfills rows no override touched; leaves overridden rows and dashboard-added picks NULL', () => {
    const kernel = Store.open(':memory:');
    const db = kernel.db;
    db.exec(`CREATE TABLE IF NOT EXISTS app_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
    db.prepare(`INSERT INTO app_schema (id, version) VALUES (1, 0)`).run();
    for (const [i, m] of APP_MIGRATIONS.slice(0, 14).entries()) {
      if (typeof m === 'string') db.exec(m);
      else {
        db.pragma('foreign_keys = OFF');
        m.run(db);
        db.pragma('foreign_keys = ON');
      }
      db.prepare(`UPDATE app_schema SET version = ?`).run(i + 1);
    }
    const ins = db.prepare(`INSERT INTO companies (company_key, name, website, status, reasons, source, user_override, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'a')`);
    ins.run('v.test', 'V', 'https://v.test', 'verified', '[]', 'yc', null);
    ins.run('a.test', 'A', 'https://a.test', 'verified', '[]', 'yc', 'approved');
    ins.run('r.test', 'R', 'https://r.test', 'rejected', '[]', 'yc', 'rejected');
    ins.run('p.test', 'P', 'https://p.test', 'proposed', '["added by you, resolves on the next coverage run"]', 'pick', null);
    const s = AppStore.on(kernel);
    expect(s.schemaVersion()).toBe(19);
    expect(Object.fromEntries(s.listCompanies().map((c) => [c.companyKey, c.coverageStatus]))).toEqual({ 'a.test': null, 'p.test': null, 'r.test': null, 'v.test': 'verified' });
  });
});
