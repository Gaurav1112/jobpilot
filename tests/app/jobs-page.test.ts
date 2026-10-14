import { describe, expect, it } from 'vitest';
import type { CompanyJobs } from '../../src/app/coverage/company-jobs.js';
import { AppStore, DEFAULT_BANDS, type Band, type JobFilter, type JobView } from '../../src/app/store/app-store.js';
import { JOB_STATUSES } from '../../src/app/store/schema.js';
import { Store } from '../../src/kernel/store/store.js';
import { fillJobs, FLOOR, prng } from '../support/jobs-fixture.js';

/**
 * dashboard-perf fix 2: `listJobsPage` (band, filters, sort, paging and the counts in SQL, the list's columns only) is
 * EXACTLY the old path: `listJobs(filter)` (every row materialised, filtered and sorted in JS), sliced to the page, its
 * length, its new-since count and the second `listJobs` for the hidden count. Compared over a varied, seeded fixture DB
 * for many filter combinations: same rows (every field but the description, which the list never shows), same order,
 * same counts.
 */
const ALL: readonly Band[] = ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'];
const HIDDEN_BANDS = ALL.filter((b) => !DEFAULT_BANDS.includes(b));

interface PageOut {
  readonly jobs: JobView[];
  readonly page: number;
  readonly pages: number;
  readonly total: number;
  readonly newCount: number;
  readonly hiddenCount: number;
}

/** The dashboard's jobs list before fix 2, verbatim in effect (server.ts `GET /`). */
function legacy(s: AppStore, filter: JobFilter, pageAsked: number, size: number, newAfterMs: number): PageOut {
  const list = s.listJobs(filter);
  const pages = Math.max(1, Math.ceil(list.length / size));
  const page = Math.min(pageAsked, pages);
  return {
    jobs: list.slice((page - 1) * size, page * size).map((j) => ({ ...j, jdText: '' })),
    page,
    pages,
    total: list.length,
    newCount: list.filter((j) => Date.parse(j.firstSeen) > newAfterMs).length,
    hiddenCount: filter.band === undefined ? s.listJobs({ ...filter, band: HIDDEN_BANDS }).length : 0,
  };
}

function viaSql(s: AppStore, filter: JobFilter, pageAsked: number, size: number, newAfterMs: number): PageOut {
  const p = s.listJobsPage(filter, { page: pageAsked, size, newAfterMs });
  return { jobs: p.jobs, page: p.page, pages: p.pages, total: p.total, newCount: p.newCount, hiddenCount: filter.band === undefined ? p.hiddenCount : 0 };
}

const COMPANY_FILTERS: readonly CompanyJobs[] = [
  { key: 'globex.example', name: 'Globex', board: null },
  { key: 'nowhere.example', name: 'Ünïcode GmbH', board: null },
  { key: 'nowhere.example', name: '', board: { platform: 'workday', ref: 'acme.example/tenant1' } },
  { key: 'nowhere.example', name: '', board: { platform: 'smartrecruiters', ref: 'v2:hooli.example/tenant0' } },
  { key: 'nobody.example', name: 'Nobody', board: null },
];

