import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppStore, type JobUpsert } from '../../src/app/store/app-store.js';
import { AT, jobRow, LATER } from '../support/app-fixtures.js';
import { APP_MIGRATIONS } from '../../src/app/store/schema.js';
import { Store } from '../../src/kernel/store/store.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('AppStore schema', () => {
  it('migrates beside the kernel without touching kernel tables or its schema version', () => {
    const k = Store.open(':memory:');
    const kernelTables = k.db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all();
    const app = AppStore.on(k);
    expect(k.db.pragma('user_version', { simple: true })).toBe(1);
    expect(app.schemaVersion()).toBe(APP_MIGRATIONS.length);
    const after = k.db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all() as { name: string; sql: string }[];
    for (const t of kernelTables) expect(after).toContainEqual(t);
    const names = after.map((t) => t.name);
    for (const t of ['jobs', 'job_sources', 'job_docs', 'status_history', 'fact_overrides', 'runs_summary']) expect(names).toContain(t);
  });

  it('is idempotent across reopen of the same file, and refuses a newer app schema', () => {
    const d = mkdtempSync(join(tmpdir(), 'jp-app-'));
    tmp.push(d);
    const path = join(d, 'jobpilot.db');
    const a = AppStore.open(path);
    a.upsertJob(jobRow());
    a.close();
    const b = AppStore.open(path);
    expect(b.getJob('0123456789abcdef')?.company).toBe('Acme Robotics');
    b.kernel.db.prepare(`UPDATE app_schema SET version = 99`).run();
    b.close();
    expect(() => AppStore.open(path)).toThrow(/newer/);
  });
});

describe('AppStore.upsertJob', () => {
  it('inserts a new job with status new, an empty note, first_seen and last_seen', () => {
    const s = AppStore.on(Store.open(':memory:'));
    expect(s.upsertJob(jobRow())).toEqual({ jobKey: '0123456789abcdef', inserted: true });
    const j = s.getJob('0123456789abcdef');
    expect(j).toMatchObject({ status: 'new', note: '', firstSeen: AT, lastSeen: AT, score: 70, docsState: 'none' });
    expect(j?.sources).toEqual([{ source: 'greenhouse', sourceId: '1001' }]);
  });

  it('keeps the user status and note, updates run-owned columns and last_seen, keeps first_seen', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    s.setStatus('0123456789abcdef', 'applied', 'user', AT);
    s.setNote('0123456789abcdef', 'spoke to the recruiter');
    expect(s.upsertJob(jobRow({ title: 'Staff Backend Engineer', score: 81, at: LATER }))).toEqual({ jobKey: '0123456789abcdef', inserted: false });
    expect(s.getJob('0123456789abcdef')).toMatchObject({
      status: 'applied',
      note: 'spoke to the recruiter',
      title: 'Staff Backend Engineer',
      score: 81,
      firstSeen: AT,
      lastSeen: LATER,
    });
  });

  it('a re-emitted (source, sourceId) is a newer version of the same row, even under another job key', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    // A retitled career page re-emits the same sourceId; its normalised key differs.
    const r = s.upsertJob(jobRow({ jobKey: 'fedcba9876543210', title: 'Principal Engineer', at: LATER }));
    expect(r).toEqual({ jobKey: '0123456789abcdef', inserted: false });
    expect(s.listJobs({ band: ['disclosed', 'undisclosed', 'review', 'rejected', 'below-floor'] })).toHaveLength(1);
    expect(s.getJob('0123456789abcdef')?.title).toBe('Principal Engineer');
    expect(s.getJob('fedcba9876543210')).toBeUndefined();
  });

  it('dedupes by job key across sources and attaches every source', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    s.upsertJob(jobRow({ source: 'himalayas', sourceId: 'https://himalayas.example.test/j/1' }));
    expect(s.getJob('0123456789abcdef')?.sources).toEqual([
      { source: 'greenhouse', sourceId: '1001' },
      { source: 'himalayas', sourceId: 'https://himalayas.example.test/j/1' },
    ]);
  });
});

