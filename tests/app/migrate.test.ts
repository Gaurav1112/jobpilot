import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDesk, NOTE_REMOVED, REDACTED } from '../../src/app/migrate-desk.js';
import { loadPack } from '../../src/app/pack/load.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { dedupeKey, jobKey } from '../../src/app/text/norm.js';
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
const ALL = { band: ['disclosed', 'undisclosed', 'review', 'rejected', 'below-floor'] as const, duplicates: true };

const ghKey = jobKey('greenhouse', '4400001');
const ghDedupe = dedupeKey('Acme Robotics', 'Senior Backend Engineer', 'Remote - India');

function deskCopy(extra: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), 'jp-desk-'));
  tmp.push(d);
  cpSync(DESK, d, { recursive: true });
  for (const [f, row] of Object.entries(extra)) writeFileSync(join(d, 'jobs', f), typeof row === 'string' ? row : JSON.stringify(row));
  return d;
}
const acme = { company: 'Acme Robotics', title: 'Senior Backend Engineer', location: 'Remote - India', url: 'https://example.test/j', score: 70, why: '', posted: '2026-08-20' };

describe('migrateDesk', () => {
  it('imports every row as its own job keyed by source id, with status, note, applied_at and a migration history entry', () => {
    const app = AppStore.on(Store.open(':memory:'));
    const r = migrateDesk(DESK, app, opts);
    expect(r).toMatchObject({
      read: 7,
      inserted: 6,
      attached: 0,
      duplicates: 0,
      alreadyPresent: 0,
      notesSanitised: 1,
      whyRemoved: 1,
      skipped: [{ file: 'zz-1.json', reason: 'unknown id prefix zz-' }],
      byStatus: { applied: 1, approved: 1, interview: 1, new: 2, skipped: 1 },
      bySource: { ashby: 1, greenhouse: 1, lever: 1, linkedin: 1, naukri: 1, wellfound: 1 },
    });
    const gh = app.getJob(ghKey);
    expect(gh).toMatchObject({
      source: 'greenhouse',
      sourceId: '4400001',
      dedupeKey: ghDedupe,
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

    const lv = app.getJob(jobKey('lever', '8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'));
    expect(lv).toMatchObject({ status: 'approved', appliedAt: null, ats: 'lever', company: 'Umbrella Health' });
  });

  it('replaces a note holding a forbidden term and drops such a why, case-insensitively', () => {
    const app = AppStore.on(Store.open(':memory:'));
    migrateDesk(DESK, app, opts);
    expect(app.getJob(jobKey('wellfound', '770001'))?.note).toBe(NOTE_REMOVED);
    expect(NOTE_REMOVED).toBe('[note removed: contained a forbidden term]');
    expect(app.getJob(jobKey('ashby', '3f2a9c1e-0b4d-4c7a-9e21-5d6f7a8b9c0d'))?.notes).toEqual([]);
  });

  it('is idempotent', () => {
    const app = AppStore.on(Store.open(':memory:'));
    migrateDesk(DESK, app, opts);
    const snap = () => JSON.stringify(app.listJobs(ALL).map((j) => app.getJob(j.jobKey)));
    const before = snap();
    expect(migrateDesk(DESK, app, opts)).toMatchObject({ read: 7, inserted: 0, attached: 0, alreadyPresent: 6 });
    expect(snap()).toBe(before);
  });

  it('keeps several same-source requisitions of one title as separate jobs', () => {
    const d = deskCopy({
      'gh-4400002.json': { ...acme, source: 'Greenhouse', found_at: '2026-08-22T09:00:00+05:30', status: 'skipped', note: 'Second req' },
      'gh-4400003.json': { ...acme, source: 'Greenhouse', found_at: '2026-08-23T09:00:00+05:30', status: 'new', note: '' },
    });
    const app = AppStore.on(Store.open(':memory:'));
    expect(migrateDesk(d, app, opts)).toMatchObject({ read: 9, inserted: 8, duplicates: 0 });
    expect(['4400001', '4400002', '4400003'].map((id) => [app.getJob(jobKey('greenhouse', id))?.status, app.getJob(jobKey('greenhouse', id))?.duplicateOf])).toEqual([
      ['applied', null],
      ['skipped', null],
      ['new', null],
    ]);
  });

  it('links a cross-source listing of the same job to the ATS row; the group shows the furthest status and both notes', () => {
    const d = deskCopy({ 'wf-990001.json': { ...acme, source: 'Wellfound', found_at: '2026-08-01T09:00:00+05:30', status: 'approved', note: 'Seen on the board first' } });
    const app = AppStore.on(Store.open(':memory:'));
    expect(migrateDesk(d, app, opts)).toMatchObject({ inserted: 7, duplicates: 1 });
    const wf = jobKey('wellfound', '990001');
    expect(app.getJob(wf)).toMatchObject({ duplicateOf: ghKey, status: 'applied' });
    expect(app.getJob(ghKey)).toMatchObject({ duplicateOf: null, alsoListedOn: ['wellfound'], status: 'applied', note: 'Referred by a former colleague | Seen on the board first' });
    expect(app.listJobs().map((j) => j.jobKey)).not.toContain(wf);
  });

  it('a later run re-finding a Desk posting upserts the same row and keeps the Desk status', () => {
    const app = AppStore.on(Store.open(':memory:'));
    migrateDesk(DESK, app, opts);
    const r = app.upsertJob(jobRow({ jobKey: ghKey, dedupeKey: ghDedupe, source: 'greenhouse', sourceId: '4400001', score: 77, verdict: 'eligible', at: '2026-10-09T01:30:00.000Z' }));
    expect(r).toEqual({ jobKey: ghKey, inserted: false, stale: false });
    expect(app.getJob(ghKey)).toMatchObject({ status: 'applied', note: 'Referred by a former colleague', score: 77, verdict: 'eligible', lastSeen: '2026-10-09T01:30:00.000Z', firstSeen: '2026-08-21T03:45:00.000Z' });
  });

  it('gives a posting a run found first the Desk status when the user never set one', () => {
    const app = AppStore.on(Store.open(':memory:'));
    app.upsertJob(jobRow({ jobKey: ghKey, dedupeKey: ghDedupe, source: 'greenhouse', sourceId: '4400001' }));
    expect(migrateDesk(DESK, app, opts)).toMatchObject({ inserted: 5, attached: 1 });
    expect(app.getJob(ghKey)).toMatchObject({ status: 'applied', note: 'Referred by a former colleague', company: 'Acme Robotics', score: 70 });
    expect(app.getJob(ghKey)?.history).toEqual([{ from: 'new', to: 'applied', at: '2026-08-25T04:30:00.000Z', by: 'migration' }]);
  });

  it('never overrides a status the user set on the dashboard', () => {
    const app = AppStore.on(Store.open(':memory:'));
    app.upsertJob(jobRow({ jobKey: ghKey, dedupeKey: ghDedupe, source: 'greenhouse', sourceId: '4400001' }));
    app.setStatus(ghKey, 'skipped', 'user', '2026-10-01T00:00:00.000Z');
    app.setNote(ghKey, 'not for me');
    expect(migrateDesk(DESK, app, opts)).toMatchObject({ alreadyPresent: 1 });
    expect(app.getJob(ghKey)).toMatchObject({ status: 'skipped', note: 'not for me' });
  });

  it('refuses a row whose company or title holds a forbidden term, even as a confusable, and redacts a location or url (fix round 2)', () => {
    const d = deskCopy({
      'gh-5500001.json': { ...acme, company: '\u0130nitech Labs', source: 'Greenhouse', found_at: '2026-09-01T09:00:00+05:30', status: 'new', note: '' },
      'gh-5500002.json': { ...acme, title: 'Engineer, \u0406nitech platform', source: 'Greenhouse', found_at: '2026-09-01T09:00:00+05:30', status: 'new', note: '' },
      'gh-5500003.json': { ...acme, title: 'Platform Engineer', location: 'Initech campus, Pune', url: 'https://example.test/initech/jobs/3', source: 'Greenhouse', found_at: '2026-09-01T09:00:00+05:30', status: 'new', note: '' },
      'ih-77001.json': { ...acme, title: 'SDE 3', source: 'Instahyre', found_at: '2026-09-02T09:00:00+05:30', status: 'new', note: '' },
    });
    const app = AppStore.on(Store.open(':memory:'));
    const r = migrateDesk(d, app, opts);
    expect(r).toMatchObject({ read: 11, inserted: 8, refused: 2, locationsRedacted: 1, urlsRedacted: 1 });
    expect(r.skipped.filter((x) => x.reason === 'company or title contains a forbidden term').map((x) => x.file)).toEqual(['gh-5500001.json', 'gh-5500002.json']);
    expect(app.getJob(jobKey('greenhouse', '5500001'))).toBeUndefined();
    const redacted = app.getJob(jobKey('greenhouse', '5500003'));
    expect(redacted).toMatchObject({ location: REDACTED, url: REDACTED, dedupeKey: dedupeKey('Acme Robotics', 'Platform Engineer', REDACTED) });
    expect(app.getJob(jobKey('instahyre', '77001'))).toMatchObject({ source: 'instahyre', ats: 'instahyre' });
  });

  it('reports unreadable files and a missing jobs directory', () => {
    const d = deskCopy({ 'gh-9.json': '{ not json', 'gh-10.json': { company: 'X' } });
    const r = migrateDesk(d, AppStore.on(Store.open(':memory:')), opts);
    expect(r.skipped.map((s) => s.file)).toEqual(['gh-10.json', 'gh-9.json', 'zz-1.json']);
    expect(r.skipped[0]?.reason).toMatch(/company|title/);
    expect(r.skipped[1]?.reason).toMatch(/JSON/);
    expect(() => migrateDesk(join(d, 'missing'), AppStore.on(Store.open(':memory:')), opts)).toThrow(/jobs/);
  });
});
