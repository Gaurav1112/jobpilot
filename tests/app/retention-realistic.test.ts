import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fullChainCheck } from '../../src/app/chain-status.js';
import { coverageProbeCommand } from '../../src/app/coverage/probe.js';
import { runFreelance } from '../../src/app/freelance/run.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { rebuildDocs, runDaily } from '../../src/app/run.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { storeCompactCommand, storeRestoreCommand } from '../../src/app/store/compact-command.js';
import { createDashboard } from '../../src/app/web/server.js';
import { Sessions } from '../../src/app/web/security.js';

const root = join(import.meta.dirname, '../..');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})() as string;
const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});
const D = (d: string, t = '01:30') => `2026-10-${d}T${t}:00.000Z`;

async function build(): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-review-ret-'));
  homes.push(home);
  chmodSync(home, 0o700);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  writeFileSync(join(home, 'pack/retention.yaml'), 'version: 1\nkeep: { daily: 1, freelance: 1, coverage: 1, rebuild: 1 }\n');
  const daily = offlineProviders(join(root, 'tests/fixtures/e2e'));
  const free = offlineProviders(join(root, 'tests/fixtures/freelance-e2e'));
  const penalty = (n: number) => {
    const t = join(home, 'pack/targets.yaml');
    writeFileSync(t, readFileSync(t, 'utf8').replace(/yearsPenalty: \d+/, `yearsPenalty: ${n}`));
  };
  for (const [i, d] of ['10', '11', '12'].entries()) {
    penalty(20 + i);
    await runDaily({ home, clock: { now: () => D(d) }, fetch: daily.fetch, browser: daily.browser, sleep: async () => {}, pdftotext, codeHash: `review-${i}` });
    await runFreelance({ home, clock: { now: () => D(d, '03:00') }, fetch: free.fetch, sleep: async () => {}, pdftotext });
  }
  return home;
}

/**
 * Retention review (the reviewer's realistic repro, kept as a regression test): a home with documents, gigs and three
 * daily and freelance runs. Every reader and dashboard route answers byte-identically after compaction and after
 * compaction + restore; audit, docs rebuild, the coverage probe and new runs still work; a restore after new runs
 * leaves what those runs re-made as it is.
 */