describe('AppStore status, note, docs, overrides and runs', () => {
  it('records every status change with from, to, at and by; an unchanged status records nothing', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    expect(s.setStatus('0123456789abcdef', 'approved', 'user', AT)).toBe(true);
    expect(s.setStatus('0123456789abcdef', 'approved', 'user', AT)).toBe(false);
    s.setStatus('0123456789abcdef', 'new', 'user', LATER);
    expect(s.getJob('0123456789abcdef')?.history).toEqual([
      { from: 'new', to: 'approved', at: AT, by: 'user' },
      { from: 'approved', to: 'new', at: LATER, by: 'user' },
    ]);
  });

  it('refuses an unknown status and an unknown job', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    expect(() => s.setStatus('0123456789abcdef', 'hired' as never, 'user', AT)).toThrow(/status/);
    expect(() => s.setStatus('ffffffffffffffff', 'applied', 'user', AT)).toThrow(/unknown job/);
    expect(() => s.setNote('ffffffffffffffff', 'x')).toThrow(/unknown job/);
  });

  it('putDocs replaces the documents of a job', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow());
    const doc = { kind: 'resume' as const, format: 'pdf' as const, path: '0123456789abcdef/resume.pdf', sha256: 'a'.repeat(64), pages: 2, qaOk: true };
    s.putDocs('0123456789abcdef', [doc, { ...doc, format: 'docx', path: '0123456789abcdef/resume.docx', pages: null }]);
    s.putDocs('0123456789abcdef', [doc]);
    expect(s.getJob('0123456789abcdef')?.docs).toEqual([doc]);
  });

  it('stores fact overrides, validated, latest wins', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.setFactOverride('f-1', 'rejected', AT);
    s.setFactOverride('f-1', 'verified', LATER);
    s.setFactOverride('f-0', 'user-cannot-confirm', AT);
    expect(s.factOverrides()).toEqual({ 'f-0': 'user-cannot-confirm', 'f-1': 'verified' });
    expect(() => s.setFactOverride('f-2', 'maybe' as never, AT)).toThrow(/status/);
  });

  it('records runs and lists the latest n, newest first', () => {
    const s = AppStore.on(Store.open(':memory:'));
    for (const d of ['07', '09', '08']) {
      s.recordRun({ runId: `daily-2026-10-${d}`, at: `2026-10-${d}T01:30:00.000Z`, counts: { jobs: Number(d) }, packHash: 'p', policyHash: 'q' });
    }
    s.recordRun({ runId: 'daily-2026-10-09', at: '2026-10-09T01:30:00.000Z', counts: { jobs: 10 }, packHash: 'p', policyHash: 'q' });
    expect(s.listRuns(2)).toEqual([
      { runId: 'daily-2026-10-09', at: '2026-10-09T01:30:00.000Z', counts: { jobs: 10 }, packHash: 'p', policyHash: 'q' },
      { runId: 'daily-2026-10-08', at: '2026-10-08T01:30:00.000Z', counts: { jobs: 8 }, packHash: 'p', policyHash: 'q' },
    ]);
  });
});

describe('AppStore.listJobs comp-first sort (spec §7)', () => {
  const k = (n: number) => n.toString(16).padStart(16, '0');
  function seed(): AppStore {
    const s = AppStore.on(Store.open(':memory:'));
    const rows: Partial<JobUpsert>[] = [
      { jobKey: k(1), sourceId: '1', compMinInr: 5_000_000, compMaxInr: 7_000_000, compBasis: 'base', score: 50 },
      { jobKey: k(2), sourceId: '2', compMinInr: null, compMaxInr: 9_000_000, compBasis: 'base', score: 40 },
      { jobKey: k(3), sourceId: '3', compMaxInr: 7_000_000, compBasis: 'base', score: 90 },
      { jobKey: k(4), sourceId: '4', score: 95 },
      { jobKey: k(5), sourceId: '5', score: 95, at: LATER },
      { jobKey: k(6), sourceId: '6', score: 80 },
      { jobKey: k(7), sourceId: '7', verdict: 'review', compMaxInr: 20_000_000, score: 99 },
      { jobKey: k(8), sourceId: '8', verdict: 'review', score: 60 },
      { jobKey: k(9), sourceId: '9', verdict: 'rejected', reasons: ['onsite'], score: null },
      { jobKey: k(10), sourceId: '10', score: 30, docsState: 'below-floor' },
      { jobKey: k(11), sourceId: '11', compMaxInr: 3_000_000, compBasis: 'base', score: 99 },
      { jobKey: k(12), sourceId: '12', score: 95 },
    ];
    for (const r of rows) s.upsertJob(jobRow(r));
    return s;
  }

  it('orders disclosed (by max INR desc), then undisclosed, then review, each by score, first_seen desc, job key', () => {
    const s = seed();
    // k(11) is disclosed but under the 12 L floor: below-floor, hidden by default.
    expect(s.listJobs({ floorInr: 1_200_000 }).map((j) => j.jobKey)).toEqual([k(2), k(3), k(1), k(5), k(4), k(12), k(6), k(7), k(8)]);
    expect(s.listJobs({ floorInr: 1_200_000 }).map((j) => j.band)).toEqual([
      'disclosed', 'disclosed', 'disclosed', 'undisclosed', 'undisclosed', 'undisclosed', 'undisclosed', 'review', 'review',
    ]);
  });

  it('without a floor every disclosed comp counts as disclosed', () => {
    expect(seed().listJobs({}).map((j) => j.jobKey).slice(0, 4)).toEqual([k(2), k(3), k(1), k(11)]);
  });

  it('lists rejected and below-floor jobs only when filtered for', () => {
    const s = seed();
    expect(s.listJobs({ floorInr: 1_200_000, band: ['rejected'] }).map((j) => j.jobKey)).toEqual([k(9)]);
    expect(s.listJobs({ floorInr: 1_200_000, band: ['below-floor'] }).map((j) => j.jobKey)).toEqual([k(11), k(10)]);
  });

  it('filters by status, minimum score and text', () => {
    const s = seed();
    s.setStatus(k(6), 'applied', 'user', AT);
    s.upsertJob(jobRow({ jobKey: k(13), sourceId: '13', company: 'Globex Systems', title: 'Platform Engineer', score: 70 }));
    expect(s.listJobs({ status: ['applied'] }).map((j) => j.jobKey)).toEqual([k(6)]);
    expect(s.listJobs({ minScore: 95, floorInr: 1_200_000 }).map((j) => j.jobKey)).toEqual([k(5), k(4), k(12), k(7)]);
    expect(s.listJobs({ text: 'globex' }).map((j) => j.jobKey)).toEqual([k(13)]);
    expect(s.listJobs({ text: '100%_' })).toEqual([]);
  });
});
