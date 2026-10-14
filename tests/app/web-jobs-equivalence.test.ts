import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppStore, type JobFilter, type JobsPage } from '../../src/app/store/app-store.js';
import { createTestDashboard } from '../../src/app/web/server-testing.js';
import { Sessions } from '../../src/app/web/security.js';
import { fillJobs } from '../support/jobs-fixture.js';

/**
 * dashboard-perf fix 2, end to end: `GET /` renders byte-identical HTML through the SQL path (`listJobsPage`) and through
 * the pre-fix JS path (`listJobs` + slice + a second `listJobs` for the hidden count, injected as a test hook), for many
 * query strings over a varied fixture DB: rows, order, counts, badges, pager, the forbidden-term redaction and the
 * company filter (the Companies tab's links).
 */
const root = join(import.meta.dirname, '../..');
const NOW = '2026-10-12T06:30:00.000Z';
const HIDDEN = ['below-floor', 'rejected'] as const;
const SID = 'jp_sid=' + 'ab'.repeat(16);

function legacy(s: AppStore, filter: JobFilter, o: { page: number; size: number; newAfterMs: number }): JobsPage {
  const list = s.listJobs(filter);
  const pages = Math.max(1, Math.ceil(list.length / o.size));
  const page = Math.min(o.page, pages);
  return {
    jobs: list.slice((page - 1) * o.size, page * o.size),
    page,
    pages,
    total: list.length,
    newCount: list.filter((j) => Date.parse(j.firstSeen) > o.newAfterMs).length,
    hiddenCount: s.listJobs({ ...filter, band: [...HIDDEN] }).length,
  };
}

let home: string;
type Req = (path: string, cookie: string) => Promise<string>;
let viaSql: Req;
let viaJs: Req;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'jobpilot-webeq-'));
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  const s = AppStore.open(join(home, 'jobpilot.db'));
  try {
    fillJobs(s, 420);
    s.kernel.db.prepare(`INSERT INTO companies (company_key, name, website, status, source, updated_at, platform, platform_slug) VALUES ('globex.example', 'Globex', 'https://globex.example', 'verified', 'pick', ?, 'workday', 'acme.example/tenant1')`).run(NOW);
  } finally {
    s.close();
  }
  const mk = (jobsPage?: typeof legacy): Req => {
    const app = createTestDashboard({ home, clock: { now: () => NOW }, sessions: new Sessions(Buffer.alloc(32, 7)) }, jobsPage ? { jobsPage } : {});
    return async (path, cookie) => {
      const r = await app.request(path, { headers: { host: 'localhost', cookie } });
      expect(r.status, path).toBe(200);
      return r.text();
    };
  };
  viaSql = mk();
  viaJs = mk(legacy);
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('GET / renders the same HTML through the SQL path and the old JS path', () => {
  const QUERIES = [
    '/', '/?page=2', '/?page=5', '/?page=999', '/?page=0', '/?page=abc',
    '/?band=rejected', '/?band=below-floor&band=rejected', '/?band=disclosed&band=review&page=2', '/?band=undisclosed',
    '/?status=new', '/?status=applied&status=interview', '/?status=skipped&band=rejected', '/?status=offer&status=rejected&status=approved',
    '/?min=70', '/?min=70.25', '/?min=0', '/?min=88&band=disclosed', '/?min=abc',
    '/?q=engineer', '/?q=ENGINEER', '/?q=%C3%BC', '/?q=globex&band=rejected', '/?q=initech', '/?q=zzz', '/?q=+de+',
    '/?companyKey=globex.example', '/?companyKey=globex.example&band=rejected&band=review', '/?companyKey=unknown.example', '/?companyKey=Bad_Key',
    '/?status=new&band=disclosed&band=undisclosed&min=42&q=eng&page=2',
  ];
  const COOKIES = [
    SID,
    // a previous visit: "new since your last visit" counts rows first seen after it
    `${SID}; jp_visit=${Date.parse('2026-10-05T01:30:00.000Z')}.${Date.parse('2026-10-05T02:00:00.000Z')}`,
    `${SID}; jp_visit=0.${Date.parse('2026-10-09T01:30:00.200Z')}`,
  ];

  it('for every query and visit cookie', async () => {
    let rows = 0;
    for (const q of QUERIES) {
      for (const c of COOKIES) {
        const [a, b] = [await viaSql(q, c), await viaJs(q, c)];
        expect(a, `${q} ${c}`).toBe(b);
        rows += (a.match(/data-job="/g) ?? []).length;
      }
    }
    // the comparison saw real pages, not empty ones
    expect(rows).toBeGreaterThan(1000);
  });

  it('the fixture shows hidden-term redaction, duplicates and the hidden count', async () => {
    const page = await viaSql('/?q=initech', SID);
    expect(page).toContain('[hidden: contains a forbidden term]');
    const all = await viaSql('/', SID);
    expect(all).toMatch(/not-eligible or below-floor jobs are hidden/);
    expect(all).toContain('also listed on');
  });
});
