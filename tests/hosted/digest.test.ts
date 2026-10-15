import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerShadow } from '../../src/app/hosted/cli.js';
import { DigestSchema, digestFileName, digestJson, digestRun, runOn, type Digest } from '../../src/app/hosted/digest.js';
import { runFreelance } from '../../src/app/freelance/run.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { runDaily } from '../../src/app/run.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { Store } from '../../src/kernel/store/store.js';
import { makeBehindDb } from '../support/behind-schema.js';

const root = join(import.meta.dirname, '../..');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();
const AT = '2026-10-09T02:30:00.000Z'; // 08:00 IST, the IST date 2026-10-09
const DATE = '2026-10-09';
const dirs: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let home: string;
const dbOf = (): string => join(home, 'jobpilot.db');

/** The expected sets, read straight from the envelopes table (the fixture's own postings), never through the digest code. */
function rawKeys(type: string, pick: (p: Record<string, unknown>) => [string, string] | null): Map<string, string[]> {
  const d = new Database(dbOf(), { readonly: true });
  try {
    const out = new Map<string, Set<string>>();
    for (const r of d.prepare(`SELECT body FROM envelopes WHERE type = ?`).all(type) as { body: string }[]) {
      const hit = pick((JSON.parse(r.body) as { payload: Record<string, unknown> }).payload);
      if (hit === null) continue;
      out.set(hit[0], (out.get(hit[0]) ?? new Set()).add(hit[1]));
    }
    return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
  } finally {
    d.close();
  }
}

