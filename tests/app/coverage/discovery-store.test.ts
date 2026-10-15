import { describe, expect, it } from 'vitest';
import { APP_MIGRATIONS } from '../../../src/app/store/schema.js';
import { AppStore, type FreehireLeadIn } from '../../../src/app/store/app-store.js';
import { Store } from '../../../src/kernel/store/store.js';

const lead = (k: string, o: Partial<FreehireLeadIn> = {}): FreehireLeadIn => ({ leadKey: k, source: 'remotedotcom', url: `https://remote.example/${k}`, title: 'Senior Backend Engineer', company: 'Example Labs', location: 'India', postedAt: '2026-10-13', evidence: 'india', queryId: 'q3', ...o });

describe('migration 24: freehire_leads (sources-x Task 8)', () => {
  it('is the last migration, a literal, and creates the table and its index', () => {
    expect(typeof APP_MIGRATIONS[23]).toBe('string');
    const s = AppStore.on(Store.open(':memory:'));
    expect(s.schemaVersion()).toBe(APP_MIGRATIONS.length);
    const cols = (s.kernel.db.prepare(`PRAGMA table_info(freehire_leads)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['lead_key', 'source', 'url', 'title', 'company', 'location', 'posted_at', 'evidence', 'first_week', 'last_week', 'query_id']);
    const idx = s.kernel.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'freehire_leads_by_week'`).all();
    expect(idx).toHaveLength(1);
  });

  it('refuses an evidence other than india or worldwide', () => {
    const s = AppStore.on(Store.open(':memory:'));
    expect(() => s.kernel.db.prepare(`INSERT INTO freehire_leads VALUES ('k', 's', 'u', 't', NULL, NULL, NULL, 'llm', 'w', 'w', 'q3')`).run()).toThrow(/CHECK/);
  });
});

describe('AppStore.recordFreehireLeads / freehireLeads', () => {
  it('upserts by lead key: the first week is kept, everything else comes from the latest finding', () => {
    const s = AppStore.on(Store.open(':memory:'));
    expect(s.recordFreehireLeads('2026-10-11', [lead('b'), lead('a')], 't1')).toBe(2);
    expect(s.recordFreehireLeads('2026-10-18', [lead('a', { title: 'Staff Engineer', postedAt: null, queryId: 'q5', evidence: 'worldwide' })], 't2')).toBe(0);
    expect(s.freehireLeads('2026-10-11')).toEqual([
      { ...lead('a', { title: 'Staff Engineer', postedAt: null, queryId: 'q5', evidence: 'worldwide' }), firstWeek: '2026-10-11', lastWeek: '2026-10-18' },
      { ...lead('b'), firstWeek: '2026-10-11', lastWeek: '2026-10-11' },
    ]);
  });

  it('freehireLeads(sinceWeek) returns the leads last seen in that week or later, ordered by key', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.recordFreehireLeads('2026-10-11', [lead('old')], 't');
    s.recordFreehireLeads('2026-10-18', [lead('z'), lead('m')], 't');
    expect(s.freehireLeads('2026-10-18').map((l) => l.leadKey)).toEqual(['m', 'z']);
    expect(s.freehireLeads('2026-10-11').map((l) => l.leadKey)).toEqual(['m', 'old', 'z']);
    expect(s.freehireLeads('2026-10-25')).toEqual([]);
  });

  it('recording the same findings twice changes nothing (a resumed run)', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.recordFreehireLeads('2026-10-11', [lead('a')], 't');
    const before = s.freehireLeads('2026-10-11');
    s.recordFreehireLeads('2026-10-11', [lead('a')], 't');
    expect(s.freehireLeads('2026-10-11')).toEqual(before);
  });
});
