import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../../src/app/store/app-store.js';
import { createTestDashboard } from '../../src/app/web/server-testing.js';
import { Sessions } from '../../src/app/web/security.js';
import { fillJobs } from './jobs-fixture.js';

export const PAGE_SID = '0'.repeat(32);
export const PAGE_SESSIONS = new Sessions(Buffer.alloc(32, 7));
const repo = join(import.meta.dirname, '../..');

/** A fictional home (fixture pack, 12 seeded jobs) for the dashboard page checks. */
export function pagesHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-pages-'));
  cpSync(join(repo, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  const app = AppStore.open(join(home, 'jobpilot.db'), { schema: 'migrate' });
  fillJobs(app, 12);
  app.close();
  return home;
}

export const PAGE_ROUTES = ['/', '/facts', '/runs', '/freelance', '/companies'] as const;

/** GET each route (plus the first job's page) with a fixed session and clock; route → body. */
export async function renderPages(home: string, basePath?: string): Promise<Record<string, string>> {
  const app = createTestDashboard({ home, clock: { now: () => '2026-10-09T06:30:00.000Z' }, sessions: PAGE_SESSIONS, ...(basePath !== undefined ? { basePath } : {}) }, {});
  const db = AppStore.open(join(home, 'jobpilot.db'));
  const first = db.listJobs({}).map((j) => j.jobKey).sort()[0] as string;
  db.close();
  const out: Record<string, string> = {};
  for (const r of [...PAGE_ROUTES, `/jobs/${first}`]) {
    const res = await app.request(r, { headers: { cookie: `jp_sid=${PAGE_SID}`, host: 'localhost' } });
    out[r] = await res.text();
  }
  return out;
}