describe.skipIf(pdftotext === undefined)('the run digest on a home after one daily and one freelance run', () => {
  beforeAll(async () => {
    home = tmp('jobpilot-digest-');
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    const e2e = offlineProviders(join(root, 'tests/fixtures/e2e'));
    await runDaily({ home, clock: { now: () => AT }, fetch: e2e.fetch, browser: e2e.browser, sleep: async () => {}, pdftotext: pdftotext as string });
    const fl = offlineProviders(join(root, 'tests/fixtures/freelance-e2e'));
    await runFreelance({ home, clock: { now: () => AT }, fetch: fl.fetch, sleep: async () => {}, pdftotext: pdftotext as string });
  }, 600_000);

  it('sources, eligible and gig keys equal a direct read of the envelopes; the JSON is byte-identical and sorted', () => {
    const daily = digestRun(dbOf(), `daily-${DATE}`, { env: 'local', codeSha: null });
    const bySource = rawKeys('Posting@1', (p) => [String(p['source']), String(p['jobKey'])]);
    expect(bySource.size).toBeGreaterThan(1);
    expect(Object.keys(daily.sources).sort()).toEqual(expect.arrayContaining([...bySource.keys()]));
    for (const [src, keys] of bySource) expect(daily.sources[src]?.postings).toEqual(keys);
    const eligible = [
      ...new Set(
        [...rawKeys('EligibilityVerdict@1', (p) => (p['verdict'] === 'eligible' ? ['x', String((p['posting'] as Record<string, unknown>)['jobKey'])] : null)).values()].flat(),
      ),
    ].sort();
    expect(eligible.length).toBeGreaterThan(0);
    expect(daily.eligible).toEqual(eligible);
    expect(daily).toMatchObject({ v: 1, date: DATE, env: 'local', pipeline: 'daily', runId: `daily-${DATE}`, codeSha: null });
    expect(daily.packHash).toMatch(/^[0-9a-f]{64}$/);
    expect(daily.gigs).toEqual({});
    expect(DigestSchema.parse(JSON.parse(digestJson(daily)))).toEqual(daily);

    const free = digestRun(dbOf(), `freelance-${DATE}-am`, { env: 'hosted', codeSha: 'a'.repeat(40), billedMinutes: 3 });
    const gigs = rawKeys('Gig@1', (p) => [String(p['platform']), String(p['gigKey'])]);
    expect(gigs.size).toBeGreaterThan(0);
    expect(free.gigs).toEqual(Object.fromEntries(gigs));
    expect(free).toMatchObject({ pipeline: 'freelance', env: 'hosted', codeSha: 'a'.repeat(40), billedMinutes: 3 });

    expect(digestJson(daily)).toBe(digestJson(digestRun(dbOf(), `daily-${DATE}`, { env: 'local', codeSha: null })));
    const sorted = (v: unknown): boolean => {
      if (Array.isArray(v)) return v.every((x, i) => i === 0 || typeof x !== 'string' || (v[i - 1] as string) <= x) && v.every(sorted);
      if (typeof v === 'object' && v !== null) {
        const k = Object.keys(v);
        return k.every((x, i) => i === 0 || (k[i - 1] as string) < x) && Object.values(v).every(sorted);
      }
      return true;
    };
    expect(sorted(JSON.parse(digestJson(daily)))).toBe(true);
    expect(digestJson(daily).endsWith('}\n')).toBe(true);
    expect(digestFileName(daily)).toBe(`${DATE}-daily.json`);
  });

  it('problems are named per source by code', () => {
    const d = digestRun(dbOf(), `daily-${DATE}`, { env: 'local', codeSha: null });
    for (const s of Object.values(d.sources)) expect([...s.problems]).toEqual([...new Set(s.problems)].sort());
  });

  describe('toDecide', () => {
    const jobs = (): readonly string[] => digestRun(dbOf(), `daily-${DATE}`, { env: 'local', codeSha: null }).toDecide;
    const raw = (fn: (d: Database.Database) => void): void => {
      const d = new Database(dbOf());
      try {
        fn(d);
      } finally {
        d.close();
      }
    };
    it('counts the new, undecided, in-window postings of the run, with status as of the run end', () => {
      const base = [...jobs()];
      expect(base.length).toBeGreaterThan(1);
      const [a, b, c] = base as [string, string, string?];
      // skipped AFTER the run's end: still to decide for that run
      const app = AppStore.open(dbOf());
      try {
        expect(app.setStatus(a, 'skipped', 'user', '2026-10-09T09:00:00.000Z')).toBe(true);
        // skipped BEFORE the run's end: decided
        expect(app.setStatus(b, 'skipped', 'user', '2026-10-09T02:00:00.000Z')).toBe(true);
      } finally {
        app.close();
      }
      const after = jobs();
      expect(after).toContain(a);
      expect(after).not.toContain(b);
      // first seen 8 IST days before the run: out
      if (c !== undefined) {
        raw((d) => d.prepare(`UPDATE jobs SET first_seen = '2026-10-01T02:30:00.000Z' WHERE job_key = ?`).run(c));
        expect(jobs()).not.toContain(c);
        // 6 IST days before at 00:00 IST is the window's first instant
        raw((d) => d.prepare(`UPDATE jobs SET first_seen = '2026-10-02T18:30:00.000Z' WHERE job_key = ?`).run(c));
        expect(jobs()).toContain(c);
        raw((d) => d.prepare(`UPDATE jobs SET first_seen = '2026-10-02T18:29:59.999Z' WHERE job_key = ?`).run(c));
        expect(jobs()).not.toContain(c);
      }
    });
  });

  it('never writes: the database bytes, mtime and side files are unchanged by a digest', () => {
    const before = readFileSync(dbOf());
    const m = statSync(dbOf()).mtimeMs;
    const side = readdirSync(home).sort();
    digestRun(dbOf(), `daily-${DATE}`, { env: 'local', codeSha: null });
    expect(readFileSync(dbOf()).equals(before)).toBe(true);
    expect(statSync(dbOf()).mtimeMs).toBe(m);
    expect(readdirSync(home).sort()).toEqual(side);
  });

  it('runOn picks the earliest daily run of the date and freelance am, never pm', () => {
    expect(runOn(dbOf(), 'daily', DATE)).toBe(`daily-${DATE}`);
    expect(runOn(dbOf(), 'freelance', DATE)).toBe(`freelance-${DATE}-am`);
    expect(runOn(dbOf(), 'daily', '2026-10-10')).toBeNull();
  });

  describe('runOn with several runs of a day', () => {
    it('the earliest started of daily-D and daily-D-n; -pm and look-alike ids are ignored', () => {
      const h = tmp('jobpilot-runon-');
      const k = Store.open(join(h, 'jobpilot.db'));
      k.startRun('daily-2026-11-02', 'p', 'h', '2026-11-02T01:00:00.000Z');
      k.startRun('daily-2026-11-02-2', 'p', 'h', '2026-11-02T02:00:00.000Z');
      k.startRun('daily-2026-11-02-pm', 'p', 'h', '2026-11-02T00:00:00.000Z');
      k.startRun('daily-2026-11-020', 'p', 'h', '2026-11-02T00:00:00.000Z');
      k.startRun('freelance-2026-11-02-pm', 'f', 'h', '2026-11-02T00:00:00.000Z');
      k.startRun('freelance-2026-11-02-am', 'f', 'h', '2026-11-02T03:00:00.000Z');
      k.startRun('freelance-2026-11-02-am-2', 'f', 'h', '2026-11-02T04:00:00.000Z');
      k.close();
      expect(runOn(join(h, 'jobpilot.db'), 'daily', '2026-11-02')).toBe('daily-2026-11-02');
      expect(runOn(join(h, 'jobpilot.db'), 'freelance', '2026-11-02')).toBe('freelance-2026-11-02-am');
    });
  });

  describe('the CLI', () => {
    const run = async (...args: string[]): Promise<{ code: number; out: string[] }> => {
      const out: string[] = [];
      const program = new Command().exitOverride();
      registerShadow(program, { out: (l) => void out.push(l), err: (l) => void out.push(l), git: () => 'b'.repeat(40) });
      try {
        await program.parseAsync(['node', 'jobpilot', 'shadow', ...args]);
        return { code: Number(process.exitCode ?? 0), out };
      } finally {
        process.exitCode = undefined;
      }
    };
    it('writes the expected files and lists the dates with no run', async () => {
      const out = tmp('jobpilot-digest-out-');
      const r = await run('digest', '--home', home, '--from', DATE, '--days', '2', '--env', 'local', '--out', out);
      expect(r.code).toBe(0);
      expect(readdirSync(out).sort()).toEqual([`${DATE}-daily.json`, `${DATE}-freelance.json`]);
      const daily = DigestSchema.parse(JSON.parse(readFileSync(join(out, `${DATE}-daily.json`), 'utf8')));
      expect(daily.codeSha).toBe('b'.repeat(40));
      expect(daily).toEqual(digestRun(dbOf(), `daily-${DATE}`, { env: 'local', codeSha: 'b'.repeat(40) }));
      expect(r.out.join('\n')).toMatch(new RegExp(`${DATE}-daily\\.json: \\d+ postings, \\d+ eligible`));
      expect(r.out.join('\n')).toContain('2026-10-10');
      expect(r.out.join('\n')).toContain('no run');
    });
    it('one run by id, with an explicit --code-sha', async () => {
      const out = tmp('jobpilot-digest-out-');
      const r = await run('digest', '--home', home, '--run', `freelance-${DATE}-am`, '--env', 'hosted', '--out', out, '--code-sha', 'c'.repeat(40));
      expect(r.code).toBe(0);
      const d = DigestSchema.parse(JSON.parse(readFileSync(join(out, `${DATE}-freelance.json`), 'utf8')));
      expect(d).toMatchObject({ env: 'hosted', codeSha: 'c'.repeat(40) });
    });
    it('refuses an --out inside the home, writing nothing', async () => {
      const inside = join(home, 'digests');
      const r = await run('digest', '--home', home, '--run', `daily-${DATE}`, '--env', 'local', '--out', inside);
      expect(r.code).toBe(1);
      expect(existsSync(inside)).toBe(false);
    });
  });

  it('the real binary runs it', () => {
    const out = tmp('jobpilot-digest-bin-');
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/bin.ts'), 'shadow', 'digest', '--home', home, '--run', `daily-${DATE}`, '--env', 'local', '--out', out, '--code-sha', 'd'.repeat(40)], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, VITEST: 'true' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/-daily\.json: \d+ postings, \d+ eligible/);
  }, 60_000);
});

describe('on a schema behind the code', () => {
  it('digestRun reads it and changes nothing', () => {
    const h = tmp('jobpilot-digest-behind-');
    const db = join(h, 'jobpilot.db');
    makeBehindDb(db);
    const k = Store.open(db);
    k.startRun('daily-2026-10-09', 'jobpilot-daily@1', 'h', AT);
    k.finishRun('daily-2026-10-09', AT);
    k.close();
    // put the schema behind again (opening the kernel store does not touch the app version)
    const before = readFileSync(db);
    const m = statSync(db).mtimeMs;
    const uv = (): number => {
      const d = new Database(db, { readonly: true });
      try {
        return d.pragma('user_version', { simple: true }) as number;
      } finally {
        d.close();
      }
    };
    const v = uv();
    const files = readdirSync(h).sort();
    const d: Digest = digestRun(db, 'daily-2026-10-09', { env: 'local', codeSha: null });
    expect(d.date).toBe('2026-10-09');
    expect(readFileSync(db).equals(before)).toBe(true);
    expect(statSync(db).mtimeMs).toBe(m);
    expect(uv()).toBe(v);
    expect(readdirSync(h).sort()).toEqual(files);
  });
});