describe('listJobsPage: the jobs list in SQL is exactly the old JS path', () => {
  const app = fillJobs(AppStore.on(Store.open(':memory:')));

  it('the fixture is varied: every band, duplicates, group statuses that differ from the row, ties', () => {
    const all = app.listJobs({ band: ALL, duplicates: true, floorInr: FLOOR });
    for (const b of ALL) expect(all.some((j) => j.band === b), b).toBe(true);
    expect(all.filter((j) => j.duplicateOf !== null).length).toBeGreaterThan(20);
    expect(all.some((j) => j.alsoListedOn.length > 0)).toBe(true);
    const raw = new Map((app.kernel.db.prepare(`SELECT job_key, status FROM jobs`).all() as { job_key: string; status: string }[]).map((r) => [r.job_key, r.status]));
    expect(all.some((j) => raw.get(j.jobKey) !== j.status)).toBe(true);
    expect(all.some((j) => j.note.includes(' | '))).toBe(true);
  });

  it('every band subset, with and without the floor and duplicates, every page', () => {
    for (let mask = 0; mask < 32; mask++) {
      const band = mask === 0 ? undefined : ALL.filter((_, i) => (mask >> i) & 1);
      for (const floorInr of [undefined, FLOOR]) {
        for (const duplicates of [undefined, true]) {
          const filter: JobFilter = { ...(band ? { band } : {}), ...(floorInr !== undefined ? { floorInr } : {}), ...(duplicates ? { duplicates } : {}) };
          for (const page of [1, 2, 3, 99]) {
            const what = JSON.stringify({ filter, page });
            expect(viaSql(app, filter, page, 25, 0), what).toEqual(legacy(app, filter, page, 25, 0));
          }
        }
      }
    }
  });

  it('seeded random combinations of status, min score, text, company, floor, bands, paging and the new-since time', () => {
    const rnd = prng(99);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const sub = <T>(xs: readonly T[]): T[] => xs.filter(() => rnd() < 0.35);
    for (let i = 0; i < 400; i++) {
      const statuses = rnd() < 0.5 ? sub(JOB_STATUSES) : [];
      const bands = rnd() < 0.5 ? sub(ALL) : [];
      const min = pick([undefined, undefined, 0, 42, 70, 70.25, 200]);
      const text = pick([undefined, undefined, 'eng', 'ENGINEER'.toLowerCase(), 'ü', 'i̇', 'globex', 'zzz', 'stanbul', 'de ']);
      const companyOf = rnd() < 0.25 ? pick(COMPANY_FILTERS) : undefined;
      const floorInr = pick([undefined, FLOOR, 1_200_000]);
      const filter: JobFilter = {
        ...(statuses.length > 0 ? { status: statuses } : {}),
        ...(bands.length > 0 ? { band: bands } : {}),
        ...(min !== undefined ? { minScore: min } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(companyOf !== undefined ? { companyOf } : {}),
        ...(floorInr !== undefined ? { floorInr } : {}),
        ...(rnd() < 0.15 ? { duplicates: true } : {}),
      };
      const size = pick([1, 7, 100]);
      const page = pick([1, 1, 2, 5, 1000]);
      const newAfter = pick([0, Date.parse('2026-10-05T01:30:00.000Z'), Date.parse('2026-10-09T01:30:00.000Z'), Date.parse('2026-10-09T01:30:00.200Z'), Number.MAX_SAFE_INTEGER]);
      const what = JSON.stringify({ filter, page, size, newAfter });
      expect(viaSql(app, filter, page, size, newAfter), what).toEqual(legacy(app, filter, page, size, newAfter));
    }
  });

  it('an empty table: one empty page', () => {
    const empty = AppStore.on(Store.open(':memory:'));
    expect(viaSql(empty, {}, 3, 100, 0)).toEqual(legacy(empty, {}, 3, 100, 0));
    expect(viaSql(empty, {}, 3, 100, 0)).toMatchObject({ jobs: [], page: 1, pages: 1, total: 0 });
  });

  it('never reads the description column', () => {
    const seen: string[] = [];
    const db = app.kernel.db;
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      seen.push(sql);
      return prepare(sql);
    }) as typeof db.prepare;
    try {
      app.listJobsPage({ text: 'eng', status: ['new'], minScore: 1 }, { page: 1, size: 100, newAfterMs: 0 });
    } finally {
      db.prepare = prepare;
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const sql of seen) {
      expect(sql).not.toMatch(/jd_text/);
      expect(sql).not.toMatch(/SELECT\s+\*|\.\*/i);
    }
  });
});

describe('companyJobRefs: the Companies tab reads the matching keys only', () => {
  it('equals the listed (non-duplicate) jobs of every band, with rejected marked', () => {
    const app = fillJobs(AppStore.on(Store.open(':memory:')));
    const old = app
      .listJobs({ band: ALL })
      .map((j) => ({ jobKey: j.jobKey, company: j.company, url: j.url, source: j.source, sourceId: j.sourceId, rejected: j.band === 'rejected' }))
      .sort((a, b) => (a.jobKey < b.jobKey ? -1 : 1));
    expect(app.companyJobRefs()).toEqual(old);
    expect(old.some((j) => j.rejected)).toBe(true);
  });
});

