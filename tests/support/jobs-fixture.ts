import { AppStore, type JobStatus } from '../../src/app/store/app-store.js';
import { JOB_STATUSES } from '../../src/app/store/schema.js';
import { Store } from '../../src/kernel/store/store.js';
import { jobRow } from './app-fixtures.js';

/**
 * dashboard-perf: a varied, seeded jobs table for the jobs-list equivalence tests (fictional companies and domains; no
 * personal data): every band, cross-source duplicates whose rows carry different statuses and notes, tenant-scoped
 * sources, score and first-seen ties, mixed-case and non-ASCII names, one name with the fixture pack's forbidden term.
 */
/** mulberry32: a small seeded PRNG, so the fixture is the same on every run. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPANIES = ['Acme Robotics', 'Globex', 'GLOBEX', 'Hooli', 'Ünïcode GmbH', 'İstanbul Yazılım', 'Vandelay Industries', 'Initrode', 'Initech Labs', 'Northwind Labs', 'Umbrella'];
const TITLES = ['Senior Backend Engineer', 'Staff Engineer', 'Platform ENGINEER', 'Backend Developer', 'Ingeniero de Datos', 'Développeur Java', 'SRE', 'Engineering Manager'];
const DOMAINS = ['acme.example', 'globex.example', 'hooli.example', 'unicode.example', 'istanbul.example', 'vandelay.example'];
const SOURCES: readonly { source: string; tenant: boolean }[] = [
  { source: 'greenhouse', tenant: false },
  { source: 'lever', tenant: false },
  { source: 'remotive', tenant: false },
  { source: 'workday', tenant: true },
  { source: 'smartrecruiters', tenant: true },
];
const STAMPS = ['2026-10-01T01:30:00.000Z', '2026-10-05T01:30:00.000Z', '2026-10-09T01:30:00.000Z', '2026-10-09T01:30:00.500Z', '2026-10-12T06:00:00.000Z'];
export const FLOOR = 4_000_000;

export function fillJobs(app: AppStore, n = 360): AppStore {
  const rnd = prng(20261014);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const groups = Array.from({ length: 60 }, (_, i) => `d${String(i).padStart(15, '0')}`);
  const stamps = [...STAMPS].sort();
  for (let i = 0; i < n; i++) {
    const src = pick(SOURCES);
    const company = pick(COMPANIES);
    const domain = pick(DOMAINS);
    const board = `${domain}/tenant${i % 3}`;
    const verdict = pick(['eligible', 'eligible', 'eligible', 'rejected', 'review', null] as const);
    const compMax = pick([null, null, 3_000_000, FLOOR, 4_000_001, 1_200_000, 1_200_000, 9_500_000.5]);
    const at = stamps[i % stamps.length] as string;
    app.upsertJob(
      jobRow({
        jobKey: (i + 1).toString(16).padStart(16, '0'),
        // a third share a dedupe group with rows of other sources: cross-source duplicates
        dedupeKey: rnd() < 0.35 ? pick(groups) : `u${String(i).padStart(15, '0')}`,
        source: src.source,
        sourceId: src.tenant ? `${board}|${i}` : String(1000 + i),
        company,
        title: pick(TITLES),
        url: `https://${rnd() < 0.5 ? 'jobs.' : 'careers.'}${domain}/p/${i}`,
        score: pick([null, 0, 42, 70, 70, 70.25, 88, 120]),
        verdict,
        compMaxInr: compMax,
        compMinInr: compMax === null ? null : Math.floor(compMax / 2),
        compBasis: compMax === null ? null : 'base',
        docsState: pick(['none', 'none', 'ready', 'blocked', 'below-floor', 'missing', 'stale'] as const),
        reasons: verdict === 'rejected' ? ['G-OFFICE'] : [],
        notes: rnd() < 0.2 ? ['office/hybrid: Pune'] : rnd() < 0.1 ? ['b2b: contractor'] : [],
        jdText: 'x'.repeat(200 + i),
        at,
      }),
    );
  }
  // user-owned columns, row by row (as a Desk import leaves them): a group's rows may differ, so the group status is
  // the furthest of them and the note is their distinct notes joined
  const rnd2 = prng(7);
  const upd = app.kernel.db.prepare(`UPDATE jobs SET status = ?, note = ?, applied_at = ?, notified_at = ? WHERE job_key = ?`);
  for (const { job_key } of app.kernel.db.prepare(`SELECT job_key FROM jobs ORDER BY job_key`).all() as { job_key: string }[]) {
    const st = JOB_STATUSES[Math.floor(rnd2() * JOB_STATUSES.length)] as JobStatus;
    upd.run(st, rnd2() < 0.3 ? `note ${Math.floor(rnd2() * 3)}` : '', st === 'applied' ? '2026-10-10T00:00:00.000Z' : null, rnd2() < 0.5 ? '2026-10-11T00:00:00.000Z' : null, job_key);
  }
  return app;
}

