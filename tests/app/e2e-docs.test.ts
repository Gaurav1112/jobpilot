import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { runDaily, type DailySummary } from '../../src/app/run.js';
import { AppStore, type JobView } from '../../src/app/store/app-store.js';
import type { Fact } from '../../src/app/pack/schema.js';

/**
 * Documents across runs (final review I1, I2, I3): each test has its own home with the fictional fixture pack and the
 * offline fixture boards.
 */
const repo = join(import.meta.dirname, '../..');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();

export function docsHome() {
  const home = mkdtempSync(join(tmpdir(), 'jp-docs-'));
  cpSync(join(repo, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: [himalayas]\n');
  const offline = offlineProviders(join(repo, 'tests/fixtures/e2e'));
  const clock = { t: '2026-10-09T01:30:00.000Z', now() { return this.t; } };
  const notes: string[] = [];
  const db = join(home, 'jobpilot.db');
  const withApp = <T>(f: (a: AppStore) => T): T => {
    const a = AppStore.open(db);
    try {
      return f(a);
    } finally {
      a.close();
    }
  };
  return {
    home,
    clock,
    notes,
    run: (extra: Partial<Parameters<typeof runDaily>[0]> = {}): Promise<DailySummary> =>
      runDaily({ home, clock, fetch: offline.fetch, browser: offline.browser, notifier: async (s) => void notes.push(s), sleep: async () => {}, pdftotext: pdftotext as string, ...extra }),
    jobs: (): JobView[] => withApp((a) => a.listJobs({ band: ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'], duplicates: true })),
    override: (id: string, status: Fact['status']) => withApp((a) => a.setFactOverride(id, status, clock.t)),
    withApp,
    shaOf: (rel: string) => createHash('sha256').update(readFileSync(join(home, 'out', rel))).digest('hex'),
    done: () => rmSync(home, { recursive: true, force: true }),
  };
}

const ready = (js: readonly JobView[]) => js.filter((j) => j.docsState === 'ready').map((j) => j.jobKey).sort();

describe.skipIf(pdftotext === undefined)('I1: documents heal themselves after an A -> B -> A pack history', () => {
  it('verify a fact, then undo the verification: the documents come back ready with no manual rebuild', async () => {
    const h = docsHome();
    try {
      const run1 = await h.run();
      const readyA = ready(h.jobs());
      expect(readyA.length).toBeGreaterThan(0);
      const files = h.withApp((a) => readyA.flatMap((k) => a.getJob(k)?.docs ?? []));
      const shaA = new Map(files.map((d) => [d.path, h.shaOf(d.path)]));

      // verify: the fact becomes citeable, the pack hash changes and every document is rendered again (pack B)
      h.override('f-nw-05', 'verified');
      h.clock.t = '2026-10-09T02:00:00.000Z';
      const run2 = await h.run();
      expect(run2.packHash).not.toBe(run1.packHash);
      expect([...shaA].some(([p, sha]) => h.shaOf(p) !== sha)).toBe(true);

      // undo: pack A again, so the renderer's steps are A's memo; their files on disk are B's
      h.override('f-nw-05', 'derived-unverified');
      h.clock.t = '2026-10-09T02:30:00.000Z';
      const run3 = await h.run();
      expect(run3.packHash).toBe(run1.packHash);
      expect(ready(h.jobs())).toEqual(readyA);
      for (const [p, sha] of shaA) expect(h.shaOf(p)).toBe(sha);
      expect(run3.exitCode).toBe(0);
      expect(run3.problems).toEqual([]);
      const r = run3.counts.byAgent['renderer'];
      expect(r?.done).toBeGreaterThan(0);
      expect(r?.replayed).toBe(0);
      h.withApp((a) => expect(a.kernel.events(run3.runId).filter((e) => e.kind === 'replay-healed').length).toBe(r?.done));
    } finally {
      h.done();
    }
  }, 240_000);
});

describe.skipIf(pdftotext === undefined)('I3: failed commits and QA-blocked documents are problems', () => {
  it('a failed commit is a commit-failed problem with exit 1, the job is blocked, and the next run heals it', async () => {
    const h = docsHome();
    try {
      await h.run();
      const key = ready(h.jobs())[0] as string;
      chmodSync(join(h.home, 'out', key), 0o500);
      h.override('f-nw-01', 'rejected'); // the pack changes, so the renderer writes new bytes
      h.clock.t = '2026-10-09T02:00:00.000Z';
      let s: DailySummary;
      try {
        s = await h.run();
      } finally {
        chmodSync(join(h.home, 'out', key), 0o700);
      }
      const failed = s.problems.filter((p) => p.kind === 'commit-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ agent: 'renderer' });
      expect(failed[0]?.item).toContain(`job ${key}`);
      expect(s.exitCode).toBe(1);
      expect(s.notification).toMatch(/· \d+ problems?$/);
      const job = h.jobs().find((j) => j.jobKey === key);
      expect(job?.docsState).toBe('blocked');
      expect(job?.docsDetail).toMatch(/could not be written/);
      // next day, obstacle gone: the replay finds the files changed and renders again; no manual rebuild
      h.clock.t = '2026-10-10T01:30:00.000Z';
      const next = await h.run();
      expect(next.problems.filter((p) => p.kind === 'commit-failed')).toEqual([]);
      expect(next.exitCode).toBe(0);
      expect(h.jobs().find((j) => j.jobKey === key)?.docsState).toBe('ready');
    } finally {
      h.done();
    }
  }, 240_000);

  const stub = (dir: string, body: string): string => {
    const p = join(dir, 'pdftotext-stub');
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };

  it('documents QA blocks for content (too many pages) are docs-blocked problems that keep exit 0', async () => {
    const h = docsHome();
    try {
      // the real text layer, plus three page breaks: only qa.pages fails (a content cause)
      const s = await h.run({ pdftotext: stub(h.home, `"${pdftotext}" "$@" && printf '\\f\\f\\f'`) });
      const blocked = s.problems.filter((p) => p.kind === 'docs-blocked');
      expect(blocked.length).toBeGreaterThan(0);
      expect(blocked.every((p) => p.agent === 'qa-gate' && p.cause === 'content' && /qa\.pages/.test(p.reason))).toBe(true);
      expect(blocked.length).toBe(h.jobs().filter((j) => j.docsState === 'blocked').length);
      expect(s.exitCode).toBe(0);
      expect(s.notification).toContain(`· ${s.problems.length} problem`);
    } finally {
      h.done();
    }
  }, 240_000);

  it('documents QA blocks for a system cause (no text layer) are docs-blocked problems with exit 1', async () => {
    const h = docsHome();
    try {
      const s = await h.run({ pdftotext: stub(h.home, 'exit 0') });
      const blocked = s.problems.filter((p) => p.kind === 'docs-blocked');
      expect(blocked.length).toBeGreaterThan(0);
      expect(blocked.every((p) => p.cause === 'system' && /qa\.pdf-text/.test(p.reason))).toBe(true);
      expect(s.exitCode).toBe(1);
    } finally {
      h.done();
    }
  }, 240_000);
});

describe.skipIf(pdftotext === undefined)('I2: documents that cite a fact the user rejected go stale', () => {
  it('a job not seen again is marked stale after the run, listed as a problem, and ready again when the fact is restored', async () => {
    const h = docsHome();
    try {
      await h.run();
      const readyJobs = h.jobs().filter((j) => j.docsState === 'ready');
      expect(readyJobs.length).toBeGreaterThan(1);
      const cited = h.withApp((a) => readyJobs.map((j) => ({ key: j.jobKey, facts: a.getJob(j.jobKey)?.citedFacts ?? [] })));
      for (const c of cited) expect(c.facts.length).toBeGreaterThan(0);
      // a fact cited by some ready jobs but not all, so both outcomes are visible
      const counts = new Map<string, number>();
      for (const c of cited) for (const f of new Set(c.facts)) counts.set(f, (counts.get(f) ?? 0) + 1);
      const fact = [...counts].find(([, n]) => n < cited.length)?.[0] ?? (cited[0]?.facts[0] as string);
      const citing = cited.filter((c) => c.facts.includes(fact)).map((c) => c.key).sort();

      // the boards are not read today (nothing is seen again), and the user rejects the fact
      writeFileSync(join(h.home, 'pack/watchlist.yaml'), 'watchlist: []\n');
      writeFileSync(join(h.home, 'pack/feeds.yaml'), 'enabled: []\n');
      h.override(fact, 'rejected');
      h.clock.t = '2026-10-10T01:30:00.000Z';
      const s = await h.run();
      const after = h.jobs();
      for (const k of citing) {
        const j = after.find((x) => x.jobKey === k);
        expect(j?.docsState).toBe('stale');
        expect(j?.docsDetail).toContain(fact);
      }
      for (const c of cited.filter((x) => !citing.includes(x.key))) expect(after.find((x) => x.jobKey === c.key)?.docsState).toBe('ready');
      const stale = s.problems.filter((p) => p.kind === 'docs-stale');
      expect(stale.map((p) => p.item.match(/job ([0-9a-f]{16})/)?.[1]).sort()).toEqual(citing);
      expect(stale.every((p) => p.reason.includes(fact))).toBe(true);
      expect(s.exitCode).toBe(0);

      // the user restores the fact: the same files are citeable again, so ready again (still not seen)
      h.override(fact, 'verified');
      h.clock.t = '2026-10-11T01:30:00.000Z';
      const back = await h.run();
      for (const k of citing) expect(h.jobs().find((x) => x.jobKey === k)?.docsState).toBe('ready');
      expect(back.problems.filter((p) => p.kind === 'docs-stale')).toEqual([]);
    } finally {
      h.done();
    }
  }, 240_000);
});
