import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDesk, NOTE_REMOVED } from '../../src/app/migrate-desk.js';
import { loadPack } from '../../src/app/pack/load.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { jobKey } from '../../src/app/text/norm.js';
import { Store } from '../../src/kernel/store/store.js';
import { jobRow } from '../support/app-fixtures.js';

const DESK = resolve(import.meta.dirname, '../fixtures/desk');
const PACK = resolve(import.meta.dirname, '../fixtures/pack');
const naming = loadPack(PACK).pack.naming;
const opts = { naming };
const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ghKey = jobKey('Acme Robotics', 'Senior Backend Engineer', 'Remote - India');

describe('migrateDesk', () => {
  it('imports every row with its status, note, applied_at, source id and a migration history entry', () => {
    const app = AppStore.on(Store.open(':memory:'));
    const r = migrateDesk(DESK, app, opts);
    expect(r).toMatchObject({
      read: 7,
      inserted: 6,
      attached: 0,
      alreadyPresent: 0,
      notesSanitised: 1,
      whyRemoved: 1,
      skipped: [{ file: 'zz-1.json', reason: 'unknown id prefix zz-' }],
      byStatus: { applied: 1, approved: 1, interview: 1, new: 2, skipped: 1 },
      bySource: { ashby: 1, greenhouse: 1, lever: 1, linkedin: 1, naukri: 1, wellfound: 1 },
    });
    const gh = app.getJob(ghKey);
    expect(gh).toMatchObject({
      company: 'Acme Robotics',
      ats: 'greenhouse',
      status: 'applied',
      note: 'Referred by a former colleague',
      appliedAt: '2026-08-25T04:30:00.000Z',
      firstSeen: '2026-08-21T03:45:00.000Z',
      postedAt: '2026-08-20',
      score: 82,
      verdict: null,
      docsState: 'none',
      notes: ['Java, distributed systems, remote India'],
    });
    expect(gh?.sources).toEqual([{ source: 'greenhouse', sourceId: '4400001' }]);
    expect(gh?.history).toEqual([{ from: null, to: 'applied', at: '2026-08-25T04:30:00.000Z', by: 'migration' }]);

    const lv = app.getJob(jobKey('Umbrella Health', 'Backend Engineer', 'Bengaluru, India'));
    expect(lv).toMatchObject({ status: 'approved', appliedAt: null, ats: 'lever' });
    expect(lv?.sources).toEqual([{ source: 'lever', sourceId: '8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' }]);
  });

  it('replaces a note holding a forbidden term and drops such a why, case-insensitively', () => {
    const app = AppStore.on(Store.open(':memory:'));
    migrateDesk(DESK, app, opts);
    expect(app.getJob(jobKey('Hooli Labs', 'Lead Engineer', 'Remote'))?.note).toBe(NOTE_REMOVED);
    expect(NOTE_REMOVED).toBe('[note removed: contained a forbidden term]');
    expect(app.getJob(jobKey('Globex Systems', 'Staff Platform Engineer', 'India (Remote)'))?.notes).toEqual([]);
  });

  it('is idempotent', () => {
    const app = AppStore.on(Store.open(':memory:'));
    migrateDesk(DESK, app, opts);
    const before = JSON.stringify(app.listJobs({ band: ['disclosed', 'undisclosed', 'review', 'rejected', 'below-floor'] }).map((j) => app.getJob(j.jobKey)));
    expect(migrateDesk(DESK, app, opts)).toMatchObject({ read: 7, inserted: 0, attached: 0, alreadyPresent: 6 });
    const after = JSON.stringify(app.listJobs({ band: ['disclosed', 'undisclosed', 'review', 'rejected', 'below-floor'] }).map((j) => app.getJob(j.jobKey)));
    expect(after).toBe(before);
  });

  it('a later run re-finding a Desk posting attaches to the Desk row through job_sources', () => {
    const app = AppStore.on(Store.open(':memory:'));
    migrateDesk(DESK, app, opts);
    // The normaliser's key for the posting differs (the API spells the location differently).
    const r = app.upsertJob(jobRow({ jobKey: 'abcdefabcdef0001', source: 'greenhouse', sourceId: '4400001', score: 77, verdict: 'eligible', at: '2026-10-09T01:30:00.000Z' }));
    expect(r).toEqual({ jobKey: ghKey, inserted: false });
    expect(app.getJob(ghKey)).toMatchObject({ status: 'applied', note: 'Referred by a former colleague', score: 77, verdict: 'eligible', lastSeen: '2026-10-09T01:30:00.000Z' });
  });

  it('attaches to a job a run already found, adopting the Desk status when the user never set one', () => {
    const app = AppStore.on(Store.open(':memory:'));
    app.upsertJob(jobRow({ jobKey: ghKey, source: 'greenhouse', sourceId: 'other-id' }));
    expect(migrateDesk(DESK, app, opts)).toMatchObject({ inserted: 5, attached: 1 });
    expect(app.getJob(ghKey)?.sources.map((s) => s.sourceId)).toEqual(['4400001', 'other-id']);
    expect(app.getJob(ghKey)).toMatchObject({ status: 'applied', note: 'Referred by a former colleague', company: 'Acme Robotics', score: 70 });
  });

  it('merges Desk rows that share a job key: the furthest status wins, notes join, every source attaches', () => {
    const d = mkdtempSync(join(tmpdir(), 'jp-desk-'));
    tmp.push(d);
    cpSync(DESK, d, { recursive: true });
    const base = { company: 'Acme Robotics', title: 'Senior Backend Engineer', location: 'Remote - India', url: 'https://example.test/j', source: 'Greenhouse', score: 70, why: '', posted: '2026-08-20' };
    // Same job, two more requisitions: one skipped with a note, one new with no note.
    writeFileSync(join(d, 'jobs', 'gh-4400002.json'), JSON.stringify({ ...base, found_at: '2026-08-22T09:00:00+05:30', status: 'skipped', note: 'Duplicate req' }));
    writeFileSync(join(d, 'jobs', 'gh-4400003.json'), JSON.stringify({ ...base, found_at: '2026-08-23T09:00:00+05:30', status: 'new', note: '' }));
    const app = AppStore.on(Store.open(':memory:'));
    const r = migrateDesk(d, app, opts);
    expect(r).toMatchObject({ read: 9, inserted: 6, merged: 2, statusConflicts: 2 });
    expect(r.byStatus).toEqual({ applied: 1, approved: 1, interview: 1, new: 3, skipped: 2 });
    const gh = app.getJob(ghKey);
    expect(gh).toMatchObject({ status: 'applied', note: 'Referred by a former colleague | Duplicate req' });
    expect(gh?.sources.map((s) => s.sourceId)).toEqual(['4400001', '4400002', '4400003']);
    expect(gh?.history).toHaveLength(1);
    expect(migrateDesk(d, app, opts)).toMatchObject({ inserted: 0, merged: 0, alreadyPresent: 8 });
    expect(app.getJob(ghKey)?.note).toBe('Referred by a former colleague | Duplicate req');
  });

  it('never overrides a status the user set on the dashboard', () => {
    const app = AppStore.on(Store.open(':memory:'));
    app.upsertJob(jobRow({ jobKey: ghKey, source: 'greenhouse', sourceId: 'other-id' }));
    app.setStatus(ghKey, 'skipped', 'user', '2026-10-01T00:00:00.000Z');
    app.setNote(ghKey, 'not for me');
    migrateDesk(DESK, app, opts);
    expect(app.getJob(ghKey)).toMatchObject({ status: 'skipped', note: 'not for me' });
    expect(app.getJob(ghKey)?.sources.map((s) => s.sourceId)).toEqual(['4400001', 'other-id']);
  });

  it('reports unreadable files and a missing jobs directory', () => {
    const d = mkdtempSync(join(tmpdir(), 'jp-desk-'));
    tmp.push(d);
    cpSync(DESK, d, { recursive: true });
    writeFileSync(join(d, 'jobs', 'gh-9.json'), '{ not json');
    writeFileSync(join(d, 'jobs', 'gh-10.json'), JSON.stringify({ company: 'X' }));
    const r = migrateDesk(d, AppStore.on(Store.open(':memory:')), opts);
    expect(r.skipped.map((s) => s.file)).toEqual(['gh-10.json', 'gh-9.json', 'zz-1.json']);
    expect(r.skipped[0]?.reason).toMatch(/company|title/);
    expect(r.skipped[1]?.reason).toMatch(/JSON/);
    expect(() => migrateDesk(join(d, 'missing'), AppStore.on(Store.open(':memory:')), opts)).toThrow(/jobs/);
  });
});