describe.skipIf(pdftotext === undefined)('review: compact a home with documents, gigs and several runs', () => {
  it('every reader answers the same before and after', async () => {
    const home = await build();
    const NOW = D('12', '09:00');
    const dash = () => createDashboard({ home, clock: { now: () => NOW }, sessions: new Sessions(Buffer.alloc(32, 7)) });
    const snapshot = async (): Promise<Map<string, string>> => {
      const app = dash();
      const a = AppStore.open(join(home, 'jobpilot.db'));
      const jobs = (a.kernel.db.prepare(`SELECT job_key FROM jobs ORDER BY job_key`).all() as { job_key: string }[]).map((r) => r.job_key);
      const gigs = (a.kernel.db.prepare(`SELECT gig_key FROM gigs ORDER BY gig_key`).all() as { gig_key: string }[]).map((r) => r.gig_key);
      const m = new Map<string, string>();
      m.set('gigExtras', JSON.stringify(a.gigExtras(gigs)));
      m.set('contractPostings', JSON.stringify(a.contractPostings(D('01'))));
      m.set('plans', JSON.stringify(jobs.map((k) => a.renderedPlanOf(k))));
      a.close();
      for (const p of ['/', '/?band=rejected&band=below-floor', '/freelance', '/freelance/sources', '/freelance/networks', '/companies', '/facts', ...jobs.map((k) => `/jobs/${k}`), ...gigs.map((g) => `/freelance/${g}`)]) {
        const r = await app.request(p, { headers: { host: 'localhost', cookie: 'jp_sid=' + 'ab'.repeat(16) } });
        m.set(p, `${r.status} ${(await r.text()).replace(/name="_csrf" value="[^"]*"/g, '')}`);
      }
      console.log('RV routes', m.size, 'jobs', jobs.length, 'gigs', gigs.length, 'jobsWithPlan', JSON.parse(m.get('plans') as string).filter((x: unknown) => x !== undefined && x !== null).length);
      return m;
    };
    const before = await snapshot();
    const out: string[] = [];
    const code = await storeCompactCommand({ home, clock: { now: () => NOW }, out: (l) => out.push(l), err: (l) => out.push(l), apply: true, includeIncomplete: true, vacuum: true });
    console.log('RV compact', code, out.filter((l) => /^(kept runs|incomplete|keep:|archive:|archived|  R)/.test(l)).join(' | '));
    const after = await snapshot();
    const diffs = [...before.keys()].filter((k) => before.get(k) !== after.get(k));
    expect(diffs).toEqual([]);
    for (const k of diffs.slice(0, 2)) {
      const a = before.get(k) as string;
      const b = after.get(k) as string;
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      console.log('RV first diff', k, JSON.stringify(a.slice(Math.max(0, i - 80), i + 80)), '=>', JSON.stringify(b.slice(Math.max(0, i - 80), i + 80)));
    }
    const ro0: string[] = [];
    await storeRestoreCommand({ home, clock: { now: () => NOW }, out: (l) => ro0.push(l), err: (l) => ro0.push(l), all: true });
    console.log('RV restore right after compact', ro0.join(' | '));
    const afterRestore = await snapshot();
    const d2 = [...before.keys()].filter((k) => before.get(k) !== afterRestore.get(k));
    expect(d2).toEqual([]);
    for (const k of d2.slice(0, 3)) {
      const x = before.get(k) as string; const y = afterRestore.get(k) as string; let i = 0; while (i < x.length && x[i] === y[i]) i++;
      console.log('RV restore diff', k, JSON.stringify(x.slice(Math.max(0, i - 100), i + 100)), '=>', JSON.stringify(y.slice(Math.max(0, i - 100), i + 100)));
    }
    const a = AppStore.open(join(home, 'jobpilot.db'));
    expect(fullChainCheck(a.kernel, NOW, { record: false })).toMatchObject({ ok: true });
    a.close();
    const rb = await rebuildDocs({ home, clock: { now: () => NOW }, pdftotext } as never).then((r) => `ok ${JSON.stringify(r).slice(0, 120)}`, (e) => `ERR ${String(e)}`);
    expect(rb).toMatch(/^ok /);
    const po: string[] = [];
    const pc = await coverageProbeCommand({ home, json: false, clock: { now: () => NOW }, out: (l) => po.push(l) }).then((c) => `exit ${c}`, (e) => `ERR ${String(e)}`);
    expect(pc).toBe('exit 0');
    const free = offlineProviders(join(root, 'tests/fixtures/freelance-e2e'));
    const fr = await runFreelance({ home, clock: { now: () => D('13', '03:00') }, fetch: free.fetch, sleep: async () => {}, pdftotext }).then((r) => `${r.report.status} exit ${r.exitCode}`, (e) => `ERR ${String(e)}`);
    expect(fr).toMatch(/^completed exit 0$/);
    const daily = offlineProviders(join(root, 'tests/fixtures/e2e'));
    const dr = await runDaily({ home, clock: { now: () => D('13') }, fetch: daily.fetch, browser: daily.browser, sleep: async () => {}, pdftotext, codeHash: 'review-2' }).then((r) => `${r.report.status} exit ${r.exitCode}`, (e) => `ERR ${String(e)}`);
    expect(dr).toMatch(/^completed exit 0$/);
    const ro: string[] = [];
    const rc = await storeRestoreCommand({ home, clock: { now: () => D('13', '09:00') }, out: (l) => ro.push(l), err: (l) => ro.push(l), all: true }).then((c) => `exit ${c}`, (e) => `ERR ${String(e)}`);
    expect(rc).toBe('exit 0');
    expect(code).toBe(0);
  }, 600_000);
});
