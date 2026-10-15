import { cpSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppStore } from '../../src/app/store/app-store.js';
import { jobRow } from './app-fixtures.js';

export const FIXTURE_PACK = join(import.meta.dirname, '..', 'fixtures', 'pack');
export const OUT_KEY = '0123456789abcdef';

/**
 * A fictional jobpilot home for the hosted tests: the fixture pack, a migrated database with one completed daily run
 * (and its chained events), a resume PDF, a fresh and a 20-day-old log, the attempt files, and the things a state
 * bundle must leave out (archive, secrets, lock, tmp).
 */
export function buildHostedHome(dir: string, now: string): void {
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE_PACK, join(dir, 'pack'), { recursive: true });
  const app = AppStore.open(join(dir, 'jobpilot.db'));
  try {
    const k = app.kernel;
    k.startRun('run-0001', 'daily', 'p'.repeat(16), now);
    k.appendEvent('run-0001', now, 'run_started', { n: 1 }, 'p'.repeat(16));
    k.appendEvent('run-0001', now, 'run_finished', { n: 2 }, 'p'.repeat(16));
    k.finishRun('run-0001', now);
    app.upsertJob(jobRow({ at: now }));
    app.recordRun({ runId: 'run-0001', at: now, counts: { jobs: 1 }, packHash: 'h'.repeat(16), policyHash: 'p'.repeat(16) });
  } finally {
    app.close();
  }
  mkdirSync(join(dir, 'out', OUT_KEY), { recursive: true });
  writeFileSync(join(dir, 'out', OUT_KEY, 'resume.pdf'), '%PDF-1.4 fictional resume\n');
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'logs', 'daily.log'), 'daily ok\n');
  writeFileSync(join(dir, 'logs', 'old.log'), 'old\n');
  const old = new Date(Date.parse(now) - 20 * 86_400_000);
  utimesSync(join(dir, 'logs', 'old.log'), old, old);
  writeFileSync(join(dir, 'daily-attempts.json'), '{}\n');
  writeFileSync(join(dir, 'coverage-start.json'), '{}\n');
  mkdirSync(join(dir, 'archive'), { recursive: true });
  writeFileSync(join(dir, 'archive', 'seg.jsonl.gz'), 'gz');
  mkdirSync(join(dir, 'secrets'), { recursive: true });
  writeFileSync(join(dir, 'secrets', 'x'), 'not-a-secret');
  writeFileSync(join(dir, 'jobpilot.lock'), '');
  writeFileSync(join(dir, 'a.tmp'), 'tmp');
}
